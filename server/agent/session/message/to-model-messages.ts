// Purpose: Projects persisted Agent messages into AI SDK model input while preserving V1 replay behavior.

import type { WithParts } from "@openchart/server/agent/contracts/message";
import {
  ToolModelOutput,
  type ToolInput,
  type ToolStateError,
} from "@openchart/server/agent/contracts/part";
import type { AvailableModel } from "@openchart/models/model-provider";
import {
  convertToModelMessages,
  type ModelMessage,
  type ProviderMetadata,
  type UIMessage,
} from "ai";
import { Array, Effect, Filter, Schema } from "effect";
import { userModelParts } from "./model-message-user-parts";

const TOOL_OUTPUT_MAX_CHARS = 2_000;

/**
 * Converts already-parsed transcript messages into model history in input order.
 * Retains partial output after failures, skips failed reasoning-only messages,
 * replays tools without execution, pairs unfinished calls with interruption errors,
 * and preserves stored Parts while adapting provider metadata and attachments.
 * History selection and compaction boundaries remain caller-owned.
 * Clipped tool output keeps a fixed 2,000-character text preview per successful
 * result, plus truncation markers; media and attachments remain intact. Previews
 * never depend on message age or model capacity, preserving replay prefixes.
 *
 * @param input - Complete messages, ordered oldest first by the caller.
 * @param model - Selected V2 provider and its SDK model identifier.
 * @param options - Tool output is full by default for transcript reads/search;
 * model replay and its capacity estimate opt into clipped previews.
 * @returns An Effect producing AI SDK messages ready for LLM.stream. Unmaterialized
 * document evidence and SDK conversion failures remain defects.
 * @example
 * const messages = yield* toModelMessages(history, {providerID: 'openai', id: 'gpt-5'});
 */
export const toModelMessages = Effect.fn("toModelMessages")(function* (
  input: WithParts[],
  model: Pick<AvailableModel, "id" | "providerID">,
  options: { toolOutput: "full" | "clipped" } = { toolOutput: "full" },
): Effect.fn.Return<ModelMessage[]> {
  const toolNames = new Set<string>();
  const messages = input
    .flatMap<Omit<UIMessage, "id">>((msg) => {
      if (msg.parts.length === 0) return [];
      if (msg.info.role === "user") {
        return [{ role: "user", parts: userModelParts(msg.parts) }];
      }

      if (
        msg.info.error &&
        !(
          // Failed turns still own committed text and tool outcomes.
          msg.parts.some(
            (part) =>
              part.type === "tool" ||
              (part.type === "text" && part.text.trim().length > 0),
          )
        )
      )
        return [];

      const sameModel =
        model.providerID === msg.info.providerID &&
        model.id === msg.info.modelID;
      const media: Array<{ mime: string; url: string }> = [];
      const parts = msg.parts.flatMap<UIMessage["parts"][number]>((part) => {
        switch (part.type) {
          case "text":
          case "reasoning":
            return [
              {
                type: part.type,
                text: part.text,
                ...(sameModel && {
                  providerMetadata: replayMetadata(part.metadata, model),
                }),
              },
            ];
          case "step-start":
            return [{ type: "step-start" }];
          case "tool": {
            toolNames.add(part.tool);
            const call = {
              type: `tool-${part.tool}` as const,
              toolCallId: part.callID,
              ...(sameModel && {
                callProviderMetadata: replayMetadata(
                  part.providerMetadata,
                  model,
                ),
              }),
            };
            if (part.state.status === "completed") {
              const modelOutput = part.state.time.compacted
                ? ({
                    type: "text",
                    value: "[Old tool result content cleared]",
                  } as const)
                : options.toolOutput === "clipped"
                  ? clipToolOutput(part.state.output)
                  : part.state.output;
              // Native agent adapters receive media attachments in a separate user message.
              const [attachments, mediaAttachments] = Array.partition(
                part.state.time.compacted ? [] : (part.state.attachments ?? []),
                Filter.fromPredicate(
                  (attachment) =>
                    attachment.mime.startsWith("image/") ||
                    attachment.mime === "application/pdf",
                ),
              );
              media.push(...mediaAttachments);

              const output =
                attachments.length > 0
                  ? {
                      modelOutput,
                      attachments: attachments.map((attachment) => ({
                        mime: attachment.mime,
                        url: attachment.url,
                      })),
                    }
                  : modelOutput;

              return [
                {
                  ...call,
                  state: "output-available",
                  input: part.state.input,
                  output,
                },
              ];
            }
            // Every pending/running tool call needs a paired interruption result.
            const error =
              part.state.status === "error"
                ? modelToolError(part.state)
                : {
                    input: part.state.input,
                    text: "[Tool execution was interrupted]",
                  };
            return [
              {
                ...call,
                state: "output-error",
                input: error.input,
                errorText: error.text,
              },
            ];
          }
          // Evidence is already present in its producing tool's output.
          default:
            return [];
        }
      });
      if (parts.length === 0) return [];
      return [
        { role: "assistant", parts },
        ...(media.length === 0
          ? []
          : [
              {
                role: "user" as const,
                parts: [
                  {
                    type: "text" as const,
                    text: "Attached image(s) from tool result:",
                  },
                  ...media.map((attachment) => ({
                    type: "file" as const,
                    url: attachment.url,
                    mediaType: attachment.mime,
                  })),
                ],
              },
            ]),
      ];
    })
    .filter((msg) => msg.parts.some((part) => part.type !== "step-start"));

  const tools = Object.fromEntries(
    [...toolNames].map((toolName) => [toolName, { toModelOutput }]),
  );

  // Keep the Promise boundary at the SDK conversion; callbacks only format output.
  return yield* Effect.promise(() =>
    convertToModelMessages(messages, {
      //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
      tools,
    }),
  );
});

