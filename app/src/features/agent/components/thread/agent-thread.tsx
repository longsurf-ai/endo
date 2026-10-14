import { QuestionCard } from "@openchart/app/features/agent/components/question-card/question-card";
import { toast } from "sonner";
// Purpose: Connect existing and new conversations to the same reusable Agent presentation.
import "./agent-thread.css";
import {
  AssistantRuntimeProvider,
  AuiIf,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { type ReactNode, useState, useRef, useMemo } from "react";
import { computerUseSequence } from "@openchart/app/features/agent/ag-ui/tool-media";
import { ComputerUsePlayback } from "@openchart/app/features/agent/components/computer-use/computer-use-playback";
import type { FloatingViewerBounds } from "@openchart/app/components/ui/floating-viewer/floating-viewer";
import { useSessionSnapshot } from "@openchart/app/lib/agent/use-session-snapshot";
import { useSessionRead } from "@openchart/app/lib/agent/use-session-read";
import type { SessionSnapshot } from "@openchart/app/lib/agent/session-store";

import { ApprovalCard } from "@openchart/app/components/ui/approval-card/approval-card";
import type {
  ModelSelection,
  PermissionReply,
} from "@openchart/app/lib/agent/client";
import { useAgentContext } from "@openchart/app/lib/agent/provider";
import type { LoadMoreProps } from "@openchart/app/components/ui/load-more/load-more";
import {
  useAssistantUiRuntime,
  useComposerRuntime,
} from "@openchart/app/features/agent/ag-ui/react/use-assistant-ui-runtime";
import type { ComposerDraft } from "@openchart/app/lib/prompt-converter/converter";
import type { PromptSuggestion } from "@openchart/app/lib/proactive/proactive";

import { AgentLayout } from "@openchart/app/features/agent/components/thread/agent-layout/agent-layout";
import { AgentComposer } from "@openchart/app/features/agent/components/composer/composer";
import { AgentTranscript } from "@openchart/app/features/agent/components/thread/transcript/transcript";
import { SelectionToolbar } from "@openchart/app/features/agent/components/quote/quote";
import { PromptSuggestions } from "@openchart/app/features/agent/components/prompt-suggestions/prompt-suggestions";

function latestRunError(state: SessionSnapshot["state"]): string | undefined {
  if (!state) return undefined;
  const latest = state.runs.at(-1);
  if (latest?.status !== "failed") return undefined;
  return Object.values(state.messageInfo)
    .flatMap((info) => {
      if (
        !("error" in info) ||
        !info.error ||
        typeof info.completedAt !== "number" ||
        info.completedAt < (latest.startedAt ?? latest.createdAt) ||
        !("message" in info.error.data)
      )
        return [];
      return [
        { completedAt: info.completedAt, message: info.error.data.message },
      ];
    })
    .sort((left, right) => right.completedAt - left.completedAt)[0]?.message;
}

function ComputerUsePreview({
  sessionID,
  bounds,
}: {
  sessionID: string;
  bounds: FloatingViewerBounds;
}) {
  const { agent } = useAgentContext();
  const messages = useSessionSnapshot(agent, sessionID, (s) => s.messages);
  const sequence = useMemo(() => computerUseSequence(messages), [messages]);
  return sequence ? (
    <ComputerUsePlayback sequence={sequence} bounds={bounds} />
  ) : null;
}

function ThreadView({
  readOnly = false,
  composerLeading,
  composerContext,
  messageActions,
  suggestions,
  floating,
  history,
  children,
}: {
  readOnly?: boolean;
  composerLeading?: ReactNode;
  composerContext?: ReactNode;
  messageActions?: ReactNode;
  suggestions?: readonly PromptSuggestion[];
  floating?: (bounds: FloatingViewerBounds) => ReactNode;
  history?: LoadMoreProps;
  children?: ReactNode;
}) {
  const empty = useAuiState((s) => s.thread.isEmpty && !s.thread.isLoading);
  const threadRef = useRef<HTMLDivElement>(null);
  return (
    <ThreadPrimitive.Root
      ref={threadRef}
      className="agent-thread"
      aria-label="Conversation"
    >
      <AgentLayout
        floating={floating}
        history={history}
        empty={empty}
        transcript={<AgentTranscript messageActions={messageActions} />}
        composer={
          !readOnly ? (
            <AgentComposer
              leading={composerLeading}
              context={composerContext}
            />
          ) : null
        }
        suggestions={
          !readOnly && suggestions?.length ? (
            <PromptSuggestions suggestions={suggestions} />
          ) : null
        }
      >
        {children}
      </AgentLayout>
      <AuiIf condition={(s) => !s.thread.isDisabled}>
        <SelectionToolbar threadRef={threadRef} showQuote={!readOnly} />
      </AuiIf>
    </ThreadPrimitive.Root>
  );
}

/**
 * Observes an explicit Session through the shared Agent from AgentProvider.
 * Unmounting releases observation without cancelling execution. Children supply
 * host notices beside permissions and errors; submission failures retain drafts.
 * @example <AgentThread sessionID={sessionID} model={model} onSubmit={submit} />
 */
export function AgentThread({
  visible = true,
  readOnly,
  composerLeading,
  composerContext,
  sessionID,
  model,
  onSubmit,
  onTruncate,
  submitting,
  failedDraft,
  initialDraft,
  messageActions,
  children,
}: {
  sessionID: string;
  visible?: boolean;
  readOnly?: boolean;
  model?: ModelSelection;
  onSubmit: (draft: ComposerDraft) => Promise<void>;
  onTruncate?: (messageID: string | null) => Promise<void>;
  submitting?: boolean;
  failedDraft?: ComposerDraft;
  initialDraft?: ComposerDraft;
  messageActions?: ReactNode;
  composerLeading?: ReactNode;
  composerContext?: ReactNode;
  children?: ReactNode;
}) {
  const { agent } = useAgentContext();
  const { runtime, snapshot, session } = useAssistantUiRuntime({
    agent,
    sessionID,
    model,
    onSubmit,
    onTruncate,
    submitting,
    failedDraft,
    initialDraft,
  });
  const [pendingPermission, setPendingPermission] = useState<string>();
  useSessionRead(agent.markSessionRead.mutate, snapshot, visible);
  const permissions = snapshot.state?.permissions;
  const questions = snapshot.state?.questions;
  const loading = snapshot.loading;
  const sessionError = latestRunError(snapshot.state) ?? snapshot.error;
  const history = snapshot.history;
  // Keep the provider's child tree stable while its runtime streams updates.
  // Message primitives subscribe directly; only host notices rebuild this shell.
  const view = useMemo(() => {
    function replyPermission(requestID: string, reply: PermissionReply) {
      setPendingPermission(requestID);
      void session
        .replyPermission(requestID, reply)
        .catch((cause: unknown) => {
          toast.error("Couldn’t submit permission response", {
            description: cause instanceof Error ? cause.message : String(cause),
          });
        })
        .finally(() => setPendingPermission(undefined));
    }
    return (
      <ThreadView
        readOnly={readOnly}
        composerLeading={composerLeading}
        composerContext={composerContext}
        messageActions={messageActions}
        history={{
          hasMore: history.hasMore,
          loading: history.loading,
          error: history.error !== undefined,
          onLoadMore: () => {
            void session.loadOlder();
          },
          label: "Load earlier messages",
        }}
        floating={(bounds) => (
          <ComputerUsePreview
            key={sessionID}
            sessionID={sessionID}
            bounds={bounds}
          />
        )}
      >
        {children}
        {questions?.map((request) => (
          <QuestionCard
            key={request.id}
            request={request}
            disabled={loading}
            onReply={session.replyQuestion}
          />
        ))}
        {permissions?.map((permission) => (
          <ApprovalCard
            key={permission.id}
            role="group"
            aria-label="Permission request"
            aria-busy={pendingPermission === permission.id}
            state="request"
            title={`Allow ${permission.action}?`}
            subtitle="The agent requests your approval."
            command={[
              ...permission.resources.map((resource) => `Request: ${resource}`),
              ...(permission.save ?? []).map(
                (pattern) => `Always allows: ${pattern}`,
              ),
            ].join("\n")}
            requestDetails={
              permission.metadata
                ? JSON.stringify(permission.metadata, null, 2)
                : undefined
            }
            disabled={loading || pendingPermission !== undefined}
            onDeny={() => replyPermission(permission.id, "reject")}
            onAlwaysAllow={
              permission.save?.length
                ? () => replyPermission(permission.id, "always")
                : undefined
            }
            onAllowOnce={() => replyPermission(permission.id, "once")}
          />
        ))}
        {sessionError ? (
          <p className="agent-chat-error" role="alert">
            {sessionError}
          </p>
        ) : null}
      </ThreadView>
    );
  }, [
    readOnly,
    composerLeading,
    composerContext,
    messageActions,
    children,
    permissions,
    questions,
    loading,
    sessionError,
    history.hasMore,
    history.loading,
    history.error,
    pendingPermission,
    session,
    sessionID,
  ]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {view}
    </AssistantRuntimeProvider>
  );
}

/**
 * Compose a new chat without creating backend state on mount. The host supplies
 * submission status/errors; assistant-ui owns the draft. Selecting one of the
 * host's `suggestions` submits it through the same `onSubmit`.
 * @example <AgentNewThread onSubmit={submitPrompt} submitting={submitting} />
 */
export function AgentNewThread({
  initialDraft,
  onSubmit,
  readOnly,
  disabled,
  submitting = false,
  composerLeading,
  composerContext,
  suggestions,
  children,
}: {
  initialDraft?: ComposerDraft;
  onSubmit: (draft: ComposerDraft) => Promise<void>;
  readOnly?: boolean;
  disabled?: boolean;
  submitting?: boolean;
  composerLeading?: ReactNode;
  composerContext?: ReactNode;
  suggestions?: readonly PromptSuggestion[];
  children?: ReactNode;
}) {
  const runtime = useComposerRuntime({
    initialDraft,
    onSubmit,
    disabled: disabled || submitting,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadView
        readOnly={readOnly}
        composerLeading={composerLeading}
        composerContext={composerContext}
        suggestions={suggestions}
      >
        {children}
        {submitting ? (
          <p role="status" className="mb-3 text-sm text-muted-foreground">
            Starting conversation…
          </p>
        ) : null}
      </ThreadView>
    </AssistantRuntimeProvider>
  );
}
