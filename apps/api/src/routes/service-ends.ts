// What a container leaving service — or coming back to it — leaves on the
// routes, and the generation runs that put them right (#291, slice 10). A
// termination (routes/agreements.ts) ends its containers' service on a day;
// a subscription's pause (routes/subscription-pauses.ts) suspends it over a
// window, and a pause shortened or cancelled gives days back. Generation reads
// the Registry's placements and the pauses on every service date it walks
// (apps/worker's stop-matching.ts), so a run over the days that moved puts its
// planned routes right: the stops of a container out of service go, and those
// of one back in service come. Two kinds of stop no run touches, and those are
// named for the office to remove by hand: a stop on a dispatched or running
// route, which generation never refreshes, and the office's own, which it
// never skips or moves (#111).
//
// The runs are asked as `release-hold` asks one (#245): best effort, only
// where the caller may ask a run of the scheme (Generate's grant), only of a
// validated scheme, from the window's first day — or the project's today, or
// the scheme's first day, whichever is latest — through the last planned
// route the run should read, capped at the walk's days, absorbed by a run of
// the scheme already queued, and never a refusal of the command: where no
// worker has made the queue yet nothing is asked, and the next run — the
// nightly plan-ahead's or the next Generate's — puts the routes right. Every
// day here is a service date, the day generation matches a container on, and
// every statement is the containers' project's.
import type { StopToRemove } from "@waste/contracts/agreements"
import { routeLabel } from "@waste/contracts/execution"
import type { Tx } from "@waste/db/client"
import { QueueMissing, type JobSender } from "@waste/db/jobs"
import { pickup, route } from "@waste/db/schema/execution"
import { WALK_CAP_DAYS } from "@waste/domain/route-schemes/generation"
import { addDays } from "@waste/domain/route-schemes/recurrence"
import { and, asc, eq, gte, inArray, isNotNull, lt, max, ne, notInArray, or } from "drizzle-orm"

import type { Principal } from "../auth/principal"
import { allows } from "../auth/require"
import { projectToday } from "./fleet-lookups"
import { askGeneration } from "./generation"
import type { Scope } from "./references"
import { findScheme, MODULE as SCHEMES_MODULE } from "./scheme-groups"

/** The days a change of service covers: from `from`, up to `to` exclusive, or open. */
export type Window = { from: string; to: string | null }

/** The run to ask of each scheme, by id: from a day through its last service date to read, both inclusive. */
export type RunWindows = ReadonlyMap<string, { from: string; to: string }>

/** The routes a stop at a container can still be standing on: not yet completed or cancelled. */
const OPEN_ROUTES = ["planned", "ready", "active"] as const

/** How far back a container's stops say which schemes serve it, for days given back: the window the office's routes are read over (`ROUTES_WINDOW_DAYS` in the web's records). */
export const SERVED_DAYS = 35

const within = (window: Window) => and(gte(route.serviceDate, window.from), window.to === null ? undefined : lt(route.serviceDate, window.to))

/**
 * The planned stops at these containers over the window, which their leaving
 * service strands: those no run will take away, for the office (`toRemove`,
 * oldest first), and, by scheme, the run over the planned routes whose
 * generated stops a run of the scheme will drop, through the last of them. A
 * removal or a swap of one of the containers is how it leaves service (O3b of
 * #290, D9): the office keeps that stop. Beside them, the planned deliveries
 * booked under `deliveriesUnder` — the subscriptions a termination ends —
 * whose bin would go into service under a subscription out of force, and
 * which hold it from another booking meanwhile.
 */
