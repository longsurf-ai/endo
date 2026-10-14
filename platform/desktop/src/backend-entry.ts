// Purpose: Run the application services in a separate process from the windows.

import { once } from "node:events";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { Agent, setGlobalDispatcher } from "undici";
import { createServer } from "@openchart/server";
import {
  HostMessage,
  type Init,
  type Notify,
  type Ready,
} from "./host-protocol";

type Server = Awaited<ReturnType<typeof createServer>>;

// Network defaults for every connection this process opens, set before the
// server starts (docs/architecture/desktop.md). Node gives up on each address
// after 250 ms, less than a round trip to distant hosts (~260 ms), so new
// connections tried them all; 1 s still skips a dead one.
setDefaultAutoSelectFamilyAttemptTimeout(1_000);
// Node's fetch drops a connection after 4 s idle unless the server sends a
// Keep-Alive hint; many APIs send none and keep connections open 60-170 s.
setGlobalDispatcher(new Agent({ keepAliveTimeout: 30_000 }));

let starting: Promise<Server> | undefined;

async function start(init: Init): Promise<Server> {
  // The runtime prepares its home, opens the database, and starts services.
  const server = await createServer(
    {
      home: init.home,
      models: { installOnStartup: true },
      // Main owns the OS notification; the backend only asks it to show one.
      notify: ({ title, body, sound }) =>
        process.parentPort.postMessage({
          type: "notify",
          title,
          body,
          sound,
        } satisfies Notify),
    },
    { access: { token: init.token, origin: init.rendererOrigin } },
  );
  // Accept requests only from this computer; let the OS choose a free port.
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Backend did not bind a TCP port");
  // Tell main which port to use. It can now open the app window.
  process.parentPort.postMessage({
    type: "ready",
    port: address.port,
  } satisfies Ready);
  return server;
}

async function handle(data: unknown): Promise<void> {
  // Check messages from main before using their settings or commands.
  const message = HostMessage.parse(data);
  if (message.type === "init") {
    starting = start(message);
    await starting;
    return;
  }
  // If Quit arrived early, wait for startup before closing services and the database.
  const server = await starting?.catch(() => undefined);
  await server?.shutdown();
  process.exit(0);
}

// Electron provides this private connection to the main process that started us.
process.parentPort.on("message", ({ data }) => {
  void handle(data).catch((cause: unknown) => {
    console.error(cause);
    process.exit(1);
  });
});
