// What the generation job decides, without a database (Issue #97 part B,
// ADR-0002): which dates a validated Route Scheme plans over a window, which
// of them each Collection Group runs on, what becomes of the Routes already
// there, which containers a rule group's stops are on a day once the database
// has said which are inside the boundary and under a valid placement, the
// order of a route's pickups and what changed among them, and whether a rule
// group's drift stamp moved. The job in `apps/worker` is the I/O shell around
// these: it reads the rows, calls this module, and writes what it answers.
//
// The dates are `generateOccurrences`'s (route-schemes/occurrences.ts), the
// ONE implementation the guided setup's preview, the API's occurrence read
// and this module share, so a preview row and a generated route agree by
// construction; `planRoutes` wraps it and never re-derives a date. The walk
// is capped at `WALK_CAP_DAYS` past the window's start (route-schemes/
// generation.ts's rule, reused): a route beyond the cap is never judged, and
// the cleanup is bounded by the same day, or an over-long window would cancel
// routes still served past the truncation point.
//
// The identity of a Route is `(scheme, group, service date)`, the recurrence
// date (ADR-0002); a shifted collection keeps it and moves `operatingDate`.
// The decisions, per (group, occurrence) whose weekday is in the group's
// days: no route → `create`; a `planned` route → `refresh`, which the job
// writes only where something differs, so a second run of the same inputs
// writes nothing; a route `cancelled` by an earlier run whose identity is
// planned again → `refresh` with `resurrect`, back to planned; `ready` and
// beyond, and a route a person cancelled → `leave`. A holiday the policy
// skips writes nothing (`omit`, counted) and cancels a `planned` route that
// stood on the date. Then the cleanup: every `planned` route of the scheme
// inside the walk whose identity was not planned → `cancel` with one of the
// three sentences the prototype spells. Nothing here reads `edit_policy`.
//
// The stops. The database answers, per service date, every container of the
// project under a placement, subscription and agreement valid that day, with
// its label, type and fraction, whether its place has a location and whether
// that location is inside the boundary in force that day (the query is the
// worker's stop-matching module; the geography and the effective dating are
// Postgres's). `resolveStops` takes it from there: a rule group's stops are
// the candidates that are contained, located and match its rule — the
// fraction one of the rule's, the container type one of the rule's where it
// names any, and the type compatible with the rule's vehicle type where it
// names one, through Resources' `container_type_vehicle_type` rows handed in
// as a set (#97's open decision 7, closed by Resources: a vehicle type is a
// row and compatibility is the join, never a name) — ordered by label; a
// manual group's are its picked containers in picked order, planned as
// picked, with the placement the day has for the place and the fraction and
// no other check. Tie-breaks between groups on one day as
// `resolveCollectionGroupPlans` has them: manual groups claim first in
// position order, then rule groups in position order take what is left. A
// rule match whose place has no location cannot be judged for containment
// and is `unlocated`, as is a picked container with no placement valid that
// day, which has no place and no fraction to write a pickup with; the job
// counts them on the run and writes nothing for them.
//
// The drift stamp (#41) is the set a rule group matches as of the window's
// first day — one day, so a nightly 7-day run and a 90-day on-demand run
// compare like with like — under the group's `ruleSignature`
// (route-schemes/container-drift.ts), the rule's own matches before any
// other group's claim, since the signature covers the rule alone. A stamp is
// written when the group has none, or its latest has another signature or
// another set (`stampMoved`); an identical set writes nothing, so the two
// latest rows are the two latest distinct sets, which is what
// `containerDriftBetween` compares.
import type { PickupReason, PickupStatus, RouteStatus } from "../execution/vocabulary"
import { ruleSignature } from "../route-schemes/container-drift"
import { WALK_CAP_DAYS } from "../route-schemes/generation"
import { holidayLabel, holidayNamesFor, withCarriedNames } from "../route-schemes/holiday-names"
import { generateOccurrences, NO_HOLIDAYS, shiftedNote, type HolidayList, type HolidayPolicy, type Occurrence, type SchemeCalendar } from "../route-schemes/occurrences"
import { addDays, serviceDayOf, type SchemeRecurrence } from "../route-schemes/recurrence"
import type { RecurrenceFrequency, ServiceDay, StopSource, WeekRotation } from "./vocabulary"

