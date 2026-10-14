// Purpose: Collects a streamed native turn into the AI SDK's buffered generation result.
import type {
  LanguageModelV4,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4Warning,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";

type Generation = Awaited<ReturnType<LanguageModelV4["doGenerate"]>>;

/**
 * Both native adapters stream every turn; buffered generation replays that
 * stream once. Text and reasoning blocks are joined by ID, tool events pass
 * through, and a stream error rejects.
 * @example
 * async doGenerate(call) { return collectGeneration(await this.doStream(call), this.modelId); }
 */
export async function collectGeneration(
  streamed: Awaited<ReturnType<LanguageModelV4["doStream"]>>,
  modelId: string,
): Promise<Generation> {
  const content: LanguageModelV4Content[] = [];
  const blocks = new Map<
    string,
    { type: "text" | "reasoning"; text: string }
  >();
  let usage: LanguageModelV4Usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
  let finishReason: LanguageModelV4FinishReason = {
    unified: "other",
    raw: undefined,
  };
  let warnings: SharedV4Warning[] = [];
  const reader = streamed.stream.getReader();
  try {
    for (;;) {
      const { done, value: part } = await reader.read();
      if (done) break;
      collect(part);
    }
  } finally {
    reader.releaseLock();
  }
  return {
    content: content.filter(
      (part) => part.type !== "text" || part.text.length > 0,
    ),
    usage,
    finishReason,
    warnings,
    request: streamed.request,
    response: { id: generateId(), timestamp: new Date(), modelId },
  };

  function collect(part: LanguageModelV4StreamPart): void {
    switch (part.type) {
      case "stream-start":
        warnings = part.warnings;
        return;
      case "text-start":
      case "reasoning-start": {
        const block = {
          type:
            part.type === "text-start"
              ? ("text" as const)
              : ("reasoning" as const),
          text: "",
        };
        blocks.set(part.id, block);
        content.push(block);
        return;
      }
      case "text-delta":
      case "reasoning-delta":
        blocks.get(part.id)!.text += part.delta;
        return;
      case "tool-call":
      case "tool-result":
        content.push(part);
        return;
      case "finish":
        usage = part.usage;
        finishReason = part.finishReason;
        return;
      case "error":
        throw part.error;
      default:
        return;
    }
  }
}
