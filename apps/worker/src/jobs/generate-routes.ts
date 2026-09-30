// Generation as a job (Issue #97 part B, ADR-0002): `planning.generate-routes`
// turns one validated Route Scheme's rules into dated Routes and Pickups over
// one window, recorded on a `generation_run` the sender wrote first — the
// nightly `planning.plan-ahead` (plan-ahead.ts), or the office's button,
// `POST /route-schemes/:id/generate` in apps/api. The decisions are the domain's
// (@waste/domain/planning/generation); this file is the I/O shell around
// them: it reads the rows, asks the database the one question only it can
// answer (which containers are eligible on a day and inside the boundary in
// force, stop-matching.ts), writes what the domain decided, and stamps the
// run.
//
// One transaction, as `wms_api` under `withCompany` on the API role's pool,
// so every row is fenced by the tenant exactly as a request's is: the run is
// locked and marked `running`; the scheme's row lock is taken, the same lock
// the API's patches take, so an edit in flight waits for the run and a run
// in flight makes an edit wait; the scheme, its groups by position with their
// rule sets and picked containers, the project's working week and, where it
// names a holiday list, the holidays of its calendars near the walk are read;
// the domain plans the routes; the routes of the scheme inside the walk are
// read `for update`, so a dispatch racing the run takes its turn; the stop
// candidates of every service date the run writes are one statement; the
// creates take their numbers from the company's counter in one `update …
// returning` (a block, whose row lock is the serialisation, so two runs never
// share a number and no route is renumbered); then the writes, then the drift
// stamps, then the run marked `succeeded` with its counts. A failure rolls
// all of it back and a second, small transaction marks the run `failed` with
// the `loggable` projection of the error; the job then fails, pg-boss retries
// it twice with backoff, and a third failure leaves the run `failed` for the
// list to show. A run already `succeeded` — a replay — writes nothing.
//
// What a run writes, per the domain's decision: `create` inserts a `planned`
// route with its number, the scheme's start time, depot and station and the
// group's vehicle, driver and provider as the Planned Assignment, and its
// pickups in stop order with the place and the fraction resolved once on the
// service date; `refresh` brings a `planned` route to what the run plans and
// writes only where something differs — the operating date, the note, the
// assignment copied afresh (refreshed only while `planned`: a dispatched
// route is frozen), or a pickup inserted, moved, brought back or skipped —
// so a second run of the same inputs writes no route and moves no
// `updated_at`; a `resurrect` brings a route an earlier run cancelled back to
// `planned`; `cancel` marks a `planned` route cancelled by generation with
// the sentence and skips its open pickups with `regeneration` as the reason,
// deleting nothing; `leave` and `omit` write nothing. The route that a run
// wrote names it (`generation_run_id`), and one it left alone keeps the run
// that last wrote it.
//
// The clock in what is written is the run's stamps, a cancellation's and a
// skip's instant (which the table's checks demand beside the status), and
// nothing else, so identical inputs give identical rows (ADR-0002).
//
// Once the run's transaction has committed, and outside it (#124 §4), the
// routes it created or reshaped — a stop inserted, moved, brought back or
// skipped, the depot or the station changed — are handed to the horizon
// (routing-horizon.ts, #172), which asks a Plan for each operating inside
// tomorrow…today + 7, one transaction per route. Generation never calls the
// provider and never waits on it; a route whose ask fails is a line in the
// log, never the run's failure, and waits for the night's sweep. A route
// whose Plan was active stays on it meanwhile, read stale (#124 §2). A
// replay asks nothing: the run it finds `succeeded` asked already, and the
// sweep covers a crash between the commit and the asks.
//
// The payload carries the company beside the run, so the handler opens the
// fenced transaction without a cross-tenant read first; the sender knows both.
// The queue's name and the payload are @waste/db/commands/generation's, since
// the office's button in apps/api sends the same job as the nightly sweep.
import type { Tx } from "@waste/db/client"
import { GENERATE_ROUTES_QUEUE, type GenerateRoutesData } from "@waste/db/commands/generation"
import { collectionCalendarHoliday } from "@waste/db/schema/collection-calendars"
import { containerTypeVehicleType } from "@waste/db/schema/fleet-types"
import { pickup, route } from "@waste/db/schema/execution"
import { generationMatch, generationRun } from "@waste/db/schema/generation"
import { company, project } from "@waste/db/schema/organisation"
import { collectionGroup, collectionGroupContainer, collectionGroupContainerType, collectionGroupFraction, routeScheme } from "@waste/db/schema/route-schemes"
import { withCompany } from "@waste/db/tenant"
import type { PickupReason, PickupStatus, RouteStatus } from "@waste/domain/execution/vocabulary"
import {
  compatibilityKey,
  holidayListOf,
  matchStampOf,
  NO_PLANNING_AREA,
  noBoundaryInForce,
  pickupChanges,
  planRoutes,
  resolveStops,
  schemeRecurrenceOf,
  stampMoved,
  walkWindow,
  type ExistingPickup,
  type GenerationGroup,
  type MatchStamp,
  type PlannedStop,
  type RouteDecision,
  type StopGroup,
} from "@waste/domain/planning/generation"
import type { HolidayPolicy, RecurrenceFrequency, ServiceDay, StopSource, WeekRotation } from "@waste/domain/planning/vocabulary"
import { SHIFT_SEARCH_DAYS } from "@waste/domain/route-schemes/occurrences"
import { addDays } from "@waste/domain/route-schemes/recurrence"
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm"