export { WALK_CAP_DAYS }

/* --------------------------------- window ---------------------------------- */

/** The window a run is asked for, both days inclusive, `YYYY-MM-DD`. */
export type GenerationWindow = { from: string; to: string }

/**
 * The days a run actually judges: the window, its end capped at
 * `WALK_CAP_DAYS` past its start. An inverted window walks nothing but its
 * first day, which no recurrence matches twice.
 */
export function walkWindow(window: GenerationWindow): GenerationWindow {
  if (window.to < window.from) return { from: window.from, to: window.from }
  const cap = addDays(window.from, WALK_CAP_DAYS)
  return { from: window.from, to: window.to < cap ? window.to : cap }
}

/* ------------------------------- recurrence -------------------------------- */

/** The stored recurrence of a scheme as its row carries it: the period is `validity`'s, `validTo` the first day out of force. */
export type StoredRecurrence = {
  frequency: RecurrenceFrequency
  serviceDays: readonly ServiceDay[]
  weekRotation: WeekRotation | null
  validFrom: string
  validTo: string | null
}

/**
 * The domain's recurrence from the row's: the one place `validTo`, the first
 * day out of force, meets `effectiveTo`, the last day in it. The API's
 * occurrence read and the generation job both build their input here, so
 * the two cannot spell the boundary day differently.
 */
export function schemeRecurrenceOf(scheme: StoredRecurrence): SchemeRecurrence {
  return {
    frequency: scheme.frequency,
    serviceDays: [...scheme.serviceDays],
    ...(scheme.weekRotation === null ? {} : { weekRotation: scheme.weekRotation }),
    effectiveFrom: scheme.validFrom,
    effectiveTo: scheme.validTo === null ? "" : addDays(scheme.validTo, -1),
  }
}

/* -------------------------------- holidays --------------------------------- */

/** A holiday as a collection calendar stores it: the day, and the name where somebody gave one. */
export type StoredHoliday = { day: string; name: string | null }

/**
 * The holidays a scheme's dates are judged against, from its project's
 * calendars: none when the project names no holiday list (the glossary's
 * rule — a project without one rests on its weekend only, whatever calendars
 * it has), else every row named as the calendar names it or, where it does
 * not, as the list's own lookup does. The API's occurrence read and the job
 * both read through this.
 */
export function holidayListOf(rows: readonly StoredHoliday[], holidayList: string | null): HolidayList {
  if (holidayList === null) return NO_HOLIDAYS
  const carried = new Map(rows.flatMap((row) => (row.name === null ? [] : [[row.day, row.name] as const])))
  const names = withCarriedNames(carried, holidayNamesFor(holidayList))
  return new Map(rows.map((row) => [row.day, holidayLabel(row.day, names)]))
}

/* -------------------------------- sentences -------------------------------- */

/** The cleanup's first sentence: the date is no longer one the scheme serves. */
export const NO_LONGER_SERVES_DATE = "Scheme no longer serves this date"
/** The cleanup's second: the date is served, but not by this group any more. */
export const NO_LONGER_PLANS_GROUP = "Scheme no longer plans this collection group on this date"
/** A stop taken off a planned route's list by a later run: the container left the rule, the boundary or its placement. */
export const REMOVED_FROM_DAY_PLAN = "Removed from the scheme's day plan"
/** A rule group on a scheme without a planning area matches nothing; said once per run. */
export const NO_PLANNING_AREA = "The scheme has no planning area, so its rule groups match no containers"

/** The third sentence, and the holiday's name: "Skipped · Christmas Day". */
export const skippedHoliday = (holiday: string | undefined): string => `Skipped · ${holiday ?? "Holiday"}`

/** The run's warning for a day with no boundary of the scheme's planning area in force: rule groups match nothing that day. */
export const noBoundaryInForce = (serviceDate: string): string => `No planning area boundary in force on ${serviceDate}; rule groups match no containers that day`

