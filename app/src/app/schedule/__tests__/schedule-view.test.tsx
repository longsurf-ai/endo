import { renderWithToaster as render } from "@openchart/app/testing/test-utils";
import { findErrorToast } from "@openchart/app/testing/test-utils";
import { createQueryClient } from "@openchart/app/lib/react-query/react-query";
// Purpose: Exercise Schedule composition, including the real shared composer and revision-safe edits.
import { Fragment, StrictMode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { ScheduleView } from "@openchart/app/features/schedule/components/schedule-view";
import { SchedulePromptEditor } from "@openchart/app/app/schedule/schedule-prompt-editor";
import type { PromptParts } from "@openchart/app/lib/prompt-converter/converter";
import type { Schedule } from "@openchart/app/features/schedule/api/queries";
import { subscribeResourceInvalidation } from "@openchart/app/lib/resource/invalidation";
import {
  createTransport,
  type AppEventFrame,
} from "@openchart/app/lib/transport/transport";

const rpc = vi.hoisted(() => ({
  agent: {
    restoreCommand: { mutate: vi.fn() },
    buildCommand: { mutate: vi.fn() },
    prompt: { mutate: vi.fn() },
    createSession: { mutate: vi.fn() },
  },
  events: { subscribe: { subscribe: vi.fn() } },
  scheduler: { runNow: { mutate: vi.fn() } },
  resources: {
    workspace: {
      get: { query: vi.fn() },
      getDefault: { query: vi.fn() },
      list: { query: vi.fn() },
    },
    agent_schedule: {
      list: { query: vi.fn() },
      patch: { mutate: vi.fn() },
      create: { mutate: vi.fn() },
    },
    agent_schedule_occurrence: { list: { query: vi.fn() } },
  },
  workspace: { listTree: { query: vi.fn() } },
}));
vi.mock("@openchart/app/lib/agent/provider", () => ({
  useAgentContext: () => ({
    agent: {
      defaultModel: { providerID: "codex", modelID: "tier1" },
      modelProviders: {
        data: [
          {
            id: "codex",
            name: "Codex",
            models: [
              {
                id: "tier1",
                tier: 1,
                providerID: "codex",
                name: "Fast model",
                availableVariants: ["low", "high"],
              },
              {
                id: "tier2",
                tier: 2,
                providerID: "codex",
                name: "Reasoning model",
                availableVariants: ["low", "high"],
              },
            ],
          },
        ],
        isPending: false,
        isError: false,
      },
      providerSetup: [
        { data: { status: "idle" } },
        { data: { status: "idle" } },
      ],
      commands: {
        data: [
          {
            name: "best-of-n",
            type: "workflow",
            description: "Compare candidates",
            argumentHint: "<count> <prompt>",
          },
        ],
        isPending: false,
        isError: false,
      },
    },
  }),
}));
vi.mock("@trpc/client", async (original) => ({
  ...(await original<typeof import("@trpc/client")>()),
  createTRPCClient: () => rpc,
}));

const disposals: Array<() => void> = [];
// Radix Select and cmdk use browser APIs that jsdom does not implement.
beforeAll(async () => {
  // Compile the lazy picker before interaction assertions start their timeout.
  await import("@openchart/app/components/ui/calendar");
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: () => "blob:preview",
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    value: MouseEvent,
  });
  for (const [name, value] of Object.entries({
    hasPointerCapture: (): boolean => false,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    scrollIntoView: () => {},
  }))
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      value,
    });
});
afterAll(() => {
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
  Reflect.deleteProperty(window, "PointerEvent");
  for (const name of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture",
    "scrollIntoView",
  ])
    Reflect.deleteProperty(HTMLElement.prototype, name);
});
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.resetAllMocks();
  vi.useRealTimers();
});

/** Every fixture schedules an Agent prompt; data collections have no prompt editor. */
type PromptSchedule = Schedule & {
  target: Extract<Schedule["target"], { kind: "agent_prompt" }>;
};

