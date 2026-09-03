"use client"

import { useMemo, useState } from "react"
import {
  Barcode,
  Buildings,
  CalendarBlank,
  Cube,
  Database,
  Flag,
  Funnel,
  IdentificationBadge,
  MapPin,
  MapTrifold,
  Path,
  Speedometer,
  Spinner,
  SteeringWheel,
  Tag,
  Truck,
  UsersThree,
  WifiHigh,
} from "@phosphor-icons/react/dist/ssr"

import type { BusinessRecord } from "@/lib/data/business-modules"
import {
  BUSINESS_FILTER_CHIP_LABELS,
  emptyBusinessFilters,
  singleFilterValue,
  splitFilterValues,
  type BusinessFilterKey,
  type BusinessFilters,
  type FilterValueReaders,
} from "@/lib/data/business-filters"
import { serviceFrequencyOfRecord } from "@/lib/data/service-frequencies"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

// The filter shape lives in the pure lib (lib/data/business-filters.ts) so
// non-workspace surfaces filter through the same model; re-exported for the
// existing component importers.
export type { BusinessFilters }

type FilterDefinition = {
  id: BusinessFilterKey
  label: string
  values: (record: BusinessRecord) => string[]
  /**
   * When set, the category always offers exactly these values (in this
   * order) instead of deriving the options from the loaded records.
   */
  options?: readonly string[]
}

// The legacy-name fold moved to the pure lib (issue #30) so derived list
// cells share it; re-exported here for the existing component importers.
import { canonicalCalendarName } from "@/lib/route-schemes/calendar"
export { canonicalCalendarName }

/** One icon per category, whichever surface offers it. */
const CATEGORY_ICONS: Readonly<Record<BusinessFilterKey, typeof Spinner>> = {
  statuses: Spinner,
  sources: Database,
  freshness: WifiHigh,
  containerTypes: Cube,
  wasteFractions: Database,
  vehicles: Truck,
  drivers: SteeringWheel,
  containers: MapPin,
  containerIds: Barcode,
  routes: Path,
  serviceDates: CalendarBlank,
  serviceFrequencies: Database,
  routeSchemes: MapTrifold,
  collectionCalendars: CalendarBlank,
  propertyTypes: Buildings,
  serviceAreas: MapTrifold,
  serviceScopes: Database,
  reliabilityBands: Speedometer,
  roles: IdentificationBadge,
  ticketTypes: Tag,
  priorities: Flag,
  teams: UsersThree,
}

/**
 * Categories for a surface that passes its own reader set: the same function
 * fills the popover's option list and decides which rows survive, so the two
 * can never disagree. Reader declaration order is the category order.
 */
function categoriesFromReaders(readers: FilterValueReaders): FilterDefinition[] {
  return (Object.keys(readers) as BusinessFilterKey[]).flatMap((id) => {
    const values = readers[id]
    return values ? [{ id, label: BUSINESS_FILTER_CHIP_LABELS[id], values }] : []
  })
}

const defaultCategories: FilterDefinition[] = [
  { id: "statuses", label: "Status", values: (record) => [record.status] },
  { id: "sources", label: "Source", values: (record) => [record.source] },
  { id: "freshness", label: "Freshness", values: (record) => [record.freshness] },
]

const containerCategories: FilterDefinition[] = [
  { id: "statuses", label: "Status", values: (record) => [record.status] },
  {
    id: "containerTypes",
    label: "Container type",
    values: (record) => singleFilterValue(record.facts["Container type"]),
  },
  {
    id: "wasteFractions",
    label: "Waste fraction",
    values: (record) => splitFilterValues(record.facts["Waste fractions"]),
  },
  {
    id: "vehicles",
    label: "Vehicle",
    values: (record) => singleFilterValue(record.facts.Vehicle),
  },
  {
    id: "serviceFrequencies",
    label: "Service frequency",
    // Typed reference first (issue #20); the fact chain is the legacy
    // fallback — pre-rename records keep the retired "Pickup setting" key
    // (issue #13), and pre-#20 fused strings fold onto catalog names so the
    // facet stays one option per cadence.
    values: (record) =>
      singleFilterValue(
        serviceFrequencyOfRecord(record)?.name ??
          record.facts["Service frequency"] ??
          record.facts["Pickup setting"],
      ),
  },
  {
    id: "routeSchemes",
    label: "Route scheme",
    values: (record) => singleFilterValue(record.facts["Route scheme"]),
  },
  {
    id: "collectionCalendars",
    label: "Collection calendar",
    values: (record) => singleFilterValue(canonicalCalendarName(record.facts["Collection calendar"])),
  },
  {
    id: "propertyTypes",
    label: "Property type",
    values: (record) => singleFilterValue(record.facts["Property type"]),
  },
]

