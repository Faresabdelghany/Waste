// Manual route generation engine. Pure data logic — no UI or store
// dependencies — so the confirm preview and the record writes share one plan.
//
// Upsert rules (validated in the prototype on branch prototype/route-schemes):
//   for each service date in the window:
//     a holiday or non-working date on the scheme's Collection Calendar is
//       skipped: no route is written, the preview shows why, and a
//       still-Planned previously generated route on that date is cancelled;
//     no route for (scheme, serviceDate)       → create Planned with scheme defaults
//     route still Draft/Planned                → refresh date/stops/version;
//                                                keep an overridden assignment
//     route Ready/Active/Completed/Cancelled   → leave untouched
//   routes in the window whose service date the scheme no longer serves, or
//   whose collection group the scheme no longer plans on that date:
//     still Planned → cancel ("scheme no longer serves this date"); else leave.
//   Collection groups (D33/D36): the scheme's groups resolve per day
//   (lib/route-schemes/groups) and generation writes ONE route per group per
//   applicable day, carrying the group's vehicle, default driver, and service
//   provider. Route identity is (schemeId, serviceDate) for the implicit legacy
//   group and (schemeId, groupId, serviceDate) for explicit groups —
//   deterministic ids, never Date.now().

import type { BusinessRecord } from "../data/business-modules"
import {
  calendarDayStatus,
  dayStatusSkipsGeneration,
  type CollectionCalendar,
} from "./calendar"
import { schemeGroupPlans, type ResolvedCollectionGroup } from "./groups"
import { avalancheHash } from "./hash"
import {
  addDays,
  formatServiceDate,
  isIsoDate,
  matchesRecurrence,
  recurrenceFromValues,
  routeIdentityKey,
  serviceDayOf,
  type ServiceDay,
} from "./recurrence"
import { stringValue } from "./validation"

export type GenerationWindow = { from: string; to: string }

/** "omit" rows are calendar skips: preview-visible, but never written. */
export type PlannedRouteAction = "create" | "refresh" | "skip" | "cancel" | "omit"

export type PlannedRoute = {
  action: PlannedRouteAction
  routeId: string
  routeName: string
  /** The scheme's service date — the identity half that never remaps. */
  serviceDate: string
  /** The date the route operates on — the service date for generated rows; a skip row keeps the stored route's own. */
  actualDate: string
  day: ServiceDay
  containerIds: string[]
  /** The explicit collection group this route materializes; absent for the implicit legacy group. */
  groupId?: string
  groupName?: string
  /** The group's planned assignment as display names (create/refresh rows). */
  vehicle?: string
  driver?: string
  serviceProvider?: string
  serviceProviderId?: string
  /** The stored route this action refreshes, skips, or cancels. */
  existing?: BusinessRecord
  note?: string
  /** Non-blocking calendar caveat (uncovered date, replacement on a holiday). */
  calendarWarning?: string
  /** Rule-mode caveat: the day's stop rule currently matches no containers. */
  matchWarning?: string
}

export type SchemeGenerationPlan = {
  scheme: BusinessRecord
  schemeVersion: string
  window: GenerationWindow
  routes: PlannedRoute[]
}

export type GenerationSummary = {
  created: number
  refreshed: number
  cancelled: number
  skipped: number
  /** Dates the Collection Calendar invalidated (holiday / non-working). */
  calendarSkipped: number
  pickups: number
}

export type GenerationApplyResult = {
  routes: BusinessRecord[]
  pickups: BusinessRecord[]
  summary: GenerationSummary
}

/* ------------------------------ identity ---------------------------------- */

/**
 * Deterministic route id: the legacy (scheme, serviceDate) shape for the
 * implicit group, extended with the group id for explicit groups (D36).
 */
export function generatedRouteId(
  schemeId: string,
  serviceDate: string,
  groupKey?: string,
): string {
  return groupKey
    ? `route-gen-${schemeId}-${groupKey}-${serviceDate}`
    : `route-gen-${schemeId}-${serviceDate}`
}

/**
 * Deterministic RC number per route identity so regeneration never
 * renumbers. RC-7000–RC-9999 keeps clear of the fixture RC-10xx range;
 * cross-scheme hash collisions are tolerated in this prototype.
 */
