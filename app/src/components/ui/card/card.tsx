import * as React from "react";

import { cn } from "@openchart/app/utils/cn";

/** Shared Card surface; sections own their own horizontal padding. @example <Card><CardHeader /></Card> */
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

/** Shared Card header for the title and description. @example <CardHeader><CardTitle>Title</CardTitle></CardHeader> */
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 [&.border-b]:pb-6",
        className,
      )}
      {...props}
    />
  );
}

/** Shared Card title; pass an id to label the card. @example <CardTitle>Title</CardTitle> */
function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("font-semibold leading-none", className)}
      {...props}
    />
  );
}

/** Shared Card supporting text. @example <CardDescription>Details</CardDescription> */
function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

/** Shared Card action row. @example <CardFooter><Button>Done</Button></CardFooter> */
function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6 [&.border-t]:pt-6", className)}
      {...props}
    />
  );
}

export { Card, CardDescription, CardFooter, CardHeader, CardTitle };
