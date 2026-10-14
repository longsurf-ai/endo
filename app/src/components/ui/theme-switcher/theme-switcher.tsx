// Purpose: Render the controlled theme menu; its owner saves the preference.
import { ChevronsUpDown } from "lucide-react";

import { Button } from "@openchart/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@openchart/app/components/ui/dropdown";
import type { Theme } from "@openchart/app/lib/theme/theme";
import { cn } from "@openchart/app/utils/cn";

/** Select a theme without owning persistence or browser effects. @example <ThemeSwitcher theme={theme} onChange={saveTheme} /> */
export function ThemeSwitcher({
  theme,
  onChange,
  disabled,
}: {
  theme: Theme;
  onChange: (theme: Theme) => void;
  disabled?: boolean;
}) {
  const options = [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
    { value: "system", label: "System" },
  ] as const;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-between"
          aria-label="Theme"
          title="Edit theme"
          disabled={disabled}
        >
          {options.find((option) => option.value === theme)?.label ?? "System"}
          <ChevronsUpDown
            className="ml-2 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            className={cn(
              "my-0.5 cursor-pointer",
              theme === option.value && "bg-secondary-foreground/[0.08]",
            )}
            onSelect={() => onChange(option.value)}
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
