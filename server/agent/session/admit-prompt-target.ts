// Purpose: Resolves the Session of a stored prompt target and admits its prompt once per intent.

import type { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import type { AgentPromptTarget } from "@openchart/server/agent/contracts/agent-prompt-target";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import { Session } from "@openchart/server/agent/session";
import { Effect } from "effect";

import { submitPrompt } from "./submit-prompt";

/** One admission of a stored prompt target, identified by its caller-owned intent. */
export interface PromptTargetAdmission {
  /** Stable per fire; a retry of the same fire reuses it. */
  readonly intent: string;
  /** Title of a Session created by this admission. */
  readonly title: string;
  /** Opaque feature key selecting a reusable Session; omitted creates a fresh one. */
  readonly binding?: AgentPromptTarget["binding"];
  readonly input: AgentPromptInput;
}

/**
 * Shared admission for backend owners of an {@link AgentPromptTarget}
 * (Scheduler, Trigger). The owner decides when to fire and supplies the intent.
 *
 * A Run already accepted for the intent keeps its Session and immutable input,
 * even if the target or its binding changed since. Otherwise the binding key
 * resolves through `Session.getOrCreateBound`, or a fresh Session is created;
 * both are ordinary `chat` Sessions. `submitPrompt` then admits or replays the
 * Run and wakes execution without waiting for the model.
 *
 * Session resolution and admission are separate commits: a failure between
 * them can leave an empty Session. Store and Session errors propagate.
 *
 * @returns The durable Run accepted or replayed for the intent.
 *
 * @example
 * ```ts
 * const run = yield* admitPromptTarget({
 *   intent: `schedule:${schedule.id}:${fireAt}`,
 *   title: schedule.name,
 *   binding: schedule.target.binding,
 *   input: schedule.target.prompt,
 * });
 * ```
 */
export const admitPromptTarget = Effect.fn("Agent.admitPromptTarget")(
  function* (admission: PromptTargetAdmission) {
    const store = yield* AgentRunStore.Service;
    const sessions = yield* Session.Service;
    const accepted = yield* store.getByIntent(admission.intent);
    // Retry the saved admission, even if the target or its current binding changed.
    const sessionID =
      accepted?.sessionID ??
      (yield* admission.binding
        ? sessions.getOrCreateBound({
            key: admission.binding.key,
            kind: "chat",
            title: admission.title,
          })
        : sessions.create({ title: admission.title })).id;
    return yield* submitPrompt({
      sessionID,
      sessionIntentID: admission.intent,
      input: accepted?.input ?? admission.input,
    });
  },
);
