// Purpose: Locks Resource tool access, schema discovery, pagination, and recoverable transaction failures.

import { join } from "node:path";

import { Database } from "@openchart/server/db";
import { Home } from "@openchart/server/home";
import { temporaryHome } from "@openchart/server/home.test-utils";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { ToolRegistry } from "@openchart/server/agent/tool/registry";
import { Session } from "@openchart/server/agent/session";
import type { Tool } from "@openchart/server/agent/tool/tool";
import { InvalidArgumentsError } from "@openchart/server/agent/tool/errors";
import { DeclinedError } from "@openchart/server/agent/permission/errors";
import { Workflow } from "@openchart/server/agent/workflow";
import { Workspaces } from "@openchart/server/workspace/workspace";
import { AgentProfile } from "@openchart/server/agent/profiles/profile";
import { agentScheduleResource } from "@openchart/server/resources/agent-schedule";
import { agentSchedules } from "@openchart/server/resources/agent-schedule/schema";
import { workspaceResource } from "@openchart/server/resources/workspace";
import { resources } from "@openchart/server/resources/catalog";
import { Transactor } from "@openchart/server/lib/resource";
import { MAX_PAGE_SIZE } from "@openchart/server/lib/resource/pagination";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  ManagedRuntime,
  JsonSchema,
  Schema,
} from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TestClock } from "effect/testing";

const committed = vi.fn<Database.OnCommitted>(() => Effect.void);
const ask = vi.fn<Tool.Context["ask"]>(() => Effect.void);
const context: Tool.Context = {
  rootRunID: "agr_test",
  sessionID: "session",
  messageID: "message",
  callID: "call",
  agent: "analyst",
  messages: [],
  metadata: () => Effect.void,
  ask,
};
const makeRuntime = () =>
  ManagedRuntime.make(
    Layer.empty.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ToolRegistry.layer,
          Session.layer,
          Layer.mock(Workspaces, {}),
          Database.layer(":memory:", committed),
          Home.layer(temporaryHome()).pipe(
            Layer.provideMerge(NodeFileSystem.layer),
          ),
          Layer.succeed(Workflow.Service, {
            getResource: () => Effect.die("Unexpected Resource read"),
            settings: { concurrency: 5 },
            parentPrompt: {
              agent: "analyst",
              model: {
                providerID: "codex" as const,
                modelID: "tier1" as const,
              },
              parts: [{ type: "text", text: "Test" }],
            },
            agent: () => Effect.die("Unexpected workflow child execution"),
          }),
        ).pipe(Layer.provideMerge(AgentProfile.layerDefault)),
      ),
    ),
  );
let runtime: ReturnType<typeof makeRuntime>;

beforeEach(() => {
  runtime = makeRuntime();
});
afterEach(async () => {
  await runtime.dispose();
  vi.restoreAllMocks();
  committed.mockClear();
  ask.mockClear();
});

function invoke(name: string, input: unknown, ctx = context) {
  return Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service;
    const tool = (yield* registry.all()).find((tool) => tool.id === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return yield* tool.execute(input, ctx);
  });
}

async function call(name: string, input: unknown, ctx = context) {
  const result = await runtime.runPromise(invoke(name, input, ctx));
  if (result.output.type !== "text") throw new Error("Expected JSON text");
  return JSON.parse(result.output.value);
}

const savedPrompt = {
  kind: "agent_prompt",
  prompt: {
    agent: "analyst",
    model: { providerID: "codex", modelID: "tier1" },
    parts: [{ type: "text", text: "Review the plan." }],
  },
};
const onceInFuture = { kind: "once", fireAt: "2090-01-01T00:00:00.000Z" };
const scheduleTarget: (typeof agentScheduleResource.entity.Type)["target"] = {
  kind: "agent_prompt",
  prompt: {
    agent: "analyst",
    model: { providerID: "codex", modelID: "tier1" },
    parts: [{ type: "text", text: "Review the plan." }],
  },
};
/** Complete Agent-authored Schedule input with the given name. */
const scheduleBody = (name: string) => ({
  name,
  target: savedPrompt,
  recurrence: onceInFuture,
});

const create = (name: string) =>
  call("resource_mutate", {
    resource: "agent_schedule",
    op: "create",
    input: scheduleBody(name),
  });

const scheduleInput = {
  name: "Morning review",
  prompt: "Review the market and cite your sources.",
  recurrence: { kind: "cron", expression: "0 9 * * *", timeZone: "UTC" },
};

