// Manual route generation engine (spec docs/specs/ROUTE_SCHEMES.md FR-6–FR-10
// and docs/specs/PLAN_SIMPLIFICATION.md). Pure data logic — no UI or store
// dependencies — so the confirm preview and the record writes share one plan,
// and the upsert rules are harness-testable
// (scripts/route-scheme-generation-harness.ts).
//
// Upsert rules (validated in the prototype on branch prototype/route-schemes):
//   for each service date in the window:
//     an approved deviation matching the scheme's calendar and scope remaps
//       the operating date (deviations outrank calendar filtering — they exist
//       to relocate a holiday's service);
//     otherwise a holiday or non-working date on the scheme's Collection
//       Calendar is skipped: no route is written, the preview shows why, and a
//       still-Planned previously generated route on that date is cancelled;
//     no route for (scheme, serviceDate)       → create Planned with scheme defaults
//     route still Draft/Planned                → refresh date/stops/version;
//                                                keep an overridden assignment
//     route Ready/Active/Completed/Cancelled   → leave untouched
//   routes in the window whose service date the scheme no longer serves:
//     still Planned → cancel ("scheme no longer serves this date"); else leave.
//   Route identity is (schemeId, serviceDate) — deterministic ids, never Date.now().

import type { BusinessRecord } from "../data/business-modules"
import {
  calendarDayStatus,
  dayStatusSkipsGeneration,
  type CollectionCalendar,
} from "./calendar"
import { avalancheHash } from "./hash"
import { effectiveStopPlans, stopSelectionMode } from "./matching"
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

export type DeviationScopeType = "project" | "scheme" | "customer"

export type ApprovedDeviation = {
  name: string
  /** ISO date the scheme originally serves. */
  originalDate: string
  /** ISO date the route actually operates on. */
  replacementDate: string
  reason: string
  /** The deviation record's project scope; absent = applies project-wide. */
  projectIds?: string[]
  /** Calendar the deviation changes a date on; absent = legacy, project-matched. */
  calendarId?: string
  /** Declared scope; absent = legacy, treated as project scope. */
  scopeType?: DeviationScopeType
  /** The one scheme a scheme-scoped deviation affects. */
  schemeId?: string
}

/** "omit" rows are calendar skips: preview-visible, but never written. */
export type PlannedRouteAction = "create" | "refresh" | "skip" | "cancel" | "omit"

export type PlannedRoute = {
  action: PlannedRouteAction
  routeId: string
  routeName: string
  /** The scheme's service date — the identity half that never remaps. */
  serviceDate: string
  /** The operating date after deviation remap. */
  actualDate: string
  day: ServiceDay
  containerIds: string[]
  deviation?: ApprovedDeviation
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

export function generatedRouteId(schemeId: string, serviceDate: string): string {
  return `route-gen-${schemeId}-${serviceDate}`
}

/**
 * Deterministic RC number per (scheme, serviceDate) so regeneration never
 * renumbers. RC-7000–RC-9999 keeps clear of the fixture RC-10xx range;
 * cross-scheme hash collisions are tolerated in this prototype.
 */
export function generatedRouteName(schemeId: string, serviceDate: string): string {
  return `RC-${7000 + (avalancheHash(routeIdentityKey(schemeId, serviceDate)) % 3000)}`
}

/** "v6 draft" → "v6"; absent → "v1". */
export function schemeVersionOf(scheme: BusinessRecord): string {
  const version = scheme.facts?.Version?.trim().split(/\s+/)[0]
  return version || "v1"
}

/* ------------------------------ deviations -------------------------------- */

const FACT_DATE_MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
}

/** "24 Dec 2026" (the deviation facts format) or ISO → ISO, else null. */
export function parseDeviationDate(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (isIsoDate(trimmed)) return trimmed
  const match = /^(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})$/.exec(trimmed)
  if (!match) return null
  const month = FACT_DATE_MONTHS[match[2].toLowerCase()]
  if (!month) return null
  return `${match[3]}-${month}-${match[1].padStart(2, "0")}`
}

/** Actionable deviation statuses — shared with the portal notice derivation. */
export const APPROVED_DEVIATION_STATUSES = new Set(["Approved", "Notified"])

/**
 * The approved replacement dates generation must honor (FR-10). Draft
 * deviations are not yet promises and Executed/Cancelled ones no longer
 * remap. Form-created records carry ISO dates in submittedValues; fixtures
 * carry "24 Dec 2026" facts — both are read.
 */