function replayMetadata(
  metadata: ProviderMetadata | undefined,
  model: Pick<AvailableModel, "providerID">,
) {
  if (model.providerID !== "openai" || !metadata) return metadata;
  const provider = metadata[model.providerID];
  if (!provider || typeof provider !== "object" || Array.isArray(provider))
    return metadata;
  if (!("itemId" in provider)) return metadata;
  const replay = { ...provider };
  delete replay.itemId;
  return { ...metadata, [model.providerID]: replay };
}

function modelToolError(state: ToolStateError): {
  input: ToolInput;
  text: string;
} {
  if (
    state.input !== null &&
    typeof state.input === "object" &&
    !Array.isArray(state.input)
  ) {
    return { input: state.input, text: state.error };
  }
  const message = "Tool input must be an object; execution did not start.";
  const originalError = state.error.trim();

  return {
    input: {
      __openchart: {
        error: "non_object_tool_input",
        rawInput: state.input,
      },
    },
    text: originalError
      ? `${message} Original error: ${originalError}`
      : message,
  };
}

// The SDK callback is an unknown boundary; derive its decoder from the durable
// ToolModelOutput contract. Persisted media remains media; only SDK output uses file.
const decodeOutput = Schema.decodeUnknownSync(
  Schema.Union([
    ToolModelOutput,
    Schema.Struct({
      modelOutput: ToolModelOutput,
      attachments: Schema.Array(
        Schema.Struct({ mime: Schema.String, url: Schema.String }).annotate({
          parseOptions: { onExcessProperty: "error" },
        }),
      ),
    }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  ]),
);

function toModelOutput({ output }: { output: unknown }) {
  const decoded = decodeOutput(output);
  if (!("modelOutput" in decoded)) return sdkToolOutput(decoded);
  const attachments = decoded.attachments.filter(
    (attachment) =>
      attachment.url.startsWith("data:") && attachment.url.includes(","),
  );
  return sdkToolOutput({
    type: "content",
    value: [
      { type: "text", text: toolOutputText(decoded.modelOutput) },
      ...attachments.map((attachment) => ({
        type: "media" as const,
        mediaType: attachment.mime,
        data: attachment.url.slice(attachment.url.indexOf(",") + 1),
      })),
    ],
  });
}

function sdkToolOutput(output: ToolModelOutput) {
  if (output.type !== "content") return output;
  return {
    type: "content" as const,
    value: output.value.map((part) =>
      part.type === "text"
        ? { type: "text" as const, text: part.text }
        : {
            type: "file" as const,
            mediaType: part.mediaType,
            data: { type: "data" as const, data: part.data },
          },
    ),
  };
}

function toolOutputText(output: ToolModelOutput): string {
  if (output.type === "text") return output.value;
  if (output.type === "json") return JSON.stringify(output.value, null, 2);
  return output.value
    .map((part) =>
      part.type === "text" ? part.text : `[Attached ${part.mediaType}]`,
    )
    .join("\n");
}

function clipToolOutput(output: ToolModelOutput): ToolModelOutput {
  let remaining = TOOL_OUTPUT_MAX_CHARS;
  const clip = (text: string) => {
    const preview = text.slice(0, remaining);
    remaining -= preview.length;
    return preview.length < text.length ? `${preview}\n[truncated]` : preview;
  };
  if (output.type === "content")
    return {
      ...output,
      value: output.value.map((part) =>
        part.type === "text" ? { ...part, text: clip(part.text) } : part,
      ),
    };
  const text = toolOutputText(output);
  return text.length > TOOL_OUTPUT_MAX_CHARS
    ? { type: "text", value: clip(text) }
    : output;
}
