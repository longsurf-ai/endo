import { toast } from "sonner";
// Purpose: Adapts the shared core state and commands to assistant-ui's React runtime.

import {
  type AppendMessage,
  type ComposerState,
  type CompleteAttachment,
  MessageNotSentError,
  SimpleImageAttachmentAdapter,
  type QuoteInfo,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { replaceEqualDeep } from "@tanstack/react-query";

import type {
  ModelSelection,
  SessionState,
} from "@openchart/app/lib/agent/client";
import type { SessionStore } from "@openchart/app/lib/agent/session-store";
import type { ComposerDraft } from "@openchart/app/lib/prompt-converter/converter";

import { convertMessages } from "./assistant-ui-messages";
import { toAssistantUiMessage } from "./assistant-ui-message-metadata";
import { useSessionSnapshot } from "@openchart/app/lib/agent/use-session-snapshot";

const selectSnapshot = <T>(snapshot: T) => snapshot;
const attachments = new SimpleImageAttachmentAdapter();

/** Read a draft without sending, clearing or trimming it. Complete picked images with the same upstream adapter used by chat; failures leave the native draft intact. @example const draft = await prepareComposerDraft(runtime.thread.composer.getState()); */
export async function prepareComposerDraft(
  draft: Pick<ComposerState, "text" | "quote" | "attachments">,
): Promise<ComposerDraft> {
  return {
    text: draft.text,
    quote: draft.quote,
    attachments: await Promise.all(
      draft.attachments.map((attachment) => {
        if (attachment.status.type === "complete")
          return attachment as CompleteAttachment;
        if (attachment.status.type !== "requires-action" || !attachment.file)
          throw new Error("Wait for attachments to finish loading.");
        return attachments.send({
          ...attachment,
          file: attachment.file,
          status: attachment.status,
        });
      }),
    ),
  };
}

async function submitMessage(
  message: AppendMessage,
  submit: (draft: ComposerDraft) => Promise<unknown>,
) {
  try {
    await submit(readDraft(message));
  } catch (cause) {
    throw new MessageNotSentError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

function readDraft(message: AppendMessage): ComposerDraft {
  return {
    text: message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
    quote: message.metadata?.custom.quote as QuoteInfo | undefined,
    attachments: message.attachments ?? [],
  };
}

function isSessionRunning(state: SessionState | undefined): boolean {
  if (!state) return false;
  return (
    state.runs.some(
      (run) => run.status === "running" || run.status === "queued",
    ) ||
    // Delegates share their parent's Run; Assistant headers own their completion.
    (state.session.kind === "delegate" &&
      Object.values(state.messageInfo).some(
        (info) => "completedAt" in info && info.completedAt === null,
      ))
  );
}

const emptyMessages: readonly ThreadMessageLike[] = [];

/**
 * Own a standalone draft in assistant-ui, optionally initialized once on mount.
 * Without a submit callback, sending is disabled; hosts read the draft to save it.
 * `sendDisabled` blocks sending while keeping draft editing available.
 * This adapter never creates a Session. Failed submissions retain the draft.
 * @example const runtime = useComposerRuntime({ initialDraft, disabled });
 */
export function useComposerRuntime({
  onSubmit,
  disabled,
  sendDisabled,
  initialDraft,
}: {
  onSubmit?: (draft: ComposerDraft) => Promise<void>;
  disabled?: boolean;
  /** Disable submission while retaining an editable draft, for example during model discovery. */
  sendDisabled?: boolean;
  initialDraft?: ComposerDraft;
}) {
  const runtime = useExternalStoreRuntime({
    messages: emptyMessages,
    convertMessage: toAssistantUiMessage,
    isDisabled: disabled,
    isSendDisabled: disabled || !onSubmit || sendDisabled,
    adapters: { attachments },
    onNew: async (message) => {
      if (!onSubmit) throw new MessageNotSentError("Sending is disabled.");
      await submitMessage(message, onSubmit);
    },
  });
  useInitialDraft(runtime, initialDraft);
  return runtime;
}

function useInitialDraft(
  runtime: ReturnType<typeof useExternalStoreRuntime>,
  initialDraft: ComposerDraft | undefined,
) {
  const initialized = useRef(false);
  useLayoutEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    if (!initialDraft) return;
    const composer = runtime.thread.composer;
    composer.setText(initialDraft.text);
    composer.setQuote(initialDraft.quote);
    for (const attachment of initialDraft.attachments) {
      void composer.addAttachment(attachment);
    }
  }, [initialDraft, runtime]);
}

/**
 * Projects a session into assistant-ui without owning its state or execution.
 * Custom React views can use useSessionSnapshot alone and omit this adapter.
 * The host supplies submission and its status. Rejected input handed across
 * Session creation restores an empty composer; existing drafts are preserved.
 *
 * @example
 * const {runtime, snapshot, session} = useAssistantUiRuntime(options);
 * // Render runtime with AssistantRuntimeProvider; use snapshot for permissions.
 */
export function useAssistantUiRuntime({
  agent,
  sessionID,
  model,
  onSubmit,
  onTruncate,
  submitting = false,
  failedDraft,
  initialDraft,
}: {
  agent: Pick<SessionStore, "getSession">;
  sessionID: string;
  model?: ModelSelection;
  onSubmit: (draft: ComposerDraft) => Promise<void>;
  onTruncate?: (messageID: string | null) => Promise<void>;
  submitting?: boolean;
  failedDraft?: ComposerDraft;
  initialDraft?: ComposerDraft;
}) {
  const snapshot = useSessionSnapshot(agent, sessionID, selectSnapshot);
  const sessionHandle = agent.getSession(sessionID);
  const running = isSessionRunning(snapshot.state);
  const previousMessages = useRef<ThreadMessageLike[]>([]);
  const messages = useMemo(
    () =>
      // Reuse the framework's structural sharing, then let assistant-ui's
      // identity cache normalize only changed messages (including Date values).
      replaceEqualDeep(
        previousMessages.current,
        convertMessages(
          snapshot.messages,
          running,
          snapshot.subagents,
          snapshot.state?.messageInfo,
        ),
      ),
    [
      snapshot.messages,
      running,
      snapshot.subagents,
      snapshot.state?.messageInfo,
    ],
  );
  useLayoutEffect(() => {
    previousMessages.current = messages;
  }, [messages]);
  const disabled = snapshot.loading || model === undefined || submitting;
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: toAssistantUiMessage,
    isDisabled: disabled,
    isSendDisabled: disabled,
    adapters: {
      attachments,
      threadList: { threadId: sessionID },
    },
    isLoading: snapshot.loading,
    isRunning: running,
    onNew: (message) => submitMessage(message, onSubmit),
    onEdit: onTruncate ? editMessage : undefined,
    onCancel: async () => {
      try {
        await sessionHandle.cancel();
      } catch (cause) {
        toast.error("Couldn’t stop the agent", {
          description: cause instanceof Error ? cause.message : String(cause),
        });
        throw cause;
      }
    },
  });
  useInitialDraft(runtime, initialDraft);
  useEffect(() => {
    // Creating a Session mounts a new composer before admission finishes.
    // Restore rejected input there without overwriting a draft the user edited.
    const composer = runtime.thread.composer;
    if (
      failedDraft &&
      composer.getState().isEmpty &&
      !composer.getState().quote
    ) {
      composer.setText(failedDraft.text);
      composer.setQuote(failedDraft.quote);
      for (const attachment of failedDraft.attachments) {
        void composer.addAttachment(attachment);
      }
    }
  }, [failedDraft, runtime]);

  return { runtime, snapshot, session: sessionHandle };

  async function editMessage(message: AppendMessage) {
    const sourceID = message.sourceId;
    if (!sourceID)
      throw new Error("An edit must identify its original message.");
    const draft = readEditDraft(message, sourceID);
    try {
      if (running || submitting || snapshot.loading || !model)
        throw new Error(
          "Wait for the conversation to be ready before editing.",
        );
      const parent = messages.find((entry) => entry.id === message.parentId);
      const messageID =
        message.parentId === null
          ? null
          : parent?.metadata?.custom?.sourceMessageId;
      if (messageID !== null && typeof messageID !== "string")
        throw new Error("The preceding reply has no canonical Message ID.");
      // This handler is registered only when onTruncate is available.
      await onTruncate!(messageID);
    } catch (cause) {
      restoreEditDraft(sourceID, draft);
      throw cause;
    }
    await onSubmit(draft);
  }

  function readEditDraft(
    message: AppendMessage,
    sourceID: string,
  ): ComposerDraft {
    const source = messages.find((entry) => entry.id === sourceID);
    const input = readDraft(message);
    // Quotes are durable data parts, separate from the editable prompt text.
    const quote = Array.isArray(source?.content)
      ? source.content.find(
          (part) => part.type === "data" && part.name === "quote",
        )
      : undefined;
    return {
      ...input,
      // The upstream edit composer lifts data Parts into attachments. The
      // durable quote is restored below, not submitted again as a file.
      attachments: input.attachments.filter(
        (attachment) =>
          !attachment.content.some(
            (part) => part.type === "data" && part.name === "quote",
          ),
      ),
      quote:
        quote?.type === "data" && typeof quote.data === "string"
          ? { text: quote.data, messageId: sourceID }
          : input.quote,
    };
  }

  function restoreEditDraft(sourceID: string, draft: ComposerDraft) {
    // The upstream edit composer closes on send, before the async command finishes.
    // Reopen it when preparation fails; the original history still exists.
    if (
      !runtime.thread.getState().messages.some((entry) => entry.id === sourceID)
    )
      return;
    const composer = runtime.thread.getMessageById(sourceID).composer;
    if (!composer.getState().isEditing) composer.beginEdit();
    composer.setText(draft.text);
  }
}
