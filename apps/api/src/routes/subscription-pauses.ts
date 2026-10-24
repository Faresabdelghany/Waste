// A Subscription's pause (#291, slice 10, scenario 12.5): an effective-dated
// suspension — a holiday, a season — through which generation plans no stop
// for the containers serving the subscription (apps/worker's
// stop-matching.ts reads it as `paused`). `POST /subscriptions/:id/pauses`
// writes one, `GET /subscription-pauses` lists them across the caller's
// projects and `GET /subscription-pauses/:id` reads one, `PATCH` moves it —
// its first day while it has not begun, its end, the day collections resume,
// while it has not ended, which is how the office resumes a pause — and
// `POST /subscription-pauses/:id/cancel` removes one that has not begun. The
// audit log is its history; the pause is a set of its subscription there.
//
// The rules the period holds: inside the subscription's (400 naming the
// bound), and one pause of a subscription in force at a time (the exclusion
// constraint, a 409 in its sentence). And the clock's: a pause begins today
// or later and ends today or later, on the project's clock, so no write here
// rewrites a day generation, a driver or a charge has already acted on. Every
// write takes the subscription's lock under its agreement's, top down, as the
// subscription's own patch does, so a pause and a shortening of the period
// it sits in take turns.
//
// A write changes what generation plans over the days it moves. Where days
// are paused, the stops already planned there go: a generation run of each
// scheme whose planned routes stop at the subscription's containers is asked,
// and the stops no run will take away — on a dispatched or running route, or
// the office's own — are answered for the office to remove by hand. Where
// days are given back, a run of each scheme that serves the containers brings
// their stops back. Both are best effort and never a refusal
// (routes/service-ends.ts says how).
//
// The grant is `customers.agreements`, `edit` for every write: a pause
// changes how a subscription is delivered, as its patch does.
import {
  SubscriptionPause,
  SubscriptionPauseCancel,
  SubscriptionPauseCreate,
  SubscriptionPaused,
  SubscriptionPauseListQuery,
  SubscriptionPausePatch,
} from "@waste/contracts/agreements"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import type { JobSender } from "@waste/db/jobs"
import { validOn } from "@waste/db/query/valid-on"
import { agreement, subscription, subscriptionPause } from "@waste/db/schema/agreements"
import { containerServicePlacement } from "@waste/db/schema/containers"
import { and, asc, eq, gt, isNull, lt, or } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { projectToday } from "./fleet-lookups"
import { OUTSIDE_SUBSCRIPTION } from "./lifecycle"
import { periodAfter, periodOf, requireWithin, type Period } from "./periods"
import type { ClockOptions } from "./scheme-groups"
import { askRuns, mergedRuns, runsBringingBack, stopsLeft, type Window } from "./service-ends"
import { describeCreated, describeJson, IdParam, lockRow, refuseOverlap, stampsOf } from "./shared"

const MODULE = "customers.agreements"
const PausePage = Page(SubscriptionPause)

/** `EXCLUDE USING gist (company_id, subscription_id, daterange)`: one pause of a subscription in force at a time. */
const PAUSED_ALREADY = "subscription_pause_no_overlap"
export const PAUSED_ALREADY_SENTENCE = "The subscription is already paused over part of that period"

export const BEGINS_TODAY_OR_LATER = "A pause begins today or later"
export const ENDS_TODAY_OR_LATER = "A pause ends today or later: collections resume on that day"
export const KEEPS_ITS_FIRST_DAY = "A pause that has begun keeps its first day"
export const pauseEnded = (day: string) => `This pause ended on ${day}; a later one is a new pause`
export const pauseBegun = (day: string) => `This pause began on ${day}; give it an end instead`

const noSuchPause = (id: string) => problem(404, { detail: `No pause ${id} in the projects this account works in` })
const noSuchSubscription = (id: string) => problem(404, { detail: `No subscription ${id} in the projects this account works in` })

const columns = {
  id: subscriptionPause.id,
  projectId: subscriptionPause.projectId,
  subscriptionId: subscriptionPause.subscriptionId,
  validFrom: subscriptionPause.validFrom,
  validTo: subscriptionPause.validTo,
  createdAt: subscriptionPause.createdAt,
  updatedAt: subscriptionPause.updatedAt,
}

