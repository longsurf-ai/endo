// Purpose: Start the backend, wait for it to be ready, and stop it on app exit.

import { once } from "node:events";
import { utilityProcess } from "electron";
import {
  BackendMessage,
  type HostMessage,
  type Init,
  type Notify,
} from "./host-protocol";

/** An owned backend process, stoppable even before it is ready. */
export interface Backend {
  /** Gives the listening port, or fails after a failed startup's process exits. */
  readonly ready: Promise<number>;
  /** Posts shutdown, kills after 5 s, and resolves on the exit event. @example await backend.stop(); */
  stop(): Promise<void>;
}

/**
 * Starts the backend and immediately lets the caller request a stop. `ready`
 * gives the port; a 30 s timeout or early exit stops the child and waits for
 * exit before failing. Unexpected exits after readiness call `onExit`.
 * Every backend message is parsed: `notify` calls `onNotify` whenever it
 * arrives; an invalid message fails a pending startup and is only logged after.
 * The host must call stop() before quitting, including during startup.
 * @example
 * const backend = startBackend({modulePath, init, onExit: showRelaunchDialog, onNotify: showNotification});
 * const port = await backend.ready;
 * await backend.stop();
 */
export function startBackend(input: {
  modulePath: string;
  init: Init;
  onExit: (code: number) => void;
  onNotify: (notification: Notify) => void;
}): Backend {
  // Run the backend separately from main and the windows.
  const child = utilityProcess.fork(input.modulePath, [], {
    serviceName: "Endo Backend",
    stdio: "inherit",
  });
  // Attach listeners before sending setup, so a quick reply cannot be missed.
  const exited = once(child, "exit").then(([code]) => code as number);
  const message = new Promise<number>((resolve, reject) => {
    // One listener for the child's lifetime: a notification may precede ready.
    child.on("message", (message: unknown) => {
      const parsed = BackendMessage.safeParse(message);
      if (!parsed.success) {
        // Fails a pending startup; once ready has settled, this only logs.
        console.error("Invalid backend message", parsed.error.message);
        reject(new Error("Unexpected backend message"));
      } else if (parsed.data.type === "ready") resolve(parsed.data.port);
      else input.onNotify(parsed.data);
    });
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<void> | undefined;
  const ready = (async () => {
    try {
      // Startup ends when the backend is ready, exits, or takes too long.
      const port = await Promise.race([
        message,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error("Backend startup timed out")),
            30_000,
          );
        }),
        exited.then((code) => {
          throw new Error(`Backend exited during startup (${code})`);
        }),
      ]);
      void exited.then((code) => {
        if (!stopping) input.onExit(code);
      });
      return port;
    } catch (cause) {
      // Wait for the failed process to disappear before reporting the failure.
      child.kill();
      await exited;
      throw cause;
    } finally {
      clearTimeout(deadline);
    }
  })();
  // Send secrets through Electron's private channel, not command-line arguments.
  child.postMessage(input.init);
  return {
    ready,
    stop() {
      // Repeated stop requests share one cleanup and wait for the same exit.
      return (stopping ??= (async () => {
        clearTimeout(deadline);
        child.postMessage({ type: "shutdown" } satisfies HostMessage);
        const kill = setTimeout(() => child.kill(), 5_000);
        try {
          await exited;
        } finally {
          clearTimeout(kill);
        }
      })());
    },
  };
}
