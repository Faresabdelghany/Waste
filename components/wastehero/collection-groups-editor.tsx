"use client"

// Collection groups editor (docs/new-changes/SPEC.md area L, DECISIONS.md
// D33–D36): the hub-and-spoke surface that defines a Route Scheme's
// collection groups — the hub is a service-day coverage strip plus one
// summary row per group (the "every service day has at least one group"
// invariant made visible), the spoke edits one group at a time: name, days,
// vehicle, default driver, optional service provider, and the stop source —
// a matching rule (the normal path) or hand-picked containers (the explicit
// exception). Shared by the Guided Setup wizard step and the scheme page's
// "Edit collection groups" dialog so both surfaces edit the same shape.

import { useEffect, useMemo, useState } from "react"
import { Check, MagnifyingGlass, Plus, Trash } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useModuleRecords } from "@/components/wastehero/scheme-route-map"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { PLANNING_AREAS_MODULE } from "@/lib/data/planning-areas"
import {
  collectionGroupCoverage,
  collectionGroupsOfRecord,
  collectionGroupsToValues,
  issuesByGroup,
  resolveCollectionGroupPlans,
  type CollectionGroup,
  type CollectionGroupResolution,
} from "@/lib/route-schemes/groups"
import { schemeLiveValidation } from "@/lib/route-schemes/lifecycle"
import {
  STOP_MATCH_VEHICLE_TYPES,
  resolveStopMatches,
  type StopMatchRule,
} from "@/lib/route-schemes/matching"
import {
  SERVICE_DAY_SHORT_LABELS,
  serviceDaysFromValues,
  sortServiceDays,
  type ServiceDay,
} from "@/lib/route-schemes/recurrence"
import { cn } from "@/lib/utils"

/* ------------------------------ shared inputs ------------------------------ */