function schedule(id = "daily"): PromptSchedule {
  return {
    id: `ags_${id}` as Schedule["id"],
    revision: 3,
    createdAt: Date.parse("2026-09-01T00:00:00.000Z"),
    name: id === "daily" ? "Morning briefing" : "Weekly review",
    enabled: true,
    recurrence: {
      kind: "cron",
      expression: "0 9 * * 1-5",
      timeZone: "America/New_York",
    },
    nextFireAt: Date.parse("2026-09-21T13:00:00.000Z"),
    target: {
      kind: "agent_prompt",
      prompt: {
        agent: "default",
        model: { providerID: "codex", modelID: "tier1" },
        parts: [{ type: "text", text: "Summarize the market" }],
      },
      binding: { key: "schedule-binding" },
    },
  };
}

function setup(
  items: Schedule[] = [schedule()],
  nextCursor: string | null = null,
  strict = false,
) {
  const queryClient = createQueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  disposals.push(() => queryClient.clear());
  let emit: (frame: AppEventFrame) => void = () => {};
  rpc.events.subscribe.subscribe.mockImplementation((_input, callbacks) => {
    emit = callbacks.onData;
    return { unsubscribe: vi.fn() };
  });
  rpc.resources.agent_schedule.list.query.mockImplementation(async () => ({
    items: [...items],
    nextCursor,
  }));
  rpc.resources.agent_schedule_occurrence.list.query.mockResolvedValue({
    items: [],
    nextCursor: null,
  });
  rpc.resources.workspace.get.query.mockImplementation(async ({ id }) => ({
    id,
    root: id === "research" ? "/projects/research" : "/workspace",
  }));
  rpc.resources.workspace.getDefault.query.mockResolvedValue("workspace");
  rpc.resources.workspace.list.query.mockResolvedValue({
    items: [
      { id: "workspace", root: "/workspace" },
      { id: "research", root: "/projects/research" },
    ],
    nextCursor: null,
  });
  rpc.workspace.listTree.query.mockResolvedValue({
    status: "ready",
    entries: [{ path: "report.md" }],
  });
  const transport = createTransport({ origin: "http://schedule.test" });
  const subscription = subscribeResourceInvalidation(transport, queryClient);
  disposals.push(() => subscription.unsubscribe());
  const onOpenSession = vi.fn();
  const Mode = strict ? StrictMode : Fragment;
  render(
    <Mode>
      <QueryClientProvider client={queryClient}>
        <ScheduleView
          transport={transport}
          renderHeader={(createAction) => (
            <header>
              <h1>Schedule</h1>
              {createAction}
            </header>
          )}
          view="list"
          onOpenSession={onOpenSession}
          renderPromptEditor={(props) => (
            <SchedulePromptEditor transport={transport} {...props} />
          )}
        />
      </QueryClientProvider>
    </Mode>,
  );
  return {
    items,
    onOpenSession,
    emit: (resource: string) =>
      emit({
        kind: "event",
        event: {
          id: "evt_test" as never,
          type: "resource.changed",
          data: { resource },
        },
      }),
  };
}

const imagePart = {
  type: "file" as const,
  mime: "image/png",
  filename: "chart.png",
  url: "data:image/png;base64,Y2hhcnQ=",
};
const quotePart = {
  type: "context" as const,
  context: { kind: "quote" as const, text: "Revenue grew 20%." },
};
const workflowPart = {
  type: "workflow" as const,
  workflow: "default:workflows/best-of-n.workflow.ts",
  args: { n: 3, question: "Research Google" },
};

function withParts(parts: PromptParts): PromptSchedule {
  const value = schedule();
  return {
    ...value,
    target: {
      ...value.target,
      prompt: {
        ...value.target.prompt,
        workspaceId: "workspace",
        parts: parts as PromptSchedule["target"]["prompt"]["parts"],
      },
    },
  };
}

async function openEditor() {
  await userEvent.click(
    await screen.findByRole("button", { name: "Edit Morning briefing" }),
  );
  return screen.findByRole("textbox", { name: "Prompt" });
}

