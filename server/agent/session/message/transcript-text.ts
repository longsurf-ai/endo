// Purpose: Serializes the existing model-history projection for transcript reads and search.

import type { WithParts } from "@openchart/server/agent/contracts/message";
import type { Part } from "@openchart/server/agent/contracts/part";
import { pruneMessages } from "ai";
import { Effect } from "effect";
import { toModelMessages } from "./to-model-messages";

/**
 * Replaces a completed read_transcript output with a pointer to the Session it
 * copied. Projected in full, each read would embed earlier copies again with
 * another layer of JSON escaping, doubling in size per generation of reads.
 */
function pointToReadSource(part: Part): Part {
  if (
    part.type !== "tool" ||
    part.tool !== "read_transcript" ||
    part.state.status !== "completed"
  )
    return part;
  const source = part.state.input.session_id;
  return {
    ...part,
    state: {
      ...part.state,
      output: {
        type: "text",
        value: `[Copy of session ${typeof source === "string" ? source : "unknown"} omitted; read that session directly with read_transcript.]`,
      },
    },
  };
}

/**
 * Serializes one committed message's model history as JSON, without reasoning.
 * Uses its recorded model; replay owns context, tools, media, and error handling.
 * Synthetic text stays in model history. Empty projections serialize as `[]`.
 * Completed read_transcript outputs become pointers to the Session they read,
 * so transcripts never re-embed other transcripts; that Session stays the source.
 * The caller retains the stored message ID and selects whole Parts. Does not mutate
 * the message; model projection failures, including missing evidence, remain defects.
 * @example
 * const content = yield* transcriptText(message);
 */
export const transcriptText = Effect.fn("transcriptText")(function* (
  message: WithParts,
) {
  const model =
    message.info.role === "user" ? message.info.model : message.info;
  return JSON.stringify(
    pruneMessages({
      messages: yield* toModelMessages(
        [{ ...message, parts: message.parts.map(pointToReadSource) }],
        { providerID: model.providerID, id: model.modelID },
      ),
      reasoning: "all",
    }),
    null,
    2,
  );
});
