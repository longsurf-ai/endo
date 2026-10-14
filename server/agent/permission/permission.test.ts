// Purpose: Verifies permission decisions, remembered grants, concurrency, and scoped cleanup.

import { Publisher } from "@openchart/server/agent/publisher/publisher";
import * as Agui from "@openchart/server/agent/publisher/agui/adapter";
import { SessionId } from "@openchart/server/agent/contracts/session";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProfile } from "@openchart/server/agent/profiles/profile";
import { create as createSession } from "@openchart/server/agent/session/operations/create";
import { get as getSession } from "@openchart/server/agent/session/operations/get";
import { Session as SessionService } from "@openchart/server/agent/session";
import { Database } from "@openchart/server/db";
import { EventDefinition, Events } from "@openchart/server/events";
import { AgentEvent } from "@openchart/server/agent/publisher/agui/events";
import { EventType } from "@ag-ui/core";
import { sql } from "drizzle-orm";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Schema,
  Scope,
} from "effect";
import { expect, test } from "vitest";

import { Permission } from "./permission";
import { permissionGrants } from "./schema";

type Environment =
  | Permission.Service
  | Database.Service
  | Events.Service
  | Publisher.Service
  | AgentProfile.Service
  | Scope.Scope;

function profile(
  name: string,
  permission: Permission.Ruleset = [],
): AgentProfile.Info {
  return {
    name,
    permission,
    prompt: "Test profile",
    mode: "primary",
    hidden: false,
    options: {},
  };
}

interface Fixture {
  readonly setProfile: (
    info: AgentProfile.Info,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly published: EventDefinition.Payload[];
  readonly next: Effect.Effect<Permission.Request>;
  readonly hooks: {
    asked?: (request: Permission.Request) => Effect.Effect<void>;
  };
}

function permissions(
  event: EventDefinition.Payload,
): readonly Permission.Request[] | undefined {
  if (event.type !== AgentEvent.type) return undefined;
  const native = Schema.decodeUnknownSync(AgentEvent)(event).data.event;
  if (native.type !== EventType.STATE_DELTA) return undefined;
  const patch = native.delta.find((item) => item.path === "/permissions");
  return patch === undefined
    ? undefined
    : Schema.decodeUnknownSync(Schema.Array(Permission.Request))(patch.value);
}

function run<A, E>(
  program: (fixture: Fixture) => Effect.Effect<A, E, Environment>,
  filename = ":memory:",
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Events.Service;
        const profiles = yield* AgentProfile.Service;
        const setProfile = (info: AgentProfile.Info) =>
          profiles.transform((draft) => {
            draft.update(info.name, (target) =>
              Object.assign(target, structuredClone(info)),
            );
          });
        yield* setProfile(profile("analyst"));
        const asked = yield* Queue.unbounded<Permission.Request>();
        const published: EventDefinition.Payload[] = [];
        const observedIds = new Set<string>();
        const hooks: Fixture["hooks"] = {};
        const observed: Events.Interface = {
          ...events,
          publish: (definition, data, options) =>
            Effect.gen(function* () {
              const requests = permissions({
                id: EventDefinition.ID.create(),
                type: definition.type,
                data,
              });
              const added =
                requests?.filter((request) => !observedIds.has(request.id)) ??
                [];
              for (const request of added)
                if (hooks.asked) yield* hooks.asked(request);
              const event = yield* events.publish(definition, data, options);
              published.push(structuredClone(event));
              for (const request of added) {
                observedIds.add(request.id);
                yield* Queue.offer(asked, request);
              }
              return event;
            }),
        };
        for (const id of ["ses_s1", "ses_s2"].map((id) => SessionId.make(id))) {
          if (!(yield* getSession(id))) yield* createSession({ id });
        }
        return yield* program({
          setProfile,
          published,
          next: Queue.take(asked),
          hooks,
        }).pipe(
          Effect.provide(Permission.layer),
          Effect.provide(Layer.fresh(Agui.layer)),
          Effect.provideService(Events.Service, observed),
        );
      }),
    ).pipe(
      Effect.provide(Layer.fresh(Agui.layer)),
      Effect.provide(
        Layer.mergeAll(
          SessionService.layer,
          Database.layer(filename, () => Effect.void),
          Events.layer,
          AgentProfile.layerDefault,
        ),
      ),
    ),
  );
}