import { defineJob, type JobContext } from "./definition"
import { loggable } from "./loggable"
import { planReshaped, type HorizonAsks, type ReshapedRoute } from "./routing-horizon"
import { daysWithBoundary, stopCandidatesByDay } from "./stop-matching"

/** What one run did, as the run row records it. */
export type GenerationCounts = {
  routesCreated: number
  routesRefreshed: number
  routesCancelled: number
  pickupsWritten: number
  holidaysSkipped: number
  unlocated: number
  warnings: string[]
}

/** A draft plans nothing: said on the run rather than thrown, since it is the scheme's state and not a failure. */
export const DRAFT_GENERATES_NOTHING = "The scheme is a draft; a draft generates nothing"

/** What a run's transaction came to: the counts and the routes it created or reshaped, or that the run was already done. */
type Generated = { kind: "succeeded"; counts: GenerationCounts; projectId: string; reshaped: ReshapedRoute[] } | { kind: "already-done"; status: string }

/** What a run came to: the counts and the Plans the horizon asked for its routes (routing-horizon.ts), or that the run was already done. */
type Outcome = { kind: "succeeded"; counts: GenerationCounts; horizon: HorizonAsks } | { kind: "already-done"; status: string }

/** The block of numbers the creates take: one `update … returning` under the company's row lock; the first number of the block. */
async function takeNumbers(tx: Tx, companyId: string, count: number): Promise<number> {
  if (count === 0) return 0
  const [row] = await tx
    .update(company)
    .set({ nextRouteNumber: sql`${company.nextRouteNumber} + ${count}` })
    .where(eq(company.id, companyId))
    .returning({ next: company.nextRouteNumber })
  if (row === undefined) throw new Error(`no company ${companyId} to number routes in`)
  return row.next - count
}

/** The stop as a pickup row's columns. */
const pickupColumnsOf = (stop: PlannedStop) => ({
  containerId: stop.containerId,
  position: stop.position,
  propertyId: stop.propertyId,
  sharedCollectionPointId: stop.sharedCollectionPointId,
  wasteFractionId: stop.wasteFractionId,
})