test("create_schedule reuses Schedule creation and inherits each invocation's execution context", async () => {
  for (const parentPrompt of [
    {
      agent: "analyst",
      model: { providerID: "codex" as const, modelID: "tier1" as const },
      parts: [{ type: "text" as const, text: "Do not copy this request." }],
    },
    {
      agent: "researcher",
      workspaceId: "wsp_research",
      model: {
        providerID: "codex" as const,
        modelID: "tier4" as const,
        selectedVariant: "high",
      },
      parts: [{ type: "text" as const, text: "Different conversation." }],
    },
  ]) {
    const output = await runtime.runPromise(
      invoke("create_schedule", scheduleInput).pipe(
        Effect.provideService(Workflow.Service, {
          getResource: () => Effect.die("Unexpected Resource read"),
          parentPrompt,
          settings: { concurrency: 5 },
          agent: () => Effect.die("Creation must not execute the target"),
        }),
        Effect.provide(TestClock.layer()),
      ),
    );
    if (output.output.type !== "text") throw new Error("Expected JSON text");
    const created = JSON.parse(output.output.value);
    expect(created).toMatchObject({
      status: "ok",
      resource: "agent_schedule",
      entity: {
        name: scheduleInput.name,
        enabled: true,
        revision: 1,
        recurrence: scheduleInput.recurrence,
        nextFireAt: 9 * 60 * 60 * 1_000,
      },
    });
    expect(created.entity.target).toEqual({
      kind: "agent_prompt",
      prompt: {
        ...parentPrompt,
        parts: [{ type: "text", text: scheduleInput.prompt }],
      },
    });
    expect(created.entity).toEqual(
      await runtime.runPromise(
        Transactor.run(
          agentScheduleResource.transitions.get(
            agentScheduleResource.id.make(created.entity.id),
          ),
        ),
      ),
    );
  }
  expect(committed).toHaveBeenCalledTimes(2);
  expect(ask).toHaveBeenCalledWith({
    permission: "create_schedule",
    patterns: ["agent_schedule"],
    always: ["agent_schedule"],
    metadata: scheduleInput,
  });
});

test.each([
  { name: " " },
  { prompt: " " },
  { recurrence: { kind: "once", fireAt: "2099-01-01T00:00:00.000Z" } },
  { recurrence: { ...scheduleInput.recurrence, expression: "0 0 9 * * *" } },
  { recurrence: { ...scheduleInput.recurrence, timeZone: "invalid/zone" } },
  { nextFireAt: 0 },
])(
  "create_schedule rejects invalid arguments before permission or writes: %j",
  async (input) => {
    await expect(
      call("create_schedule", { ...scheduleInput, ...input }),
    ).rejects.toBeInstanceOf(InvalidArgumentsError);
    expect(ask).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
  },
);

test("create_schedule preserves permission refusal without creating a schedule", async () => {
  ask.mockImplementationOnce(() => Effect.fail(new DeclinedError({})));
  await expect(call("create_schedule", scheduleInput)).rejects.toBeInstanceOf(
    DeclinedError,
  );
  expect(committed).not.toHaveBeenCalled();
  expect(
    await runtime.runPromise(
      Transactor.run(agentScheduleResource.transitions.listAll({})),
    ),
  ).toEqual([]);
});

test("creates, reads, patches and deletes the same canonical entity as Resource transitions", async () => {
  const created = await create("Rates");
  expect(created).toMatchObject({
    status: "ok",
    resource: "agent_schedule",
    entity: { name: "Rates", revision: 1, enabled: true },
  });
  const id = agentScheduleResource.id.make(created.entity.id);
  expect(created.entity).toEqual(
    await runtime.runPromise(
      Transactor.run(agentScheduleResource.transitions.get(id)),
    ),
  );
  expect(
    await call("resource_read", { resource: "agent_schedule", id }),
  ).toEqual(created);
  const patch = {
    resource: "agent_schedule",
    id,
    op: "patch",
    expected_revision: 1,
    input: [{ op: "replace", path: "/name", value: "Bonds" }],
  };
  expect(await call("resource_mutate", patch)).toMatchObject({
    status: "ok",
    entity: { name: "Bonds", revision: 2 },
  });
  expect(await call("resource_mutate", patch)).toMatchObject({
    status: "rejected",
    code: "resource.revision_conflict",
  });
  expect(
    await call("resource_mutate", {
      resource: "agent_schedule",
      op: "delete",
      id,
    }),
  ).toEqual({ status: "ok", resource: "agent_schedule", id });
  expect(
    await call("resource_read", { resource: "agent_schedule", id }),
  ).toMatchObject({ status: "rejected", code: "resource.not_found" });
  expect(committed).toHaveBeenCalledTimes(3);
});