const serviceProviderCategories: FilterDefinition[] = [
  { id: "statuses", label: "Status", values: (record) => [record.status] },
  {
    id: "serviceAreas",
    label: "Service area",
    values: (record) => singleFilterValue(record.facts["Service area"]),
  },
  {
    id: "serviceScopes",
    label: "Service scope",
    values: (record) => splitFilterValues(record.facts["Service scope"]),
  },
  {
    id: "reliabilityBands",
    label: "Reliability",
    values: (record) => singleFilterValue(record.facts["Reliability band"]),
  },
]

// Service provider users are filtered by the data the Add User form captures: the
// enumerable Role plus the lifecycle Status. Name, phone, and email are
// free-text and stay searchable instead. The "Service provider role" key covers
// records created before the field was renamed. Both categories offer the
// full fixed value set, matching the user lifecycle and the form's roles,
// even when no loaded record currently holds a value.
const serviceProviderUserCategories: FilterDefinition[] = [
  {
    id: "statuses",
    label: "Status",
    values: (record) => [record.status],
    options: ["Invited", "Active", "Deactive"],
  },
  {
    id: "roles",
    label: "Role",
    values: (record) =>
      singleFilterValue(record.facts.Role ?? record.facts["Service provider role"]),
    options: ["Service provider manager", "Foreman", "Driver", "Read-only viewer"],
  },
]

// Tickets are filtered by the classification data every Ticket carries:
// lifecycle Status plus the Type, Priority, and Assigned team facts. Fixture
// tickets store them as Type/Priority/Team; tickets created through the form
// store the field labels Ticket type/Priority/Assigned team, so both keys are
// read. Subject and description stay free-text searchable instead.
const ticketCategories: FilterDefinition[] = [
  { id: "statuses", label: "Status", values: (record) => [record.status] },
  {
    id: "ticketTypes",
    label: "Type",
    values: (record) =>
      singleFilterValue(record.facts.Type ?? record.facts["Ticket type"]),
  },
  {
    id: "priorities",
    label: "Priority",
    values: (record) => singleFilterValue(record.facts.Priority),
  },
  {
    id: "teams",
    label: "Assigned team",
    values: (record) =>
      singleFilterValue(record.facts.Team ?? record.facts["Assigned team"]),
  },
]

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) =>
    left.localeCompare(right),
  )
}

export type BusinessFilterVariant =
  | "default"
  | "containers"
  | "service-providers"
  | "service-provider-users"
  | "tickets"

const CATEGORIES_BY_VARIANT: Readonly<Record<BusinessFilterVariant, FilterDefinition[]>> = {
  default: defaultCategories,
  containers: containerCategories,
  "service-providers": serviceProviderCategories,
  "service-provider-users": serviceProviderUserCategories,
  tickets: ticketCategories,
}

function toggleValue(values: string[], value: string) {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value]
}

