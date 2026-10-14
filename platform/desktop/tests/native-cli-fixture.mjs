// Purpose: Isolated native CLI fixture for packaged discovery, login, tools, and chat smoke.
import { createInterface } from "node:readline";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const state = process.env.REAGENT_SMOKE_STATE;
if (!state)
  throw new Error("Native fixture requires an isolated state directory");
if (process.argv.includes("--version")) {
  console.log(`codex-cli ${readFileSync(join(state, "version"), "utf8")}`);
} else if (process.argv[2] === "login") {
  console.log("Fixture login: enter smoke-code to finish.");
  const lines = createInterface({ input: process.stdin });
  lines.once("line", (code) => {
    if (code !== "smoke-code") process.exit(1);
    writeFileSync(join(state, "authenticated"), "ready");
    console.log("Signed in");
    process.exit(0);
  });
} else {
  const threads = new Map();
  const pendingTools = new Map();
  const send = (message) => console.log(JSON.stringify(message));
  const notify = (method, params) => send({ method, params });
  createInterface({ input: process.stdin }).on("line", (line) => {
    void receive(JSON.parse(line)).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });
  async function receive(message) {
    const { id, method, params } = message;
    if (method === undefined) {
      const resolve = pendingTools.get(id);
      if (!resolve) throw new Error(`Unexpected tool response: ${id}`);
      pendingTools.delete(id);
      resolve(message);
      return;
    }
    appendFileSync(join(state, "methods"), method + "\n");
    if (id === undefined) return;
    const reply = (result) => send({ id, result });
    if (method === "initialize")
      reply({ userAgent: "codex-cli 0.144.0", capabilities: null });
    else if (method === "account/read")
      reply({
        account: existsSync(join(state, "authenticated"))
          ? { type: "chatgpt" }
          : null,
        requiresOpenaiAuth: true,
      });
    else if (method === "account/rateLimits/read") reply({ rateLimits: {} });
    else if (method === "model/list")
      reply({
        data: [
          {
            id: "gpt-5.6-luna",
            model: "gpt-5.6-luna",
            displayName: "smoke-model",
            isDefault: true,
          },
        ],
        nextCursor: null,
      });
    else if (method === "thread/start") {
      const threadId = randomUUID();
      threads.set(threadId, params.dynamicTools ?? []);
      reply({
        thread: { id: threadId },
        model: "gpt-5.6-luna",
        modelProvider: "openai",
        cwd: params.cwd,
        approvalPolicy: "on-request",
        sandbox: { type: "readOnly" },
        reasoningEffort: null,
      });
    } else if (method === "turn/start") {
      const turnId = randomUUID();
      reply({ turn: { id: turnId } });
      // Allow the adapter to bind this turn before delivering notifications.
      setTimeout(
        () =>
          void turn(params, turnId).catch((error) => {
            console.error(error);
            notify("turn/completed", {
              threadId: params.threadId,
              turn: {
                id: turnId,
                items: [],
                status: "failed",
                error: { message: String(error) },
              },
            });
          }),
        20,
      );
    } else reply({});
  }
  async function turn(params, turnId) {
    const threadId = params.threadId;
    const tools = threads.get(threadId);
    const text = params.input
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const scope = { threadId, turnId };
    const record = (value) =>
      appendFileSync(join(state, "requests"), value + "\n");
    let answer = "CONFIG_NATIVE_OK";
    if (text.includes("SDK_CHILD:")) {
      answer = "SDK_CHILD_OK";
      record("child");
    } else if (
      text.includes("WORKSPACE_RUN") &&
      tools.some((tool) => tool.name === "workflow")
    ) {
      // Title requests quote the same text but have no workflow tool.
      record("workflow");
      const args = {
        workflow: "workspace:workspace-smoke.workflow.ts",
        args: { question: "NVDA" },
      };
      const item = {
        type: "dynamicToolCall",
        id: randomUUID(),
        tool: "workflow",
        status: "inProgress",
        durationMs: null,
        arguments: args,
        success: null,
      };
      notify("item/started", { ...scope, item });
      const response = await new Promise((resolve) => {
        const id = randomUUID();
        pendingTools.set(id, resolve);
        send({
          id,
          method: "item/tool/call",
          params: {
            ...scope,
            callId: item.id,
            tool: item.tool,
            arguments: args,
          },
        });
      });
      if (response.error || !response.result.success)
        throw new Error(JSON.stringify(response));
      notify("item/completed", {
        ...scope,
        item: { ...item, status: "completed", success: true },
      });
      answer = "WORKSPACE_WORKFLOW_OK";
    } else record("chat");
    notify("item/agentMessage/delta", {
      ...scope,
      itemId: "answer",
      delta: answer,
    });
    notify("item/completed", {
      ...scope,
      item: {
        type: "agentMessage",
        id: "answer",
        text: answer,
        phase: "final_answer",
      },
    });
    notify("turn/completed", {
      threadId,
      turn: { id: turnId, items: [], status: "completed", error: null },
    });
  }
}
