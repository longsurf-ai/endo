// Purpose: Context Menu primitives with the application's shared menu styles.
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { cn } from "@openchart/app/utils/cn";
import { menuContentClassName, menuItemClassName } from "./menu-styles";

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

/** Positions a portalled context menu at the trigger's pointer. @example <ContextMenuContent><ContextMenuItem>Create file</ContextMenuItem></ContextMenuContent> */
export function ContextMenuContent({
  className,
  ...props
}: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align="start"
        alignOffset={4}
        side="right"
        sideOffset={0}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            menuContentClassName,
            "max-h-[var(--available-height)] origin-[var(--transform-origin)] outline-none",
            className,
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

/** Keyboard and pointer menu action; selection closes the menu by default. @example <ContextMenuItem onClick={create}>Create file</ContextMenuItem> */
export function ContextMenuItem({
  className,
  ...props
}: ContextMenuPrimitive.Item.Props) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      className={cn(
        menuItemClassName,
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}