export function generatedRouteName(
  schemeId: string,
  serviceDate: string,
  groupKey?: string,
): string {
  return `RC-${7000 + (avalancheHash(routeIdentityKey(schemeId, serviceDate, groupKey)) % 3000)}`
}

/** The identity half explicit groups add; implicit (legacy) groups add none. */
const groupKeyOf = (group: ResolvedCollectionGroup): string | undefined =>
  group.implicit ? undefined : group.id

const identityOf = (groupKey: string | undefined, serviceDate: string): string =>
  `${groupKey ?? ""}|${serviceDate}`

/** "v6 draft" → "v6"; absent → "v1". */
export function schemeVersionOf(scheme: BusinessRecord): string {
  const version = scheme.facts?.Version?.trim().split(/\s+/)[0]
  return version || "v1"
}

/* -------------------------------- planning -------------------------------- */

const REFRESHABLE_STATUSES = new Set(["Draft", "Planned"])

/** A record's submitted value as a non-empty string, else undefined. */
export const stringValueOf = (
  record: BusinessRecord,
  key: string,
): string | undefined => stringValue(record.submittedValues ?? {}, key)

/**
 * The scheme's planned start time, or undefined when it has none (issue
 * #32): submittedValues win over the legacy "Planned start" fact, both are
 * trimmed, and the "—" display placeholder counts as absent. Shared by
 * generation and the scheme detail page so the two never disagree — a scheme
 * without one shows "—" and generates routes with no estimated start.
 */
export function schemePlannedStartTime(
  scheme: BusinessRecord,
): string | undefined {
  const raw =
    stringValueOf(scheme, "plannedStartTime")?.trim() ||
    scheme.facts?.["Planned start"]?.trim()
  return raw && raw !== "—" ? raw : undefined
}

/**
 * The note a route detail shows for its `Deviation` fact (issue #26): the
 * stamped fact other than "None", read from the record alone so every
 * presentation path agrees — fixture execution notes ("Access blocked at
 * first attempt") and generation's cancellation reasons alike. A route with
 * the "None" placeholder or no fact renders no deviation row.
 */
export function routeDeviationNote(route: BusinessRecord): string | null {
  const stamped = route.facts.Deviation?.trim()
  return stamped && stamped !== "None" ? stamped : null
}

/**
 * The furthest the day walk reaches past a window's start: from + 366 days,
 * 367 dates. Dates past it are never judged, so anything that cancels on
 * generation's behalf and expects a later run to resurrect its cancels must
 * bound itself to this range too (edit.ts).
 */
export const WALK_CAP_DAYS = 366

/**
 * A day-by-day walk is fine: windows are weeks, not years. The walk caps at
 * 367 dates; everything downstream (generation AND cleanup) must bound itself
 * to the walked range, never the raw window, or an over-long window would
 * cancel still-served routes past the truncation point.
 */
function windowDates(window: GenerationWindow): string[] {
  const dates: string[] = []
  for (
    let cursor = window.from;
    cursor <= window.to && dates.length <= WALK_CAP_DAYS;
    cursor = addDays(cursor, 1)
  ) {
    dates.push(cursor)
  }
  return dates
}

/**
 * The generation plan for one scheme over one window — every row the confirm
 * preview shows and applySchemeGeneration writes. Returns null for schemes
 * without structured recurrence (legacy free-text records cannot generate).
 * The optional calendar is the scheme's Collection Calendar: it invalidates
 * holiday and non-working candidate dates (Q2/Q7); uncovered dates only warn
 * (Q6).
 * Stop lists come from effectiveStopPlans (issue #19): manual schemes keep
 * their picked lists; rule schemes resolve their stop-matching rules against
 * the supplied container records at plan time, so regeneration picks up
 * containers added to the area since the scheme was saved.
 */