test("creates from the empty state through the shared dialog and refreshes the list without running a prompt", async () => {
  const fixture = setup([]);
  const user = userEvent.setup();
  rpc.resources.agent_schedule.create.mutate.mockImplementation(
    async (input) => {
      const created = { ...schedule("created"), ...input };
      fixture.items.push(created);
      return created;
    },
  );
  await user.click(
    await screen.findByRole("button", { name: "Create schedule" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Create schedule" });
  const prompt = await within(dialog).findByRole("textbox", { name: "Prompt" });
  const submit = within(dialog).getByRole("button", {
    name: "Create schedule",
  });
  expect(submit).toBeDisabled();
  await user.type(within(dialog).getByLabelText("Name"), "Daily research");
  await user.type(prompt, "Summarize the market");
  fireEvent.change(within(dialog).getByLabelText("Time", { exact: true }), {
    target: { value: "09:15" },
  });
  await user.click(submit);
  await screen.findByRole("button", { name: "Daily research" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    rpc.resources.agent_schedule.create.mutate,
  ).toHaveBeenCalledExactlyOnceWith({
    name: "Daily research",
    recurrence: {
      kind: "cron",
      expression: "15 9 * * *",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    target: {
      kind: "agent_prompt",
      prompt: {
        agent: "analyst",
        parts: [{ type: "text", text: "Summarize the market" }],
        model: { providerID: "codex", modelID: "tier1" },
        workspaceId: "workspace",
      },
    },
  });
  expect(rpc.resources.agent_schedule.patch.mutate).not.toHaveBeenCalled();
  expect(rpc.agent.createSession.mutate).not.toHaveBeenCalled();
  expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();
  expect(rpc.scheduler.runNow.mutate).not.toHaveBeenCalled();
});

test("retains a failed creation draft, blocks duplicate saves, and discards it on cancel", async () => {
  setup([]);
  const user = userEvent.setup();
  let rejectCreate: (error: Error) => void = () => {};
  rpc.resources.agent_schedule.create.mutate.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectCreate = reject;
      }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Create schedule" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Create schedule" });
  const prompt = await within(dialog).findByRole("textbox", { name: "Prompt" });
  await user.type(within(dialog).getByLabelText("Name"), "Unsaved schedule");
  await user.type(prompt, "Research stocks");
  await user.click(
    within(dialog).getByRole("button", { name: "Create schedule" }),
  );
  await waitFor(() =>
    expect(rpc.resources.agent_schedule.create.mutate).toHaveBeenCalledOnce(),
  );
  expect(
    within(dialog).getByRole("button", { name: "Saving…" }),
  ).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(dialog).toBeVisible();
  await act(async () => rejectCreate(new Error("Could not create")));
  expect(await findErrorToast("Could not create")).toHaveTextContent(
    "Could not create",
  );
  expect(prompt).toHaveTextContent("Research stocks");
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Unsaved schedule");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Create schedule" }));
  const reopened = screen.getByRole("dialog");
  expect(
    await within(reopened).findByRole("textbox", { name: "Prompt" }),
  ).toHaveTextContent("");
  expect(within(reopened).getByLabelText("Name")).toHaveValue("");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("restores quotes, file chips, images and workspace in StrictMode, then patches only changed parts", async () => {
  const text = "  Review\n:file[report.md]{name=/workspace/report.md}  ";
  const original = withParts([quotePart, { type: "text", text }, imagePart]);
  const fixture = setup([original], null, true);
  const input = await openEditor();
  expect(input).toHaveTextContent("report.md");
  expect(screen.getByText(quotePart.context.text)).toBeVisible();
  expect(screen.getAllByRole("button", { name: "Remove file" })).toHaveLength(
    1,
  );
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  // eslint-disable-next-line testing-library/no-node-access -- Catch invalid nested forms, including forms without an accessible name.
  expect(document.querySelectorAll("form")).toHaveLength(1);
  expect(rpc.resources.workspace.get.query).toHaveBeenCalledWith(
    { id: "workspace" },
    expect.anything(),
  );
  expect(rpc.workspace.listTree.query).not.toHaveBeenCalled();
  // Removing the quote changes Parts but leaves the text, chip and image verbatim.
  await userEvent.click(screen.getByRole("button", { name: "Dismiss quote" }));
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(
      rpc.resources.agent_schedule.patch.mutate,
    ).toHaveBeenCalledExactlyOnceWith({
      id: original.id,
      expectedRevision: original.revision,
      operations: [
        {
          op: "replace",
          path: "/target/prompt/parts",
          value: [{ type: "text", text }, imagePart],
        },
      ],
    }),
  );
  expect(fixture.items[0]).toEqual(original);
  expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();
  expect(rpc.agent.createSession.mutate).not.toHaveBeenCalled();
  expect(rpc.scheduler.runNow.mutate).not.toHaveBeenCalled();
});

