import { QueryClient } from "@tanstack/react-query";
// Purpose: Exercises the real provider backend through the production frontend SessionStore.
import { CLAUDE_CODE, CODEX, TIER1 } from "@openchart/models/model-tiers";

import assert from "node:assert/strict";
import { EventSource } from "eventsource";
import type { Message } from "@ag-ui/core";
import { Observable, filter, firstValueFrom, throwError, timeout } from "rxjs";
import {
  createAgentClient,
  type ModelSelection,
} from "@openchart/app/lib/agent/client";
import {
  createSessionStore,
  type SessionStore,
} from "@openchart/app/lib/agent/session-store";
import { createTransport } from "@openchart/app/lib/transport/transport";

type Session = ReturnType<SessionStore["getSession"]>;
type Snapshot = ReturnType<Session["getSnapshot"]>;

const origin = new URL(process.argv[2] ?? "http://127.0.0.1:43873").origin;
const onlyProvider = process.argv[3];
const onlyScenario = process.argv[4];
const remote = createAgentClient(createTransport({ origin }, { EventSource }));
const store = createSessionStore(remote, new QueryClient());
const created: string[] = [];
const results: { provider: string; scenario: string; elapsedMs: number }[] = [];
const token = crypto.randomUUID().slice(0, 8).toUpperCase();

function runStatus(snapshot: Snapshot, runID: string): string | undefined {
  const runs: readonly { id: string; status: string }[] =
    snapshot.state?.runs ?? [];
  return runs.find((run) => run.id === runID)?.status;
}

function text(message: Message): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.role === "user"
    ? message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
    : "";
}

function waitFor(
  session: Session,
  predicate: (snapshot: Snapshot) => boolean,
  description: string,
  runID?: string,
): Promise<Snapshot> {
  return firstValueFrom(
    new Observable<Snapshot>((subscriber) => {
      const emit = () => subscriber.next(session.getSnapshot());
      const unsubscribe = session.subscribe(emit);
      emit();
      return unsubscribe;
    }).pipe(
      filter((snapshot) => {
        if (predicate(snapshot)) return true;
        if (
          runID &&
          ["completed", "stop", "failed"].includes(
            runStatus(snapshot, runID) ?? "",
          )
        )
          throw new Error(
            `Run ${runID} ended before ${description}: ${snapshot.error ?? runStatus(snapshot, runID)}`,
          );
        return false;
      }),
      timeout({
        first: 180_000,
        with: () =>
          throwError(
            () =>
              new Error(
                `Timed out waiting for ${description}: ${session.getSnapshot().error ?? runID ?? session.id}`,
              ),
          ),
      }),
    ),
  );
}

async function createSession(title: string) {
  const info = await remote.createSession({ title });
  const session = store.getSession(info.id);
  created.push(session.id);
  await waitFor(session, (snapshot) => !snapshot.loading, "initial snapshot");
  return session;
}

async function freshSnapshot(sessionID: string) {
  const coldStore = createSessionStore(remote, new QueryClient());
  try {
    return await waitFor(
      coldStore.getSession(sessionID),
      (snapshot) => !snapshot.loading,
      "fresh bootstrap snapshot",
    );
  } finally {
    coldStore.dispose();
  }
}

async function terminal(session: Session, runID: string) {
  const snapshot = await waitFor(
    session,
    (snapshot) =>
      ["completed", "stop", "failed"].includes(
        runStatus(snapshot, runID) ?? "",
      ),
    `terminal run ${runID}`,
  );
  const canonical = await freshSnapshot(session.id);
  assert.deepEqual(snapshot.messages, canonical.messages);
  assert.deepEqual(snapshot.state, canonical.state);
  return snapshot;
}

async function completed(session: Session, runID: string) {
  const snapshot = await terminal(session, runID);
  assert.equal(runStatus(snapshot, runID), "completed");
  return snapshot;
}

async function permission(session: Session, runID: string) {
  const snapshot = await waitFor(
    session,
    (snapshot) => (snapshot.state?.permissions.length ?? 0) > 0,
    "Echo permission request",
    runID,
  );
  const request = snapshot.state?.permissions[0];
  assert.ok(request);
  assert.equal(request.action, "echo");
  assert.equal(request.sessionID, session.id);
  return request;
}

async function scenario(
  provider: string,
  name: string,
  run: () => Promise<void>,
) {
  if (onlyScenario && !name.includes(onlyScenario)) return;
  const start = performance.now();
  await run();
  const result = {
    provider,
    scenario: name,
    elapsedMs: Math.round(performance.now() - start),
  };
  results.push(result);
  console.log(JSON.stringify({ passed: result }));
}