test("Agent reads workspace registrations but cannot create, patch, delete, or invoke custom transitions", async () => {
  const root = await runtime.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = join((yield* Home).root, "studies");
      yield* fs.makeDirectory(root);
      yield* fs.writeFileString(join(root, "main.tea"), "close");
      return root;
    }),
  );
  const { id } = await runtime.runPromise(
    Transactor.run(workspaceResource.transitions.register({ root })),
  );
  const read = await call("resource_read", {
    resource: "workspace",
    id,
    include_schema: true,
  });
  expect(read).toMatchObject({
    status: "ok",
    entity: { id, root },
    schema: { transitions: {} },
  });
  ask.mockClear();
  committed.mockClear();
  for (const input of [
    { op: "create", input: { root } },
    {
      op: "patch",
      id,
      expected_revision: 1,
      input: [{ op: "replace", path: "/root", value: `${root}-other` }],
    },
    { op: "delete", id },
  ]) {
    expect(
      await call("resource_mutate", { resource: "workspace", ...input }),
    ).toMatchObject({
      status: "rejected",
      message: "workspace is read-only.",
    });
  }
  for (const op of ["register", "forget"]) {
    await expect(
      call("resource_mutate", {
        resource: "workspace",
        op,
        id,
        input: { root },
      }),
    ).rejects.toBeInstanceOf(InvalidArgumentsError);
  }
  expect(ask).not.toHaveBeenCalled();
  expect(committed).not.toHaveBeenCalled();
  expect(
    await runtime.runPromise(
      FileSystem.FileSystem.use((fs) =>
        fs.readFileString(join(root, "main.tea")),
      ),
    ),
  ).toBe("close");
});

test("exports resolvable schemas for every Resource and only intrinsic writable inputs", async () => {
  for (const resource of resources) {
    const result = await call("resource_read", {
      resource: resource.name,
      include_schema: true,
      limit: 0,
    });
    expect(result.status).toBe("ok");
    expect(result.schema.listKeys).toEqual(resource.listKeys);
    expect(Object.keys(result.schema.transitions)).toEqual(
      resource.readOnly ? [] : ["create", "patch", "delete"],
    );
    expect(result.schema.transitions).not.toHaveProperty("promote");
    const entity = result.schema.entity;
    if (entity.$ref)
      expect(entity.definitions[entity.$ref.split("/").at(-1)]).toBeDefined();
  }
  const { schema } = await call("resource_read", {
    resource: "agent_schedule",
    include_schema: true,
  });
  expect(schema.transitions.create.properties).toHaveProperty("target");
  expect(schema.transitions.create.properties).not.toHaveProperty("nextFireAt");
});

test("uses limit to include entity examples or return only the schema after permission", async () => {
  await create("First example");
  await create("Second example");
  const input = { resource: "agent_schedule", include_schema: true, limit: 0 };
  const example = await call("resource_read", { ...input, limit: 1 });
  expect(example.status).toBe("ok");
  expect(example.items).toHaveLength(1);
  expect(example.nextCursor).not.toBeNull();

  const { db } = await runtime.runPromise(Database.Service);
  const transaction = vi.spyOn(db, "transaction");
  ask.mockClear();
  expect(await call("resource_read", input)).toEqual({
    status: "ok",
    resource: "agent_schedule",
    schema: example.schema,
  });
  expect(ask).toHaveBeenCalledExactlyOnceWith({
    permission: "resource_read",
    patterns: ["agent_schedule"],
    always: ["agent_schedule"],
    metadata: { resource: "agent_schedule" },
  });
  ask.mockImplementationOnce(() => Effect.die(new DeclinedError({})));
  const declined = await runtime.runPromiseExit(invoke("resource_read", input));
  expect(Exit.hasDies(declined)).toBe(true);
  expect(transaction).not.toHaveBeenCalled();
});

