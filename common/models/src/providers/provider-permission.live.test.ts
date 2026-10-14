// Purpose: Proves native permission modes and application-tool refusal with logged-in CLIs; opt in with CODEX_LIVE / CLAUDE_LIVE.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { streamText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  conformProviderStream,
  type ModelStreamEvent,
} from "@openchart/models/stream";
import { claudeCode } from "./claude-code/binding";
import { codex } from "./codex/binding";

const providers = [
  {
    id: "codex",
    executable: process.env.CODEX_LIVE,
    model: process.env.CODEX_LIVE_MODEL ?? "gpt-6-luna",
    create: codex.createModelProvider,
    options: codex.requestOptions,
    namespace: "codex-app-server",
  },
  {
    id: "claude-code",
    executable: process.env.CLAUDE_LIVE,
    model: process.env.CLAUDE_LIVE_MODEL ?? "haiku",
    create: claudeCode.createModelProvider,
    options: claudeCode.requestOptions,
    namespace: "claude-code",
  },
] as const;

for (const provider of providers) {
  describe.skipIf(!provider.executable)(
    `${provider.id} permission integration`,
    () => {
      it.each(["full-access", "ask", "auto"] as const)(
        "%s enforces native policy without bypassing OpenChart tool refusal",
        async (permissionMode) => {
          // Keep the sibling outside both the cwd and OS temp roots allowed by some sandboxes.
          const directory = await mkdtemp(
            join(homedir(), ".openchart-permission-test-"),
          );
          const cwd = join(directory, "workspace");
          const outside = join(directory, "outside");
          await Promise.all([mkdir(cwd), mkdir(outside)]);
          const marker = randomUUID();
          let requests = 0;
          const server = createServer((_request, response) => {
            requests++;
            response.end(marker);
          });
          server.listen(0, "127.0.0.1");
          await once(server, "listening");
          const address = server.address();
          if (!address || typeof address === "string")
            throw new Error("No test server port");
          const binding = provider.create(
            { get: async () => ({}) },
            provider.executable!,
          );
          const askPermission = vi.fn(async () => {
            throw new Error("Denied by test host approval policy");
          });
          const nativeApproval = vi.fn();
          const blocked = vi.fn(async () => {
            throw new Error("OPENCHART_TOOL_BLOCKED");
          });
          const options = provider.options({
            cwd,
            permissionMode,
            askPermission,
            tools: {
              permission_probe_blocked: {
                description:
                  "Tests OpenChart's tool policy. Invoke once when requested and report its error; do not retry or work around it.",
                inputSchema: z.object({}),
                execute: blocked,
                toModelOutput: (output) => output,
              },
            },
          });
          if ("requests" in options && options.requests) {
            const decide = options.requests;
            options.requests = (request, options) => {
              nativeApproval(request.method);
              return decide(request, options);
            };
          }
          if ("canUseTool" in options && options.canUseTool) {
            const decide = options.canUseTool;
            options.canUseTool = (...args) => {
              nativeApproval(args[0]);
              return decide(...args);
            };
          }
          try {
            const result = streamText({
              model: binding.sdk.languageModel(
                provider.id === "claude-code" && permissionMode === "auto"
                  ? (process.env.CLAUDE_LIVE_AUTO_MODEL ?? "sonnet")
                  : provider.model,
              ),
              system: `Run only the requested benign integration checks. The entire test fixture ${directory} is explicitly authorized, including both its workspace and outside sibling directories. The outside sibling is deliberately outside cwd to test permission boundaries. The specified loopback HTTP server is also authorized. Do not delegate or inspect other files. If a native operation needs permissions outside the sandbox, request them through your native approval mechanism. You may retry a sandbox error once through that mechanism, but never retry or work around an approval refusal or the OpenChart tool refusal.`,
              prompt: [
                `Use your native file editing tool to create ${join(outside, "native-file.txt")} containing exactly ${marker}.`,
                `Then use your native shell tool to run: curl --fail --silent http://127.0.0.1:${address.port}/probe > '${join(outside, "network.txt")}'.`,
                "Then invoke permission_probe_blocked exactly once. Report its refusal without trying any workaround. Finish with a short summary.",
              ].join("\n"),
              providerOptions: { [provider.namespace]: options } as never,
              abortSignal: AbortSignal.timeout(240_000),
              maxRetries: 0,
            });
            const events: ModelStreamEvent[] = [];
            for await (const event of conformProviderStream(result.fullStream))
              events.push(event);
            expect(events.filter((event) => event.type === "error")).toEqual(
              [],
            );
            const file = await readFile(
              join(outside, "native-file.txt"),
              "utf8",
            ).catch(() => undefined);
            const network = await readFile(
              join(outside, "network.txt"),
              "utf8",
            ).catch(() => undefined);
            const diagnostic = JSON.stringify({
              text: events
                .filter((event) => event.type === "text-delta")
                .map((event) => event.text)
                .join(""),
              tools: events.filter((event) =>
                ["tool-call", "tool-result", "tool-error", "error"].includes(
                  event.type,
                ),
              ),
              nativeApprovals: nativeApproval.mock.calls,
              hostApprovals: askPermission.mock.calls,
            });
            if (permissionMode === "ask") {
              expect(file, diagnostic).toBeUndefined();
              expect(network, diagnostic).toBeUndefined();
              expect(requests).toBe(0);
              expect(askPermission, diagnostic).toHaveBeenCalled();
              return;
            }
            expect(file?.trim(), diagnostic).toBe(marker);
            expect(network, diagnostic).toBe(marker);
            expect(requests).toBeGreaterThan(0);
            expect(nativeApproval).not.toHaveBeenCalled();
            expect(askPermission).not.toHaveBeenCalled();
            expect(blocked).toHaveBeenCalledTimes(1);
            const refusal = events.find(
              (event) =>
                event.type === "tool-error" &&
                event.toolName === "permission_probe_blocked",
            );
            expect(refusal).toBeDefined();
            expect(JSON.stringify(refusal)).toContain("OPENCHART_TOOL_BLOCKED");
          } finally {
            await binding.dispose();
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
            await rm(directory, { recursive: true, force: true });
          }
        },
        270_000,
      );
    },
  );
}
