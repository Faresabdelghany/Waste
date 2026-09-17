"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import {
  ChartLine,
  CheckSquare,
  DownloadSimple,
  DotsThree,
  Funnel,
  Gear,
  ListBullets,
  MagnifyingGlass,
  MapTrifold,
  Plus,
  Printer,
  SquaresFour,
  Ticket,
  Trash,
  Wrench,
} from "@phosphor-icons/react/dist/ssr"

import type { BusinessRecord, ModuleDefinition } from "@/lib/data/business-modules"
import { serviceFrequencyOfRecord } from "@/lib/data/service-frequencies"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TablePagination, useTablePagination } from "@/components/ui/table-pagination"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAssetManagementStore } from "@/components/settings/asset-management-store"
import { canonicalCalendarName } from "@/components/wastehero/business-filter-popover"

export type ContainerProjectScope = "copenhagen" | "harbor" | "all"

type RegisterProps = {
  records: BusinessRecord[]
  projectScope: ContainerProjectScope
  fixedScopeLabel?: string
  onOpenRecord: (record: BusinessRecord) => void
  onAction: (record: BusinessRecord, action: string) => void
}

type ContainerProfile = {
  id: string
  type: string
  fractions: string
  address: string
  property: string
  project: string
  pickupMethod: string
  serviceFrequency: string
  calendar: string
  routeScheme: string
  fillLevel: string
  sensor: string
  battery: string
  lastMeasurement: string
  ownership: string
  rfid: string
  group: string
}

type ContainerGroup = {
  id: string
  name: string
  location: string
  members: number
  fractions: string
  routeScheme: string
}

const containerStatuses = [
  "Available",
  "On hold",
  "Future",
  "Ended",
  "Defect",
  "In storage",
  "In transit",
] as const

const initialGroups: ContainerGroup[] = [
  {
    id: "group-osterbro-east",
    name: "Østerbro East",
    location: "Parkvej service area",
    members: 18,
    fractions: "Organic · Residual",
    routeScheme: "Østerbro Organic B",
  },
  {
    id: "group-norrebro-north",
    name: "Nørrebro North",
    location: "Nørrebrogade corridor",
    members: 12,
    fractions: "Residual · Mixed",
    routeScheme: "Nørrebro Mixed",
  },
]

const mapPinPositions = [
  [31, 35],
  [57, 61],
  [23, 72],
  [69, 31],
  [44, 48],
  [77, 71],
  [14, 52],
] as const

const detailTabs = [
  ["configuration", "Configuration"],
  ["routes", "Routes"],
  ["collection-log", "Collection Log"],
  ["history", "History"],
  ["tickets", "Tickets"],
  ["property", "Property"],
  ["property-groups", "Property Groups"],
  ["invoices", "Invoices"],
  ["agreements", "Agreements"],
  ["temporary-changes", "Temporary changes"],
  ["stock-activity", "Stock activity"],
] as const

function fact(record: BusinessRecord, label: string, fallback = "—") {
  return record.facts[label] ?? fallback
}

function profileFor(record: BusinessRecord): ContainerProfile {
  const submitted = record.submittedValues ?? {}
  const text = (field: string): string => {
    const value = submitted[field]
    return typeof value === "string" ? value : ""
  }

  const primaryFraction = fact(
    record,
    "Primary waste fraction",
    text("wasteFraction") || "Not set",
  )
  const secondaryFraction = fact(
    record,
    "Additional waste fraction · order 2",
    text("secondaryWasteFraction") || "",
  )

  return {
    id: fact(record, "Container ID", record.name.split(" · ")[0]),
    type: fact(record, "Container type", text("containerType") || "Type pending"),
    fractions: fact(
      record,
      "Waste fractions",
      [primaryFraction, secondaryFraction].filter(Boolean).join(" · "),
    ),
    address: fact(
      record,
      "Address",
      fact(record, "Location or service address", text("serviceAddress") || record.context),
    ),
    property: fact(record, "Property"),
    project: fact(
      record,
      "Project",
      fact(
        record,
        "Operating project",
        record.context.includes("Harbor") ? "Harbor Commercial" : "Copenhagen Central",
      ),
    ),
    pickupMethod: fact(record, "Pickup method", text("pickupMethod") || "Disabled"),
    // Typed frequency reference first (issue #20); the legacy fallback chain
    // then covers pre-rename records (retired "Pickup setting" fact key) and
    // older form submissions that only have submittedValues (issue #13).
    serviceFrequency:
      serviceFrequencyOfRecord(record)?.name ??
      fact(record, "Service frequency", fact(record, "Pickup setting", text("pickupSetting"))),
    calendar: canonicalCalendarName(fact(record, "Collection calendar", text("collectionCalendar"))) ?? "—",
    routeScheme: fact(record, "Route scheme", text("routeScheme")),
    fillLevel: fact(record, "Fill level", record.value),
    sensor: fact(record, "Sensor", text("sensorIdentifier") || "None"),
    battery: fact(record, "Battery"),
    lastMeasurement: fact(record, "Last measurement", record.updated),
    ownership: fact(record, "Ownership", text("ownership")),
    rfid: fact(record, "RFID", text("rfid")),
    group: fact(record, "Group"),
  }
}