function input(
  overrides: Partial<Permission.AskInput> = {},
): Permission.AskInput {
  return {
    sessionID: "ses_s1",
    action: "read",
    resources: ["/notes/a"],
    ...overrides,
  };
}

test("resolves current profile rules and only queues ask decisions", () =>
  run(({ setProfile, published, next }) =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service;
      yield* setProfile(
        profile("analyst", [
          { action: "read", resource: "*", decision: "allow" },
        ]),
      );
      expect(yield* permission.ask(input())).toBeUndefined();
      yield* setProfile(
        profile("analyst", [
          { action: "read", resource: "*", decision: "deny" },
        ]),
      );
      expect((yield* Effect.flip(permission.ask(input())))._tag).toBe(
        "Permission.BlockedError",
      );
      expect(
        yield* Effect.flip(permission.ask(input({ agent: "missing" }))),
      ).toMatchObject({ _tag: "Permission.BlockedError" });
      expect(
        yield* Effect.flip(permission.ask(input({ sessionID: "missing" }))),
      ).toMatchObject({
        _tag: "AgentStore.NotFound",
        entity: "session",
        id: "missing",
      });
      expect(yield* permission.list()).toEqual([]);
      expect(published).toEqual([]);
      yield* setProfile(profile("analyst"));
      yield* permission.ask(input()).pipe(Effect.exit, Effect.forkScoped);
      const request = yield* next;
      expect(request.id).toMatch(/^per_/);
      expect(yield* permission.list()).toEqual([request]);
      expect(published.map(permissions)).toEqual([[request]]);
    }),
  ));

test.each(["allow", "deny"] as const)(
  "an explicit null profile still asks instead of applying profile %s",
  (decision) =>
    run(({ setProfile, next }) =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service;
        yield* setProfile(
          profile("analyst", [{ action: "*", resource: "*", decision }]),
        );
        const native = input({ agent: null });
        expect(
          Schema.decodeUnknownSync(Permission.AskInput)(native).agent,
        ).toBeNull();
        const waiter = yield* permission.ask(native).pipe(Effect.forkScoped);
        const request = yield* next;
        expect(yield* permission.list()).toEqual([request]);
        expect(request).not.toHaveProperty("agent");
        yield* permission.reply({ requestID: request.id, reply: "once" });
        yield* Fiber.join(waiter);
        expect(yield* permission.list()).toEqual([]);
        expect(
          yield* permission
            .ask(input({ agent: null, sessionID: "missing" }))
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "AgentStore.NotFound" });
      }),
    ),
);

test("native saved approval settles native waiters without overriding application denial", () =>
  run(({ setProfile, next }) =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service;
      yield* setProfile(
        profile("analyst", [{ action: "*", resource: "*", decision: "deny" }]),
      );
      const native = input({ agent: null, save: ["/notes/*"] });
      const first = yield* permission.ask(native).pipe(Effect.forkScoped);
      const request = yield* next;
      const second = yield* permission
        .ask({ ...native, sessionID: "ses_s2" })
        .pipe(Effect.forkScoped);
      yield* next;
      yield* permission.reply({ requestID: request.id, reply: "always" });
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(yield* permission.list()).toEqual([]);
      expect(yield* permission.ask(native)).toBeUndefined();
      expect(
        yield* permission.ask(input({ agent: "analyst" })).pipe(Effect.flip),
      ).toMatchObject({ _tag: "Permission.BlockedError" });
    }),
  ));

