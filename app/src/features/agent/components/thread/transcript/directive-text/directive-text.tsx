// The official badge markup is shared with the Lexical directive chip.
"use client";

import type { ComponentProps, FC } from "react";
import { Badge } from "@openchart/app/components/ui/badge";

type IconComponent = FC<{ className?: string }>;

export type DirectiveTextSegment =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "mention";
      readonly type: string;
      readonly label: string;
      readonly id: string;
    };

export type DirectiveTextFormatter = {
  /** Parse text into alternating text and directive segments. */
  parse(text: string): readonly DirectiveTextSegment[];
};

export type CreateDirectiveTextOptions = {
  /** Maps a directive `type` to an icon component. */
  iconMap?: Record<string, IconComponent>;
  /** Icon rendered when `iconMap` has no entry for the segment type. */
  fallbackIcon?: IconComponent;
};

/** Creates a directive renderer; text remains the persisted source of truth. @example const Text = createDirectiveText(formatter); */
export function createDirectiveText(
  formatter: DirectiveTextFormatter,
  options?: CreateDirectiveTextOptions,
): FC<{ text: string }> {
  const iconMap = options?.iconMap;
  const fallbackIcon = options?.fallbackIcon;

  const Component: FC<{ text: string }> = ({ text }) => {
    const segments = formatter.parse(text);

    if (segments.length === 1 && segments[0]!.kind === "text") {
      return <>{text}</>;
    }

    return (
      <>
        {segments.map((seg, i) => {
          if (seg.kind === "text") {
            return (
              <span key={i} className="whitespace-pre-wrap">
                {seg.text}
              </span>
            );
          }

          const Icon = iconMap?.[seg.type] ?? fallbackIcon;
          return (
            <DirectiveChip
              key={i}
              directiveType={seg.type}
              directiveId={seg.id}
              label={seg.label}
              icon={Icon}
            />
          );
        })}
      </>
    );
  };
  Component.displayName = "DirectiveText";
  return Component;
}

/** Official directive badge, also used through Lexical's directiveChip slot. @example <DirectiveChip directiveType="file" directiveId="/demo.tea" label="demo.tea" /> */
export function DirectiveChip({
  directiveType,
  directiveId,
  label,
  icon: Icon,
  render,
}: {
  directiveType: string;
  directiveId: string;
  label: string;
  icon?: IconComponent;
  render?: ComponentProps<typeof Badge>["render"];
}) {
  return (
    <Badge
      render={render}
      variant="secondary"
      data-slot="directive-text-chip"
      data-directive-type={directiveType}
      data-directive-id={directiveId}
      aria-label={`${directiveType}: ${label}`}
      title={directiveId}
      // eslint-disable-next-line tailwindcss/no-custom-classname -- Keep the directive chip hook without adding local style overrides.
      className="aui-directive-chip items-baseline px-1.5 py-0.5 text-[13px] leading-none [&_svg]:self-center"
    >
      {Icon && <Icon />}
      {label}
    </Badge>
  );
}