type Row = Pick<typeof subscriptionPause.$inferSelect, keyof typeof columns>

const pauseOf = (row: Row): SubscriptionPause => ({
  id: row.id,
  projectId: row.projectId,
  subscriptionId: row.subscriptionId,
  validFrom: row.validFrom,
  validTo: row.validTo,
  ...stampsOf(row),
})

const scope = (principal: Principal) => and(eq(subscriptionPause.companyId, principal.companyId), inProjects(subscriptionPause.projectId, principal))

/** The subscription a pause hangs on, as a write needs it: its period, its project and the agreement whose lock comes first. */
type Parent = Period & { id: string; projectId: string; agreementId: string }

async function findSubscription(tx: Tx, principal: Principal, id: string): Promise<Parent | undefined> {
  const [row] = await tx
    .select({ id: subscription.id, projectId: subscription.projectId, agreementId: subscription.agreementId, validFrom: subscription.validFrom, validTo: subscription.validTo })
    .from(subscription)
    .where(and(eq(subscription.companyId, principal.companyId), inProjects(subscription.projectId, principal), eq(subscription.id, id)))
    .limit(1)
  return row
}

/** The subscription's locks, its agreement's first, top down; then the subscription read again underneath them. */
async function lockedSubscription(tx: Tx, principal: Principal, found: Parent): Promise<Parent> {
  await lockRow(tx, agreement, { companyId: principal.companyId, id: found.agreementId })
  await lockRow(tx, subscription, { companyId: principal.companyId, id: found.id })
  const current = await findSubscription(tx, principal, found.id)
  if (current === undefined) throw noSuchSubscription(found.id)
  return current
}

async function findPause(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx.select(columns).from(subscriptionPause).where(and(scope(principal), eq(subscriptionPause.id, id))).limit(1)
  return row
}

/** The containers serving the subscription on any day of the window: what its pause suspends, or gives back. */
async function containersOf(tx: Tx, companyId: string, subscriptionId: string, window: Window): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ containerId: containerServicePlacement.containerId })
    .from(containerServicePlacement)
    .where(
      and(
        eq(containerServicePlacement.companyId, companyId),
        eq(containerServicePlacement.subscriptionId, subscriptionId),
        window.to === null ? undefined : lt(containerServicePlacement.validFrom, window.to),
        or(isNull(containerServicePlacement.validTo), gt(containerServicePlacement.validTo, window.from)),
      ),
    )
  return rows.map((row) => row.containerId)
}

const windowOf = (period: Period): Window => ({ from: period.validFrom, to: period.validTo })

