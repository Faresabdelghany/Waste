// The Ticket as the office reads, opens and moves it (Issue #109, slice 3;
// ADR-0001, ADR-0004, ADR-0005): "a case that owns the resolution of a
// request, deviation, complaint, task, or operational issue" (CONTEXT.md).
// `GET /tickets` lists them — with `?customerId=`, the citizen portal's read
// model — `POST /tickets` opens one, `GET /tickets/:id` reads one with its
// history and the alerts naming it, `PATCH /tickets/:id` moves the case's own
// fields, seven commands move what the machine and the assignment own
// (`assign`, `start`, `wait`, `hold`, `complete`, `reject`, `reopen`),
// `GET /tickets/:id/events` pages the history and `POST /tickets/:id/comments`
// appends to it. No delete: a ticket is completed or rejected, and a history
// row never goes.
//
// Every write to the ticket's row is a command, and every command appends
// (#109 §3): each takes `lockRow(ticket)` before it reads — the machine is a
// rule the API holds, so two commands on one ticket take turns — reads the
// row under the caller's scope (the family's 404 when there is none), asks
// the domain's `ticketTransition` (@waste/domain/resolution/transitions) and
// answers its sentence as a 409 on `refuse` ("Ticket T-8831 is completed;
// reopen it first"), 200 without a write on `stay` (starting a ticket already
// in progress, reopening an open one, assigning the account already assigned
// — the `confirm` precedent, #101), and on `move` writes the row and appends
// the `ticket_event` through routes/ticket-writes.ts, the one place a write
// is followed by a history row. `PATCH` appends nothing — a field edit is the
// audit log's (ADR-0005) — and `updatedAt` moves. A comment is appended and
// touches the row not at all, on a closed ticket too: a note after the fact
// is a note.
//
// The ticket's own state is judged first, as the machine judges it: a closed
// ticket refuses every command but `reopen` and a comment whatever the body
// says. Then the body's 400s, in body order — every id a body names held in
// routes/references.ts's words, the pickup with its route, an assignee an
// account of the company working in the ticket's project, `occurredAt` at
// most five minutes ahead of the request's clock — and no status gate on a
// link (§7.13): a ticket is about whatever it is about. The one gate is the
// re-collection route's, since that reference asks the route to run: 409
// after the 400, the #79 shape. What Resolution publishes — `ticket-opened`,
// `ticket-completed`, `ticket-rejected` — goes into the outbox in the
// request's transaction with the `Ticket` as answered (outbox.ts); Finance
// is their consumer.
//
// Every statement carries the tenant and `inProjects`; the grant is
// `operate.tickets`, `view` to read, `create` to open a ticket and to
// comment, `edit` for the patch and the seven commands.
import { Page } from "@waste/contracts/pagination"
import {
  PICKUP_WITH_ITS_ROUTE,
  Ticket,
  TicketAssign,
  TicketComment,
  TicketComplete,
  TicketCreate,
  TicketDetail,
  TicketEvent,
  TicketEventListQuery,
  TicketHold,
  TicketListQuery,
  TicketPatch,
  TicketReject,
  TicketReopen,
  TicketStart,
  TicketWait,
  type TicketLinks,
  type TicketLinksSet,
} from "@waste/contracts/tickets"
import type { Tx } from "@waste/db/client"
import { propertyParty } from "@waste/db/schema/customers"
import { route } from "@waste/db/schema/execution"
import { ticket, ticketEvent } from "@waste/db/schema/resolution"
import { RECORDED_AFTER_IT_HAPPENED } from "@waste/domain/execution/commands"
import { closedTicket, ticketTransition, type TicketCommand } from "@waste/domain/resolution/transitions"
import { CLOSED_TICKET_STATUSES, isClosedTicketStatus, OPEN_TICKET_STATUSES, type TicketStatus } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq, exists, gt, gte, inArray, lt, or } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { emit } from "../outbox"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { labelOf as routeLabelOf } from "./execution-shapes"
import {
  NOT_A_ROUTE,
  requireAccountInProject,
  requireAgreement,
  requireAlert,
  requireContainer,
  requireCustomer,
  requireDriver,
  requirePickup,
  requireProperty,
  requireRoute,
  requireSharedCollectionPoint,
  requireTicket,
  type Scope,
} from "./references"
import { alertOf, alertsNamingTicket, eventColumns, eventOf, eventsOfTicket, findTicket, labelOf, linksOf, noSuchTicket, ticketColumns, ticketOf, ticketScope, type TicketRow } from "./resolution-shapes"
import type { ClockOptions } from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, lockRow, OCCURRED_AT_SKEW_MS } from "./shared"
import { appendTicketEvent, openTicket, type TicketEventDraft } from "./ticket-writes"