export function planSchemeGeneration(input: {
  scheme: BusinessRecord
  window: GenerationWindow
  existingRoutes: readonly BusinessRecord[]
  /** Container records the stop rules resolve against (and pickups enrich from). */
  containers: readonly BusinessRecord[]
  calendar?: CollectionCalendar | null
}): SchemeGenerationPlan | null {
  const { scheme, window, calendar } = input
  const recurrence = recurrenceFromValues(scheme.submittedValues ?? {})
  if (!recurrence) return null

  // The scheme's collection groups resolved per day (D33): implicit for the
  // legacy single-assignment shape, explicit when stored — one route per
  // group per applicable day. Tie-breaks between groups (manual beats rule,
  // first rule group wins) are already applied in the per-group plans.
  const { groups, resolution } = schemeGroupPlans(
    scheme,
    recurrence.serviceDays,
    input.containers,
  )
  const planFor = new Map(
    resolution.plans.map((plan) => [`${plan.groupId}|${plan.day}`, plan.containerIds]),
  )
  // A rule that resolves to zero stops must never look like quiet success
  // (issue #19): the preview row says so. Manual groups keep today's
  // behavior — FR-5c already blocks empty manual plans at save time.
  const matchWarningFor = (
    group: ResolvedCollectionGroup,
    day: ServiceDay,
  ): string | undefined =>
    group.stopSource === "rule" && (planFor.get(`${group.id}|${day}`) ?? []).length === 0
      ? group.implicit
        ? "No containers currently match this day's stop rule"
        : `No containers currently match the stop rule of ${group.name}`
      : undefined
  // The implicit group already carries the scheme's display facts as its
  // names (collectionGroupsOf), so a missing name is genuinely unassigned.
  const groupFieldsOf = (group: ResolvedCollectionGroup) =>
    groupKeyOf(group) ? { groupId: group.id, groupName: group.name } : {}
  const assignmentOf = (group: ResolvedCollectionGroup) => ({
    ...groupFieldsOf(group),
    vehicle: group.vehicleName ?? "Unassigned",
    driver: group.driverName ?? "Unassigned",
    ...(group.serviceProviderName ? { serviceProvider: group.serviceProviderName } : {}),
    ...(group.serviceProviderId ? { serviceProviderId: group.serviceProviderId } : {}),
  })

  type ExistingRoute = { route: BusinessRecord; serviceDate: string; groupId?: string }
  const existingByIdentity = new Map<string, ExistingRoute>()
  for (const route of input.existingRoutes) {
    const schemeId = stringValueOf(route, "schemeId")
    const serviceDate = stringValueOf(route, "serviceDate")
    if (schemeId === scheme.id && serviceDate) {
      const groupId = stringValueOf(route, "collectionGroupId")
      existingByIdentity.set(identityOf(groupId, serviceDate), { route, serviceDate, groupId })
    }
  }

  const routes: PlannedRoute[] = []
  const servedDates = new Set<string>()
  const plannedIdentities = new Set<string>()
  const walkedDates = windowDates(window)
  const walkEnd = walkedDates.length > 0
    ? walkedDates[walkedDates.length - 1]
    : window.from

  for (const date of walkedDates) {
    if (!matchesRecurrence(recurrence, date)) continue
    servedDates.add(date)
    const day = serviceDayOf(date)

    // Calendar validity filtering (Q2/Q7): a holiday or non-working date gets
    // no route. The date stays in the preview so the planner sees why, and a
    // still-Planned route generation previously wrote there is cancelled — the
    // same rule as a date the scheme no longer serves.
    let calendarSkip: string | undefined
    if (calendar) {
      const dayStatus = calendarDayStatus(calendar, date)
      if (dayStatusSkipsGeneration(dayStatus)) {
        calendarSkip =
          dayStatus === "holiday"
            ? `Holiday on ${calendar.name}`
            : `Not a working day on ${calendar.name}`
      }
    }
    // Non-blocking calendar caveats (Q6): uncovered dates generate normally
    // but warn.
    let calendarWarning: string | undefined
    if (calendar && calendarDayStatus(calendar, date) === "uncovered") {
      calendarWarning = `Outside ${calendar.name} validity — calendar rules not applied`
    }

    for (const group of groups) {
      if (!group.days.includes(day)) continue
      const groupKey = groupKeyOf(group)
      const identity = identityOf(groupKey, date)
      plannedIdentities.add(identity)
      const existing = existingByIdentity.get(identity)?.route
      const containerIds = planFor.get(`${group.id}|${day}`) ?? []
      const routeId = generatedRouteId(scheme.id, date, groupKey)
      const routeName = generatedRouteName(scheme.id, date, groupKey)
      const groupFields = groupFieldsOf(group)

      if (calendarSkip) {
        if (existing && existing.status === "Planned") {
          routes.push({
            action: "cancel",
            routeId: existing.id,
            routeName: existing.name,
            serviceDate: date,
            actualDate: stringValueOf(existing, "actualDate") ?? date,
            day,
            containerIds: [],
            ...groupFields,
            existing,
            note: calendarSkip,
          })
        } else if (existing) {
          routes.push({
            action: "skip",
            routeId: existing.id,
            routeName: existing.name,
            serviceDate: date,
            actualDate: stringValueOf(existing, "actualDate") ?? date,
            day,
            containerIds,
            ...groupFields,
            existing,
            note: `${existing.status} — left untouched`,
            calendarWarning: calendarSkip,
          })
        } else {
          routes.push({
            action: "omit",
            routeId,
            routeName,
            serviceDate: date,
            actualDate: date,
            day,
            containerIds: [],
            ...groupFields,
            note: calendarSkip,
          })
        }
        continue
      }

      // A Cancelled route that generation itself authored (calendar skip or
      // unserved-date cleanup) is bookkeeping, not operational reality: once
      // the scheme serves the date again — the holiday left the calendar, the
      // service day returned, the group is planned again — the route is
      // re-created. An operationally cancelled route (no marker) stays untouched.
      const resurrect =
        existing?.status === "Cancelled" &&
        existing.submittedValues?.cancelledByGeneration === true
      const action: PlannedRouteAction =
        !existing || resurrect
          ? "create"
          : REFRESHABLE_STATUSES.has(existing.status)
            ? "refresh"
            : "skip"
      const matchWarning = action === "skip" ? undefined : matchWarningFor(group, day)
      routes.push({
        action,
        routeId,
        routeName,
        serviceDate: date,
        // A skip row is display-only — show where the stored route actually
        // operates, not where a fresh write would put it.
        actualDate:
          action === "skip"
            ? (stringValueOf(existing!, "actualDate") ?? date)
            : date,
        day,
        containerIds,
        ...assignmentOf(group),
        ...(existing && !resurrect ? { existing } : {}),
        ...(action === "skip"
          ? { note: `${existing?.status} — left untouched` }
          : {}),
        ...(calendarWarning ? { calendarWarning } : {}),
        ...(matchWarning ? { matchWarning } : {}),
      })
    }
  }

  // Routes this scheme once generated inside the window but no longer plans —
  // the date is no longer served, or the collection group no longer runs on
  // it: still Planned → cancel; any further state is operational reality we
  // keep. Bounded by walkEnd, not window.to — dates past the walk cap were
  // never examined, so their routes must not be judged "no longer served".
  for (const [identity, { route: existing, serviceDate, groupId }] of existingByIdentity) {
    if (plannedIdentities.has(identity)) continue
    if (serviceDate < window.from || serviceDate > walkEnd) continue
    if (existing.status !== "Planned") continue
    routes.push({
      action: "cancel",
      routeId: existing.id,
      routeName: existing.name,
      serviceDate,
      actualDate: stringValueOf(existing, "actualDate") ?? serviceDate,
      day: serviceDayOf(serviceDate),
      containerIds: [],
      ...(groupId ? { groupId, groupName: existing.facts?.["Collection group"] ?? groupId } : {}),
      existing,
      // A served date with a stale identity: an explicit group that no longer
      // runs that day, or a legacy single-assignment route on a scheme that
      // now plans the date per collection group (D36).
      note: !servedDates.has(serviceDate)
        ? "Scheme no longer serves this date"
        : groupId
          ? "Scheme no longer plans this collection group on this date"
          : "Scheme now plans this date per collection group",
    })
  }

  routes.sort((a, b) => a.serviceDate.localeCompare(b.serviceDate))

  return { scheme, schemeVersion: schemeVersionOf(scheme), window, routes }
}