export function subscriptionPauseRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date(), jobs }: ClockOptions & { jobs: JobSender }) {
  return new Hono<AuthEnv>()
    .get(
      "/subscription-pauses",
      describeRoute({
        operationId: "listSubscriptionPauses",
        summary: "The pauses of the caller's projects' subscriptions",
        description:
          "One page of subscription pauses, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none reads an empty page. `projectId` narrows it to one of those projects, naming another being refused; `subscriptionId` to one subscription's; `validOn` to the pauses in force on that day, `validFrom` inclusive and `validTo` exclusive. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of pauses.", PausePage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.agreements`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", SubscriptionPauseListQuery),
      async (c) => {
        const { limit, cursor, projectId, subscriptionId, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(columns)
          .from(subscriptionPause)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(subscriptionPause.projectId, projectId),
              subscriptionId === undefined ? undefined : eq(subscriptionPause.subscriptionId, subscriptionId),
              day === undefined ? undefined : validOn(subscriptionPause, day),
              after === undefined ? undefined : gt(subscriptionPause.id, after),
            ),
          )
          .orderBy(asc(subscriptionPause.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(pauseOf), limit))
      },
    )
    .get(
      "/subscription-pauses/:id",
      describeRoute({
        operationId: "getSubscriptionPause",
        summary: "One subscription pause",
        description: "One pause of a subscription of a project the caller works in. A pause of another company, or of a project this account does not work in, is a pause that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The pause.", SubscriptionPause),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.agreements`."),
          404: describeProblem("No pause with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findPause(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchPause(id)
        return c.json(pauseOf(row))
      },
    )
    .post(
      "/subscriptions/:id/pauses",
      describeRoute({
        operationId: "pauseSubscription",
        summary: "Pause a subscription over a period",
        description:
          "Pauses the subscription the path names from `validFrom` until `validTo`, the day collections resume, or until it is resumed where `validTo` is absent or null: generation plans no stop for the containers serving it on those days. The period lies inside the subscription's (400 naming the bound) and begins today or later on the project's clock (400 on `validFrom`); the subscription may not already be paused over part of it (409). Generation's planned routes in the pause stop at its containers no more once a run has read them again: a run of each scheme whose planned routes do is asked in the same transaction — where the caller may ask one (`edit` on `route-studio.schemes`), of a validated scheme, absorbed by one already queued, and never a refusal: where no worker has made the queue yet, the next run drops them. The stops no run will take away — on a dispatched or running route, or the office's own — are answered in `stopsToRemove`, for the office to remove by hand. Answers the pause with its `Location`. Under the agreement's lock and then the subscription's.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The pause as it was written, and the stops left to remove by hand; `Location` is the pause's own read.", SubscriptionPaused),
          400: describeProblem("The path does not hold an id, or the body names a member it does not own, ends on or before the day it starts, falls outside the subscription's period, or begins before today."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `customers.agreements`."),
          404: describeProblem("No subscription with that id in the projects this account works in."),
          409: describeProblem("The subscription is already paused over part of that period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", SubscriptionPauseCreate),
      async (c) => {
        const { id } = c.req.valid("param")
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const found = await findSubscription(tx, principal, id)
        if (found === undefined) throw noSuchSubscription(id)
        const parent = await lockedSubscription(tx, principal, found)
        const within = { companyId: principal.companyId, projectId: parent.projectId }

        const period = periodOf(values)
        requireWithin(parent, period, OUTSIDE_SUBSCRIPTION)
        const today = await projectToday(tx, within, now)()
        if (period.validFrom < today) throw invalidRequest("body", [{ path: "validFrom", message: BEGINS_TODAY_OR_LATER }])

        const [row] = await refuseOverlap({ [PAUSED_ALREADY]: PAUSED_ALREADY_SENTENCE }, () =>
          tx
            .insert(subscriptionPause)
            .values({ id: newId(), companyId: principal.companyId, projectId: parent.projectId, subscriptionId: parent.id, ...period })
            .returning(columns),
        )
        const containers = await containersOf(tx, principal.companyId, parent.id, windowOf(period))
        const { toRemove, runs } = await stopsLeft(tx, within, containers, windowOf(period))
        await askRuns(tx, principal, jobs, within, runs, now)
        const body: SubscriptionPaused = { pause: pauseOf(row), stopsToRemove: toRemove }
        return c.json(body, 201, { location: `/subscription-pauses/${row.id}` })
      },
    )
    .patch(
      "/subscription-pauses/:id",
      describeRoute({
        operationId: "patchSubscriptionPause",
        summary: "Move or resume a subscription pause",
        description:
          "Moves one pause; at least one field must be given. A pause that has ended is history and is refused (409). Its first day moves only while it has not begun (400 on `validFrom`), and to today or later; its end — the day collections resume, today's to resume now — to today or later (400 on `validTo`), or to null, a pause until it is resumed. The period stays inside the subscription's (400 naming the bound) and off its other pauses (409). Days newly paused lose their planned stops and days given back get theirs again, through the runs `POST /subscriptions/{id}/pauses` asks — best effort, and never a refusal — and the stops no run will take away are answered in `stopsToRemove`. Under the agreement's lock and then the subscription's.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The pause as it now stands, and the stops left to remove by hand.", SubscriptionPaused),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a member it does not own, ends on or before the day it starts, falls outside the subscription's period, moves the first day of a pause that has begun, or puts a bound before today."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `customers.agreements`."),
          404: describeProblem("No pause with that id in the projects this account works in."),
          409: describeProblem("The pause has ended, or the subscription is already paused over part of the new period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", SubscriptionPausePatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const found = await findPause(tx, principal, id)
        if (found === undefined) throw noSuchPause(id)
        const owner = await findSubscription(tx, principal, found.subscriptionId)
        if (owner === undefined) throw noSuchPause(id)
        const parent = await lockedSubscription(tx, principal, owner)
        const current = await findPause(tx, principal, id)
        if (current === undefined) throw noSuchPause(id)
        const within = { companyId: principal.companyId, projectId: parent.projectId }
        const today = await projectToday(tx, within, now)()

        // The row's state first, then the body's fields (problem.ts).
        if (current.validTo !== null && current.validTo <= today) throw problem(409, { detail: pauseEnded(current.validTo) })
        const next = periodAfter(current, patch)
        requireWithin(parent, next, OUTSIDE_SUBSCRIPTION)
        if (patch.validFrom !== undefined && patch.validFrom !== current.validFrom) {
          if (current.validFrom <= today) throw invalidRequest("body", [{ path: "validFrom", message: KEEPS_ITS_FIRST_DAY }])
          if (patch.validFrom < today) throw invalidRequest("body", [{ path: "validFrom", message: BEGINS_TODAY_OR_LATER }])
        }
        if (patch.validTo != null && patch.validTo < today) throw invalidRequest("body", [{ path: "validTo", message: ENDS_TODAY_OR_LATER }])

        const [row] = await refuseOverlap({ [PAUSED_ALREADY]: PAUSED_ALREADY_SENTENCE }, () =>
          tx.update(subscriptionPause).set(patch).where(and(scope(principal), eq(subscriptionPause.id, id))).returning(columns),
        )
        if (row === undefined) throw noSuchPause(id)
        // The days it covers now lose their stops; any it covered and no longer does get theirs back.
        const before = windowOf(current)
        const after = windowOf(next)
        const span: Window = { from: before.from < after.from ? before.from : after.from, to: before.to === null || after.to === null ? null : before.to > after.to ? before.to : after.to }
        const containers = await containersOf(tx, principal.companyId, parent.id, span)
        const { toRemove, runs } = await stopsLeft(tx, within, containers, after)
        const givenBack = after.from > before.from || (after.to !== null && (before.to === null || after.to < before.to))
        await askRuns(tx, principal, jobs, within, givenBack ? mergedRuns(runs, await runsBringingBack(tx, within, containers, before)) : runs, now)
        const body: SubscriptionPaused = { pause: pauseOf(row), stopsToRemove: toRemove }
        return c.json(body)
      },
    )
    .post(
      "/subscription-pauses/:id/cancel",
      describeRoute({
        operationId: "cancelSubscriptionPause",
        summary: "Cancel a pause that has not begun",
        description:
          "Removes one pause that has not begun on the project's clock; one that has is ended instead, through its patch (409). Its days are given back to the subscription's containers, whose stops come back through the runs `POST /subscriptions/{id}/pauses` asks — best effort, and never a refusal. The audit log keeps that it was. Answers the pause as it stood. Takes no body. Under the agreement's lock and then the subscription's.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The pause as it stood, now removed.", SubscriptionPause),
          400: describeProblem("The path does not hold an id, or the request has a body."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `customers.agreements`."),
          404: describeProblem("No pause with that id in the projects this account works in."),
          409: describeProblem("The pause has begun: give it an end instead."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", SubscriptionPauseCancel),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const found = await findPause(tx, principal, id)
        if (found === undefined) throw noSuchPause(id)
        const owner = await findSubscription(tx, principal, found.subscriptionId)
        if (owner === undefined) throw noSuchPause(id)
        const parent = await lockedSubscription(tx, principal, owner)
        const current = await findPause(tx, principal, id)
        if (current === undefined) throw noSuchPause(id)
        const within = { companyId: principal.companyId, projectId: parent.projectId }
        const today = await projectToday(tx, within, now)()
        if (current.validFrom <= today) throw problem(409, { detail: pauseBegun(current.validFrom) })

        await tx.delete(subscriptionPause).where(and(scope(principal), eq(subscriptionPause.id, id)))
        const period = windowOf(current)
        const containers = await containersOf(tx, principal.companyId, parent.id, period)
        await askRuns(tx, principal, jobs, within, await runsBringingBack(tx, within, containers, period), now)
        return c.json(pauseOf(current))
      },
    )
}
