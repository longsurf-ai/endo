// Purpose: Locks intrinsic read-only API surfaces while retaining custom transitions and internal operations.

import { router } from "@openchart/server";
import { temporaryHome } from "@openchart/server/home.test-utils";
import { makeRuntime } from "@openchart/server/runtime";
import { defineResource, Transition } from "@openchart/server/lib/resource";
import { agentScheduleOccurrenceResource } from "@openchart/server/resources/agent-schedule-occurrence";
import { agentScheduleResource } from "@openchart/server/resources/agent-schedule";
import { workspaceResource } from "@openchart/server/resources/workspace";
import { Effect, Schema } from "effect";
import type { inferRouterInputs } from "@trpc/server";
import { expect, expectTypeOf, test } from "vitest";

import { resourceRouters } from "./resource-router";

test("Workspace exposes reads and registration transitions without intrinsic mutations", () => {
  type Inputs = inferRouterInputs<typeof router>;
  expectTypeOf<keyof Inputs["resources"]["workspace"]>().toEqualTypeOf<
    "get" | "list" | "register" | "forget" | "createLocal" | "getDefault"
  >();
  expectTypeOf<keyof typeof workspaceResource.transitions>().toEqualTypeOf<
    | "get"
    | "list"
    | "listAll"
    | "create"
    | "patch"
    | "remove"
    | "register"
    | "forget"
    | "createLocal"
    | "getDefault"
  >();
  const grouped = resourceRouters([workspaceResource]);
  expect(Object.keys(grouped.workspace._def.procedures).sort()).toEqual([
    "createLocal",
    "forget",
    "get",
    "getDefault",
    "list",
    "register",
  ]);
  expect(grouped.workspace._def.procedures.getDefault._def.type).toBe("query");
  expect(grouped.workspace._def.procedures.createLocal._def.type).toBe(
    "mutation",
  );
  expectTypeOf<keyof Inputs["workspace"]>().toEqualTypeOf<
    | "listTree"
    | "listDirectory"
    | "watch"
    | "read"
    | "write"
    | "remove"
    | "rename"
    | "removeDirectory"
    | "mkdir"
  >();
});

test("Occurrence exposes reads and ensureOccurrence in generated types and runtime routes", async () => {
  type Inputs = inferRouterInputs<typeof router>;
  expectTypeOf<
    keyof Inputs["resources"]["agent_schedule_occurrence"]
  >().toEqualTypeOf<"get" | "list" | "ensureOccurrence">();
  expectTypeOf<
    keyof typeof agentScheduleOccurrenceResource.transitions
  >().toEqualTypeOf<
    | "get"
    | "list"
    | "listAll"
    | "create"
    | "patch"
    | "remove"
    | "ensureOccurrence"
  >();
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
  });
  const caller = router.createCaller({ runtime });
  try {
    await expect(
      caller.resources.agent_schedule_occurrence.list(),
    ).resolves.toEqual({ items: [], nextCursor: null });
    await expect(
      // @ts-expect-error Creation is intentionally absent from the API.
      caller.resources.agent_schedule_occurrence.create({}),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      // @ts-expect-error Patch is intentionally absent from the API.
      caller.resources.agent_schedule_occurrence.patch({}),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      // @ts-expect-error Delete is intentionally absent from the API.
      caller.resources.agent_schedule_occurrence.delete({}),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      // @ts-expect-error The exposed custom mutation requires its declared input.
      caller.resources.agent_schedule_occurrence.ensureOccurrence({}),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  } finally {
    await runtime.dispose();
  }
});

test("readOnly hides only intrinsic mutations while the default retains every procedure", () => {
  const example = defineResource({
    name: "example",
    entity: agentScheduleResource.entity,
    store: agentScheduleResource.store,
    transitions: {
      promote: Transition.make({
        kind: "mutation",
        input: Schema.Struct({}),
        resolve: () => Effect.void,
        apply: () => Effect.void,
      }),
    },
  });
  const readOnly = defineResource({
    name: "read_only_example",
    entity: example.entity,
    store: example.store,
    transitions: example.transitionDefinitions,
    readOnly: true,
  });
  expectTypeOf(readOnly.readOnly).toEqualTypeOf<true>();
  expectTypeOf(example.readOnly).toEqualTypeOf<false>();
  expectTypeOf<keyof typeof readOnly.transitions>().toEqualTypeOf<
    "get" | "list" | "listAll" | "create" | "patch" | "remove" | "promote"
  >();
  const grouped = resourceRouters([readOnly, example]);
  expectTypeOf<
    keyof inferRouterInputs<typeof grouped.read_only_example>
  >().toEqualTypeOf<"get" | "list" | "promote">();
  expectTypeOf<keyof inferRouterInputs<typeof grouped.example>>().toEqualTypeOf<
    "get" | "list" | "create" | "patch" | "delete" | "promote"
  >();
  expect(Object.keys(grouped.read_only_example._def.procedures).sort()).toEqual(
    ["get", "list", "promote"],
  );
  expect(Object.keys(grouped.example._def.procedures).sort()).toEqual([
    "create",
    "delete",
    "get",
    "list",
    "patch",
    "promote",
  ]);
});
