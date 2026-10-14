// Purpose: Owns the Codex app-server wire subset OpenChart consumes, parsed once at the RPC boundary.
import { z } from "zod";

/**
 * Protocol layer. Codex app-server speaks newline-delimited JSON-RPC 2.0 without
 * the `jsonrpc` field. Every message OpenChart reads is parsed here with loose
 * objects: known fields are typed, unknown fields survive so raw items can be
 * forwarded as provider metadata. Known item variants with malformed bodies fail
 * instead of degrading to the unknown-item branch.
 *
 * Source of truth: `codex app-server generate-json-schema` for the pinned CLI.
 */

const loose = z.looseObject;

function item<Type extends string, Shape extends z.ZodRawShape>(
  type: Type,
  shape: Shape,
) {
  return loose({ type: z.literal(type), id: z.string(), ...shape });
}

const KNOWN_ITEM_TYPES = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "contextCompaction",
]);

export const McpToolCallResult = loose({
  content: z.array(z.unknown()),
  structuredContent: z.unknown().nullish(),
  _meta: z.unknown().nullish(),
});
export type McpToolCallResult = z.infer<typeof McpToolCallResult>;

const AsyncUserInputQuestion = z.object({
  title: z.string(),
  options: z.array(z.string()).nullish(),
});

/** Questions carried by a completed native assistant message. */
export interface AsyncQuestionRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: z.infer<typeof AsyncUserInputQuestion>[];
}

/** Thread items OpenChart translates; unknown future variants keep only type/id. */
export const ThreadItem = z.union([
  item("userMessage", {}),
  item("agentMessage", {
    text: z.string(),
    phase: z.string().nullish(),
    questions: z.array(AsyncUserInputQuestion).nullish(),
  }),
  item("reasoning", {
    summary: z.array(z.string()).default([]),
    content: z.array(z.string()).default([]),
  }),
  item("commandExecution", {
    command: z.string(),
    cwd: z.string(),
    status: z.string(),
    aggregatedOutput: z.string().nullish(),
    exitCode: z.number().nullish(),
    durationMs: z.number().nullish(),
  }),
  item("fileChange", { changes: z.array(z.unknown()), status: z.string() }),
  item("mcpToolCall", {
    server: z.string(),
    tool: z.string(),
    status: z.string(),
    arguments: z.unknown(),
    result: McpToolCallResult.nullish(),
    error: z.unknown().nullish(),
    durationMs: z.number().nullish(),
  }),
  item("dynamicToolCall", {
    namespace: z.string().nullish(),
    tool: z.string(),
    arguments: z.unknown(),
    status: z.string(),
    success: z.boolean().nullish(),
    durationMs: z.number().nullish(),
  }),
  item("collabAgentToolCall", {
    tool: z.string(),
    status: z.string(),
    senderThreadId: z.string(),
    receiverThreadIds: z.array(z.string()).default([]),
    prompt: z.string().nullish(),
    model: z.string().nullish(),
    agentsStates: z
      .record(
        z.string(),
        loose({ status: z.string(), message: z.string().nullish() }),
      )
      .default({}),
  }),
  item("subAgentActivity", {
    kind: z.enum(["started", "interacted", "interrupted", "completed"]),
    agentThreadId: z.string(),
    agentPath: z.string(),
  }),
  item("webSearch", { query: z.string().nullish() }),
  item("contextCompaction", {}),
  // Future variants get their own discriminant so known ones narrow cleanly.
  loose({
    type: z.string().refine((type) => !KNOWN_ITEM_TYPES.has(type)),
    id: z.string(),
  }).transform(({ type, ...rest }) => ({
    ...rest,
    type: "unknown" as const,
    nativeType: type,
  })),
]);
export type ThreadItem = z.infer<typeof ThreadItem>;
export type ThreadItemOf<Type extends ThreadItem["type"]> = Extract<
  ThreadItem,
  { type: Type }
>;

