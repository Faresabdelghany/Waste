"use client"

import Image from "next/image"
import Link from "next/link"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  Check,
  CornersOut,
  DotsThreeVertical,
  DownloadSimple,
  Funnel,
  MagnifyingGlass,
  MapTrifold,
  PencilSimple,
  Play,
  Plus,
  Ticket,
  Trash,
  UserSwitch,
} from "@phosphor-icons/react/dist/ssr"

import type {
  BusinessRecord,
  ModuleDefinition,
} from "@/lib/data/business-modules"
import { getBusinessModuleHref } from "@/lib/data/business-links"
import {
  reassignRouteAssignment,
  reassignRoutePickups,
  stringValueOf,
} from "@/lib/route-schemes/generation"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useModuleRecords } from "@/components/wastehero/scheme-route-map"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { StatRow } from "@/components/projects/StatRow"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Breadcrumbs } from "@/components/projects/Breadcrumbs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  TablePagination,
  useTablePagination,
} from "@/components/ui/table-pagination"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

type RouteStop = {
  id: string
  sequence: number
  name: string
  kind: "Depot" | "Collection" | "Unloading" | "Ticket"
  arrival: string
  service: string
  status: "Completed" | "Next" | "Planned" | "Attention"
}

const initialStops: RouteStop[] = [
  {
    id: "stop-depot-start",
    sequence: 1,
    name: "Nordhavn Depot",
    kind: "Depot",
    arrival: "06:10",
    service: "Start and vehicle check",
    status: "Completed",
  },
  {
    id: "stop-adelsgade",
    sequence: 2,
    name: "Adelgade 12",
    kind: "Collection",
    arrival: "06:32",
    service: "Residual · 660 L",
    status: "Completed",
  },
  {
    id: "stop-borgergade",
    sequence: 3,
    name: "Borgergade 41",
    kind: "Collection",
    arrival: "06:48",
    service: "Mixed waste · 2 containers",
    status: "Next",
  },
  {
    id: "stop-kronprinsessegade",
    sequence: 4,
    name: "Kronprinsessegade 18",
    kind: "Ticket",
    arrival: "07:05",
    service: "Recollection · access confirmed",
    status: "Attention",
  },
  {
    id: "stop-gothersgade",
    sequence: 5,
    name: "Gothersgade 52",
    kind: "Collection",
    arrival: "07:24",
    service: "Residual · 4 containers",
    status: "Planned",
  },
  {
    id: "stop-unloading",
    sequence: 6,
    name: "ARC Amager",
    kind: "Unloading",
    arrival: "12:50",
    service: "Planned unloading",
    status: "Planned",
  },
]

function routeStatusClasses(status: string) {
  if (/active|completed|ready/i.test(status)) {
    return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  }
  if (/attention|delayed|unassigned/i.test(status)) {
    return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  }
  return "border-border bg-muted/50 text-muted-foreground"
}

function stopStatusClasses(status: RouteStop["status"]) {
  if (status === "Completed") {
    return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  }
  if (status === "Attention") {
    return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  }
  if (status === "Next") {
    return "border-primary/25 bg-primary/10 text-primary"
  }
  return "border-border bg-muted/40 text-muted-foreground"
}

function routeReference(record: BusinessRecord) {
  return record.name.split(" · ")[0] ?? record.name
}

function routeDate(record: BusinessRecord) {
  // Wizard-created routes submit operatingDate; scheme-generated routes carry
  // the deviation-remapped actualDate instead.
  const submittedDate =
    stringValueOf(record, "operatingDate") ?? stringValueOf(record, "actualDate")
  if (submittedDate) {
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(`${submittedDate}T12:00:00`))
  }
  return "28 July 2026"
}

function routeScheme(record: BusinessRecord) {
  const relation = record.relationRefs?.find(
    (item) =>
      item.moduleId === "schemes" &&
      (item.workspaceId === "route-studio" || item.workspaceId === "plan"),
  )
  if (relation) return relation.label
  return record.source.replace(/^Route scheme\s*/i, "") || "RS-Central-A"
}