export function BusinessFilterPopover({
  records,
  value,
  onChange,
  variant = "default",
  readers,
}: {
  records: BusinessRecord[]
  value: BusinessFilters
  onChange: (filters: BusinessFilters) => void
  variant?: BusinessFilterVariant
  /**
   * A surface's own reader set (e.g. the scheme detail tabs) — offered in
   * declaration order instead of the variant's categories, so the popover's
   * options and the surface's row matching read one function per category.
   */
  readers?: FilterValueReaders
}) {
  const [open, setOpen] = useState(false)
  const [activeCategory, setActiveCategory] =
    useState<BusinessFilterKey>("statuses")
  const [categorySearch, setCategorySearch] = useState("")
  const [optionSearch, setOptionSearch] = useState("")
  const [draft, setDraft] = useState<BusinessFilters>(value)

  const categories = useMemo(
    () => (readers ? categoriesFromReaders(readers) : CATEGORIES_BY_VARIANT[variant]),
    [readers, variant],
  )
  const resolvedActiveCategory = categories.some(
    (category) => category.id === activeCategory,
  )
    ? activeCategory
    : categories[0].id

  const options = useMemo<Record<BusinessFilterKey, string[]>>(() => {
    const next = {} as Record<BusinessFilterKey, string[]>
    for (const key of Object.keys(emptyBusinessFilters) as BusinessFilterKey[]) {
      next[key] = []
    }
    for (const category of categories) {
      next[category.id] = category.options
        ? [...category.options]
        : uniqueSorted(records.flatMap(category.values))
    }
    return next
  }, [categories, records])

  const counts = useMemo(() => {
    const next = {} as Record<BusinessFilterKey, Record<string, number>>
    for (const key of Object.keys(emptyBusinessFilters) as BusinessFilterKey[]) {
      next[key] = {}
    }
    for (const category of categories) {
      next[category.id] = Object.fromEntries(
        options[category.id].map((option) => [
          option,
          records.filter((record) => category.values(record).includes(option)).length,
        ]),
      )
    }
    return next
  }, [categories, options, records])

  const activeCount = categories.reduce(
    (total, category) => total + value[category.id].length,
    0,
  )
  const visibleCategories = categories.filter((category) =>
    category.label.toLowerCase().includes(categorySearch.trim().toLowerCase()),
  )
  const visibleOptions = options[resolvedActiveCategory].filter((option) =>
    option.toLowerCase().includes(optionSearch.trim().toLowerCase()),
  )

  const clear = () => {
    setDraft(emptyBusinessFilters)
    onChange(emptyBusinessFilters)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen) {
          setDraft(value)
          setCategorySearch("")
          setOptionSearch("")
        }
      }}
    >
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
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[640px] rounded-xl p-0"
      >
        <div className="grid grid-cols-[230px_minmax(0,1fr)]">
          <div className="border-r border-border/50 p-3">
            <Input
              value={categorySearch}
              onChange={(event) => setCategorySearch(event.target.value)}
              placeholder="Find a filter"
              className="mb-2 h-8 text-xs"
            />
            <div className="space-y-1">
              {visibleCategories.map((category) => {
                const Icon = CATEGORY_ICONS[category.id]
                const selectionCount = draft[category.id].length
                return (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() => {
                      setActiveCategory(category.id)
                      setOptionSearch("")
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs hover:bg-accent",
                      resolvedActiveCategory === category.id && "bg-accent",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="flex-1 text-left">{category.label}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {selectionCount || options[category.id].length}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex min-h-[270px] flex-col p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold">
                  {categories.find((category) => category.id === resolvedActiveCategory)?.label}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Select one or several values
                </p>
              </div>
              {options[resolvedActiveCategory].length > 6 && (
                <Input
                  value={optionSearch}
                  onChange={(event) => setOptionSearch(event.target.value)}
                  placeholder="Search values"
                  className="h-8 w-44 text-xs"
                />
              )}
            </div>

            <div className="max-h-[240px] flex-1 overflow-y-auto border-y border-border/60">
              {visibleOptions.map((option) => (
                <label
                  key={option}
                  className="flex cursor-pointer items-center gap-3 border-b border-border/50 px-1 py-2.5 last:border-b-0 hover:bg-muted/40"
                >
                  <Checkbox
                    checked={draft[resolvedActiveCategory].includes(option)}
                    onCheckedChange={() =>
                      setDraft((current) => ({
                        ...current,
                        [resolvedActiveCategory]: toggleValue(
                          current[resolvedActiveCategory],
                          option,
                        ),
                      }))
                    }
                  />
                  <span className="flex-1 text-xs">{option}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {counts[resolvedActiveCategory][option]}
                  </span>
                </label>
              ))}
            </div>

            <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-3">
              <button
                type="button"
                onClick={clear}
                className="text-xs font-medium text-primary hover:underline"
              >
                Clear all
              </button>
              <Button
                size="sm"
                className="h-8"
                onClick={() => {
                  onChange(draft)
                  setOpen(false)
                }}
              >
                Apply filters
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
