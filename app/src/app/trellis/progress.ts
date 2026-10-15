// Purpose: Remember which onboarding workflow is running and which of its steps the user has seen.
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { onboardingWorkflows, type OnboardingWorkflowId } from "./workflows";

const isWorkflowId = (id: string): id is OnboardingWorkflowId =>
  Object.hasOwn(onboardingWorkflows, id);

const Progress = z.object({
  /** The running workflow; an ID this build doesn't know is dropped. */
  workflow: z
    .string()
    .optional()
    .transform((id) => (id !== undefined && isWorkflowId(id) ? id : undefined)),
  /** Indexes of the running workflow's steps the user has seen. */
  seen: z.array(z.number().int().nonnegative()).default([]),
  /** Workflows already offered on this device; completion never clears these. */
  started: z.array(z.string()).default([]),
});
type Progress = z.infer<typeof Progress>;

/**
 * Device-local onboarding progress. Desktop starts `starter` for a new
 * profile. Seeing every step ends the workflow. `startOnce` remembers an offer
 * across visits and restarts, and refuses offers while another workflow runs;
 * the composition owner retries while the relevant surface remains open.
 * Zustand owns browser persistence and subscribers own their subscriptions.
 * Invalid saved progress is ignored; older records default to no offer history.
 * @example const running = useOnboardingProgress((state) => state.workflow);
 */
export const useOnboardingProgress = create<
  Progress & {
    /** Records the running workflow's step at this index as seen. */
    see: (index: number) => void;
    /** Starts an unseen workflow only while idle; never interrupts another tour. */
    startOnce: (workflow: OnboardingWorkflowId) => void;
  }
>()(
  persist(
    (set) => ({
      ...Progress.parse({}),
      startOnce: (workflow) =>
        set((state) =>
          state.workflow || state.started.includes(workflow)
            ? {}
            : {
                workflow,
                seen: [],
                started: [...state.started, workflow],
              },
        ),
      see: (index) =>
        set(({ workflow, seen }) => {
          const steps = workflow ? onboardingWorkflows[workflow].steps : [];
          if (seen.includes(index) || index >= steps.length) return {};
          const next = [...seen, index];
          return next.length === steps.length
            ? { workflow: undefined, seen: [] }
            : { seen: next };
        }),
    }),
    {
      name: "local:onboarding",
      version: 2,
      partialize: ({ workflow, seen, started }) => ({
        workflow,
        seen,
        started,
      }),
      // Version 2 inserted the starter's two chart cards after its dashboard
      // step (index 2), so steps the user saw later keep their meaning.
      migrate: (saved, version) => {
        const parsed = Progress.safeParse(saved);
        if (!parsed.success) return Progress.parse({});
        const { workflow, seen } = parsed.data;
        return {
          ...parsed.data,
          workflow,
          seen:
            version < 2 && workflow === "starter"
              ? seen.map((index) => (index > 2 ? index + 2 : index))
              : seen,
        };
      },
      merge: (saved, current) => {
        const parsed = Progress.safeParse(saved);
        return parsed.success ? { ...current, ...parsed.data } : current;
      },
    },
  ),
);
