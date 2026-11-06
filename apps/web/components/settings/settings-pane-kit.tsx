"use client"

// The frame and the list kit every Settings pane draws with: the pane's shell
// (its heading bar, tabs, toolbar, title and ⓘ), the list's toolbar and
// count, the empty row, and the field and section of a pane's own dialogs.

import type { ReactNode } from "react"
import { Funnel, Info, MagnifyingGlass, Sliders } from "@phosphor-icons/react/dist/ssr"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { TableCell, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PageActions, TableCard } from "@/components/page-layout"
import { NARROWED_HINT, recordCountLabel } from "@/lib/table-copy"
import { useSettingsPaneFrame } from "@/components/settings/settings-pane-frame"

export function Field({
  label,
  note,
  required,
  wide,
  children,
}: {
  label: string
  /** What the value is, or why it cannot change — never how to fill it in. */
  note?: string
  required?: boolean
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div className={cn("grid content-start gap-2", wide && "sm:col-span-2")}>
      <Label>
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </Label>
      {children}
      {note && <p className="text-xs leading-5 text-muted-foreground">{note}</p>}
    </div>
  )
}

export function DialogSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="border-t border-border/70 py-5 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  )
}

export type AssetView = {
  ordering: "updated" | "name"
  showDetails: boolean
}

export const defaultAssetView: AssetView = { ordering: "updated", showDetails: true }

const assetStatusOptions = ["Active", "Inactive"] as const

export function sortByView<T>(
  items: T[],
  view: AssetView,
  name: (item: T) => string,
  updated: (item: T) => string,
) {
  return [...items].sort((a, b) =>
    view.ordering === "name"
      ? name(a).localeCompare(name(b))
      : updated(b).localeCompare(updated(a)),
  )
}

export type AssetFilterGroup = {
  label: string
  options: readonly string[]
  value: string[]
  onChange: (value: string[]) => void
}

