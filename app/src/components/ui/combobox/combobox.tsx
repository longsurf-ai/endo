import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "@openchart/app/utils/cn";

import { Button } from "@openchart/app/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@openchart/app/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@openchart/app/components/ui/popover";

/** Search a controlled choice with a Popover and Command list. @example <Combobox label="Time zone" value={zone} options={zones} onChange={setZone} /> */
export function Combobox({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  id?: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">
            {options.find((option) => option.value === value)?.label ?? value}
          </span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="neutral-controls w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command label={`Search ${label.toLowerCase()}`}>
          <CommandInput
            placeholder={`Search ${label.toLowerCase()}…`}
            className="h-9"
          />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label]}
                  onSelect={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  {option.label}
                  <Check
                    className={cn(
                      "ml-auto",
                      value === option.value ? "opacity-100" : "opacity-0",
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