/** The route's deviation note for an occurrence the holiday policy touched: shifted off a holiday, or collecting on one; null for a plain date. */
export function occurrenceNote(occurrence: Occurrence): string | null {
  if (occurrence.status === "shifted") return `Shifted ${shiftedNote(occurrence)}`
  if (occurrence.status === "holiday") return `Collects on a holiday · ${occurrence.note ?? "Holiday"}`
  return null
}

/* --------------------------------- routes ---------------------------------- */

/** A collection group as the plan reads it: its order, the days it runs on, and how it finds its stops. */
export type GenerationGroup = {
  id: string
  position: number
  days: readonly ServiceDay[]
  stopSource: StopSource
}

/** A route of the scheme already in the database, inside the walk. */
export type ExistingRoute = {
  id: string
  collectionGroupId: string
  serviceDate: string
  status: RouteStatus
  cancelledByGeneration: boolean
}

export type RouteDecision =
  /** No route of this identity: insert one, `planned`, with a number from the counter. */
  | { kind: "create"; groupId: string; serviceDate: string; operatingDate: string; note: string | null }
  /** A `planned` route, or one an earlier run cancelled whose identity is planned again (`resurrect`): bring it to what the run plans, where anything differs. */
  | { kind: "refresh"; routeId: string; groupId: string; serviceDate: string; operatingDate: string; note: string | null; resurrect: boolean }
  /** A route that ran or is about to (`ready` and beyond), or one a person cancelled: not the run's to touch. */
  | { kind: "leave"; routeId: string; groupId: string; serviceDate: string; status: RouteStatus }
  /** A `planned` route the scheme no longer plans: cancelled by generation, with the sentence. */
  | { kind: "cancel"; routeId: string; groupId: string; serviceDate: string; note: string }
  /** A holiday the policy skips, with no route standing on it: nothing is written; counted. */
  | { kind: "omit"; groupId: string; serviceDate: string; note: string }

export type RoutePlan = {
  /** The days judged: the window, capped. */
  walk: GenerationWindow
  /** Every occurrence inside the walk, as `generateOccurrences` answered it. */
  occurrences: Occurrence[]
  /** In service-date order, then the group's position: the order creates take their numbers in. */
  decisions: RouteDecision[]
  /** Dates the holiday policy skipped, counted once per group that would have run. */
  holidaysSkipped: number
}

export type PlanRoutesInput = {
  recurrence: SchemeRecurrence
  holidayPolicy: HolidayPolicy
  calendar: SchemeCalendar
  window: GenerationWindow
  groups: readonly GenerationGroup[]
  existingRoutes: readonly ExistingRoute[]
}

const identityOf = (groupId: string, serviceDate: string): string => `${groupId}|${serviceDate}`

const byPosition = (a: GenerationGroup, b: GenerationGroup): number => a.position - b.position || a.id.localeCompare(b.id)

/**
 * What the run does to the scheme's routes over the window: the header's
 * rules, over plain shapes. `existingRoutes` are the scheme's routes with a
 * service date inside the walk (any others are ignored); groups are taken in
 * position order, ties by id, as the database orders them.
 */
