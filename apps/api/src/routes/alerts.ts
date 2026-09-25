// The Alert as the office raises, acknowledges, resolves and links it (Issue
// #109; ADR-0005): "a condition that requires attention,
// notification, or acknowledgement and may create or link to a ticket"
// (CONTEXT.md). `GET /alerts` lists them, `POST /alerts` raises one by hand —
// the one source this issue writes, `source = manual` — `GET /alerts/:id`
// reads one, and three commands move it: `acknowledge`, `resolve` and
// `link-ticket`. No patch and no delete: an alert is raised, acknowledged,
// resolved and linked, and nothing else changes it; a resolved one keeps its
// row. An alert owns no resolution work — that is a Ticket's — so there is no
// history here and no number: current state, named by its title (#109 §7.18).
//
// The stamps follow the status. `acknowledged_at`/`_by` and `resolved_at`/`_by`
// are columns the table's `alert_stamps_shape` holds to the status, the
// `route` stamps precedent, so every command runs the domain's
// `alertTransition` (@waste/domain/resolution/transitions) under the alert's
// row lock and does one of three things: writes the next status with its
// stamp (`move`), answers 200 without a write for a command already done
// (`stay` — acknowledging an acknowledged alert, resolving a resolved one, the
// `confirm` precedent of #101), or answers the sentence as its 409 (`refuse`:
// "This alert is resolved and does not change", which the link command reads
// too). A resolved alert may never have been acknowledged: `resolve` on a
// `new` alert leaves the acknowledgement stamps null, and the shape allows it.
//
// Every command keeps the one order routes/tickets.ts keeps: the alert's own
// state first, as the machine judges it — a resolved alert refuses every
// command whatever the body says — then the body's 400s in body order, then
// the 409s that need the body (the link's "linked to another ticket"). So
// `link-ticket` answers a resolved alert before it holds the body's ticket
// to the project.
//
// An alert is about something — a route, a vehicle, a driver or a container
// of its project — or it is nothing: the contracts hold the subject rule at
// `routeId`, and every link a body names is held here to the project (400 at
// its field, routes/references.ts), a vehicle with no kind demanded, since a
// trailer left in the road is a condition too. There is no status gate on any
// of them (#109 §3): a defect on a retired container and a route that has
// ended are exactly what an alert is about. `detectedAt` may run ahead of the
// request's clock by `OCCURRED_AT_SKEW_MS` and no further, in the domain's
// words, and has no lower bound, since the office records a condition seen
// yesterday. The link to a ticket is the one column `ticket_id`, set on the
// create by naming a ticket of the project and afterwards through
// routes/alert-links.ts's `linkAlert`, the function `POST /tickets` runs too.
// Nothing here writes the outbox: Resolution publishes its tickets' news and
// no alert's (#109 §5).
//
// Every statement carries the tenant and `inProjects` (auth/projects.ts); the
// grant is `operate.exceptions` throughout, `view` to read, `create` to raise,
// `edit` for the three commands. A Service Provider's account works in no
// project and reaches nothing here (#109 §5).
import { Alert, AlertAcknowledge, AlertCreate, AlertLinkTicket, AlertListQuery, AlertResolve } from "@waste/contracts/alerts"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { alert } from "@waste/db/schema/resolution"
import { ALERT_DOES_NOT_CHANGE, alertTransition, type AlertCommand } from "@waste/domain/resolution/transitions"
import type { AlertStatus } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { linkAlert } from "./alert-links"
import { requireContainer, requireDriver, requireRoute, requireTicket, requireVehicle, type Scope } from "./references"
import { alertColumns, alertOf, alertScope, noSuchAlert, type AlertRow } from "./resolution-shapes"
import type { ClockOptions } from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, lockRow, requireNotAhead } from "./shared"

/** The grant every route here runs under: the exceptions board's. */
const MODULE = "operate.exceptions"

const AlertPage = Page(Alert)

/** One alert of this company by id, inside the caller's projects; undefined when it is neither. */
async function findAlert(tx: Tx, principal: Principal, id: string): Promise<AlertRow | undefined> {
  const [row] = await tx
    .select(alertColumns)
    .from(alert)
    .where(and(alertScope(principal), eq(alert.id, id)))
    .limit(1)
  return row
}

/**
 * The alert the path names, locked and read: every command holds a rule the
 * API rather than the database holds — the machine, the one link — so it
 * takes the row lock first and reads afterwards (routes/shared.ts), and two
 * commands on one alert take turns.
 */
async function lockedAlert(tx: Tx, principal: Principal, id: string): Promise<AlertRow> {
  await lockRow(tx, alert, { companyId: principal.companyId, id })
  const current = await findAlert(tx, principal, id)
  if (current === undefined) throw noSuchAlert(id)
  return current
}

