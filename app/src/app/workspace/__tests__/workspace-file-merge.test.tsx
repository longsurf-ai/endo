// Purpose: Verify file merges reuse Agent admission with tier one and the file's workspace.
import { useContext } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceFileMergeProvider } from "@openchart/app/app/workspace/workspace-file-merge";
import { WorkspaceFileMerge } from "@openchart/app/lib/workspace/workspace";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  submit: vi.fn(),
  select: vi.fn(),
  admitted: vi.fn(),
  failed: vi.fn(),
  models: [{ id: "tier1", providerID: "codex" }],
}));
vi.mock("@openchart/app/lib/agent/provider", () => ({
  useAgentContext: () => ({
    agent: {
      defaultModel: {
        providerID: "codex",
        modelID: "tier4",
        selectedVariant: "high",
      },
      modelProviders: { data: [{ id: "codex", models: mocks.models }] },
      createSession: { mutateAsync: mocks.create },
      submitPrompt: { mutateAsync: mocks.submit },
    },
  }),
}));
vi.mock("@openchart/app/app/agent/copilot-controls", () => ({
  useCopilotControls: () => ({ selectSession: mocks.select }),
}));

function MergeRequest() {
  const merge = useContext(WorkspaceFileMerge)!;
  return (
    <button
      onClick={() =>
        void merge("wsp_research", "Merge these snapshots").then(
          mocks.admitted,
          mocks.failed,
        )
      }
    >
      Merge
    </button>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.models = [{ id: "tier1", providerID: "codex" }];
  mocks.create.mockResolvedValue({ id: "ses_merge" });
});

test("reveals a fresh conversation and only resolves after tier-one prompt admission", async () => {
  let accept!: () => void;
  mocks.submit.mockReturnValue(
    new Promise<void>((resolve) => {
      accept = resolve;
    }),
  );
  render(
    <WorkspaceFileMergeProvider>
      <MergeRequest />
    </WorkspaceFileMergeProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  await waitFor(() =>
    expect(mocks.submit).toHaveBeenCalledWith({
      sessionID: "ses_merge",
      workspaceId: "wsp_research",
      model: { providerID: "codex", modelID: "tier1" },
      draft: {
        text: "Merge these snapshots",
        attachments: [],
        quote: undefined,
      },
    }),
  );
  expect(mocks.select).toHaveBeenCalledWith("ses_merge");
  expect(mocks.admitted).not.toHaveBeenCalled();
  accept();
  await waitFor(() => expect(mocks.admitted).toHaveBeenCalledOnce());
});

test("failed admission rejects so the editor keeps the draft", async () => {
  const failure = new Error("Admission unavailable");
  mocks.submit.mockRejectedValue(failure);
  render(
    <WorkspaceFileMergeProvider>
      <MergeRequest />
    </WorkspaceFileMergeProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  await waitFor(() => expect(mocks.failed).toHaveBeenCalledWith(failure));
  expect(mocks.admitted).not.toHaveBeenCalled();
});

test("an unavailable small model does not silently use a larger model or create a conversation", async () => {
  mocks.models = [{ id: "tier4", providerID: "codex" }];
  render(
    <WorkspaceFileMergeProvider>
      <MergeRequest />
    </WorkspaceFileMergeProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  await waitFor(() => expect(mocks.failed).toHaveBeenCalledOnce());
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.submit).not.toHaveBeenCalled();
});