export function planRoutes(input: PlanRoutesInput): RoutePlan {
  const walk = walkWindow(input.window)
  const occurrences = generateOccurrences({ recurrence: input.recurrence, window: walk, holidayPolicy: input.holidayPolicy, calendar: input.calendar })
  const groups = [...input.groups].sort(byPosition)
  const positionOf = new Map(groups.map((group, index) => [group.id, index]))

  const existing = new Map<string, ExistingRoute>()
  for (const row of input.existingRoutes) {
    if (row.serviceDate < walk.from || row.serviceDate > walk.to) continue
    existing.set(identityOf(row.collectionGroupId, row.serviceDate), row)
  }

  const decisions: RouteDecision[] = []
  const judged = new Set<string>()
  let holidaysSkipped = 0

  for (const occurrence of occurrences) {
    // The recurrence date is the identity; the shift moved only the operating date. Groups run on the recurrence weekday.
    const serviceDate = occurrence.plannedDate
    const day = serviceDayOf(serviceDate)
    for (const group of groups) {
      if (!group.days.includes(day)) continue
      const identity = identityOf(group.id, serviceDate)
      judged.add(identity)
      const route = existing.get(identity)

      if (occurrence.status === "skipped") {
        holidaysSkipped += 1
        const note = skippedHoliday(occurrence.note)
        if (route === undefined) decisions.push({ kind: "omit", groupId: group.id, serviceDate, note })
        else if (route.status === "planned") decisions.push({ kind: "cancel", routeId: route.id, groupId: group.id, serviceDate, note })
        else decisions.push({ kind: "leave", routeId: route.id, groupId: group.id, serviceDate, status: route.status })
        continue
      }

      const note = occurrenceNote(occurrence)
      if (route === undefined) {
        decisions.push({ kind: "create", groupId: group.id, serviceDate, operatingDate: occurrence.date, note })
      } else if (route.status === "planned") {
        decisions.push({ kind: "refresh", routeId: route.id, groupId: group.id, serviceDate, operatingDate: occurrence.date, note, resurrect: false })
      } else if (route.status === "cancelled" && route.cancelledByGeneration) {
        // Bookkeeping, not operational reality: the scheme serves the identity again, so the route comes back.
        decisions.push({ kind: "refresh", routeId: route.id, groupId: group.id, serviceDate, operatingDate: occurrence.date, note, resurrect: true })
      } else {
        decisions.push({ kind: "leave", routeId: route.id, groupId: group.id, serviceDate, status: route.status })
      }
    }
  }

  // The cleanup: a planned route inside the walk whose identity the run did not plan — the date is
  // no longer served, or the group no longer runs on it. Anything beyond planned is operational
  // reality and stays; a route an earlier run cancelled is already what it would become.
  const servedDates = new Set(occurrences.map((occurrence) => occurrence.plannedDate))
  for (const [identity, route] of existing) {
    if (judged.has(identity)) continue
    if (route.status !== "planned") continue
    decisions.push({
      kind: "cancel",
      routeId: route.id,
      groupId: route.collectionGroupId,
      serviceDate: route.serviceDate,
      note: servedDates.has(route.serviceDate) ? NO_LONGER_PLANS_GROUP : NO_LONGER_SERVES_DATE,
    })
  }

  decisions.sort((a, b) => a.serviceDate.localeCompare(b.serviceDate) || (positionOf.get(a.groupId) ?? Number.MAX_SAFE_INTEGER) - (positionOf.get(b.groupId) ?? Number.MAX_SAFE_INTEGER))
  return { walk, occurrences, decisions, holidaysSkipped }
}

/* ---------------------------------- stops ---------------------------------- */

/** A container of the project as the database answers it for one service date: under a placement, subscription and agreement valid that day. */
export type StopCandidate = {
  containerId: string
  label: string
  containerTypeId: string
  /** The placement's fraction that day. */
  wasteFractionId: string
  /** The subscription's place that day: exactly one of the two. */
  propertyId: string | null
  sharedCollectionPointId: string | null
  /** Whether the place has a location at all; without one containment cannot be judged. */
  located: boolean
  /** Whether the location is inside the scheme's boundary in force that day; false where there is no location, no boundary or no planning area. */
  contained: boolean
}

/** A Stop Matching Rule by ids: the fractions it matches, the container types it is restricted to (none is no restriction), the vehicle type it asks for. */
export type StopRule = {
  fractionIds: readonly string[]
  containerTypeIds: readonly string[]
  vehicleTypeId: string | null
}

/** A collection group as the stop resolution reads it: a rule, or the containers picked in stop order. */
export type StopGroup = {
  id: string
  position: number
  stopSource: StopSource
  rule: StopRule | null
  pickedContainerIds: readonly string[]
}

/** One stop of one route: the container, and the place and fraction the day resolved for it. */
export type PlannedStop = {
  containerId: string
  position: number
  propertyId: string | null
  sharedCollectionPointId: string | null
  wasteFractionId: string
}

export type ResolvedStops = {
  /** The stops of each group that ran, in stop order, positions 1..n. */
  stops: Map<string, PlannedStop[]>
  /** Containers no pickup could be written for that day: a rule match whose place has no location, a pick with no placement valid that day. Distinct. */
  unlocated: string[]
}