test.each(["resource_read", "resource_mutate"])(
  "%s advertises catalog Resource names and rejects unknown names before execution",
  async (name) => {
    const tools = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ToolRegistry.Service).all();
      }),
    );
    const tool = tools.find((tool) => tool.id === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    const document = JsonSchema.toDocumentDraft07(
      Schema.toJsonSchemaDocument(tool.parameters),
    );
    expect(document.schema).toMatchObject({
      properties: {
        resource: {
          type: "string",
          enum: resources.map((resource) => resource.name),
        },
      },
    });
    await expect(
      call(name, {
        resource: "missing",
        ...(name === "resource_mutate" ? { op: "create", input: {} } : {}),
      }),
    ).rejects.toBeInstanceOf(InvalidArgumentsError);
    expect(ask).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
  },
);

test("rejects undeclared filters, managed writes, and malformed patches", async () => {
  expect(
    await call("resource_read", {
      resource: "agent_schedule_occurrence",
      filter: { fireAt: 1 },
    }),
  ).toMatchObject({ status: "rejected", allowedKeys: ["scheduleId"] });
  expect(
    await call("resource_read", {
      resource: "agent_schedule",
      filter: { name: "Rates" },
    }),
  ).toMatchObject({ status: "rejected", allowedKeys: [] });
  expect(
    await call("resource_mutate", {
      resource: "agent_schedule",
      op: "create",
      input: { ...scheduleBody("Rates"), revision: 10 },
    }),
  ).toMatchObject({ status: "rejected", code: "invalid_arguments" });
  const { entity } = await create("Rates");
  const mutate = (input: unknown) =>
    call("resource_mutate", {
      resource: "agent_schedule",
      id: entity.id,
      op: "patch",
      expected_revision: 1,
      input,
    });
  expect(
    await mutate([{ op: "replace", path: "/missing", value: "x" }]),
  ).toMatchObject({ status: "rejected", code: "resource.patch_rejected" });
  expect(
    await mutate([{ op: "replace", path: "/name", value: 4 }]),
  ).toMatchObject({
    status: "rejected",
    code: "resource.state_invalid",
    issues: expect.any(Array),
  });
  expect(
    (await call("resource_read", { resource: "agent_schedule", id: entity.id }))
      .entity,
  ).toEqual(entity);
});

test("rejects unsupported operations and ambiguous input before execution", async () => {
  for (const [name, input] of [
    [
      "resource_mutate",
      {
        resource: "agent_schedule",
        op: "promote",
        id: "ags_a",
        expected_revision: 1,
      },
    ],
    [
      "resource_mutate",
      { resource: "agent_schedule", op: "patch", id: "ags_a", input: [] },
    ],
    [
      "resource_mutate",
      {
        resource: "agent_schedule",
        op: "create",
        id: "ags_a",
        input: { name: "x" },
      },
    ],
    [
      "resource_mutate",
      { resource: "agent_schedule", op: "delete", id: "ags_a", input: {} },
    ],
    ["resource_read", { resource: "agent_schedule", id: "ags_a", filter: {} }],
    [
      "resource_read",
      { resource: "agent_schedule", id: "ags_a", order: "desc" },
    ],
    [
      "resource_read",
      { resource: "agent_schedule", id: "ags_a", orderBy: "updatedAt" },
    ],
    ["resource_read", { resource: "agent_schedule", order: "newest" }],
    ["resource_read", { resource: "agent_schedule", orderBy: "name" }],
    ["resource_read", { resource: "agent_schedule", limit: MAX_PAGE_SIZE + 1 }],
    ["resource_read", { resource: "agent_schedule", limit: -1 }],
    ["resource_read", { resource: "agent_schedule", limit: 0.5 }],
    ["resource_read", { resource: "agent_schedule", limit: 0 }],
    [
      "resource_read",
      { resource: "agent_schedule", limit: 0, include_schema: false },
    ],
    ...[
      { id: "ags_a" },
      { filter: {} },
      { cursor: "eyJjcmVhdGVkQXQiOjEsImlkIjoiZHNoX2EifQ" },
      { order: "desc" },
      { orderBy: "updatedAt" },
    ].map(
      (extra) =>
        [
          "resource_read",
          {
            resource: "agent_schedule",
            include_schema: true,
            limit: 0,
            ...extra,
          },
        ] as const,
    ),
    ["resource_read", { resource: "agent_schedule", path: "/schedules" }],
    ["resource_search", { query: "" }],
  ] as const) {
    const exit = await runtime.runPromiseExit(invoke(name, input));
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(InvalidArgumentsError);
    } else {
      expect(exit.value.output.type).toBe("text");
      if (exit.value.output.type === "text")
        expect(JSON.parse(exit.value.output.value).status).toBe("rejected");
    }
  }
  expect(ask).not.toHaveBeenCalled();
  expect(committed).not.toHaveBeenCalled();
});

