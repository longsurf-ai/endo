// Purpose: Defines the provider-neutral protocol, its schemas, and result ownership.
import type {
  LanguageModelV4StreamPart,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import { z } from "zod";

/**
 * Provider adapters remain independent; the outer stream parses this contract.
 *
 * ```text
 * OpenChart execute -> retain full outcome -> model projection -> restore outcome
 * Native tool       -> adapter JSON / media ---------------------------+
 *                                                                     v
 * AI SDK -> conformProviderStream -> typed ModelStreamEvent -> Processor
 *                                      | delegate metadata -> child/root
 *                                      | tool result       -> ToolPart
 * ```
 * Schema-derived fields live here; PROTOCOL.md owns lifecycle/order diagrams.
 */
export const PROVIDER_DELEGATE_START_STEP_KIND =
  "openchart.delegate-start-step";
export const PROVIDER_DELEGATE_FINISH_STEP_KIND =
  "openchart.delegate-finish-step";

/** The authored delegate invocation; the parent proxy does not supply child output. */
export const ProviderDelegateCall = z
  .object({
    description: z.string().min(1),
    prompt: z.string(),
    agent: z.string().min(1),
  })
  .strict();
export type ProviderDelegateCall = z.infer<typeof ProviderDelegateCall>;

const ProviderDelegateUsage = z
  .object({
    inputTokens: z.number().nonnegative(),
    inputTokenDetails: z
      .object({
        noCacheTokens: z.number().nonnegative(),
        cacheReadTokens: z.number().nonnegative(),
        cacheWriteTokens: z.number().nonnegative(),
      })
      .strict(),
    outputTokens: z.number().nonnegative(),
    outputTokenDetails: z
      .object({
        textTokens: z.number().nonnegative(),
        reasoningTokens: z.number().nonnegative(),
      })
      .strict(),
    totalTokens: z.number().nonnegative(),
  })
  .strict();

/** Transport-only child completion; the conformer moves this into finish-step. */
export const ProviderDelegateFinishStep = z
  .object({
    finishReason: z.enum([
      "stop",
      "length",
      "content-filter",
      "tool-calls",
      "error",
      "other",
    ]),
    usage: ProviderDelegateUsage,
  })
  .strict();

/** Unmarked native results are JSON; application outcomes remain host-owned. */
export const ProviderNativeOutput = z.json();
export type ProviderNativeOutput = z.infer<typeof ProviderNativeOutput>;

const ImageAttachment = z
  .object({
    mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    url: z
      .string()
      .regex(
        /^(?:data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+|https?:\/\/\S+)$/,
      ),
  })
  .strict();

/**
 * Every normalized native tool result uses this envelope, including plain JSON.
 * Plain results have empty attachments; consumers never inspect transport markers.
 * Attachments are model-facing images; computerUse.screenshot is display-only.
 * The adapter owns provenance and materializes local paths before this boundary.
 * If the screenshot is already an attachment, omit its duplicate display copy.
 * Processor assigns attachment IDs; AG-UI projects the same committed ToolPart.
 */
export const ProviderNativeToolOutput = z
  .object({
    output: ProviderNativeOutput,
    attachments: z.array(ImageAttachment),
    computerUse: z
      .object({
        title: z.string().min(1),
        // Native UI observations are display-only; never add them to model history.
        screenshot: ImageAttachment.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ProviderNativeToolOutput = z.infer<typeof ProviderNativeToolOutput>;

/** Transport-only media envelope selected by openchart.toolMedia=true. */
export const ProviderToolMedia = ProviderNativeToolOutput.refine(
  (value) =>
    value.attachments.length > 0 || value.computerUse?.screenshot !== undefined,
  {
    message: "Tool media must contain an image or a display screenshot",
  },
);

/**
 * Ownership and opening are independent. Every event may name its owner;
 * only an Agent tool-call opens a delegate, identified by its own toolCallId.
 *
 * Lifecycle of delegate "A" as an adapter emits it (`openchart` metadata shown):
 *
 * ```text
 * open    tool-call Agent (toolCallId "A")
 *           { openDelegate: { description, prompt, agent } }
 *         custom openchart.delegate-start-step
 *           { delegateCallId: "A" }
 *
 * run     text-delta / reasoning-delta / tool-call Read / tool-result Read
 *           { delegateCallId: "A" }
 *
 * finish  custom openchart.delegate-finish-step
 *           { delegateCallId: "A", finishDelegate: { finishReason, usage } }
 *         tool-result Agent (toolCallId "A", output: A's final report)
 *           {}  // owned by the parent; completes the proxy only
 * ```
 *
 * If A itself was opened inside delegate "P", its Agent tool-call and
 * tool-result carry `delegateCallId: "P"` instead of nothing.
 */
const delegateMetadata = {
  /**
   * Agent call ID of the delegate that owns this event; absent selects the root.
   * The call ID identifies the delegate in the stream; its session has its own ID.
   */
  delegateCallId: z.string().min(1).optional(),
  /** Opens a delegate whose ID is this tool-call's toolCallId. */
  openDelegate: ProviderDelegateCall.optional(),
  /** Finishes delegateCallId's step; transport-only, on the finish-step marker. */
  finishDelegate: ProviderDelegateFinishStep.optional(),
};

/**
 * OpenChart's namespace on SDK transport events. Execution provenance and media
 * are exclusive: restored application outcomes never use the native media envelope.
 * Unknown OpenChart fields fail; unrelated provider namespaces remain opaque.
 */
export const OpenChartProviderMetadata = z.union([
  z.strictObject({
    ...delegateMetadata,
    toolExecution: z.never().optional(),
    toolMedia: z.never().optional(),
  }),
  z.strictObject({
    ...delegateMetadata,
    toolExecution: z.literal("provider-mcp"),
    toolMedia: z.never().optional(),
  }),
  z.strictObject({
    ...delegateMetadata,
    toolExecution: z.never().optional(),
    toolMedia: z.literal(true),
  }),
]);
export type OpenChartProviderMetadata = z.infer<
  typeof OpenChartProviderMetadata
>;

/** An OpenChart marker without ownership; {@link scopedMetadata} adds the owner. */
export type ProtocolMarker<T = OpenChartProviderMetadata> = T extends unknown
  ? Omit<T, "delegateCallId">
  : never;

/**
 * Adapter-side metadata for one event: its owning delegate (null is the root)
 * plus an optional protocol marker. The root with no marker adds nothing.
 * @example this.emit({ type: "text-start", id, ...scopedMetadata(scope) });
 */
export function scopedMetadata(
  scope: string | null,
  marker?: ProtocolMarker,
): { providerMetadata?: SharedV4ProviderMetadata } {
  if (scope === null && marker === undefined) return {};
  const owner = scope === null ? {} : { delegateCallId: scope };
  return { providerMetadata: { openchart: { ...marker, ...owner } } };
}

/** Both adapters see only aggregate root usage; the root finish keeps it. */
const ZERO_DELEGATE_USAGE: z.infer<typeof ProviderDelegateUsage> = {
  inputTokens: 0,
  inputTokenDetails: {
    noCacheTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokens: 0,
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
  totalTokens: 0,
};

/**
 * Opens delegate `delegateCallId`'s step. Adapters cannot emit `start-step`, so
 * the conformer rewrites this marker after `streamText` (see protocol.md).
 * @example this.emit(delegateStartStep(toolCallId));
 */
export function delegateStartStep(
  delegateCallId: string,
): LanguageModelV4StreamPart {
  return {
    type: "custom",
    kind: PROVIDER_DELEGATE_START_STEP_KIND,
    ...scopedMetadata(delegateCallId),
  };
}

/**
 * Finishes delegate `delegateCallId`'s step with zero child usage; the conformer
 * rewrites it into `finish-step` (see protocol.md).
 * @example this.emit(delegateFinishStep(toolCallId, "stop"));
 */
export function delegateFinishStep(
  delegateCallId: string,
  finishReason: z.infer<typeof ProviderDelegateFinishStep>["finishReason"],
): LanguageModelV4StreamPart {
  return {
    type: "custom",
    kind: PROVIDER_DELEGATE_FINISH_STEP_KIND,
    ...scopedMetadata(delegateCallId, {
      finishDelegate: { finishReason, usage: ZERO_DELEGATE_USAGE },
    }),
  };
}

type WithoutTransport<T> = T extends unknown
  ? Omit<T, "finishDelegate" | "toolMedia"> & {
      finishDelegate?: never;
      toolMedia?: never;
    }
  : never;
type NormalizedMetadata = WithoutTransport<OpenChartProviderMetadata>;
type UnmarkedMetadata = Extract<
  NormalizedMetadata,
  { toolExecution?: never; toolMedia?: never }
>;
type McpMetadata = Extract<
  NormalizedMetadata,
  { toolExecution: "provider-mcp" }
>;

/** Validated metadata; transport-only step payloads and media markers cannot escape. */
export type ProviderMetadata<
  T extends NormalizedMetadata = NormalizedMetadata,
> = SharedV4ProviderMetadata & {
  openchart?: T;
};
type RequiredMetadata<T extends NormalizedMetadata> = ProviderMetadata<T> & {
  openchart: T;
};

/** All native observations share one envelope; application outcomes stay separate. */
export type ObservedProviderToolResult = {
  providerExecuted: true;
  providerMetadata?: ProviderMetadata<UnmarkedMetadata>;
  output: ProviderNativeToolOutput;
};

/**
 * Narrows validated native observations; never guesses from tool names or text.
 * @example
 * if (isObservedProviderTool(event)) displayNativeResult(event.output);
 */
export function isObservedProviderTool(
  event: ProviderToolResult,
): event is ObservedProviderToolResult;
export function isObservedProviderTool(event: {
  providerExecuted?: boolean;
  providerMetadata?: ProviderMetadata;
}): boolean;
export function isObservedProviderTool(event: {
  providerExecuted?: boolean;
  providerMetadata?: ProviderMetadata;
}): boolean {
  return (
    event.providerExecuted === true &&
    event.providerMetadata?.openchart?.toolExecution !== "provider-mcp"
  );
}

/**
 * Tool-result contract: execution provenance determines the output shape.
 * These fields merge directly into ModelStreamEvent's tool-result branch:
 *
 * ```text
 * ModelStreamEvent (type: "tool-result")
 *   + SDK identity: toolCallId, toolName, ...
 *   + ProviderToolResult
 *       + providerExecuted
 *       + providerMetadata.openchart -> execution / delegate markers
 *       + output                     -> shape selected by execution + markers
 * ```
 *
 * The three normalized combinations (toolExecution is under providerMetadata.openchart):
 *
 * | Execution route | providerExecuted | toolExecution  | output                   |
 * | --------------- | ---------------- | -------------- | ------------------------ |
 * | Local callback  | false / absent   | absent         | ApplicationOutput        |
 * | Managed MCP     | true             | "provider-mcp" | ApplicationOutput        |
 * | Native tool     | true             | absent         | ProviderNativeToolOutput |
 *
 * "Absent" includes undefined. providerExecuted=true alone does not establish
 * output ownership: the MCP marker distinguishes host outcomes from native ones.
 * The MCP marker requires providerExecuted=true.
 *
 * The host owns ApplicationOutput. Local callbacks return it directly; managed
 * MCP restores the exact same object once by toolCallId before SDK processing.
 * conformProviderStream parses native JSON/media once into the same envelope:
 * plain JSON becomes { output: JSON, attachments: [] }; marked media already has
 * this shape. The transport-only toolMedia marker is consumed and removed.
 * Consumers trust the resulting type and never infer ownership from output shape.
 *
 * Delegate routing is independent of output ownership: delegateCallId selects
 * a child, and its absence selects the root. Normalized metadata excludes
 * finishDelegate; the conformer moves that transport payload into finish-step.
 */
export type ProviderToolResult<ApplicationOutput = unknown> =
  | {
      providerExecuted?: false;
      providerMetadata?: ProviderMetadata<UnmarkedMetadata>;
      output: ApplicationOutput;
    }
  // The Agent provider executed the tools provided by the host OpenChart.
  | {
      providerExecuted: true;
      providerMetadata: RequiredMetadata<McpMetadata>;
      output: ApplicationOutput;
    }
  // The Agent provider executed the provider's native tool.
  | ObservedProviderToolResult;
