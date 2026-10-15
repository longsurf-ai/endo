// Purpose: Render the corner card a CardView shows: a looping video above the explanation.
import { useReducedMotion } from "motion/react";
import { useId } from "react";

import { Button } from "@openchart/app/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@openchart/app/components/ui/card";

import type { CardContent, OnboardingViewProps } from "./views";
import "./corner-card.css";

/**
 * The corner card for the shown step: a looping video above the explanation,
 * its web links, and Next (Done on the last step), which calls `onDone`.
 * @example <CornerCard card={card} {...viewProps} />
 */
export function CornerCard({
  card,
  number,
  total,
  last,
  onDone,
}: { card: CardContent } & OnboardingViewProps) {
  const titleId = useId();
  const reduceMotion = useReducedMotion() ?? false;
  return (
    <Card
      role="dialog"
      aria-labelledby={titleId}
      className="onboarding-card fixed bottom-4 right-4 z-50 w-[22rem] gap-4 overflow-hidden pb-4 pt-0 animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-4 dark:bg-secondary"
    >
      <video
        src={card.video}
        className="aspect-square w-full bg-black"
        autoPlay={!reduceMotion}
        controls={reduceMotion}
        aria-hidden={!reduceMotion}
        loop
        muted
        playsInline
      />
      <CardHeader className="gap-1.5 px-4">
        {number !== undefined ? (
          <CardDescription className="text-xs">
            {number} of {total}
          </CardDescription>
        ) : null}
        <CardTitle id={titleId}>{card.title}</CardTitle>
        <CardDescription>{card.body}</CardDescription>
      </CardHeader>
      <CardFooter className="justify-end gap-2 px-4">
        {/* Desktop opens new windows in the browser. Links are the step's ask,
            so they take the primary style and Next steps back. */}
        {card.links?.map(({ label, url }) => (
          <Button key={url} size="sm" asChild>
            <a href={url} target="_blank" rel="noreferrer">
              {label}
            </a>
          </Button>
        ))}
        <Button
          size="sm"
          variant={card.links ? "outline" : "default"}
          onClick={onDone}
        >
          {last ? "Done" : "Next"}
        </Button>
      </CardFooter>
    </Card>
  );
}