/* ------------------------ scheme route list (FR-13) ----------------------- */

/** The routes one scheme generated, sorted by service date. */
export function schemeGeneratedRoutes(
  schemeId: string,
  routes: readonly BusinessRecord[],
): BusinessRecord[] {
  return routes
    .filter((route) => stringValueOf(route, "schemeId") === schemeId)
    .sort((a, b) =>
      (stringValueOf(a, "serviceDate") ?? "").localeCompare(
        stringValueOf(b, "serviceDate") ?? "",
      ),
    )
}

/** The newest generatedAt stamp across the routes, or null if none carry one. */
export function lastGeneratedAt(
  routes: readonly BusinessRecord[],
): string | null {
  let latest: string | null = null
  for (const route of routes) {
    const stamp = stringValueOf(route, "generatedAt")
    if (stamp && (!latest || stamp > latest)) latest = stamp
  }
  return latest
}

/* ---------------------- single-route reassignment (FR-12) ----------------- */

/**
 * The reassigned route record to upsert; the input is left untouched. Only
 * this route's facts move — the scheme defaults and the appliedVehicle/
 * appliedDriver stamps stay as generation wrote them, which is exactly what
 * lets the next regeneration detect the drift and keep the override.
 */
export function reassignRouteAssignment(
  route: BusinessRecord,
  assignment: { driver?: string; vehicle?: string },
): BusinessRecord {
  const driver = assignment.driver?.trim()
  const vehicle = assignment.vehicle?.trim()
  return {
    ...route,
    ...(driver ? { owner: driver } : {}),
    updated: "Now",
    freshness: "Now",
    facts: {
      ...route.facts,
      ...(driver ? { Driver: driver } : {}),
      ...(vehicle ? { Vehicle: vehicle } : {}),
    },
  }
}

