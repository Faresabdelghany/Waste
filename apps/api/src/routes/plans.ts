// The Plan endpoints (#170, decided on #124 and #132): `GET /routes/:id/plans`
// lists a route's Plans, `GET /plans/:id` answers one with its legs — fetched
// only when a map draws — and `POST /routes/:id/optimise` asks for one: fifty
// stops or fewer go to the optimiser, more become a `baseline` measurement
// read "Not optimised" (#124 §4), both through `ensurePlan`
// (routes/plan-shapes.ts): the fingerprint's cache first, a `ready` match
// re-activated without a call, then the Plan written `calculating` and its
// job sent in the request's transaction under the fingerprint singleton. The
// request is accepted while the quota is exhausted — the answer is the
// `calculating` Plan, `deferredUntil` beside it once #171's engine defers —
// and a Route without a Plan stays complete: nothing routing gates dispatch
// (#132). The grant is `route-studio.routes`, `view` to read and `edit` to
// ask, the module the decisions name for Plans and legs (#124 §5).
import { Page, PageRequest } from "@waste/contracts/pagination"
import { Plan, PlanDetail } from "@waste/contracts/plans"
import { plan } from "@waste/db/schema/routing"
import { OPTIMISER_MAX_STOPS } from "@waste/domain/routing/plans"
import type { RoutingProvider } from "@waste/routing/provider"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { findRoute, labelOf, noSuchRoute, pickupsOfRoute } from "./execution-shapes"
import { ensurePlan, findPlan, legsOfPlan, noSuchPlan, planColumns, planOf, planScope } from "./plan-shapes"
import type { JobSender } from "@waste/db/jobs"
import { lockedRoute, ORDER_IS_FROZEN, requireNotStarted } from "./routes"
import { describeJson, IdParam } from "./shared"

const MODULE = "route-studio.routes"

const PlanPage = Page(Plan)

/** What asking for a Plan of a route with no open stops is told: there is nothing to order. */
export const nothingToOrder = (label: string): string => `Route ${label} has no open pickups to order`

export type PlanRouteOptions = {
  /** The routing provider: its name keys the fingerprint; no call is ever made on the request (#124 §4). */
  routing: RoutingProvider
  /** pg-boss's send for this process (#187): the Plan's job rides the request's transaction through it. */
  jobs: JobSender
}

export function planRoutes(guard: MiddlewareHandler<AuthEnv>, { routing, jobs }: PlanRouteOptions) {
  return new Hono<AuthEnv>()
    .get(
      "/routes/:id/plans",
      describeRoute({
        operationId: "listRoutePlans",
        summary: "The Plans of one route",
        description:
          "One page of the route's Plans, oldest first (ids are time-ordered) — every calculation ever asked for over this route, whoever ordered it: the optimiser, a dispatcher's reorder (`manual`), or the generated order measured (`baseline`). A re-optimisation is a new Plan and the previous rows stay, so this is the history; the route's own read says which one is active. Legs are `GET /plans/{id}`'s, fetched only when a map draws. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the route's Plans.", PlanPage),
          400: describeProblem("The path does not hold an id, the page size is outside 1..200, or the cursor is not one this API wrote."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
          404: describeProblem("No route with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", PageRequest),
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit, cursor } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if ((await findRoute(tx, principal, id)) === undefined) throw noSuchRoute(id)
        const rows = await tx
          .select(planColumns)
          .from(plan)
          .where(and(planScope(principal), eq(plan.routeId, id), after === undefined ? undefined : gt(plan.id, after)))
          .orderBy(asc(plan.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(planOf), limit))
      },
    )
    .get(
      "/plans/:id",
      describeRoute({
        operationId: "getPlan",
        summary: "One Plan with its legs",
        description:
          "One Plan of a project the caller works in, with its legs in driving order — each a stored LineString with its metres and seconds, written by the measurement and never patched (#124). A `calculating` or `failed` Plan has no legs yet, or ever. A Plan of another company, or of a project this account does not work in, is a Plan that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The Plan and its legs.", PlanDetail),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
          404: describeProblem("No plan with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findPlan(tx, principal, id)
        if (row === undefined) throw noSuchPlan(id)
        return c.json({ ...planOf(row), legs: await legsOfPlan(tx, principal.companyId, id) })
      },
    )
    .post(
      "/routes/:id/optimise",
      describeRoute({
        operationId: "optimiseRoute",
        summary: "Ask for a Plan over a route's open stops",
        description:
          "Asks the routing provider for an ordered, measured Plan over the route's open pickups: fifty or fewer go to the optimiser; more become a `baseline` measurement of the generated order, read \"Not optimised\" (#124 §4: one optimisation call takes at most fifty locations). Answers at once with the Plan — 202 `calculating` when this request created it and its job now waits for the worker, 200 when an identical request's Plan already stood: a `ready` one is re-activated and consumes no provider call, a `calculating` one is already on its way (two clicks are one job). Accepted while the routing quota is exhausted — the Plan answers `calculating` with `deferredUntil` once the quota engine (#171) defers it — and the route beneath is never gated: dispatch and execution go on over the generated order, drawn dashed. A route that has started is refused (409): the sequence is frozen (ADR-0002); a completed or cancelled one does not change. Takes no body. Under the route's row lock.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("An identical request's Plan already stood: re-activated if it was ready, or still calculating.", Plan),
          202: describeJson("The Plan this request created, calculating; its job waits for the worker.", Plan),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`edit\` on \`${MODULE}\`.`),
          404: describeProblem("No route with that id in the projects this account works in."),
          409: describeProblem("The route is active, completed or cancelled, or has no open pickups to order."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedRoute(tx, principal, id)
        // Re-optimisation is refused once a session has started, the same freeze the reorder holds (ADR-0002, #124 §2).
        requireNotStarted(current, ORDER_IS_FROZEN)
        const open = (await pickupsOfRoute(tx, principal.companyId, current.id)).filter((stop) => stop.status === "planned")
        if (open.length === 0) throw problem(409, { detail: nothingToOrder(labelOf(current)) })
        const { planId, created } = await ensurePlan(
          tx,
          principal,
          current,
          { solver: open.length <= OPTIMISER_MAX_STOPS ? "optimiser" : "baseline", orderedPickupIds: open.map((stop) => stop.id) },
          { routing, jobs },
        )
        const answered = await findPlan(tx, principal, planId)
        if (answered === undefined) throw noSuchPlan(planId)
        return c.json(planOf(answered), created ? 202 : 200)
      },
    )
}
