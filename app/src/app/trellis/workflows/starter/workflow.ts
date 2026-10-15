// Purpose: Connect a new profile's agent using OpenChart's first-launch page.
import { lazy } from "react";

import { PageView } from "@openchart/app/app/trellis/views";
import type { OnboardingWorkflow } from "@openchart/app/app/trellis/workflows";

/**
 * The first-launch workflow connects Claude Code, Codex or Antigravity through
 * the existing provider setup. Continuing or skipping finishes onboarding.
 * Desktop queues it only before a new profile's database is created.
 * @example starterWorkflow.steps[0].view;
 */
export const starterWorkflow = {
  steps: [
    {
      countInProgress: false,
      view: new PageView(
        lazy(() =>
          import("./connect-agents-page").then((module) => ({
            default: module.ConnectAgentsPage,
          })),
        ),
      ),
    },
  ],
} satisfies OnboardingWorkflow;
