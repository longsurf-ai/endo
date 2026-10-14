// Purpose: Verifies shared prompt-target admission: Session resolution, intent replay, and bindings.

import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import { agentRun, agentSessions } from "@openchart/server/agent/schema";
import { Session } from "@openchart/server/agent/session";
import { SessionExecution } from "@openchart/server/agent/session/execution";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { Effect, Layer } from "effect";
import { expect, test } from "vitest";

import { admitPromptTarget } from "./admit-prompt-target";

const input = {
  agent: "analyst",
  model: { providerID: "codex" as const, modelID: "tier1" as const },
  parts: [{ type: "text" as const, text: "Review." }],
};
const edited = {
  ...input,
  parts: [{ type: "text" as const, text: "Edited." }],
};

function run<A, E>(
  program: (
    woken: string[],
  ) => Effect.Effect<
    A,
    E,
    | Database.Service
    | AgentRunStore.Service
    | Session.Service
    | SessionExecution.Service
    | Publisher.Service
    | Events.Service
  >,
) {
  const woken: string[] = [];
  const dependencies = Layer.mergeAll(
    Database.layer(":memory:", () => Effect.void),
    Events.layer,
    Session.layer,
    Layer.succeed(Publisher.Service, { publish: () => Effect.void }),
    Layer.succeed(SessionExecution.Service, {
      active: Effect.succeed(new Set<string>()),
      interrupt: () => Effect.void,
      wake: (sessionID) => Effect.sync(() => void woken.push(sessionID)),
    }),
  );
  return Effect.runPromise(
    program(woken).pipe(
      Effect.provide(
        AgentRunStore.layer.pipe(Layer.provideMerge(dependencies)),
      ),
    ),
  );
}

test("a fresh intent creates a titled chat Session; replaying it reuses the Run, Session, and input", () =>
  run((woken) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service;
      const first = yield* admitPromptTarget({
        intent: "trigger:trg_1:ale_1",
        title: "AAPL breakout",
        input,
      });
      expect(first).toMatchObject({ status: "queued", input });
      expect(yield* db.select().from(agentSessions)).toMatchObject([
        { id: first.sessionID, kind: "chat", title: "AAPL breakout" },
      ]);
      // The accepted admission is canonical: later edits never replace it.
      const replayed = yield* admitPromptTarget({
        intent: "trigger:trg_1:ale_1",
        title: "Renamed",
        binding: { key: "other" },
        input: edited,
      });
      expect(replayed).toEqual(first);
      expect(yield* db.select().from(agentSessions)).toHaveLength(1);
      expect(yield* db.select().from(agentRun)).toHaveLength(1);
      expect(woken).toEqual([first.sessionID, first.sessionID]);
    }),
  ));

test("a binding key shares one Session across intents; unbound intents each get their own", () =>
  run(() =>
    Effect.gen(function* () {
      const admit = (intent: string, binding?: { key: string }) =>
        admitPromptTarget({ intent, title: "Review", binding, input });
      const bound = yield* admit("bound-1", { key: "alerts:aapl" });
      const boundAgain = yield* admit("bound-2", { key: "alerts:aapl" });
      const unbound = yield* admit("unbound-1");
      const unboundAgain = yield* admit("unbound-2");
      expect(boundAgain.id).not.toBe(bound.id);
      expect(boundAgain.sessionID).toBe(bound.sessionID);
      expect(
        new Set([bound.sessionID, unbound.sessionID, unboundAgain.sessionID])
          .size,
      ).toBe(3);
      const sessions = yield* Session.Service;
      expect(
        (yield* sessions.getSessionByBinding({ key: "alerts:aapl" }))?.id,
      ).toBe(bound.sessionID);
    }),
  ));