const OPEN_PICKUP_STATUSES = new Set(["Planned", "Next"])

/**
 * The route's own still-open pickups rewritten for a driver reassignment, so
 * the stop list agrees with the route's assignment. Completed/Skipped pickups
 * record who actually serviced them and other routes' pickups are not this
 * reassignment's business — neither is returned. Vehicle-only reassignments
 * return nothing (pickups carry no vehicle).
 */
export function reassignRoutePickups(
  routeId: string,
  pickups: readonly BusinessRecord[],
  driver: string | undefined,
): BusinessRecord[] {
  const trimmed = driver?.trim()
  if (!trimmed) return []
  return pickups
    .filter(
      (pickup) =>
        stringValueOf(pickup, "routeId") === routeId &&
        OPEN_PICKUP_STATUSES.has(pickup.status),
    )
    .map((pickup) => ({
      ...pickup,
      owner: trimmed,
      updated: "Now",
      freshness: "Now",
      facts: { ...pickup.facts, Driver: trimmed },
    }))
}

/* -------------------------------- applying -------------------------------- */

function addMinutes(time: string, minutes: number): string {
  const [hours, mins] = time.split(":").map(Number)
  if (Number.isNaN(hours) || Number.isNaN(mins)) return time
  const total = (hours * 60 + mins + minutes) % (24 * 60)
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
}

const MINUTES_PER_STOP = 7
const CLOSEOUT_MINUTES = 45

function generatedPickupId(routeId: string, containerId: string): string {
  return `${routeId}-p-${containerId}`
}

/**
 * The one generation-authored cancel shape (shared with edit-save
 * reconciliation, issue #33): the route is rewritten Cancelled — never
 * deleted — carrying the `cancelledByGeneration` marker that lets a later
 * run re-create it when the scheme serves the date again. Everything that
 * cancels on generation's behalf must write exactly this shape, or the
 * resurrection pass above would not recognize its own bookkeeping.
 */
export function cancelledByGenerationRoute(
  existing: BusinessRecord,
  note: string,
  generatedAt?: string,
): BusinessRecord {
  return {
    ...existing,
    status: "Cancelled",
    updated: "Now",
    freshness: "Now",
    description: `Cancelled by regeneration — ${note}.`,
    facts: { ...existing.facts, Deviation: note },
    allowedTransitions: [],
    submittedValues: {
      ...existing.submittedValues,
      // Marks this cancel as generation bookkeeping so a later run may
      // re-create the route when the scheme serves the date again.
      cancelledByGeneration: true,
      ...(generatedAt ? { generatedAt } : {}),
    },
  }
}

/**
 * A still-open pickup rewritten Skipped because regeneration invalidated it
 * (its route was cancelled, or its container left the day plan). Null when
 * the pickup already records operational reality (Completed/Skipped/Failed)
 * — those are never rewritten.
 */
