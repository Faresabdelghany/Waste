// The Unload as the weights desk reads and captures it (Issue #104, slice 3):
// `GET /unloads` lists the ledger across routes, `GET /unloads/:id` reads one
// row, and `POST /routes/:id/unloads` is the office's capture of a
// weighbridge ticket the device did not record — a forgotten one, a ticket
// that came by post. The row is a ledger's (`recorded`, `appendOnly`): it is
// never updated here, and weight control — approve, reject, correct,
// release for billing — is Finance's review over these rows (step 7), a
// wrong unload corrected there by a new row naming the old.
//
// The office's capture is `source = dispatch`, `recordedBy` the caller,
// `sessionId` null (a session is named by every driver-recorded row and by
// no office row, `unload_session_shape`), the id server-minted. It is made on
// a route that ran, `active` or `completed` (#104 §7.21: the office may
// capture on a completed route where the device may not after `end-route`) —
// a route that has not is refused (409), and a cancelled one does not change.
// The station is one of the company's — any station, since a full truck
// unloads where it can and the route's planned one is a default the device
// offers, not a rule — and the fraction one of the company's, each a 400 at
// its field; the weights hold the table's own sentence at the boundary
// (contracts/unloads.ts: net given, gross and tare together or not at all,
// and net gross less tare where both are); and `occurredAt` may run ahead of
// the request's clock by the ledger's skew (`OCCURRED_AT_SKEW_MS`,
// routes/shared.ts, the one constant the ledger, the driver door and this
// capture read) and no further, in the domain's words. The
// `unload-recorded` event is written in the same transaction, carrying the
// unload as answered.
//
// Every statement carries the tenant and `inProjects`; the grant is
// `route-studio.weights`, `view` to read and `create` to capture.
import { Page } from "@waste/contracts/pagination"
import { Unload, UnloadCreate, UnloadListQuery } from "@waste/contracts/unloads"
import { route, unload } from "@waste/db/schema/execution"
import { RECORDED_AFTER_IT_HAPPENED } from "@waste/domain/execution/commands"
import { doesNotChange, hasNotRun } from "@waste/domain/execution/transitions"
import { and, asc, eq, gt, gte, lte } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { projectIdsOf, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { emit } from "../outbox"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { findRoute, labelOf, noSuchRoute, noSuchUnload, unloadColumns, unloadOf, unloadScope, type RouteRow } from "./execution-shapes"
import { requireRoute, requireUnloadingStation, requireWasteFraction } from "./references"
import type { ClockOptions } from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, lockRow, OCCURRED_AT_SKEW_MS } from "./shared"

const MODULE = "route-studio.weights"

const UnloadPage = Page(Unload)

/** An unload is captured on a route that ran: `active` or `completed`; a route that has not is refused, and a cancelled one does not change. */
function requireRan(current: RouteRow): void {
  const label = labelOf(current)
  switch (current.status) {
    case "active":
    case "completed":
      return
    case "planned":
    case "ready":
      throw problem(409, { detail: hasNotRun(label) })
    case "cancelled":
      throw problem(409, { detail: doesNotChange(label, "cancelled") })
    default:
      throw new Error(`route ${current.id} carries a status the vocabulary does not know: ${current.status}`)
  }
}

