// Purpose: Settings dropdown for finite choices.
import { ChevronsUpDown } from "lucide-react";

import { Button } from "@openchart/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@openchart/app/components/ui/dropdown";
import { cn } from "@openchart/app/utils/cn";

type DropdownControlProps = {
  value: string;
  selectedLabel?: string;
  options: Array<{ value: number | string; name: string }>;
  onChange: (value: number | string) => void;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
};

/** Finite-choice control; a single choice is displayed as text. @example <DropdownControl value={model} options={options} onChange={selectModel} /> */
export function DropdownControl({
  value,
  selectedLabel,
  options,
  onChange,
  disabled,
  id,
  "aria-label": label,
}: DropdownControlProps) {
  const isSelected =
    selectedLabel ??
    (options.find((option) => option.value === value)?.name || value);
  if (options.length <= 1)
    return (
      <div
        id={id}
        aria-label={label}
        className="max-w-full truncate px-3 py-1.5 text-sm text-muted-foreground"
        title={String(isSelected)}
      >
        {isSelected}
      </div>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          id={id}
          aria-label={label}
          disabled={disabled}
          variant="outline"
          size="sm"
          className="w-full justify-between"
          title={isSelected}
        >
          <span className="line-clamp-1 max-w-[10.5rem]">{isSelected}</span>
          <ChevronsUpDown
            className="ml-2 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[17.5rem]">
        {options.map((option, optionIndex) => (
          <DropdownMenuItem
            key={optionIndex}
            onSelect={() => onChange(option.value)}
            className={cn(
              "my-1 flex items-center justify-between",
              isSelected === option.name
                ? "bg-secondary/60 hover:bg-secondary/40"
                : "",
            )}
          >
            <span>{option.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