test.each(resources.filter((resource) => resource.readOnly))(
  "$name rejects every Agent mutation even though internal transitions exist",
  async (resource) => {
    const insert = vi.spyOn(resource.store, "insert");
    const save = vi.spyOn(resource.store, "save");
    const remove = vi.spyOn(resource.store, "remove");
    const id = resource.id.create();
    for (const mutation of [
      { op: "create", input: {} },
      {
        op: "patch",
        id,
        expected_revision: 1,
        input: [{ op: "add", path: "/name", value: "Forged" }],
      },
      { op: "delete", id },
    ]) {
      expect(
        await call("resource_mutate", { resource: resource.name, ...mutation }),
      ).toMatchObject({
        status: "rejected",
        code: "invalid_arguments",
        message: `${resource.name} is read-only.`,
      });
    }
    expect(insert).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
  },
);

// Every writable catalog entry exercises a real domain constraint through the
// Agent boundary. Shared schemas own their rules; this table adds no validators.
const writableCases: Array<{
  resource: (typeof resources)[number]["name"];
  input: () => Schema.JsonObject;
  invalid: Schema.JsonObject;
  issuePath: string;
}> = [
  {
    resource: "agent_schedule",
    input: () => scheduleBody("Scheduled prompt"),
    // Workflow intent cannot follow ordinary text in a saved prompt.
    invalid: {
      target: {
        ...savedPrompt,
        prompt: {
          ...savedPrompt.prompt,
          parts: [
            ...savedPrompt.prompt.parts,
            {
              type: "workflow",
              workflow: "workspace:review.workflow.ts",
              args: {},
            },
          ],
        },
      },
    },
    issuePath: "/target/prompt/parts",
  },
];

test("every writable Resource has an Agent mutation rejection and recovery case", () => {
  expect(writableCases.map(({ resource }) => resource).sort()).toEqual(
    resources
      .filter((resource) => !resource.readOnly)
      .map((resource) => resource.name)
      .sort(),
  );
});

test.each(writableCases)(
  "$resource returns repairable create/patch diagnostics without writes and accepts a corrected retry",
  async ({ resource, input, invalid, issuePath }) => {
    const body = input();
    const definition = resources.find((entry) => entry.name === resource)!;
    const insert = vi.spyOn(definition.store, "insert");
    const save = vi.spyOn(definition.store, "save");
    committed.mockClear();
    const issues = expect.arrayContaining([
      expect.objectContaining({
        code: expect.any(String),
        path: expect.stringContaining(issuePath),
        message: expect.any(String),
      }),
    ]);
    expect(
      await call("resource_mutate", {
        resource,
        op: "create",
        input: { ...body, ...invalid },
      }),
    ).toMatchObject({
      status: "rejected",
      code: "invalid_arguments",
      issues,
    });
    expect(insert).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();

    const created = await call("resource_mutate", {
      resource,
      op: "create",
      input: body,
    });
    expect(created.status).toBe("ok");
    committed.mockClear();
    expect(
      await call("resource_mutate", {
        resource,
        op: "patch",
        id: created.entity.id,
        expected_revision: created.entity.revision,
        input: Object.entries(invalid).map(([key, value]) => ({
          op: "replace",
          path: `/${key}`,
          value,
        })),
      }),
    ).toMatchObject({
      status: "rejected",
      code: "resource.state_invalid",
      issues,
    });
    expect(save).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
    expect(
      await call("resource_read", { resource, id: created.entity.id }),
    ).toEqual(created);

    // Caller-authored envelope fields never become writable through either entry point.
    expect(
      await call("resource_mutate", {
        resource,
        op: "create",
        input: { ...body, revision: 99 },
      }),
    ).toMatchObject({ status: "rejected", code: "invalid_arguments" });
    expect(
      await call("resource_mutate", {
        resource,
        op: "patch",
        id: created.entity.id,
        expected_revision: created.entity.revision,
        input: [{ op: "add", path: "/revision", value: 99 }],
      }),
    ).toMatchObject({ status: "rejected", code: "resource.state_invalid" });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();

    const repaired = await call("resource_mutate", {
      resource,
      op: "patch",
      id: created.entity.id,
      expected_revision: created.entity.revision,
      input: Object.keys(invalid).map((key) => ({
        op: "replace",
        path: `/${key}`,
        value: created.entity[key],
      })),
    });
    expect(repaired).toMatchObject({
      status: "ok",
      entity: { id: created.entity.id, revision: created.entity.revision + 1 },
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledTimes(1);
  },
);

test("advertises opaque cursor strings and rejects malformed tokens before Store access", async () => {
  const tools = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* (yield* ToolRegistry.Service).all();
    }),
  );
  const tool = tools.find((tool) => tool.id === "resource_read");
  if (!tool) throw new Error("Missing resource_read tool");
  const document = JsonSchema.toDocumentDraft07(
    Schema.toJsonSchemaDocument(tool.parameters),
  );
  expect(document.schema).toMatchObject({
    properties: {
      cursor: {
        type: "string",
        description: expect.stringContaining("Opaque pagination token"),
      },
      order: { enum: ["asc", "desc"] },
      orderBy: { enum: ["createdAt", "updatedAt"] },
    },
  });
  const list = vi.spyOn(agentScheduleResource.store, "list");
  for (const cursor of ["not a token!", "e30", "bnVsbA"]) {
    expect(
      await call("resource_read", { resource: "agent_schedule", cursor }),
    ).toMatchObject({ status: "rejected", code: "invalid_arguments" });
  }
  await expect(
    call("resource_read", {
      resource: "agent_schedule",
      cursor: { createdAt: 1, id: "ags_a" },
    }),
  ).rejects.toBeInstanceOf(InvalidArgumentsError);
  expect(list).not.toHaveBeenCalled();
});

