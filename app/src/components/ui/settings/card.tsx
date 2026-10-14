// Purpose: Settings cards and labelled control rows.
import type { ReactNode } from "react";

import { cn } from "@openchart/app/utils/cn";

type CardProps = {
  title?: string;
  children?: ReactNode;
  header?: ReactNode;
};
type CardItemProps = {
  /** Use a native list item when rows are grouped inside a list. */
  as?: "div" | "li";
  title?: ReactNode;
  description?: ReactNode;
  descriptionOutside?: ReactNode;
  align?: "start" | "center" | "end";
  actions?: ReactNode;
  column?: boolean;
  className?: string;
  classNameWrapperAction?: string;
  htmlFor?: string;
};

/** Settings row; actions and labels are supplied by the form owner. @example <CardItem title="Theme" actions={<ThemeSwitcher />} /> */
export function CardItem({
  as: Component = "div",
  title,
  description,
  descriptionOutside,
  className,
  classNameWrapperAction,
  align = "center",
  column,
  actions,
  htmlFor,
}: CardItemProps) {
  return (
    <>
      <Component
        className={cn(
          "mt-2 flex justify-between gap-8 border-b border-border/40 pb-3 first:mt-0 last:border-none last:pb-0",
          descriptionOutside && "border-0",
          align === "start" && "items-start",
          align === "center" && "items-center",
          align === "end" && "items-end",
          column && "flex-col items-start gap-y-0",
          className,
        )}
      >
        <div className="space-y-1.5">
          <h3 className="font-medium text-foreground">
            {htmlFor ? <label htmlFor={htmlFor}>{title}</label> : title}
          </h3>
          {description && (
            <span className="leading-normal text-muted-foreground">
              {description}
            </span>
          )}
        </div>
        {actions && (
          <div
            className={cn(
              "shrink-0",
              classNameWrapperAction,
              column && "w-full",
            )}
          >
            {actions}
          </div>
        )}
      </Component>
      {descriptionOutside && (
        <span className="leading-normal text-muted-foreground">
          {descriptionOutside}
        </span>
      )}
    </>
  );
}

/** Settings section; this component owns no form or configuration state. @example <Card title="Interface">{rows}</Card> */
export function Card({ title, children, header }: CardProps) {
  return (
    <div className="w-full rounded-lg bg-card p-4 text-muted-foreground">
      {title && (
        <h2 className="mb-4 font-studio text-base font-medium text-foreground">
          {title}
        </h2>
      )}
      {header && header}
      {children}
    </div>
  );
}