export const Turn = loose({
  id: z.string(),
  status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
  error: loose({
    message: z.string(),
    codexErrorInfo: z.unknown().nullish(),
  }).nullish(),
});
export type Turn = z.infer<typeof Turn>;

const TokenUsageBreakdown = loose({
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
});

const scoped = { threadId: z.string(), turnId: z.string() };
const delta = { ...scoped, itemId: z.string(), delta: z.string() };

/** Notifications with a translation; every other method is ignored. */
export const Notifications = {
  "thread/started": loose({
    thread: loose({ id: z.string(), parentThreadId: z.string().nullish() }),
  }),
  "turn/started": loose({ threadId: z.string(), turn: Turn }),
  "turn/completed": loose({ threadId: z.string(), turn: Turn }),
  "item/started": loose({ ...scoped, item: ThreadItem }),
  "item/completed": loose({ ...scoped, item: ThreadItem }),
  "item/agentMessage/delta": loose(delta),
  "item/reasoning/textDelta": loose(delta),
  "item/reasoning/summaryTextDelta": loose(delta),
  "thread/tokenUsage/updated": loose({
    ...scoped,
    tokenUsage: loose({ last: TokenUsageBreakdown }),
  }),
  error: loose({
    ...scoped,
    error: loose({
      message: z.string(),
      codexErrorInfo: z.unknown().nullish(),
    }),
    willRetry: z.boolean(),
  }),
} as const;

export type Notification = {
  [Method in keyof typeof Notifications]: {
    method: Method;
    params: z.infer<(typeof Notifications)[Method]>;
  };
}[keyof typeof Notifications];

/**
 * Parses a known notification; unknown methods return undefined and malformed
 * known methods throw.
 * @example const event = parseNotification("turn/completed", params);
 */
export function parseNotification(
  method: string,
  params: unknown,
): Notification | undefined {
  if (!Object.hasOwn(Notifications, method)) return undefined;
  const schema = Notifications[method as keyof typeof Notifications];
  return { method, params: schema.parse(params) } as Notification;
}

/** Server-to-client requests OpenChart answers; each carries its owning thread. */
export const ServerRequests = {
  "item/commandExecution/requestApproval": loose({
    ...scoped,
    itemId: z.string(),
    command: z.string().nullish(),
    cwd: z.string().nullish(),
    reason: z.string().nullish(),
  }),
  "item/fileChange/requestApproval": loose({
    ...scoped,
    itemId: z.string(),
    reason: z.string().nullish(),
    grantRoot: z.string().nullish(),
  }),
  "item/permissions/requestApproval": loose({
    ...scoped,
    itemId: z.string(),
    cwd: z.string(),
    permissions: z.record(z.string(), z.unknown()),
    reason: z.string().nullish(),
  }),
  "mcpServer/elicitation/request": loose({
    threadId: z.string(),
    serverName: z.string(),
    request: z.unknown().optional(),
  }),
  "item/tool/call": loose({
    ...scoped,
    callId: z.string(),
    namespace: z.string().nullish(),
    tool: z.string(),
    arguments: z.unknown(),
  }),
  "item/tool/requestUserInput": loose({
    ...scoped,
    itemId: z.string(),
    isBlocking: z.boolean(),
    questions: z
      .array(
        z.object({
          id: z.string().min(1),
          header: z.string(),
          question: z.string(),
          isOther: z.boolean().default(false),
          isSecret: z.boolean().default(false),
          options: z
            .array(z.object({ label: z.string(), description: z.string() }))
            .nullish(),
        }),
      )
      .min(1)
      .refine(
        (questions) =>
          new Set(questions.map((question) => question.id)).size ===
          questions.length,
        "Question IDs must be unique",
      ),
  }),
} as const;

export type ServerRequest = {
  [Method in keyof typeof ServerRequests]: {
    method: Method;
    params: z.infer<(typeof ServerRequests)[Method]>;
  };
}[keyof typeof ServerRequests];

