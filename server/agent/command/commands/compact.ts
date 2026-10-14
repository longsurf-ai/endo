// Purpose: Compiles /compact into an explicit manual compaction intent.
import { defineCommand } from "@openchart/server/agent/command/definition";
import { Effect, Schema } from "effect";

/** Manual compaction is an ordinary prompt intent; Prompt owns its execution. */
export const compact = defineCommand({
  name: "compact",
  type: "compaction",
  description: "Summarize this conversation to free up context",
  template: "",
  buildParts: ({ expandedText }) =>
    Schema.decodeUnknownEffect(Schema.Literal(""))(expandedText).pipe(
      Effect.map(() => [{ type: "compaction", auto: false }]),
    ),
  restoreArgumentsFromParts: (parts) =>
    Effect.succeed(
      parts.length === 1 && parts[0]?.type === "compaction" && !parts[0].auto
        ? ""
        : undefined,
    ),
});