/**
 * Reassign driver/vehicle for this route only (spec FR-12, ticket #9). The
 * write goes through reassignRouteAssignment, which leaves the generation
 * stamps (appliedDriver/appliedVehicle) untouched — so on a scheme-generated
 * route the override is detected as drift and survives later regenerations.
 * The scheme's own defaults and sibling routes are never touched.
 */
function ReassignRouteDialog({
  record,
  onClose,
  onReassign,
}: {
  record: BusinessRecord
  onClose: () => void
  onReassign: (updated: BusinessRecord, pickups: BusinessRecord[]) => void
}) {
  const driverRecords = useModuleRecords("fleet", "drivers")
  const vehicleRecords = useModuleRecords("fleet", "vehicles")
  const pickupRecords = useModuleRecords("route-studio", "pickups")
  const currentDriver = record.facts.Driver ?? record.owner ?? "Unassigned"
  const currentVehicle = record.facts.Vehicle ?? "Unassigned"
  const [driver, setDriver] = useState(currentDriver)
  const [vehicle, setVehicle] = useState(currentVehicle)

  const dedupe = (values: string[]) => Array.from(new Set(values))
  const driverOptions = dedupe([
    currentDriver,
    ...driverRecords.map((candidate) => candidate.name),
  ])
  // Vehicle facts store the reference ("WH-24"), not the full registry name.
  const vehicleOptions = dedupe([
    currentVehicle,
    ...vehicleRecords.map((candidate) => candidate.name.split(" · ")[0]),
  ])
  const unchanged = driver === currentDriver && vehicle === currentVehicle

  const save = () => {
    onReassign(
      reassignRouteAssignment(record, {
        ...(driver !== currentDriver ? { driver } : {}),
        ...(vehicle !== currentVehicle ? { vehicle } : {}),
      }),
      // The route's own open pickups follow the new driver so the stop list
      // agrees with the assignment; completed work keeps its actual driver.
      reassignRoutePickups(
        record.id,
        pickupRecords,
        driver !== currentDriver ? driver : undefined,
      ),
    )
    toast.success("Route reassigned", {
      description: `${routeReference(record)} · ${driver} · ${vehicle}. Other routes from the same scheme are unchanged.`,
    })
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reassign route</DialogTitle>
          <DialogDescription>
            Changes {routeReference(record)} only. The route scheme&apos;s
            defaults stay as they are, and this override survives
            regeneration.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reassign-driver">Driver</Label>
            <Select value={driver} onValueChange={setDriver}>
              <SelectTrigger id="reassign-driver" className="w-full">
                <SelectValue placeholder="Select driver" />
              </SelectTrigger>
              <SelectContent>
                {driverOptions.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reassign-vehicle">Vehicle</Label>
            <Select value={vehicle} onValueChange={setVehicle}>
              <SelectTrigger id="reassign-vehicle" className="w-full">
                <SelectValue placeholder="Select vehicle" />
              </SelectTrigger>
              <SelectContent>
                {vehicleOptions.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={unchanged}>
            Reassign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RouteInformation({
  record,
  stops,
}: {
  record: BusinessRecord
  stops: RouteStop[]
}) {
  const completedStops = stops.filter(
    (stop) => stop.status === "Completed",
  ).length
  const status =
    record.status === "Active"
      ? "In progress"
      : record.status === "Completed"
        ? "Completed"
        : record.status
  type InformationRow = readonly [string, string, boolean?]
  // Planned vs actual assignment stay distinct (spec FR-12): when a dispatcher
  // override drifted from what generation applied, show the scheme default too.
  const appliedDriver = stringValueOf(record, "appliedDriver")
  const appliedVehicle = stringValueOf(record, "appliedVehicle")
  const assignment: InformationRow[] = [
    ["Vehicle", record.facts.Vehicle ?? "Not assigned", true],
    ...(appliedVehicle && appliedVehicle !== record.facts.Vehicle
      ? [["Scheme default vehicle", appliedVehicle] as InformationRow]
      : []),
    ["Driver", record.facts.Driver ?? record.owner, true],
    ...(appliedDriver && appliedDriver !== record.facts.Driver
      ? [["Scheme default driver", appliedDriver] as InformationRow]
      : []),
    ["Trailer", record.facts["Vehicle Trailer"] ?? "None", false],
    [
      "Hauler",
      record.facts.Contractor ?? "Copenhagen Municipal Operations",
      true,
    ],
    ["Route scheme", routeScheme(record), true],
  ]
  const schedule: InformationRow[] = [
    ["Estimated time", "06:00 → 12:50"],
    ["Actual time", "06:10 → In progress"],
    ["Estimated duration", "6h 50m"],
    ["Actual duration", "2h 18m"],
  ]
  const progress: InformationRow[] = [
    ["Completed stops", `${completedStops} of ${stops.length}`],
    ["Estimated distance", "87.4 km"],
    ["Actual distance", "31.2 km"],
    ["Collected weight", "3.8 t"],
  ]

  const sections: { title: string; rows: InformationRow[] }[] = [
    { title: "Assignment", rows: assignment },
    { title: "Schedule", rows: schedule },
    { title: "Progress", rows: progress },
  ]

  return (
    <section className="min-w-0 px-5 py-5 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground">Operating date</p>
          <p className="mt-1 text-base font-semibold">{routeDate(record)}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">Route status</p>
          <Badge
            variant="outline"
            className={cn(
              "mt-1 rounded-full text-[11px]",
              routeStatusClasses(status),
            )}
          >
            {status}
          </Badge>
        </div>
      </div>

      <div className="mt-7 space-y-7">
        {sections.map((section) => (
          <section key={section.title} className="space-y-3.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {section.title}
            </h3>
            <div className="space-y-3.5">
              {section.rows.map(([label, value, isRelation]) => (
                <StatRow
                  key={label}
                  label={label}
                  value={
                    <span
                      className={cn(
                        "block min-w-0 break-words",
                        isRelation && "text-primary",
                      )}
                    >
                      {value}
                    </span>
                  }
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  )
}

function OverviewTab({
  record,
  onAction,
  onDelete,
  readOnly = false,
}: {
  record: BusinessRecord
  onAction: (action: string) => void
  onDelete?: () => void
  readOnly?: boolean
}) {
  const [stops, setStops] = useState<RouteStop[]>(initialStops)
  const [search, setSearch] = useState("")
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [mapExpanded, setMapExpanded] = useState(false)
  const [rightPanel, setRightPanel] = useState<"map" | "information">("map")
  const [selectedStopIds, setSelectedStopIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [lastDelete, setLastDelete] = useState<{
    stops: RouteStop[]
    count: number
  } | null>(null)

  const visibleStops = useMemo(() => {
    const normalized = search.trim().toLowerCase()
    return stops.filter((stop) => {
      if (attentionOnly && stop.status !== "Attention") return false
      if (!normalized) return true
      return `${stop.name} ${stop.kind} ${stop.service} ${stop.status}`
        .toLowerCase()
        .includes(normalized)
    })
  }, [attentionOnly, search, stops])

  const {
    page: stopsPage,
    setPage: setStopsPage,
    pageCount: stopsPageCount,
    pageRows: stopsPageRows,
    totalCount: stopsTotalCount,
  } = useTablePagination(visibleStops)

  const visibleStopIds = visibleStops.map((stop) => stop.id)
  const selectedVisibleCount = visibleStopIds.filter((id) =>
    selectedStopIds.has(id),
  ).length
  const allVisibleSelected =
    visibleStopIds.length > 0 && selectedVisibleCount === visibleStopIds.length
  const someVisibleSelected =
    selectedVisibleCount > 0 && !allVisibleSelected

  const toggleStopSelection = (stopId: string, selected: boolean) => {
    setSelectedStopIds((current) => {
      const next = new Set(current)
      if (selected) next.add(stopId)
      else next.delete(stopId)
      return next
    })
  }

  const toggleVisibleStops = (selected: boolean) => {
    setSelectedStopIds((current) => {
      const next = new Set(current)
      visibleStopIds.forEach((id) => {
        if (selected) next.add(id)
        else next.delete(id)
      })
      return next
    })
  }

  const completeSelectedStops = () => {
    const count = selectedStopIds.size
    setLastDelete(null)
    setStops((current) =>
      current.map((stop) =>
        selectedStopIds.has(stop.id)
          ? { ...stop, status: "Completed" }
          : stop,
      ),
    )
    setSelectedStopIds(new Set())
    toast.success(`${count} ${count === 1 ? "stop" : "stops"} completed`)
  }

  const deleteSelectedStops = () => {
    const removedStops = stops.filter((stop) => selectedStopIds.has(stop.id))
    if (removedStops.length === 0) return
    const previousStops = stops

    setStops((current) =>
      current
        .filter((stop) => !selectedStopIds.has(stop.id))
        .map((stop, index) => ({ ...stop, sequence: index + 1 })),
    )
    setSelectedStopIds(new Set())
    setLastDelete({
      stops: previousStops,
      count: removedStops.length,
    })
    toast.success(
      `${removedStops.length} ${removedStops.length === 1 ? "stop" : "stops"} deleted`,
    )
  }

  const deleteSingleStop = (stopId: string) => {
    const previousStops = stops
    setStops((current) =>
      current
        .filter((stop) => stop.id !== stopId)
        .map((stop, index) => ({ ...stop, sequence: index + 1 })),
    )
    setSelectedStopIds((current) => {
      const next = new Set(current)
      next.delete(stopId)
      return next
    })
    setLastDelete({ stops: previousStops, count: 1 })
    toast.success("Stop deleted")
  }

  const addStop = (kind: "Collection" | "Ticket") => {
    const stop: RouteStop = {
      id: `stop-${kind.toLowerCase()}-${Date.now()}`,
      sequence: stops.length + 1,
      name: kind === "Ticket" ? "New ticket stop" : "New container stop",
      kind,
      arrival: "—",
      service: kind === "Ticket" ? "Ticket work" : "Container collection",
      status: kind === "Ticket" ? "Attention" : "Planned",
    }
    setStops((current) => [...current, stop])
    setLastDelete(null)
    toast.success(`${kind} stop added`)
  }

  const optimizeRoute = () => {
    setLastDelete(null)
    setStops((current) =>
      current.map((stop, index) => ({ ...stop, sequence: index + 1 })),
    )
    toast.success("Route sequence optimized", {
      description: "Service scope was unchanged.",
    })
  }

  const completeStop = (stopId: string) => {
    setLastDelete(null)
    setStops((current) =>
      current.map((stop) =>
        stop.id === stopId ? { ...stop, status: "Completed" } : stop,
      ),
    )
    toast.success("Stop completed")
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="grid min-h-[640px] min-[1180px]:grid-cols-[minmax(0,1.45fr)_minmax(380px,0.95fr)]">
        <section className="min-w-0 border-b border-border min-[1180px]:border-b-0 min-[1180px]:border-r">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <div className="relative min-w-[220px] max-w-sm flex-1">
              <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search route stops"
                className="h-8 pl-9 text-sm"
              />
            </div>
            {(search || attentionOnly) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch("")
                  setAttentionOnly(false)
                }}
              >
                Reset
              </Button>
            )}
            <Button
              variant={attentionOnly ? "secondary" : "outline"}
              size="sm"
              onClick={() => setAttentionOnly((current) => !current)}
            >
              <Funnel className="h-4 w-4" />
              Filters
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  Action
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuItem onSelect={() => addStop("Collection")}>
                  <Plus className="h-4 w-4" />
                  Add container stops
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => addStop("Ticket")}>
                  <Ticket className="h-4 w-4" />
                  Add ticket stops
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={optimizeRoute}>
                  <ArrowsClockwise className="h-4 w-4" />
                  Optimize route
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    setStops(initialStops)
                    setSelectedStopIds(new Set())
                    setLastDelete(null)
                    toast.success("Route reset")
                  }}
                >
                  <ArrowsClockwise className="h-4 w-4" />
                  Reset route
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    toast.success("Route export prepared", {
                      description: `${routeReference(record)} · ${stops.length} stops`,
                    })
                  }
                >
                  <DownloadSimple className="h-4 w-4" />
                  Export route
                </DropdownMenuItem>
                {!readOnly && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => (onDelete ? onDelete() : onAction("Cancel"))}
                    >
                      <Trash className="h-4 w-4" />
                      Delete route
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {selectedStopIds.size > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-primary/[0.04] px-4 py-2">
              <p className="text-sm font-medium">
                {selectedStopIds.size}{" "}
                {selectedStopIds.size === 1 ? "stop" : "stops"} selected
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={completeSelectedStops}
                >
                  <Check className="h-4 w-4" />
                  Complete
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={deleteSelectedStops}
                >
                  <Trash className="h-4 w-4" />
                  Delete
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedStopIds(new Set())}
                >
                  Clear
                </Button>
              </div>
            </div>
          )}

          {selectedStopIds.size === 0 && lastDelete && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-destructive/[0.04] px-4 py-2">
              <p className="text-sm font-medium">
                {lastDelete.count}{" "}
                {lastDelete.count === 1 ? "stop" : "stops"} deleted
              </p>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setStops(lastDelete.stops)
                    setLastDelete(null)
                    toast.success("Stops restored")
                  }}
                >
                  Undo delete
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setLastDelete(null)}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          )}

          <div className="p-3 sm:p-4">
            <div className="max-w-full overflow-hidden rounded-xl border border-border">
              <div className="border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
                {visibleStops.length}{" "}
                {visibleStops.length === 1 ? "stop" : "stops"}
              </div>
              <div className="max-w-full overflow-x-auto">
                <Table className="min-w-[720px]">
                  <TableHeader className="bg-muted/30">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-12 text-xs font-medium text-muted-foreground">
                    <Checkbox
                      checked={
                        allVisibleSelected
                          ? true
                          : someVisibleSelected
                            ? "indeterminate"
                            : false
                      }
                      onCheckedChange={(checked) =>
                        toggleVisibleStops(checked === true)
                      }
                      aria-label={
                        allVisibleSelected
                          ? "Deselect all visible stops"
                          : "Select all visible stops"
                      }
                    />
                      </TableHead>
                      <TableHead className="w-14 text-xs font-medium text-muted-foreground">
                        #
                      </TableHead>
                      <TableHead className="text-xs font-medium text-muted-foreground">
                        Stop
                      </TableHead>
                      <TableHead className="text-xs font-medium text-muted-foreground">
                        Arrival
                      </TableHead>
                      <TableHead className="text-xs font-medium text-muted-foreground">
                        Service
                      </TableHead>
                      <TableHead className="text-xs font-medium text-muted-foreground">
                        Status
                      </TableHead>
                      <TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleStops.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="h-52 text-center">
                          <p className="text-sm font-medium">No matching stops</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Change the search or filter.
                          </p>
                        </TableCell>
                      </TableRow>
                    ) : (
                      stopsPageRows.map((stop) => (
                        <TableRow
                          key={stop.id}
                          data-state={
                            selectedStopIds.has(stop.id) ? "selected" : undefined
                          }
                          className="hover:bg-muted/60 data-[state=selected]:bg-primary/[0.05]"
                        >
                          <TableCell className="py-3">
                            <Checkbox
                              checked={selectedStopIds.has(stop.id)}
                              onCheckedChange={(checked) =>
                                toggleStopSelection(stop.id, checked === true)
                              }
                              aria-label={`Select ${stop.name}`}
                            />
                          </TableCell>
                          <TableCell className="py-3 text-sm text-muted-foreground">
                            {stop.sequence}
                          </TableCell>
                          <TableCell className="min-w-[180px] py-3">
                            <div className="space-y-0.5">
                              <p className="text-sm font-medium text-foreground">
                                {stop.name}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {stop.kind}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className="whitespace-nowrap py-3 text-sm">
                            {stop.arrival}
                          </TableCell>
                          <TableCell className="min-w-[160px] py-3 text-sm text-muted-foreground">
                            {stop.service}
                          </TableCell>
                          <TableCell className="py-3">
                            <Badge
                              variant="outline"
                              className={cn(
                                "rounded-full px-2 py-0.5 text-[11px] font-medium",
                                stopStatusClasses(stop.status),
                              )}
                            >
                              {stop.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="py-3 text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground"
                                  aria-label={`Actions for ${stop.name}`}
                                >
                                  <DotsThreeVertical className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="min-w-40">
                                {stop.status !== "Completed" && (
                                  <DropdownMenuItem
                                    onSelect={() => completeStop(stop.id)}
                                  >
                                    <Check className="h-4 w-4" />
                                    Mark completed
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onSelect={() => deleteSingleStop(stop.id)}
                                >
                                  <Trash className="h-4 w-4" />
                                  Delete stop
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
              <TablePagination
                page={stopsPage}
                pageCount={stopsPageCount}
                totalCount={stopsTotalCount}
                onPageChange={setStopsPage}
              />
            </div>
          </div>
        </section>

        <aside className="min-w-0">
          <section className="min-w-0">
            <div
              className={cn(
                "flex min-h-14 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3",
                rightPanel !== "map" && "bg-muted/20",
              )}
            >
              <button
                type="button"
                className="flex items-center gap-2 text-left"
                onClick={() => setRightPanel("map")}
                aria-expanded={rightPanel === "map"}
              >
                {rightPanel === "map" ? (
                  <CaretDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <CaretRight className="h-4 w-4 text-muted-foreground" />
                )}
                <MapTrifold className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold">Map</h2>
              </button>
              {rightPanel === "map" && (
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label="Expand map"
                    onClick={() => setMapExpanded(true)}
                  >
                    <CornersOut className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>

            {rightPanel === "map" && (
              <div className="relative h-[clamp(360px,55vh,660px)] overflow-hidden bg-muted">
                <Image
                  src="/route-map-copenhagen.png"
                  alt="Route map with six ordered stops"
                  fill
                  priority
                  sizes="(min-width: 1180px) 40vw, 100vw"
                  className="object-cover"
                />
              </div>
            )}

            <button
              type="button"
              className={cn(
                "flex min-h-14 w-full items-center gap-2 border-b border-border px-4 py-3 text-left",
                rightPanel !== "information" && "border-t",
              )}
              onClick={() => setRightPanel("information")}
              aria-expanded={rightPanel === "information"}
            >
              {rightPanel === "information" ? (
                <CaretDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <CaretRight className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="text-sm font-semibold">Route information</span>
            </button>

            {rightPanel === "information" && (
              <RouteInformation record={record} stops={stops} />
            )}
          </section>

          <Dialog open={mapExpanded} onOpenChange={setMapExpanded}>
            <DialogContent
              aria-describedby={undefined}
              className="max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0 sm:max-w-6xl"
            >
              <DialogHeader className="border-b border-border px-5 py-4 pr-12">
                <DialogTitle>{routeReference(record)} · Route map</DialogTitle>
              </DialogHeader>
              <div className="relative aspect-[16/9] max-h-[78vh] min-h-[320px] bg-muted sm:min-h-[420px]">
                <Image
                  src="/route-map-copenhagen.png"
                  alt="Expanded Route map with six ordered stops"
                  fill
                  sizes="(min-width: 1024px) 90vw, 100vw"
                  className="object-cover"
                />
              </div>
            </DialogContent>
          </Dialog>
        </aside>
      </div>
    </div>
  )
}

function TicketsTab({
  tickets,
}: {
  tickets: readonly BusinessRecord[]
}) {
  const {
    page: ticketsPage,
    setPage: setTicketsPage,
    pageCount: ticketsPageCount,
    pageRows: ticketsPageRows,
    totalCount: ticketsTotalCount,
  } = useTablePagination(tickets)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold">Tickets related to this Route</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Open requests and deviations linked to a stop or the Route.
        </p>
      </div>
      <div className="p-4">
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
            {tickets.length} {tickets.length === 1 ? "ticket" : "tickets"}
          </div>
          <div className="overflow-x-auto">
            <Table className="min-w-[900px]">
              <TableHeader className="bg-muted/30">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    Ticket
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    Type
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    Priority
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    Status
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    SLA
                  </TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tickets.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-52 text-center">
                      <Ticket className="mx-auto h-6 w-6 text-muted-foreground" />
                      <p className="mt-2 text-sm font-medium">No related tickets</p>
                    </TableCell>
                  </TableRow>
                ) : (
                  ticketsPageRows.map((ticketRecord) => (
                    <TableRow
                      key={ticketRecord.id}
                      className="hover:bg-muted/60"
                    >
                      <TableCell className="min-w-[260px] py-3">
                        <p className="text-sm font-medium text-foreground">
                          {ticketRecord.name}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {ticketRecord.context}
                        </p>
                      </TableCell>
                      <TableCell className="py-3 text-sm">
                        {ticketRecord.facts.Type ?? "Operational"}
                      </TableCell>
                      <TableCell className="py-3">
                        <Badge
                          variant="outline"
                          className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                        >
                          {ticketRecord.facts.Priority ?? "Normal"}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-3">
                        <Badge
                          variant="outline"
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[11px] font-medium",
                            routeStatusClasses(ticketRecord.status),
                          )}
                        >
                          {ticketRecord.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-3 text-sm">
                        {ticketRecord.value}
                      </TableCell>
                      <TableCell className="py-3 text-right">
                        <Button variant="ghost" size="sm" asChild>
                          <Link
                            href={getBusinessModuleHref(
                              "operate",
                              "tickets",
                              ticketRecord.id,
                            )}
                          >
                            Open
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <TablePagination
            page={ticketsPage}
            pageCount={ticketsPageCount}
            totalCount={ticketsTotalCount}
            onPageChange={setTicketsPage}
          />
        </div>
      </div>
    </div>
  )
}

function SessionsTab({
  sessions,
}: {
  sessions: readonly BusinessRecord[]
}) {
  const {
    page: sessionsPage,
    setPage: setSessionsPage,
    pageCount: sessionsPageCount,
    pageRows: sessionsPageRows,
    totalCount: sessionsTotalCount,
  } = useTablePagination(sessions)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold">Route sessions</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Driver runs, synchronization state, and execution progress.
        </p>
      </div>
      <div className="p-4">
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
            {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
          </div>
          <div className="overflow-x-auto">
            <Table className="min-w-[820px]">
              <TableHeader className="bg-muted/30">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    Session
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    Status
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    Driver
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    Device
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    Proof and sync
                  </TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-52 text-center">
                      <Play className="mx-auto h-6 w-6 text-muted-foreground" />
                      <p className="mt-2 text-sm font-medium">
                        No Route sessions yet
                      </p>
                    </TableCell>
                  </TableRow>
                ) : (
                  sessionsPageRows.map((session) => (
                    <TableRow key={session.id} className="hover:bg-muted/60">
                      <TableCell className="min-w-[260px] py-3">
                        <p className="text-sm font-medium text-foreground">
                          {session.name}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {session.context}
                        </p>
                      </TableCell>
                      <TableCell className="py-3">
                        <Badge
                          variant="outline"
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[11px] font-medium",
                            routeStatusClasses(session.status),
                          )}
                        >
                          {session.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-3 text-sm text-muted-foreground">
                        {session.owner}
                      </TableCell>
                      <TableCell className="py-3 text-sm">
                        {session.facts["Device state"] ?? "Not reported"}
                      </TableCell>
                      <TableCell className="py-3 text-sm text-muted-foreground">
                        {session.value}
                      </TableCell>
                      <TableCell className="py-3 text-right">
                        <Button variant="ghost" size="sm" asChild>
                          <Link
                            href={getBusinessModuleHref(
                              "operate",
                              "driver-app",
                              session.id,
                            )}
                          >
                            Open
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <TablePagination
            page={sessionsPage}
            pageCount={sessionsPageCount}
            totalCount={sessionsTotalCount}
            onPageChange={setSessionsPage}
          />
        </div>
      </div>
    </div>
  )
}

export function RouteDetailsPage({
  module,
  record,
  tickets,
  sessions,
  onBack,
  onAction,
  onEdit,
  onDelete,
  onReassign,
  readOnly = false,
}: {
  module: ModuleDefinition
  record: BusinessRecord
  tickets: readonly BusinessRecord[]
  sessions: readonly BusinessRecord[]
  onBack: () => void
  onAction: (action: string) => void
  onEdit?: () => void
  onDelete?: () => void
  /** Upserts the reassigned route and its cascaded open pickups; absent hides Reassign. */
  onReassign?: (updated: BusinessRecord, pickups: BusinessRecord[]) => void
  /** Hides every lifecycle and mutation control, e.g. for contractor scopes. */
  readOnly?: boolean
}) {
  const [reassignOpen, setReassignOpen] = useState(false)
  // Reassign is a scheme-route affordance (spec FR-12): the override-vs-default
  // semantics only exist on routes generation stamped with a scheme identity.
  const isSchemeGenerated = Boolean(stringValueOf(record, "schemeId"))
  const primaryAction =
    record.status === "Active"
      ? "Pause"
      : record.status === "Completed"
        ? "Reopen"
        : "Start"

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-border">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-accent" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Breadcrumbs
                  items={[
                    { label: module.label, onClick: onBack },
                    { label: record.name },
                  ]}
                />
                <Badge
                  variant="outline"
                  className={cn(
                    "rounded-full text-[11px]",
                    routeStatusClasses(record.status),
                  )}
                >
                  {record.status}
                </Badge>
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {record.context} · {routeDate(record)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!readOnly && (
              <Button size="sm" onClick={() => onAction(primaryAction)}>
                <Play className="h-4 w-4" weight="fill" />
                {primaryAction}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  Actions
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                {!readOnly &&
                  (record.allowedTransitions ?? module.lifecycle.slice(1, 3)).map(
                    (action) => (
                      <DropdownMenuItem
                        key={action}
                        onSelect={() => onAction(action)}
                      >
                        {action}
                      </DropdownMenuItem>
                    ),
                  )}
                {!readOnly && <DropdownMenuSeparator />}
                {onEdit && (
                  <DropdownMenuItem onSelect={onEdit}>
                    <PencilSimple className="h-4 w-4" />
                    Edit route
                  </DropdownMenuItem>
                )}
                {!readOnly && onReassign && isSchemeGenerated && (
                  <DropdownMenuItem onSelect={() => setReassignOpen(true)}>
                    <UserSwitch className="h-4 w-4" />
                    Reassign driver or vehicle
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onSelect={() =>
                    toast.success("Route export prepared", {
                      description: routeReference(record),
                    })
                  }
                >
                  <DownloadSimple className="h-4 w-4" />
                  Export route
                </DropdownMenuItem>
                {onDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={onDelete}
                    >
                      <Trash className="h-4 w-4" />
                      Delete route
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border/40 px-4 py-3">
          <div className="overflow-x-auto">
            <TabsList className="inline-flex h-8 rounded-full border border-border/50 bg-muted px-1 py-0.5 text-xs">
            <TabsTrigger
              value="overview"
              className="h-7 rounded-full px-3 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground"
            >
              Overview
            </TabsTrigger>
            <TabsTrigger
              value="tickets"
              className="h-7 rounded-full px-3 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground"
            >
              Tickets
              <span className="ml-1.5 text-[10px] text-muted-foreground">
                {tickets.length}
              </span>
            </TabsTrigger>
            <TabsTrigger
              value="sessions"
              className="h-7 rounded-full px-3 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground"
            >
              Sessions
              <span className="ml-1.5 text-[10px] text-muted-foreground">
                {sessions.length}
              </span>
            </TabsTrigger>
            </TabsList>
          </div>
        </div>
        <TabsContent value="overview" className="mt-0 min-h-0 flex-1">
          <OverviewTab
            record={record}
            onAction={onAction}
            onDelete={onDelete}
            readOnly={readOnly}
          />
        </TabsContent>
        <TabsContent value="tickets" className="mt-0 min-h-0 flex-1">
          <TicketsTab tickets={tickets} />
        </TabsContent>
        <TabsContent value="sessions" className="mt-0 min-h-0 flex-1">
          <SessionsTab sessions={sessions} />
        </TabsContent>
      </Tabs>

      {reassignOpen && onReassign && (
        <ReassignRouteDialog
          record={record}
          onClose={() => setReassignOpen(false)}
          onReassign={onReassign}
        />
      )}
    </div>
  )
}
