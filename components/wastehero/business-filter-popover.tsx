"use client"

import { useMemo, useState } from "react"
import {
  Buildings,
  CalendarBlank,
  Cube,
  Database,
  Funnel,
  MapTrifold,
  Speedometer,
  Spinner,
  Truck,
  User,
  WifiHigh,
} from "@phosphor-icons/react/dist/ssr"

import type { BusinessRecord } from "@/lib/data/business-modules"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

export type BusinessFilters = {
  statuses: string[]
  owners: string[]
  sources: string[]
  freshness: string[]
  containerTypes: string[]
  wasteFractions: string[]
  vehicles: string[]
  pickupSettings: string[]
  routeSchemes: string[]
  collectionCalendars: string[]
  propertyTypes: string[]
  contractAreas: string[]
  serviceScopes: string[]
  reliabilityBands: string[]
}

type FilterCategory = keyof BusinessFilters

const emptyFilters: BusinessFilters = {
  statuses: [],
  owners: [],
  sources: [],
  freshness: [],
  containerTypes: [],
  wasteFractions: [],
  vehicles: [],
  pickupSettings: [],
  routeSchemes: [],
  collectionCalendars: [],
  propertyTypes: [],
  contractAreas: [],
  serviceScopes: [],
  reliabilityBands: [],
}

type FilterDefinition = {
  id: FilterCategory
  label: string
  icon: typeof Spinner
  values: (record: BusinessRecord) => string[]
}

function singleValue(value: string | undefined) {
  return value && value !== "—" ? [value] : []
}

function fractionValues(value: string | undefined) {
  if (!value || value === "—") return []
  return value.split(" · ").map((fraction) => fraction.trim()).filter(Boolean)
}

const defaultCategories: FilterDefinition[] = [
  { id: "statuses", label: "Status", icon: Spinner, values: (record) => [record.status] },
  { id: "owners", label: "Owner", icon: User, values: (record) => [record.owner] },
  { id: "sources", label: "Source", icon: Database, values: (record) => [record.source] },
  { id: "freshness", label: "Freshness", icon: WifiHigh, values: (record) => [record.freshness] },
]

const containerCategories: FilterDefinition[] = [
  { id: "statuses", label: "Status", icon: Spinner, values: (record) => [record.status] },
  {
    id: "containerTypes",
    label: "Container type",
    icon: Cube,
    values: (record) => singleValue(record.facts["Container type"]),
  },
  {
    id: "wasteFractions",
    label: "Waste fraction",
    icon: Database,
    values: (record) => fractionValues(record.facts["Waste fractions"]),
  },
  {
    id: "vehicles",
    label: "Vehicle",
    icon: Truck,
    values: (record) => singleValue(record.facts.Vehicle),
  },
  {
    id: "pickupSettings",
    label: "Pickup setting",
    icon: Database,
    values: (record) => singleValue(record.facts["Pickup setting"]),
  },
  {
    id: "routeSchemes",
    label: "Route scheme",
    icon: MapTrifold,
    values: (record) => singleValue(record.facts["Route scheme"]),
  },
  {
    id: "collectionCalendars",
    label: "Collection calendar",
    icon: CalendarBlank,
    values: (record) => singleValue(record.facts["Collection calendar"]),
  },
  {
    id: "propertyTypes",
    label: "Property type",
    icon: Buildings,
    values: (record) => singleValue(record.facts["Property type"]),
  },
]

const contractorCategories: FilterDefinition[] = [
  { id: "statuses", label: "Status", icon: Spinner, values: (record) => [record.status] },
  {
    id: "contractAreas",
    label: "Contract area",
    icon: MapTrifold,
    values: (record) => singleValue(record.facts["Contract area"]),
  },
  {
    id: "serviceScopes",
    label: "Service scope",
    icon: Database,
    values: (record) => fractionValues(record.facts["Service scope"]),
  },
  {
    id: "reliabilityBands",
    label: "Reliability",
    icon: Speedometer,
    values: (record) => singleValue(record.facts["Reliability band"]),
  },
]

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) =>
    left.localeCompare(right),
  )
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
}: {
  records: BusinessRecord[]
  value: BusinessFilters
  onChange: (filters: BusinessFilters) => void
  variant?: "default" | "containers" | "contractors"
}) {
  const [open, setOpen] = useState(false)
  const [activeCategory, setActiveCategory] =
    useState<FilterCategory>("statuses")
  const [categorySearch, setCategorySearch] = useState("")
  const [optionSearch, setOptionSearch] = useState("")
  const [draft, setDraft] = useState<BusinessFilters>(value)

  const categories =
    variant === "containers"
      ? containerCategories
      : variant === "contractors"
        ? contractorCategories
        : defaultCategories
  const resolvedActiveCategory = categories.some(
    (category) => category.id === activeCategory,
  )
    ? activeCategory
    : categories[0].id

  const options = useMemo<Record<FilterCategory, string[]>>(() => {
    const next = {} as Record<FilterCategory, string[]>
    for (const key of Object.keys(emptyFilters) as FilterCategory[]) {
      next[key] = []
    }
    for (const category of categories) {
      next[category.id] = uniqueSorted(records.flatMap(category.values))
    }
    return next
  }, [categories, records])

  const counts = useMemo(() => {
    const next = {} as Record<FilterCategory, Record<string, number>>
    for (const key of Object.keys(emptyFilters) as FilterCategory[]) {
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
    setDraft(emptyFilters)
    onChange(emptyFilters)
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
                const Icon = category.icon
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
