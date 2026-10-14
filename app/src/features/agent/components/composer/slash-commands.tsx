// Purpose: Insert a leading command chip using the backend catalog and assistant-ui primitives.
import {
  ComposerPrimitive,
  unstable_useSlashCommandAdapter,
  unstable_useTriggerPopoverScopeContext,
} from "@assistant-ui/react";
import type { DirectiveChipProps } from "@assistant-ui/react-lexical";
import { Minimize2Icon, WorkflowIcon, type LucideIcon } from "lucide-react";
import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { useAgentContext } from "@openchart/app/lib/agent/provider";
import type { Agent } from "@openchart/app/lib/agent/use-agent";
import { directiveFormatter } from "@openchart/app/lib/prompt-converter/directive-formatter";
import { FileDirectiveChip } from "@openchart/app/features/agent/components/thread/transcript/directive-text/directive-text.aui";
import { DirectiveChip } from "@openchart/app/features/agent/components/thread/transcript/directive-text/directive-text";
import {
  ComposerCommandItem,
  ComposerMenu,
} from "./composer-slash-commands.aui";

type Command = NonNullable<Agent["commands"]["data"]>[number];
const icons = {
  workflow: WorkflowIcon,
  compaction: Minimize2Icon,
} satisfies Record<Command["type"], LucideIcon>;

const matchLeadingCommand: NonNullable<
  ComponentProps<typeof ComposerPrimitive.Unstable_TriggerPopover>["matcher"]
> = (text, _char, cursor) => {
  const match = /^\/([^\s/]*)/.exec(text);
  if (!match || cursor < 1 || cursor > match[0].length) return null;
  return { query: match[1]!, offset: 0, endOffset: match[0].length };
};

/** Inserts a draft chip only; the converter builds Parts when Send is pressed. @example <SlashCommands /> */
export function SlashCommands() {
  const { agent } = useAgentContext();
  const commands = agent.commands;
  const slash = unstable_useSlashCommandAdapter({
    commands: (commands.data ?? []).map((command) => ({
      id: command.name,
      description: command.description,
      execute: () => {},
    })),
  });
  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="/"
      aria-label="Commands"
      matcher={matchLeadingCommand}
      adapter={slash.adapter}
      isLoading={commands.isPending}
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive
        formatter={directiveFormatter}
      />
      <CommandItems commands={commands} />
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}

/** Renders native command and file chips with their existing icons. @example <LexicalComposerInput directiveChip={ComposerDirectiveChip} /> */
export function ComposerDirectiveChip(props: DirectiveChipProps) {
  const { agent } = useAgentContext();
  if (props.directiveType !== "command")
    return <FileDirectiveChip {...props} />;
  const command = agent.commands.data?.find(
    (command) => command.name === props.directiveId,
  );
  return (
    <DirectiveChip
      {...props}
      icon={command ? icons[command.type] : undefined}
    />
  );
}

/** Height above the bottom-anchored menu that neither the window nor a clipping ancestor hides. */
function visibleHeightAbove(menu: HTMLElement, style: CSSStyleDeclaration) {
  let top = 0;
  for (let node = menu.parentElement; node; node = node.parentElement) {
    const nodeStyle = getComputedStyle(node);
    if (/auto|scroll|hidden|clip/.test(nodeStyle.overflowY))
      top = Math.max(top, node.getBoundingClientRect().top + node.clientTop);
    // Ancestors outside a fixed box, such as a portaled dialog, do not clip it.
    if (nodeStyle.position === "fixed") break;
  }
  // Mirror the gap below the menu so it never touches the clipping edge.
  return Math.max(
    0,
    menu.getBoundingClientRect().bottom - top - parseFloat(style.marginBottom),
  );
}

function CommandItems({ commands }: { commands: Agent["commands"] }) {
  const { items, highlightedIndex, isLoading } =
    unstable_useTriggerPopoverScopeContext();
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    menu.scrollTop = 0;
    const rows = Array.from(
      menu.querySelectorAll<HTMLElement>('[role="option"]'),
    ).slice(0, 5);
    const lastRow = rows[4];

    // Keep the existing, potentially wrapped row heights; only cap the viewport
    // at five rows and at the space a host such as a dialog leaves visible.
    const measure = () => {
      const style = getComputedStyle(menu);
      const fiveRows = lastRow
        ? lastRow.offsetTop +
          lastRow.offsetHeight +
          parseFloat(style.paddingBottom) +
          parseFloat(style.borderTopWidth) +
          parseFloat(style.borderBottomWidth)
        : Infinity;
      menu.style.maxHeight = `${Math.min(fiveRows, visibleHeightAbove(menu, style))}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    rows.forEach((row) => observer.observe(row));
    if (menu.offsetParent) observer.observe(menu.offsetParent);
    return () => observer.disconnect();
  }, [items]);

  useLayoutEffect(() => {
    // Native Electron scrolling stays inside the menu, without moving the thread.
    const options = { block: "nearest", container: "nearest" } as const;
    menuRef.current
      ?.querySelector<HTMLElement>("[data-highlighted]")
      ?.scrollIntoView(options);
  }, [highlightedIndex, items]);

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverItems asChild>
      {(items) => (
        <ComposerMenu
          ref={menuRef}
          open
          className="overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
        >
          {items.map((item, index) => {
            const command = commands.data?.find(
              (command) => command.name === item.id,
            );
            return command ? (
              <ComposerPrimitive.Unstable_TriggerPopoverItem
                key={item.id}
                item={item}
                index={index}
                onMouseDown={(event) => event.preventDefault()}
                asChild
              >
                <ComposerCommandItem
                  command={{ ...command, icon: icons[command.type] }}
                  active={highlightedIndex === index}
                />
              </ComposerPrimitive.Unstable_TriggerPopoverItem>
            ) : null;
          })}
          {commands.isError ? (
            <p className="px-2.5 py-2 text-xs text-muted-foreground">
              <button
                type="button"
                className="underline"
                onClick={() => void commands.refetch()}
              >
                Retry
              </button>
            </p>
          ) : items.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-muted-foreground">
              {isLoading ? "Loading commands…" : "No matching commands."}
            </p>
          ) : null}
        </ComposerMenu>
      )}
    </ComposerPrimitive.Unstable_TriggerPopoverItems>
  );
}
