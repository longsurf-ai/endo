// Purpose: Owns durable resource, document, session, quote, dig-in, and plugin context.

import { Schema, Struct } from "effect";
import { PartBase } from "./part-base";
import { EvidenceCandidate } from "./evidence-part";

/** Resource identity captured when a prompt is sent; definitions own resolution. */
export const ResourceContext = Schema.Struct({
  kind: Schema.Literal("resource"),
  resource: Schema.String.check(Schema.isMinLength(1)),
  id: Schema.String.check(Schema.isMinLength(1)),
  // Current working targets and explicit attachments have different meaning.
  scope: Schema.Literals(["attached", "current"]),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } })
  .annotate({ identifier: "ResourceContext" });
/** Parsed resource reference and its role in this prompt. */
export type ResourceContext = typeof ResourceContext.Type;

/** Attached text and optional source evidence captured with the message. */
export const DocumentContext = Schema.Struct({
  kind: Schema.Literal("document"),
  title: Schema.String,
  text: Schema.String,
  // Evidence-backed documents keep source blocks here; text is framing only.
  evidence: Schema.optional(
    Schema.Array(EvidenceCandidate)
      .pipe(Schema.mutable)
      .check(Schema.isMinLength(1))
      .check(Schema.isMaxLength(100)),
  ),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } })
  .annotate({ identifier: "DocumentContext" });
/** Parsed document snapshot, including evidence when the source supplies it. */
export type DocumentContext = typeof DocumentContext.Type;

/** Prior analysis reference bounded at the time its source artifact was created. */
export const SessionContext = Schema.Struct({
  kind: Schema.Literal("session"),
  sessionId: Schema.String.check(Schema.isStartsWith("ses")),
  throughCreatedAt: Schema.DateTimeUtcFromString.pipe(
    Schema.decodeTo(Schema.flip(Schema.DateTimeUtcFromString)),
  ),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } })
  .annotate({ identifier: "SessionContext" });
/** Parsed historical session identity and required transcript cutoff. */
export type SessionContext = typeof SessionContext.Type;

/** Quoted text snapshot, independent of the original message or selection. */
export const QuoteContext = Schema.Struct({
  kind: Schema.Literal("quote"),
  text: Schema.String,
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } })
  .annotate({ identifier: "QuoteContext" });
/** Parsed quoted text snapshot. */
export type QuoteContext = typeof QuoteContext.Type;

/** Selected quote framing the first prompt of a dig-in child session. */
export const DigInContext = Schema.Struct({
  kind: Schema.Literal("dig_in"),
  quoteText: Schema.String,
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } })
  .annotate({ identifier: "DigInContext" });
/** Parsed target selection for a dig-in, distinct from an ordinary quote. */
export type DigInContext = typeof DigInContext.Type;

/** Canonical plugin identity shared by context and plugin definitions. */
export const AgentPluginId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*$/, {
    message: "Agent plugin IDs must use lowercase kebab-case",
  }),
).pipe(Schema.brand("AgentPluginId"));
/** Parsed plugin identity. */
export type AgentPluginId = typeof AgentPluginId.Type;

// Plugin context can arrive in prompt input or from a preparation hook.
// Plugin and hook names describe its source, not uniqueness or trusted authorship.
/** Plugin-associated context with its originating lifecycle hook. */
export const PluginContext = Schema.Struct({
  kind: Schema.Literal("plugin"),
  pluginId: AgentPluginId,
  hook: Schema.String.check(Schema.isMinLength(1)),
  content: Schema.String.check(Schema.isMinLength(1)),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } })
  .annotate({ identifier: "PluginContext" });
/** Parsed plugin-associated context. */
export type PluginContext = typeof PluginContext.Type;

/** The context facts shared by model translation and UI rendering. */
export const PartContext = Schema.Union([
  ResourceContext,
  DocumentContext,
  SessionContext,
  QuoteContext,
  DigInContext,
  PluginContext,
]).annotate({ identifier: "PartContext" });
/** Parsed context facts captured with a message. */
export type PartContext = typeof PartContext.Type;

// @agent invariant: Context has one durable shape. UI and model text derive
// from it; neither a display payload nor a live UI target is stored beside it.
// Quote and dig-in remain distinct context kinds even within one session.
/** Immutable prompt context, with no independently persisted presentation. */
export const ContextPart = Schema.Struct({
  ...PartBase.fields,
  type: Schema.Literal("context"),
  context: PartContext,
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } })
  .annotate({ identifier: "ContextPart" });
/** Parsed context part and its message ownership. */
export type ContextPart = typeof ContextPart.Type;