function echoPrompt(value: string) {
  return `Call the Endo echo tool exactly once with {"text":"${value}"}. Use the tool, not a simulated answer. After its result, reply briefly. If permission is rejected, do not retry the tool.`;
}

async function exercise(model: ModelSelection) {
  const provider = model.providerID;
  const session = await createSession(`AG-UI live ${provider} ${token}`);
  const other = await createSession(`AG-UI independent ${provider} ${token}`);
  assert.equal(store.getSession(session.id), session);
  let firstSubscriber = 0;
  let secondSubscriber = 0;
  const first = session.subscribe(() => firstSubscriber++);
  const second = session.subscribe(() => secondSubscriber++);

  await scenario(
    provider,
    "multi-turn and independent shared subscriptions",
    async () => {
      const code = `MEMORY_${provider}_${token}`;
      const firstRun = await session.submit(
        [
          {
            type: "text",
            text: `Remember this exact code: ${code}. Reply READY only. Do not use tools.`,
          },
        ],
        model,
      );
      await completed(session, firstRun.id);
      first();
      const firstCount = firstSubscriber;
      const secondCount = secondSubscriber;
      const nextRun = await session.submit(
        [
          {
            type: "text",
            text: "What exact code did I ask you to remember? Reply with that code only. Do not use tools.",
          },
        ],
        model,
      );
      const snapshot = await completed(session, nextRun.id);
      assert.ok(
        snapshot.messages
          .filter((message) => message.role === "assistant")
          .some((message) => text(message).includes(code)),
      );
      assert.equal(firstSubscriber, firstCount);
      assert.ok(secondSubscriber > secondCount);
      assert.deepEqual(other.getSnapshot().messages, []);
      second();
    },
  );

  await scenario(
    provider,
    "approval once and cold attach while waiting",
    async () => {
      const value = `ONCE_${provider}_${token}`;
      for (let index = 0; index < 2; index++) {
        const run = await session.submit(
          [{ type: "text", text: echoPrompt(value) }],
          model,
        );
        const request = await permission(session, run.id);
        if (index === 0) {
          const coldStore = createSessionStore(remote, new QueryClient());
          try {
            const cold = coldStore.getSession(session.id);
            const restored = await waitFor(
              cold,
              (snapshot) => !snapshot.loading,
              "cold permission snapshot",
            );
            assert.deepEqual(
              restored.messages,
              (await freshSnapshot(session.id)).messages,
            );
            assert.ok(
              restored.state?.permissions.some(
                (item) => item.id === request.id,
              ),
            );
            await cold.replyPermission(request.id, "once");
            await completed(cold, run.id);
          } finally {
            coldStore.dispose();
          }
        } else {
          await session.replyPermission(request.id, "once");
        }
        const snapshot = await completed(session, run.id);
        assert.ok(
          snapshot.messages.some(
            (message) =>
              message.role === "tool" &&
              text(message).includes(`echo ${value}`),
          ),
        );
        assert.deepEqual(snapshot.state?.permissions, []);
      }
    },
  );

  await scenario(
    provider,
    "approval always applies to another session",
    async () => {
      const value = `ALWAYS_${provider}_${token}`;
      const run = await session.submit(
        [{ type: "text", text: echoPrompt(value) }],
        model,
      );
      await session.replyPermission(
        (await permission(session, run.id)).id,
        "always",
      );
      await completed(session, run.id);
      let asked = false;
      const unsubscribe = other.subscribe(() => {
        asked ||= (other.getSnapshot().state?.permissions.length ?? 0) > 0;
      });
      try {
        const next = await other.submit(
          [{ type: "text", text: echoPrompt(value) }],
          model,
        );
        const snapshot = await completed(other, next.id);
        assert.equal(asked, false);
        assert.ok(
          snapshot.messages.some(
            (message) =>
              message.role === "tool" &&
              text(message).includes(`echo ${value}`),
          ),
        );
      } finally {
        unsubscribe();
      }
    },
  );

  await scenario(
    provider,
    "reject permission without executing the tool",
    async () => {
      const value = `REJECT_${provider}_${token}`;
      const run = await session.submit(
        [{ type: "text", text: echoPrompt(value) }],
        model,
      );
      await session.replyPermission(
        (await permission(session, run.id)).id,
        "reject",
      );
      const snapshot = await terminal(session, run.id);
      assert.deepEqual(snapshot.state?.permissions, []);
      assert.equal(runStatus(snapshot, run.id), "failed");
      assert.equal(
        snapshot.messages.some(
          (message) =>
            message.role === "tool" && text(message) === `echo ${value}`,
        ),
        false,
      );
    },
  );

  await scenario(
    provider,
    "cancel pending approval and continue the conversation",
    async () => {
      const run = await session.submit(
        [{ type: "text", text: echoPrompt(`CANCEL_${provider}_${token}`) }],
        model,
      );
      await permission(session, run.id);
      await session.cancel();
      const snapshot = await terminal(session, run.id);
      assert.equal(runStatus(snapshot, run.id), "stop");
      assert.equal(snapshot.error, undefined);
      assert.deepEqual(snapshot.state?.permissions, []);
      const resumed = await session.submit(
        [{ type: "text", text: "Reply RECOVERED only. Do not call tools." }],
        model,
      );
      const recovered = await completed(session, resumed.id);
      assert.ok(
        recovered.messages.some(
          (message) =>
            message.role === "assistant" && text(message).includes("RECOVERED"),
        ),
      );
    },
  );

  await scenario(
    provider,
    "concurrent sessions isolate permissions and interruption",
    async () => {
      const firstRun = await session.submit(
        [
          {
            type: "text",
            text: echoPrompt(`CONCURRENT_A_${provider}_${token}`),
          },
        ],
        model,
      );
      const secondRun = await other.submit(
        [
          {
            type: "text",
            text: echoPrompt(`CONCURRENT_B_${provider}_${token}`),
          },
        ],
        model,
      );
      const firstRequest = await permission(session, firstRun.id);
      const secondRequest = await permission(other, secondRun.id);
      assert.notEqual(firstRequest.id, secondRequest.id);
      await session.cancel();
      const cancelled = await terminal(session, firstRun.id);
      assert.equal(runStatus(cancelled, firstRun.id), "stop");
      assert.equal(cancelled.error, undefined);
      assert.ok(
        other
          .getSnapshot()
          .state?.permissions.some(
            (request) => request.id === secondRequest.id,
          ),
      );
      await other.replyPermission(secondRequest.id, "once");
      await completed(other, secondRun.id);
      const resumed = await session.submit(
        [
          {
            type: "text",
            text: "Reply CONCURRENT_RECOVERED only. Do not call tools.",
          },
        ],
        model,
      );
      await completed(session, resumed.id);
    },
  );

  await scenario(
    provider,
    "late attach during text streaming and interruption",
    async () => {
      const before = new Set(
        session.getSnapshot().messages.map((message) => message.id),
      );
      const run = await session.submit(
        [
          {
            type: "text",
            text: "Without tools, write integers 1 through 3000, one per line, with a short original sentence after every integer. Begin immediately and continue through 3000.",
          },
        ],
        model,
      );
      await waitFor(
        session,
        (snapshot) =>
          snapshot.messages.some(
            (message) =>
              message.role === "assistant" &&
              !before.has(message.id) &&
              text(message).length > 20,
          ),
        "streamed assistant text",
        run.id,
      );
      const coldStore = createSessionStore(remote, new QueryClient());
      try {
        const cold = coldStore.getSession(session.id);
        await waitFor(
          cold,
          (snapshot) =>
            !snapshot.loading &&
            snapshot.messages.some(
              (message) =>
                message.role === "assistant" &&
                !before.has(message.id) &&
                text(message).length > 20,
            ),
          "late streaming observer",
          run.id,
        );
        await cold.cancel();
        const interrupted = await terminal(cold, run.id);
        assert.equal(runStatus(interrupted, run.id), "stop");
        assert.equal(interrupted.error, undefined);
        const original = await terminal(session, run.id);
        assert.deepEqual(interrupted.messages, original.messages);
      } finally {
        coldStore.dispose();
      }
    },
  );
}

try {
  const providers = await remote.models();
  for (const providerID of [CODEX, CLAUDE_CODE]) {
    if (onlyProvider && onlyProvider !== "all" && onlyProvider !== providerID)
      continue;
    const preferred = TIER1;
    const available = providers
      .find((provider) => provider.id === providerID)
      ?.models.find((model) => model.id === preferred);
    assert.ok(
      available,
      `${providerID}/${preferred} must be available and authenticated`,
    );
    await exercise({
      providerID,
      modelID: available.id,
      ...(available.availableVariants?.includes("low")
        ? { selectedVariant: "low" }
        : {}),
    });
  }
  assert.ok(results.length > 0, "At least one provider must be selected");
  console.log(JSON.stringify({ origin, passed: results }, null, 2));
} finally {
  await Promise.allSettled(
    created.map(async (sessionID) => {
      await remote.cancel(sessionID);
    }),
  );
  store.dispose();
}