test("ask waits until once, exposes detached snapshots, and does not hold a DB transaction", () =>
  run(({ next, published }) =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service;
      let completed = false;
      const args = input({
        metadata: { nested: { value: "original" } },
        source: { type: "tool", messageID: "m", callID: "c" },
      });
      const waiter = yield* permission.ask(args).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            completed = true;
          }),
        ),
        Effect.forkScoped,
      );
      const request = yield* next;
      expect(completed).toBe(false);
      (args.resources as string[])[0] = "/mutated";
      const view = (yield* permission.list())[0]!;
      (view.resources as string[])[0] = "/also-mutated";
      expect((yield* permission.list())[0]?.resources).toEqual(["/notes/a"]);
      yield* createSession({ id: SessionId.make("ses_unblocked-write") });
      yield* permission.reply({ requestID: request.id, reply: "once" });
      yield* Fiber.join(waiter);
      expect(completed).toBe(true);
      expect(yield* permission.list()).toEqual([]);
      expect(
        published.map(permissions).filter((value) => value !== undefined),
      ).toEqual([[request], []]);
    }),
  ));

test("reject with feedback corrects its caller and rejects only other requests in the same Session", () =>
  run(({ next }) =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service;
      const first = yield* permission
        .ask(input())
        .pipe(Effect.flip, Effect.forkScoped);
      const a = yield* next;
      const second = yield* permission
        .ask(input())
        .pipe(Effect.exit, Effect.forkScoped);
      yield* next;
      yield* permission
        .ask(input({ sessionID: "ses_s2" }))
        .pipe(Effect.exit, Effect.forkScoped);
      const other = yield* next;
      yield* permission.reply({
        requestID: a.id,
        reply: "reject",
        message: "Use a public file.",
      });
      const corrected = yield* Fiber.join(first);
      const declined = yield* Fiber.join(second);
      expect(corrected).toMatchObject({
        _tag: "Permission.CorrectedError",
        feedback: "Use a public file.",
      });
      expect(Exit.isFailure(declined) && Cause.hasDies(declined.cause)).toBe(
        true,
      );
      expect(yield* permission.list()).toEqual([other]);
    }),
  ));

test.each(["once", "always"] as const)(
  "%s without save patterns approves only its request",
  (reply) =>
    run(({ setProfile, next }) =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service;
        const first = yield* permission.ask(input()).pipe(Effect.forkScoped);
        const request = yield* next;
        yield* permission.ask(input()).pipe(Effect.exit, Effect.forkScoped);
        const sameSession = yield* next;
        yield* permission
          .ask(input({ sessionID: "ses_s2" }))
          .pipe(Effect.exit, Effect.forkScoped);
        const otherSession = yield* next;
        yield* permission.reply({ requestID: request.id, reply });
        yield* Fiber.join(first);
        expect(yield* permission.list()).toEqual([sameSession, otherSession]);
        yield* permission.ask(input()).pipe(Effect.exit, Effect.forkScoped);
        const later = yield* next;
        expect(yield* permission.list()).toEqual([
          sameSession,
          otherSession,
          later,
        ]);
        yield* setProfile(
          profile("analyst", [
            { action: "*", resource: "*", decision: "deny" },
          ]),
        );
        expect(yield* Effect.flip(permission.ask(input()))).toMatchObject({
          _tag: "Permission.BlockedError",
        });
      }),
    ),
);

test("multiple resources use deny before ask before allow", () =>
  run(({ setProfile, next }) =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service;
      yield* setProfile(
        profile("analyst", [
          { action: "read", resource: "/allowed", decision: "allow" },
          { action: "read", resource: "/denied", decision: "deny" },
        ]),
      );
      yield* permission
        .ask(input({ resources: ["/allowed", "/unknown"] }))
        .pipe(Effect.exit, Effect.forkScoped);
      const combined = yield* next;
      expect(combined.resources).toEqual(["/allowed", "/unknown"]);
      expect(
        yield* Effect.flip(
          permission.ask(input({ resources: ["/unknown", "/denied"] })),
        ),
      ).toMatchObject({ _tag: "Permission.BlockedError" });
      expect(yield* permission.list()).toEqual([combined]);
    }),
  ));

