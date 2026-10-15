// Purpose: Define the onboarding workflow shape and register every workflow; the runtime knows none by name.
import type { OnboardingAction } from "./actions";
import type { OnboardingView } from "./views";
import { starterWorkflow } from "./workflows/starter/workflow";

/** One step: what brings the user to the thing it explains, and what it shows there. */
export type OnboardingStep = {
  /**
   * Runs when Next on the step before opens this one. Without one, the view
   * shows on whatever page the user is on once it is the first unseen step.
   */
  readonly action?: OnboardingAction;
  readonly view: OnboardingView;
  /** Defaults to true. False hides the counter and excludes this step from its numbering and total. */
  readonly countInProgress?: boolean;
};

/** Next opens the next unseen step in this order; routed steps also work in any order. */
export type OnboardingWorkflow = { readonly steps: readonly OnboardingStep[] };

/**
 * Every workflow this build can run, by the ID saved in onboarding progress.
 * Each lives in its own `workflows/<id>/` directory with its media.
 * @example onboardingWorkflows.starter.steps[0].view;
 */
export const onboardingWorkflows = {
  starter: starterWorkflow,
} satisfies Record<string, OnboardingWorkflow>;

/** A workflow this build can run. */
export type OnboardingWorkflowId = keyof typeof onboardingWorkflows;