export async function stopsLeft(tx: Tx, scope: Scope, containerIds: readonly string[], window: Window, deliveriesUnder: readonly string[] = []): Promise<{ toRemove: StopToRemove[]; runs: RunWindows }> {
  const toRemove: StopToRemove[] = []
  const runs = new Map<string, { from: string; to: string }>()
  const which = [
    ...(containerIds.length === 0 ? [] : [and(inArray(pickup.containerId, [...containerIds]), notInArray(pickup.service, ["remove", "swap"]))]),
    ...(deliveriesUnder.length === 0 ? [] : [and(eq(pickup.service, "deliver"), inArray(pickup.subscriptionId, [...deliveriesUnder]))]),
  ]
  if (which.length === 0) return { toRemove, runs }
  const rows = await tx
    .select({
      routeId: route.id,
      number: route.number,
      status: route.status,
      routeSchemeId: route.routeSchemeId,
      serviceDate: route.serviceDate,
      operatingDate: route.operatingDate,
      pickupId: pickup.id,
      containerId: pickup.containerId,
      origin: pickup.origin,
    })
    .from(pickup)
    .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
    .where(
      and(
        eq(pickup.companyId, scope.companyId),
        eq(pickup.projectId, scope.projectId),
        or(...which),
        eq(pickup.status, "planned"),
        inArray(route.status, [...OPEN_ROUTES]),
        within(window),
      ),
    )
    .orderBy(asc(route.operatingDate), asc(route.number), asc(pickup.id))
  for (const row of rows) {
    if (row.status === "planned" && row.origin === "generation" && row.routeSchemeId !== null) {
      const run = runs.get(row.routeSchemeId)
      if (run === undefined || row.serviceDate > run.to) runs.set(row.routeSchemeId, { from: window.from, to: row.serviceDate })
    } else if (row.containerId !== null) {
      toRemove.push({ routeId: row.routeId, routeLabel: routeLabel(row.number), operatingDate: row.operatingDate, pickupId: row.pickupId, containerId: row.containerId })
    }
  }
  return { toRemove, runs }
}

/**
 * The runs that bring these containers' stops back over days given back to
 * service — a pause shortened or cancelled — whose routes carry no stop of
 * theirs to say which schemes serve them: the schemes whose routes stopped
 * at them in the `SERVED_DAYS` before the window, or stop at them in it,
 * each through its last planned route in the window, where it has one; a
 * scheme with none plans those days when its horizon reaches them.
 */
export async function runsBringingBack(tx: Tx, scope: Scope, containerIds: readonly string[], window: Window): Promise<RunWindows> {
  const runs = new Map<string, { from: string; to: string }>()
  if (containerIds.length === 0) return runs
  const serving = await tx
    .selectDistinct({ routeSchemeId: route.routeSchemeId })
    .from(pickup)
    .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
    .where(
      and(
        eq(pickup.companyId, scope.companyId),
        eq(pickup.projectId, scope.projectId),
        inArray(pickup.containerId, [...containerIds]),
        ne(route.status, "cancelled"),
        isNotNull(route.routeSchemeId),
        within({ from: addDays(window.from, -SERVED_DAYS), to: window.to }),
      ),
    )
  const schemeIds = serving.flatMap((row) => (row.routeSchemeId === null ? [] : [row.routeSchemeId]))
  if (schemeIds.length === 0) return runs
  const last = await tx
    .select({ routeSchemeId: route.routeSchemeId, until: max(route.serviceDate) })
    .from(route)
    .where(and(eq(route.companyId, scope.companyId), eq(route.projectId, scope.projectId), inArray(route.routeSchemeId, schemeIds), eq(route.status, "planned"), within(window)))
    .groupBy(route.routeSchemeId)
  for (const row of last) if (row.routeSchemeId !== null && row.until !== null) runs.set(row.routeSchemeId, { from: window.from, to: row.until })
  return runs
}

/** The runs of several reasons as one per scheme: the earliest first day and the latest last, since a scheme takes one run at a time. */
export function mergedRuns(...all: RunWindows[]): RunWindows {
  const merged = new Map<string, { from: string; to: string }>()
  for (const runs of all) {
    for (const [schemeId, run] of runs) {
      const held = merged.get(schemeId)
      merged.set(schemeId, held === undefined ? run : { from: run.from < held.from ? run.from : held.from, to: run.to > held.to ? run.to : held.to })
    }
  }
  return merged
}

/** Asks the runs, as the header says: best effort, and never a refusal of the command that asks them. */
export async function askRuns(tx: Tx, principal: Principal, jobs: JobSender, scope: Scope, runs: RunWindows, now: () => Date): Promise<void> {
  if (runs.size === 0 || !allows(principal.grants, SCHEMES_MODULE, "edit")) return
  const today = await projectToday(tx, scope, now)()
  for (const [schemeId, run] of runs) {
    const scheme = await findScheme(tx, principal, schemeId)
    if (scheme === undefined || scheme.status !== "validated") continue
    const from = [run.from, today, scheme.validFrom].reduce((latest, day) => (day > latest ? day : latest))
    const capped = addDays(from, WALK_CAP_DAYS)
    const to = run.to > capped ? capped : run.to
    if (to < from) continue
    try {
      await askGeneration(tx, principal, jobs.send, scheme, { from, to })
    } catch (error) {
      if (!(error instanceof QueueMissing)) throw error
      return
    }
  }
}
