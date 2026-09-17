"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  CalendarBlank,
  CaretUpDown,
  ChartBar,
  Clock,
  DotsSixVertical,
  Garage,
  Globe,
  Kanban,
  ListBullets,
  MapPin,
  Package,
  Plus,
  Sliders,
  Spinner,
  Table,
  Tag,
  TextIndent,
  TextT,
  Truck,
  User,
  X,
} from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

export type BusinessViewType = "table" | "list" | "board" | "timeline"

export type BusinessViewOptions = {
  viewType: BusinessViewType
  density: "compact" | "comfortable"
  ordering: "updated" | "name" | "status"
  groupBy: string
  factColumns: string[]
  staticColumns: string[]
  showDescription: boolean
  showContext: boolean
  showUpdated: boolean
  showArea: boolean
  showContainerType: boolean
  showWasteFraction: boolean
  showAddress: boolean
  showFillLevel: boolean
  showNextCollection: boolean
  showProject: boolean
}

export const defaultBusinessViewOptions: BusinessViewOptions = {
  viewType: "table",
  density: "comfortable",
  ordering: "updated",
  groupBy: "none",
  factColumns: ["Vehicle", "Driver"],
  staticColumns: [],
  showDescription: true,
  showContext: true,
  showUpdated: true,
  showArea: true,
  showContainerType: true,
  showWasteFraction: true,
  showAddress: true,
  showFillLevel: true,
  showNextCollection: true,
  showProject: true,
}

type BooleanViewOption = Exclude<
  keyof BusinessViewOptions,
  "viewType" | "density" | "ordering" | "groupBy" | "factColumns" | "staticColumns"
>

export type BusinessGroupOption = {
  value: string
  label: string
  count?: string
}

export type BusinessColumnChip = {
  key: BooleanViewOption
  label: string
}

const viewTypeTabs: Array<{
  id: BusinessViewType
  label: string
  icon: typeof Table
}> = [
  { id: "table", label: "Table", icon: Table },
  { id: "list", label: "List", icon: ListBullets },
  { id: "board", label: "Board", icon: Kanban },
  { id: "timeline", label: "Timeline", icon: ChartBar },
]

const defaultFields: Array<{ key: BooleanViewOption; label: string }> = [
  { key: "showDescription", label: "Description" },
  { key: "showContext", label: "Business context" },
  { key: "showUpdated", label: "Updated time" },
]

const containerFields: Array<{ key: BooleanViewOption; label: string }> = [
  { key: "showDescription", label: "Description under ID" },
  { key: "showContainerType", label: "Container type" },
  { key: "showWasteFraction", label: "Waste fraction" },
  { key: "showAddress", label: "Address / location" },
  { key: "showFillLevel", label: "Fill level / sensor state" },
  { key: "showNextCollection", label: "Next collection" },
  { key: "showProject", label: "Project" },
]

function columnIcon(label: string): typeof Tag {
  const normalized = label.toLowerCase()
  if (normalized.includes("vehicle") || normalized.includes("trailer")) return Truck
  if (normalized.includes("driver")) return User
  if (normalized.includes("depot") || normalized.includes("warehouse")) return Garage
  if (normalized.includes("unloading")) return Package
  if (normalized.includes("date") || normalized.includes("calendar"))
    return CalendarBlank
  if (
    normalized.includes("scheme") ||
    normalized.includes("route") ||
    normalized.includes("area")
  )
    return MapPin
  if (normalized.includes("status") || normalized.includes("state")) return Spinner
  if (normalized.includes("project") || normalized.includes("scope")) return Globe
  if (normalized.includes("updated") || normalized.includes("time")) return Clock
  if (normalized.includes("description")) return TextT
  if (normalized.includes("context")) return TextIndent
  return Tag
}