test.each([
  [undefined, undefined, ["ags_a", "ags_b", "ags_c"]],
  ["createdAt", "asc", ["ags_a", "ags_b", "ags_c"]],
  ["createdAt", "desc", ["ags_c", "ags_b", "ags_a"]],
  ["updatedAt", "asc", ["ags_b", "ags_a", "ags_c"]],
  ["updatedAt", "desc", ["ags_c", "ags_a", "ags_b"]],
] as const)(
  "lists by %s %s through the Agent tool with cursor continuation",
  async (orderBy, order, expected) => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        yield* db.transaction((tx) =>
          tx.insert(agentSchedules).values(
            (
              [
                ["ags_a", 100, 400],
                ["ags_b", 200, 300],
                ["ags_c", 200, 400],
              ] as const
            ).map(([id, createdAt, updatedAt]) => ({
              id,
              name: id,
              enabled: false,
              target: scheduleTarget,
              recurrence: {
                kind: "once" as const,
                fireAt: onceInFuture.fireAt,
              },
              nextFireAt: Date.parse(onceInFuture.fireAt),
              createdAt,
              updatedAt,
            })),
          ),
        );
      }),
    );
    const input = {
      resource: "agent_schedule",
      limit: 2,
      ...(orderBy ? { orderBy } : {}),
      ...(order ? { order } : {}),
    };
    const first = await call("resource_read", input);
    expect(first).toMatchObject({
      status: "ok",
      items: expected.slice(0, 2).map((id) => ({ id })),
      nextCursor: expect.any(String),
    });
    const second = await call("resource_read", {
      ...input,
      cursor: first.nextCursor,
    });
    expect(second).toMatchObject({
      status: "ok",
      items: expected.slice(2).map((id) => ({ id })),
      nextCursor: null,
    });
  },
);

test("lists with opaque cursors and searches every page across Resources without snippets", async () => {
  const { schedules, workspace } = await runtime.runPromise(
    Effect.gen(function* () {
      const schedules = [];
      for (let index = 0; index < MAX_PAGE_SIZE + 5; index++) {
        schedules.push(
          yield* Transactor.run(
            agentScheduleResource.transitions.create({
              name:
                index === MAX_PAGE_SIZE + 4 ? "NEEDLE" : `Schedule ${index}`,
              enabled: false,
              target: scheduleTarget,
              recurrence: { kind: "once", fireAt: onceInFuture.fireAt },
              nextFireAt: 0,
            }),
          ),
        );
      }
      const fs = yield* FileSystem.FileSystem;
      const root = join((yield* Home).root, "needle-notes");
      yield* fs.makeDirectory(root);
      const workspace = yield* Transactor.run(
        workspaceResource.transitions.register({ root }),
      );
      return { schedules, workspace };
    }),
  );
  const first = await call("resource_read", {
    resource: "agent_schedule",
    limit: MAX_PAGE_SIZE,
  });
  expect(first.items).toHaveLength(MAX_PAGE_SIZE);
  expect(first.nextCursor).toEqual(expect.any(String));
  const second = await call("resource_read", {
    resource: "agent_schedule",
    limit: MAX_PAGE_SIZE,
    cursor: first.nextCursor,
  });
  expect(second.items).toHaveLength(5);
  expect(second.nextCursor).toBeNull();
  const { db } = await runtime.runPromise(Database.Service);
  const transaction = vi.spyOn(db, "transaction");
  expect(await call("resource_search", { query: "nEeDlE" })).toEqual({
    status: "ok",
    items: [
      { resource: "workspace", id: workspace.id },
      { resource: "agent_schedule", id: schedules.at(-1)!.id },
    ],
  });
  expect(transaction).toHaveBeenCalledTimes(resources.length + 1);
});

