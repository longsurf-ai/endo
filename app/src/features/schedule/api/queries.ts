// Purpose: Read schedules/history, toggle enabled state, and request immediate admission.
import {
  infiniteQueryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import { resourceQueryKeys } from "@openchart/app/lib/resource/invalidation";
import type {
  AgentInputs,
  AppTransport,
  ResourceOutputs,
} from "@openchart/app/lib/transport/transport";

/** Canonical prompt input shared by schedule creation and editing. */
export type SchedulePrompt = AgentInputs["prompt"]["input"];

/** Fields consumed by the schedule list, derived from the public Resource API. */
export type Schedule = Pick<
  ResourceOutputs["agent_schedule"]["list"]["items"][number],
  | "id"
  | "revision"
  | "createdAt"
  | "name"
  | "enabled"
  | "recurrence"
  | "nextFireAt"
  | "target"
>;

/** Accepted scheduled run, including its backend-projected Session identity. */
export type ScheduleOccurrence = Awaited<
  ReturnType<
    AppTransport["rpc"]["resources"]["agent_schedule_occurrence"]["get"]["query"]
  >
>;

async function readSchedules(
  transport: AppTransport,
  cursor: string | undefined,
  signal: AbortSignal,
) {
  const page = await transport.rpc.resources.agent_schedule.list.query(
    { limit: 20, cursor },
    { signal },
  );
  const items: Schedule[] = [];
  for (const {
    id,
    revision,
    createdAt,
    name,
    enabled,
    recurrence,
    nextFireAt,
    target,
  } of page.items) {
    items.push({
      id,
      revision,
      createdAt,
      name,
      enabled,
      recurrence,
      nextFireAt,
      target,
    });
  }
  return { nextCursor: page.nextCursor, items };
}

/** Page schedules through the shared Resource cache and live invalidation. @example useInfiniteQuery(schedulesQueryOptions(transport)); */
export function schedulesQueryOptions(transport: AppTransport) {
  return infiniteQueryOptions({
    meta: { errorTitle: "Couldn’t load schedules" },
    queryKey: [["resources", "agent_schedule", "list"], transport.url] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      readSchedules(transport, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

/** Page one schedule's accepted runs; Query owns cancellation and cursors. @example useInfiniteQuery(scheduleOccurrencesQueryOptions(transport, schedule.id)); */
export function scheduleOccurrencesQueryOptions(
  transport: AppTransport,
  scheduleId: string,
) {
  return infiniteQueryOptions({
    meta: { errorTitle: "Couldn’t load runs" },
    queryKey: [
      ["resources", "agent_schedule_occurrence", "list"],
      transport.url,
      scheduleId,
    ] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      transport.rpc.resources.agent_schedule_occurrence.list.query(
        { filter: { scheduleId }, limit: 20, cursor: pageParam },
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

/** Toggle only enabled at the displayed revision; refresh even on conflict, with no automatic retry. @example const toggle = useToggleSchedule(transport); toggle.mutate(schedule); */
export function useToggleSchedule(transport: AppTransport) {
  const client = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn’t update this schedule" },
    mutationFn: async (schedule: Schedule) => {
      await transport.rpc.resources.agent_schedule.patch.mutate({
        id: schedule.id,
        expectedRevision: schedule.revision,
        operations: [
          { op: "replace", path: "/enabled", value: !schedule.enabled },
        ],
      });
    },
    retry: false,
    onSettled: () =>
      client.invalidateQueries({
        queryKey: resourceQueryKeys.resource("agent_schedule"),
      }),
  });
}

/** Delete a confirmed schedule, discard its cached history, and refresh the list without waiting for SSE. Failures retain the schedule and are never retried automatically. @example const remove = useDeleteSchedule(transport); remove.mutate(schedule.id); */
export function useDeleteSchedule(transport: AppTransport) {
  const client = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn’t delete this schedule" },
    mutationFn: (id: Schedule["id"]) =>
      transport.rpc.resources.agent_schedule.delete.mutate({ id }),
    retry: false,
    onSuccess: (_result, id) => {
      client.removeQueries({
        queryKey: scheduleOccurrencesQueryOptions(transport, id).queryKey,
        exact: true,
      });
      return client.invalidateQueries({
        queryKey: resourceQueryKeys.resource("agent_schedule"),
      });
    },
  });
}

/** Create a schedule or patch changed fields at its captured revision. Await prompt conversion while pending; preserve binding and backend lifecycle fields. Refresh after success or conflict without retrying. @example const save = useSaveSchedule(transport); save.mutate({ name, recurrence, prompt: editor.read() }); */
export function useSaveSchedule(transport: AppTransport) {
  const client = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn’t save this schedule" },
    mutationFn: async ({
      schedule,
      name,
      recurrence,
      prompt,
    }: {
      schedule?: Schedule;
      name: string;
      recurrence: Schedule["recurrence"];
      /** Undefined when the prompt editor has nothing to save. */
      prompt: Promise<SchedulePrompt | undefined>;
    }) => {
      const input = await prompt;
      if (!schedule) {
        if (!input) return;
        await transport.rpc.resources.agent_schedule.create.mutate({
          name,
          recurrence,
          target: { kind: "agent_prompt", prompt: input },
        });
        return;
      }
      const operations = [];
      if (name !== schedule.name)
        operations.push({ op: "replace" as const, path: "/name", value: name });
      if (JSON.stringify(recurrence) !== JSON.stringify(schedule.recurrence))
        operations.push({
          op: "replace" as const,
          path: "/recurrence",
          value: recurrence,
        });
      if (input) {
        const saved = schedule.target.prompt;
        if (JSON.stringify(input.parts) !== JSON.stringify(saved.parts))
          operations.push({
            op: "replace" as const,
            path: "/target/prompt/parts",
            value: input.parts,
          });
        if (JSON.stringify(input.model) !== JSON.stringify(saved.model))
          operations.push({
            op: "replace" as const,
            path: "/target/prompt/model",
            value: input.model,
          });
        if (
          input.workspaceId !== undefined &&
          input.workspaceId !== saved.workspaceId
        )
          // Add also replaces an existing object member and permits a previously omitted workspace.
          operations.push({
            op: "add" as const,
            path: "/target/prompt/workspaceId",
            value: input.workspaceId,
          });
      }
      const [first, ...rest] = operations;
      if (!first) return;
      await transport.rpc.resources.agent_schedule.patch.mutate({
        id: schedule.id,
        expectedRevision: schedule.revision,
        operations: [first, ...rest],
      });
    },
    retry: false,
    onSettled: () =>
      client.invalidateQueries({
        queryKey: resourceQueryKeys.resource("agent_schedule"),
      }),
  });
}

/** Admit one manual fire without changing the definition; refresh history after acceptance. No automatic retries. @example const run = useRunSchedule(transport); run.mutate(schedule.id); */
export function useRunSchedule(transport: AppTransport) {
  const client = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn’t run this schedule" },
    mutationFn: (id: Schedule["id"]) =>
      transport.rpc.scheduler.runNow.mutate({ id }),
    retry: false,
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: resourceQueryKeys.resource("agent_schedule_occurrence"),
      }),
  });
}
