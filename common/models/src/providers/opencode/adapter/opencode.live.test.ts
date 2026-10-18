// Purpose: Opt-in native OpenCode acceptance without committed provider URLs or model credentials.
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createOpenCodeProvider } from "./provider";

const enabled = process.env.OPENCODE_LIVE === "1";
const modelIds: string[] = enabled
  ? z
      .array(z.string().min(1))
      .min(1)
      .parse(JSON.parse(process.env.OPENCODE_LIVE_MODEL_IDS ?? "[]"))
  : [];
const executable = process.env.OPENCODE_LIVE_EXECUTABLE ?? "";

describe.skipIf(!enabled)("OpenCode native live acceptance", () => {
  it.each(modelIds)(
    "reads a native file and preserves an Endo host outcome with %s",
    async (modelId) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "endo-opencode-live-"));
      const token = randomUUID();
      await writeFile(path.join(cwd, "probe.txt"), token);
      const provider = createOpenCodeProvider({
        executable,
        discoveryDirectory: cwd,
      });
      let calls = 0;
      const exactOutcome = { token, hostRevision: 17 };
      try {
        const result = await provider.languageModel(modelId).doGenerate({
          prompt: [
            {
              role: "system",
              content:
                "This is a synthetic integration test. Work only in this temporary workspace. Do not edit files, browse, or delegate.",
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Use your native read tool to read probe.txt, then call the injected Endo verify_token tool exactly once with the exact token you read. Reply with the token it returns.",
                },
              ],
            },
          ],
          providerOptions: {
            opencode: {
              cwd,
              permissionMode: "full-access",
              approve: async () => true,
              tools: {
                verify_token: {
                  description: "Validate a token from the native read tool.",
                  inputSchema: z.object({ token: z.literal(token) }),
                  execute: async () => {
                    calls++;
                    return exactOutcome;
                  },
                  toModelOutput: () => ({ token }),
                },
              },
            },
          } as unknown as LanguageModelV4CallOptions["providerOptions"],
        });
        expect(calls).toBe(1);
        const host = result.content.find(
          (part) =>
            part.type === "tool-result" && part.toolName === "verify_token",
        );
        expect(host).toMatchObject({
          result: exactOutcome,
          providerMetadata: { openchart: { toolExecution: "provider-mcp" } },
        });
        expect(
          result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        ).toContain(token);
      } finally {
        await provider.dispose();
        await rm(cwd, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

// Extended acceptance is separate so routine model probes do not spawn delegates
// or long-running commands. Every workspace and prompt remains synthetic.
describe.skipIf(!enabled || process.env.OPENCODE_LIVE_EXTENDED !== "1")(
  "OpenCode native compatibility",
  () => {
    it("keeps denied providers out of discovery and rejects them without inference", async () => {
      const { createServer } = await import("node:http");
      const cwd = await mkdtemp(path.join(tmpdir(), "endo-opencode-policy-"));
      let requests = 0;
      const server = createServer((_request, response) => {
        requests++;
        response.writeHead(500).end();
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing test port");
      const nativeProvider = {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${address.port}/v1` },
        models: {
          coder: { name: "Synthetic coder", capabilities: { tools: true } },
        },
      };
      const provider = createOpenCodeProvider({
        executable,
        discoveryDirectory: cwd,
        env: {
          HOME: cwd,
          XDG_CONFIG_HOME: path.join(cwd, "config"),
          XDG_DATA_HOME: path.join(cwd, "data"),
          XDG_CACHE_HOME: path.join(cwd, "cache"),
          XDG_STATE_HOME: path.join(cwd, "state"),
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            model: "permitted/coder",
            providers: { permitted: nativeProvider, blocked: nativeProvider },
            policies: [
              { action: "provider.use", resource: "*", effect: "deny" },
              {
                action: "provider.use",
                resource: "permitted",
                effect: "allow",
              },
            ],
          }),
        },
      });
      try {
        expect(
          (await provider.discoverModels()).map((model) => model.id),
        ).toEqual(["permitted/coder"]);
        await expect(
          provider.languageModel("blocked/coder").doGenerate({
            prompt: [
              {
                role: "user",
                content: [{ type: "text", text: "Reply hello without tools." }],
              },
            ],
            providerOptions: {
              opencode: {
                cwd,
                tools: {},
                permissionMode: "ask",
                approve: async () => false,
              },
            } as unknown as LanguageModelV4CallOptions["providerOptions"],
          }),
        ).rejects.toThrow(/OpenCode.*failed/);
        expect(requests).toBe(0);
      } finally {
        await provider.dispose();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(cwd, { recursive: true, force: true });
      }
    }, 120_000);

    async function fixture() {
      const cwd = await mkdtemp(path.join(tmpdir(), "endo-opencode-compat-"));
      const provider = createOpenCodeProvider({
        executable,
        discoveryDirectory: cwd,
      });
      const model = provider.languageModel(modelIds[0]!);
      const options = (
        permissionMode = "full-access",
        approve = async () => true,
      ) =>
        ({
          opencode: { cwd, tools: {}, permissionMode, approve },
        }) as unknown as LanguageModelV4CallOptions["providerOptions"];
      return {
        cwd,
        provider,
        model,
        options,
        close: async () => {
          await provider.dispose();
          await rm(cwd, { recursive: true, force: true });
        },
      };
    }

    it("resumes a native conversation across process restarts", async () => {
      const { AcpConnection } = await import("./acp");
      const { vi } = await import("vitest");
      const spy = vi.spyOn(AcpConnection.prototype, "request");
      const f = await fixture();
      const marker = randomUUID();
      const firstPrompt = [
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: `Remember this marker: ${marker}. Reply only acknowledged. Do not use tools.`,
            },
          ],
        },
      ];
      try {
        const first = await f.model.doGenerate({
          prompt: firstPrompt,
          providerOptions: f.options(),
        });
        const text = first.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        const second = await f.model.doGenerate({
          prompt: [
            ...firstPrompt,
            { role: "assistant", content: [{ type: "text", text }] },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "What was the marker? Reply only with it. Do not use tools.",
                },
              ],
            },
          ],
          providerOptions: f.options(),
        });
        expect(
          second.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        ).toContain(marker);
        const index = spy.mock.calls.findIndex(
          ([method]) => method === "session/resume",
        );
        expect(index).toBeGreaterThanOrEqual(0);
        expect(
          spy.mock.calls.filter(([method]) => method === "session/new"),
        ).toHaveLength(1);
        await expect(spy.mock.results[index]!.value).resolves.toMatchObject({
          configOptions: expect.any(Array),
        });
      } finally {
        spy.mockRestore();
        await f.close();
      }
    }, 120_000);

    it("honors host refusal before writing a native file", async () => {
      const { access } = await import("node:fs/promises");
      const f = await fixture();
      let asked = 0;
      try {
        await f.model.doGenerate({
          prompt: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Use a native tool to write denied.txt containing TEST. If permission is refused, stop and say declined. Do not use other tools or delegate.",
                },
              ],
            },
          ],
          providerOptions: f.options("ask", async () => {
            asked++;
            return false;
          }),
        });
        expect(asked).toBeGreaterThan(0);
        await expect(access(path.join(f.cwd, "denied.txt"))).rejects.toThrow();
      } finally {
        await f.close();
      }
    }, 120_000);

    it("projects native child text through the canonical stream contract", async () => {
      const { streamText, isStepCount } = await import("ai");
      const { conformProviderStream } =
        await import("@openchart/models/stream");
      const f = await fixture();
      try {
        const result = streamText({
          model: f.model,
          prompt:
            "Use OpenCode's native task tool to delegate one small calculation to a general-purpose child agent: compute 19 + 23 and reply with the answer. No file, shell or web work. Wait for the child, then report its answer.",
          providerOptions: f.options(),
          stopWhen: isStepCount(1),
          maxRetries: 0,
        });
        const parts = [];
        for await (const part of conformProviderStream(result.fullStream))
          parts.push(part);
        expect(parts.filter((part) => part.type === "error")).toEqual([]);
        const childSteps = parts.filter(
          (part) =>
            part.type === "start-step" &&
            part.providerMetadata?.openchart?.delegateCallId,
        );
        expect(childSteps.length).toBeGreaterThan(0);
        expect(
          parts.some(
            (part) =>
              part.type === "text-delta" &&
              part.providerMetadata?.openchart?.delegateCallId,
          ),
        ).toBe(true);
        expect(
          parts.some(
            (part) =>
              part.type === "finish-step" &&
              part.providerMetadata?.openchart?.delegateCallId,
          ),
        ).toBe(true);
      } finally {
        await f.close();
      }
    }, 120_000);
    it("cancels a running native shell and reaps its child process", async () => {
      const { readFile } = await import("node:fs/promises");
      const { vi } = await import("vitest");
      const f = await fixture();
      const abort = new AbortController();
      const script =
        "require('node:fs').writeFileSync('running.pid',String(process.pid));setTimeout(()=>{},60000)";
      let pid = 0;
      try {
        const streamed = await f.model.doStream({
          abortSignal: abort.signal,
          providerOptions: f.options(),
          prompt: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Run this exact native shell command in the workspace and wait for it: node -e ${JSON.stringify(script)}. Do not delegate or change the command.`,
                },
              ],
            },
          ],
        });
        const consumed = (async () => {
          const parts = [];
          for await (const part of streamed.stream) parts.push(part);
          return parts;
        })();
        await vi.waitFor(
          async () => {
            pid = Number(
              await readFile(path.join(f.cwd, "running.pid"), "utf8"),
            );
            expect(pid).toBeGreaterThan(0);
          },
          { timeout: 30000, interval: 100 },
        );
        abort.abort();
        const parts = await consumed;
        expect(parts.find((part) => part.type === "finish")).toMatchObject({
          finishReason: { raw: "cancelled" },
        });
        await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), {
          timeout: 10000,
          interval: 100,
        });
      } finally {
        abort.abort();
        await f.close();
      }
    }, 60000);

    it("returns a host answer to a native choice question", async () => {
      const f = await fixture();
      let questions = 0;
      try {
        const result = await f.model.doGenerate({
          prompt: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Use OpenCode's native question tool to ask Which package manager? with choices npm and pnpm. Wait for the user's answer, then reply with that choice. Do not use shell, files, web, or delegates.",
                },
              ],
            },
          ],
          providerOptions: {
            opencode: {
              cwd: f.cwd,
              tools: {},
              permissionMode: "full-access",
              approve: async () => true,
              answer: async ({
                requestedSchema,
              }: {
                requestedSchema: Record<string, unknown>;
              }) => {
                questions++;
                const fields = requestedSchema.properties as Record<
                  string,
                  { oneOf?: Array<{ const: string }> }
                >;
                const values: Record<string, unknown> = {};
                for (const [key, field] of Object.entries(fields))
                  if (field.oneOf?.length)
                    values[key] = field.oneOf.at(-1)!.const;
                return values;
              },
            },
          } as unknown as LanguageModelV4CallOptions["providerOptions"],
        });
        expect(questions).toBeGreaterThan(0);
        expect(
          result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        ).toContain("pnpm");
      } finally {
        await f.close();
      }
    }, 120000);
  },
);