export function BusinessViewOptionsPopover({
  value,
  onChange,
  variant = "default",
  allowedViewTypes,
  columnOptions = [],
  groupOptions = [],
  builtinColumnChips,
  fixedColumnChips = [],
  columnsStyle = "chips",
}: {
  value: BusinessViewOptions
  onChange: (options: BusinessViewOptions) => void
  variant?: "default" | "containers" | "records"
  allowedViewTypes?: readonly BusinessViewType[]
  columnOptions?: readonly string[]
  groupOptions?: readonly BusinessGroupOption[]
  builtinColumnChips?: readonly BusinessColumnChip[]
  /**
   * Columns the table always shows. They are listed so the popover mirrors
   * the table, but they cannot be toggled off.
   */
  fixedColumnChips?: readonly string[]
  /**
   * "chips": toggle chips with an add-column picker. "display": the
   * Display-columns panel with a Static Columns drop zone and Other Columns.
   */
  columnsStyle?: "chips" | "display"
}) {
  const [groupByOpen, setGroupByOpen] = useState(false)
  const [addColumnOpen, setAddColumnOpen] = useState(false)
  const fields = variant === "containers" ? containerFields : defaultFields
  const viewTypes = viewTypeTabs.filter(
    (tab) => allowedViewTypes?.includes(tab.id) ?? tab.id === "table",
  )
  const showViewTypeTabs = viewTypes.length > 1
  const isRecordsVariant = variant === "records"

  const activeFactColumns = value.factColumns.filter((column) =>
    columnOptions.includes(column),
  )
  const activeStaticColumns = value.staticColumns.filter((column) =>
    columnOptions.includes(column),
  )
  const addableColumns = columnOptions.filter(
    (column) =>
      !activeFactColumns.includes(column) &&
      !activeStaticColumns.includes(column),
  )
  const resolvedGroupOptions: readonly BusinessGroupOption[] =
    groupOptions.length > 0 ? groupOptions : [{ value: "none", label: "None" }]
  const activeGroupOption =
    resolvedGroupOptions.find((option) => option.value === value.groupBy) ??
    resolvedGroupOptions[0]

  const toggleFactColumn = (column: string) => {
    const isActive = activeFactColumns.includes(column)
    onChange({
      ...value,
      factColumns: isActive
        ? value.factColumns.filter((candidate) => candidate !== column)
        : [...value.factColumns, column],
    })
  }

  const pinColumn = (column: string) =>
    onChange({
      ...value,
      staticColumns: [
        ...value.staticColumns.filter((candidate) => candidate !== column),
        column,
      ],
      factColumns: value.factColumns.filter((candidate) => candidate !== column),
    })

  const unpinColumn = (column: string) => {
    if (!value.staticColumns.includes(column)) return
    onChange({
      ...value,
      staticColumns: value.staticColumns.filter(
        (candidate) => candidate !== column,
      ),
      // An unpinned column stays visible as a regular column.
      factColumns: value.factColumns.includes(column)
        ? value.factColumns
        : [...value.factColumns, column],
    })
  }

  const builtinChips: readonly BusinessColumnChip[] = builtinColumnChips ?? [
    { key: "showDescription", label: "Description" },
    { key: "showProject", label: "Project" },
    { key: "showArea", label: "Area" },
    { key: "showUpdated", label: "Updated" },
  ]

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
          {showViewTypeTabs && (
            <div className="flex rounded-xl bg-muted p-1">
              {viewTypes.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onChange({ ...value, viewType: tab.id })}
                  className={cn(
                    "flex flex-1 flex-col items-center gap-1 rounded-lg py-2.5 text-xs font-medium transition-colors",
                    value.viewType === tab.id
                      ? "bg-background shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <tab.icon className="h-5 w-5" />
                  {tab.label}
                </button>
              ))}
            </div>
          )}
          {!isRecordsVariant && (
            <div>
              <p className="text-sm font-semibold">
                {showViewTypeTabs ? "View options" : "Table view"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {showViewTypeTabs
                  ? "Choose a layout and control density, ordering, and visible fields."
                  : variant === "containers"
                    ? "Control row density, ordering, and visible registry columns."
                    : "Control row density, ordering, and visible business context."}
              </p>
            </div>
          )}

          <div className="space-y-3 border-y border-border/60 py-3">
            <div className="flex items-center justify-between gap-4">
              <span className="text-xs font-medium">Density</span>
              <Select
                value={value.density}
                onValueChange={(density: BusinessViewOptions["density"]) =>
                  onChange({ ...value, density })
                }
              >
                <SelectTrigger className="h-8 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="comfortable">Comfortable</SelectItem>
                  <SelectItem value="compact">Compact</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between gap-4">
              <span className="text-xs font-medium">Order by</span>
              <Select
                value={value.ordering}
                onValueChange={(ordering: BusinessViewOptions["ordering"]) =>
                  onChange({ ...value, ordering })
                }
              >
                <SelectTrigger className="h-8 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="updated">Recently updated</SelectItem>
                  <SelectItem value="name">Name</SelectItem>
                  <SelectItem value="status">Status</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {isRecordsVariant && (
              <div className="flex items-center justify-between gap-4">
                <span className="text-xs font-medium">Group by</span>
                <Popover open={groupByOpen} onOpenChange={setGroupByOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 w-36 justify-between gap-2 rounded-lg border-border/60 bg-transparent px-3 text-xs font-normal"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {(() => {
                          const Icon =
                            activeGroupOption.value === "none"
                              ? Globe
                              : columnIcon(activeGroupOption.label)
                          return <Icon className="h-4 w-4 shrink-0" />
                        })()}
                        <span className="truncate">{activeGroupOption.label}</span>
                      </span>
                      <CaretUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-52 rounded-xl p-1" align="end">
                    {resolvedGroupOptions.map((option) => {
                      const Icon =
                        option.value === "none" ? Globe : columnIcon(option.label)
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            onChange({ ...value, groupBy: option.value })
                            setGroupByOpen(false)
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent",
                            value.groupBy === option.value && "bg-accent",
                          )}
                        >
                          <Icon className="h-4 w-4" />
                          <span className="flex-1 text-left">{option.label}</span>
                          {option.count && (
                            <span className="text-xs text-muted-foreground">
                              {option.count}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </PopoverContent>
                </Popover>
              </div>
            )}
          </div>

          {isRecordsVariant && columnsStyle === "display" ? (
            <div>
              <span className="text-sm font-medium">Display columns</span>
              <div className="mt-2 space-y-3">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    Static Columns
                  </p>
                  <div
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault()
                      const column = event.dataTransfer.getData("text/column")
                      if (column) pinColumn(column)
                    }}
                    className="mt-1.5 rounded-lg border border-dashed border-border/70"
                  >
                    {activeStaticColumns.length === 0 ? (
                      <p className="px-3 py-3 text-xs text-muted-foreground">
                        Drag a column here to make it static in the table.
                      </p>
                    ) : (
                      <div className="p-1">
                        {activeStaticColumns.map((column) => {
                          const Icon = columnIcon(column)
                          return (
                            <div
                              key={column}
                              draggable
                              onDragStart={(event) =>
                                event.dataTransfer.setData("text/column", column)
                              }
                              className="flex cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                            >
                              <DotsSixVertical className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <span className="flex-1 truncate">{column}</span>
                              <button
                                type="button"
                                aria-label={`Remove ${column} from static columns`}
                                onClick={() => unpinColumn(column)}
                                className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    Other Columns
                  </p>
                  <div
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault()
                      const column = event.dataTransfer.getData("text/column")
                      if (column) unpinColumn(column)
                    }}
                    className="mt-1.5 flex flex-wrap gap-2"
                  >
                    {builtinChips.map((chip) => {
                      const Icon = columnIcon(chip.label)
                      const isActive = value[chip.key]
                      return (
                        <button
                          key={chip.key}
                          type="button"
                          onClick={() =>
                            onChange({ ...value, [chip.key]: !isActive })
                          }
                          className={cn(
                            "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors",
                            isActive
                              ? "border-border bg-background text-foreground"
                              : "border-border text-muted-foreground hover:bg-accent",
                          )}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {chip.label}
                        </button>
                      )
                    })}
                    {activeFactColumns.map((column) => {
                      const Icon = columnIcon(column)
                      return (
                        <button
                          key={column}
                          type="button"
                          draggable
                          onDragStart={(event) =>
                            event.dataTransfer.setData("text/column", column)
                          }
                          onClick={() => toggleFactColumn(column)}
                          className="flex cursor-grab items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {column}
                        </button>
                      )
                    })}
                    <Popover open={addColumnOpen} onOpenChange={setAddColumnOpen}>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          disabled={addableColumns.length === 0}
                          aria-label="Add column"
                          className="flex items-center justify-center gap-1 rounded-md border border-dashed border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-52 rounded-xl p-1" align="start">
                        {addableColumns.length === 0 ? (
                          <p className="px-3 py-2 text-xs text-muted-foreground">
                            All available columns are visible.
                          </p>
                        ) : (
                          addableColumns.map((column) => {
                            const Icon = columnIcon(column)
                            return (
                              <button
                                key={column}
                                type="button"
                                onClick={() => {
                                  toggleFactColumn(column)
                                  setAddColumnOpen(false)
                                }}
                                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent"
                              >
                                <Icon className="h-4 w-4" />
                                {column}
                              </button>
                            )
                          })
                        )}
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
              </div>
            </div>
          ) : isRecordsVariant ? (
            <div>
              <span className="text-sm font-medium">Columns</span>
              <p className="mt-1 text-xs text-muted-foreground">
                {fixedColumnChips.length > 0 && columnOptions.length === 0
                  ? "These columns are always shown; only Updated can be toggled."
                  : "Toggle visible columns or add more from the record data."}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {fixedColumnChips.map((column) => {
                  const Icon = columnIcon(column)
                  return (
                    <span
                      key={column}
                      className="flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground"
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {column}
                    </span>
                  )
                })}
                {builtinChips.map((chip) => {
                  const Icon = columnIcon(chip.label)
                  const isActive = value[chip.key]
                  return (
                    <button
                      key={chip.key}
                      type="button"
                      onClick={() =>
                        onChange({ ...value, [chip.key]: !isActive })
                      }
                      className={cn(
                        "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors",
                        isActive
                          ? "border-border bg-background text-foreground"
                          : "border-border text-muted-foreground hover:bg-accent",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {chip.label}
                    </button>
                  )
                })}
                {activeFactColumns.map((column) => {
                  const Icon = columnIcon(column)
                  return (
                    <button
                      key={column}
                      type="button"
                      onClick={() => toggleFactColumn(column)}
                      className="flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {column}
                    </button>
                  )
                })}
                {columnOptions.length > 0 && (
                <Popover open={addColumnOpen} onOpenChange={setAddColumnOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      disabled={addableColumns.length === 0}
                      aria-label="Add column"
                      className="flex items-center justify-center gap-1 rounded-md border border-dashed border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-52 rounded-xl p-1" align="start">
                    {addableColumns.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-muted-foreground">
                        All available columns are visible.
                      </p>
                    ) : (
                      addableColumns.map((column) => {
                        const Icon = columnIcon(column)
                        return (
                          <button
                            key={column}
                            type="button"
                            onClick={() => {
                              toggleFactColumn(column)
                              setAddColumnOpen(false)
                            }}
                            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent"
                          >
                            <Icon className="h-4 w-4" />
                            {column}
                          </button>
                        )
                      })
                    )}
                  </PopoverContent>
                </Popover>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {fields.map(({ key, label }) => (
                <div key={key} className="flex items-center justify-between gap-4">
                  <span className="text-xs">{label}</span>
                  <Switch
                    aria-label={`Show ${label}`}
                    checked={value[key]}
                    onCheckedChange={(checked) =>
                      onChange({ ...value, [key]: checked })
                    }
                  />
                </div>
              ))}
            </div>
          )}

          {isRecordsVariant && (
            <div className="flex items-center justify-between border-t border-border/40 pt-3">
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                onClick={() =>
                  toast.success("Default view saved", {
                    description: "This view configuration now applies for everyone.",
                  })
                }
              >
                <Globe className="h-4 w-4" />
                Set default
                <span className="font-normal text-muted-foreground">
                  for everyone
                </span>
              </button>
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() =>
                  onChange({
                    ...defaultBusinessViewOptions,
                    viewType: value.viewType,
                  })
                }
              >
                Reset
              </button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