export function RecordSelect({
  label,
  placeholder,
  records,
  value,
  onChange,
  hint,
}: {
  label: string
  placeholder: string
  records: BusinessRecord[]
  value?: string
  onChange: (value: string) => void
  hint?: string
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {records.map((record) => (
            <SelectItem key={record.id} value={record.id}>
              {record.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * The declarative rule editor + live match preview (issue #19): waste
 * fraction chips, an optional vehicle-type constraint, and the containers the
 * rule currently resolves to inside the scheme's planning area — matched list,
 * near-miss exclusions with reasons, and a loud zero-match empty state.
 */
export function SchemeRuleEditor({
  containers,
  areaId,
  areaName,
  projectIds,
  rule,
  onChange,
}: {
  containers: BusinessRecord[]
  areaId?: string
  areaName?: string
  projectIds?: string[]
  rule: StopMatchRule
  onChange: (rule: StopMatchRule) => void
}) {
  const fractionOptions = useMemo(() => {
    const values = new Set<string>(rule.fractions)
    for (const container of containers) {
      const fact = container.facts?.["Waste fractions"]
      if (!fact || fact === "—") continue
      for (const part of fact.split("·")) {
        const trimmed = part.trim()
        if (trimmed) values.add(trimmed)
      }
    }
    return Array.from(values).sort()
  }, [containers, rule.fractions])

  const toggleFraction = (fraction: string) => {
    onChange({
      ...rule,
      fractions: rule.fractions.includes(fraction)
        ? rule.fractions.filter((candidate) => candidate !== fraction)
        : [...rule.fractions, fraction],
    })
  }

  const result = useMemo(
    () => resolveStopMatches({ rule, areaId, projectIds, containers }),
    [rule, areaId, projectIds, containers],
  )

  return (
    <div className="space-y-3 rounded-2xl border border-border/60 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">Stop matching rule</p>
        <p className="text-sm font-medium text-primary">
          {result.matched.length} matching
        </p>
      </div>

      {areaId ? (
        <p className="text-xs text-muted-foreground">
          Matching inside{" "}
          <span className="font-semibold text-foreground">
            {areaName ?? "the selected planning area"}
          </span>{" "}
          — containers carry their planning area; the scheme&apos;s area bounds
          the rule.
        </p>
      ) : (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          No planning area selected — go back to the Scheme &amp; scope step and
          pick one. The rule matches containers inside the scheme&apos;s area.
        </p>
      )}

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Waste fractions</Label>
        <div className="flex flex-wrap gap-2">
          {fractionOptions.map((fraction) => {
            const isOn = rule.fractions.includes(fraction)
            return (
              <button
                key={fraction}
                type="button"
                onClick={() => toggleFraction(fraction)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  isOn
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground hover:border-primary/50",
                )}
              >
                {fraction}
              </button>
            )
          })}
        </div>
      </div>

      <div className="max-w-xs space-y-1.5">
        <Label className="text-xs text-muted-foreground">Vehicle type</Label>
        <Select
          value={rule.vehicleType ?? "any"}
          onValueChange={(value) =>
            onChange(
              value === "any"
                ? { fractions: rule.fractions }
                : { ...rule, vehicleType: value },
            )
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any vehicle type</SelectItem>
            {STOP_MATCH_VEHICLE_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Only containers this vehicle type can service are matched.
        </p>
      </div>

      <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
        {rule.fractions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Pick at least one waste fraction — the rule is the fraction
            selection.
          </p>
        ) : result.matched.length === 0 ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-4 text-center">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              No containers currently match this rule
            </p>
            <p className="mt-1 text-xs text-amber-700/80 dark:text-amber-400/80">
              {areaId
                ? `${result.scopeTotal} container${result.scopeTotal === 1 ? "" : "s"} in the planning area — none matches the fractions${rule.vehicleType ? ` and ${rule.vehicleType.toLowerCase()} compatibility` : ""}. The scheme cannot validate until the rule matches.`
                : "Pick a planning area first."}
            </p>
          </div>
        ) : (
          result.matched.map((profile) => {
            const container = containers.find(
              (candidate) => candidate.id === profile.id,
            )
            return (
              <div
                key={profile.id}
                className="flex w-full items-center gap-3 rounded-xl border border-border/60 px-3 py-2 text-left"
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-primary bg-primary text-primary-foreground">
                  <Check className="h-3 w-3" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {profile.name}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {profile.fractions.join(" · ")}
                    </span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {container?.facts?.Address ?? container?.context ?? ""}
                    {profile.containerType ? ` · ${profile.containerType}` : ""}
                  </p>
                </div>
              </div>
            )
          })
        )}
      </div>

      {result.excluded.length > 0 && (
        <div className="space-y-1 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
          <p className="text-xs font-medium text-muted-foreground">
            {result.excluded.length} matching-fraction container
            {result.excluded.length === 1 ? "" : "s"} excluded
          </p>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {result.excluded.slice(0, 6).map((exclusion) => (
              <li key={exclusion.id} className="truncate">
                <span className="font-medium text-foreground/80">
                  {exclusion.name}
                </span>{" "}
                — {exclusion.reason}
              </li>
            ))}
            {result.excluded.length > 6 && (
              <li>… and {result.excluded.length - 6} more</li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

export function SchemeContainerPicker({
  containers,
  defaultProject,
  pickedIds,
  onPick,
}: {
  containers: BusinessRecord[]
  defaultProject?: string
  pickedIds: string[]
  onPick: (ids: string[]) => void
}) {
  const [search, setSearch] = useState("")
  const [projectFilter, setProjectFilter] = useState(defaultProject ?? "all")
  const [fractionFilter, setFractionFilter] = useState("all")
  const [typeFilter, setTypeFilter] = useState("all")

  const factOptions = (fact: string) => {
    const values = new Set<string>()
    for (const container of containers) {
      const value = container.facts?.[fact]
      if (value && value !== "—") values.add(value)
    }
    return Array.from(values).sort()
  }
  const projectOptions = useMemo(() => factOptions("Project"), [containers]) // eslint-disable-line react-hooks/exhaustive-deps
  const fractionOptions = useMemo(() => factOptions("Waste fractions"), [containers]) // eslint-disable-line react-hooks/exhaustive-deps
  const typeOptions = useMemo(() => factOptions("Container type"), [containers]) // eslint-disable-line react-hooks/exhaustive-deps

  const matches = useMemo(() => {
    const query = search.trim().toLowerCase()
    return containers.filter((container) => {
      const facts = container.facts ?? {}
      if (projectFilter !== "all" && facts.Project !== projectFilter) return false
      if (fractionFilter !== "all" && facts["Waste fractions"] !== fractionFilter) {
        return false
      }
      if (typeFilter !== "all" && facts["Container type"] !== typeFilter) return false
      if (!query) return true
      return (
        container.name.toLowerCase().includes(query) ||
        (facts.Address ?? "").toLowerCase().includes(query)
      )
    })
  }, [containers, fractionFilter, projectFilter, search, typeFilter])

  const allMatchesPicked =
    matches.length > 0 && matches.every((container) => pickedIds.includes(container.id))
  const toggleAllMatches = () => {
    onPick(
      allMatchesPicked
        ? pickedIds.filter((id) => !matches.some((container) => container.id === id))
        : Array.from(new Set([...pickedIds, ...matches.map((container) => container.id)])),
    )
  }

  const toggleContainer = (containerId: string) => {
    onPick(
      pickedIds.includes(containerId)
        ? pickedIds.filter((id) => id !== containerId)
        : [...pickedIds, containerId],
    )
  }

  const filterSelect = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: string[],
  ) => (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  return (
    <div className="space-y-3 rounded-2xl border border-border/60 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">Pick containers</p>
        <p className="text-sm font-medium text-primary">
          {pickedIds.length} picked
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {filterSelect("Project", projectFilter, setProjectFilter, projectOptions)}
        {filterSelect("Waste fraction", fractionFilter, setFractionFilter, fractionOptions)}
        {filterSelect("Container type", typeFilter, setTypeFilter, typeOptions)}
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by container ID or address"
            className="pl-9"
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={matches.length === 0}
          onClick={toggleAllMatches}
        >
          {allMatchesPicked ? "Clear filtered" : `Add all filtered (${matches.length})`}
        </Button>
      </div>

      <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
        {matches.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No containers match this filter.
          </p>
        ) : (
          matches.map((container) => {
            const isPicked = pickedIds.includes(container.id)
            return (
              <button
                key={container.id}
                type="button"
                onClick={() => toggleContainer(container.id)}
                className="flex w-full items-center gap-3 rounded-xl border border-border/60 px-3 py-2 text-left transition-colors hover:bg-muted/50"
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                    isPicked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border",
                  )}
                >
                  {isPicked && <Check className="h-3 w-3" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {container.name}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {container.facts?.["Waste fractions"] ?? ""}
                    </span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {container.facts?.Address ?? container.context}
                    {container.facts?.["Container type"]
                      ? ` · ${container.facts["Container type"]}`
                      : ""}
                  </p>
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}


/* ------------------------------ group helpers ------------------------------ */

/** The next free `group-N` id — stable within the scheme, never Date.now(). */
export function nextCollectionGroupId(groups: readonly CollectionGroup[]): string {
  const max = groups.reduce((highest, group) => {
    const match = /^group-(\d+)$/.exec(group.id)
    return match ? Math.max(highest, Number(match[1])) : highest
  }, 0)
  return `group-${max + 1}`
}

/**
 * A fresh group: it takes the service days no group covers yet (so adding a
 * group closes the coverage gap by default), else every service day.
 */
export function newCollectionGroup(
  groups: readonly CollectionGroup[],
  serviceDays: readonly ServiceDay[],
): CollectionGroup {
  const uncovered = collectionGroupCoverage(serviceDays, groups)
    .filter((entry) => entry.groupIds.length === 0)
    .map((entry) => entry.day)
  const id = nextCollectionGroupId(groups)
  return {
    id,
    name: `Group ${id.replace("group-", "")}`,
    days: uncovered.length > 0 ? uncovered : sortServiceDays(serviceDays),
    fractions: [],
    stopSource: "rule",
    containerIds: [],
  }
}

/**
 * Per-group "Wed 12 · Sun 11" container counts from a resolution — matches
 * and picks, never Stops (those exist only on generated routes).
 */
export function groupContainerCounts(
  group: CollectionGroup,
  resolution: CollectionGroupResolution,
): string {
  const plans = resolution.plans.filter((plan) => plan.groupId === group.id)
  if (plans.length === 0) return "No service days"
  return plans
    .map((plan) => `${SERVICE_DAY_SHORT_LABELS[plan.day]} ${plan.containerIds.length}`)
    .join(" · ")
}

/* ---------------------------------- hub ----------------------------------- */

export function CollectionGroupsEditor({
  groups,
  onChange,
  serviceDays,
  planningAreaId,
  projectId,
  issues = [],
}: {
  groups: CollectionGroup[]
  onChange: (groups: CollectionGroup[]) => void
  serviceDays: readonly ServiceDay[]
  planningAreaId?: string
  projectId?: string
  /** Live validation issues — the ones naming a group show on its row. */
  issues?: readonly string[]
}) {
  const containers = useModuleRecords("resources", "containers")
  const vehicles = useModuleRecords("fleet", "vehicles")
  const drivers = useModuleRecords("fleet", "drivers")
  const serviceProviders = useModuleRecords("service-providers", "service-providers")
  const areas = useModuleRecords(PLANNING_AREAS_MODULE.workspaceId, PLANNING_AREAS_MODULE.moduleId)
  const projects = useModuleRecords("configure", "organization")
  const days = sortServiceDays(serviceDays)
  const [selectedId, setSelectedId] = useState<string | null>(groups[0]?.id ?? null)

  useEffect(() => {
    if (selectedId && !groups.some((group) => group.id === selectedId)) {
      setSelectedId(groups[0]?.id ?? null)
    }
  }, [groups, selectedId])

  const resolution = useMemo(
    () =>
      resolveCollectionGroupPlans({
        groups,
        serviceDays: days,
        areaId: planningAreaId,
        projectIds: projectId ? [projectId] : undefined,
        containers,
      }),
    [containers, days, groups, planningAreaId, projectId],
  )
  const coverage = collectionGroupCoverage(days, groups)
  const attributedIssues = useMemo(() => issuesByGroup(groups, issues), [groups, issues])
  const selected = groups.find((group) => group.id === selectedId) ?? null

  const updateGroup = (id: string, updates: Partial<CollectionGroup>) => {
    onChange(groups.map((group) => (group.id === id ? { ...group, ...updates } : group)))
  }
  const addGroup = () => {
    const group = newCollectionGroup(groups, days)
    onChange([...groups, group])
    setSelectedId(group.id)
  }
  const removeGroup = (id: string) => {
    onChange(groups.filter((group) => group.id !== id))
  }

  const nameOf = (records: readonly BusinessRecord[], id?: string) =>
    records.find((record) => record.id === id)?.name

  if (days.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Pick at least one service day in the Recurrence step first — each
        collection group runs on a subset of the scheme&apos;s service days.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {/* Coverage strip — the "every service day has at least one group" invariant. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Coverage</span>
        {coverage.map((entry) => (
          <span
            key={entry.day}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
              entry.groupIds.length === 0
                ? "border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-400"
                : "border-border bg-muted/40 text-foreground",
            )}
            title={
              entry.groupIds.length === 0
                ? "No collection group runs on this day"
                : entry.groupIds
                    .map((id) => groups.find((group) => group.id === id)?.name ?? id)
                    .join(", ")
            }
          >
            {SERVICE_DAY_SHORT_LABELS[entry.day]}
            <span className="font-mono">{entry.groupIds.length}</span>
          </span>
        ))}
      </div>

      {/* Hub — one summary row per group. */}
      <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60">
        {groups.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No collection groups yet — add one to define who collects which
            containers on which days.
          </p>
        )}
        {groups.map((group) => {
          const groupIssues = attributedIssues.get(group.id) ?? []
          const isSelected = group.id === selectedId
          return (
            <div
              key={group.id}
              className={cn(
                "flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 text-sm",
                isSelected && "bg-muted/40",
              )}
            >
              <button
                type="button"
                onClick={() => setSelectedId(isSelected ? null : group.id)}
                className="min-w-0 flex-1 text-left"
              >
                <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                  {group.name}
                  <span className="text-xs font-normal text-muted-foreground">
                    {group.days.map((day) => SERVICE_DAY_SHORT_LABELS[day]).join(", ") ||
                      "No days"}
                  </span>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                      group.stopSource === "rule"
                        ? "border-primary/40 text-primary"
                        : "border-amber-500/50 text-amber-700 dark:text-amber-400",
                    )}
                  >
                    {group.stopSource === "rule" ? "Matched by rule" : "Picked manually"}
                  </span>
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {[
                    group.fractions.length > 0 ? group.fractions.join(", ") : null,
                    nameOf(vehicles, group.vehicleId) ?? "No vehicle",
                    nameOf(drivers, group.driverId) ?? "No driver",
                    nameOf(serviceProviders, group.serviceProviderId) ?? "In-house",
                    groupContainerCounts(group, resolution),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {groupIssues.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs text-red-600 dark:text-red-400">
                    {groupIssues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                )}
              </button>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant={isSelected ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setSelectedId(isSelected ? null : group.id)}
                >
                  {isSelected ? "Done" : "Edit"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => removeGroup(group.id)}
                  title="Remove group"
                >
                  <Trash className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )
        })}
        <div className="px-4 py-2">
          <Button type="button" variant="outline" size="sm" onClick={addGroup}>
            <Plus className="h-4 w-4" weight="bold" />
            Add collection group
          </Button>
        </div>
      </div>

      {/* Spoke — the selected group's editor. */}
      {selected && (
        <CollectionGroupSpoke
          key={selected.id}
          group={selected}
          days={days}
          containers={containers}
          vehicles={vehicles}
          drivers={drivers}
          serviceProviders={serviceProviders}
          areaId={planningAreaId}
          areaName={areas.find((area) => area.id === planningAreaId)?.name}
          projectIds={projectId ? [projectId] : undefined}
          projectName={projects.find((project) => project.id === projectId)?.name}
          onChange={(updates) => updateGroup(selected.id, updates)}
        />
      )}
    </div>
  )
}

/* ---------------------------------- spoke --------------------------------- */

function CollectionGroupSpoke({
  group,
  days,
  containers,
  vehicles,
  drivers,
  serviceProviders,
  areaId,
  areaName,
  projectIds,
  projectName,
  onChange,
}: {
  group: CollectionGroup
  days: readonly ServiceDay[]
  containers: BusinessRecord[]
  vehicles: BusinessRecord[]
  drivers: BusinessRecord[]
  serviceProviders: BusinessRecord[]
  areaId?: string
  areaName?: string
  projectIds?: string[]
  projectName?: string
  onChange: (updates: Partial<CollectionGroup>) => void
}) {
  const rule: StopMatchRule = {
    fractions: group.fractions,
    ...(group.ruleVehicleType ? { vehicleType: group.ruleVehicleType } : {}),
  }
  const toggleDay = (day: ServiceDay) => {
    onChange({
      days: group.days.includes(day)
        ? group.days.filter((candidate) => candidate !== day)
        : sortServiceDays([...group.days, day]),
    })
  }
  // Display names are denormalized onto the group at pick time so generation
  // stamps them without a record lookup (the record's facts do the same).
  const pick = (
    records: readonly BusinessRecord[],
    idKey: "vehicleId" | "driverId" | "serviceProviderId",
    nameKey: "vehicleName" | "driverName" | "serviceProviderName",
    id: string,
  ) => {
    const record = records.find((candidate) => candidate.id === id)
    // Vehicle names carry the registration plate; facts show the callsign.
    const name =
      idKey === "vehicleId" ? record?.name.split(" · ")[0] : record?.name
    onChange({ [idKey]: id || undefined, [nameKey]: name })
  }

  return (
    <div className="space-y-4 rounded-2xl border border-primary/30 bg-background p-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label>Group name</Label>
          <Input
            value={group.name}
            onChange={(event) => onChange({ name: event.target.value })}
            placeholder="e.g. Organic bins"
          />
        </div>
        <div className="space-y-2">
          <Label>Runs on</Label>
          <div className="flex flex-wrap gap-1.5">
            {days.map((day) => {
              const isOn = group.days.includes(day)
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => toggleDay(day)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    isOn
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:border-primary/50",
                  )}
                >
                  {SERVICE_DAY_SHORT_LABELS[day]}
                </button>
              )
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            A subset of the scheme&apos;s service days — one route is generated
            per group per day it runs on.
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <RecordSelect
          label="Vehicle"
          placeholder="Select vehicle"
          records={vehicles}
          value={group.vehicleId}
          onChange={(id) => pick(vehicles, "vehicleId", "vehicleName", id)}
        />
        <RecordSelect
          label="Default driver"
          placeholder="Select driver"
          records={drivers}
          value={group.driverId}
          onChange={(id) => pick(drivers, "driverId", "driverName", id)}
          hint="Required to validate; refined per route at dispatch."
        />
        <RecordSelect
          label="Service provider (optional)"
          placeholder="In-house"
          records={serviceProviders}
          value={group.serviceProviderId}
          onChange={(id) => pick(serviceProviders, "serviceProviderId", "serviceProviderName", id)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={group.stopSource === "rule" ? "secondary" : "outline"}
          onClick={() => onChange({ stopSource: "rule", containerIds: [] })}
        >
          Match by rule
        </Button>
        <Button
          type="button"
          size="sm"
          variant={group.stopSource === "manual" ? "secondary" : "outline"}
          onClick={() => onChange({ stopSource: "manual", ruleVehicleType: undefined })}
        >
          Pick containers manually
        </Button>
        <p className="basis-full text-xs text-muted-foreground">
          {group.stopSource === "rule"
            ? "The group stores its selection rule — matching containers are resolved every time routes are generated. A container another group already collects that day is left to that group."
            : "The exception path: the group stores its picked list — new containers must be added by editing the group. A hand-picked container always beats another group's rule on the same day."}
        </p>
      </div>

      {group.stopSource === "rule" ? (
        <SchemeRuleEditor
          containers={containers}
          areaId={areaId}
          areaName={areaName}
          projectIds={projectIds}
          rule={rule}
          onChange={(next) =>
            onChange({
              fractions: next.fractions,
              ruleVehicleType: next.vehicleType,
            })
          }
        />
      ) : (
        <SchemeContainerPicker
          containers={containers}
          defaultProject={projectName}
          pickedIds={group.containerIds}
          onPick={(containerIds) => onChange({ containerIds })}
        />
      )}
    </div>
  )
}

/* --------------------------------- dialog --------------------------------- */

/**
 * "Edit collection groups" on the scheme page: the same editor over a stored
 * scheme's groups (implicit or explicit), with the save-time validation
 * previewed live through the record-side seam, so the planner sees the exact
 * outcome (Validated, or Draft with the named issues) before saving.
 */
export function CollectionGroupsEditorDialog({
  scheme,
  onClose,
  onSave,
}: {
  scheme: BusinessRecord | null
  onClose: () => void
  onSave: (groups: CollectionGroup[]) => void
}) {
  return (
    <Dialog open={Boolean(scheme)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
        {scheme && (
          // Keyed by scheme so the editor state re-seeds per opened record —
          // the dialog itself stays mounted while closed.
          <CollectionGroupsEditorDialogBody
            key={scheme.id}
            scheme={scheme}
            onClose={onClose}
            onSave={onSave}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function CollectionGroupsEditorDialogBody({
  scheme,
  onClose,
  onSave,
}: {
  scheme: BusinessRecord
  onClose: () => void
  onSave: (groups: CollectionGroup[]) => void
}) {
  const schemes = useModuleRecords("route-studio", "schemes")
  const calendars = useModuleRecords("plan", "calendars")
  const allocations = useModuleRecords("fleet", "vehicle-planning")
  const containers = useModuleRecords("resources", "containers")
  const vehicles = useModuleRecords("fleet", "vehicles")
  const values = scheme.submittedValues ?? {}
  const serviceDays = useMemo(() => serviceDaysFromValues(values), [values])
  const [groups, setGroups] = useState<CollectionGroup[]>(() =>
    collectionGroupsOfRecord(scheme, serviceDaysFromValues(values)).map(
      ({ implicit: _implicit, ...group }) => group,
    ),
  )

  // Validation runs over the record as it WOULD be saved — the groups
  // serialized the way the save path serializes them.
  const preview = useMemo(
    () =>
      schemeLiveValidation(
        {
          ...scheme,
          submittedValues: {
            ...scheme.submittedValues,
            ...collectionGroupsToValues(groups, serviceDays),
          },
        },
        { schemes, calendars, allocations, containers, vehicles },
      ),
    [allocations, calendars, containers, groups, scheme, schemes, serviceDays, vehicles],
  )

  const planningAreaId =
    typeof values.planningAreaId === "string" && values.planningAreaId
      ? values.planningAreaId
      : undefined
  const projectId =
    typeof values.projectId === "string" && values.projectId ? values.projectId : undefined

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit collection groups</DialogTitle>
        <DialogDescription>
          {scheme.name} · who collects what on which service days. Saving
          revalidates the scheme and reshapes its future planned routes.
        </DialogDescription>
      </DialogHeader>
      <CollectionGroupsEditor
        groups={groups}
        onChange={setGroups}
        serviceDays={serviceDays}
        planningAreaId={planningAreaId}
        projectId={projectId}
        issues={preview?.issues ?? []}
      />
      {preview && preview.issues.length > 0 && (
        <div className="space-y-1.5 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
          <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
            Saving keeps the scheme as Draft until these are resolved
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-400">
            {preview.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      {preview && preview.warnings.length > 0 && (
        <div className="space-y-1.5 rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
            Warnings — the scheme can still be saved
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-400">
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => onSave(groups)}>Save collection groups</Button>
      </DialogFooter>
    </>
  )
}
