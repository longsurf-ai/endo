// Purpose: Parses the Grok CLI's ACP messages once at the process boundary.
import { z } from "zod";

/** One JSON-RPC 2.0 message on the agent's stdout. */
export const RpcMessage = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .looseObject({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});
export type RpcMessage = z.infer<typeof RpcMessage>;

/** Grok's tool identity on `tool_call` updates; `title` is display text. */
const ToolMeta = z.looseObject({
  "x.ai/tool": z
    .looseObject({ name: z.string(), kind: z.string().optional() })
    .optional(),
});

const TextContent = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
});

/**
 * The `session/update` variants the adapter reads. Other variants (plans,
 * command lists, titles, replayed user chunks) are ignored by name.
 */
export const SessionUpdate = z.discriminatedUnion("sessionUpdate", [
  z.looseObject({
    sessionUpdate: z.literal("agent_message_chunk"),
    content: TextContent,
  }),
  z.looseObject({
    sessionUpdate: z.literal("agent_thought_chunk"),
    content: TextContent,
  }),
  z.looseObject({
    sessionUpdate: z.literal("tool_call"),
    toolCallId: z.string(),
    title: z.string().optional(),
    kind: z.string().optional(),
    status: z.string().optional(),
    rawInput: z.unknown().optional(),
    _meta: ToolMeta.optional(),
  }),
  z.looseObject({
    sessionUpdate: z.literal("tool_call_update"),
    toolCallId: z.string(),
    status: z.string().nullish(),
    title: z.string().nullish(),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
    content: z
      .array(
        z.looseObject({ type: z.string(), content: TextContent.optional() }),
      )
      .nullish(),
  }),
]);
export type SessionUpdate = z.infer<typeof SessionUpdate>;

/** `_x.ai/session_notification` updates that link a child session to its spawn call. */
export const SubagentNotice = z.discriminatedUnion("sessionUpdate", [
  z.looseObject({
    sessionUpdate: z.literal("subagent_spawned"),
    parent_session_id: z.string(),
    child_session_id: z.string(),
    description: z.string().optional(),
    subagent_type: z.string().optional(),
  }),
  z.looseObject({
    sessionUpdate: z.literal("subagent_finished"),
    child_session_id: z.string(),
    status: z.string(),
  }),
]);
export type SubagentNotice = z.infer<typeof SubagentNotice>;

/**
 * Turn usage on the `session/prompt` result. `inputTokens` includes cache
 * reads and `outputTokens` includes reasoning; the turn's subagents are counted
 * in the same totals.
 */
export const TurnUsage = z.looseObject({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cachedReadTokens: z.number().nonnegative().optional(),
  cacheCreationTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
});
export type TurnUsage = z.infer<typeof TurnUsage>;

export const PromptResult = z.looseObject({
  stopReason: z.string(),
  _meta: z
    .looseObject({
      usage: TurnUsage.optional(),
      structuredOutput: z.unknown().optional(),
      structuredOutputError: z.unknown().optional(),
    })
    .optional(),
});
export type PromptResult = z.infer<typeof PromptResult>;

/** `session/request_permission`: one native action and the choices the agent offers. */
export const PermissionRequest = z.looseObject({
  sessionId: z.string(),
  toolCall: z.looseObject({
    toolCallId: z.string(),
    title: z.string().nullish(),
    kind: z.string().nullish(),
    rawInput: z.unknown().optional(),
  }),
  options: z.array(
    z.looseObject({ optionId: z.string(), name: z.string(), kind: z.string() }),
  ),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

/** `_x.ai/ask_user_question`: the `ask_user_question` tool's questions. */
export const QuestionRequest = z.looseObject({
  sessionId: z.string(),
  toolCallId: z.string(),
  questions: z
    .array(
      z.looseObject({
        question: z.string(),
        header: z.string().nullish(),
        options: z
          .array(
            z.looseObject({
              label: z.string(),
              description: z.string().nullish(),
            }),
          )
          .nullish(),
        multiSelect: z.boolean().nullish(),
      }),
    )
    .min(1),
});
export type QuestionRequest = z.infer<typeof QuestionRequest>;

/** One `_x.ai/models/list` entry; efforts list the values `reasoning_effort` accepts. */
export const NativeModel = z.looseObject({
  modelId: z.string().min(1),
  name: z.string(),
  description: z.string().nullish(),
  _meta: z
    .looseObject({
      totalContextTokens: z.number().int().positive().optional(),
      supportsReasoningEffort: z.boolean().optional(),
      reasoningEfforts: z
        .array(z.looseObject({ value: z.string(), default: z.boolean() }))
        .optional(),
    })
    .optional(),
});
export type NativeModel = z.infer<typeof NativeModel>;

export const ModelList = z.looseObject({
  result: z.looseObject({ availableModels: z.array(NativeModel) }),
});

/** `_x.ai/auth/check_subscription`; `meta` is null while signed out. */
export const Subscription = z.looseObject({
  authenticated: z.boolean(),
  meta: z
    .looseObject({
      auth_mode: z.string().optional(),
      subscription_tier: z.string().nullish(),
    })
    .nullish(),
});
export type Subscription = z.infer<typeof Subscription>;

/** `_x.ai/billing`: the plan's credit use in its current period. */
export const Billing = z.looseObject({
  config: z.looseObject({
    creditUsagePercent: z.number().nonnegative(),
    currentPeriod: z
      .looseObject({
        type: z.string(),
        start: z.string().optional(),
        end: z.string().optional(),
      })
      .optional(),
  }),
  subscription_tier: z.string().nullish(),
});
export type Billing = z.infer<typeof Billing>;

/** Plan usage the binding translates into quota meters. */
export interface NativeUsageReport {
  subscription: Subscription;
  billing: Billing;
}