test("converts a write defect into recoverable feedback after rollback and permits the next call", async () => {
  const original = agentScheduleResource.store.insert;
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const insert = vi
    .spyOn(agentScheduleResource.store, "insert")
    .mockImplementationOnce((...args) =>
      original(...args).pipe(
        Effect.andThen(Effect.die(new Error("private database detail"))),
      ),
    );
  expect(await create("Rolled back")).toMatchObject({
    status: "rejected",
    code: "internal",
    message: "Internal server error",
    recovery: expect.any(String),
  });
  expect(committed).not.toHaveBeenCalled();
  expect(
    (await call("resource_read", { resource: "agent_schedule" })).items,
  ).toEqual([]);
  expect((await create("Recovered")).status).toBe("ok");
  expect(insert).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalledTimes(1);
});

test("a synchronous read defect and a failed search return rejection, not partial data", async () => {
  await create("anything");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(agentScheduleResource.store, "list").mockImplementationOnce(() => {
    throw new Error("Read defect");
  });
  expect(
    await call("resource_read", { resource: "agent_schedule" }),
  ).toMatchObject({
    status: "rejected",
    code: "internal",
  });
  vi.spyOn(agentScheduleResource.store, "list").mockReturnValueOnce(
    Effect.die("Search defect"),
  );
  const failed = await call("resource_search", { query: "anything" });
  expect(failed).toMatchObject({ status: "rejected", code: "internal" });
  expect(failed).not.toHaveProperty("items");
});

test("search interruption propagates and prevents later Resource reads", async () => {
  vi.spyOn(workspaceResource.store, "list").mockReturnValueOnce(
    Effect.interrupt,
  );
  const later = vi.spyOn(agentScheduleResource.store, "list");
  const interrupted = await runtime.runPromiseExit(
    invoke("resource_search", { query: "anything" }),
  );
  if (Exit.isSuccess(interrupted)) throw new Error("Expected interruption");
  expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
  expect(later).not.toHaveBeenCalled();
});

test("waits for permission before writes and preserves decline and cancellation", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const approved = yield* Deferred.make<void>();
      const ctx = {
        ...context,
        ask: () =>
          Deferred.succeed(requested, undefined).pipe(
            Effect.andThen(Deferred.await(approved)),
          ),
      };
      const fiber = yield* invoke(
        "resource_mutate",
        {
          resource: "agent_schedule",
          op: "create",
          input: scheduleBody("Allowed"),
        },
        ctx,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      expect(committed).not.toHaveBeenCalled();
      yield* Deferred.succeed(approved, undefined);
      yield* Fiber.join(fiber);
      expect(committed).toHaveBeenCalledTimes(1);
    }),
  );
  const declined = await runtime.runPromiseExit(
    invoke(
      "resource_mutate",
      {
        resource: "agent_schedule",
        op: "create",
        input: scheduleBody("Declined"),
      },
      { ...context, ask: () => Effect.die(new DeclinedError({})) },
    ),
  );
  expect(Exit.hasDies(declined)).toBe(true);
  const cancelled = await runtime.runPromiseExit(
    invoke(
      "resource_read",
      { resource: "agent_schedule" },
      { ...context, ask: () => Effect.interrupt },
    ),
  );
  if (Exit.isSuccess(cancelled)) throw new Error("Expected interruption");
  expect(Cause.hasInterruptsOnly(cancelled.cause)).toBe(true);
  expect(committed).toHaveBeenCalledTimes(1);
});
