// Purpose: Compose shared controls for each sidebar directory heading.
import { MoreHorizontal, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@openchart/app/components/ui/dropdown";
import { SidebarGroupLabel } from "@openchart/app/components/ui/sidebar";
import { TooltipIconButton } from "@openchart/app/components/ui/tooltip-icon-button/tooltip-icon-button";
import {
  SidebarSort,
  useSidebarSort,
  type SidebarSection,
} from "@openchart/app/stores/sidebar";

/** Add uses the existing creation action; sorting only changes this directory's preference. @example <SectionHeader section="chats" label="Chats" createLabel="New chat" onCreate={newChat} /> */
export function SectionHeader({
  section,
  label,
  createLabel,
  onCreate,
}: {
  section: SidebarSection;
  label: string;
  createLabel: string;
  onCreate: () => void;
}) {
  const order = useSidebarSort((state) => state[section]);
  const setSort = useSidebarSort((state) => state.setSort);
  return (
    <div className="group/section-header flex items-center justify-between pr-2">
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-focus-within/section-header:opacity-100 group-hover/section-header:opacity-100 has-[[aria-expanded=true]]:opacity-100 [@media(hover:none)]:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TooltipIconButton
              tooltip={`Sort ${section}`}
              aria-label={`Sort ${section}`}
              className="text-muted-foreground"
            >
              <MoreHorizontal />
            </TooltipIconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={order}
              onValueChange={(value) =>
                setSort(section, SidebarSort.parse(value))
              }
            >
              <DropdownMenuRadioItem value="updatedAt">
                Last updated
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="createdAt">
                Last created
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <TooltipIconButton
          tooltip={createLabel}
          aria-label={createLabel}
          onClick={onCreate}
          className="text-muted-foreground"
        >
          <Plus />
        </TooltipIconButton>
      </div>
    </div>
  );
}
