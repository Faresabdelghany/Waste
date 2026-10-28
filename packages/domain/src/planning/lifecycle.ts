// A Route Scheme's lifecycle on the API (O21 of #290): what ending a scheme
// from a day does to its dated Routes, the first day an ending may take
// effect, and the Plan Ahead window a scheme keeps planned.
//
// A scheme ends two ways. An archive ends it for good: the period is cut at
// the effective day, Plan Ahead is turned off and the scheme is marked, and
// nothing is erased — every route, stop, proof and billable event of its past
// stays as it stands. A new version ends it where the next row of the same
// name takes over. Either way the routes from that day on are the scheme's
// no longer, and they go exactly as generation lets a shortened scheme's
// routes go (planning/generation.ts): a `planned` route is cancelled with the
// sentence, unless it carries an open stop the office added (#111, a moved
// stop of O23 among them), when it is trimmed — the scheme's own open stops
// skipped, the route left planned for the office's — so no office stop is
// cancelled under it and nothing moved is billed twice. A held route is
// cancelled like any other, since the scheme no longer runs that collection,
// and its hold goes with the status. A route that is `ready` or beyond is
// operational reality and stays; the dispatched and running ones are counted,
// so the office knows which to cancel by hand. A route a person cancelled, or
// an earlier run, is already what it would become.
//
// The earliest effective day is tomorrow on the project's clock: today's
// routes are operating, the Plan Ahead convention (route-schemes/plan-ahead.ts).
//
// The Plan Ahead window is a scheme's setting, `plan_ahead_days`: the nightly
// sweep plans tomorrow through that many days ahead, 7 unless the office says
// otherwise and at most 28, four weeks, since every run re-plans and asks a
// Plan for each route it reshapes. The routing horizon keeps its own fixed
// week (route-schemes/plan-ahead.ts), since it spends the routing quota.
import { addDays } from "../route-schemes/recurrence"
import type { ExistingRoute, GenerationWindow, RouteDecision } from "./generation"

/** The window the nightly sweep plans when a scheme says nothing: the week it always planned. */
export const PLAN_AHEAD_DAYS_DEFAULT = 7
/** The longest window a scheme may ask the nightly sweep to keep planned: four weeks. */
export const PLAN_AHEAD_DAYS_MAX = 28

/** Whether a number of days is a window the sweep plans: a whole number in 1..`PLAN_AHEAD_DAYS_MAX`. */
export const planAheadDaysAllowed = (days: number): boolean => Number.isInteger(days) && days >= 1 && days <= PLAN_AHEAD_DAYS_MAX

/** The days a scheme's nightly run plans: tomorrow through `days` days ahead, both inclusive. */
export function planAheadRunWindow(today: string, days: number): GenerationWindow {
  return { from: addDays(today, 1), to: addDays(today, days) }
}

/** The first day an archive or a new version may take effect: tomorrow, since today's routes are operating. */
export const firstEndingDay = (today: string): string => addDays(today, 1)

/** The note an archived scheme's cancelled and trimmed routes carry. */
export const SCHEME_ARCHIVED_NOTE = "Route scheme archived — future planning stopped"

/** The note a scheme's routes carry where its next version takes over. */
export const supersededNote = (validFrom: string): string => `Superseded by the scheme's next version from ${validFrom}`

/** What ending a scheme from a day decides: each planned route cancelled or trimmed, and how many dispatched or running routes stay. */
export type SchemeEnding = {
  decisions: Extract<RouteDecision, { kind: "cancel" | "trim" }>[]
  /** The `ready` and `active` routes on or after the day, which stay as they are. */
  kept: number
}

/**
 * The scheme's routes from `from` on, decided as the header says, in service
 * date order then by id. Routes before `from` are not judged.
 */
export function routesEndedFrom(routes: readonly ExistingRoute[], from: string, note: string): SchemeEnding {
  const ending = routes.filter((route) => route.serviceDate >= from).sort((a, b) => a.serviceDate.localeCompare(b.serviceDate) || a.id.localeCompare(b.id))
  const decisions: SchemeEnding["decisions"] = []
  let kept = 0
  for (const route of ending) {
    if (route.status === "planned") decisions.push({ kind: route.officeStops ? "trim" : "cancel", routeId: route.id, groupId: route.collectionGroupId, serviceDate: route.serviceDate, note })
    else if (route.status === "ready" || route.status === "active") kept += 1
  }
  return { decisions, kept }
}
