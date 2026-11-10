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
// @waste/db/commands/alert-links's `linkAlert`, the function `POST /tickets` runs too.
// A raised alert writes `alert-raised` to the outbox (O16 of #290), the
// `Alert` as answered, for the staff notices' consumer to tell the people who
// asked to hear of one that severe; the three commands write nothing, since a
// staff notice is about an alert raised and Resolution publishes its
// tickets' news and no other alert's (#109 §5).
//
// Every statement carries the tenant and `inProjects` (auth/projects.ts); the
// grant is `operate.exceptions` throughout, `view` to read, `create` to raise,
// `edit` for the three commands. A Service Provider's account works in no
// project and reaches nothing here (#109 §5).
import { Alert, AlertAcknowledge, AlertCreate, AlertLinkTicket, AlertListQuery, AlertResolve } from "@waste/contracts/alerts"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { raiseAlerts } from "@waste/db/commands/alerts"
import { alert } from "@waste/db/schema/resolution"
import { alertLinkRefusal, alertTransition, type AlertCommand } from "@waste/domain/resolution/transitions"
import type { AlertStatus } from "@waste/domain/resolution/vocabulary"
import { and, eq } from "drizzle-orm"
import { newId } from "@waste/db/ids"
import { linkAlert } from "@waste/db/commands/alert-links"
import { alertColumns, alertOf, type AlertRow } from "@waste/db/shapes/alerts"

import type { Principal } from "../auth/principal"
import { requireProject } from "../auth/projects"
import type { RouteDeps } from "../deps"
import { created, describeCreated, describeJson, IdParam, routes } from "../operation"
import { pageAt } from "../pagination"
import { describeProblem, problem } from "../problem"
import { requireContainer, requireDriver, requireRoute, requireTicket, requireVehicle, type Scope } from "./references"
import { alertScope, getAlert, listAlerts, lockedAlert, noSuchAlert } from "./resolution-shapes"
import { requireNotAhead } from "./shared"

const MODULE = "operate.exceptions"

const AlertPage = Page(Alert)

/** What the machine says of a command on this alert: the next status, undefined when the command is already done, or the 409 thrown. */
function judged(current: AlertRow, command: AlertCommand): AlertStatus | undefined {
  const transition = alertTransition(current.status, command)
  if (transition.kind === "refuse") throw problem(409, { detail: transition.sentence })
  return transition.kind === "stay" ? undefined : transition.to
}

async function moved(tx: Tx, principal: Principal, id: string, values: Partial<typeof alert.$inferInsert>): Promise<AlertRow> {
  const [row] = await tx
    .update(alert)
    .set(values)
    .where(and(alertScope(principal), eq(alert.id, id)))
    .returning(alertColumns)
  if (row === undefined) throw noSuchAlert(id)
  return row
}

const commandProblems = {
  404: describeProblem("No alert with that id in the projects this account works in."),
}