test("service and database reopening retain neither approvals nor pending requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permission-approval-"));
  const filename = join(directory, "app.sqlite");
  try {
    await run(
      ({ next }) =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service;
          const waiter = yield* permission.ask(input()).pipe(Effect.forkScoped);
          const request = yield* next;
          yield* permission.reply({ requestID: request.id, reply: "once" });
          yield* Fiber.join(waiter);
          yield* permission
            .ask(input({ action: "edit" }))
            .pipe(Effect.exit, Effect.forkScoped);
          yield* next;
          expect(yield* permission.list()).toHaveLength(1);
        }),
      filename,
    );
    await run(
      ({ next }) =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service;
          expect(yield* permission.list()).toEqual([]);
          const waiter = yield* permission.ask(input()).pipe(Effect.forkScoped);
          const request = yield* next;
          expect(yield* permission.list()).toEqual([request]);
          yield* permission.reply({ requestID: request.id, reply: "once" });
          yield* Fiber.join(waiter);
        }),
      filename,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent replies settle once and duplicate pending IDs never replace an existing request", () =>
  run(({ published, next }) =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service;
      const id = Permission.ID.make("per_duplicate");
      const waiter = yield* permission
        .ask(input({ id }))
        .pipe(Effect.exit, Effect.forkScoped);
      yield* next;
      const duplicate = yield* Effect.exit(
        permission.ask(input({ id, sessionID: "ses_s2" })),
      );
      expect(Exit.hasDies(duplicate)).toBe(true);
      expect(yield* permission.list()).toMatchObject([
        { id, sessionID: "ses_s1" },
      ]);
      const replies = yield* Effect.all(
        [
          Effect.exit(permission.reply({ requestID: id, reply: "once" })),
          Effect.exit(permission.reply({ requestID: id, reply: "reject" })),
        ],
        { concurrency: "unbounded" },
      );
      expect(replies.filter(Exit.isSuccess)).toHaveLength(1);
      expect(replies.filter(Exit.isFailure)).toHaveLength(1);
      yield* Fiber.join(waiter);
      expect(
        published.filter((event) => permissions(event)?.length === 0),
      ).toHaveLength(1);
    }),
  ));

test("interruption removes a waiting request and late replies fail", () =>
  run(({ next }) =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service;
      const waiter = yield* permission.ask(input()).pipe(Effect.forkScoped);
      const request = yield* next;
      yield* Fiber.interrupt(waiter);
      expect(yield* permission.list()).toEqual([]);
      expect(
        (yield* Effect.flip(
          permission.reply({ requestID: request.id, reply: "once" }),
        ))._tag,
      ).toBe("Permission.NotFoundError");
    }),
  ));

test("ask preserves an uninterruptible caller until approval and cleanup finish", () =>
  run(({ next }) =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service;
      const waiter = yield* permission
        .ask(input())
        .pipe(Effect.uninterruptible, Effect.forkScoped);
      const request = yield* next;
      const stopping = yield* Fiber.interrupt(waiter).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(stopping.pollUnsafe()).toBeUndefined();
      expect(yield* permission.list()).toEqual([request]);

      yield* permission.reply({ requestID: request.id, reply: "once" });
      yield* Fiber.join(stopping);
      expect(yield* permission.list()).toEqual([]);
    }),
  ));

test("scope disposal rejects all waiters, clears pending state, and prevents new approvals", () =>
  run(({ next }) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.build(Layer.fresh(Permission.layer)).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const permission = Context.get(context, Permission.Service);
      const waiter = yield* permission
        .ask(input())
        .pipe(Effect.exit, Effect.forkScoped);
      yield* next;
      const other = yield* permission
        .ask(input({ sessionID: "ses_s2" }))
        .pipe(Effect.exit, Effect.forkScoped);
      yield* next;
      yield* Scope.close(scope, Exit.void);
      const exit = yield* Fiber.join(waiter);
      expect(Exit.hasDies(exit)).toBe(true);
      expect(Exit.hasDies(yield* Fiber.join(other))).toBe(true);
      expect(yield* permission.list()).toEqual([]);
      expect(Exit.hasDies(yield* Effect.exit(permission.ask(input())))).toBe(
        true,
      );
    }),
  ));

test("failed asked publication removes pending state", () =>
  run(({ hooks }) =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service;
      hooks.asked = () => Effect.die("publication failed");
      expect(Exit.hasDies(yield* Effect.exit(permission.ask(input())))).toBe(
        true,
      );
      expect(yield* permission.list()).toEqual([]);
    }),
  ));