const MODULE = "operate.tickets"

const TicketPage = Page(Ticket)
const EventPage = Page(TicketEvent)

/** What a body naming the ticket as its own parent is told, at `links.parentTicketId`. */
export const NOT_ITS_OWN_PARENT = "A ticket is not its own parent"

/** What a completion naming a route that has ended is told: the #79 gate on the one reference a ticket makes that asks its row to run. */
export const routeHasEnded = (label: string, status: "completed" | "cancelled"): string => `Route ${label} is ${status}; a re-collection rides on a route that has not ended`

/** What a comment's attachment key naming the wrong ids is told, at `objectKey`. */
export const KEY_NAMES_ANOTHER = "The attachment key names another ticket or another comment"

/** The nine links a body may name, each null where the body cleared or never named it. */
const NO_LINKS: TicketLinks = { routeId: null, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null }

const LINK_KEYS = Object.keys(NO_LINKS) as (keyof TicketLinks)[]

/** The links a write leaves behind: the body's where given (null clearing), the stored ones where not. */
function linksAfter(current: TicketLinks, set: TicketLinksSet | undefined): TicketLinks {
  const after = { ...current }
  for (const key of LINK_KEYS) {
    const given = set?.[key]
    if (given !== undefined) after[key] = given
  }
  return after
}

/** Which links a body named, cleared or set: the ones held afresh. */
const namedIn = (set: TicketLinksSet | undefined): Set<keyof TicketLinks> => new Set(LINK_KEYS.filter((key) => set?.[key] !== undefined))

/**
 * Holds the links a write leaves behind, in body order and in
 * routes/references.ts's words: a route of the project, a pickup of that
 * route (`PICKUP_WITH_ITS_ROUTE` where the row would carry a pickup and no
 * route, the route's key being what carries the pickup), a container, a
 * property, a point, a driver, an agreement and a parent ticket of the
 * project, a customer of the company. Only what the body named is held —
 * a stored link the body did not move is no new reference — except the
 * pickup, held again when the body moved the route under it. No status is
 * asked of any (§7.13).
 */
async function requireLinks(tx: Tx, scope: Scope, after: TicketLinks, named: ReadonlySet<keyof TicketLinks>, self?: string): Promise<void> {
  const at = (key: keyof TicketLinks) => `links.${key}`
  if (after.pickupId !== null && after.routeId === null) throw invalidRequest("body", [{ path: at("pickupId"), message: PICKUP_WITH_ITS_ROUTE }])
  if (named.has("routeId")) await requireRoute(tx, scope, after.routeId, at("routeId"))
  if (after.pickupId !== null && after.routeId !== null && (named.has("pickupId") || named.has("routeId"))) {
    await requirePickup(tx, { companyId: scope.companyId, routeId: after.routeId }, after.pickupId, at("pickupId"))
  }
  if (named.has("containerId")) await requireContainer(tx, scope, after.containerId, at("containerId"))
  if (named.has("propertyId")) await requireProperty(tx, scope, after.propertyId, at("propertyId"))
  if (named.has("sharedCollectionPointId")) await requireSharedCollectionPoint(tx, scope, after.sharedCollectionPointId, at("sharedCollectionPointId"))
  if (named.has("customerId")) await requireCustomer(tx, scope.companyId, after.customerId, at("customerId"))
  if (named.has("agreementId")) await requireAgreement(tx, scope, after.agreementId, at("agreementId"))
  if (named.has("driverId")) await requireDriver(tx, scope, after.driverId, at("driverId"))
  if (named.has("parentTicketId")) {
    if (self !== undefined && after.parentTicketId === self) throw invalidRequest("body", [{ path: at("parentTicketId"), message: NOT_ITS_OWN_PARENT }])
    await requireTicket(tx, scope, after.parentTicketId, at("parentTicketId"))
  }
}

/** `occurredAt` may run ahead of the request's clock by the skew a device's clock accounts for and no further; it has no lower bound, since the office records a complaint made yesterday. */
function requireNotAhead(occurredAt: Date, at: Date, path = "occurredAt"): void {
  if (occurredAt.getTime() > at.getTime() + OCCURRED_AT_SKEW_MS) throw invalidRequest("body", [{ path, message: RECORDED_AFTER_IT_HAPPENED }])
}