export function approvedDeviationsFromRecords(
  records: readonly BusinessRecord[],
): ApprovedDeviation[] {
  const deviations: ApprovedDeviation[] = []
  for (const record of records) {
    if (!APPROVED_DEVIATION_STATUSES.has(record.status)) continue
    const values = record.submittedValues
    const originalDate =
      parseDeviationDate(
        typeof values?.originalDate === "string" ? values.originalDate : undefined,
      ) ?? parseDeviationDate(record.facts?.["Original date"])
    const replacementDate =
      parseDeviationDate(
        typeof values?.replacementDate === "string" ? values.replacementDate : undefined,
      ) ?? parseDeviationDate(record.facts?.["Replacement date"])
    if (!originalDate || !replacementDate) continue
    const scopeType = stringValue(values ?? {}, "scopeType")
    deviations.push({
      name: record.name,
      originalDate,
      replacementDate,
      reason:
        record.facts?.Reason ??
        stringValue(values ?? {}, "deviationReason") ??
        "Approved deviation",
      ...(record.projectIds?.length ? { projectIds: [...record.projectIds] } : {}),
      ...(stringValue(values ?? {}, "calendarId")
        ? { calendarId: stringValue(values ?? {}, "calendarId") }
        : {}),
      ...(scopeType === "project" || scopeType === "scheme" || scopeType === "customer"
        ? { scopeType }
        : {}),
      ...(stringValue(values ?? {}, "schemeId")
        ? { schemeId: stringValue(values ?? {}, "schemeId") }
        : {}),
    })
  }
  return deviations
}

/**
 * Authoritative deviation matching (Q8/Q13): a deviation changes a date on a
 * Collection Calendar, and schemes subscribed to that calendar inherit it
 * according to the deviation's scope.
 *   customer scope → never remaps whole-route generation;
 *   a recorded calendarId must equal the scheme's calendarId (a mismatched
 *     calendar never matches merely because projects overlap);
 *   scheme scope → exact schemeId only — a missing or wrong schemeId means no
 *     effect, never a silent fallback to project-wide;
 *   project scope (and legacy records without scope) → project overlap, where
 *     a side without recorded projects is scope-unknown and treated as
 *     project-wide — the deviation-preserving default.
 */