export function staleGenerationPickup(
  pickup: BusinessRecord,
  reason: string,
): BusinessRecord | null {
  if (pickup.status !== "Planned" && pickup.status !== "Next") return null
  return {
    ...pickup,
    status: "Skipped",
    value: "Skipped · regeneration",
    updated: "Now",
    freshness: "Now",
    description: reason,
    facts: { ...pickup.facts, Deviation: reason },
    allowedTransitions: [],
    // Structured marker so readers can tell "left the plan at regeneration"
    // from a Stop skipped in execution without parsing display strings.
    submittedValues: { ...pickup.submittedValues, removedFromPlan: "true" },
  }
}

/** True for a Stop a regeneration removed from its route's plan (kept as a Skipped record, never deleted). */
export function pickupRemovedFromPlan(pickup: BusinessRecord): boolean {
  return stringValueOf(pickup, "removedFromPlan") === "true"
}

/**
 * A scheme's future refreshable routes rewritten as generation-authored
 * cancels — cancelled, never deleted, through cancelledByGenerationRoute so
 * the resurrection pass recognizes them — with their open pickups skipped.
 * Shared by edit-save reconciliation (issue #33: the invalidating save) and
 * scheme deletion (issue #34). Only routes whose service date lies in
 * [from, to] (`to` omitted = every future route) and whose status is
 * refreshable (Draft/Planned) are touched: Ready/Active/Completed routes,
 * cancels without the marker, and routes outside the bound are operational
 * reality or unjudged and stay exactly as stored.
 */
export function cancelSchemeFutureRoutes(input: {
  schemeId: string
  /** First service date judged — tomorrow by convention (today's routes operate). */
  from: string
  /** Last service date judged; omitted, every future route is judged. */
  to?: string
  existingRoutes: readonly BusinessRecord[]
  existingPickups: readonly BusinessRecord[]
  note: string
  generatedAt?: string
}): { routes: BusinessRecord[]; pickups: BusinessRecord[] } {
  const routes: BusinessRecord[] = []
  const pickups: BusinessRecord[] = []
  const pickupsByRoute = new Map<string, BusinessRecord[]>()
  for (const pickup of input.existingPickups) {
    const routeId = stringValueOf(pickup, "routeId")
    if (!routeId) continue
    const list = pickupsByRoute.get(routeId) ?? []
    list.push(pickup)
    pickupsByRoute.set(routeId, list)
  }
  for (const route of input.existingRoutes) {
    if (stringValueOf(route, "schemeId") !== input.schemeId) continue
    const serviceDate = stringValueOf(route, "serviceDate")
    if (!serviceDate || serviceDate < input.from) continue
    if (input.to !== undefined && serviceDate > input.to) continue
    if (!REFRESHABLE_STATUSES.has(route.status)) continue
    routes.push(cancelledByGenerationRoute(route, input.note, input.generatedAt))
    for (const pickup of pickupsByRoute.get(route.id) ?? []) {
      const skipped = staleGenerationPickup(pickup, input.note)
      if (skipped) pickups.push(skipped)
    }
  }
  return { routes, pickups }
}

/**
 * Materializes a plan into the route and pickup records to upsert. Skip rows
 * write nothing; cancel rows rewrite the existing route as Cancelled and skip
 * its still-planned pickups; refresh rows keep a dispatcher-overridden
 * vehicle/driver (detected against the appliedVehicle/appliedDriver the last
 * generation recorded) while re-pinning the current scheme version.
 */
