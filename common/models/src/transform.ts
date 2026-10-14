// Purpose: Projects transcripts and request options for one resolved model; native details arrive through NativeProvider.
/* eslint-disable @typescript-eslint/no-explicit-any -- Provider option transforms intentionally shuttle provider-defined dynamic payloads. */
/* eslint-disable @typescript-eslint/no-namespace -- Namespace exports are the intentional public API for this module. */
import type { ModelMessage } from "ai";
import type { AvailableModel } from "./model-provider";
import type { NativeProvider } from "./native-provider";

type Modality = keyof AvailableModel["capabilities"]["input"];

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  return undefined;
}

// The AI SDK options namespace: the native adapter's key, or the provider ID
// itself for a plain AI SDK provider.
function sdkKey(
  model: AvailableModel,
  provider: NativeProvider | undefined,
): string {
  return provider?.sdkKey ?? model.providerID;
}

export namespace ProviderTransform {
  function unsupportedParts(
    msgs: ModelMessage[],
    model: AvailableModel,
  ): ModelMessage[] {
    return msgs.map((msg) => {
      if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;

      const filtered = msg.content.map((part) => {
        if (part.type !== "file" && part.type !== "image") return part;

        // Check for empty base64 image data
        if (part.type === "image") {
          const imageStr = part.image.toString();
          if (imageStr.startsWith("data:")) {
            const match = imageStr.match(/^data:([^;]+);base64,(.*)$/);
            if (match && (!match[2] || match[2].length === 0)) {
              return {
                type: "text" as const,
                text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
              };
            }
          }
        }

        const mime =
          part.type === "image"
            ? part.image.toString().split(";")[0]!.replace("data:", "")
            : part.mediaType;
        const filename = part.type === "file" ? part.filename : undefined;
        const modality = mimeToModality(mime);
        if (!modality) return part;
        // Unknown capability metadata must not reject otherwise valid input.
        if (model.capabilities.input[modality] !== false) return part;

        const name = filename ? `"${filename}"` : modality;
        return {
          type: "text" as const,
          text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
        };
      });

      return { ...msg, content: filtered };
    });
  }

  /**
   * Projects a transcript for one model without mutating caller-owned messages:
   * capability filtering, the native provider's own normalization, then stored
   * `providerOptions` keys move from the provider ID to the SDK namespace.
   * @example
   * const prompt = ProviderTransform.message(messages, model, provider);
   */
  export function message(
    msgs: ModelMessage[],
    model: AvailableModel,
    provider: NativeProvider | undefined,
  ) {
    // Clone messages and content parts before provider normalization so callers
    // can reuse their original transcript for another request or provider.
    msgs = msgs.map((msg) => {
      if (!Array.isArray(msg.content)) return { ...msg };
      return {
        ...msg,
        content: msg.content.map((part) => ({ ...part })),
      } as ModelMessage;
    });
    msgs = unsupportedParts(msgs, model);
    if (provider?.normalizeMessages) msgs = provider.normalizeMessages(msgs);

    const key = sdkKey(model, provider);
    if (key !== model.providerID) {
      const remap = (opts: Record<string, any> | undefined) => {
        if (!opts) return opts;
        if (!(model.providerID in opts)) return opts;
        const result = { ...opts };
        result[key] = result[model.providerID];
        delete result[model.providerID];
        return result;
      };

      msgs = msgs.map((msg) => {
        if (!Array.isArray(msg.content))
          return { ...msg, providerOptions: remap(msg.providerOptions) };
        return {
          ...msg,
          providerOptions: remap(msg.providerOptions),
          content: msg.content.map((part) =>
            "providerOptions" in part
              ? { ...part, providerOptions: remap(part.providerOptions) }
              : part,
          ),
        } as typeof msg;
      });
    }

    return msgs;
  }

  /**
   * Builds native request options from an already-resolved model selection.
   * Native defaults lose to explicit overrides, which lose to the selected
   * variant. Only native providers translate variants, as effort levels.
   * Does not mutate discovery metadata or caller-owned overrides.
   * @example
   * const options = ProviderTransform.options({model, variant: 'high'}, provider, {effort: 'medium'});
   */
  export function options(
    input: { model: AvailableModel; variant?: string },
    provider: NativeProvider | undefined,
    overrides: Record<string, unknown> = {},
  ): Record<string, any> {
    if (input.variant !== undefined && !provider)
      throw new Error(
        `Unsupported variant ${input.variant} for ${input.model.providerID}/${input.model.id}`,
      );
    // A user's explicit variant must win over caller overrides and defaults.
    return {
      ...provider?.defaultOptions?.(input.model),
      ...overrides,
      ...(input.variant === undefined ? {} : { effort: input.variant }),
    };
  }

  /**
   * Wraps request settings in the selected model's AI SDK options namespace.
   * @example
   * const options = ProviderTransform.providerOptions(model, provider, {effort: 'high'});
   */
  export function providerOptions(
    model: AvailableModel,
    provider: NativeProvider | undefined,
    options: { [x: string]: any },
  ) {
    return { [sdkKey(model, provider)]: options };
  }
}
