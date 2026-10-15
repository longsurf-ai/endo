// Purpose: Define what an onboarding step does to bring the user to the thing it explains.
import type { NavigateFunction } from "react-router";

/**
 * What a step does to bring the user to the thing it explains. A workflow may
 * add its own action by extending this class.
 */
export abstract class OnboardingAction {
  /** Whether the user is already where this action brings them; its step's view shows there. */
  abstract leadsTo(pathname: string): boolean;
  /** Brings the user there; runs when Next on the step before opens this one. */
  abstract run(navigate: NavigateFunction): void;
}

/**
 * Opens an app route; the step's view shows there until dismissed or left.
 * @example new OpenRouteAction("/app/feed");
 */
export class OpenRouteAction extends OnboardingAction {
  constructor(readonly path: string) {
    super();
  }

  leadsTo(pathname: string) {
    return pathname === this.path;
  }

  run(navigate: NavigateFunction) {
    void navigate(this.path);
  }
}