test("Enter inserts a newline; saving text and timing writes one revision-checked patch", async () => {
  setup();
  const user = userEvent.setup();
  const input = await openEditor();
  expect(
    screen.queryByRole("button", { name: "Send message" }),
  ).not.toBeInTheDocument();
  await user.clear(input);
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await user.type(input, "  First line{Enter}Second line  ");
  expect(rpc.resources.agent_schedule.patch.mutate).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Time", { exact: true }), {
    target: { value: "10:17" },
  });
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(
      rpc.resources.agent_schedule.patch.mutate,
    ).toHaveBeenCalledExactlyOnceWith({
      id: "ags_daily",
      expectedRevision: 3,
      operations: [
        {
          op: "replace",
          path: "/recurrence",
          value: {
            kind: "cron",
            expression: "17 10 * * 1-5",
            timeZone: "America/New_York",
          },
        },
        {
          op: "replace",
          path: "/target/prompt/parts",
          value: [{ type: "text", text: "  First line\nSecond line  " }],
        },
      ],
    }),
  );
});

test("completes newly pasted images on Save and retains text, quote and images on failure", async () => {
  setup([
    withParts([quotePart, { type: "text", text: "Original" }, imagePart]),
  ]);
  rpc.resources.agent_schedule.patch.mutate.mockRejectedValueOnce(
    new Error("Offline"),
  );
  const user = userEvent.setup();
  const input = await openEditor();
  await user.clear(input);
  await user.type(input, "Edited");
  fireEvent.paste(input, {
    clipboardData: {
      files: [new File(["new chart"], "new.png", { type: "image/png" })],
    },
  });
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Remove file" })).toHaveLength(
      2,
    ),
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await findErrorToast("Offline")).toHaveTextContent("Offline");
  expect(input).toHaveTextContent("Edited");
  expect(screen.getByText(quotePart.context.text)).toBeVisible();
  expect(screen.getAllByRole("button", { name: "Remove file" })).toHaveLength(
    2,
  );
  expect(
    rpc.resources.agent_schedule.patch.mutate,
  ).toHaveBeenCalledExactlyOnceWith({
    id: "ags_daily",
    expectedRevision: 3,
    operations: [
      {
        op: "replace",
        path: "/target/prompt/parts",
        value: [
          quotePart,
          { type: "text", text: "Edited" },
          imagePart,
          {
            type: "file",
            mime: "image/png",
            filename: "new.png",
            url: "data:image/png;base64,bmV3IGNoYXJ0",
          },
        ],
      },
    ],
  });
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(rpc.resources.agent_schedule.patch.mutate).toHaveBeenCalledTimes(2);
  expect(rpc.resources.agent_schedule.patch.mutate.mock.calls[1]).toEqual(
    rpc.resources.agent_schedule.patch.mutate.mock.calls[0],
  );
});

test("restores workflow commands as editable chips and compiles them only when changed", async () => {
  setup([withParts([workflowPart])]);
  rpc.agent.restoreCommand.mutate.mockResolvedValue({
    command: "best-of-n",
    arguments: "3 Research Google",
  });
  rpc.agent.buildCommand.mutate.mockResolvedValue([
    { ...workflowPart, args: { n: 3, question: "Research Google today" } },
  ]);
  const user = userEvent.setup();
  const input = await openEditor();
  expect(
    await within(input).findByLabelText("command: /best-of-n"),
  ).toHaveAttribute("data-directive-id", "best-of-n");
  expect(input).toHaveTextContent("3 Research Google");
  expect(rpc.agent.restoreCommand.mutate).toHaveBeenCalledWith(
    workflowPart,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(rpc.agent.buildCommand.mutate).not.toHaveBeenCalled();
  // Place the caret after the preserved command chip and arguments.
  await user.click(input);
  const selection = window.getSelection()!;
  selection.selectAllChildren(input);
  selection.collapseToEnd();
  await user.keyboard(" today");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(rpc.resources.agent_schedule.patch.mutate).toHaveBeenCalledOnce(),
  );
  expect(rpc.agent.buildCommand.mutate).toHaveBeenCalledExactlyOnceWith({
    command: "best-of-n",
    arguments: "3 Research Google today",
  });
  expect(rpc.resources.agent_schedule.patch.mutate).toHaveBeenCalledWith({
    id: "ags_daily",
    expectedRevision: 3,
    operations: [
      {
        op: "replace",
        path: "/target/prompt/parts",
        value: [
          {
            ...workflowPart,
            args: { n: 3, question: "Research Google today" },
          },
        ],
      },
    ],
  });
});

