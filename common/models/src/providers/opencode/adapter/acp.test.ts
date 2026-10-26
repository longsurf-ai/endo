// Purpose: Exercises OpenCode process framing, cleanup and policy-filtered discovery without inference.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpConnection, AcpError } from "./acp";
import { discoverModels } from "./discovery";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(body: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), "endo-opencode-test-"));
  directories.push(cwd);
  const script = path.join(cwd, "agent.cjs");
  await writeFile(
    script,
    `const readline = require('node:readline');
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id, result})+'\\n');
readline.createInterface({input:process.stdin}).on('line', async line => {
const message = JSON.parse(line); ${body}
});`,
  );
  return {
    executable: process.execPath,
    args: [script],
    cwd,
    env: process.env,
    timeoutMs: 2000,
  };
}

function connect(
  options: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<ConstructorParameters<typeof AcpConnection>[0]> = {},
) {
  return new AcpConnection({
    ...options,
    notification: () => {},
    request: async () => null,
    ...overrides,
  });
}

describe("OpenCode ACP process", () => {
  it("handles split and concurrent response frames", async () => {
    const options =
      await fixture(`const text=JSON.stringify({jsonrpc:'2.0',id:message.id,result:message.method})+'\\n';
process.stdout.write(text.slice(0,5)); process.stdout.write(text.slice(5));`);
    const acp = connect(options);
    try {
      await expect(
        Promise.all([acp.request("first", {}), acp.request("second", {})]),
      ).resolves.toEqual(["first", "second"]);
    } finally {
      await acp.close();
    }
  });

  it("preserves native rejection codes without killing a live connection", async () => {
    const options = await fixture(
      `if(message.method==='bad')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32602,message:'model denied'}})+'\\n');else send(message.id, true);`,
    );
    const acp = connect(options);
    try {
      await expect(acp.request("bad", {})).rejects.toMatchObject({
        method: "bad",
        code: -32602,
      });
      await expect(acp.request("good", {})).resolves.toBe(true);
      expect(AcpError.prototype).toBeInstanceOf(Error);
    } finally {
      await acp.close();
    }
  });

  it.each([
    "process.stdout.write('broken\\n')",
    "send(999, {})",
    "process.exit(3)",
  ])("rejects every waiter on invalid traffic or exit: %s", async (body) => {
    const acp = connect(await fixture(body));
    try {
      const outcomes = await Promise.allSettled([
        acp.request("first", {}),
        acp.request("second", {}),
      ]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        "rejected",
        "rejected",
      ]);
    } finally {
      await acp.close();
    }
  });

  it("bounds requests that never respond and makes close idempotent", async () => {
    const acp = connect(await fixture(""), { timeoutMs: 50 });
    await expect(acp.request("stalled", {})).rejects.toThrow("timed out");
    await Promise.all([acp.close(), acp.close()]);
    await expect(acp.request("late", {})).rejects.toThrow("timed out");
  });

  it("aborts native callbacks and pending work together", async () => {
    const options = await fixture(
      `if(message.method==='begin')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'permission',method:'session/request_permission',params:{}})+'\\n');`,
    );
    const abort = new AbortController();
    let callbackSignal: AbortSignal | undefined;
    let callbackFinished = false;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const acp = connect(options, {
      signal: abort.signal,
      request: async (_method, _params, signal) => {
        callbackSignal = signal;
        started();
        return new Promise((resolve) =>
          signal.addEventListener(
            "abort",
            () =>
              setTimeout(() => {
                callbackFinished = true;
                resolve(null);
              }, 30),
            { once: true },
          ),
        );
      },
    });
    const pending = acp.request("begin", {});
    const outcome = expect(pending).rejects.toThrow("aborted");
    await ready;
    abort.abort();
    await outcome;
    await acp.close();
    expect(callbackSignal?.aborted).toBe(true);
    expect(callbackFinished).toBe(true);
  });
});

describe("OpenCode native discovery", () => {
  it("returns only native model choices and deletes its probe session", async () => {
    const options = await fixture(`switch(message.method){
case 'initialize': send(message.id,{protocolVersion:1});break;
case 'session/new': send(message.id,{sessionId:'probe',configOptions:[{id:'model',options:[{value:'private/model/with/slashes',name:'Custom model'}]}]});break;
case 'session/set_config_option': send(message.id,{configOptions:[{id:'effort',options:[{value:'default',name:'Default'},{value:'high',name:'High'}]}]});break;
case 'session/delete': require('node:fs').writeFileSync('deleted',message.params.sessionId);send(message.id,{});break;
default: throw new Error('Unexpected method '+message.method);
}`);
    await expect(discoverModels(options)).resolves.toEqual([
      {
        id: "private/model/with/slashes",
        name: "Custom model",
        availableVariants: ["high"],
      },
    ]);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path.join(options.cwd, "deleted"), "utf8")).toBe(
      "probe",
    );
  });

  it("accepts an empty configured catalog without inventing models", async () => {
    const options =
      await fixture(`if(message.method==='initialize')send(message.id,{protocolVersion:1});
else if(message.method==='session/new')send(message.id,{sessionId:'probe',configOptions:[{id:'model',options:[]}]});
else send(message.id,{});`);
    await expect(discoverModels(options)).resolves.toEqual([]);
  });
});
