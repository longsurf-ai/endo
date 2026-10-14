// Purpose: Compose a reusable Agent surface independently of routes and host containers.
import { type ReactNode, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAgentContext } from "@openchart/app/lib/agent/provider";
import type { ModelSelection } from "@openchart/app/lib/agent/client";
import type { ComposerDraft } from "@openchart/app/lib/prompt-converter/converter";
import type { AppTransport } from "@openchart/app/lib/transport/transport";
import type { PromptSuggestion } from "@openchart/app/lib/proactive/proactive";
import { defaultWorkspaceQueryOptions } from "@openchart/app/lib/workspace/workspace";
import {
  lastUserInfo as selectLastUserInfo,
  useSessionSnapshot,
} from "@openchart/app/lib/agent/use-session-snapshot";
import { resolveModel } from "@openchart/app/lib/agent/model-selection";

import {
  AgentNewThread,
  AgentThread,
} from "@openchart/app/features/agent/components/thread/agent-thread";
import { ComposerControls } from "@openchart/app/features/agent/components/composer/composer-controls";
import {
  AgentViewProvider,
  type AgentPanelTarget,
  type DigInTarget,
} from "@openchart/app/features/agent/components/agent-view/agent-view-context";

/**
 * Compose the main chat area: header, model controls/status, and one conversation.
 * With an active Session, AgentThread shows the conversation and its composer.
 * Without one, AgentNewThread shows the empty state and first-message composer;
 * rendering it does not create a backend Session. Both threads already contain
 * their own Transcript and Composer, arranged by AgentLayout.
 *
 * This view supplies the model and workspace pickers to each composer
 * and restores their choices from the latest User message. AgentProvider supplies the
 * shared Agent, including submission status and failed drafts scoped to this
 * view's Session. Props bind the view to its host's Session and navigation.
 * Submission passes that same Session ID to the host, including undefined for new chats.
 * The host owns navigation, creation, header, message actions, and notices.
 * `readOnly` hides input, Quote and Edit while retaining transcript navigation and Dig In.
 * `suggestions` are offered beneath a new chat's composer; selecting one submits it.
 * Key this view by Session ID; an unsent choice stays local to that conversation.
 * @example <AgentView transport={transport} sessionID={sessionID} onSubmit={submit} />
 */