test("retains the draft when command compilation fails and blocks closing during compilation", async () => {
  setup();
  let rejectBuild: (error: Error) => void = () => {};
  rpc.agent.buildCommand.mutate.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectBuild = reject;
      }),
  );
  const user = userEvent.setup();
  const input = await openEditor();
  await user.clear(input);
  await user.type(input, "/best-of-n zero Research");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(rpc.agent.buildCommand.mutate).toHaveBeenCalledOnce(),
  );
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await waitFor(() =>
    expect(input).toHaveAttribute("contenteditable", "false"),
  );
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeVisible();
  await act(async () => rejectBuild(new Error("Count must be positive")));
  expect(await findErrorToast("Count must be positive")).toHaveTextContent(
    "Count must be positive",
  );
  expect(input).toHaveTextContent("/best-of-n zero Research");
  expect(rpc.resources.agent_schedule.patch.mutate).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await openEditor()).toHaveTextContent("Summarize the market");
});

test("restoration failures expose Retry and unsupported Parts cannot be overwritten", async () => {
  const fixture = setup([withParts([workflowPart])]);
  rpc.agent.restoreCommand.mutate.mockRejectedValueOnce(
    new Error("Unavailable"),
  );
  rpc.agent.restoreCommand.mutate.mockResolvedValue({
    command: "best-of-n",
    arguments: "3 Research Google",
  });
  await userEvent.click(
    await screen.findByRole("button", { name: "Edit Morning briefing" }),
  );
  expect(await findErrorToast("Unavailable")).toHaveTextContent("Unavailable");
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await userEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Retry" }),
  );
  expect(
    await screen.findByRole("textbox", { name: "Prompt" }),
  ).toHaveTextContent("/best-of-n");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fixture.items[0] = {
    ...withParts([{ type: "text", text: "Unsupported", synthetic: true }]),
    revision: 4,
  };
  act(() => fixture.emit("agent_schedule"));
  await waitFor(() =>
    expect(rpc.resources.agent_schedule.list.query).toHaveBeenCalledTimes(2),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Edit Morning briefing" }),
  );
  expect(await findErrorToast("synthetic")).toHaveTextContent(
    "Expected no excess property",
  );
  expect(
    screen.queryByRole("textbox", { name: "Prompt" }),
  ).not.toBeInTheDocument();
  expect(rpc.resources.agent_schedule.patch.mutate).not.toHaveBeenCalled();
});

test("a newer revision preserves the local prompt until cancel, then reopening loads the latest", async () => {
  const fixture = setup();
  const input = await openEditor();
  await userEvent.clear(input);
  await userEvent.type(input, "Local draft");
  fixture.items[0] = {
    ...withParts([{ type: "text", text: "Remote edit" }]),
    revision: 4,
  };
  act(() => fixture.emit("agent_schedule"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This schedule changed",
  );
  expect(input).toHaveTextContent("Local draft");
  await waitFor(() =>
    expect(input).toHaveAttribute("contenteditable", "false"),
  );
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await openEditor()).toHaveTextContent("Remote edit");
  expect(rpc.resources.agent_schedule.patch.mutate).not.toHaveBeenCalled();
});

