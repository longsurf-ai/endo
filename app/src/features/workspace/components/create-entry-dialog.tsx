// Purpose: Own one creation form's draft and mutations until the dialog closes.
import { useState } from "react";
import { Button } from "@openchart/app/components/ui/button";
import { Input } from "@openchart/app/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@openchart/app/components/ui/dialog";
import { useWorkspaceFileMutations } from "@openchart/app/lib/workspace/workspace";
import { useWorkspaceView } from "./context";
import type { CreateKind } from "./file-tree";

const defaultWorkflowSource = `import { defineWorkflow, Schema, agent, textPrompt } from "@openchart/workflow";

// GET STARTED
// Save this file, reference it with @ in the Agent composer, and ask to run it.
// Import workflow helpers from @openchart/workflow; no package setup is needed.

export default defineWorkflow({
  // 1. PURPOSE — Tell the Agent when to use this workflow.
  description: "Research a question using a fresh agent",

  // 2. INPUTS — The caller supplies these values; Schema validates them.
  // Add fields here, e.g. symbol: Schema.String or rounds: Schema.Int,
  // then include them in run's first argument: ({ question, symbol, rounds }).
  args: Schema.Struct({ question: Schema.String }),

  // 3. RUN — Start a fresh agent using the caller's model and agent profile.
  // Customize question, e.g. "Research with sources: " + question.
  // The child receives this prompt, not the parent's conversation history.
  // agent() returns an Effect whose result is { sessionId, output }.
  run: ({ question }, { parentPrompt }) =>
    agent(textPrompt(question, parentPrompt.model, parentPrompt.agent)),
});

// EXTEND: MULTIPLE STEPS
// Add Effect to the import above, then replace run with this example.
// yield* waits for each step; use its output in the next prompt.
//
// run: ({ question }, { parentPrompt }) => Effect.gen(function* () {
//   const { model, agent: profile } = parentPrompt;
//   const research = yield* agent(textPrompt(question, model, profile));
//   const review = yield* agent(
//     textPrompt("Review this answer: " + research.output, model, profile),
//   );
//   return review.output;
// }),
//
// MORE OPTIONS — Import any additional helpers from @openchart/workflow.
// Parallel: yield* parallel([agent(promptA), agent(promptB)]) inside Effect.gen.
//   Each result has status: "success" with value, or "error" with error details.
// Continue a child: agent(nextPrompt, { sessionId: research.sessionId }).
//   Reuses that child's history within this workflow run.
// Structured output: agent(prompt, { schema: Schema.Struct({ summary: Schema.String }) }).
//   The result's output is decoded to match your schema.
`;

/** Create a file or folder in the targeted workspace directory. Failures preserve the draft for retry; unmounting resets the form. @example <CreateEntryDialog workspaceId={id} kind="file" directory="src" onClose={close} onCreated={openFile} /> */
export function CreateEntryDialog({
  workspaceId,
  kind,
  directory,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  kind: CreateKind;
  directory: string;
  onClose: () => void;
  onCreated: (path: string) => void;
}) {
  const { transport } = useWorkspaceView();
  const { write, mkdir } = useWorkspaceFileMutations(transport, workspaceId);
  const [filename, setFilename] = useState(
    `${directory ? `${directory}/` : ""}${kind === "file" ? "untitled.workflow.ts" : "untitled"}`,
  );
  const creation = kind === "folder" ? mkdir : write;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !creation.isPending) onClose();
      }}
    >
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (kind === "folder") {
              mkdir.mutate({ path: filename.trim() }, { onSuccess: onClose });
              return;
            }
            const path = filename.trim();
            write.mutate(
              {
                path,
                text: path.endsWith(".workflow.ts")
                  ? defaultWorkflowSource
                  : "",
                expected: null,
              },
              {
                onSuccess: (entry) => {
                  onClose();
                  onCreated(entry.path);
                },
              },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {kind === "folder" ? "Create folder" : "Create file"}
            </DialogTitle>
            <DialogDescription>
              {kind === "folder"
                ? "Enter a folder path within this workspace."
                : "Enter a file path within this workspace. Include a folder path to create it inside a folder."}
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label={kind === "folder" ? "Folder path" : "File path"}
            value={filename}
            onChange={(event) => setFilename(event.target.value)}
            className="my-4"
          />

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={creation.isPending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!filename.trim() || creation.isPending}
            >
              {kind === "folder" ? "Create folder" : "Create file"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
