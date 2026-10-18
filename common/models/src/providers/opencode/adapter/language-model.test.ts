// Purpose: Tests the full OpenCode adapter boundary with fake ACP processes and real host-tool transport.
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContinuation } from "@openchart/models/providers/continuation";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenCodeLanguageModel } from "./language-model";
import { createOpenCodeProvider } from "./provider";

function nativeOptions(value: unknown) {
  return value as LanguageModelV4CallOptions["providerOptions"];
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function modelFixture(promptBody: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), "endo-opencode-model-test-"));
  directories.push(cwd);
  const executable = path.join(cwd, "agent.cjs");
  await writeFile(
    executable,
    `#!${process.execPath}
const readline=require('node:readline');let mcp;const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
const update=(update)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'session',update}})+'\\n');
readline.createInterface({input:process.stdin}).on('line',async line=>{const message=JSON.parse(line);
if(message.method==='initialize')return send(message.id,{protocolVersion:1});
if(message.method==='session/new'){mcp=message.params.mcpServers[0];return send(message.id,{sessionId:'session'});}
if(message.method==='session/set_config_option')return send(message.id,{});
if(message.method==='session/cancel')return;
if(message.method==='session/prompt'){${promptBody}}
});`,
  );
  await chmod(executable, 0o755);
  const disposal = new AbortController();
  const active = new Set<Promise<unknown>>();
  return {
    cwd,
    executable,
    disposal,
    active,
    model: new OpenCodeLanguageModel({
      modelId: "private/custom",
      executable,
      env: process.env,
      continuation: createContinuation(),
      disposal: disposal.signal,
      active,
    }),
  };
}
const prompt = [
  {
    role: "user" as const,
    content: [{ type: "text" as const, text: "Synthetic test request" }],
  },
];

describe("OpenCode language model", () => {
  it("awaits an interrupted host tool's cleanup before completing the turn", async () => {
    const fixture =
      await modelFixture(`const headers=Object.fromEntries(mcp.headers.map(h=>[h.name,h.value]));headers['content-type']='application/json';
fetch(mcp.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'pending',arguments:{}}})}).catch(()=>{});
while(!require('node:fs').existsSync('started'))await new Promise(resolve=>setTimeout(resolve,5));
send(message.id,{stopReason:'end_turn'});`);
    let cleaned = false;
    await fixture.model.doGenerate({
      prompt,
      providerOptions: nativeOptions({
        opencode: {
          cwd: fixture.cwd,
          permissionMode: "ask",
          approve: async () => true,
          tools: {
            pending: {
              description: "A cancellable host operation",
              inputSchema: z.object({}),
              execute: async (
                _input: unknown,
                { abortSignal }: { abortSignal: AbortSignal },
              ) => {
                await writeFile(path.join(fixture.cwd, "started"), "ready");
                if (!abortSignal.aborted)
                  await new Promise<void>((resolve) =>
                    abortSignal.addEventListener("abort", () => resolve(), {
                      once: true,
                    }),
                  );
                await new Promise((resolve) => setTimeout(resolve, 30));
                cleaned = true;
                throw new Error("Interrupted");
              },
              toModelOutput: () => "unused",
            },
          },
        },
      }),
    });
    expect(cleaned).toBe(true);
  });

  it("executes a host tool once and emits its exact opaque outcome", async () => {
    const fixture =
      await modelFixture(`const headers=Object.fromEntries(mcp.headers.map(h=>[h.name,h.value]));headers['content-type']='application/json';
await fetch(mcp.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'echo',arguments:{token:'fixture'}}})});
update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'done'}});send(message.id,{stopReason:'end_turn'});`);
    let count = 0;
    const outcome = { visible: "ok", privateHostState: { revision: 9 } };
    const result = await fixture.model.doGenerate({
      prompt,
      providerOptions: nativeOptions({
        opencode: {
          cwd: fixture.cwd,
          permissionMode: "ask",
          approve: async () => true,
          tools: {
            echo: {
              description: "Echo test",
              inputSchema: z.object({ token: z.literal("fixture") }),
              execute: async () => {
                count++;
                return outcome;
              },
              toModelOutput: () => "ok",
            },
          },
        },
      }),
    });
    expect(count).toBe(1);
    expect(
      result.content.find((part) => part.type === "tool-result"),
    ).toMatchObject({
      result: outcome,
      providerMetadata: { openchart: { toolExecution: "provider-mcp" } },
    });
    expect(fixture.active.size).toBe(0);
  });

  it("rejects invalid structured submissions without returning unvalidated prose", async () => {
    const fixture =
      await modelFixture(`const headers=Object.fromEntries(mcp.headers.map(h=>[h.name,h.value]));headers['content-type']='application/json';
await fetch(mcp.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'endo_submit_output',arguments:{wrong:true}}})});
update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'pretend valid'}});send(message.id,{stopReason:'end_turn'});`);
    await expect(
      fixture.model.doGenerate({
        prompt,
        responseFormat: {
          type: "json",
          schema: {
            type: "object",
            properties: { required: { type: "string" } },
            required: ["required"],
          },
        },
        providerOptions: nativeOptions({
          opencode: {
            cwd: fixture.cwd,
            tools: {},
            permissionMode: "ask",
            approve: async () => true,
          },
        }),
      }),
    ).rejects.toThrow("structured output");
  });

  it("validates nested structured submission and suppresses native prose", async () => {
    const fixture =
      await modelFixture(`const headers=Object.fromEntries(mcp.headers.map(h=>[h.name,h.value]));headers['content-type']='application/json';
await fetch(mcp.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'endo_submit_output',arguments:{answer:{token:'ok'}}}})});
update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ignored prose'}});send(message.id,{stopReason:'end_turn'});`);
    const result = await fixture.model.doGenerate({
      prompt,
      responseFormat: {
        type: "json",
        schema: {
          type: "object",
          properties: {
            answer: {
              type: "object",
              properties: { token: { type: "string" } },
              required: ["token"],
            },
          },
          required: ["answer"],
        },
      },
      providerOptions: nativeOptions({
        opencode: {
          cwd: fixture.cwd,
          tools: {},
          permissionMode: "ask",
          approve: async () => true,
        },
      }),
    });
    expect(result.content.filter((part) => part.type === "text")).toEqual([
      { type: "text", text: '{"answer":{"token":"ok"}}' },
    ]);
  });
});

it("provider disposal waits for active generation and prevents later access", async () => {
  const fixture = await modelFixture(
    `setTimeout(()=>send(message.id,{stopReason:'end_turn'}),100);`,
  );
  const provider = createOpenCodeProvider({
    executable: fixture.executable,
    discoveryDirectory: fixture.cwd,
  });
  const model = provider.languageModel("private/custom");
  const streamed = await model.doStream({
    prompt,
    providerOptions: nativeOptions({
      opencode: {
        cwd: fixture.cwd,
        tools: {},
        permissionMode: "ask",
        approve: async () => true,
      },
    }),
  });
  await provider.dispose();
  await provider.dispose();
  expect(() => provider.languageModel("private/custom")).toThrow("disposed");
  const reader = streamed.stream.getReader();
  const parts = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
  }
  expect(parts.find((part) => part.type === "finish")).toMatchObject({
    finishReason: { raw: "cancelled" },
  });
});
