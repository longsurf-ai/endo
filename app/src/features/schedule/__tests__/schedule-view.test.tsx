import { renderWithToaster as render } from "@openchart/app/testing/test-utils";
import { findErrorToast } from "@openchart/app/testing/test-utils";
import { createQueryClient } from "@openchart/app/lib/react-query/react-query";
// Purpose: Exercise schedule pagination, lazy history, live refresh and revision-safe toggles.
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
import type {
  Schedule,
  ScheduleOccurrence,
} from "@openchart/app/features/schedule/api/queries";
import { subscribeResourceInvalidation } from "@openchart/app/lib/resource/invalidation";
import type { PromptParts } from "@openchart/app/lib/prompt-converter/converter";
import {
  createTransport,
  type AppEventFrame,
} from "@openchart/app/lib/transport/transport";

const rpc = vi.hoisted(() => ({
  events: { subscribe: { subscribe: vi.fn() } },
  scheduler: { runNow: { mutate: vi.fn() } },
  resources: {
    agent_schedule: {
      list: { query: vi.fn() },
      patch: { mutate: vi.fn() },
      delete: { mutate: vi.fn() },
    },
    agent_schedule_occurrence: { list: { query: vi.fn() } },
  },
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

function schedule(id = "daily"): Schedule {
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

function occurrence(id: string, scheduleId = "ags_daily"): ScheduleOccurrence {
  return {
    id: `aso_${id}` as ScheduleOccurrence["id"],
    scheduleId,
    agentRunId: `run_${id}`,
    sessionId: `ses_${id}` as ScheduleOccurrence["sessionId"],
    fireAt: Date.parse("2026-09-18T13:00:00.000Z"),
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function setup(
  items: Schedule[] = [schedule()],
  nextCursor: string | null = null,
  view: "list" | "calendar" = "list",
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
  const transport = createTransport({ origin: "http://schedule.test" });
  const subscription = subscribeResourceInvalidation(transport, queryClient);
  disposals.push(() => subscription.unsubscribe());
  const onOpenSession = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <ScheduleView
        transport={transport}
        renderHeader={(createAction) => (
          <header>
            <h1>Schedule</h1>
            {createAction}
          </header>
        )}
        view={view}
        onOpenSession={onOpenSession}
        renderPromptEditor={({ prompt, children }) =>
          children({
            content: <span>Prompt preview</span>,
            changed: false,
            ready: true,
            read: async () => ({
              ...prompt!,
              parts: prompt!.parts as PromptParts,
            }),
          })
        }
      />
    </QueryClientProvider>,
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

test("reads history only when expanded, follows its cursor and opens the occurrence's Session", async () => {
  const fixture = setup();
  const user = userEvent.setup();
  const trigger = await screen.findByRole("button", {
    name: "Morning briefing",
  });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.getByText("At 9:00 AM, Monday through Friday (Eastern Time)"),
  ).toBeVisible();
  expect(
    rpc.resources.agent_schedule_occurrence.list.query,
  ).not.toHaveBeenCalled();
  rpc.resources.agent_schedule_occurrence.list.query
    .mockResolvedValueOnce({
      items: [occurrence("first")],
      nextCursor: "history-next",
    })
    .mockResolvedValueOnce({ items: [occurrence("second")], nextCursor: null });
  await user.click(trigger);
  const history = await screen.findByRole("list", {
    name: "Runs for Morning briefing",
  });
  await user.click(
    await screen.findByRole("button", {
      name: "Show more runs for Morning briefing",
    }),
  );
  await waitFor(() =>
    expect(within(history).getAllByRole("button")).toHaveLength(2),
  );
  expect(
    rpc.resources.agent_schedule_occurrence.list.query,
  ).toHaveBeenLastCalledWith(
    { filter: { scheduleId: "ags_daily" }, limit: 20, cursor: "history-next" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  await user.click(within(history).getAllByRole("button")[1]!);
  expect(fixture.onOpenSession).toHaveBeenCalledWith("ses_second");
  expect(rpc.resources.agent_schedule.patch.mutate).not.toHaveBeenCalled();
  await user.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("toggles only enabled, waits for the server, and refreshes the revision before retrying a conflict", async () => {
  const fixture = setup();
  const user = userEvent.setup();
  let rejectPatch: (error: Error) => void = () => {};
  rpc.resources.agent_schedule.patch.mutate.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectPatch = reject;
      }),
  );
  const toggle = await screen.findByRole("switch", {
    name: "Enable Morning briefing",
  });
  expect(toggle).toBeChecked();
  await user.click(toggle);
  expect(toggle).toBeDisabled();
  expect(toggle).toHaveAttribute("aria-busy", "true");
  expect(toggle).toBeChecked();
  expect(
    screen.getByRole("button", { name: "Morning briefing" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(rpc.resources.agent_schedule.patch.mutate).toHaveBeenCalledWith({
    id: "ags_daily",
    expectedRevision: 3,
    operations: [{ op: "replace", path: "/enabled", value: false }],
  });
  fixture.items[0] = { ...fixture.items[0]!, revision: 4 };
  await act(async () => rejectPatch(new Error("Revision conflict")));
  expect(await findErrorToast("Revision conflict")).toHaveTextContent(
    "Revision conflict",
  );
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).toBeChecked();
  rpc.resources.agent_schedule.patch.mutate.mockImplementation(
    async ({ operations }) => {
      fixture.items[0] = {
        ...fixture.items[0]!,
        revision: fixture.items[0]!.revision + 1,
        enabled: operations[0].value,
      };
      return fixture.items[0];
    },
  );
  await user.click(toggle);
  expect(rpc.resources.agent_schedule.patch.mutate).toHaveBeenLastCalledWith({
    id: "ags_daily",
    expectedRevision: 4,
    operations: [{ op: "replace", path: "/enabled", value: false }],
  });
  await waitFor(() => expect(toggle).not.toBeChecked());
  await waitFor(() => expect(toggle).toBeEnabled());
  await user.click(toggle);
  expect(rpc.resources.agent_schedule.patch.mutate).toHaveBeenLastCalledWith({
    id: "ags_daily",
    expectedRevision: 5,
    operations: [{ op: "replace", path: "/enabled", value: true }],
  });
  await waitFor(() => expect(toggle).toBeChecked());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test.each([
  ["0 8 * * *", "At 8:00 AM, every day"],
  ["*/15 * * * *", "Every 15 minutes, every hour, every day"],
  ["0 8 1 * MON", "At 8:00 AM, on day 1 of the month, and on Monday"],
  ["0 8 * * 7", "At 8:00 AM, only on Sunday"],
])(
  "describes cron %s in its authored time zone",
  async (expression, description) => {
    setup([
      {
        ...schedule(),
        recurrence: {
          kind: "cron",
          expression,
          timeZone: "America/Los_Angeles",
        },
      },
    ]);
    expect(
      await screen.findByText(`${description} (Pacific Time)`),
    ).toBeVisible();
    expect(
      screen.queryByText(/Cron ·|America\/Los_Angeles/),
    ).not.toBeInTheDocument();
  },
);

test("refreshes Agent-created schedules and new occurrences through existing Resource events", async () => {
  const fixture = setup([]);
  const user = userEvent.setup();
  const header = screen.getByRole("banner");
  const create = within(header).getByRole("button", {
    name: "Create schedule",
  });
  expect(create).toBeVisible();
  await screen.findByText("Run a prompt on a schedule.");
  expect(screen.getByRole("button", { name: "Create schedule" })).toBe(create);
  expect(
    screen.queryByRole("button", { name: /delete|edit/i }),
  ).not.toBeInTheDocument();
  fixture.items.push(schedule());
  act(() => fixture.emit("agent_schedule"));
  await user.click(
    await screen.findByRole("button", { name: "Morning briefing" }),
  );
  expect(within(header).getByRole("button", { name: "Create schedule" })).toBe(
    create,
  );
  await screen.findByText("No runs yet.");
  rpc.resources.agent_schedule_occurrence.list.query.mockResolvedValue({
    items: [occurrence("new")],
    nextCursor: null,
  });
  act(() => fixture.emit("agent_schedule_occurrence"));
  await within(
    screen.getByRole("list", { name: "Runs for Morning briefing" }),
  ).findByRole("button");
  expect(rpc.resources.agent_schedule.patch.mutate).not.toHaveBeenCalled();
});

test("runs a disabled schedule once, refreshes history, and opens its accepted transcript", async () => {
  const fixture = setup([{ ...schedule(), enabled: false }]);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Morning briefing" }),
  );
  await screen.findByText("No runs yet.");
  let accept: (value: ScheduleOccurrence) => void = () => {};
  rpc.scheduler.runNow.mutate.mockImplementationOnce(
    () =>
      new Promise<ScheduleOccurrence>((resolve) => {
        accept = resolve;
      }),
  );
  const play = screen.getByRole("button", { name: "Run Morning briefing now" });
  await user.click(play);
  expect(play).toBeDisabled();
  await user.click(play);
  expect(rpc.scheduler.runNow.mutate).toHaveBeenCalledExactlyOnceWith({
    id: "ags_daily",
  });
  expect(fixture.onOpenSession).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Morning briefing" }),
  ).toHaveAttribute("aria-expanded", "true");
  const accepted = occurrence("manual");
  rpc.resources.agent_schedule_occurrence.list.query.mockResolvedValue({
    items: [accepted],
    nextCursor: null,
  });
  await act(async () => accept(accepted));
  await waitFor(() =>
    expect(fixture.onOpenSession).toHaveBeenCalledWith("ses_manual"),
  );
  expect(
    await within(
      screen.getByRole("list", { name: "Runs for Morning briefing" }),
    ).findByRole("button"),
  ).toBeVisible();
  expect(
    screen.getByRole("switch", { name: "Enable Morning briefing" }),
  ).not.toBeChecked();
  expect(rpc.resources.agent_schedule.patch.mutate).not.toHaveBeenCalled();
});

test("reports manual admission failure without retrying or opening a transcript", async () => {
  const fixture = setup();
  const user = userEvent.setup();
  rpc.scheduler.runNow.mutate.mockRejectedValue(new Error("Offline"));
  const play = await screen.findByRole("button", {
    name: "Run Morning briefing now",
  });
  await user.click(play);
  expect(await findErrorToast()).toHaveTextContent(
    /Couldn’t run this schedule\s*Offline/,
  );
  expect(play).toBeEnabled();
  expect(rpc.scheduler.runNow.mutate).toHaveBeenCalledTimes(1);
  expect(fixture.onOpenSession).not.toHaveBeenCalled();
  expect(rpc.resources.agent_schedule.patch.mutate).not.toHaveBeenCalled();
});

test("keeps loaded schedules on page failure and retries the same cursor", async () => {
  setup([schedule()], "schedules-next");
  const user = userEvent.setup();
  rpc.resources.agent_schedule.list.query
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce({ items: [schedule("weekly")], nextCursor: null });
  await screen.findByRole("button", { name: "Morning briefing" });
  await user.click(screen.getByRole("button", { name: "Show more schedules" }));
  expect(await findErrorToast("Couldn’t load schedules")).toHaveTextContent(
    "Couldn’t load schedules",
  );
  expect(
    screen.getByRole("button", { name: "Morning briefing" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Show more schedules" }));
  await screen.findByRole("button", { name: "Weekly review" });
  expect(rpc.resources.agent_schedule.list.query).toHaveBeenLastCalledWith(
    { limit: 20, cursor: "schedules-next" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(
    screen.queryByRole("button", { name: "Show more schedules" }),
  ).not.toBeInTheDocument();
});

test("shows occurrence read failures and permits retry without changing the schedule", async () => {
  setup();
  const user = userEvent.setup();
  rpc.resources.agent_schedule_occurrence.list.query.mockRejectedValueOnce(
    new Error("Offline"),
  );
  await user.click(
    await screen.findByRole("button", { name: "Morning briefing" }),
  );
  expect(await findErrorToast("Couldn’t load runs")).toHaveTextContent(
    "Couldn’t load runs",
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("No runs yet.");
  expect(rpc.resources.agent_schedule.patch.mutate).not.toHaveBeenCalled();
});

test("opens deletion before edit and allows cancellation without deleting or expanding history", async () => {
  setup();
  const user = userEvent.setup();
  const remove = await screen.findByRole("button", {
    name: "Delete Morning briefing",
  });
  expect(
    remove.compareDocumentPosition(
      screen.getByRole("button", { name: "Edit Morning briefing" }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await user.click(remove);
  const dialog = screen.getByRole("dialog", { name: "Delete schedule" });
  expect(within(dialog).getByText(/Delete “Morning briefing”/)).toBeVisible();
  expect(rpc.resources.agent_schedule.delete.mutate).not.toHaveBeenCalled();
  expect(
    rpc.resources.agent_schedule_occurrence.list.query,
  ).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(remove).toBeVisible();
  expect(rpc.resources.agent_schedule.delete.mutate).not.toHaveBeenCalled();
});

test("deletes only after confirmation, prevents duplicate requests, and refreshes the empty list", async () => {
  const fixture = setup();
  const user = userEvent.setup();
  let resolveDelete: () => void = () => {};
  rpc.resources.agent_schedule.delete.mutate.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Delete Morning briefing" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Delete schedule" });
  await user.click(
    within(dialog).getByRole("button", { name: "Delete schedule" }),
  );
  const deleting = within(dialog).getByRole("button", { name: /Deleting…/ });
  expect(deleting).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  await user.click(deleting);
  await user.keyboard("{Escape}");
  expect(dialog).toBeVisible();
  expect(
    rpc.resources.agent_schedule.delete.mutate,
  ).toHaveBeenCalledExactlyOnceWith({ id: "ags_daily" });
  fixture.items.splice(0);
  await act(async () => resolveDelete());
  expect(await screen.findByText("No schedules yet")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(fixture.onOpenSession).not.toHaveBeenCalled();
  expect(rpc.resources.agent_schedule.patch.mutate).not.toHaveBeenCalled();
  expect(rpc.scheduler.runNow.mutate).not.toHaveBeenCalled();
});

test("keeps a failed deletion open without automatic retries and permits retry", async () => {
  const fixture = setup();
  const user = userEvent.setup();
  rpc.resources.agent_schedule.delete.mutate.mockRejectedValueOnce(
    new Error("Offline"),
  );
  await user.click(
    await screen.findByRole("button", { name: "Delete Morning briefing" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Delete schedule" });
  const confirm = within(dialog).getByRole("button", {
    name: "Delete schedule",
  });
  await user.click(confirm);
  expect(await findErrorToast()).toHaveTextContent(
    /Couldn’t delete this schedule\s*Offline/,
  );
  expect(confirm).toBeEnabled();
  expect(rpc.resources.agent_schedule.delete.mutate).toHaveBeenCalledTimes(1);
  expect(fixture.items).toHaveLength(1);
  rpc.resources.agent_schedule.delete.mutate.mockImplementationOnce(
    async () => {
      fixture.items.splice(0);
    },
  );
  await user.click(confirm);
  expect(await screen.findByText("No schedules yet")).toBeVisible();
  expect(rpc.resources.agent_schedule.delete.mutate).toHaveBeenCalledTimes(2);
});

test("projects enabled schedules onto the calendar and opens the shared editor from an event", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T12:00:00"));
  setup(
    [schedule(), { ...schedule("weekly"), enabled: false }],
    null,
    "calendar",
  );
  const user = userEvent.setup();
  // The visible week holds five weekday fires; a disabled schedule projects nothing.
  expect(await screen.findAllByText("Morning briefing")).toHaveLength(5);
  expect(screen.queryByText("Weekly review")).not.toBeInTheDocument();
  await user.click(screen.getAllByText("Morning briefing")[0]!);
  const dialog = screen.getByRole("dialog", { name: "Edit schedule" });
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Morning briefing");
  expect(
    within(dialog).getByRole("combobox", { name: "Repeat" }),
  ).toHaveTextContent("Weekdays");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    within(screen.getByRole("banner")).getByRole("button", {
      name: "Create schedule",
    }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Create schedule" }));
  expect(screen.getByRole("dialog", { name: "Create schedule" })).toBeVisible();
  expect(rpc.resources.agent_schedule.patch.mutate).not.toHaveBeenCalled();
});

test("edits the name without writing prompt, lifecycle or cursor, and prevents duplicate saves", async () => {
  const fixture = setup();
  const user = userEvent.setup();
  const edit = await screen.findByRole("button", {
    name: "Edit Morning briefing",
  });
  const play = screen.getByRole("button", { name: "Run Morning briefing now" });
  expect(
    edit.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await user.click(edit);
  const dialog = screen.getByRole("dialog", { name: "Edit schedule" });
  expect(within(dialog).getByText("Prompt preview")).toBeVisible();
  expect(
    within(dialog).getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await user.clear(within(dialog).getByLabelText("Name"));
  await user.type(within(dialog).getByLabelText("Name"), "Opening briefing");
  let resolveSave: () => void = () => {};
  rpc.resources.agent_schedule.patch.mutate.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Save changes" }),
  );
  expect(
    rpc.resources.agent_schedule.patch.mutate,
  ).toHaveBeenCalledExactlyOnceWith({
    id: "ags_daily",
    expectedRevision: 3,
    operations: [{ op: "replace", path: "/name", value: "Opening briefing" }],
  });
  expect(
    within(dialog).getByRole("button", { name: /Saving…/ }),
  ).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(dialog).toBeVisible();
  fixture.items[0] = { ...schedule(), name: "Opening briefing", revision: 4 };
  await act(async () => resolveSave());
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(
    await screen.findByRole("button", { name: "Opening briefing" }),
  ).toBeVisible();
  expect(rpc.scheduler.runNow.mutate).not.toHaveBeenCalled();
});

test("edits weekly timing with exact minutes, weekday and authored time zone", async () => {
  setup();
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Edit Morning briefing" }),
  );
  await user.click(screen.getByRole("combobox", { name: "Repeat" }));
  await user.click(screen.getByRole("option", { name: "Weekly" }));
  await user.click(screen.getByRole("radio", { name: "Thursday" }));
  fireEvent.change(screen.getByLabelText("Time", { exact: true }), {
    target: { value: "18:17" },
  });
  await user.click(screen.getByRole("combobox", { name: "Time zone" }));
  await user.type(
    screen.getByRole("combobox", { name: "Search time zone" }),
    "Tokyo",
  );
  await user.click(screen.getByRole("option", { name: "Asia/Tokyo" }));
  await user.click(screen.getByRole("button", { name: "Save changes" }));
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
          expression: "17 18 * * 4",
          timeZone: "Asia/Tokyo",
        },
      },
    ],
  });
});

test.each([
  {
    kind: "cron" as const,
    expression: "*/7 9-16 1,15 JAN,MAR MON-FRI",
    timeZone: "Asia/Kathmandu",
  },
  { kind: "cron" as const, expression: "17 9 * * 7", timeZone: "US/Eastern" },
  { kind: "once" as const, fireAt: "2020-01-01T12:34:56.789Z" },
])("preserves the exact recurrence on rename: %j", async (recurrence) => {
  setup([{ ...schedule(), recurrence }]);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Edit Morning briefing" }),
  );
  await user.type(screen.getByLabelText("Name"), " renamed");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(
    rpc.resources.agent_schedule.patch.mutate,
  ).toHaveBeenCalledExactlyOnceWith({
    id: "ags_daily",
    expectedRevision: 3,
    operations: [
      { op: "replace", path: "/name", value: "Morning briefing renamed" },
    ],
  });
});

test("validates a changed one-time date and submits the local time as UTC", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T12:00:00"));
  setup();
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Edit Morning briefing" }),
  );
  await user.click(screen.getByRole("combobox", { name: "Repeat" }));
  await user.click(screen.getByRole("option", { name: "Once" }));
  await user.click(screen.getByRole("button", { name: "Date" }));
  await user.click(
    await screen.findByRole("button", { name: /Thursday, January 1st, 2026/ }),
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Choose a future date and time.",
  );
  expect(rpc.resources.agent_schedule.patch.mutate).not.toHaveBeenCalled();
  // Clearing time must not invalidate the independently selected calendar date.
  fireEvent.change(screen.getByLabelText("Time", { exact: true }), {
    target: { value: "" },
  });
  await user.click(screen.getByRole("button", { name: "Date" }));
  await user.click(
    screen.getByRole("button", { name: /Friday, January 2nd, 2026/ }),
  );
  fireEvent.change(screen.getByLabelText("Time", { exact: true }), {
    target: { value: "12:17" },
  });
  await user.click(screen.getByRole("button", { name: "Save changes" }));
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
          kind: "once",
          fireAt: new Date("2026-01-02T12:17").toISOString(),
        },
      },
    ],
  });
});

test("keeps a failed draft, avoids automatic retries, and discards it on cancel", async () => {
  setup();
  rpc.resources.agent_schedule.patch.mutate.mockRejectedValueOnce(
    new Error("Invalid cron expression"),
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Edit Morning briefing" }),
  );
  await user.click(screen.getByRole("combobox", { name: "Repeat" }));
  await user.click(screen.getByRole("option", { name: "Custom" }));
  await user.clear(screen.getByLabelText("Cron expression"));
  await user.type(screen.getByLabelText("Cron expression"), "invalid");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await findErrorToast("Invalid cron expression")).toHaveTextContent(
    "Invalid cron expression",
  );
  expect(screen.getByLabelText("Cron expression")).toHaveValue("invalid");
  expect(rpc.resources.agent_schedule.patch.mutate).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(
    screen.getByRole("button", { name: "Edit Morning briefing" }),
  );
  expect(screen.getByRole("combobox", { name: "Repeat" })).toHaveTextContent(
    "Weekdays",
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("preserves the open draft when the Agent changes the schedule and requires reopening before saving", async () => {
  const fixture = setup();
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Edit Morning briefing" }),
  );
  await user.type(screen.getByLabelText("Name"), " local edit");
  fixture.items[0] = { ...schedule(), name: "Agent revision", revision: 4 };
  act(() => fixture.emit("agent_schedule"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This schedule changed",
  );
  expect(screen.getByLabelText("Name")).toHaveValue(
    "Morning briefing local edit",
  );
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  expect(rpc.resources.agent_schedule.patch.mutate).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Edit Agent revision" }));
  expect(screen.getByLabelText("Name")).toHaveValue("Agent revision");
});
