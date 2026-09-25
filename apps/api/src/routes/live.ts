// The live dashboard's reads (Issue #104, slice 3): `GET /routes/live`, the
// routes running or due today, and the Session as the office reads it —
// `GET /sessions` and `GET /sessions/:id`. Nothing here writes: a session is
// minted by the device when it starts a route and moved by its commands, and
// the office watches.
//
// "Live" is two things. Every `active` route of the caller's projects, and
// every `ready` one whose operating date is today — today on the route's
// project's clock, `now at time zone project.timezone`, the reading
// routes/scheme-groups.ts's `groupsInForceNaming` makes, with the app's
// injected `now` as the instant so a test can pin it: 22:30Z on the 1st of
// December is still the 1st in Copenhagen and already the 2nd in Cairo, and
// a route due on the 2nd in each project is live in one and not the other.
// Each row carries what the dashboard shows beside the route: its progress,
// its open session or null, whether that session is paused, when the device
// was last seen, and the latest point a proof of the route carried — one
// `distinct on (route_id)` over the page's routes in recording order, so a
// page of fifty costs one statement and not fifty; no position stream exists
// yet (#104 §1), and a proof's point is what is cheap.
//
// Every statement carries the tenant and `inProjects`; the grant is
// `route-studio.live`, `view` throughout.
import type { FlatPoint } from "@waste/contracts/geojson"
import { Page } from "@waste/contracts/pagination"
import { LiveRoute, LiveRouteQuery } from "@waste/contracts/routes"
import { Session, SessionListQuery } from "@waste/contracts/sessions"
import type { Tx } from "@waste/db/client"
import { proofOfService, route, session } from "@waste/db/schema/execution"
import { project } from "@waste/db/schema/organisation"
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { projectIdsOf, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, validate } from "../problem"
import { noSuchSession, openSessionsByRoute, progressByRoute, progressFor, routeColumns, routeOf, routeScope, sessionColumns, sessionOf, sessionScope } from "./execution-shapes"
import { requireRoute } from "./references"
import type { ClockOptions } from "./scheme-groups"
import { describeJson, IdParam } from "./shared"

const MODULE = "route-studio.live"

const LivePage = Page(LiveRoute)
const SessionPage = Page(Session)

/** The latest point a proof of each route carried, by route, in one statement over the page's ids. */
async function lastLocationsByRoute(tx: Tx, companyId: string, routeIds: readonly string[]): Promise<Map<string, FlatPoint>> {
  if (routeIds.length === 0) return new Map()
  const rows = await tx
    .selectDistinctOn([proofOfService.routeId], { routeId: proofOfService.routeId, location: proofOfService.location })
    .from(proofOfService)
    .where(and(eq(proofOfService.companyId, companyId), inArray(proofOfService.routeId, [...routeIds]), isNotNull(proofOfService.location)))
    .orderBy(asc(proofOfService.routeId), desc(proofOfService.id))
  return new Map(rows.flatMap((row) => (row.location === null ? [] : [[row.routeId, row.location as FlatPoint] as const])))
}

export function liveRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/routes/live",
      describeRoute({
        operationId: "listLiveRoutes",
        summary: "The routes running or due today",
        description:
          "One page of the routes the live dashboard watches, oldest first (ids are time-ordered): every `active` route of the projects the caller works in, and every `ready` one whose operating date is today on its project's clock — the request's instant rendered in `project.timezone`, so a route due tomorrow in Copenhagen may already be due today in Cairo. `projectId` narrows it to one of those projects; naming another is refused. Each row is the route with its progress, its open `session` or null for a route due today that has not started, `paused` (whether that session is paused), `lastSeenAt` (when the device last uploaded) and `lastLocation` (the latest point a proof of the route carried, or null). Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of live routes.", LivePage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", LiveRouteQuery),
      async (c) => {
        const { limit, cursor, projectId } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        // Today on each route's project's clock: the request's instant at the project's timezone, as a day.
        const today = sql`(${now().toISOString()}::timestamptz at time zone ${project.timezone})::date`
        const rows = await tx
          .select(routeColumns)
          .from(route)
          .innerJoin(project, and(eq(project.companyId, route.companyId), eq(project.id, route.projectId)))
          .where(
            and(
              routeScope(principal),
              projectId === undefined ? undefined : eq(route.projectId, projectId),
              or(eq(route.status, "active"), and(eq(route.status, "ready"), eq(route.operatingDate, today))),
              after === undefined ? undefined : gt(route.id, after),
            ),
          )
          .orderBy(asc(route.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        const ids = items.map((row) => row.id)
        const [progress, sessions, locations] = await Promise.all([
          progressByRoute(tx, principal.companyId, ids),
          openSessionsByRoute(tx, principal.companyId, ids),
          lastLocationsByRoute(tx, principal.companyId, ids),
        ])
        const live: LiveRoute[] = items.map((row) => {
          const open = sessions.get(row.id)
          return {
            ...routeOf(row, progressFor(progress, row.id)),
            session: open === undefined ? null : sessionOf(open),
            lastLocation: locations.get(row.id) ?? null,
            lastSeenAt: open === undefined ? null : open.lastSeenAt.toISOString(),
            paused: open !== undefined && open.pausedAt !== null,
          }
        })
        return c.json({ items: live, nextCursor })
      },
    )
    .get(
      "/sessions",
      describeRoute({
        operationId: "listSessions",
        summary: "The driver sessions of the caller's projects",
        description:
          "One page of sessions, oldest first (ids are time-ordered, minted by the device when it started the route), from the projects the caller works in — an account that works in none reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `routeId` is one route's sessions, and must be a route of a project this account works in (400 on the query); `driverId` one driver's; `open=true` the sessions still running and `open=false` the ended ones, absent being both. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of sessions.", SessionPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `open` is not `true` or `false`, `projectId` is not a project this account works in, or `routeId` is not a route of one."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", SessionListQuery),
      async (c) => {
        const { limit, cursor, projectId, routeId, driverId, open } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        if (routeId !== undefined) await requireRoute(tx, { companyId: principal.companyId, projectId: projectId ?? projectIdsOf(principal) }, routeId, "routeId", "query")
        const rows = await tx
          .select(sessionColumns)
          .from(session)
          .where(
            and(
              sessionScope(principal),
              projectId === undefined ? undefined : eq(session.projectId, projectId),
              routeId === undefined ? undefined : eq(session.routeId, routeId),
              driverId === undefined ? undefined : eq(session.driverId, driverId),
              open === undefined ? undefined : open ? isNull(session.endedAt) : isNotNull(session.endedAt),
              after === undefined ? undefined : gt(session.id, after),
            ),
          )
          .orderBy(asc(session.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(sessionOf), limit))
      },
    )
    .get(
      "/sessions/:id",
      describeRoute({
        operationId: "getSession",
        summary: "One driver session",
        description:
          "One session of a project the caller works in, as it now stands: the route, the driver, the vehicle and trailer that went out, the device, when it started and ended, whether it is paused, and when the device was last seen. A session of another company, or of a project this account does not work in, is a session that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The session.", Session),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
          404: describeProblem("No session with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const [row] = await tx
          .select(sessionColumns)
          .from(session)
          .where(and(sessionScope(principal), eq(session.id, id)))
          .limit(1)
        if (row === undefined) throw noSuchSession(id)
        return c.json(sessionOf(row))
      },
    )
}
