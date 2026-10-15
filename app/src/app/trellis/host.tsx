// Purpose: Run the onboarding workflow: show the view of the step this page belongs to, then run the next step's action.
import { Suspense, useLayoutEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router";

import type { AppTransport } from "@openchart/app/lib/transport/transport";

import { useOnboardingProgress } from "./progress";
import { onboardingWorkflows, type OnboardingWorkflow } from "./workflows";

/** What the running workflow shows on one page. */
function planWorkflow(
  workflow: OnboardingWorkflow | undefined,
  seen: readonly number[],
  pathname: string,
) {
  const steps = workflow?.steps ?? [];
  let total = 0;
  const unseen = steps
    .map((step, index) => ({
      step,
      index,
      number: step.countInProgress === false ? undefined : ++total,
    }))
    .filter(({ index }) => !seen.includes(index));
  const first = unseen[0];
  // An actionless first unseen step comes before any step this page explains.
  const current =
    first && first.step.action === undefined
      ? first
      : unseen.find(({ step }) => step.action?.leadsTo(pathname));
  return {
    current,
    next: unseen.find((entry) => entry !== current),
    total,
  };
}

/**
 * Runs the onboarding workflow. Arriving where a step's action leads shows its
 * view; the view's `onDone` marks it seen and runs the next unseen step's
 * action. Leaving the page also marks the shown step seen. Mount once inside
 * the router; renders nothing while nothing is running.
 * @example <OnboardingHost transport={transport} />
 */
export function OnboardingHost({ transport }: { transport: AppTransport }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { workflow: running, seen, see } = useOnboardingProgress();
  const workflow = running && onboardingWorkflows[running];
  const { current, next, total } = useMemo(
    () => planWorkflow(workflow, seen, pathname),
    [workflow, seen, pathname],
  );

  // StrictMode's repeated mount keeps the same path, so only real navigation
  // counts. Seeing before paint keeps an actionless view from flashing on the
  // next page.
  const shown = useRef({ pathname, workflow: running, index: current?.index });
  useLayoutEffect(() => {
    const previous = shown.current;
    shown.current = { pathname, workflow: running, index: current?.index };
    if (
      previous.workflow === running &&
      previous.pathname !== pathname &&
      previous.index !== undefined
    )
      see(previous.index);
  }, [pathname, running, current, see]);

  if (!current) return null;
  // Leaving a page marks its step seen; marking first would briefly show, and
  // then count, a view for the page being left.
  const done = () => {
    const action = next?.step.action;
    if (action && !action.leadsTo(pathname)) action.run(navigate);
    else see(current.index);
  };
  return (
    <Suspense key={`${running}:${current.index}`} fallback={null}>
      {current.step.view.render({
        transport,
        number: current.number,
        total,
        last: !next,
        onDone: done,
      })}
    </Suspense>
  );
}