function statusClass(status: string) {
  const normalized = status.toLowerCase()
  if (normalized === "available") {
    return "border-transparent bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-100"
  }
  if (normalized === "defect" || normalized === "ended") {
    return "border-transparent bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-100"
  }
  if (normalized === "future" || normalized === "on hold" || normalized === "in transit") {
    return "border-transparent bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-100"
  }
  return "border-transparent bg-muted text-muted-foreground"
}

function fillClass(value: string) {
  const percentage = Number(value.match(/\d+/)?.[0] ?? 100)
  if (percentage <= 15) return "bg-teal-500"
  if (percentage > 95) return "bg-rose-500"
  if (percentage >= 80) return "bg-amber-500"
  return "bg-sky-500"
}

function toOptions(records: BusinessRecord[], key: keyof ContainerProfile) {
  return Array.from(
    new Set(records.map((record) => profileFor(record)[key]).filter((value) => value && value !== "—")),
  ).sort((left, right) => left.localeCompare(right))
}

export function ContainersAssetsRegister({
  records,
  projectScope,
  fixedScopeLabel,
  onOpenRecord,
  onAction,
}: RegisterProps) {
  const { containerTypes, wasteFractions } = useAssetManagementStore()
  const [registerMode, setRegisterMode] = useState<"containers" | "groups">("containers")
  const [view, setView] = useState<"list" | "map">("list")
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("all")
  const [typeFilter, setTypeFilter] = useState("all")
  const [fractionFilter, setFractionFilter] = useState("all")
  const [sensorFilter, setSensorFilter] = useState("all")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [groups, setGroups] = useState(initialGroups)
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [groupName, setGroupName] = useState("")
  const [groupLocation, setGroupLocation] = useState("")

  const selectedProjectId =
    projectScope === "all"
      ? null
      : projectScope === "harbor"
        ? "project-harbor"
        : "project-copenhagen"
  const types = useMemo(
    () =>
      Array.from(
        new Set([
          ...containerTypes
            .filter(
              (item) =>
                item.lifecycleStatus === "Active" &&
                (item.projectIds.length === 0 ||
                  selectedProjectId === null ||
                  item.projectIds.includes(selectedProjectId)),
            )
            .map((item) => item.name),
          ...toOptions(records, "type"),
        ]),
      ).sort((left, right) => left.localeCompare(right)),
    [containerTypes, records, selectedProjectId],
  )
  const fractions = useMemo(
    () =>
      Array.from(
        new Set([
          ...wasteFractions
            .filter(
              (item) =>
                item.status === "Active" &&
                (item.projectIds.length === 0 ||
                  selectedProjectId === null ||
                  item.projectIds.includes(selectedProjectId)),
            )
            .map((item) => item.name),
          ...records.flatMap((record) =>
            profileFor(record).fractions
              .split(" · ")
              .map((fraction) => fraction.trim())
              .filter(Boolean),
          ),
        ]),
      ).sort((left, right) => left.localeCompare(right)),
    [records, selectedProjectId, wasteFractions],
  )
  const filteredRecords = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return records.filter((record) => {
      const profile = profileFor(record)
      const searchable = [
        record.name,
        record.description,
        record.status,
        record.context,
        ...Object.values(record.facts),
      ]
        .join(" ")
        .toLowerCase()
      const sensorPaired = profile.sensor !== "None" && profile.sensor !== "Not fitted"
      return (
        (!needle || searchable.includes(needle)) &&
        (statusFilter === "all" || record.status === statusFilter) &&
        (typeFilter === "all" || profile.type === typeFilter) &&
        (fractionFilter === "all" ||
          profile.fractions.split(" · ").includes(fractionFilter)) &&
        (sensorFilter === "all" ||
          (sensorFilter === "paired" ? sensorPaired : !sensorPaired))
      )
    })
  }, [fractionFilter, query, records, sensorFilter, statusFilter, typeFilter])

  const activeFilterCount = [statusFilter, typeFilter, fractionFilter, sensorFilter].filter(
    (value) => value !== "all",
  ).length
  const allVisibleSelected =
    filteredRecords.length > 0 && filteredRecords.every((record) => selectedIds.has(record.id))

  useEffect(() => {
    const permittedIds = new Set(records.map((record) => record.id))
    setSelectedIds((current) => {
      const next = new Set(
        Array.from(current).filter((recordId) => permittedIds.has(recordId)),
      )
      return next.size === current.size ? current : next
    })
  }, [records])

  const toggleSelected = (recordId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(recordId)) next.delete(recordId)
      else next.add(recordId)
      return next
    })
  }

  const toggleAllVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allVisibleSelected) filteredRecords.forEach((record) => next.delete(record.id))
      else filteredRecords.forEach((record) => next.add(record.id))
      return next
    })
  }

  const clearFilters = () => {
    setStatusFilter("all")
    setTypeFilter("all")
    setFractionFilter("all")
    setSensorFilter("all")
  }

  const createGroup = () => {
    if (!groupName.trim() || !groupLocation.trim()) return
    setGroups((current) => [
      {
        id: `group-${Date.now()}`,
        name: groupName.trim(),
        location: groupLocation.trim(),
        members: 0,
        fractions: "Not configured",
        routeScheme: "Not configured",
      },
      ...current,
    ])
    setGroupDialogOpen(false)
    setGroupName("")
    setGroupLocation("")
    toast.success("Container group created", {
      description: "The group is ready for member assignment and configuration.",
    })
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-4">
      <section className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight">Containers</h1>
            <div className="inline-flex rounded-lg border border-border bg-muted/35 p-0.5">
              <Button
                variant={registerMode === "containers" ? "secondary" : "ghost"}
                size="sm"
                className="h-7 rounded-md px-3 text-xs"
                onClick={() => setRegisterMode("containers")}
              >
                Containers
              </Button>
              <Button
                variant={registerMode === "groups" ? "secondary" : "ghost"}
                size="sm"
                className="h-7 rounded-md px-3 text-xs"
                onClick={() => setRegisterMode("groups")}
              >
                Groups
              </Button>
            </div>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Physical container registry with agreement-driven status, collection configuration,
            optional sensor pairing, inventory state, and audited service history.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/settings?pane=asset-management&from=%2Fresources%3Fmodule%3Dcontainers">
              <Gear className="h-4 w-4" />
              Asset settings
            </Link>
          </Button>
          {registerMode === "containers" ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  toast.success("Bulk ticket workflow opened", {
                    description: "Create a property or container ticket for the current project scope.",
                  })
                }
              >
                <Ticket className="h-4 w-4" />
                Bulk ticket
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setGroupDialogOpen(true)}>
              <Plus className="h-4 w-4" weight="bold" />
              Create group
            </Button>
          )}
        </div>
      </section>

      {registerMode === "containers" ? (
        <>
          <section className="space-y-3 rounded-xl border border-border/60 bg-card p-3">
            <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <div className="relative min-w-[260px] flex-1 xl:max-w-md">
                  <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search ID, address, property, barcode, RFID or sensor"
                    className="h-9 pl-9"
                  />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Status" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    {containerStatuses.map((status) => <SelectItem key={status} value={status}>{status}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="h-9 w-[190px]"><SelectValue placeholder="Container type" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All container types</SelectItem>
                    {types.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={fractionFilter} onValueChange={setFractionFilter}>
                  <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="Waste fraction" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All fractions</SelectItem>
                    {fractions.map((fraction) => <SelectItem key={fraction} value={fraction}>{fraction}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={sensorFilter} onValueChange={setSensorFilter}>
                  <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Sensor" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any sensor</SelectItem>
                    <SelectItem value="paired">Has sensor</SelectItem>
                    <SelectItem value="unpaired">No sensor</SelectItem>
                  </SelectContent>
                </Select>
                {activeFilterCount > 0 ? (
                  <Button variant="ghost" size="sm" className="h-9" onClick={clearFilters}>
                    Clear {activeFilterCount}
                  </Button>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {fixedScopeLabel ? <Badge variant="outline">{fixedScopeLabel}</Badge> : null}
                <div className="inline-flex rounded-lg border border-border p-0.5">
                  <Button
                    variant={view === "list" ? "secondary" : "ghost"}
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Show container list"
                    onClick={() => setView("list")}
                  >
                    <ListBullets className="h-4 w-4" />
                  </Button>
                  <Button
                    variant={view === "map" ? "secondary" : "ghost"}
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Show container map"
                    onClick={() => setView("map")}
                  >
                    <MapTrifold className="h-4 w-4" />
                  </Button>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="h-9">
                      <DownloadSimple className="h-4 w-4" /> Export
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {["Filtered containers", "All containers", "Selected containers"].map((label) => (
                      <DropdownMenuItem
                        key={label}
                        disabled={label.startsWith("Selected") && selectedIds.size === 0}
                        onSelect={() => toast.success("Excel export queued", { description: `${label} · .xlsx` })}
                      >
                        {label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Funnel className="h-3.5 w-3.5" />
              Project · type · fraction · vehicle · service frequency · route scheme · calendar · status · property · sensor freshness
            </div>
          </section>

          {selectedIds.size > 0 ? (
            <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <CheckSquare className="h-5 w-5 text-primary" weight="fill" />
                {selectedIds.size} container{selectedIds.size === 1 ? "" : "s"} selected
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => toast.success("Selection ready for review")}>Review selection</Button>
                <Button variant="outline" size="sm" onClick={() => toast.success("Container ticket draft created")}>
                  <Ticket className="h-4 w-4" /> Create ticket
                </Button>
                <Button size="sm" onClick={() => toast.success("Label PDF generation queued", { description: `${selectedIds.size} barcodes` })}>
                  <Printer className="h-4 w-4" /> Print labels
                </Button>
              </div>
            </section>
          ) : null}

          {view === "map" ? (
            <ContainerMap records={filteredRecords} onOpenRecord={onOpenRecord} />
          ) : (
            <ContainerTable
              records={filteredRecords}
              selectedIds={selectedIds}
              allVisibleSelected={allVisibleSelected}
              onToggleAll={toggleAllVisible}
              onToggleSelected={toggleSelected}
              onOpenRecord={onOpenRecord}
              onAction={onAction}
            />
          )}
        </>
      ) : (
        <GroupsTable groups={groups} />
      )}

      <Dialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create container group</DialogTitle>
            <DialogDescription>
              Create a named cluster with its own location. Members remain independent containers.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="group-name">Group name</Label>
              <Input id="group-name" value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Østerbro East" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-location">Group location</Label>
              <Input id="group-location" value={groupLocation} onChange={(event) => setGroupLocation(event.target.value)} placeholder="Address or service area" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGroupDialogOpen(false)}>Cancel</Button>
            <Button disabled={!groupName.trim() || !groupLocation.trim()} onClick={createGroup}>Create group</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ContainerTable({
  records,
  selectedIds,
  allVisibleSelected,
  onToggleAll,
  onToggleSelected,
  onOpenRecord,
  onAction,
}: {
  records: BusinessRecord[]
  selectedIds: Set<string>
  allVisibleSelected: boolean
  onToggleAll: () => void
  onToggleSelected: (recordId: string) => void
  onOpenRecord: (record: BusinessRecord) => void
  onAction: (record: BusinessRecord, action: string) => void
}) {
  const { page, setPage, pageCount, pageRows, totalCount } = useTablePagination(records)

  return (
    <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
        {records.length} container{records.length === 1 ? "" : "s"} · last measurement shown in project time
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-11">
                <Checkbox checked={allVisibleSelected} onCheckedChange={onToggleAll} aria-label="Select all visible containers" />
              </TableHead>
              <TableHead>Container ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Waste fractions</TableHead>
              <TableHead>Container type</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Service frequency</TableHead>
              <TableHead>Route scheme</TableHead>
              <TableHead>Fill level</TableHead>
              <TableHead>Sensor</TableHead>
              <TableHead>Last measurement</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.length === 0 ? (
              <TableRow>
                <TableCell colSpan={12} className="h-52 text-center">
                  <MagnifyingGlass className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
                  <p className="text-sm font-medium">No containers match these filters</p>
                  <p className="mt-1 text-xs text-muted-foreground">Clear a filter or search another identifier.</p>
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((record) => {
                const profile = profileFor(record)
                const sensorPaired = profile.sensor !== "None" && profile.sensor !== "Not fitted"
                return (
                  <TableRow key={record.id} className="group cursor-pointer" onClick={() => onOpenRecord(record)}>
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.has(record.id)}
                        onCheckedChange={() => onToggleSelected(record.id)}
                        aria-label={`Select ${profile.id}`}
                      />
                    </TableCell>
                    <TableCell className="min-w-[145px] font-medium">
                      <div>{profile.id}</div>
                      <div className="mt-0.5 text-[11px] font-normal text-muted-foreground">{profile.rfid}</div>
                    </TableCell>
                    <TableCell><Badge variant="outline" className={cn("rounded-full text-[11px]", statusClass(record.status))}>{record.status}</Badge></TableCell>
                    <TableCell className="min-w-[140px]">{profile.fractions}</TableCell>
                    <TableCell className="min-w-[190px] text-muted-foreground">{profile.type}</TableCell>
                    <TableCell className="min-w-[230px] text-muted-foreground">{profile.address}</TableCell>
                    <TableCell className="min-w-[185px] text-muted-foreground">{profile.serviceFrequency}</TableCell>
                    <TableCell className="min-w-[170px] text-muted-foreground">{profile.routeScheme}</TableCell>
                    <TableCell>
                      <div className="flex min-w-[90px] items-center gap-2">
                        <span className={cn("h-2.5 w-2.5 rounded-full", fillClass(profile.fillLevel))} />
                        <span>{profile.fillLevel}</span>
                      </div>
                    </TableCell>
                    <TableCell className="min-w-[150px] text-muted-foreground">
                      <div>{profile.sensor}</div>
                      {sensorPaired ? <div className="mt-0.5 text-[11px]">Battery {profile.battery}</div> : null}
                    </TableCell>
                    <TableCell className="min-w-[145px] text-muted-foreground">{profile.lastMeasurement}</TableCell>
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Actions for ${profile.id}`}>
                            <DotsThree className="h-5 w-5" weight="bold" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => onOpenRecord(record)}>View container</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => toast.success("Label PDF generation queued", { description: profile.id })}>
                            <Printer className="h-4 w-4" /> Print label
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => onOpenRecord(record)}>Edit configuration</DropdownMenuItem>
                          {sensorPaired ? (
                            <DropdownMenuItem onSelect={() => onOpenRecord(record)}>
                              <ChartLine className="h-4 w-4" /> Show fill-level graph
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive" onSelect={() => onAction(record, "Delete container")}>
                            <Trash className="h-4 w-4" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
      <TablePagination
        page={page}
        pageCount={pageCount}
        totalCount={totalCount}
        onPageChange={setPage}
      />
    </section>
  )
}

function ContainerMap({
  records,
  onOpenRecord,
}: {
  records: BusinessRecord[]
  onOpenRecord: (record: BusinessRecord) => void
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <p className="text-sm font-medium">Container map</p>
          <p className="text-xs text-muted-foreground">Clustered service locations · collection calendar layer available</p>
        </div>
        <Badge variant="outline">{records.length} visible</Badge>
      </div>
      <div
        className="relative min-h-[560px] bg-cover bg-center"
        style={{ backgroundImage: "linear-gradient(rgb(255 255 255 / 0.08), rgb(255 255 255 / 0.08)), url('/route-map-copenhagen.png')" }}
      >
        {records.map((record, index) => {
          const profile = profileFor(record)
          const [left, top] = mapPinPositions[index % mapPinPositions.length]
          return (
            <button
              key={record.id}
              type="button"
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground shadow-lg transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{ left: `${left}%`, top: `${top}%` }}
              onClick={() => onOpenRecord(record)}
              aria-label={`Open ${profile.id} at ${profile.address}`}
              title={`${profile.id} · ${record.status} · ${profile.fillLevel}`}
            >
              {profile.id.replace("BIN-", "")}
            </button>
          )
        })}
      </div>
    </section>
  )
}

function GroupsTable({ groups }: { groups: ContainerGroup[] }) {
  const {
    page: groupsPage,
    setPage: setGroupsPage,
    pageCount: groupsPageCount,
    pageRows: groupsPageRows,
    totalCount: groupsTotalCount,
  } = useTablePagination(groups)

  return (
    <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
        {groups.length} container groups · office users only
      </div>
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead>Group</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Members</TableHead>
            <TableHead>Waste fractions</TableHead>
            <TableHead>Route scheme</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groupsPageRows.map((group) => (
            <TableRow key={group.id}>
              <TableCell className="font-medium">{group.name}</TableCell>
              <TableCell className="text-muted-foreground">{group.location}</TableCell>
              <TableCell>{group.members}</TableCell>
              <TableCell>{group.fractions}</TableCell>
              <TableCell>{group.routeScheme}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <TablePagination
        page={groupsPage}
        pageCount={groupsPageCount}
        totalCount={groupsTotalCount}
        onPageChange={setGroupsPage}
      />
    </section>
  )
}

// Pre-rename user-created records keep facts under retired keys and drifted
// calendar names (issue #13).
const legacyFactKeys: Record<string, string> = {
  "Service frequency": "Pickup setting",
}

function factWithLegacyFallback(record: BusinessRecord, label: string) {
  // The typed frequency reference outranks any stored fact string (issue #20).
  if (label === "Service frequency") {
    const definition = serviceFrequencyOfRecord(record)
    if (definition) return definition.name
  }
  const value = legacyFactKeys[label]
    ? fact(record, label, fact(record, legacyFactKeys[label]))
    : fact(record, label)
  return label === "Collection calendar" ? canonicalCalendarName(value) ?? "—" : value
}

function FactGrid({ record, labels }: { record: BusinessRecord; labels: readonly string[] }) {
  return (
    <dl className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
      {labels.map((label) => (
        <div key={label} className="min-w-0 border-b border-border/60 pb-3">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-1 break-words text-sm font-medium">{factWithLegacyFallback(record, label)}</dd>
        </div>
      ))}
    </dl>
  )
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-border/60 p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

export function ContainerDetailsSheet({
  module,
  record,
  onClose,
  onAction,
}: {
  module: ModuleDefinition
  record: BusinessRecord | null
  onClose: () => void
  onAction: (action: string) => void
}) {
  const [activeTab, setActiveTab] = useState("configuration")
  const profile = record ? profileFor(record) : null
  const temporaryLocation = record ? fact(record, "Temporary location") : "None"
  const hasGroup = Boolean(profile && profile.group !== "—")

  return (
    <Sheet open={Boolean(record)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-5xl">
        {record && profile ? (
          <>
            <SheetHeader className="border-b border-border px-5 py-4 pr-12 text-left">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={cn("rounded-full", statusClass(record.status))}>{record.status}</Badge>
                <Badge variant="outline" className="rounded-full font-normal">{profile.project}</Badge>
                {fact(record, "Warranty end") !== "—" ? <Badge variant="outline" className="rounded-full font-normal">Warranty to {fact(record, "Warranty end")}</Badge> : null}
                {temporaryLocation !== "None" && temporaryLocation !== "—" ? (
                  <Badge className="rounded-full bg-violet-100 text-violet-700 hover:bg-violet-100 dark:bg-violet-500/20 dark:text-violet-100">
                    Temporary location · {temporaryLocation}
                  </Badge>
                ) : null}
              </div>
              <SheetTitle className="pt-1 text-xl">{profile.id}</SheetTitle>
              <SheetDescription>{profile.type} · {profile.fractions} · {profile.address}</SheetDescription>
            </SheetHeader>

            <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
              <div className="overflow-x-auto border-b border-border px-4 py-2">
                <TabsList className="inline-flex h-9 min-w-max bg-muted/70">
                  {detailTabs.map(([value, label]) => (
                    <TabsTrigger key={value} value={value} disabled={value === "property-groups" && !hasGroup} className="text-xs">
                      {label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
                <TabsContent value="configuration" className="mt-0 space-y-4">
                  <DetailSection title="Basic">
                    <FactGrid record={record} labels={["Container ID", "Barcode", "RFID", "Serial number", "Project", "Container type", "Waste fractions", "Ownership", "Warranty end", "Condition"]} />
                  </DetailSection>
                  <DetailSection title="Location">
                    <FactGrid record={record} labels={["Address", "Curb location", "Property", "Property number", "Property type", "Group", "Storage depot"]} />
                  </DetailSection>
                  <DetailSection title="Pickup">
                    <FactGrid record={record} labels={["Pickup method", "Service frequency", "Collection calendar", "Last collection", "Next collection"]} />
                  </DetailSection>
                  <DetailSection title="Route">
                    <FactGrid record={record} labels={["Route scheme", "Vehicle"]} />
                  </DetailSection>
                  <DetailSection title="Sensors">
                    <FactGrid record={record} labels={["Sensor", "Measurement setting", "Battery", "RSSI", "Fill level", "Last measurement", "Full threshold"]} />
                    {profile.sensor !== "None" && profile.sensor !== "Not fitted" ? (
                      <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
                        <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
                          <span>Fill level · last 24 hours</span><span>{profile.lastMeasurement}</span>
                        </div>
                        <div className="flex h-24 items-end gap-2">
                          {[48, 54, 61, 68, 72, 79, Number(profile.fillLevel.match(/\d+/)?.[0] ?? 87)].map((height, index) => (
                            <div key={`${height}-${index}`} className="flex-1 rounded-t bg-primary/70" style={{ height: `${Math.max(8, height)}%` }} />
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-amber-700 dark:text-amber-200">No sensor is paired. Fill percentage defaults to 100% in backend calculations.</p>
                    )}
                  </DetailSection>
                  <DetailSection title="Others">
                    <p className="text-sm text-muted-foreground">{record.description}</p>
                    <FactGrid record={record} labels={["External reference", "Driver description"]} />
                  </DetailSection>
                </TabsContent>

                <TabsContent value="routes" className="mt-0 space-y-4">
                  <DetailSection title="Routes · last 7 days">
                    <FactGrid record={record} labels={["Route scheme", "Vehicle", "Last collection", "Next collection"]} />
                    <p className="text-xs text-muted-foreground">Dynamic routing uses fill prediction when available and falls back to the static candidate list.</p>
                  </DetailSection>
                </TabsContent>

                <TabsContent value="collection-log" className="mt-0">
                  <DetailSection title="Pickup-order service log">
                    <FactGrid
                      record={record}
                      labels={["Last recorded weight", "Weight date"]}
                    />
                    {[fact(record, "Last collection"), "Previous service · completed", "Earlier service · completed"].map((entry, index) => (
                      <div key={`${entry}-${index}`} className="flex items-center justify-between border-b border-border/60 py-3 last:border-0">
                        <span className="text-sm">{entry}</span><Badge variant="outline">{index === 0 ? "Latest" : "Collected"}</Badge>
                      </div>
                    ))}
                  </DetailSection>
                </TabsContent>

                <TabsContent value="history" className="mt-0">
                  <DetailSection title="Audited event history">
                    {["Status synchronized from agreement", "Collection configuration updated", "Location confirmed", "Container created"].map((event, index) => (
                      <div key={event} className="grid grid-cols-[18px_1fr] gap-3 pb-5 last:pb-0">
                        <span className={cn("mt-1 h-2.5 w-2.5 rounded-full", index === 0 ? "bg-primary" : "bg-muted-foreground/35")} />
                        <div><p className="text-sm font-medium">{event}</p><p className="mt-1 text-xs text-muted-foreground">{index === 0 ? record.updated : `${index * 3 + 2} months ago`} · Olivia Larsen · before/after retained</p></div>
                      </div>
                    ))}
                    <Button variant="outline" size="sm" onClick={() => toast.success("Container history PDF queued")}>Download history PDF</Button>
                  </DetailSection>
                </TabsContent>

                <TabsContent value="tickets" className="mt-0">
                  <DetailSection title="Container tickets">
                    <p className="text-sm">{record.related.find((item) => item.startsWith("Ticket")) ?? "No open container tickets"}</p>
                    <Button size="sm" onClick={() => onAction("Create container ticket")}><Ticket className="h-4 w-4" /> Create ticket</Button>
                  </DetailSection>
                </TabsContent>

                <TabsContent value="property" className="mt-0">
                  <DetailSection title="Linked property">
                    <FactGrid record={record} labels={["Property", "Property number", "Property type", "Address", "Agreement"]} />
                  </DetailSection>
                </TabsContent>

                <TabsContent value="property-groups" className="mt-0">
                  <DetailSection title="Property groups"><p className="text-sm font-medium">{profile.group}</p></DetailSection>
                </TabsContent>

                <TabsContent value="invoices" className="mt-0">
                  <DetailSection title="Invoices"><p className="text-sm text-muted-foreground">Invoices are resolved through the container agreement and linked property payer.</p></DetailSection>
                </TabsContent>

                <TabsContent value="agreements" className="mt-0">
                  <DetailSection title="Agreements">
                    <FactGrid record={record} labels={["Agreement", "Property", "Waste fractions", "Container type"]} />
                    <p className="text-xs text-muted-foreground">Active, future, ended, and fallback agreement states synchronize the displayed container status.</p>
                  </DetailSection>
                </TabsContent>

                <TabsContent value="temporary-changes" className="mt-0">
                  <DetailSection title="Temporary location changes">
                    <p className="text-sm">{temporaryLocation === "None" ? "No scheduled or active temporary relocation." : temporaryLocation}</p>
                    <p className="text-xs text-muted-foreground">Reasons: equipment failure, roadworks, event, or other. Changes move through Scheduled, Active, and Reverted.</p>
                    <Button variant="outline" size="sm" onClick={() => toast.success("Temporary-change workflow opened")}>Create temporary change</Button>
                  </DetailSection>
                </TabsContent>

                <TabsContent value="stock-activity" className="mt-0 space-y-4">
                  <DetailSection title="Condition and maintenance">
                    <FactGrid record={record} labels={["Condition", "Storage depot"]} />
                    <Button variant="outline" size="sm" onClick={() => onAction("Defect")}><Wrench className="h-4 w-4" /> Record condition</Button>
                  </DetailSection>
                  <DetailSection title="Lifecycle stock activity">
                    <p className="text-sm">{record.related.find((item) => item.startsWith("Stock")) ?? "No stock movements linked"}</p>
                    <p className="text-xs text-muted-foreground">Stock movements are append-only. A DECOMMISSION movement makes an Ended container terminal.</p>
                  </DetailSection>
                </TabsContent>
              </div>
            </Tabs>

            <SheetFooter className="flex-row items-center justify-between border-t border-border px-5 py-4">
              <Button variant="ghost" onClick={onClose}>Close</Button>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" onClick={() => toast.success("Label PDF generation queued", { description: profile.id })}>
                  <Printer className="h-4 w-4" /> Print label
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button>Actions <DotsThree className="h-4 w-4" /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setActiveTab("configuration")}>Edit configuration</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onAction("Create container ticket")}>Create container ticket</DropdownMenuItem>
                    {record.status !== "Defect" ? <DropdownMenuItem onSelect={() => onAction("Defect")}>Mark defect</DropdownMenuItem> : null}
                    {record.status !== "In storage" ? <DropdownMenuItem onSelect={() => onAction("In storage")}>Move to storage</DropdownMenuItem> : null}
                    {record.status !== "In transit" ? <DropdownMenuItem onSelect={() => onAction("In transit")}>Move in transit</DropdownMenuItem> : null}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive" onSelect={() => onAction("Delete container")}><Trash className="h-4 w-4" /> Delete container</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