/** What the machine says of a command on this alert: the next status, undefined when the command is already done, or the 409 thrown. */
function judged(current: AlertRow, command: AlertCommand): AlertStatus | undefined {
  const transition = alertTransition(current.status as AlertStatus, command)
  if (transition.kind === "refuse") throw problem(409, { detail: transition.sentence })
  return transition.kind === "stay" ? undefined : transition.to
}

/** Moves the row — the status and the stamps a command sets — and answers it as written. */
async function moved(tx: Tx, principal: Principal, id: string, values: Partial<typeof alert.$inferInsert>): Promise<AlertRow> {
  const [row] = await tx
    .update(alert)
    .set(values)
    .where(and(alertScope(principal), eq(alert.id, id)))
    .returning(alertColumns)
  if (row === undefined) throw noSuchAlert(id)
  return row
}

const commandProblems = (action: "view" | "edit") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
  404: describeProblem("No alert with that id in the projects this account works in."),
})

export function alertRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/alerts",
      describeRoute({
        operationId: "listAlerts",
        summary: "The alerts of the caller's projects",
        description:
          "One page of alerts, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `status`, `severity` and `kind` narrow the board; `routeId`, `vehicleId`, `driverId` and `containerId` answer what was raised about one route, vehicle, driver or container; `ticketId` answers the alerts a ticket answers. Whether an alert is linked to a ticket is `ticketId` not null and no status. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of alerts.", AlertPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", AlertListQuery),
      async (c) => {
        const { limit, cursor, projectId, status, severity, kind, routeId, vehicleId, driverId, containerId, ticketId } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(alertColumns)
          .from(alert)
          .where(
            and(
              alertScope(principal),
              projectId === undefined ? undefined : eq(alert.projectId, projectId),
              status === undefined ? undefined : eq(alert.status, status),
              severity === undefined ? undefined : eq(alert.severity, severity),
              kind === undefined ? undefined : eq(alert.kind, kind),
              routeId === undefined ? undefined : eq(alert.routeId, routeId),
              vehicleId === undefined ? undefined : eq(alert.vehicleId, vehicleId),
              driverId === undefined ? undefined : eq(alert.driverId, driverId),
              containerId === undefined ? undefined : eq(alert.containerId, containerId),
              ticketId === undefined ? undefined : eq(alert.ticketId, ticketId),
              after === undefined ? undefined : gt(alert.id, after),
            ),
          )
          .orderBy(asc(alert.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(alertOf), nextCursor })
      },
    )
    .post(
      "/alerts",
      describeRoute({
        operationId: "raiseAlert",
        summary: "Raise an alert by hand",
        description:
          "Raises an alert about something of one project the caller works in: `source` is `manual`, `status` is `new`, `raisedBy` is the caller's account, and `detectedAt` is the body's or the request's clock when absent. An alert names what it is about — at least one of `routeId`, `vehicleId`, `driverId` and `containerId` (400 at `routeId` otherwise: an alert about nothing is nothing) — and each one named is held to that project (400 at its field): the route one of its routes, the vehicle one of its vehicles of any kind, a trailer included, the driver one of its drivers, the container one of its containers; `ticketId`, where given, is a ticket of that project and links the alert to it from the start. There is no status gate on any of them: a defect on a retired container and a route that has ended are what an alert is about. `detectedAt` may run at most five minutes ahead of the request's clock (400, `Recorded after it happened`) and has no lower bound, since the office records a condition seen yesterday; the clock is judged before the links, since it costs no statement. Nothing here writes the outbox: an alert is news to the board and to no other context. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The alert as it was written.", Alert),
          400: describeProblem(
            "The body is missing a field, names a member the server owns (`source`, `status`, `raisedBy`, the stamps), names a project this account does not work in, names none of the four subjects, sets `detectedAt` more than five minutes ahead of the clock, or names a route, vehicle, driver, container or ticket that is not that project's — each at the field that is wrong.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`create\` on \`${MODULE}\`.`),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", AlertCreate),
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        const scope: Scope = { companyId: principal.companyId, projectId: values.projectId }
        // The clock first, since it costs no statement: the body's instant may run ahead of the request's by the skew and no further, and behind it as far as it likes.
        const at = now()
        const detectedAt = values.detectedAt === undefined ? at : new Date(values.detectedAt)
        requireNotAhead(detectedAt, at, "detectedAt")
        // Then the links, in body order, each held to the project and none to its status.
        await requireRoute(tx, scope, values.routeId)
        await requireVehicle(tx, scope, values.vehicleId)
        await requireDriver(tx, scope, values.driverId)
        await requireContainer(tx, scope, values.containerId)
        await requireTicket(tx, scope, values.ticketId)
        const [row] = await tx
          .insert(alert)
          .values({
            id: newId(),
            companyId: principal.companyId,
            projectId: values.projectId,
            kind: values.kind,
            severity: values.severity,
            source: "manual",
            status: "new",
            title: values.title,
            details: values.details,
            detectedAt,
            routeId: values.routeId ?? null,
            vehicleId: values.vehicleId ?? null,
            driverId: values.driverId ?? null,
            containerId: values.containerId ?? null,
            ticketId: values.ticketId ?? null,
            raisedBy: principal.user.id,
          })
          .returning(alertColumns)
        return created(c, "/alerts", alertOf(row))
      },
    )
    .get(
      "/alerts/:id",
      describeRoute({
        operationId: "getAlert",
        summary: "One alert",
        description:
          "One alert of a project the caller works in, as it now stands: its subject, its status with the acknowledgement and resolution stamps the status carries, and the ticket it is linked to or null. An alert of another company, or of a project this account does not work in, is an alert that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The alert.", Alert),
          400: describeProblem("The path does not hold an id."),
          ...commandProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findAlert(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchAlert(id)
        return c.json(alertOf(row))
      },
    )
    .post(
      "/alerts/:id/acknowledge",
      describeRoute({
        operationId: "acknowledgeAlert",
        summary: "Acknowledge an alert",
        description:
          "The `acknowledge` command: `new` becomes `acknowledged`, stamped with the caller's account and the request's clock. The body is empty; a member in it is refused. An alert already acknowledged answers 200 as it stands, without a write; a resolved one is refused (409, `This alert is resolved and does not change`). Runs under the alert's row lock, so two commands on one alert take turns.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The alert, acknowledged.", Alert),
          400: describeProblem("The path does not hold an id, or the body carries a member."),
          ...commandProblems("edit"),
          409: describeProblem("The alert is resolved; a resolved alert does not change."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", AlertAcknowledge),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedAlert(tx, principal, id)
        const to = judged(current, "acknowledge")
        if (to === undefined) return c.json(alertOf(current))
        return c.json(alertOf(await moved(tx, principal, id, { status: to, acknowledgedAt: now(), acknowledgedBy: principal.user.id })))
      },
    )
    .post(
      "/alerts/:id/resolve",
      describeRoute({
        operationId: "resolveAlert",
        summary: "Resolve an alert",
        description:
          "The `resolve` command: `new` or `acknowledged` becomes `resolved`, stamped with the caller's account, the request's clock and the body's note where it has one. An alert is resolved without being acknowledged first — a resolved alert may never have been acknowledged, and the acknowledgement stamps then stay null. An alert already resolved answers 200 as it stands, without a write and with the note it already carries: the body's note is not taken. Runs under the alert's row lock.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The alert, resolved.", Alert),
          400: describeProblem("The path does not hold an id, or the body carries a member the command does not take or a note that is blank."),
          ...commandProblems("edit"),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", AlertResolve),
      async (c) => {
        const { id } = c.req.valid("param")
        const { note } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedAlert(tx, principal, id)
        const to = judged(current, "resolve")
        if (to === undefined) return c.json(alertOf(current))
        return c.json(alertOf(await moved(tx, principal, id, { status: to, resolvedAt: now(), resolvedBy: principal.user.id, resolutionNote: note ?? null })))
      },
    )
    .post(
      "/alerts/:id/link-ticket",
      describeRoute({
        operationId: "linkAlertTicket",
        summary: "Link an alert to a ticket",
        description:
          "Sets the one ticket the alert is linked to. The alert's own state is judged first, whatever the body names: a resolved alert is refused (409, `This alert is resolved and does not change`). Then `ticketId` is held to a ticket of the alert's project (400 at `ticketId` otherwise). Then the link: an alert links to one ticket — the same ticket again answers 200 as it stands, without a write, and another is refused (409, `This alert is linked to ticket T-8831; an alert links to one ticket`, naming the ticket it already names). The status does not move: `linked to ticket` is `ticketId` not null and no status. The same rule `POST /tickets` runs when a ticket is opened from an alert. Runs under the alert's row lock.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The alert, linked.", Alert),
          400: describeProblem("The path does not hold an id, or the body has no `ticketId`, carries a member the command does not take, or names a ticket that is not the alert's project's."),
          ...commandProblems("edit"),
          409: describeProblem("The alert is resolved, or is already linked to another ticket; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", AlertLinkTicket),
      async (c) => {
        const { id } = c.req.valid("param")
        const { ticketId } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedAlert(tx, principal, id)
        // The alert's own state first — the machine's sentence, as `acknowledge` answers it through `judged` — then the body's 400, then the link's own 409 under the same lock: the order every command here and in routes/tickets.ts keeps.
        if (current.status === "resolved") throw problem(409, { detail: ALERT_DOES_NOT_CHANGE })
        const scope: Scope = { companyId: principal.companyId, projectId: current.projectId }
        await requireTicket(tx, scope, ticketId)
        return c.json(alertOf(await linkAlert(tx, scope, current.id, ticketId)))
      },
    )
}
