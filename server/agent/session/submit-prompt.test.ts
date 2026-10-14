// Purpose: Verifies admission preserves submitted workspace selections and retries.

import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import { agentSessions } from "@openchart/server/agent/schema";
import { SessionExecution } from "@openchart/server/agent/session/execution";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { Effect, Layer } from "effect";
import { expect, test } from "vitest";
import { submitPrompt } from "./submit-prompt";

test("preserves omitted and explicit workspaces without resolving defaults during admission", async () => {
  const woken: string[] = [];
  const dependencies = Layer.mergeAll(
    Database.layer(":memory:", () => Effect.void),
    Events.layer,
    Layer.succeed(Publisher.Service, { publish: () => Effect.void }),
    Layer.succeed(SessionExecution.Service, {
      active: Effect.succeed(new Set<string>()),
      interrupt: () => Effect.void,
      wake: (sessionID) =>
        Effect.sync(() => {
          woken.push(sessionID);
        }),
    }),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service;
      yield* db
        .insert(agentSessions)
        .values({ id: "ses_test", kind: "chat", title: "Test" });
      const request = {
        sessionID: "ses_test",
        sessionIntentID: "default-intent",
        input: {
          agent: "analyst",
          model: { providerID: "codex" as const, modelID: "tier1" as const },
          parts: [{ type: "text" as const, text: "Hello" }],
        },
      };
      const first = yield* submitPrompt(request);
      expect(first.input).toEqual(request.input);
      expect(request.input).not.toHaveProperty("workspaceId");
      expect(yield* submitPrompt(request)).toEqual(first);
      const selected = yield* submitPrompt({
        ...request,
        sessionIntentID: "selected-intent",
        input: { ...request.input, workspaceId: "wsp_selected" },
      });
      const store = yield* AgentRunStore.Service;
      expect(
        (yield* store.list(request.sessionID)).map(
          (run) => run.input.workspaceId,
        ),
      ).toEqual([undefined, "wsp_selected"]);
      expect(selected.input.workspaceId).toBe("wsp_selected");
      expect(woken).toEqual(["ses_test", "ses_test", "ses_test"]);
    }).pipe(
      Effect.provide(
        AgentRunStore.layer.pipe(Layer.provideMerge(dependencies)),
      ),
    ),
  );
});
