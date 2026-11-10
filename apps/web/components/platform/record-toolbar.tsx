"use client"

// The toolbar every list draws, the workspace's modules and the Settings
// panes' alike: its search, the filters its readers name, the view, and the
// picked filters as chips beneath. A list keeps its own rows, readers, orders
// and columns; how they are asked for is this one layout.

import type { ComponentProps, ReactNode } from "react"

import { ChipOverflow } from "@/components/chip-overflow"
import { BusinessFilterPopover, type BusinessFilterVariant } from "@/components/platform/business-filter-popover"
import {
  BusinessViewOptionsPopover,
  defaultBusinessViewOptions,
  type BusinessColumnChip,
  type BusinessOrderingOption,
  type BusinessViewOptions,
} from "@/components/platform/business-view-options-popover"
import { RecordSearchInput } from "@/components/platform/record-search-input"
import type { BusinessRecord } from "@/lib/prototype/prototype-record"
import { businessFilterChips, removeBusinessFilterValue, type BusinessFilters, type FilterValueReaders } from "@/lib/prototype/business-filters"
import { cn } from "@/lib/utils"

export function RecordToolbar({
  placeholder,
  query,
  onQueryChange,
  records,
  readers,
  filterVariant,
  filters,
  onFiltersChange,
  view,
  actions,
  className,
}: {
  placeholder: string
  query: string
  onQueryChange: (value: string) => void
  /** The rows the filters' values are read off. */
  records: readonly BusinessRecord[]
  /** The list's own readers; without them, the variant's categories. */
  readers?: FilterValueReaders
  filterVariant?: BusinessFilterVariant
  filters: BusinessFilters
  onFiltersChange: (filters: BusinessFilters) => void
  /** The view popover, `records` unless it says otherwise; a list without one shows none. */
  view?: ComponentProps<typeof BusinessViewOptionsPopover>
  /** What the list offers beside its toolbar (the workspace's Open full view). */
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-[260px] flex-1 flex-wrap items-center gap-2">
          <RecordSearchInput value={query} onChange={onQueryChange} placeholder={placeholder} />
          <BusinessFilterPopover records={[...records]} value={filters} onChange={onFiltersChange} variant={filterVariant} readers={readers} />
          {view && <BusinessViewOptionsPopover variant="records" {...view} />}
        </div>
        {actions}
      </div>
      <ChipOverflow chips={businessFilterChips(filters)} onRemove={(key, value) => onFiltersChange(removeBusinessFilterValue(filters, key, value))} maxVisible={4} />
    </div>
  )
}

/** A list's one optional column, shown under `showDescription`, as the view's chip names it. */
export const detailsColumn = (label: string): readonly BusinessColumnChip[] => [{ key: "showDescription", label }]

/** A list's view: the shared options, in the list's order, its one optional column (`showDescription`) shown. */
export const listView = (ordering: BusinessViewOptions["ordering"]): BusinessViewOptions => ({ ...defaultBusinessViewOptions, ordering, showDescription: true })

/** The orders of a list whose rows read an update and a name. */
export const RECENT_ORDERS: readonly BusinessOrderingOption[] = [
  { value: "updated", label: "Recently updated" },
  { value: "name", label: "Name" },
]

/** A table's rows by the view's density: compact tightens every cell. */
export const densityClass = (view: Pick<BusinessViewOptions, "density">): string => (view.density === "compact" ? "[&_td]:py-1.5" : "")

/** A list's rows in the view's order: by name, else newest first by `updated` (the store's order where every row reads alike). */
export function sortByView<T>(items: readonly T[], view: Pick<BusinessViewOptions, "ordering">, name: (item: T) => string, updated: (item: T) => string): T[] {
  return [...items].sort((a, b) => (view.ordering === "name" ? name(a).localeCompare(name(b)) : updated(b).localeCompare(updated(a))))
}