/** One key for a `(container type, vehicle type)` pair the company allows, as `container_type_vehicle_type` has rows for. */
export const compatibilityKey = (containerTypeId: string, vehicleTypeId: string): string => `${containerTypeId}|${vehicleTypeId}`

/** Whether a candidate is what the rule asks for, geography aside: the fraction, the type restriction, the vehicle type's compatibility. */
export function ruleMatches(candidate: Pick<StopCandidate, "containerTypeId" | "wasteFractionId">, rule: StopRule, compatible: ReadonlySet<string>): boolean {
  if (!rule.fractionIds.includes(candidate.wasteFractionId)) return false
  if (rule.containerTypeIds.length > 0 && !rule.containerTypeIds.includes(candidate.containerTypeId)) return false
  if (rule.vehicleTypeId !== null && !compatible.has(compatibilityKey(candidate.containerTypeId, rule.vehicleTypeId))) return false
  return true
}

const byLabel = (a: StopCandidate, b: StopCandidate): number => a.label.localeCompare(b.label) || a.containerId.localeCompare(b.containerId)

/**
 * The containers a rule matches on the day: contained, located, and the
 * rule's — sorted by label, before any other group's claim. What the drift
 * stamp records, and where a rule group's stops start from.
 */
export function ruleMatchSet(candidates: readonly StopCandidate[], rule: StopRule, compatible: ReadonlySet<string>): StopCandidate[] {
  return candidates.filter((candidate) => candidate.contained && candidate.located && ruleMatches(candidate, rule, compatible)).sort(byLabel)
}

const stopOf = (candidate: StopCandidate, position: number): PlannedStop => ({
  containerId: candidate.containerId,
  position,
  propertyId: candidate.propertyId,
  sharedCollectionPointId: candidate.sharedCollectionPointId,
  wasteFractionId: candidate.wasteFractionId,
})

/**
 * Every group's stops on one service date with the tie-breaks applied:
 * `groups` are the ones that run that day, in any order. Manual groups claim
 * first in position order, then rule groups in position order take what is
 * left; a container is on one route a day.
 */
export function resolveStops(groups: readonly StopGroup[], candidates: readonly StopCandidate[], compatible: ReadonlySet<string>): ResolvedStops {
  const byId = new Map(candidates.map((candidate) => [candidate.containerId, candidate]))
  const ordered = [...groups].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
  const claimed = new Set<string>()
  const unlocated = new Set<string>()
  const stops = new Map<string, PlannedStop[]>()

  for (const group of ordered.filter((candidate) => candidate.stopSource === "manual")) {
    const planned: PlannedStop[] = []
    for (const containerId of group.pickedContainerIds) {
      if (claimed.has(containerId)) continue
      const candidate = byId.get(containerId)
      if (candidate === undefined) {
        // Picked, but under no placement valid that day: no place and no fraction to write a pickup with.
        unlocated.add(containerId)
        continue
      }
      claimed.add(containerId)
      planned.push(stopOf(candidate, planned.length + 1))
    }
    stops.set(group.id, planned)
  }

  for (const group of ordered.filter((candidate) => candidate.stopSource === "rule")) {
    const planned: PlannedStop[] = []
    if (group.rule !== null) {
      for (const candidate of candidates) {
        if (candidate.located || !ruleMatches(candidate, group.rule, compatible)) continue
        // A manual group planned it already, its place looked up by the pick and not by geometry: it has a stop, and is not unlocated for a rule that would have wanted it too.
        if (claimed.has(candidate.containerId)) continue
        // The rule wants it and nobody can say where it is.
        unlocated.add(candidate.containerId)
      }
      for (const candidate of ruleMatchSet(candidates, group.rule, compatible)) {
        if (claimed.has(candidate.containerId)) continue
        claimed.add(candidate.containerId)
        planned.push(stopOf(candidate, planned.length + 1))
      }
    }
    stops.set(group.id, planned)
  }

  return { stops, unlocated: [...unlocated].sort() }
}

/* --------------------------------- pickups --------------------------------- */

/** A pickup of a planned route as the database has it. */
export type ExistingPickup = {
  id: string
  containerId: string
  position: number
  status: PickupStatus
  reason: PickupReason | null
  propertyId: string | null
  sharedCollectionPointId: string | null
  wasteFractionId: string
}