export function deviationMatchesScheme(
  deviation: ApprovedDeviation,
  scheme: BusinessRecord,
): boolean {
  if (deviation.calendarId) {
    const schemeCalendarId = stringValue(scheme.submittedValues ?? {}, "calendarId")
    if (schemeCalendarId !== deviation.calendarId) return false
  }
  return deviationMatchesScope(deviation, scheme.id, scheme.projectIds)
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
 * The scope tail shared by scheme- and route-side deviation matching:
 * customer scope never remaps whole routes; scheme scope is exact-id only;
 * project scope (and legacy) is project overlap with an unrecorded side
 * treated as project-wide.
 */
function deviationMatchesScope(
  deviation: ApprovedDeviation,
  schemeId: string | undefined,
  projectIds: readonly string[] | undefined,
): boolean {
  if (deviation.scopeType === "customer") return false
  if (deviation.scopeType === "scheme") {
    return deviation.schemeId === schemeId
  }
  if (!deviation.projectIds?.length || !projectIds?.length) return true
  return deviation.projectIds.some((projectId) => projectIds.includes(projectId))
}

/**
 * Deterministic pick among several matching deviations: the most specific
 * scope wins (scheme over project/legacy), then name order.
 */
export function deviationPrecedence(
  a: ApprovedDeviation,
  b: ApprovedDeviation,
): number {
  return (
    (a.scopeType === "scheme" ? 0 : 1) - (b.scopeType === "scheme" ? 0 : 1) ||
    a.name.localeCompare(b.name)
  )
}

/** The route-facing note for a deviation move — one wording everywhere. */
function deviationMovedNote(serviceDate: string, reason: string): string {
  return `Moved from ${formatServiceDate(serviceDate)} · ${reason}`
}

/**
 * The deviation note a route detail shows, derived from the record alone so
 * every presentation path agrees (issue #26): a stamped `Deviation` fact
 * other than "None" is shown verbatim; a route whose identity says it was
 * moved (`actualDate` differs from `serviceDate`) without such a stamp gets
 * the note derived from the approved deviation records, using generation's
 * precedence (most specific scope, then name order). A move no approved
 * deviation explains — a manual date edit stores exactly this shape (issue
 * #23) — is NOT attributed to a deviation: null, so the panel renders no
 * deviation row.
 */
export function routeDeviationInfo(
  route: BusinessRecord,
  deviations: readonly ApprovedDeviation[],
): string | null {
  const stamped = route.facts.Deviation?.trim()
  const stampedInfo = stamped && stamped !== "None" ? stamped : null
  const serviceDate = stringValueOf(route, "serviceDate")
  const actualDate = stringValueOf(route, "actualDate")
  if (stampedInfo || !serviceDate || !actualDate || serviceDate === actualDate) {
    return stampedInfo
  }
  // The route records no calendar id, so unlike deviationMatchesScheme this
  // display-side match cannot apply the calendar gate.
  const match = deviations
    .filter(
      (candidate) =>
        candidate.originalDate === serviceDate &&
        candidate.replacementDate === actualDate &&
        deviationMatchesScope(
          candidate,
          stringValueOf(route, "schemeId"),
          route.projectIds,
        ),
    )
    .sort(deviationPrecedence)[0]
  return match ? deviationMovedNote(serviceDate, match.reason) : null
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
 * holiday and non-working candidate dates (Q2/Q7) unless an approved
 * deviation relocates them first; uncovered dates only warn (Q6).
 * Stop lists come from effectiveStopPlans (issue #19): manual schemes keep
 * their picked lists; rule schemes resolve their stop-matching rules against
 * the supplied container records at plan time, so regeneration picks up
 * containers added to the area since the scheme was saved.
 */
export function planSchemeGeneration(input: {
  scheme: BusinessRecord
  window: GenerationWindow
  existingRoutes: readonly BusinessRecord[]
  deviations: readonly ApprovedDeviation[]
  /** Container records the stop rules resolve against (and pickups enrich from). */
  containers: readonly BusinessRecord[]
  calendar?: CollectionCalendar | null
}): SchemeGenerationPlan | null {
  const { scheme, window, calendar } = input
  const recurrence = recurrenceFromValues(scheme.submittedValues ?? {})
  if (!recurrence) return null

  const plans = effectiveStopPlans(scheme, recurrence.serviceDays, input.containers)
  const stopsByDay = new Map(plans.map((plan) => [plan.day, plan.containerIds]))
  // A rule that resolves to zero stops must never look like quiet success
  // (issue #19): the preview row says so. Manual schemes keep today's
  // behavior — FR-5c already blocks empty manual plans at save time.
  const matchWarningForDay = (day: ServiceDay): string | undefined =>
    stopSelectionMode(scheme.submittedValues) === "rule" &&
    (stopsByDay.get(day) ?? []).length === 0
      ? "No containers currently match this day's stop rule"
      : undefined

  const existingByIdentity = new Map<string, BusinessRecord>()
  for (const route of input.existingRoutes) {
    const schemeId = stringValueOf(route, "schemeId")
    const serviceDate = stringValueOf(route, "serviceDate")
    if (schemeId === scheme.id && serviceDate) {
      existingByIdentity.set(serviceDate, route)
    }
  }

  const routes: PlannedRoute[] = []
  const servedDates = new Set<string>()
  const walkedDates = windowDates(window)
  const walkEnd = walkedDates.length > 0
    ? walkedDates[walkedDates.length - 1]
    : window.from

  for (const date of walkedDates) {
    if (!matchesRecurrence(recurrence, date)) continue
    servedDates.add(date)
    const day = serviceDayOf(date)
    // Several approved deviations can match one date; pick deterministically
    // (deviationPrecedence) instead of whatever the store enumerated first.
    const deviation = input.deviations
      .filter(
        (candidate) =>
          candidate.originalDate === date &&
          deviationMatchesScheme(candidate, scheme),
      )
      .sort(deviationPrecedence)[0]
    const existing = existingByIdentity.get(date)

    // Calendar validity filtering (Q2/Q7): without a deviation to relocate
    // it, a holiday or non-working date gets no route. The date stays in the
    // preview so the planner sees why, and a still-Planned route generation
    // previously wrote there is cancelled — the same rule as a date the
    // scheme no longer serves.
    if (!deviation && calendar) {
      const dayStatus = calendarDayStatus(calendar, date)
      if (dayStatusSkipsGeneration(dayStatus)) {
        const reason =
          dayStatus === "holiday"
            ? `Holiday on ${calendar.name}`
            : `Not a working day on ${calendar.name}`
        if (existing && existing.status === "Planned") {
          routes.push({
            action: "cancel",
            routeId: existing.id,
            routeName: existing.name,
            serviceDate: date,
            actualDate: stringValueOf(existing, "actualDate") ?? date,
            day,
            containerIds: [],
            existing,
            note: reason,
          })
        } else if (existing) {
          routes.push({
            action: "skip",
            routeId: existing.id,
            routeName: existing.name,
            serviceDate: date,
            actualDate: stringValueOf(existing, "actualDate") ?? date,
            day,
            containerIds: stopsByDay.get(day) ?? [],
            existing,
            note: `${existing.status} — left untouched`,
            calendarWarning: reason,
          })
        } else {
          routes.push({
            action: "omit",
            routeId: generatedRouteId(scheme.id, date),
            routeName: generatedRouteName(scheme.id, date),
            serviceDate: date,
            actualDate: date,
            day,
            containerIds: [],
            note: reason,
          })
        }
        continue
      }
    }

    // Non-blocking calendar caveats (Q6): uncovered dates generate normally
    // but warn; a deviation's replacement date is honored even on a holiday
    // or non-working day (the planner chose it explicitly) but flagged.
    let calendarWarning: string | undefined
    if (calendar) {
      if (deviation) {
        const replacementStatus = calendarDayStatus(calendar, deviation.replacementDate)
        if (replacementStatus === "holiday") {
          calendarWarning = `Replacement date is a holiday on ${calendar.name}`
        } else if (replacementStatus === "non-working") {
          calendarWarning = `Replacement date is not a working day on ${calendar.name}`
        } else if (replacementStatus === "uncovered") {
          calendarWarning = `Replacement date is outside ${calendar.name} validity`
        }
      } else if (calendarDayStatus(calendar, date) === "uncovered") {
        calendarWarning = `Outside ${calendar.name} validity — calendar rules not applied`
      }
    }

    // A Cancelled route that generation itself authored (calendar skip or
    // unserved-date cleanup) is bookkeeping, not operational reality: once the
    // scheme serves the date again — a deviation now relocates it, the holiday
    // left the calendar, the service day returned — the route is re-created.
    // An operationally cancelled route (no marker) stays untouched.
    const resurrect =
      existing?.status === "Cancelled" &&
      existing.submittedValues?.cancelledByGeneration === true
    const action: PlannedRouteAction =
      !existing || resurrect
        ? "create"
        : REFRESHABLE_STATUSES.has(existing.status)
          ? "refresh"
          : "skip"
    const matchWarning = action === "skip" ? undefined : matchWarningForDay(day)
    routes.push({
      action,
      routeId: generatedRouteId(scheme.id, date),
      routeName: generatedRouteName(scheme.id, date),
      serviceDate: date,
      // A skip row is display-only — show where the stored route actually
      // operates, not where a new deviation would move a route it never writes.
      actualDate:
        action === "skip"
          ? (stringValueOf(existing!, "actualDate") ?? date)
          : deviation
            ? deviation.replacementDate
            : date,
      day,
      containerIds: stopsByDay.get(day) ?? [],
      ...(deviation ? { deviation } : {}),
      ...(existing && !resurrect ? { existing } : {}),
      ...(action === "skip"
        ? { note: `${existing?.status} — left untouched` }
        : {}),
      ...(calendarWarning ? { calendarWarning } : {}),
      ...(matchWarning ? { matchWarning } : {}),
    })
  }

  // Routes this scheme once generated inside the window but no longer serves:
  // still Planned → cancel; any further state is operational reality we keep.
  // Bounded by walkEnd, not window.to — dates past the walk cap were never
  // examined, so their routes must not be judged "no longer served".
  for (const [serviceDate, existing] of existingByIdentity) {
    if (servedDates.has(serviceDate)) continue
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
      existing,
      note: "Scheme no longer serves this date",
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
  }
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
   * the engine stays deterministic for harnesses; omitted, a refreshed
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
    // A stamp-less run (harness determinism) keeps a refreshed route's prior stamp.
    const generatedAtStamp =
      input.generatedAt ??
      (existing ? stringValueOf(existing, "generatedAt") : undefined)

    const schemeVehicle = schemeFacts.Vehicle ?? "Unassigned"
    const schemeDriver = schemeFacts.Driver ?? "Unassigned"
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
    const deviationNote = planned.deviation
      ? deviationMovedNote(planned.serviceDate, planned.deviation.reason)
      : "None"

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
        ...(schemeFacts["Service provider"] ? { "Service provider": schemeFacts["Service provider"] } : {}),
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
        Deviation: deviationNote,
        "Generated by": input.actorName,
      },
      related: [
        `Route scheme ${scheme.name}`,
        `${stops} pickups`,
        ...(planned.deviation ? [`Deviation ${planned.deviation.name}`] : []),
      ],
      source: `Route scheme ${scheme.name}`,
      freshness: "Now",
      allowedTransitions: ["Ready", "Cancelled"],
      companyId: scheme.companyId,
      projectIds: scheme.projectIds ? [...scheme.projectIds] : undefined,
      serviceProviderId: scheme.serviceProviderId,
      recordKind: "Route",
      submittedValues: {
        schemeId: scheme.id,
        serviceDate: planned.serviceDate,
        actualDate: planned.actualDate,
        schemeVersion: plan.schemeVersion,
        appliedVehicle: schemeVehicle,
        appliedDriver: schemeDriver,
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
          Deviation: deviationNote,
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
        serviceProviderId: scheme.serviceProviderId,
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