export function unloadRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/unloads",
      describeRoute({
        operationId: "listUnloads",
        summary: "The unloads of the caller's projects",
        description:
          "One page of unloads, oldest first (ids are time-ordered, so a cursor over them is a cursor over recording order), from the projects the caller works in — an account that works in none reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `routeId` is one route's unloads, and must be a route of a project this account works in (400 on the query); `unloadingStationId` what was tipped at one station, `wasteFractionId` one fraction, and `from` and `to` the window over `occurredAt` (both inclusive, `to` on or after `from`). Weight control over these rows is Finance's, step 7. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of unloads.", UnloadPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, the window runs backwards, `projectId` is not a project this account works in, or `routeId` is not a route of one."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", UnloadListQuery),
      async (c) => {
        const { limit, cursor, projectId, routeId, unloadingStationId, wasteFractionId, from, to } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        if (routeId !== undefined) await requireRoute(tx, { companyId: principal.companyId, projectId: projectId ?? projectIdsOf(principal) }, routeId, "routeId", "query")
        const rows = await tx
          .select(unloadColumns)
          .from(unload)
          .where(
            and(
              unloadScope(principal),
              projectId === undefined ? undefined : eq(unload.projectId, projectId),
              routeId === undefined ? undefined : eq(unload.routeId, routeId),
              unloadingStationId === undefined ? undefined : eq(unload.unloadingStationId, unloadingStationId),
              wasteFractionId === undefined ? undefined : eq(unload.wasteFractionId, wasteFractionId),
              from === undefined ? undefined : gte(unload.occurredAt, new Date(from)),
              to === undefined ? undefined : lte(unload.occurredAt, new Date(to)),
              after === undefined ? undefined : gt(unload.id, after),
            ),
          )
          .orderBy(asc(unload.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(unloadOf), limit))
      },
    )
    .get(
      "/unloads/:id",
      describeRoute({
        operationId: "getUnload",
        summary: "One unload",
        description:
          "One unload of a project the caller works in: the route and session it was recorded on, the station and the fraction, the weights, the station's ticket and who recorded it. An unload of another company, or of a project this account does not work in, is an unload that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The unload.", Unload),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
          404: describeProblem("No unload with that id in the projects this account works in."),
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
          .select(unloadColumns)
          .from(unload)
          .where(and(unloadScope(principal), eq(unload.id, id)))
          .limit(1)
        if (row === undefined) throw noSuchUnload(id)
        return c.json(unloadOf(row))
      },
    )
    .post(
      "/routes/:id/unloads",
      describeRoute({
        operationId: "recordRouteUnload",
        summary: "Capture an unload the office holds the ticket for",
        description:
          "The office's capture of a weighbridge ticket on a route that ran (`active` or `completed`; a route that has not is refused, 409, and a cancelled one does not change): appends one Unload with `source` dispatch, the caller as its recorder, no session, and a server-minted id. The station is one of this company's — any station, since a full truck unloads where it can — and the fraction one of this company's (400 at the field). `netKg` is what was tipped, whole kilograms; `grossKg` and `tareKg` come together or not at all (400 at `tareKg`), and where both are given net is gross less tare (400 at `netKg`). `occurredAt` is when the truck tipped, on the caller's word, and at most five minutes ahead of the request's clock (400). The `unload-recorded` event is written in the same transaction, carrying the unload as answered.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The unload as it was appended.", Unload),
          400: describeProblem(
            "The path does not hold an id, or the body is missing a field, names a member the server owns, gives one of gross and tare without the other or a net that is not gross less tare, dates the unload more than five minutes after the request, or names a station or a fraction that is not this company's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`create\` on \`${MODULE}\`.`),
          404: describeProblem("No route with that id in the projects this account works in."),
          409: describeProblem("The route has not run, or is cancelled."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", UnloadCreate),
      async (c) => {
        const { id } = c.req.valid("param")
        const { unloadingStationId, wasteFractionId, netKg, grossKg, tareKg, weighbridgeTicket, occurredAt, note } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        // The route's lock, then the route: a cancellation and a capture on one route take turns, and the status is read under the lock.
        await lockRow(tx, route, { companyId: principal.companyId, id })
        const current = await findRoute(tx, principal, id)
        if (current === undefined) throw noSuchRoute(id)
        // The body's 400s before the state's 409, the order every route keeps.
        await requireUnloadingStation(tx, principal.companyId, unloadingStationId)
        await requireWasteFraction(tx, principal.companyId, wasteFractionId)
        const at = now()
        const tipped = new Date(occurredAt)
        if (tipped.getTime() > at.getTime() + OCCURRED_AT_SKEW_MS) throw invalidRequest("body", [{ path: "occurredAt", message: RECORDED_AFTER_IT_HAPPENED }])
        requireRan(current)
        const [row] = await tx
          .insert(unload)
          .values({
            id: newId(),
            companyId: principal.companyId,
            projectId: current.projectId,
            routeId: current.id,
            sessionId: null,
            unloadingStationId,
            wasteFractionId,
            source: "dispatch",
            occurredAt: tipped,
            recordedBy: principal.user.id,
            grossKg: grossKg ?? null,
            tareKg: tareKg ?? null,
            netKg,
            weighbridgeTicket: weighbridgeTicket ?? null,
            note: note ?? null,
          })
          .returning(unloadColumns)
        const answered = unloadOf(row)
        await emit(tx, principal, { aggregate: "unload", aggregateId: row.id, kind: "unload-recorded", payload: answered, projectId: row.projectId, occurredAt: tipped })
        return created(c, "/unloads", answered)
      },
    )
}
