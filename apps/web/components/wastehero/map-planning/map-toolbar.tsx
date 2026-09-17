"use client"

// The Map Planning toolbar (2026-09-16): the search, the shared filter
// popover with the map's own readers, the collection window, and Reset all
// — with the active picks shown as chips so the filter state is never
// invisible.

import { CalendarBlank } from "@phosphor-icons/react/dist/ssr"

import { ChipOverflow } from "@/components/chip-overflow"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { BusinessFilterPopover } from "@/components/wastehero/business-filter-popover"
import {
  businessFilterChips,
  removeBusinessFilterValue,
  type BusinessFilters,
} from "@waste/domain/business-filters"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { MAP_FILTER_READERS } from "@waste/domain/map-planning/filters"
import {
  COLLECTION_WINDOWS,
  COLLECTION_WINDOW_LABELS,
  isCollectionWindow,
  type CollectionWindow,
} from "@waste/domain/map-planning/schedule"
import { cn } from "@/lib/utils"

export type MapToolbarProps = {
  /** The records the filter popover offers values from. */
  records: BusinessRecord[]
  filters: BusinessFilters
  onFiltersChange: (filters: BusinessFilters) => void
  window: CollectionWindow
  onWindowChange: (window: CollectionWindow) => void
  canReset: boolean
  onResetAll: () => void
  /** Leading controls — the search box. */
  children?: React.ReactNode
}

export function MapToolbar({
  records,
  filters,
  onFiltersChange,
  window,
  onWindowChange,
  canReset,
  onResetAll,
  children,
}: MapToolbarProps) {
  const chips = businessFilterChips(filters)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {children}
        <BusinessFilterPopover
          records={records}
          value={filters}
          onChange={onFiltersChange}
          readers={MAP_FILTER_READERS}
        />
        <Select
          value={window}
          onValueChange={(value) => {
            if (isCollectionWindow(value)) onWindowChange(value)
          }}
        >
          <SelectTrigger
            aria-label="Collection window"
            className={cn(
              "h-8 w-auto gap-2 rounded-md text-xs",
              window !== "any" && "border-primary/40 bg-primary/5",
            )}
          >
            <CalendarBlank className="h-4 w-4 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COLLECTION_WINDOWS.map((option) => (
              <SelectItem key={option} value={option} className="text-xs">
                {COLLECTION_WINDOW_LABELS[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto">
          <Button variant="ghost" size="sm" disabled={!canReset} onClick={onResetAll}>
            Reset all
          </Button>
        </div>
      </div>
      {chips.length > 0 && (
        <ChipOverflow
          chips={chips}
          maxVisible={6}
          onRemove={(label, value) => onFiltersChange(removeBusinessFilterValue(filters, label, value))}
        />
      )}
    </div>
  )
}
