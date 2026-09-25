// "What changed" (Issue #40): the difference between two versions of a
// scheme's configuration, spelled as rows a person reads — field, what it
// said, what it says now. The guided setup's review step compares the draft
// against the version the person last reviewed; the same reader answers for
// any two GuidedSchemeData, so two stored versions read back through
// quickSchemeDraftFromValues compare the same way. Pure — no UI, store, or
// fixture dependencies; the caller supplies how an id reads as a name.

import { SCHEME_CREATE_AS_LABELS } from "./creation"
import type { CollectionGroup } from "./groups"
import { containerTypeShortLabel } from "./matching"
import { HOLIDAY_POLICY_LABELS, formatClockTime, formatOccurrenceDate } from "./occurrences"
import type { GuidedSchemeData } from "./quick-create"
import { recurrenceCadenceLabel, serviceDaysRangeLabel } from "./recurrence"
import { count } from "../text"

export type SchemeDraftChange = {
  /** The draft field, or `group:<id>` for a collection group. */
  field: string
  /** What the row is about — "Service days", "Residual · bins". */
  label: string
  /** How the value read before; "—" when it had none (a group: "Added"). */
  before: string
  /** How it reads now; "—" when it has none (a group: "Removed"). */
  after: string
}

/** How an id reads as a name; undefined falls back to the id itself. */
export type SchemeDraftNames = {
  project?: (id: string) => string | undefined
  area?: (id: string) => string | undefined
  depot?: (id: string) => string | undefined
  station?: (id: string) => string | undefined
  vehicle?: (id: string) => string | undefined
  driver?: (id: string) => string | undefined
}

export const NO_VALUE = "—"

const named = (
  resolve: ((id: string) => string | undefined) | undefined,
  id: string | undefined,
): string => (id ? resolve?.(id) ?? id : NO_VALUE)

const or = (value: string | undefined): string => value?.trim() || NO_VALUE

const dateOr = (iso: string): string => (iso ? formatOccurrenceDate(iso) : NO_VALUE)

/** The group's stops in one phrase: its container types (rule) or how many it picked (manual). */
export function groupStopsLabel(group: CollectionGroup): string {
  if (group.stopSource === "manual") return count(group.containerIds.length, "container")
  const types = (group.containerTypes ?? []).map(containerTypeShortLabel)
  return types.length > 0 ? types.join(", ") : "Any container type"
}

/** "Mon, Wed · WH-31 · Freja Nielsen · 240 L, 140 L" — the group in one line. */
export function groupSummaryLabel(group: CollectionGroup, names: SchemeDraftNames): string {
  return [
    serviceDaysRangeLabel(group.days) || NO_VALUE,
    named(names.vehicle, group.vehicleId ?? group.vehicleName),
    group.driverId || group.driverName
      ? named(names.driver, group.driverId ?? group.driverName)
      : "Unassigned",
    groupStopsLabel(group),
  ].join(" · ")
}

type Reader = { field: string; label: string; read: (data: GuidedSchemeData) => string }

const scalarReaders = (names: SchemeDraftNames): Reader[] => [
  { field: "schemeName", label: "Name", read: (data) => or(data.schemeName) },
  { field: "projectId", label: "Project", read: (data) => named(names.project, data.projectId) },
  {
    field: "planningAreaId",
    label: "Planning area",
    read: (data) => named(names.area, data.planningAreaId),
  },
  { field: "wasteFraction", label: "Waste fraction", read: (data) => or(data.wasteFraction) },
  { field: "serviceType", label: "Service type", read: (data) => or(data.serviceType) },
  { field: "depotId", label: "Departure depot", read: (data) => named(names.depot, data.depotId) },
  {
    field: "unloadingStationId",
    label: "Unloading station",
    read: (data) => named(names.station, data.unloadingStationId),
  },
  { field: "frequency", label: "Frequency", read: (data) => recurrenceCadenceLabel(data) },
  {
    field: "serviceDays",
    label: "Service days",
    read: (data) => serviceDaysRangeLabel(data.serviceDays) || NO_VALUE,
  },
  { field: "effectiveFrom", label: "Effective from", read: (data) => dateOr(data.effectiveFrom) },
  { field: "effectiveTo", label: "Effective to", read: (data) => dateOr(data.effectiveTo) },
  {
    field: "plannedStartTime",
    label: "Start time",
    read: (data) => formatClockTime(data.plannedStartTime) || NO_VALUE,
  },
  {
    field: "holidayPolicy",
    label: "On a public holiday",
    read: (data) => HOLIDAY_POLICY_LABELS[data.holidayPolicy],
  },
  { field: "createAs", label: "Create as", read: (data) => SCHEME_CREATE_AS_LABELS[data.createAs] },
]

/**
 * Every field whose reading differs between the two versions, in the order
 * the wizard asks for them, then the collection groups: added, removed, or
 * changed (matched by id; a changed group reads as its before and after
 * summary lines). Empty when the two read the same.
 */
export function schemeDraftChanges(
  before: GuidedSchemeData,
  after: GuidedSchemeData,
  names: SchemeDraftNames = {},
): SchemeDraftChange[] {
  const changes: SchemeDraftChange[] = []
  for (const reader of scalarReaders(names)) {
    const was = reader.read(before)
    const now = reader.read(after)
    if (was !== now) changes.push({ field: reader.field, label: reader.label, before: was, after: now })
  }

  const wasById = new Map(before.groups.map((group) => [group.id, group]))
  const nowById = new Map(after.groups.map((group) => [group.id, group]))
  for (const group of after.groups) {
    const was = wasById.get(group.id)
    const now = groupSummaryLabel(group, names)
    if (!was) {
      changes.push({ field: `group:${group.id}`, label: group.name || "Collection group", before: "Added", after: now })
      continue
    }
    const then = groupSummaryLabel(was, names)
    if (then !== now || was.name !== group.name) {
      changes.push({
        field: `group:${group.id}`,
        label: was.name === group.name ? group.name : `${was.name || NO_VALUE} → ${group.name || NO_VALUE}`,
        before: then,
        after: now,
      })
    }
  }
  for (const group of before.groups) {
    if (nowById.has(group.id)) continue
    changes.push({
      field: `group:${group.id}`,
      label: group.name || "Collection group",
      before: groupSummaryLabel(group, names),
      after: "Removed",
    })
  }
  return changes
}