export function alertRoutes(deps: RouteDeps) {
  const { now } = deps
  return routes(deps)
    .get(
      "/alerts",
      {
        operationId: "listAlerts",
        summary: "The alerts of the caller's projects",
        description:
          "One page of alerts, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `status`, `severity` and `kind` narrow the board, and `rule` to what one of the worker's rules raised (O4 of #290); `routeId`, `vehicleId`, `driverId` and `containerId` answer what was raised about one route, vehicle, driver or container; `ticketId` answers the alerts a ticket answers, and `outboundLoadId` the alerts the disposal-site reconciliation raised about one outbound load (M17 of #293). Whether an alert is linked to a ticket is `ticketId` not null and no status. Hand `nextCursor` back as `cursor` for the next page.",
        module: MODULE,
        action: "view",
        query: AlertListQuery,
        invalid: ["a filter is malformed", "`projectId` is not a project this account works in"],
        responses: {
          200: describeJson("One page of alerts.", AlertPage),
        },
      },
      async (c) => {
        const { limit, cursor, projectId, status, rule, severity, kind, routeId, vehicleId, driverId, containerId, ticketId, outboundLoadId } = c.req.valid("query")
        const at = pageAt({ cursor, limit })
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const { items, nextCursor } = await listAlerts(
          tx,
          principal,
          at,
          projectId === undefined ? undefined : eq(alert.projectId, projectId),
          status === undefined ? undefined : eq(alert.status, status),
          rule === undefined ? undefined : eq(alert.rule, rule),
          severity === undefined ? undefined : eq(alert.severity, severity),
          kind === undefined ? undefined : eq(alert.kind, kind),
          routeId === undefined ? undefined : eq(alert.routeId, routeId),
          vehicleId === undefined ? undefined : eq(alert.vehicleId, vehicleId),
          driverId === undefined ? undefined : eq(alert.driverId, driverId),
          containerId === undefined ? undefined : eq(alert.containerId, containerId),
          ticketId === undefined ? undefined : eq(alert.ticketId, ticketId),
          outboundLoadId === undefined ? undefined : eq(alert.outboundLoadId, outboundLoadId),
        )
        return c.json({ items: items.map(alertOf), nextCursor })
      },
    )
    .post(
      "/alerts",
      {
        operationId: "raiseAlert",
        summary: "Raise an alert by hand",
        description:
          "Raises an alert about something of one project the caller works in: `source` is `manual`, `status` is `new`, `raisedBy` is the caller's account, and `detectedAt` is the body's or the request's clock when absent. An alert names what it is about — at least one of `routeId`, `vehicleId`, `driverId` and `containerId` (400 at `routeId` otherwise: an alert about nothing is nothing) — and each one named is held to that project (400 at its field): the route one of its routes, the vehicle one of its vehicles of any kind, a trailer included, the driver one of its drivers, the container one of its containers; `ticketId`, where given, is a ticket of that project and links the alert to it from the start. There is no status gate on any of them: a defect on a retired container and a route that has ended are what an alert is about. `detectedAt` may run at most five minutes ahead of the request's clock (400, `Recorded after it happened`) and has no lower bound, since the office records a condition seen yesterday; the clock is judged before the links, since it costs no statement. The raise writes `alert-raised` to the outbox with the alert as answered, from which the worker e-mails the staff who asked to hear of an alert that severe (O16 of #290). The server mints the id.",
        module: MODULE,
        action: "create",
        body: AlertCreate,
        invalid: ["the body is missing a field, names a member the server owns (`source`, `status`, `raisedBy`, the stamps), names a project this account does not work in, names none of the four subjects, sets `detectedAt` more than five minutes ahead of the clock, or names a route, vehicle, driver, container or ticket that is not that project's — each at the field that is wrong"],
        responses: {
          201: describeCreated("The alert as it was written.", Alert),
        },
      },
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
        const [row] = await raiseAlerts(tx, principal.companyId, [
          {
            id: newId(),
            projectId: values.projectId,
            kind: values.kind,
            severity: values.severity,
            source: "manual",
            title: values.title,
            details: values.details,
            detectedAt,
            routeId: values.routeId ?? null,
            vehicleId: values.vehicleId ?? null,
            driverId: values.driverId ?? null,
            containerId: values.containerId ?? null,
            ticketId: values.ticketId ?? null,
            raisedBy: principal.user.id,
          },
        ])
        const answered = alertOf(row)
        return created(c, "/alerts", answered)
      },
    )
    .get(
      "/alerts/:id",
      {
        operationId: "getAlert",
        summary: "One alert",
        description:
          "One alert of a project the caller works in, as it now stands: its subject, its status with the acknowledgement and resolution stamps the status carries, and the ticket it is linked to or null. An alert of another company, or of a project this account does not work in, is an alert that does not exist here.",
        module: MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The alert.", Alert),
          ...commandProblems,
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await getAlert(c.get("tx"), c.get("principal"), id)
        return c.json(alertOf(row))
      },
    )
    .post(
      "/alerts/:id/acknowledge",
      {
        operationId: "acknowledgeAlert",
        summary: "Acknowledge an alert",
        description:
          "The `acknowledge` command: `new` becomes `acknowledged`, stamped with the caller's account and the request's clock. The body is empty; a member in it is refused. An alert already acknowledged answers 200 as it stands, without a write; a resolved one is refused (409, `This alert is resolved and does not change`). Runs under the alert's row lock, so two commands on one alert take turns.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: AlertAcknowledge,
        invalid: ["the body carries a member"],
        responses: {
          200: describeJson("The alert, acknowledged.", Alert),
          ...commandProblems,
          409: describeProblem("The alert is resolved; a resolved alert does not change."),
        },
      },
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
      {
        operationId: "resolveAlert",
        summary: "Resolve an alert",
        description:
          "The `resolve` command: `new` or `acknowledged` becomes `resolved`, stamped with the caller's account, the request's clock and the body's note where it has one. An alert is resolved without being acknowledged first — a resolved alert may never have been acknowledged, and the acknowledgement stamps then stay null. An alert already resolved answers 200 as it stands, without a write and with the note it already carries: the body's note is not taken. Runs under the alert's row lock.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: AlertResolve,
        invalid: ["the body carries a member the command does not take or a note that is blank"],
        responses: {
          200: describeJson("The alert, resolved.", Alert),
          ...commandProblems,
        },
      },
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
      {
        operationId: "linkAlertTicket",
        summary: "Link an alert to a ticket",
        description:
          "Sets the one ticket the alert is linked to. The alert's own state is judged first, whatever the body names: a resolved alert is refused (409, `This alert is resolved and does not change`). Then `ticketId` is held to a ticket of the alert's project (400 at `ticketId` otherwise). Then the link: an alert links to one ticket — the same ticket again answers 200 as it stands, without a write, and another is refused (409, `This alert is linked to ticket T-8831; an alert links to one ticket`, naming the ticket it already names). The status does not move: `linked to ticket` is `ticketId` not null and no status. The same rule `POST /tickets` runs when a ticket is opened from an alert. Runs under the alert's row lock.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: AlertLinkTicket,
        invalid: ["the body has no `ticketId`, carries a member the command does not take, or names a ticket that is not the alert's project's"],
        responses: {
          200: describeJson("The alert, linked.", Alert),
          ...commandProblems,
          409: describeProblem("The alert is resolved, or is already linked to another ticket; the detail says which."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const { ticketId } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedAlert(tx, principal, id)
        // The alert's own state first — the machine's sentence, as `acknowledge` answers it through `judged` — then the body's 400, then the link's own 409 under the same lock: the order every command here and in routes/tickets.ts keeps.
        const refused = alertLinkRefusal(current.status)
        if (refused !== undefined) throw problem(409, { detail: refused })
        const scope: Scope = { companyId: principal.companyId, projectId: current.projectId }
        await requireTicket(tx, scope, ticketId)
        return c.json(alertOf(await linkAlert(tx, scope, current.id, ticketId)))
      },
    )
}
