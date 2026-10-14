// Purpose: Derives and encodes column-free SQL payloads from the shared transcript contract.

import {
  Assistant,
  MessageInfo,
  User,
} from "@openchart/server/agent/contracts/message";
import * as Part from "@openchart/server/agent/contracts/part";
import { Schema, Struct } from "effect";

// @agent invariant: SQL owns identity, ownership, and role. JSON must
// never duplicate those fields; transcript timestamps remain content facts.
/** User content stored alongside the authoritative message columns. */
export const UserData = User.mapFields(
  Struct.omit(["id", "sessionID", "role"]),
).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Assistant content stored alongside the authoritative message columns. */
export const AssistantData = Assistant.mapFields(
  Struct.omit(["id", "sessionID", "role"]),
).annotate({ parseOptions: { onExcessProperty: "error" } });
/** Message JSON payload, derived from the complete message schemas. */
export const InfoData = Schema.Union([UserData, AssistantData]);
/** Message JSON payload, excluding authoritative SQL columns. */
export type InfoData = typeof InfoData.Encoded;

const partColumns = ["id", "messageID"] as const;

function partData<Fields extends Schema.Struct.Fields>(
  schema: Schema.Struct<Fields>,
) {
  return schema.mapFields(Struct.omit(partColumns)).annotate({
    parseOptions: { onExcessProperty: "error" },
  });
}

/** Part JSON payloads, derived from every complete transcript variant. */
export const PartData = Schema.Union([
  partData(Part.TextPart),
  partData(Part.SubtaskPart),
  partData(Part.WorkflowPart),
  partData(Part.ReasoningPart),
  partData(Part.FilePart),
  partData(Part.ContextPart),
  partData(Part.PluginInputPart),
  partData(Part.ToolPart),
  partData(Part.EvidencePart),
  partData(Part.StepStartPart),
  partData(Part.StepFinishPart),
  partData(Part.AgentPart),
  partData(Part.CompactionPart),
]);
/** Part JSON payload, excluding authoritative SQL columns. */
export type PartData = typeof PartData.Encoded;

/**
 * Encodes Message content for SQL without duplicating its identity or role.
 *
 * @example
 * ```ts
 * const data = yield* encodeInfo(message.info);
 * ```
 */
export function encodeInfo(info: MessageInfo) {
  return info.role === "user"
    ? Schema.encodeEffect(UserData)(
        Struct.omit(info, ["id", "sessionID", "role"]),
      )
    : Schema.encodeEffect(AssistantData)(
        Struct.omit(info, ["id", "sessionID", "role"]),
      );
}

/**
 * Encodes Part content, including nested codecs, without SQL-owned identity.
 *
 * @example
 * ```ts
 * const data = yield* encodePart(textPart);
 * ```
 */
export function encodePart(part: Part.Part) {
  // Struct.omit loses union correlation; PartData derives from exactly this
  // same union and omission above. The encoder retains every variant's codec.
  const data = Struct.omit(part, partColumns) as typeof PartData.Type;
  return Schema.encodeEffect(PartData)(data);
}
