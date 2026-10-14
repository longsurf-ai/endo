// Purpose: Compose the renderers for each assistant message part.
import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { MarkdownText } from "@openchart/app/features/agent/components/thread/transcript/markdown/markdown-text";
import { ActivityPart } from "@openchart/app/features/agent/components/thread/transcript/agent-parts/activity-part/activity-part";
import { AssistantThinking } from "@openchart/app/features/agent/components/thread/transcript/agent-parts/thinking-indicator/thinking-indicator.aui";
import { AssistantToolCall } from "@openchart/app/features/agent/components/thread/transcript/agent-parts/tool-call/tool-call.aui";
import { ToolProgress } from "@openchart/app/features/agent/components/thread/transcript/agent-parts/tool-progress/tool-progress";

const HiddenPart = () => null;

/** Uses official text/tool views and one live thinking indicator. @example <AgentParts /> */
export function AgentParts({
  startIndex = 0,
  endIndex,
  showReasoning = false,
}: {
  startIndex?: number;
  endIndex?: number;
  showReasoning?: boolean;
}) {
  const length = useAuiState((s) => s.message.content.length);
  const components = {
    Text: MarkdownText,
    Reasoning: showReasoning ? MarkdownText : HiddenPart,
    Empty: ToolProgress,
    tools: { Fallback: AssistantToolCall },
    data: { Fallback: ActivityPart },
  };
  const wholeMessage = startIndex === 0 && (endIndex ?? length) === length;
  return (
    <>
      {wholeMessage ? (
        <MessagePrimitive.Parts components={components} />
      ) : (
        Array.from(
          { length: (endIndex ?? length) - startIndex },
          (_, offset) => (
            <MessagePrimitive.PartByIndex
              key={startIndex + offset}
              index={startIndex + offset}
              components={components}
            />
          ),
        )
      )}
      {!showReasoning && wholeMessage && <AssistantThinking />}
    </>
  );
}
