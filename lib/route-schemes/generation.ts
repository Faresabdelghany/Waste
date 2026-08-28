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
import { calendarDayStatus, type CollectionCalendar } from "./calendar"
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
import { dayPlansFromValues, effectiveDayPlans, stringValue } from "./validation"

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
function parseDeviationDate(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (isIsoDate(trimmed)) return trimmed
  const match = /^(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})$/.exec(trimmed)
  if (!match) return null
  const month = FACT_DATE_MONTHS[match[2].toLowerCase()]
  if (!month) return null
  return `${match[3]}-${month}-${match[1].padStart(2, "0")}`
}

const APPROVED_DEVIATION_STATUSES = new Set(["Approved", "Notified"])

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
  if (deviation.scopeType === "customer") return false
  if (deviation.calendarId) {
    const schemeCalendarId = stringValue(scheme.submittedValues ?? {}, "calendarId")
    if (schemeCalendarId !== deviation.calendarId) return false
  }
  if (deviation.scopeType === "scheme") {
    return deviation.schemeId === scheme.id
  }
  if (!deviation.projectIds?.length || !scheme.projectIds?.length) return true
  return deviation.projectIds.some((projectId) =>
    scheme.projectIds?.includes(projectId),
  )
}

/* -------------------------------- planning -------------------------------- */

const REFRESHABLE_STATUSES = new Set(["Draft", "Planned"])

/** A record's submitted value as a non-empty string, else undefined. */
export const stringValueOf = (
  record: BusinessRecord,
  key: string,
): string | undefined => stringValue(record.submittedValues ?? {}, key)

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
    cursor <= window.to && dates.length <= 366;
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
 */
export function planSchemeGeneration(input: {
  scheme: BusinessRecord
  window: GenerationWindow
  existingRoutes: readonly BusinessRecord[]
  deviations: readonly ApprovedDeviation[]
  calendar?: CollectionCalendar | null
}): SchemeGenerationPlan | null {
  const { scheme, window, calendar } = input
  const recurrence = recurrenceFromValues(scheme.submittedValues ?? {})
  if (!recurrence) return null

  const plans = effectiveDayPlans(
    recurrence.serviceDays,
    dayPlansFromValues(scheme.submittedValues),
  )
  const stopsByDay = new Map(plans.map((plan) => [plan.day, plan.containerIds]))

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
    // Several approved deviations can match one date; pick deterministically —
    // the most specific scope wins (scheme over project/legacy), then name —
    // instead of whatever the store happened to enumerate first.
    const deviation = input.deviations
      .filter(
        (candidate) =>
          candidate.originalDate === date &&
          deviationMatchesScheme(candidate, scheme),
      )
      .sort(
        (a, b) =>
          (a.scopeType === "scheme" ? 0 : 1) - (b.scopeType === "scheme" ? 0 : 1) ||
          a.name.localeCompare(b.name),
      )[0]
    const existing = existingByIdentity.get(date)

    // Calendar validity filtering (Q2/Q7): without a deviation to relocate
    // it, a holiday or non-working date gets no route. The date stays in the
    // preview so the planner sees why, and a still-Planned route generation
    // previously wrote there is cancelled — the same rule as a date the
    // scheme no longer serves.
    if (!deviation && calendar) {
      const dayStatus = calendarDayStatus(calendar, date)
      if (dayStatus === "holiday" || dayStatus === "non-working") {
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
  const startTime =
    stringValueOf(scheme, "plannedStartTime") ?? schemeFacts["Planned start"] ?? "06:00"
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
    if (pickup.status !== "Planned" && pickup.status !== "Next") return
    pickups.push({
      ...pickup,
      status: "Skipped",
      value: "Skipped · regeneration",
      updated: "Now",
      freshness: "Now",
      description: reason,
      facts: { ...pickup.facts, Deviation: reason },
      allowedTransitions: [],
    })
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
      routes.push({
        ...existing,
        status: "Cancelled",
        updated: "Now",
        freshness: "Now",
        description: `Cancelled by regeneration — ${planned.note ?? "no longer served"}.`,
        facts: {
          ...existing.facts,
          Deviation: planned.note ?? "Scheme no longer serves this date",
        },
        allowedTransitions: [],
        submittedValues: {
          ...existing.submittedValues,
          // Marks this cancel as generation bookkeeping so a later run may
          // re-create the route when the scheme serves the date again.
          cancelledByGeneration: true,
          ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
        },
      })
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
      ? `Moved from ${formatServiceDate(planned.serviceDate)} · ${planned.deviation.reason}`
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
        ...(schemeFacts.Contractor ? { Contractor: schemeFacts.Contractor } : {}),
        ...(schemeFacts["Departure depot"]
          ? { Depot: schemeFacts["Departure depot"] }
          : {}),
        ...(schemeFacts["Unloading station"]
          ? { Unloading: schemeFacts["Unloading station"] }
          : {}),
        "Time window": `${startTime}–${addMinutes(startTime, stops * MINUTES_PER_STOP + CLOSEOUT_MINUTES)}`,
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
      contractorId: scheme.contractorId,
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
        value: `${addMinutes(startTime, index * MINUTES_PER_STOP)} · Scheduled`,
        updated: "Now",
        description: `Generated with ${planned.routeName} from route scheme ${scheme.name}.`,
        facts: {
          Route: planned.routeName,
          Stop: String(index + 1),
          Type: "Collection",
          Scheduled: addMinutes(startTime, index * MINUTES_PER_STOP),
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
        contractorId: scheme.contractorId,
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