/** The generation over one run, inside the fenced transaction. */
async function generate(tx: Tx, runId: string, companyId: string, at: Date): Promise<Generated> {
  const [run] = await tx.select().from(generationRun).where(and(eq(generationRun.companyId, companyId), eq(generationRun.id, runId))).for("update")
  if (run === undefined) throw new Error(`no generation run ${runId} in company ${companyId}`)
  if (run.status === "succeeded") return { kind: "already-done", status: run.status }
  await tx.update(generationRun).set({ status: "running", startedAt: at, finishedAt: null, error: null }).where(eq(generationRun.id, run.id))

  const scope = { companyId, projectId: run.projectId }
  const [scheme] = await tx.select().from(routeScheme).where(and(eq(routeScheme.companyId, companyId), eq(routeScheme.id, run.routeSchemeId))).for("update")
  if (scheme === undefined) throw new Error(`no route scheme ${run.routeSchemeId} for generation run ${run.id}`)

  const counts: GenerationCounts = { routesCreated: 0, routesRefreshed: 0, routesCancelled: 0, pickupsWritten: 0, holidaysSkipped: 0, unlocated: 0, warnings: [] }
  // The routes whose stops or ends this run wrote: the horizon's to ask a Plan for, once the transaction has committed.
  const reshaped: ReshapedRoute[] = []
  if (scheme.status !== "validated") {
    counts.warnings.push(DRAFT_GENERATES_NOTHING)
    return { kind: "succeeded", counts, projectId: run.projectId, reshaped }
  }

  // The scheme's groups by position, ties by id, with their rule sets and picked containers.
  const groups = await tx
    .select()
    .from(collectionGroup)
    .where(and(eq(collectionGroup.companyId, companyId), eq(collectionGroup.routeSchemeId, scheme.id)))
    .orderBy(asc(collectionGroup.position), asc(collectionGroup.id))
  const groupIds = groups.map((group) => group.id)
  const [fractions, containerTypes, picked] =
    groupIds.length === 0
      ? [[], [], []]
      : await Promise.all([
          tx.select({ groupId: collectionGroupFraction.collectionGroupId, id: collectionGroupFraction.wasteFractionId }).from(collectionGroupFraction).where(and(eq(collectionGroupFraction.companyId, companyId), inArray(collectionGroupFraction.collectionGroupId, groupIds))),
          tx.select({ groupId: collectionGroupContainerType.collectionGroupId, id: collectionGroupContainerType.containerTypeId }).from(collectionGroupContainerType).where(and(eq(collectionGroupContainerType.companyId, companyId), inArray(collectionGroupContainerType.collectionGroupId, groupIds))),
          tx
            .select({ groupId: collectionGroupContainer.collectionGroupId, id: collectionGroupContainer.containerId, position: collectionGroupContainer.position })
            .from(collectionGroupContainer)
            .where(and(eq(collectionGroupContainer.companyId, companyId), inArray(collectionGroupContainer.collectionGroupId, groupIds)))
            .orderBy(asc(collectionGroupContainer.position)),
        ])
  const of = <T extends { groupId: string }>(rows: T[], groupId: string): T[] => rows.filter((row) => row.groupId === groupId)
  const stopGroups: StopGroup[] = groups.map((group) => ({
    id: group.id,
    position: group.position,
    stopSource: group.stopSource as StopSource,
    rule:
      group.stopSource === "rule"
        ? { fractionIds: of(fractions, group.id).map((row) => row.id), containerTypeIds: of(containerTypes, group.id).map((row) => row.id), vehicleTypeId: group.ruleVehicleTypeId }
        : null,
    pickedContainerIds: of(picked, group.id).map((row) => row.id),
  }))
  const stopGroupOf = new Map(stopGroups.map((group) => [group.id, group]))
  const groupOf = new Map(groups.map((group) => [group.id, group]))
  const planningGroups: GenerationGroup[] = groups.map((group) => ({ id: group.id, position: group.position, days: group.days as ServiceDay[], stopSource: group.stopSource as StopSource }))

  // The project's working week and its holidays near the walk: a recurrence date lies inside it and a shift walks at most SHIFT_SEARCH_DAYS from one.
  const [calendar] = await tx.select({ weekend: project.weekend, holidayList: project.holidayList }).from(project).where(and(eq(project.companyId, companyId), eq(project.id, scheme.projectId)))
  if (calendar === undefined) throw new Error(`no project ${scheme.projectId} for route scheme ${scheme.id}`)
  const window = { from: run.windowFrom, to: run.windowTo }
  const recurrence = schemeRecurrenceOf({
    frequency: scheme.frequency as RecurrenceFrequency,
    serviceDays: scheme.serviceDays as ServiceDay[],
    weekRotation: scheme.weekRotation as WeekRotation | null,
    validFrom: scheme.validFrom,
    validTo: scheme.validTo,
  })
  const holidayRows =
    calendar.holidayList === null
      ? []
      : await tx
          .select({ day: collectionCalendarHoliday.day, name: collectionCalendarHoliday.name })
          .from(collectionCalendarHoliday)
          .where(
            and(
              eq(collectionCalendarHoliday.companyId, companyId),
              eq(collectionCalendarHoliday.projectId, scheme.projectId),
              gte(collectionCalendarHoliday.day, addDays(window.from, -SHIFT_SEARCH_DAYS)),
              lte(collectionCalendarHoliday.day, addDays(window.to, SHIFT_SEARCH_DAYS)),
            ),
          )
  const holidays = holidayListOf(holidayRows, calendar.holidayList)

  // The routes of the scheme inside the walk, locked: a dispatch racing the run takes its turn.
  const walk = walkWindow(window)
  const existingRoutes = await tx
    .select()
    .from(route)
    .where(and(eq(route.companyId, companyId), eq(route.routeSchemeId, scheme.id), gte(route.serviceDate, walk.from), lte(route.serviceDate, walk.to)))
    .for("update")
  const plan = planRoutes({
    recurrence,
    holidayPolicy: scheme.holidayPolicy as HolidayPolicy,
    calendar: { holidays, weekend: calendar.weekend as ServiceDay[] },
    window,
    groups: planningGroups,
    existingRoutes: existingRoutes.map((row) => ({ id: row.id, collectionGroupId: row.collectionGroupId, serviceDate: row.serviceDate, status: row.status as RouteStatus, cancelledByGeneration: row.cancelledByGeneration })),
  })
  counts.holidaysSkipped = plan.holidaysSkipped

  // The stop candidates of every day the run writes stops for, and of the walk's first day for the stamp, in one statement.
  const writing = plan.decisions.filter((decision): decision is Extract<RouteDecision, { kind: "create" | "refresh" }> => decision.kind === "create" || decision.kind === "refresh")
  const days = [...new Set([...writing.map((decision) => decision.serviceDate), plan.walk.from])].sort()
  const candidatesByDay = await stopCandidatesByDay(tx, scope, scheme.planningAreaId, days)
  const compatible = new Set((await tx.select({ containerTypeId: containerTypeVehicleType.containerTypeId, vehicleTypeId: containerTypeVehicleType.vehicleTypeId }).from(containerTypeVehicleType).where(eq(containerTypeVehicleType.companyId, companyId))).map((row) => compatibilityKey(row.containerTypeId, row.vehicleTypeId)))
  const hasRuleGroup = stopGroups.some((group) => group.stopSource === "rule")
  if (hasRuleGroup && scheme.planningAreaId === null) {
    counts.warnings.push(NO_PLANNING_AREA)
  } else if (hasRuleGroup && scheme.planningAreaId !== null) {
    const covered = await daysWithBoundary(tx, companyId, scheme.planningAreaId, days)
    for (const day of days) if (!covered.has(day)) counts.warnings.push(noBoundaryInForce(day))
  }

  // Every group's stops per day, the tie-breaks applied once per day over the groups that write that day.
  const stopsByDay = new Map<string, ReturnType<typeof resolveStops>>()
  const unlocated = new Set<string>()
  for (const day of new Set(writing.map((decision) => decision.serviceDate))) {
    const running = writing.filter((decision) => decision.serviceDate === day).map((decision) => stopGroupOf.get(decision.groupId)!)
    const resolved = resolveStops(running, candidatesByDay.get(day) ?? [], compatible)
    stopsByDay.set(day, resolved)
    for (const id of resolved.unlocated) unlocated.add(id)
  }
  counts.unlocated = unlocated.size

  // The existing pickups of the routes a refresh may touch, once.
  const refreshing = plan.decisions.filter((decision): decision is Extract<RouteDecision, { kind: "refresh" | "cancel" }> => decision.kind === "refresh" || decision.kind === "cancel").map((decision) => decision.routeId)
  const existingPickups = refreshing.length === 0 ? [] : await tx.select().from(pickup).where(and(eq(pickup.companyId, companyId), inArray(pickup.routeId, refreshing)))
  const pickupsOf = (routeId: string): ExistingPickup[] =>
    existingPickups
      .filter((row) => row.routeId === routeId)
      .map((row) => ({ id: row.id, containerId: row.containerId, position: row.position, status: row.status as PickupStatus, reason: row.reason as PickupReason | null, propertyId: row.propertyId, sharedCollectionPointId: row.sharedCollectionPointId, wasteFractionId: row.wasteFractionId }))
  const existingRouteOf = new Map(existingRoutes.map((row) => [row.id, row]))

  // The Planned Assignment a create copies and a refresh copies afresh while planned: the group's vehicle, driver and provider, the scheme's start, depot and station.
  const assignmentOf = (groupId: string) => {
    const group = groupOf.get(groupId)!
    return {
      plannedStartTime: scheme.plannedStartTime,
      plannedVehicleId: group.vehicleId,
      plannedDriverId: group.driverId,
      plannedServiceProviderId: group.serviceProviderId,
      depotId: scheme.depotId,
      unloadingStationId: scheme.unloadingStationId,
    }
  }

  const numbers = { next: await takeNumbers(tx, companyId, plan.decisions.filter((decision) => decision.kind === "create").length) }

  for (const decision of plan.decisions) {
    if (decision.kind === "leave" || decision.kind === "omit") continue

    if (decision.kind === "cancel") {
      await tx
        .update(route)
        .set({ status: "cancelled", cancelledAt: at, cancelledByGeneration: true, note: decision.note, generationRunId: run.id })
        .where(and(eq(route.companyId, companyId), eq(route.id, decision.routeId)))
      const open = pickupsOf(decision.routeId).filter((row) => row.status === "planned").map((row) => row.id)
      if (open.length > 0) {
        await tx.update(pickup).set({ status: "skipped", reason: "regeneration", note: decision.note, outcomeAt: at }).where(and(eq(pickup.companyId, companyId), inArray(pickup.id, open)))
      }
      counts.routesCancelled += 1
      continue
    }

    const stops = stopsByDay.get(decision.serviceDate)?.stops.get(decision.groupId) ?? []
    const assignment = assignmentOf(decision.groupId)

    if (decision.kind === "create") {
      const number = numbers.next
      numbers.next += 1
      const [created] = await tx
        .insert(route)
        .values({
          ...scope,
          routeSchemeId: scheme.id,
          collectionGroupId: decision.groupId,
          serviceDate: decision.serviceDate,
          operatingDate: decision.operatingDate,
          status: "planned",
          note: decision.note,
          number,
          generationRunId: run.id,
          ...assignment,
        })
        .returning({ id: route.id })
      if (stops.length > 0) {
        await tx.insert(pickup).values(stops.map((stop) => ({ ...scope, routeId: created.id, ...pickupColumnsOf(stop) })))
      }
      reshaped.push({ id: created.id, operatingDate: decision.operatingDate })
      counts.routesCreated += 1
      counts.pickupsWritten += stops.length
      continue
    }

    // A refresh: what differs is written, and only that.
    const current = existingRouteOf.get(decision.routeId)!
    const changes = pickupChanges(pickupsOf(decision.routeId), stops)
    const endsMoved = current.depotId !== assignment.depotId || current.unloadingStationId !== assignment.unloadingStationId
    const routeMoved =
      decision.resurrect ||
      endsMoved ||
      current.operatingDate !== decision.operatingDate ||
      current.note !== decision.note ||
      current.plannedStartTime !== assignment.plannedStartTime ||
      current.plannedVehicleId !== assignment.plannedVehicleId ||
      current.plannedDriverId !== assignment.plannedDriverId ||
      current.plannedServiceProviderId !== assignment.plannedServiceProviderId
    const pickupsMoved = changes.insert.length + changes.update.length + changes.skip.length > 0
    if (!routeMoved && !pickupsMoved) continue
    // Reshaped: a stop inserted, moved, brought back or skipped — a route brought back brings its stops back — or an end changed: what a Plan is over (#124 §2). A new note, day or crew is not.
    if (pickupsMoved || endsMoved) reshaped.push({ id: decision.routeId, operatingDate: decision.operatingDate })

    await tx
      .update(route)
      .set({
        operatingDate: decision.operatingDate,
        note: decision.note,
        generationRunId: run.id,
        ...assignment,
        ...(decision.resurrect ? { status: "planned", cancelledAt: null, cancelledByGeneration: false } : {}),
      })
      .where(and(eq(route.companyId, companyId), eq(route.id, decision.routeId)))
    if (changes.insert.length > 0) {
      await tx.insert(pickup).values(changes.insert.map((stop) => ({ ...scope, routeId: decision.routeId, ...pickupColumnsOf(stop) })))
    }
    for (const change of changes.update) {
      await tx
        .update(pickup)
        .set({ ...pickupColumnsOf(change), ...(change.resurrect ? { status: "planned", reason: null, note: null, outcomeAt: null } : {}) })
        .where(and(eq(pickup.companyId, companyId), eq(pickup.id, change.id)))
    }
    for (const skipped of changes.skip) {
      await tx.update(pickup).set({ status: "skipped", reason: "regeneration", note: skipped.note, outcomeAt: at }).where(and(eq(pickup.companyId, companyId), eq(pickup.id, skipped.id)))
    }
    counts.routesRefreshed += 1
    counts.pickupsWritten += changes.insert.length + changes.update.length
  }

  // The drift stamp (#41): each rule group's matches as of the walk's first day, written where it moved.
  const firstDay = candidatesByDay.get(plan.walk.from) ?? []
  for (const group of stopGroups) {
    if (group.rule === null) continue
    const next: MatchStamp = matchStampOf(group.rule, scheme.planningAreaId, firstDay, compatible)
    const [latest] = await tx
      .select({ ruleSignature: generationMatch.ruleSignature, containerIds: generationMatch.containerIds })
      .from(generationMatch)
      .where(and(eq(generationMatch.companyId, companyId), eq(generationMatch.collectionGroupId, group.id)))
      .orderBy(desc(generationMatch.id))
      .limit(1)
    if (!stampMoved(latest, next)) continue
    await tx.insert(generationMatch).values({ ...scope, collectionGroupId: group.id, generationRunId: run.id, ruleSignature: next.ruleSignature, containerIds: [...next.containerIds] })
  }

  return { kind: "succeeded", counts, projectId: run.projectId, reshaped }
}