/** Native reply shape returned by the host's question policy. */
export const QuestionResponse = z.object({
  answers: z.record(z.string(), z.object({ answers: z.array(z.string()) })),
});

/**
 * Parses a known server request; unknown methods return undefined.
 * @example const request = parseServerRequest("item/tool/call", params);
 */
export function parseServerRequest(
  method: string,
  params: unknown,
): ServerRequest | undefined {
  if (!Object.hasOwn(ServerRequests, method)) return undefined;
  const schema = ServerRequests[method as keyof typeof ServerRequests];
  return { method, params: schema.parse(params) } as ServerRequest;
}

// Responses OpenChart reads. Fields it never reads stay unparsed.
export const InitializeResponse = loose({ userAgent: z.string() });
export const ThreadStartResponse = loose({ thread: loose({ id: z.string() }) });
export const TurnStartResponse = loose({ turn: loose({ id: z.string() }) });
export const EmptyResponse = loose({});
export const AccountReadResponse = loose({
  account: loose({ type: z.string() }).nullable(),
  requiresOpenaiAuth: z.boolean(),
});
export type AccountReadResponse = z.infer<typeof AccountReadResponse>;

const RateLimitWindow = loose({
  usedPercent: z.number(),
  windowDurationMins: z.number().int().positive().nullish(),
  /** Unix seconds. */
  resetsAt: z.number().int().nullish(),
});
const RateLimitSnapshot = loose({
  limitName: z.string().nullish(),
  normalModelSlug: z.string().nullish(),
  planType: z.string().nullish(),
  primary: RateLimitWindow.nullish(),
  secondary: RateLimitWindow.nullish(),
});
export const AccountRateLimitsReadResponse = loose({
  ordinaryUsageAllowed: z.boolean().nullish(),
  rateLimits: RateLimitSnapshot,
  /** Every metered bucket by limit ID; `rateLimits` mirrors one of them. */
  rateLimitsByLimitId: z.record(z.string(), RateLimitSnapshot).nullish(),
});
export type AccountRateLimitsReadResponse = z.infer<
  typeof AccountRateLimitsReadResponse
>;

export const CodexModel = loose({
  model: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  hidden: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  supportedReasoningEfforts: z
    .array(loose({ reasoningEffort: z.string() }))
    .optional(),
  inputModalities: z.array(z.string()).optional(),
});
export type CodexModel = z.infer<typeof CodexModel>;
export const ModelListResponse = loose({
  data: z.array(CodexModel),
  nextCursor: z.string().nullable(),
});

// Requests OpenChart sends. These are constructed, not parsed.
export type UserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string };

export type DynamicToolSpec = {
  type: "function";
  name: string;
  description: string;
  inputSchema: unknown;
};

export type ThreadStartParams = {
  model: string;
  cwd?: string;
  approvalPolicy: "on-request" | "never";
  approvalsReviewer: "user" | "auto_review";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  developerInstructions?: string;
  config?: Record<string, unknown>;
  /** Native subagents fork the parent's saved rollout, so threads persist. */
  ephemeral: false;
  dynamicTools?: DynamicToolSpec[];
};

export type TurnStartParams = {
  threadId: string;
  input: UserInput[];
  model: string;
  cwd?: string;
  approvalPolicy: ThreadStartParams["approvalPolicy"];
  approvalsReviewer: ThreadStartParams["approvalsReviewer"];
  sandboxPolicy:
    | { type: "dangerFullAccess" }
    | { type: "readOnly"; networkAccess: false }
    | {
        type: "workspaceWrite";
        writableRoots: string[];
        networkAccess: false;
        excludeSlashTmp: true;
        excludeTmpdirEnvVar: true;
      };
  effort?: string;
  summary?: string;
  outputSchema?: unknown;
};

/** What the dynamic tool handler returns to the model. */
export type DynamicToolOutput = {
  contentItems: Array<{ type: "inputText"; text: string }>;
  success: boolean;
};