export function AgentView({
  visible = true,
  transport,
  sessionID,
  onSubmit,
  header,
  messageActions,
  onOpenPanel,
  pendingDigIn,
  initialModel,
  initialDraft,
  workspaceId: suppliedWorkspaceId,
  readOnly = false,
  composerContext,
  suggestions,
  pending = false,
  children,
}: {
  transport: AppTransport;
  /** Whether the host is displaying this conversation, including covered panels. */
  visible?: boolean;
  sessionID: string | undefined;
  onSubmit: (
    sessionID: string | undefined,
    draft: ComposerDraft,
    model: ModelSelection,
    workspaceId?: string,
  ) => Promise<void>;
  header?: ReactNode;
  messageActions?: ReactNode;
  onOpenPanel?: (target: AgentPanelTarget) => void;
  pendingDigIn?: DigInTarget;
  initialModel?: ModelSelection;
  /** Seed a newly mounted conversation once; assistant-ui owns subsequent edits. */
  initialDraft?: ComposerDraft;
  workspaceId?: string;
  readOnly?: boolean;
  composerContext?: ReactNode;
  suggestions?: readonly PromptSuggestion[];
  pending?: boolean;
  children?: ReactNode;
}) {
  const { agent } = useAgentContext();
  const { data: defaultWorkspaceId } = useQuery(
    defaultWorkspaceQueryOptions(transport),
  );
  const { modelProviders, defaultModel } = agent;
  const submission = agent.submitPrompt;
  const truncation = agent.truncateSession;
  const selectedTruncation = truncation.variables?.sessionID === sessionID;
  const selectedSubmission = submission.variables?.sessionID === sessionID;
  const submitting =
    pending ||
    (selectedTruncation && truncation.isPending) ||
    (sessionID
      ? selectedSubmission && submission.isPending
      : agent.createSession.isPending);
  const failedDraft =
    selectedSubmission && submission.isError
      ? submission.variables?.draft
      : undefined;
  const submittedModel = selectedSubmission
    ? submission.variables?.model
    : undefined;
  const [selection, setSelection] = useState<ModelSelection>();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>();
  // Text deltas belong to the thread runtime, not this view's shared context.
  const loading = useSessionSnapshot(agent, sessionID, (s) => s.loading);
  const session = useSessionSnapshot(agent, sessionID, (s) => s.state?.session);
  const lastUserInfo = useSessionSnapshot(agent, sessionID, selectLastUserInfo);
  const workspaceId =
    selectedWorkspaceId ??
    lastUserInfo?.workspaceId ??
    (selectedSubmission ? submission.variables?.workspaceId : undefined) ??
    suppliedWorkspaceId ??
    defaultWorkspaceId;
  // Prefer the local choice, then conversation history, then the submitted model
  // carried across Session creation. Use the global default when none exists.
  const preferred =
    selection ?? lastUserInfo?.model ?? submittedModel ?? initialModel;
  const { providerID, modelID, selectedVariant } = preferred ?? {};
  // Wait for history before resolving the model so an existing choice can restore.
  const model = useMemo(
    () =>
      loading
        ? undefined
        : providerID !== undefined && modelID !== undefined
          ? resolveModel(modelProviders.data ?? [], {
              providerID,
              modelID,
              selectedVariant,
            })
          : defaultModel,
    [
      loading,
      modelProviders.data,
      providerID,
      modelID,
      selectedVariant,
      defaultModel,
    ],
  );
  const context = useMemo(
    () => ({
      transport,
      session,
      model,
      workspaceId,
      pending: pendingDigIn,
      onOpen: onOpenPanel,
    }),
    [transport, session, model, workspaceId, pendingDigIn, onOpenPanel],
  );
  async function submit(draft: ComposerDraft) {
    if (!model) throw new Error("Select an available model before sending.");
    if (selectedTruncation && truncation.isError) truncation.reset();
    await onSubmit(sessionID, draft, model, workspaceId);
  }
  // Both conversation states share these controls and the same prompt inputs.
  const picker = (
    <ComposerControls
      transport={transport}
      model={model}
      onModelChange={setSelection}
      workspaceId={workspaceId}
      onWorkspaceChange={setSelectedWorkspaceId}
      disabled={loading || submitting}
    />
  );
  return (
    <AgentViewProvider value={context}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {header}
        {renderConversation()}
      </div>
    </AgentViewProvider>
  );

  function renderConversation() {
    if (!sessionID) {
      return (
        <AgentNewThread
          initialDraft={initialDraft}
          onSubmit={submit}
          readOnly={readOnly}
          disabled={!model}
          submitting={submitting}
          composerLeading={picker}
          composerContext={composerContext}
          suggestions={suggestions}
        >
          {children}
        </AgentNewThread>
      );
    }
    return (
      <AgentThread
        visible={visible}
        initialDraft={initialDraft}
        key={sessionID}
        sessionID={sessionID}
        model={model}
        onSubmit={submit}
        onTruncate={
          !readOnly && session?.kind === "chat"
            ? async (messageID) => {
                // Keep these choices when truncation removes the latest User metadata.
                setSelection(model);
                setSelectedWorkspaceId(workspaceId);
                await truncation.mutateAsync({ sessionID, messageID });
              }
            : undefined
        }
        readOnly={readOnly}
        submitting={submitting}
        failedDraft={failedDraft}
        messageActions={messageActions}
        composerLeading={picker}
        composerContext={composerContext}
      >
        {children}
      </AgentThread>
    );
  }
}