/**
 * Runs one generation run to its end: succeeded with its counts, or failed
 * with the error on the row and rethrown for pg-boss to retry. Once the run
 * has committed, the horizon asks its created and reshaped routes their Plans
 * (routing-horizon.ts), which never fails the run.
 */
export async function runGeneration(data: GenerateRoutesData, jobId: string | null, context: JobContext): Promise<Outcome> {
  const { api, now, log } = context
  const startedAt = now()
  let generated: Generated
  try {
    generated = await withCompany(api.db, data.companyId, async (tx) => {
      const outcome = await generate(tx, data.generationRunId, data.companyId, startedAt)
      if (outcome.kind === "succeeded") {
        await tx
          .update(generationRun)
          .set({ status: "succeeded", finishedAt: now(), jobId, ...outcome.counts })
          .where(and(eq(generationRun.companyId, data.companyId), eq(generationRun.id, data.generationRunId)))
      }
      return outcome
    })
  } catch (error) {
    const projection = loggable(error)
    log(`${GENERATE_ROUTES_QUEUE}: run ${data.generationRunId} failed: ${JSON.stringify(projection)}`)
    await withCompany(api.db, data.companyId, (tx) =>
      tx
        .update(generationRun)
        .set({ status: "failed", finishedAt: now(), jobId, error: JSON.stringify(projection) })
        .where(and(eq(generationRun.companyId, data.companyId), eq(generationRun.id, data.generationRunId))),
    )
    throw error
  }
  if (generated.kind === "already-done") return generated
  const horizon = await planReshaped(context, { companyId: data.companyId, projectId: generated.projectId }, generated.reshaped)
  return { kind: "succeeded", counts: generated.counts, horizon }
}

