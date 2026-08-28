// Manual route generation engine (spec docs/specs/ROUTE_SCHEMES.md FR-6–FR-10,
// ticket #7). Pure data logic — no UI or store dependencies — so the confirm
// preview and the record writes share one plan, and the upsert rules are
// harness-testable (scripts/route-scheme-generation-harness.ts).
//
// Upsert rules (validated in the prototype on branch prototype/route-schemes):
//   for each service date in the window:
//     actualDate = replacement date if an approved deviation matches, else the date
//     no route for (scheme, serviceDate)       → create Planned with scheme defaults
//     route still Draft/Planned                → refresh date/stops/version;
//                                                keep an overridden assignment
//     route Ready/Active/Completed/Cancelled   → leave untouched
//   routes in the window whose service date the scheme no longer serves:
//     still Planned → cancel ("scheme no longer serves this date"); else leave.
//   Route identity is (schemeId, serviceDate) — deterministic ids, never Date.now().

import type { BusinessRecord } from "../data/business-modules"
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

export type ApprovedDeviation = {
  name: string
  /** ISO date the scheme originally serves. */
  originalDate: string
  /** ISO date the route actually operates on. */
  replacementDate: string
  reason: string
  /** The deviation record's project scope; absent = applies project-wide. */
  projectIds?: string[]
}

export type PlannedRouteAction = "create" | "refresh" | "skip" | "cancel"

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
    deviations.push({
      name: record.name,
      originalDate,
      replacementDate,
      reason: record.facts?.Reason ?? "Approved deviation",
      ...(record.projectIds?.length ? { projectIds: [...record.projectIds] } : {}),
    })
  }
  return deviations
}

/**
 * FR-10's "matching scope": a deviation applies when it shares a project with
 * the scheme. A side without recorded projects is scope-unknown and treated as
 * project-wide — the deviation-preserving default.
 */
export function deviationMatchesScheme(
  deviation: ApprovedDeviation,
  scheme: BusinessRecord,
): boolean {
  if (!deviation.projectIds?.length || !scheme.projectIds?.length) return true
  return deviation.projectIds.some((projectId) =>
    scheme.projectIds?.includes(projectId),
  )
}

/* -------------------------------- planning -------------------------------- */

const REFRESHABLE_STATUSES = new Set(["Draft", "Planned"])

const stringValueOf = (record: BusinessRecord, key: string): string | undefined =>
  stringValue(record.submittedValues ?? {}, key)

/** A day-by-day walk is fine: windows are weeks, not years. */
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
 */
export function planSchemeGeneration(input: {
  scheme: BusinessRecord
  window: GenerationWindow
  existingRoutes: readonly BusinessRecord[]
  deviations: readonly ApprovedDeviation[]
}): SchemeGenerationPlan | null {
  const { scheme, window } = input
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

  for (const date of windowDates(window)) {
    if (!matchesRecurrence(recurrence, date)) continue
    servedDates.add(date)
    const day = serviceDayOf(date)
    const deviation = input.deviations.find(
      (candidate) =>
        candidate.originalDate === date &&
        deviationMatchesScheme(candidate, scheme),
    )
    const existing = existingByIdentity.get(date)
    const action: PlannedRouteAction = !existing
      ? "create"
      : REFRESHABLE_STATUSES.has(existing.status)
        ? "refresh"
        : "skip"
    routes.push({
      action,
      routeId: generatedRouteId(scheme.id, date),
      routeName: generatedRouteName(scheme.id, date),
      serviceDate: date,
      actualDate: deviation ? deviation.replacementDate : date,
      day,
      containerIds: stopsByDay.get(day) ?? [],
      ...(deviation ? { deviation } : {}),
      ...(existing ? { existing } : {}),
      ...(action === "skip"
        ? { note: `${existing?.status} — left untouched` }
        : {}),
    })
  }

  // Routes this scheme once generated inside the window but no longer serves:
  // still Planned → cancel; any further state is operational reality we keep.
  for (const [serviceDate, existing] of existingByIdentity) {
    if (servedDates.has(serviceDate)) continue
    if (serviceDate < window.from || serviceDate > window.to) continue
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