function AssetFilterPopover({ groups }: { groups: AssetFilterGroup[] }) {
  const activeCount = groups.reduce((sum, group) => sum + group.value.length, 0)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2 rounded-lg border-border/60 bg-transparent px-3"
        >
          <Funnel className="h-4 w-4" />
          Filter
          {activeCount > 0 && (
            <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
              {activeCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 rounded-xl p-0">
        <div className="space-y-3 p-4">
          <div>
            <p className="text-sm font-semibold">Filter</p>
          </div>
          {groups.map((group) => (
            <div key={group.label} className="space-y-2">
              {groups.length > 1 && (
                <p className="text-xs font-medium text-muted-foreground">{group.label}</p>
              )}
              {group.options.map((option) => (
                <label key={option} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={group.value.includes(option)}
                    onCheckedChange={(checked) =>
                      group.onChange(
                        checked
                          ? [...group.value, option]
                          : group.value.filter((item) => item !== option),
                      )
                    }
                  />
                  {option}
                </label>
              ))}
            </div>
          ))}
          {activeCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => groups.forEach((group) => group.onChange([]))}
            >
              Clear filters
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function AssetViewPopover({
  value,
  onChange,
}: {
  value: AssetView
  onChange: (value: AssetView) => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2 rounded-lg border-border/60 bg-transparent px-3"
        >
          <Sliders className="h-4 w-4" />
          View
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 rounded-xl p-0">
        <div className="space-y-4 p-4">
          <div>
            <p className="text-sm font-semibold">Table view</p>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm">Ordering</span>
            <Select
              value={value.ordering}
              onValueChange={(ordering: AssetView["ordering"]) =>
                onChange({ ...value, ordering })
              }
            >
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="updated">Recently updated</SelectItem>
                <SelectItem value="name">Name</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center justify-between gap-4 text-sm">
            Show details
            <Switch
              checked={value.showDetails}
              onCheckedChange={(showDetails) => onChange({ ...value, showDetails })}
            />
          </label>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function AssetToolbar({
  searchPlaceholder,
  query,
  onQueryChange,
  statuses,
  onStatusesChange,
  statusOptions = assetStatusOptions,
  extraFilters,
  view,
  onViewChange,
}: {
  searchPlaceholder: string
  query: string
  onQueryChange: (value: string) => void
  statuses: string[]
  onStatusesChange: (value: string[]) => void
  statusOptions?: readonly string[]
  extraFilters?: AssetFilterGroup[]
  view: AssetView
  onViewChange: (value: AssetView) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-[260px] flex-1 flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] max-w-sm flex-1">
          <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={searchPlaceholder}
            className="h-8 pl-9 text-sm"
          />
        </div>
        <AssetFilterPopover
          groups={[
            {
              label: "Status",
              options: statusOptions,
              value: statuses,
              onChange: onStatusesChange,
            },
            ...(extraFilters ?? []),
          ]}
        />
        <AssetViewPopover value={view} onChange={onViewChange} />
      </div>
    </div>
  )
}

/** A Settings pane's list: `TableCard` counting its rows, the list's own actions (New …, Add …) in its header. */
export function RecordsSection({
  shown,
  total,
  actions,
  children,
}: {
  shown: number
  total: number
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <TableCard summary={recordCountLabel(shown, total)} actions={actions}>
      {children}
    </TableCard>
  )
}

/**
 * An empty table's one row. `narrowed` says the table has rows its search or filters hide, the one case
 * `NARROWED_HINT` is shown; a caller's own `hint` stands instead of it, and an empty one shows none.
 */
export function EmptyRow({ colSpan, message, hint, narrowed = false }: { colSpan: number; message: string; hint?: string; narrowed?: boolean }) {
  const shownHint = hint ?? (narrowed ? NARROWED_HINT : undefined)
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="h-52 text-center">
        <MagnifyingGlass className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">{message}</p>
        {shownHint ? <p className="mt-1 text-xs text-muted-foreground">{shownHint}</p> : null}
      </TableCell>
    </TableRow>
  )
}

export function AssetPanelShell({
  heading: ownHeading,
  header,
  tabs,
  action,
  toolbar,
  title: ownTitle,
  description: ownDescription,
  children,
}: {
  /** The bar above the toolbar, the shown pane's from the Settings table unless given; null leaves it out. */
  heading?: string | null
  /** A record's page: its `RecordPageHeader`, in place of the heading bar (`heading` and `action` then go unused), and no title. */
  header?: ReactNode
  tabs?: ReactNode
  /** The buttons of a pane that has no list (Notifications' Save); a list's actions go in its `RecordsSection`, as a workspace's do. */
  action?: ReactNode
  toolbar?: ReactNode
  /** The table's title and its ⓘ, the shown pane's unless a tab gives its own. */
  title?: string
  description?: string
  children: ReactNode
}) {
  const frame = useSettingsPaneFrame()
  const heading = ownHeading === undefined ? (frame?.heading ?? null) : ownHeading
  const title = ownTitle ?? (header === undefined ? frame?.title : undefined)
  const description = ownDescription ?? (ownTitle === undefined ? frame?.description : undefined)
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex flex-col border-b border-border/40">
        {header ?? ((heading !== null || action) && (
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <p className="text-base font-medium text-foreground">{heading}</p>
            {action && <PageActions>{action}</PageActions>}
          </div>
        ))}
        {(tabs || toolbar) && (
          <div className="flex flex-col gap-3 px-4 py-3">
            {tabs}
            {toolbar}
          </div>
        )}
      </header>
      <div className="flex-1 p-4">
        <div className="mx-auto max-w-[1500px] space-y-4">
          {title !== undefined && (
          <section className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="unstyled"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`About ${title}`}
                  >
                    <Info className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm text-xs">
                  {description}
                </TooltipContent>
              </Tooltip>
            </div>
          </section>
          )}
          {children}
        </div>
      </div>
    </div>
  )
}
