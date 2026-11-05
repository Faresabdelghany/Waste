"use client"

import { Button } from "@/components/ui/button"
import { PageActions, PageTopBar } from "@/components/page-layout"
import { FilterChip } from "@/components/filter-chip"
import { ViewOptionsPopover } from "@/components/view-options-popover"
import { FilterPopover } from "@/components/filter-popover"
import { ChipOverflow } from "@/components/chip-overflow"
import { Link as LinkIcon, Plus, Sparkle } from "@phosphor-icons/react/dist/ssr"
import type { FilterCounts } from "@/lib/data/projects"
import type { FilterChip as FilterChipType, ViewOptions } from "@/lib/view-options"

interface ProjectHeaderProps {
  filters: FilterChipType[]
  onRemoveFilter: (key: string, value: string) => void
  onFiltersChange: (chips: FilterChipType[]) => void
  counts?: FilterCounts
  viewOptions: ViewOptions
  onViewOptionsChange: (options: ViewOptions) => void
  onAddProject?: () => void
}

export function ProjectHeader({ filters, onRemoveFilter, onFiltersChange, counts, viewOptions, onViewOptionsChange, onAddProject }: ProjectHeaderProps) {
  return (
    <header className="flex flex-col border-b border-border/40">
      <PageTopBar>
        <p className="text-base font-medium text-foreground">Routes</p>
      </PageTopBar>

      <div className="flex items-center justify-between px-4 pb-3 pt-3">
        <div className="flex items-center gap-2">
          <FilterPopover
            initialChips={filters}
            onApply={onFiltersChange}
            onClear={() => onFiltersChange([])}
            counts={counts}
          />
          <ChipOverflow chips={filters} onRemove={onRemoveFilter} maxVisible={6} />
        </div>
        <div className="flex items-center gap-2">
          <PageActions>
            <Button variant="ghost" size="icon" aria-label="Copy link">
              <LinkIcon className="h-4 w-4" />
            </Button>
            <Button size="sm" onClick={onAddProject}>
              <Plus className="h-4 w-4" weight="bold" />
              Add Route
            </Button>
          </PageActions>
          <ViewOptionsPopover options={viewOptions} onChange={onViewOptionsChange} />
          <div className="relative">
            <div className="relative">
              <Button className="h-8 gap-2 rounded-lg bg-primary shadow-sm text-primary-foreground hover:bg-primary/90 relative z-10 px-3">
                <Sparkle className="h-4 w-4" weight="fill" />
                Ask AI
              </Button>
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}
