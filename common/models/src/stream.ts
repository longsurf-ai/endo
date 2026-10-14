// Purpose: Validates the provider protocol once and exposes the typed model stream.
import type { ToolSet } from "@ai-sdk/provider-utils";
import type {
  AsyncIterableStream,
  FinishReason,
  LanguageModelUsage,
  TextStreamPart,
} from "ai";
import { assertTrue } from "@openchart/utils/assert";
import {
  OpenChartProviderMetadata,
  ProviderToolMedia,
  ProviderNativeOutput,
  PROVIDER_DELEGATE_START_STEP_KIND,
  PROVIDER_DELEGATE_FINISH_STEP_KIND,
  type ProviderMetadata,
  type ProviderToolResult,
} from "./provider-protocol";
import { conformProviderDelegateStep } from "./provider-delegate";

type SdkEvent = TextStreamPart<ToolSet>;
type WithMetadata<T> = T extends unknown
  ? Omit<T, "providerMetadata"> & { providerMetadata?: ProviderMetadata }
  : never;

type ToolResult<ApplicationOutput> = Omit<
  Extract<SdkEvent, { type: "tool-result" }>,
  "output" | "providerExecuted" | "providerMetadata"
> &
  ProviderToolResult<ApplicationOutput>;

/**
 * Validated SDK events with scoped root/child steps and correlated tool results.
 * ApplicationOutput belongs to the executing host; provider payload schemas live
 * in provider-protocol.ts. See PROTOCOL.md for lifecycle ordering.
 */
export type ModelStreamEvent<ApplicationOutput = unknown> =
  | WithMetadata<
      Exclude<SdkEvent, { type: "start-step" | "finish-step" | "tool-result" }>
    >
  | ToolResult<ApplicationOutput>
  | {
      type: "start-step";
      providerMetadata?: ProviderMetadata;
      request?: Record<string, unknown>;
      warnings?: unknown[];
    }
  | {
      type: "finish-step";
      finishReason: FinishReason;
      usage: LanguageModelUsage;
      providerMetadata?: ProviderMetadata;
      response?: Record<string, unknown>;
      performance?: Record<string, unknown>;
      rawFinishReason?: string;
    };

/**
 * Parses OpenChart metadata and native result payloads at the SDK exit boundary.
 * Invalid protocol data fails the stream. Vendor metadata remains opaque, while
 * scoped markers become ordinary steps after SDK root-step accounting.
 * Native JSON and marked media become the same envelope; toolMedia is removed.
 * ApplicationOutput is the host's trusted callback result, restored by the MCP
 * middleware when provider-managed; this boundary never reconstructs that value.
 * Stream cancellation and upstream failures propagate through the transform.
 * @example
 * const events = conformProviderStream<Tool.ExecuteResult>(result.stream);
 */
export function conformProviderStream<ApplicationOutput = unknown>(
  stream: AsyncIterableStream<SdkEvent>,
): AsyncIterableStream<ModelStreamEvent<ApplicationOutput>> {
  return stream.pipeThrough(
    new TransformStream<SdkEvent, ModelStreamEvent<ApplicationOutput>>({
      transform(part, controller) {
        const rawMetadata =
          "providerMetadata" in part ? part.providerMetadata : undefined;
        const protocol = OpenChartProviderMetadata.optional().parse(
          rawMetadata?.openchart,
        );
        const { finishDelegate, toolMedia, ...openchart } = protocol ?? {};
        const providerMetadata: ProviderMetadata | undefined =
          rawMetadata === undefined
            ? undefined
            : {
                ...rawMetadata,
                ...(protocol === undefined ? {} : { openchart }),
              };

        // Adapters cannot emit step parts, so child steps arrive as custom markers:
        //
        //   custom openchart.delegate-start-step  { delegateCallId }
        //     -> start-step                       { delegateCallId }
        //   custom openchart.delegate-finish-step { delegateCallId, finishDelegate }
        //     -> finish-step                      { delegateCallId } + finishReason, usage
        if (
          part.type === "custom" &&
          (part.kind === PROVIDER_DELEGATE_START_STEP_KIND ||
            part.kind === PROVIDER_DELEGATE_FINISH_STEP_KIND)
        ) {
          controller.enqueue(
            conformProviderDelegateStep(part.kind, protocol, providerMetadata),
          );
          return;
        }
        assertTrue(
          finishDelegate === undefined,
          "Delegate step payload requires a scoped finish marker",
        );

        if (part.type === "tool-result") {
          const observed =
            part.providerExecuted === true &&
            openchart.toolExecution !== "provider-mcp";
          assertTrue(
            toolMedia !== true || observed,
            "Tool media requires provider-owned execution",
          );
          assertTrue(
            openchart.toolExecution !== "provider-mcp" ||
              part.providerExecuted === true,
            "MCP outcome requires provider-owned execution",
          );
          const output = observed
            ? toolMedia === true
              ? ProviderToolMedia.parse(part.output)
              : {
                  output: ProviderNativeOutput.parse(part.output),
                  attachments: [],
                }
            : part.output;
          // The checks above establish the metadata/output correlation; TS cannot
          // infer a union across the SDK's independent, nested metadata fields.
          controller.enqueue({
            ...part,
            providerMetadata,
            output,
          } as ToolResult<ApplicationOutput>);
          return;
        }
        controller.enqueue(
          rawMetadata === undefined ? part : { ...part, providerMetadata },
        );
      },
    }),
  ) as AsyncIterableStream<ModelStreamEvent<ApplicationOutput>>;
}
