// Purpose: Owns message roles, serialized errors, LLM requests, and aggregates of transcript Parts.

import { Schema, SchemaGetter, Struct } from "effect";
import { Part } from "./part";

/** Canonical output length error schema for agent transcript content. */
export const OutputLengthError = Schema.Struct({
  name: Schema.Literal("MessageOutputLengthError"),
  data: Schema.declare<object>(
    (value): value is object =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  ).pipe(
    Schema.decodeTo(Schema.Struct({}), {
      decode: SchemaGetter.transform(() => ({})),
      encode: SchemaGetter.passthrough(),
    }),
  ),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({ identifier: "MessageOutputLengthError" });
/** Canonical aborted error schema for agent transcript content. */
export const AbortedError = Schema.Struct({
  name: Schema.Literal("MessageAbortedError"),
  data: Schema.Struct({ message: Schema.String })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "ignore" } }),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({ identifier: "MessageAbortedError" });
/** Canonical auth error schema for agent transcript content. */
export const AuthError = Schema.Struct({
  name: Schema.Literal("ProviderAuthError"),
  data: Schema.Struct({
    providerID: Schema.String,
    message: Schema.String,
  })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "ignore" } }),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({ identifier: "ProviderAuthError" });
/** Canonical apierror schema for agent transcript content. */
export const APIError = Schema.Struct({
  name: Schema.Literal("APIError"),
  data: Schema.Struct({
    message: Schema.String,
    statusCode: Schema.optional(Schema.Finite),
    isRetryable: Schema.Boolean,
    responseHeaders: Schema.optional(
      Schema.Record(Schema.String, Schema.mutableKey(Schema.String)),
    ),
    responseBody: Schema.optional(Schema.String),
    metadata: Schema.optional(
      Schema.Record(Schema.String, Schema.mutableKey(Schema.String)),
    ),
  })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "ignore" } }),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({ identifier: "APIError" });
/** Parsed apierror value. */
export type APIError = typeof APIError.Type;

/** Canonical unknown error schema for agent transcript content. */
export const UnknownError = Schema.Struct({
  name: Schema.Literal("UnknownError"),
  data: Schema.Struct({ message: Schema.String })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "ignore" } }),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({ identifier: "UnknownError" });

/** Canonical llm tool definition schema for agent transcript content. */
export const LlmToolDefinition = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Record(Schema.String, Schema.mutableKey(Schema.Any)),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "AssistantLlmToolDefinition",
  });
/** Parsed llm tool definition value. */
export type LlmToolDefinition = typeof LlmToolDefinition.Type;

/** Canonical llm request schema for agent transcript content. */
export const LlmRequest = Schema.Struct({
  instructions: Schema.optional(Schema.String),
  system: Schema.Array(Schema.String).pipe(Schema.mutable),
  tools: Schema.Array(LlmToolDefinition).pipe(Schema.mutable),
  toolChoice: Schema.optional(Schema.String),
  outputSchema: Schema.optional(Schema.JsonObject),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "AssistantLlmRequest",
  });
/** Parsed llm request value. */
export type LlmRequest = typeof LlmRequest.Type;

// Base message type.
const Base = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } });

/** Canonical user schema for agent transcript content. */
export const User = Schema.Struct({
  ...Base.fields,
  role: Schema.Literal("user"),
  time: Schema.Struct({
    created: Schema.Finite,
  })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "ignore" } }),

  // Which agent for this turn.
  agent: Schema.String,

  /** Optional workspace selection; omission uses the default workspace. */
  workspaceId: Schema.optional(Schema.String.check(Schema.isMinLength(1))),

  // Selected model and optional inference variant for this turn.
  model: Schema.Struct({
    providerID: Schema.String,
    modelID: Schema.String,
    selectedVariant: Schema.optional(Schema.String),
  })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "ignore" } }),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "UserMessage",
  });
/** Parsed user value. */
export type User = typeof User.Type;

/** Canonical assistant schema for agent transcript content. */
export const Assistant = Schema.Struct({
  ...Base.fields,
  role: Schema.Literal("assistant"),
  time: Schema.Struct({
    created: Schema.Finite,
    completed: Schema.optional(Schema.Finite),
  })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "ignore" } }),
  error: Schema.optional(
    Schema.Union([
      AuthError,
      UnknownError,
      OutputLengthError,
      AbortedError,
      APIError,
    ]),
  ),

  // The user message that triggered this assistant message.
  triggeringUserMessageID: Schema.String,
  modelID: Schema.String,
  providerID: Schema.String,
  agent: Schema.String,
  path: Schema.Struct({
    cwd: Schema.String,
    root: Schema.String,
  })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "ignore" } }),
  summary: Schema.optional(Schema.Boolean),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    })
      .mapFields(Struct.map(Schema.mutableKey))
      .annotate({ parseOptions: { onExcessProperty: "ignore" } }),
  })
    .mapFields(Struct.map(Schema.mutableKey))
    .annotate({ parseOptions: { onExcessProperty: "ignore" } }),

  // The finish reason for the assistant message. It can be used to indicate
  // whether if the message is finished with natural stop or pending tool
  // calls, or interrupted by the user or system.
  finish: Schema.optional(Schema.String),

  // One root Assistant records one model request, which may contain multiple
  // provider steps. Delegate Assistants belong to the same request.
  request: Schema.optional(LlmRequest),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "AssistantMessage",
  });
/** Parsed assistant value. */
export type Assistant = typeof Assistant.Type;

/** Message header schema for either role, excluding transcript Parts. */
export const MessageInfo = Schema.Union([User, Assistant]).annotate({
  identifier: "MessageInfo",
});
/** Parsed message header, excluding transcript Parts. */
export type MessageInfo = typeof MessageInfo.Type;

// Echoes the session intent that caused this event so clients can reconcile
// optimistic state without guessing from message/run ordering.
/** Canonical operation echo schema for agent transcript content. */
export const OperationEcho = Schema.Struct({
  sessionIntentId: Schema.String,
  kind: Schema.Literals(["prompt", "steer"]),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } })
  .annotate({
    identifier: "AgentOperationEcho",
  });
/** Parsed operation echo value. */
export type OperationEcho = typeof OperationEcho.Type;

/** Canonical with parts schema for agent transcript content. */
export const WithParts = Schema.Struct({
  info: MessageInfo,
  parts: Schema.Array(Part).pipe(Schema.mutable),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "ignore" } });
/** Parsed with parts value. */
export type WithParts = typeof WithParts.Type;
