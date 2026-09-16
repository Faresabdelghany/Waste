"use client"

// The Map Planning toolbar (2026-09-16): saved views behind the star, the
// shared filter popover with the map's own readers, the collection window,
// and Reset all — with the active picks shown as chips so the filter state
// is never invisible.

import { useState } from "react"
import { CalendarBlank, Star, Trash } from "@phosphor-icons/react/dist/ssr"

import { ChipOverflow } from "@/components/chip-overflow"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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
  filterKeyForChipLabel,
  removeBusinessFilterValue,
  type BusinessFilters,
} from "@/lib/data/business-filters"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { MAP_FILTER_READERS } from "@/lib/map-planning/filters"
import type { SavedMapView } from "@/lib/map-planning/saved-views"
import {
  COLLECTION_WINDOWS,
  COLLECTION_WINDOW_LABELS,
  isCollectionWindow,
  type CollectionWindow,
} from "@/lib/map-planning/schedule"
import { cn } from "@/lib/utils"

export type MapToolbarProps = {
  /** The records the filter popover offers values from. */
  records: BusinessRecord[]
  filters: BusinessFilters
  onFiltersChange: (filters: BusinessFilters) => void
  window: CollectionWindow
  onWindowChange: (window: CollectionWindow) => void
  savedViews: SavedMapView[]
  onApplyView: (view: SavedMapView) => void
  onSaveView: (name: string) => void
  onDeleteView: (id: string) => void
  canReset: boolean
  onResetAll: () => void
}

export function MapToolbar({
  records,
  filters,
  onFiltersChange,
  window,
  onWindowChange,
  savedViews,
  onApplyView,
  onSaveView,
  onDeleteView,
  canReset,
  onResetAll,
}: MapToolbarProps) {
  const chips = businessFilterChips(filters)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <SavedViewsMenu
          views={savedViews}
          onApply={onApplyView}
          onSave={onSaveView}
          onDelete={onDeleteView}
        />
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
          onRemove={(label, value) => {
            const key = filterKeyForChipLabel(label)
            if (key) onFiltersChange(removeBusinessFilterValue(filters, key, value))
          }}
        />
      )}
    </div>
  )
}

function SavedViewsMenu({
  views,
  onApply,
  onSave,
  onDelete,
}: {
  views: SavedMapView[]
  onApply: (view: SavedMapView) => void
  onSave: (name: string) => void
  onDelete: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")

  const save = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onSave(trimmed)
    setName("")
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("h-8 gap-1.5 text-xs", views.length > 0 && "border-primary/40")}
          aria-label="Saved views"
        >
          <Star className="h-4 w-4" weight={views.length > 0 ? "fill" : "regular"} />
          Saved views
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <p className="px-1 pb-2 text-xs font-medium text-muted-foreground">Saved views</p>
        {views.length === 0 ? (
          <p className="px-1 pb-2 text-xs text-muted-foreground">
            Save the current filters, collection window, and marker mode under a name.
          </p>
        ) : (
          <ul className="max-h-56 space-y-0.5 overflow-y-auto pb-2">
            {views.map((view) => (
              <li key={view.id} className="flex items-center gap-1">
                <button
                  type="button"
                  className="flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    onApply(view)
                    setOpen(false)
                  }}
                >
                  {view.name}
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground"
                  aria-label={`Delete saved view ${view.name}`}
                  onClick={() => onDelete(view.id)}
                >
                  <Trash className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-1 border-t border-border pt-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") save()
            }}
            placeholder="Name this view"
            aria-label="Saved view name"
            className="h-8 text-xs"
          />
          <Button size="sm" className="h-8" disabled={!name.trim()} onClick={save}>
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