export const generateRoutes = defineJob<GenerateRoutesData>({
  queue: GENERATE_ROUTES_QUEUE,
  description: "Turns one validated route scheme's rules into dated routes and pickups over a window, idempotently by (scheme, group, service date), on the generation run the sender wrote.",
  // One job per scheme queued or active at a time: `singletonKey` is the scheme's id on every send, so a scheme mid-generation is not queued twice and the sender is told so (a null id) rather than given a second run. An hour to run: a large project over the full `WALK_CAP_DAYS` walk is one transaction, and a job pg-boss expired while it still ran would be retried into the run's own lock, to find it `succeeded` and log a retry nothing needed.
  queueOptions: { policy: "exclusive", retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 60 * 60 },
  handler: async (jobs, context) => {
    const outcomes: Array<{ runId: string; outcome: string }> = []
    for (const job of jobs) {
      const outcome = await runGeneration(job.data, job.id, context)
      context.log(
        `${GENERATE_ROUTES_QUEUE}: run ${job.data.generationRunId} ${outcome.kind === "succeeded" ? `succeeded (${outcome.counts.routesCreated} created, ${outcome.counts.routesRefreshed} refreshed, ${outcome.counts.routesCancelled} cancelled, ${outcome.counts.pickupsWritten} pickups; ${outcome.horizon.asked.length} asked a Plan${outcome.horizon.failed.length === 0 ? "" : `, ${outcome.horizon.failed.length} left to the sweep`})` : `already ${outcome.status}`} (job ${job.id})`,
      )
      outcomes.push({ runId: job.data.generationRunId, outcome: outcome.kind })
    }
    return { runs: outcomes }
  },
})
