// File icon mapping is the only OpenChart presentation configuration.
"use client";

import { memo } from "react";
import { FileTextIcon } from "lucide-react";
import type { DirectiveChipProps } from "@assistant-ui/react-lexical";
import type { TextMessagePartComponent } from "@assistant-ui/react";
import type { Unstable_DirectiveFormatter } from "@assistant-ui/react";
import { directiveFormatter } from "@openchart/app/lib/prompt-converter/directive-formatter";
import {
  DirectiveChip,
  createDirectiveText as createDirectiveTextBase,
  type CreateDirectiveTextOptions,
} from "./directive-text";

export type {
  CreateDirectiveTextOptions,
  DirectiveTextFormatter,
  DirectiveTextSegment,
} from "./directive-text";

/** Binds the official renderer to an assistant-ui Text part. @example const Text = createDirectiveText(formatter); */
export function createDirectiveText(
  formatter: Unstable_DirectiveFormatter,
  options?: CreateDirectiveTextOptions,
): TextMessagePartComponent {
  return createDirectiveTextBase(formatter, options);
}

/** `Text` message part component that renders directive syntax as inline chips. */
export const DirectiveText: TextMessagePartComponent = memo(
  createDirectiveTextBase(directiveFormatter, {
    iconMap: { file: FileTextIcon },
  }),
);

/** Use the same official badge and file icon while composing. @example <LexicalComposerInput directiveChip={FileDirectiveChip} /> */
export function FileDirectiveChip(props: DirectiveChipProps) {
  return <DirectiveChip {...props} icon={FileTextIcon} />;
}