test("interruption during asked publication cannot strand a registered request", () =>
  run(({ hooks }) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      hooks.asked = () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
      const permission = yield* Permission.Service;
      const waiter = yield* permission.ask(input()).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      const interruption = yield* Fiber.interrupt(waiter).pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interruption);
      expect(yield* permission.list()).toEqual([]);
    }),
  ));

test("reply schema includes single and remembered authorization", () => {
  expect(Schema.is(Permission.Reply)("once")).toBe(true);
  expect(Schema.is(Permission.Reply)("reject")).toBe(true);
  expect(Schema.is(Permission.Reply)("always")).toBe(true);
});

test("always saves unique patterns, releases covered requests, and respects current profile denies", () =>
  run(({ setProfile, next }) =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service;
      const { db } = yield* Database.Service;
      yield* setProfile(profile("restricted"));
      const first = yield* permission
        .ask(input({ save: ["/notes/*", "/notes/*"] }))
        .pipe(Effect.forkScoped);
      const request = yield* next;
      const second = yield* permission
        .ask(input({ sessionID: "ses_s2" }))
        .pipe(Effect.forkScoped);
      yield* next;
      yield* permission
        .ask(input({ agent: "restricted" }))
        .pipe(Effect.exit, Effect.forkScoped);
      const restricted = yield* next;
      yield* setProfile(
        profile("restricted", [
          { action: "read", resource: "*", decision: "deny" },
        ]),
      );
      yield* permission.reply({ requestID: request.id, reply: "always" });
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(yield* permission.list()).toEqual([restricted]);
      expect(
        yield* db
          .select({
            action: permissionGrants.action,
            resource: permissionGrants.resource,
          })
          .from(permissionGrants),
      ).toEqual([{ action: "read", resource: "/notes/*" }]);
      expect(
        yield* permission.ask(input({ resources: ["/notes/b"] })),
      ).toBeUndefined();
      yield* setProfile(
        profile("analyst", [
          { action: "read", resource: "*", decision: "deny" },
        ]),
      );
      expect(yield* Effect.flip(permission.ask(input()))).toMatchObject({
        _tag: "Permission.BlockedError",
      });
    }),
  ));

test("always persists across service and database reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permission-grants-"));
  const filename = join(directory, "app.sqlite");
  try {
    await run(
      ({ next }) =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service;
          const waiter = yield* permission
            .ask(input({ save: ["/notes/*"] }))
            .pipe(Effect.forkScoped);
          const request = yield* next;
          yield* permission.reply({ requestID: request.id, reply: "always" });
          yield* Fiber.join(waiter);
        }),
      filename,
    );
    await run(
      ({ published }) =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service;
          expect(
            yield* permission.ask(input({ sessionID: "ses_s2" })),
          ).toBeUndefined();
          expect(published).toEqual([]);
          expect(yield* permission.list()).toEqual([]);
        }),
      filename,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed grant writes leave the request pending without publishing approval", () =>
  run(({ next, published }) =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service;
      const { db } = yield* Database.Service;
      yield* db.transaction((tx) =>
        tx.run(sql`
      CREATE TRIGGER reject_grant BEFORE INSERT ON agent_permission_grants
      BEGIN SELECT RAISE(ABORT, 'test grant failure'); END
    `),
      );
      const waiter = yield* permission
        .ask(input({ save: ["/notes/*"] }))
        .pipe(Effect.forkScoped);
      const request = yield* next;
      const result = yield* Effect.exit(
        permission.reply({ requestID: request.id, reply: "always" }),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* permission.list()).toEqual([request]);
      expect(published.map(permissions)).toEqual([[request]]);
      expect(yield* db.select().from(permissionGrants)).toEqual([]);
      yield* db.transaction((tx) => tx.run("DROP TRIGGER reject_grant"));
      yield* permission.reply({ requestID: request.id, reply: "always" });
      yield* Fiber.join(waiter);
      expect(yield* permission.list()).toEqual([]);
      expect(yield* db.select().from(permissionGrants)).toHaveLength(1);
    }),
  ));