export function applySchemeGeneration(input: {
  plan: SchemeGenerationPlan
  existingPickups: readonly BusinessRecord[]
  containers: readonly BusinessRecord[]
  actorName: string
  /**
   * ISO datetime stamped as submittedValues.generatedAt on every route this
   * run writes (the scheme detail's "Last generated", FR-13). Optional so
   * the engine stays deterministic; omitted, a refreshed
   * route keeps its prior stamp.
   */
  generatedAt?: string
}): GenerationApplyResult {
  const { plan } = input
  const scheme = plan.scheme
  const schemeFacts = scheme.facts ?? {}
  // No planned start time → the routes carry no estimated start (issue #32):
  // no Time window fact and unscheduled pickups, never a fabricated 06:00.
  const startTime = schemePlannedStartTime(scheme)
  const containersById = new Map(
    input.containers.map((container) => [container.id, container]),
  )

  const routes: BusinessRecord[] = []
  const pickups: BusinessRecord[] = []
  const summary: GenerationSummary = {
    created: 0,
    refreshed: 0,
    cancelled: 0,
    skipped: 0,
    calendarSkipped: 0,
    pickups: 0,
  }

  const pickupsByRoute = new Map<string, BusinessRecord[]>()
  for (const pickup of input.existingPickups) {
    const routeId = stringValueOf(pickup, "routeId")
    if (!routeId) continue
    const list = pickupsByRoute.get(routeId) ?? []
    list.push(pickup)
    pickupsByRoute.set(routeId, list)
  }

  const skipStalePickup = (pickup: BusinessRecord, reason: string) => {
    const skipped = staleGenerationPickup(pickup, reason)
    if (skipped) pickups.push(skipped)
  }

  for (const planned of plan.routes) {
    if (planned.action === "skip") {
      summary.skipped += 1
      continue
    }

    // Calendar skips are preview information, never writes (Q2).
    if (planned.action === "omit") {
      summary.calendarSkipped += 1
      continue
    }

    if (planned.action === "cancel") {
      const existing = planned.existing
      if (!existing) continue
      summary.cancelled += 1
      routes.push(
        cancelledByGenerationRoute(
          existing,
          planned.note ?? "Scheme no longer serves this date",
          input.generatedAt,
        ),
      )
      for (const pickup of pickupsByRoute.get(existing.id) ?? []) {
        skipStalePickup(pickup, planned.note ?? "Route cancelled by regeneration")
      }
      continue
    }

    const existing = planned.existing
    const isRefresh = planned.action === "refresh"
    if (isRefresh) summary.refreshed += 1
    else summary.created += 1
    // A stamp-less run keeps a refreshed route's prior stamp.
    const generatedAtStamp =
      input.generatedAt ??
      (existing ? stringValueOf(existing, "generatedAt") : undefined)

    // The group's planned assignment (the scheme's own for the implicit
    // legacy group) — stamped as appliedVehicle/appliedDriver so a per-group
    // value never reads as a dispatcher override on the next refresh.
    const schemeVehicle = planned.vehicle ?? schemeFacts.Vehicle ?? "Unassigned"
    const schemeDriver = planned.driver ?? schemeFacts.Driver ?? "Unassigned"
    const serviceProvider = planned.serviceProvider ?? schemeFacts["Service provider"]
    // A dispatcher override is a fact that drifted from what generation last
    // applied; the scheme default must not silently take the route back.
    const keepVehicle =
      isRefresh &&
      existing?.facts?.Vehicle &&
      stringValueOf(existing, "appliedVehicle") &&
      existing.facts.Vehicle !== stringValueOf(existing, "appliedVehicle")
    const keepDriver =
      isRefresh &&
      existing?.facts?.Driver &&
      stringValueOf(existing, "appliedDriver") &&
      existing.facts.Driver !== stringValueOf(existing, "appliedDriver")
    const vehicle = keepVehicle ? (existing?.facts.Vehicle as string) : schemeVehicle
    const driver = keepDriver ? (existing?.facts.Driver as string) : schemeDriver

    const stops = planned.containerIds.length

    routes.push({
      id: planned.routeId,
      name: planned.routeName,
      context:
        [schemeFacts.Project, schemeFacts["Planning area"]]
          .filter(Boolean)
          .join(" · ") || scheme.context,
      status: isRefresh ? (existing?.status ?? "Planned") : "Planned",
      owner: driver,
      value: `${stops} stops`,
      updated: "Now",
      description: `Generated from route scheme ${scheme.name} for ${formatServiceDate(planned.actualDate)}.`,
      facts: {
        ...(schemeFacts.Project ? { Project: schemeFacts.Project } : {}),
        ...(schemeFacts["Planning area"]
          ? { Area: schemeFacts["Planning area"] }
          : {}),
        Vehicle: vehicle,
        Driver: driver,
        ...(serviceProvider ? { "Service provider": serviceProvider } : {}),
        ...(planned.groupName ? { "Collection group": planned.groupName } : {}),
        ...(schemeFacts["Departure depot"]
          ? { Depot: schemeFacts["Departure depot"] }
          : {}),
        ...(schemeFacts["Unloading station"]
          ? { Unloading: schemeFacts["Unloading station"] }
          : {}),
        ...(startTime
          ? {
              "Time window": `${startTime}–${addMinutes(startTime, stops * MINUTES_PER_STOP + CLOSEOUT_MINUTES)}`,
            }
          : {}),
        "Operating date": formatServiceDate(planned.actualDate),
        "Route scheme": scheme.name,
        "Scheme version": plan.schemeVersion,
        Stops: String(stops),
        Deviation: "None",
        "Generated by": input.actorName,
      },
      related: [
        `Route scheme ${scheme.name}`,
        `${stops} pickups`,
      ],
      source: `Route scheme ${scheme.name}`,
      freshness: "Now",
      allowedTransitions: ["Ready", "Cancelled"],
      companyId: scheme.companyId,
      projectIds: scheme.projectIds ? [...scheme.projectIds] : undefined,
      serviceProviderId: planned.serviceProviderId ?? scheme.serviceProviderId,
      recordKind: "Route",
      submittedValues: {
        schemeId: scheme.id,
        serviceDate: planned.serviceDate,
        actualDate: planned.actualDate,
        schemeVersion: plan.schemeVersion,
        appliedVehicle: schemeVehicle,
        appliedDriver: schemeDriver,
        ...(planned.groupId ? { collectionGroupId: planned.groupId } : {}),
        ...(generatedAtStamp ? { generatedAt: generatedAtStamp } : {}),
      },
    })

    const plannedContainerIds = new Set(planned.containerIds)
    planned.containerIds.forEach((containerId, index) => {
      summary.pickups += 1
      const container = containersById.get(containerId)
      const facts = container?.facts ?? {}
      pickups.push({
        id: generatedPickupId(planned.routeId, containerId),
        name: `Stop ${index + 1} · ${facts.Address?.split(",")[0] ?? container?.name ?? containerId}`,
        context: `${planned.routeName} · ${facts["Waste fractions"] ?? "Collection"}${
          facts["Container type"] ? ` · ${facts["Container type"]}` : ""
        }`,
        status: "Planned",
        owner: driver,
        value: startTime
          ? `${addMinutes(startTime, index * MINUTES_PER_STOP)} · Scheduled`
          : "Scheduled",
        updated: "Now",
        description: `Generated with ${planned.routeName} from route scheme ${scheme.name}.`,
        facts: {
          Route: planned.routeName,
          Stop: String(index + 1),
          Type: "Collection",
          ...(startTime
            ? { Scheduled: addMinutes(startTime, index * MINUTES_PER_STOP) }
            : {}),
          ...(facts.Address ? { Address: facts.Address } : {}),
          ...(container ? { "Container ID": container.name } : {}),
          ...(facts["Container type"]
            ? { "Container Type": facts["Container type"] }
            : {}),
          ...(facts["Waste fractions"]
            ? { "Waste fraction": facts["Waste fractions"] }
            : {}),
          ...(schemeFacts.Project ? { Project: schemeFacts.Project } : {}),
          Driver: driver,
          Deviation: "None",
        },
        related: [
          `Route ${planned.routeName}`,
          ...(container ? [container.name] : []),
        ],
        source: "Route generation",
        freshness: "Now",
        allowedTransitions: ["Completed", "Skipped", "Failed"],
        deepLink: `/route-studio?module=routes&record=${planned.routeId}`,
        companyId: scheme.companyId,
        projectIds: scheme.projectIds ? [...scheme.projectIds] : undefined,
        serviceProviderId: planned.serviceProviderId ?? scheme.serviceProviderId,
        recordKind: "Pickup",
        submittedValues: {
          routeId: planned.routeId,
          schemeId: scheme.id,
          serviceDate: planned.serviceDate,
          containerId,
          stop: String(index + 1),
        },
      })
    })

    // Pickups the last generation created for containers the plan no longer
    // holds would otherwise linger as phantom Planned stops.
    for (const pickup of pickupsByRoute.get(planned.routeId) ?? []) {
      const containerId = stringValueOf(pickup, "containerId")
      if (containerId && !plannedContainerIds.has(containerId)) {
        skipStalePickup(pickup, "Removed from the scheme's day plan")
      }
    }
  }

  return { routes, pickups, summary }
}
