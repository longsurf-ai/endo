// Purpose: Define what an onboarding step shows the user: a corner card or a full-window page.
import { lazy, type ComponentType, type ReactNode } from "react";

import type { AppTransport } from "@openchart/app/lib/transport/transport";

/** What the host gives the view of the step it shows. */
export type OnboardingViewProps = {
  readonly transport: AppTransport;
  /** The step's 1-based counted position, or undefined when excluded from progress. */
  readonly number: number | undefined;
  /** How many steps participate in the displayed progress. */
  readonly total: number;
  /** Whether no unseen step follows this one. */
  readonly last: boolean;
  /** Marks the step seen and runs the next unseen step's action. */
  readonly onDone: () => void;
};

/**
 * What a step shows the user. A workflow may add its own view by extending
 * this class. Views load their UI lazily, so workflows stay data that Desktop's
 * content test can read without it.
 */
export abstract class OnboardingView {
  /**
   * Renders the view while its step is shown. The host remounts it for each
   * step inside a Suspense boundary.
   */
  abstract render(props: OnboardingViewProps): ReactNode;
}

/** What a corner card shows. */
export type CardContent = {
  readonly title: string;
  readonly body: string;
  /** Square, looping, muted demonstration shown above the text. */
  readonly video: string;
  /** Web pages offered beside Next; they open in the browser and leave the card up. */
  readonly links?: readonly { readonly label: string; readonly url: string }[];
};

const CornerCard = lazy(() =>
  import("./corner-card").then((module) => ({ default: module.CornerCard })),
);

/**
 * A corner card explaining the page under it.
 * @example new CardView({ title: "Alerts", body: "…", video: alertVideo });
 */
export class CardView extends OnboardingView {
  constructor(readonly card: CardContent) {
    super();
  }

  render(props: OnboardingViewProps) {
    return <CornerCard card={this.card} {...props} />;
  }
}

/** What a full-window page gets from the host. */
export type OnboardingPageProps = Pick<
  OnboardingViewProps,
  "transport" | "onDone"
>;

/**
 * A full-window page; pass a lazy component to keep its UI out of the workflow.
 * @example new PageView(lazy(() => import("./intro-page")));
 */
export class PageView extends OnboardingView {
  constructor(readonly page: ComponentType<OnboardingPageProps>) {
    super();
  }

  render({ transport, onDone }: OnboardingViewProps) {
    const Page = this.page;
    return <Page transport={transport} onDone={onDone} />;
  }
}