export type PickupChanges = {
  /** Stops with no pickup yet. */
  insert: PlannedStop[]
  /** Pickups whose stop moved, or that an earlier run skipped and the plan holds again (`resurrect`): brought to the stop. */
  update: Array<PlannedStop & { id: string; resurrect: boolean }>
  /** Planned pickups whose container left the plan: skipped by regeneration, with the sentence. */
  skip: Array<{ id: string; note: string }>
  /** Pickups the plan holds as they stand: nothing to write. */
  unchanged: number
}

const samePlace = (existing: ExistingPickup, stop: PlannedStop): boolean =>
  existing.position === stop.position && existing.propertyId === stop.propertyId && existing.sharedCollectionPointId === stop.sharedCollectionPointId && existing.wasteFractionId === stop.wasteFractionId

/**
 * What a refresh writes among a route's pickups: the rows stand, and a
 * refresh reorders in place (the pickup table's own rule) — a stop with no
 * pickup is inserted, a `planned` pickup whose position, place or fraction
 * moved is updated, a pickup an earlier run skipped is brought back where
 * the plan holds its container again, a `planned` pickup whose container the
 * plan no longer holds is skipped with `regeneration` as the reason and
 * never deleted, and a pickup a person decided — removed by the dispatcher,
 * or with an outcome — is left as it stands, in or out of the plan.
 */
export function pickupChanges(existing: readonly ExistingPickup[], planned: readonly PlannedStop[]): PickupChanges {
  const changes: PickupChanges = { insert: [], update: [], skip: [], unchanged: 0 }
  const byContainer = new Map(existing.map((pickup) => [pickup.containerId, pickup]))
  const held = new Set(planned.map((stop) => stop.containerId))

  for (const stop of planned) {
    const current = byContainer.get(stop.containerId)
    if (current === undefined) {
      changes.insert.push(stop)
    } else if (current.status === "planned") {
      if (samePlace(current, stop)) changes.unchanged += 1
      else changes.update.push({ ...stop, id: current.id, resurrect: false })
    } else if (current.status === "skipped" && current.reason === "regeneration") {
      changes.update.push({ ...stop, id: current.id, resurrect: true })
    } else {
      changes.unchanged += 1
    }
  }
  for (const pickup of existing) {
    if (held.has(pickup.containerId)) continue
    if (pickup.status === "planned") changes.skip.push({ id: pickup.id, note: REMOVED_FROM_DAY_PLAN })
    else changes.unchanged += 1
  }
  return changes
}

/* ---------------------------------- stamps --------------------------------- */

/** A rule group's drift stamp: the signature it matched under, and the sorted set it matched. */
export type MatchStamp = { ruleSignature: string; containerIds: readonly string[] }

/** The signature of a rule by ids, over the scheme's planning area: `ruleSignature`'s spelling, so the read and the write agree. */
export function stopRuleSignature(rule: StopRule, planningAreaId: string | null): string {
  return ruleSignature(
    { fractions: [...rule.fractionIds], ...(rule.vehicleTypeId === null ? {} : { ruleVehicleType: rule.vehicleTypeId }), containerTypes: [...rule.containerTypeIds] },
    planningAreaId ?? undefined,
  )
}

/** The stamp a run would write for a rule group on the window's first day: the rule's own matches, sorted. */
export function matchStampOf(rule: StopRule, planningAreaId: string | null, candidates: readonly StopCandidate[], compatible: ReadonlySet<string>): MatchStamp {
  return { ruleSignature: stopRuleSignature(rule, planningAreaId), containerIds: ruleMatchSet(candidates, rule, compatible).map((candidate) => candidate.containerId).sort() }
}

/** Whether a stamp is written: the group has none, or its latest is under another signature or holds another set. An identical set writes nothing. */
export function stampMoved(latest: MatchStamp | undefined, next: MatchStamp): boolean {
  if (latest === undefined) return true
  if (latest.ruleSignature !== next.ruleSignature) return true
  const before = [...latest.containerIds].sort()
  const after = [...next.containerIds].sort()
  return before.length !== after.length || before.some((id, index) => id !== after[index])
}
