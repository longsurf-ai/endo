// Purpose: Generates and normalizes the root Session title from its first real user turn.

export * as SessionTitle from "./title";

import { LLM } from "@openchart/server/agent/llm";
import { toModelMessages } from "@openchart/server/agent/session/message/to-model-messages";
import { AgentProfile } from "@openchart/server/agent/profiles/profile";
import { Session } from "@openchart/server/agent/session";
import { Models } from "@openchart/server/models";
import { TIER1 } from "@openchart/models/model-tiers";
import { assertExists } from "@openchart/utils/assert";
import { Effect, Stream } from "effect";
import type { PreparedTurn } from "./execute";

const TITLE_MINOR_WORDS = new Set(
  "a an and as at but by for from in nor of on or per the to via vs with".split(
    " ",
  ),
);
const TRACKING_REQUEST =
  /^\s*(?:(?:i\s+(?:want|need)\s+to|please)\s+)?(?:track|monitor|watch)\b/iu;

/**
 * Generates a default root title once during its first real user turn.
 * Prompt owns the Session's exclusive run and this task's lifetime. Expected
 * lookup, model, persistence, and 60-second timeout failures are logged; defects
 * and interruption propagate. A fresh read preserves edits made during inference.
 * @example
 * yield* SessionTitle.ensure({session, messages, model, cwd});
 */
export const ensure = Effect.fn("SessionTitle.ensure")(
  function* (
    input: Pick<PreparedTurn, "session" | "messages" | "model" | "cwd">,
  ) {
    if (input.session.parentId || input.session.kind === "delegate") return;
    if (!isDefaultTitle(input.session.title)) return;

    const realUsers = input.messages.filter(
      (message) =>
        message.info.role === "user" &&
        message.parts.some((part) => !("synthetic" in part && part.synthetic)),
    );
    const first = realUsers[0];
    if (!first || realUsers.length !== 1) return;
    const profiles = yield* AgentProfile.Service;
    const agent = yield* profiles.resolve("title");
    if (!agent) return;

    const models = yield* Models.Service;
    const selection = agent.model ?? {
      providerID: input.model.providerID,
      modelID: TIER1,
    };
    const model = yield* models.getModel(
      selection.providerID,
      selection.modelID,
    );
    const onlySubtasks = first.parts.every((part) => part.type === "subtask");
    const prompt = first.parts
      .flatMap((part) => {
        if (part.type === "text") return [part.text];
        if (part.type === "subtask") return [part.prompt];
        return [];
      })
      .join("\n");
    const messages = onlySubtasks
      ? [{ role: "user" as const, content: prompt }]
      : yield* toModelMessages(
          input.messages.slice(0, input.messages.indexOf(first) + 1),
          model,
        );
    const llm = yield* LLM.Service;
    const text = yield* Stream.runFold(
      llm.stream({
        model,
        cwd: input.cwd,
        // Title requests never inherit the conversation's inference variant.
        user: {
          id: first.info.id,
          model: { providerID: model.providerID, modelID: model.id },
        },
        sessionID: input.session.id,
        agent,
        system: [],
        messages: [
          {
            role: "user",
            content: "Generate a title for this conversation:\n",
          },
          ...messages,
        ],
        tools: {},
        retries: 2,
      }),
      () => "",
      (text, event) => text + (event.type === "text-delta" ? event.text : ""),
    );
    const title = normalizeTitle(text, TRACKING_REQUEST.test(prompt));
    if (!title) return;

    const session = yield* Session.Service;
    const current = yield* session.get(input.session.id);
    if (current && isDefaultTitle(current.title)) {
      yield* session.update(current.id, { title });
    }
  },
  Effect.timeout("60 seconds"),
  Effect.catch((error) =>
    Effect.logWarning("Session title generation failed", error),
  ),
);

function isDefaultTitle(title: string): boolean {
  return /^(?:New|Child) session(?: - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/u.test(
    title,
  );
}

function normalizeTitle(text: string, tracking: boolean): string | undefined {
  const firstLine = text
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return;
  let subject = firstLine
    .replace(/^["'`]+|["'`]+$/gu, "")
    .replace(
      /^(?:(?:news\s*feed|newsfeed)(?:\s+(?:column|query))?|conversation|thread|request|topic|title)\s*(?::|[-–—])\s*/iu,
      "",
    )
    .trim();
  // Tracking titles name the durable subject rather than the transient task.
  if (tracking) {
    subject = subject
      .replace(/^(?:tracking|monitoring|watching)\s+/iu, "")
      .replace(/\s+(?:tracking|monitoring|watching|tracker|watchlist)$/iu, "")
      .trim();
  }
  if (!subject) return;
  const parts = subject.split(/(\s+)/u);
  const words = parts
    .map((part, index) => (/\p{L}|\p{N}/u.test(part) ? index : -1))
    .filter((index) => index !== -1);
  const title = parts
    .map((part, index) => {
      const match = part.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
      if (!match) return part;
      const [, prefix, word, suffix] = match;
      assertExists(word, "The title token pattern always captures its word");
      const lower = word.toLocaleLowerCase("en-US");
      if (
        index !== words.at(0) &&
        index !== words.at(-1) &&
        TITLE_MINOR_WORDS.has(lower)
      ) {
        return `${prefix}${lower}${suffix}`;
      }
      if (word !== lower || /[./\\]/u.test(word) || !word[0]) return part;
      return `${prefix}${word[0].toLocaleUpperCase("en-US")}${word.slice(1)}${suffix}`;
    })
    .join("");
  return title.length > 50 ? `${title.substring(0, 47)}...` : title;
}