/**
 * The route a re-collection rides on: one of the project's (400 at
 * `recollectionRouteId`) that has not ended — a completed or cancelled route
 * is a 409 naming it and its status, the #79 gate on a new reference, after
 * the 400. One statement for both, as `requireStatus` reads a status with
 * the proof the row is there.
 */
async function requireRouteNotEnded(tx: Tx, scope: Scope, routeId: string): Promise<void> {
  const [found] = await tx
    .select({ number: route.number, status: route.status })
    .from(route)
    .where(and(eq(route.companyId, scope.companyId), eq(route.projectId, scope.projectId), eq(route.id, routeId)))
    .limit(1)
  if (found === undefined) throw invalidRequest("body", [{ path: "recollectionRouteId", message: NOT_A_ROUTE }])
  if (found.status === "completed" || found.status === "cancelled") throw problem(409, { detail: routeHasEnded(routeLabelOf(found), found.status) })
}

/** The ticket the path names, locked and read: every command and the patch hold a rule the API holds, so they take the row lock first and read afterwards (routes/shared.ts). */
async function lockedTicket(tx: Tx, principal: Principal, id: string): Promise<TicketRow> {
  await lockRow(tx, ticket, { companyId: principal.companyId, id })
  const current = await findTicket(tx, principal, id)
  if (current === undefined) throw noSuchTicket(id)
  return current
}

/** A closed ticket asked to change by the patch or by `assign`, neither of which asks the machine: the machine's own sentence. */
function requireOpen(current: TicketRow): void {
  const status = current.status as TicketStatus
  if (isClosedTicketStatus(status)) throw problem(409, { detail: closedTicket(labelOf(current), status) })
}

/** The ticket with its history in recording order and the alerts naming it: what the read answers. */
async function detailOf(tx: Tx, companyId: string, row: TicketRow): Promise<TicketDetail> {
  const [events, alerts] = await Promise.all([eventsOfTicket(tx, companyId, row.id), alertsNamingTicket(tx, companyId, row.id)])
  return { ...ticketOf(row), events: events.map(eventOf), alerts: alerts.map(alertOf) }
}

/** The tickets a customer may see: those naming the customer, or a property a party row names them on, in any role — one `exists`, so two roles at one property is one ticket and not two. */
const visibleTo = (tx: Tx, companyId: string, customerId: string) =>
  or(
    eq(ticket.customerId, customerId),
    exists(
      tx
        .select({ party: propertyParty.id })
        .from(propertyParty)
        .where(and(eq(propertyParty.companyId, companyId), eq(propertyParty.customerId, customerId), eq(propertyParty.propertyId, ticket.propertyId))),
    ),
  )

/** The UTC midnight after a `YYYY-MM-DD` day: what `to`, inclusive, is compared against. */
const dayAfter = (day: string): Date => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000)

/** The columns a machine command writes beside the status. */
type Closing = { resolution: string | null; recollectionRouteId: string | null; closedAt: Date | null }

const OPEN_AGAIN: Closing = { resolution: null, recollectionRouteId: null, closedAt: null }

const commandProblems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
  404: describeProblem("No ticket with that id in the projects this account works in."),
})

const CLOSED = "A completed or rejected ticket is refused (409, `Ticket T-8831 is completed; reopen it first`)."

