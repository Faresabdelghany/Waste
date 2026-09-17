"use client"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { FilterChip } from "@/components/filter-chip"
import { cn } from "@/lib/utils"

/**
 * A removable chip: `key` is what the consumer removes by, `label` what the
 * chip shows before the value. A chip without a label shows its key. Typing
 * `key` narrower than string (the business filter chips carry their filter
 * key) makes `onRemove` hand that key back, so a caller cannot pass the label
 * on where a key belongs.
 */
export type Chip<K extends string = string> = { key: K; label?: string; value: string }

interface ChipOverflowProps<K extends string> {
  chips: Chip<K>[]
  onRemove: (key: K, value: string) => void
  maxVisible?: number
  className?: string
}

export function ChipOverflow<K extends string = string>({
  chips,
  onRemove,
  maxVisible = 4,
  className,
}: ChipOverflowProps<K>) {
  const visible = chips.slice(0, Math.max(0, maxVisible))
  const hidden = chips.slice(Math.max(0, maxVisible))
  const text = (chip: Chip<K>) => `${chip.label ?? chip.key}: ${chip.value}`

  if (chips.length === 0) return null

  return (
    <div className={cn("flex items-center gap-2 overflow-hidden", className)}>
      {visible.map((chip) => (
        <FilterChip
          key={`${chip.key}-${chip.value}`}
          label={text(chip)}
          onRemove={() => onRemove(chip.key, chip.value)}
        />
      ))}

      {hidden.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <button className="flex h-8 items-center rounded-full border border-border/60 bg-background px-3 text-sm text-muted-foreground hover:bg-accent">
              +{hidden.length} more
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-2 rounded-xl">
            <div className="flex max-h-64 flex-col gap-2 overflow-auto pr-1">
              {hidden.map((chip) => (
                <div key={`${chip.key}-${chip.value}`} className="shrink-0">
                  <FilterChip
                    label={text(chip)}
                    onRemove={() => onRemove(chip.key, chip.value)}
                  />
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