test("restores model, effort and workspace, then saves only picker changes and retains them after failure", async () => {
  const original = withParts([workflowPart, imagePart]);
  original.target.prompt.model.selectedVariant = "high";
  const fixture = setup([original]);
  rpc.agent.restoreCommand.mutate.mockResolvedValue({
    command: "best-of-n",
    arguments: "3 Research Google",
  });
  rpc.resources.agent_schedule.patch.mutate.mockRejectedValueOnce(
    new Error("Offline"),
  );
  const user = userEvent.setup();
  const input = await openEditor();
  expect(
    screen.getByRole("combobox", { name: "Fast model high" }),
  ).toBeEnabled();
  expect(
    await screen.findByRole("button", { name: "Workspace: workspace" }),
  ).toBeEnabled();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await user.click(screen.getByRole("combobox", { name: "Fast model high" }));
  expect(screen.getByRole("radio", { name: "high" })).toBeChecked();
  await user.click(
    screen.getByRole("option", { name: "Reasoning model Codex" }),
  );
  await user.click(
    screen.getByRole("combobox", { name: "Reasoning model Default" }),
  );
  await user.click(screen.getByRole("radio", { name: "high" }));
  await user.keyboard("{Escape}");
  await user.click(
    screen.getByRole("button", { name: "Workspace: workspace" }),
  );
  await user.click(screen.getByRole("menuitemradio", { name: "research" }));
  await waitFor(() =>
    expect(rpc.resources.workspace.get.query).toHaveBeenCalledWith(
      { id: "research" },
      expect.anything(),
    ),
  );
  expect(input).toHaveTextContent("3 Research Google");
  expect(screen.getByRole("button", { name: "Remove file" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await findErrorToast("Offline")).toHaveTextContent("Offline");
  expect(
    screen.getByRole("combobox", { name: "Reasoning model high" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Workspace: research" }),
  ).toBeEnabled();
  const model = {
    providerID: "codex" as const,
    modelID: "tier2" as const,
    selectedVariant: "high",
  };
  expect(
    rpc.resources.agent_schedule.patch.mutate,
  ).toHaveBeenCalledExactlyOnceWith({
    id: original.id,
    expectedRevision: original.revision,
    operations: [
      { op: "replace", path: "/target/prompt/model", value: model },
      { op: "add", path: "/target/prompt/workspaceId", value: "research" },
    ],
  });
  rpc.resources.agent_schedule.patch.mutate.mockImplementationOnce(async () => {
    fixture.items[0] = {
      ...original,
      revision: original.revision + 1,
      target: {
        ...original.target,
        prompt: { ...original.target.prompt, model, workspaceId: "research" },
      },
    };
  });
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await openEditor();
  expect(
    screen.getByRole("combobox", { name: "Reasoning model high" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Workspace: research" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  expect(rpc.agent.buildCommand.mutate).not.toHaveBeenCalled();
  expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();
  expect(rpc.agent.createSession.mutate).not.toHaveBeenCalled();
  expect(rpc.scheduler.runNow.mutate).not.toHaveBeenCalled();
});

test("adds an omitted workspace and clears the saved effort when Default is selected", async () => {
  const original = schedule();
  original.target.prompt.model.selectedVariant = "high";
  setup([original]);
  const user = userEvent.setup();
  await openEditor();
  await user.click(screen.getByRole("combobox", { name: "Fast model high" }));
  await user.click(screen.getByRole("radio", { name: "Default" }));
  await user.keyboard("{Escape}");
  await user.click(
    screen.getByRole("button", { name: "Workspace: Workspace" }),
  );
  await user.click(screen.getByRole("menuitemradio", { name: "research" }));
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(
      rpc.resources.agent_schedule.patch.mutate,
    ).toHaveBeenCalledExactlyOnceWith({
      id: original.id,
      expectedRevision: original.revision,
      operations: [
        {
          op: "replace",
          path: "/target/prompt/model",
          value: { providerID: "codex", modelID: "tier1" },
        },
        { op: "add", path: "/target/prompt/workspaceId", value: "research" },
      ],
    }),
  );
});

test("blocks picker changes on a stale revision and discards local selections when cancelled", async () => {
  const fixture = setup([
    withParts([{ type: "text", text: "Original prompt" }]),
  ]);
  const user = userEvent.setup();
  await openEditor();
  await user.click(
    screen.getByRole("combobox", { name: "Fast model Default" }),
  );
  await user.click(
    screen.getByRole("option", { name: "Reasoning model Codex" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Workspace: workspace" }),
  );
  await user.click(screen.getByRole("menuitemradio", { name: "research" }));
  fixture.items[0] = { ...fixture.items[0]!, revision: 4 };
  act(() => fixture.emit("agent_schedule"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This schedule changed",
  );
  expect(
    screen.getByRole("combobox", { name: "Reasoning model Default" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Workspace: research" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await openEditor();
  expect(
    screen.getByRole("combobox", { name: "Fast model Default" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Workspace: workspace" }),
  ).toBeEnabled();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  expect(rpc.resources.agent_schedule.patch.mutate).not.toHaveBeenCalled();
});