export function ticketRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  /**
   * One machine command: the lock, the read, the transition, and on a move
   * the row written with what the command carries beside the status and one
   * `status-changed` event with the note. `stay` answers the row as it stands
   * without a write; `refuse` is the 409 in the machine's words. `beyond`
   * holds the command's own 400s and 409s, after the machine and before the
   * write, and answers what the row is set to beside the status.
   */
  async function moved(
    tx: Tx,
    principal: Principal,
    id: string,
    command: TicketCommand,
    note: string | null,
    beyond: (current: TicketRow) => Promise<Partial<Closing>> = async () => ({}),
  ): Promise<{ row: TicketRow; wrote: boolean }> {
    const current = await lockedTicket(tx, principal, id)
    const transition = ticketTransition(current.status as TicketStatus, command, labelOf(current))
    if (transition.kind === "refuse") throw problem(409, { detail: transition.sentence })
    if (transition.kind === "stay") return { row: current, wrote: false }
    const beside = await beyond(current)
    const [row] = await tx
      .update(ticket)
      .set({ status: transition.to, ...beside })
      .where(and(ticketScope(principal), eq(ticket.id, id)))
      .returning(ticketColumns)
    if (row === undefined) throw noSuchTicket(id)
    const event: TicketEventDraft = {
      kind: "status-changed",
      status: transition.to,
      assigneeUserAccountId: row.assigneeUserAccountId,
      resolution: transition.to === "completed" ? (row.resolution as TicketEventDraft["resolution"]) : null,
      body: note,
      visibility: "internal",
      objectKey: null,
      recordedBy: principal.user.id,
      sourceEventId: null,
    }
    await appendTicketEvent(tx, { companyId: principal.companyId, projectId: row.projectId, id: row.id }, event)
    return { row, wrote: true }
  }

  return new Hono<AuthEnv>()
    .get(
      "/tickets",
      describeRoute({
        operationId: "listTickets",
        summary: "The tickets of the caller's projects",
        description:
          "One page of tickets, oldest first (ids are time-ordered, so a cursor over them is a cursor over time), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `status` is one of the six, `open=true` the four open statuses and `open=false` the two closed (the two combine with `status`), `kind`, `priority` and `source` one each, `assigneeUserAccountId` one account's tickets, `propertyId`, `routeId`, `pickupId`, `containerId` and `driverId` the tickets naming that row, and `from` and `to` the tickets whose `occurredAt` falls on a window of UTC days (both inclusive, `to` on or after `from`). `customerId` is the citizen portal's read model: the tickets naming the customer, or naming a property a party row names them on in any role — one row per ticket however many roles they hold — held to a customer of this company (400 on the query); its fence on the portal's own login is the portal issue's. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of tickets.", TicketPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, the window runs backwards, `projectId` is not a project this account works in, or `customerId` is not a customer of this company."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", TicketListQuery),
      async (c) => {
        const { limit, cursor, projectId, status, open, kind, priority, source, assigneeUserAccountId, customerId, propertyId, routeId, pickupId, containerId, driverId, from, to } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        if (customerId !== undefined) await requireCustomer(tx, principal.companyId, customerId, "customerId", "query")
        const rows = await tx
          .select(ticketColumns)
          .from(ticket)
          .where(
            and(
              ticketScope(principal),
              projectId === undefined ? undefined : eq(ticket.projectId, projectId),
              status === undefined ? undefined : eq(ticket.status, status),
              open === undefined ? undefined : inArray(ticket.status, [...(open ? OPEN_TICKET_STATUSES : CLOSED_TICKET_STATUSES)]),
              kind === undefined ? undefined : eq(ticket.kind, kind),
              priority === undefined ? undefined : eq(ticket.priority, priority),
              source === undefined ? undefined : eq(ticket.source, source),
              assigneeUserAccountId === undefined ? undefined : eq(ticket.assigneeUserAccountId, assigneeUserAccountId),
              customerId === undefined ? undefined : visibleTo(tx, principal.companyId, customerId),
              propertyId === undefined ? undefined : eq(ticket.propertyId, propertyId),
              routeId === undefined ? undefined : eq(ticket.routeId, routeId),
              pickupId === undefined ? undefined : eq(ticket.pickupId, pickupId),
              containerId === undefined ? undefined : eq(ticket.containerId, containerId),
              driverId === undefined ? undefined : eq(ticket.driverId, driverId),
              from === undefined ? undefined : gte(ticket.occurredAt, new Date(`${from}T00:00:00Z`)),
              to === undefined ? undefined : lt(ticket.occurredAt, dayAfter(to)),
              after === undefined ? undefined : gt(ticket.id, after),
            ),
          )
          .orderBy(asc(ticket.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(ticketOf), limit))
      },
    )
    .post(
      "/tickets",
      describeRoute({
        operationId: "createTicket",
        summary: "Open a ticket",
        description:
          "Opens a case in a project the caller works in (400 at `projectId` otherwise): the number is taken from the company's counter (`T-<n>`, never renumbered), the row is written `open`, and a `created` event is appended with the assignee if one and the caller as its recorder. `source` is one of the office's doors and defaults to `office`; `driver-app` and `dispatch` are the outbox consumer's and are refused. `occurredAt` is when the issue or request happened, the request's clock when absent, and may run at most five minutes ahead of it (400) — with no lower bound, since the office records a complaint made yesterday. Every link named is held to the ticket's project (400 at `links.<field>`): a route of the project, a pickup of that route (a pickup is named with its route, 400 at `links.pickupId`), a container, a property, a shared collection point, an agreement, a driver and a parent ticket of the project, a customer of the company; no status gates a link — a ticket is about whatever it is about. `assigneeUserAccountId` is an account of this company that is not deactivated and works in the project (400). `alertId` is an alert of the project (400) that is not resolved (409, `This alert is resolved and does not change`) and not linked to another ticket (409, `This alert is linked to ticket T-8831; an alert links to one ticket`); its `ticketId` is set in the same transaction. The `ticket-opened` event is written in the same transaction, carrying the ticket as answered.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The ticket as opened.", Ticket),
          400: describeProblem("The body is missing a field, names a member the server owns, names a source the office may not write, dates the ticket more than five minutes after the request, names a pickup without its route, or names a project, link, assignee or alert the rules above refuse — each at the field that is wrong."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`create\` on \`${MODULE}\`.`),
          409: describeProblem("The alert named is resolved, or is linked to another ticket; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", TicketCreate),
      async (c) => {
        const body: TicketCreate = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, body.projectId)
        const scope: Scope = { companyId: principal.companyId, projectId: body.projectId }
        const at = now()
        const occurredAt = body.occurredAt === undefined ? at : new Date(body.occurredAt)
        // The 400s in body order: the clock, the assignee, the links, the alert's existence; the alert's two 409s follow under its lock inside `openTicket`.
        requireNotAhead(occurredAt, at)
        await requireAccountInProject(tx, scope, body.assigneeUserAccountId)
        const links = linksAfter(NO_LINKS, body.links)
        await requireLinks(tx, scope, links, namedIn(body.links))
        await requireAlert(tx, scope, body.alertId)
        const { answered } = await openTicket(tx, {
          companyId: principal.companyId,
          draft: {
            projectId: body.projectId,
            kind: body.kind,
            priority: body.priority,
            source: body.source,
            subject: body.subject,
            description: body.description,
            occurredAt,
            dueAt: body.dueAt == null ? null : new Date(body.dueAt),
            assigneeUserAccountId: body.assigneeUserAccountId ?? null,
            links,
            alertId: body.alertId ?? null,
          },
          createdBy: principal.user.id,
          sourceEventId: null,
          newId,
          now: () => at,
        })
        return created(c, "/tickets", answered)
      },
    )
    .get(
      "/tickets/:id",
      describeRoute({
        operationId: "getTicket",
        summary: "One ticket with its history and the alerts naming it",
        description:
          "One ticket of a project the caller works in, as it now stands: the case, its history in recording order — the `created` row, every assignment and status change with its note, every comment with its visibility and attachment key — and the alerts linked to it. A ticket of another company, or of a project this account does not work in, is a ticket that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The ticket, its history and its alerts.", TicketDetail),
          400: describeProblem("The path does not hold an id."),
          ...commandProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findTicket(tx, principal, id)
        if (row === undefined) throw noSuchTicket(id)
        return c.json(await detailOf(tx, principal.companyId, row))
      },
    )
    .patch(
      "/tickets/:id",
      describeRoute({
        operationId: "patchTicket",
        summary: "Change a ticket's own fields",
        description:
          "Moves the case's own fields — `subject`, `description`, `kind`, `priority`, `dueAt` and the `links` — and nothing the machine or the assignment owns: the status moves through the commands, the assignee through `assign`, and the source, the project, the number, the resolution and the stamps never. At least one field must be given. Under the ticket's row lock. " +
          CLOSED +
          " Every link named is held as on the create (400 at `links.<field>`), the pickup rule against the row the patch leaves behind: a body moving `pickupId` alone names the stored route, one moving `routeId` under a stored pickup must name the pickup's route, and a body clearing the route under a pickup is refused at `links.pickupId`; a ticket may not be its own parent (400). `updatedAt` moves; no history row is appended, since a field edit is the audit log's (ADR-0005).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The ticket as it now stands.", Ticket),
          400: describeProblem("The path does not hold an id, or the body changes nothing, names a member the patch does not take, or names a link the rules above refuse — at the field that is wrong."),
          ...commandProblems("edit"),
          409: describeProblem("The ticket is completed or rejected; reopen it first."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TicketPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedTicket(tx, principal, id)
        requireOpen(current)
        const scope: Scope = { companyId: principal.companyId, projectId: current.projectId }
        const links = linksAfter(linksOf(current), body.links)
        await requireLinks(tx, scope, links, namedIn(body.links), current.id)
        const [row] = await tx
          .update(ticket)
          .set({
            subject: body.subject ?? current.subject,
            description: body.description ?? current.description,
            kind: body.kind ?? current.kind,
            priority: body.priority ?? current.priority,
            dueAt: body.dueAt === undefined ? current.dueAt : body.dueAt === null ? null : new Date(body.dueAt),
            ...links,
          })
          .where(and(ticketScope(principal), eq(ticket.id, id)))
          .returning(ticketColumns)
        if (row === undefined) throw noSuchTicket(id)
        return c.json(ticketOf(row))
      },
    )
    .post(
      "/tickets/:id/assign",
      describeRoute({
        operationId: "assignTicket",
        summary: "Move who works a ticket",
        description:
          "The `assign` command: sets the assignee to the account named, or to nobody with null, and appends an `assigned` event carrying the body's note and the assignee after it. The account is one of this company's that is not deactivated (400, `Not a user account of this company`) and works in the ticket's project — every project, or a Project Access row (400, `Not a user account working in this project`) — since a ticket assigned to someone who cannot see it is a bug and not a choice. The account already assigned answers 200 as the ticket stands, without a write or an event. Under the ticket's row lock. " +
          CLOSED,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The ticket as it now stands.", Ticket),
          400: describeProblem("The path does not hold an id, or the body is missing `assigneeUserAccountId`, names a member the command does not take, or names an account the rules above refuse."),
          ...commandProblems("edit"),
          409: describeProblem("The ticket is completed or rejected; reopen it first."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TicketAssign),
      async (c) => {
        const { id } = c.req.valid("param")
        const { assigneeUserAccountId, note } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedTicket(tx, principal, id)
        requireOpen(current)
        if (current.assigneeUserAccountId === assigneeUserAccountId) return c.json(ticketOf(current))
        await requireAccountInProject(tx, { companyId: principal.companyId, projectId: current.projectId }, assigneeUserAccountId)
        const [row] = await tx
          .update(ticket)
          .set({ assigneeUserAccountId })
          .where(and(ticketScope(principal), eq(ticket.id, id)))
          .returning(ticketColumns)
        if (row === undefined) throw noSuchTicket(id)
        await appendTicketEvent(
          tx,
          { companyId: principal.companyId, projectId: row.projectId, id: row.id },
          { kind: "assigned", status: row.status as TicketStatus, assigneeUserAccountId: row.assigneeUserAccountId, resolution: null, body: note ?? null, visibility: "internal", objectKey: null, recordedBy: principal.user.id, sourceEventId: null },
        )
        return c.json(ticketOf(row))
      },
    )
    .post(
      "/tickets/:id/start",
      describeRoute({
        operationId: "startTicket",
        summary: "Start work on a ticket",
        description:
          "The `start` command: `open`, `pending` or `on-hold` becomes `in-progress`, and a `status-changed` event is appended with the body's note if any. A ticket already in progress answers 200 as it stands, without a write or an event. Under the ticket's row lock. " + CLOSED,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The ticket, in progress.", Ticket),
          400: describeProblem("The path does not hold an id, or the body names a member the command does not take."),
          ...commandProblems("edit"),
          409: describeProblem("The ticket is completed or rejected; reopen it first."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TicketStart),
      async (c) => {
        const { id } = c.req.valid("param")
        const { note } = c.req.valid("json")
        const { row } = await moved(c.get("tx"), c.get("principal"), id, "start", note ?? null)
        return c.json(ticketOf(row))
      },
    )
    .post(
      "/tickets/:id/wait",
      describeRoute({
        operationId: "waitTicket",
        summary: "Wait for the customer",
        description:
          "The `wait` command: `open`, `in-progress` or `on-hold` becomes `pending` — waiting for the customer, and the note says for what — with a `status-changed` event carrying the note. A ticket already pending answers 200 as it stands, without a write or an event. Under the ticket's row lock. " + CLOSED,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The ticket, pending.", Ticket),
          400: describeProblem("The path does not hold an id, or the body has no note or names a member the command does not take."),
          ...commandProblems("edit"),
          409: describeProblem("The ticket is completed or rejected; reopen it first."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TicketWait),
      async (c) => {
        const { id } = c.req.valid("param")
        const { note } = c.req.valid("json")
        const { row } = await moved(c.get("tx"), c.get("principal"), id, "wait", note)
        return c.json(ticketOf(row))
      },
    )
    .post(
      "/tickets/:id/hold",
      describeRoute({
        operationId: "holdTicket",
        summary: "Put a ticket on hold",
        description:
          "The `hold` command: `open`, `in-progress` or `pending` becomes `on-hold` — waiting on us, and the note says for what — with a `status-changed` event carrying the note. A ticket already on hold answers 200 as it stands, without a write or an event. Under the ticket's row lock. " + CLOSED,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The ticket, on hold.", Ticket),
          400: describeProblem("The path does not hold an id, or the body has no note or names a member the command does not take."),
          ...commandProblems("edit"),
          409: describeProblem("The ticket is completed or rejected; reopen it first."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TicketHold),
      async (c) => {
        const { id } = c.req.valid("param")
        const { note } = c.req.valid("json")
        const { row } = await moved(c.get("tx"), c.get("principal"), id, "hold", note)
        return c.json(ticketOf(row))
      },
    )
    .post(
      "/tickets/:id/complete",
      describeRoute({
        operationId: "completeTicket",
        summary: "Complete a ticket",
        description:
          "The `complete` command: any open status becomes `completed` with the `resolution` — `recollected`, `serviced`, `answered`, `no-action` or `duplicate` — `closedAt` stamped with the request's clock, and a `status-changed` event carrying the resolution and the note. With `recollected`, and only then (400 at `recollectionRouteId` otherwise), the body may name the route the re-collection rides on: a route of the ticket's project (400, `Not a route of this project`) that has not ended — a completed or cancelled route is refused (409, `Route RC-1042 is completed; a re-collection rides on a route that has not ended`), the one status gate a ticket's links have, since this reference asks the route to run. Resolution makes no route and no pickup: the re-collection is Execution's, and the ticket names it. Not idempotent: a second completion is a change a person meant. Under the ticket's row lock. " +
          CLOSED +
          " The `ticket-completed` event is written in the same transaction, carrying the ticket as answered; Finance is its consumer.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The ticket, completed.", Ticket),
          400: describeProblem("The path does not hold an id, or the body is missing the resolution or the note, names a member the command does not take, names a re-collection route with another resolution, or names a route that is not the project's."),
          ...commandProblems("edit"),
          409: describeProblem("The ticket is completed or rejected already, or the re-collection route has ended; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TicketComplete),
      async (c) => {
        const { id } = c.req.valid("param")
        const { resolution, note, recollectionRouteId } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const at = now()
        const { row } = await moved(tx, principal, id, "complete", note, async (current) => {
          if (recollectionRouteId !== undefined) await requireRouteNotEnded(tx, { companyId: principal.companyId, projectId: current.projectId }, recollectionRouteId)
          return { resolution, recollectionRouteId: recollectionRouteId ?? null, closedAt: at }
        })
        const answered = ticketOf(row)
        await emit(tx, principal, { aggregate: "ticket", aggregateId: row.id, kind: "ticket-completed", payload: answered, projectId: row.projectId, occurredAt: at })
        return c.json(answered)
      },
    )
    .post(
      "/tickets/:id/reject",
      describeRoute({
        operationId: "rejectTicket",
        summary: "Reject a ticket",
        description:
          "The `reject` command: any open status becomes `rejected` with the body's `reason` as the `status-changed` event's body and `closedAt` stamped with the request's clock; a rejected ticket has a reason and no resolution. Not idempotent: a second rejection is a change a person meant. Under the ticket's row lock. " +
          CLOSED +
          " The `ticket-rejected` event is written in the same transaction, carrying the ticket as answered.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The ticket, rejected.", Ticket),
          400: describeProblem("The path does not hold an id, or the body has no reason or names a member the command does not take."),
          ...commandProblems("edit"),
          409: describeProblem("The ticket is completed or rejected already; reopen it first."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TicketReject),
      async (c) => {
        const { id } = c.req.valid("param")
        const { reason } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const at = now()
        const { row } = await moved(tx, principal, id, "reject", reason, async () => ({ closedAt: at }))
        const answered = ticketOf(row)
        await emit(tx, principal, { aggregate: "ticket", aggregateId: row.id, kind: "ticket-rejected", payload: answered, projectId: row.projectId, occurredAt: at })
        return c.json(answered)
      },
    )
    .post(
      "/tickets/:id/reopen",
      describeRoute({
        operationId: "reopenTicket",
        summary: "Reopen a closed ticket",
        description:
          "The `reopen` command: `completed` or `rejected` becomes `open` with the body's note as the `status-changed` event's body, and the three closing columns — `resolution`, `recollectionRouteId` and `closedAt` — are cleared, since a reopened ticket is open; the closing stands in the history. A ticket that is open in any of the four open statuses answers 200 as it stands, without a write or an event. Under the ticket's row lock.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The ticket, open again.", Ticket),
          400: describeProblem("The path does not hold an id, or the body has no note or names a member the command does not take."),
          ...commandProblems("edit"),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TicketReopen),
      async (c) => {
        const { id } = c.req.valid("param")
        const { note } = c.req.valid("json")
        const { row } = await moved(c.get("tx"), c.get("principal"), id, "reopen", note, async () => OPEN_AGAIN)
        return c.json(ticketOf(row))
      },
    )
    .get(
      "/tickets/:id/events",
      describeRoute({
        operationId: "listTicketEvents",
        summary: "One ticket's history",
        description:
          "One page of the ticket's history, oldest first — a cursor over time-ordered ids is a cursor over recording order — each row a snapshot of the status and the assignee after it: the `created` row, every `assigned` and `status-changed` with its note or reason, every `comment` with its body, who may read it and its attachment key. `kind` narrows it to one kind, `visibility` to the rows the office alone may read or to the customer's — `visibility=customer` is the thread the portal reads, and leaves every internal row out. A ticket of another company, or of a project this account does not work in, is a ticket that does not exist here. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the ticket's history, oldest first.", EventPage),
          400: describeProblem("The path does not hold an id, the page size is outside 1..200, the cursor is not one this API wrote, or a filter is malformed."),
          ...commandProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", TicketEventListQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit, cursor, kind, visibility } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if ((await findTicket(tx, principal, id)) === undefined) throw noSuchTicket(id)
        const rows = await tx
          .select(eventColumns)
          .from(ticketEvent)
          .where(
            and(
              eq(ticketEvent.companyId, principal.companyId),
              eq(ticketEvent.ticketId, id),
              kind === undefined ? undefined : eq(ticketEvent.kind, kind),
              visibility === undefined ? undefined : eq(ticketEvent.visibility, visibility),
              after === undefined ? undefined : gt(ticketEvent.id, after),
            ),
          )
          .orderBy(asc(ticketEvent.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(eventOf), limit))
      },
    )
    .post(
      "/tickets/:id/comments",
      describeRoute({
        operationId: "commentTicket",
        summary: "Comment on a ticket",
        description:
          "Appends a `comment` to the ticket's history: the `body`, who may read it (`internal`, the office's, unless `customer` is said — the row the portal then reads), and the Storage key of an attachment if one was uploaded. The row's id is minted first and the key must name it: `<companyId>/<ticketId>/<eventId>.<jpg|jpeg|png|webp|pdf>` in the bucket `ticket-attachments`, so a caller cannot name another tenant's object, another ticket's or another comment's (400 at `objectKey`, `The attachment key names another ticket or another comment`). Taken on a closed ticket too — a note after the fact is a note — and touches the ticket's row not at all: nothing of the case moves, and `updatedAt` stays. Answers 201 with the event and no `Location`, the one create without one: a history row has no single-row read (`GET /tickets/{id}/events` is a list), and `Location` names where a row is read.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The comment as it was appended.", TicketEvent),
          400: describeProblem("The path does not hold an id, or the body has no `body`, names a member the command does not take, gives an attachment key of the wrong shape, or gives one naming another ticket or another comment."),
          ...commandProblems("create"),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", TicketComment),
      async (c) => {
        const { id } = c.req.valid("param")
        const { body, visibility, objectKey } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await findTicket(tx, principal, id)
        if (current === undefined) throw noSuchTicket(id)
        // The event's id first, so the key can be held to the row it will name.
        const eventId = newId()
        if (objectKey !== undefined && !objectKey.startsWith(`${principal.companyId}/${current.id}/${eventId}.`)) {
          throw invalidRequest("body", [{ path: "objectKey", message: KEY_NAMES_ANOTHER }])
        }
        const row = await appendTicketEvent(
          tx,
          { companyId: principal.companyId, projectId: current.projectId, id: current.id },
          {
            id: eventId,
            kind: "comment",
            status: current.status as TicketStatus,
            assigneeUserAccountId: current.assigneeUserAccountId,
            resolution: null,
            body,
            visibility,
            objectKey: objectKey ?? null,
            recordedBy: principal.user.id,
            sourceEventId: null,
          },
        )
        return c.json(eventOf(row), 201)
      },
    )
}
