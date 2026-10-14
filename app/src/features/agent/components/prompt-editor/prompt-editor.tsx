// Purpose: Author Agent prompt input through the native composer without sending it.
import { type ReactNode, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AssistantRuntimeProvider,
  useAui,
  useAuiState,
} from "@assistant-ui/react";

import { Button } from "@openchart/app/components/ui/button";
import {
  buildPromptParts,
  usePromptDraft,
} from "@openchart/app/features/agent/api/prompt-draft";
import {
  prepareComposerDraft,
  useComposerRuntime,
} from "@openchart/app/features/agent/ag-ui/react/use-assistant-ui-runtime";
import { AgentViewProvider } from "@openchart/app/features/agent/components/agent-view/agent-view-context";
import { useAgentContext } from "@openchart/app/lib/agent/provider";
import { AgentComposer } from "@openchart/app/features/agent/components/composer/composer";
import { ComposerControls } from "@openchart/app/features/agent/components/composer/composer-controls";
import type { ComposerDraft } from "@openchart/app/lib/prompt-converter/converter";
import type {
  AgentInputs,
  AppTransport,
} from "@openchart/app/lib/transport/transport";
import { defaultWorkspaceQueryOptions } from "@openchart/app/lib/workspace/workspace";

type PromptInput = AgentInputs["prompt"]["input"];
type PromptEditorProps = {
  transport: AppTransport;
  prompt?: PromptInput;
  initialText?: string;
  disabled: boolean;
  onCancel: () => void;
  children: (editor: {
    content: ReactNode;
    changed: boolean;
    partsChanged: boolean;
    modelChanged: boolean;
    workspaceChanged: boolean;
    ready: boolean;
    model?: PromptInput["model"];
    read: () => Promise<PromptInput>;
  }) => ReactNode;
};

/**
 * Restore a saved prompt or initialize a new draft with Agent defaults, then expose the shared composer to a host form.
 * assistant-ui owns the draft until unmount; reading completes images and converts Parts
 * without clearing or submitting. Restoration errors offer retry/cancel, never partial editing.
 * The host owns persistence, pending state and closing; mount anew for a different snapshot.
 * @example <AgentPromptEditor {...props}>{editor => <Form editor={editor} />}</AgentPromptEditor>
 */
export function AgentPromptEditor(props: PromptEditorProps) {
  const { transport, prompt } = props;
  const draft = usePromptDraft(
    transport,
    prompt?.parts ??
      (props.initialText ? [{ type: "text", text: props.initialText }] : []),
  );
  if (!draft.isSuccess)
    return props.children({
      content: draft.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading prompt…
        </p>
      ) : (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-muted-foreground">
            This saved prompt cannot be edited in the composer.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void draft.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      ),
      changed: false,
      partsChanged: false,
      modelChanged: false,
      workspaceChanged: false,
      ready: false,
      read: async () => {
        throw new Error("The saved prompt is not ready for editing.");
      },
    });
  return <PromptEditorRuntime {...props} initialDraft={draft.data} />;
}

function PromptEditorRuntime(
  props: PromptEditorProps & { initialDraft: ComposerDraft },
) {
  const runtime = useComposerRuntime({
    initialDraft: props.initialDraft,
    disabled: props.disabled,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <PromptEditorContent {...props} />
    </AssistantRuntimeProvider>
  );
}

function PromptEditorContent({
  transport,
  prompt,
  disabled,
  initialDraft,
  children,
}: PromptEditorProps & { initialDraft: ComposerDraft }) {
  const aui = useAui();
  const { agent } = useAgentContext();
  const { data: defaultWorkspaceId } = useQuery({
    ...defaultWorkspaceQueryOptions(transport),
    enabled: prompt === undefined,
  });
  const [selection, setModel] = useState(prompt?.model);
  const model = selection ?? agent.defaultModel;
  const [selectedWorkspaceId, setWorkspaceId] = useState(prompt?.workspaceId);
  const workspaceId =
    selectedWorkspaceId ?? (prompt ? prompt.workspaceId : defaultWorkspaceId);
  const initialModel = prompt?.model ?? agent.defaultModel;
  // Resolved defaults initialize a new prompt; only explicit selections are edits.
  const modelChanged =
    selection !== undefined &&
    (selection.providerID !== initialModel?.providerID ||
      selection.modelID !== initialModel?.modelID ||
      selection.selectedVariant !== initialModel?.selectedVariant);
  const workspaceChanged =
    selectedWorkspaceId !== undefined &&
    selectedWorkspaceId !== (prompt ? prompt.workspaceId : defaultWorkspaceId);
  const partsChanged = useAuiState(
    ({ composer }) =>
      composer.text !== initialDraft.text ||
      composer.quote?.text !== initialDraft.quote?.text ||
      composer.attachments.length !== initialDraft.attachments.length ||
      composer.attachments.some(
        (attachment, index) =>
          attachment.id !== initialDraft.attachments[index]?.id,
      ),
  );
  const ready = useAuiState(
    ({ composer }) =>
      (composer.text.trim().length > 0 ||
        !!composer.quote ||
        composer.attachments.length > 0) &&
      composer.attachments.every(
        (attachment) =>
          attachment.status.type === "complete" ||
          attachment.status.type === "requires-action",
      ),
  );
  return (
    <AgentViewProvider
      value={{
        transport,
        model,
        workspaceId,
        session: undefined,
        pending: undefined,
        onOpen: undefined,
      }}
    >
      {children({
        content: (
          <AgentComposer
            mode="edit"
            leading={
              <ComposerControls
                transport={transport}
                model={model}
                onModelChange={setModel}
                workspaceId={workspaceId}
                onWorkspaceChange={setWorkspaceId}
                disabled={disabled}
              />
            }
          />
        ),
        changed: partsChanged || modelChanged || workspaceChanged,
        partsChanged,
        modelChanged,
        workspaceChanged,
        model,
        ready: ready && model !== undefined,
        read: async () => {
          if (!model)
            throw new Error("Select an available model before saving.");
          const parts =
            prompt && !partsChanged
              ? prompt.parts
              : await prepareComposerDraft(aui.composer.getState()).then(
                  (prepared) => buildPromptParts(transport, prepared),
                );
          return {
            agent: prompt?.agent ?? "analyst",
            parts,
            model,
            workspaceId,
          };
        },
      })}
    </AgentViewProvider>
  );
}
