// The Ticket as the office reads, opens and moves it (Issue #109;
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
// is a note; its snapshot is read under the row's lock like a command's, so
// it is the row as it stands when the comment lands.
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
// Every command and the patch carry the tenant and `inProjects`; the reads —
// the list, a ticket's read and its history — and the comment carry the
// tenant and the reach (`ticketReach`): the office's projects, or, for a
// Service Provider's account, the tickets about a route its provider runs
// (#291 slice 23b). Such an account raises a ticket only about a route it
// runs, in that route's project, from its workspace — the row's source is
// `service-provider`, its assignee and its alert the office's to give — and
// reads and writes the ticket's `service-provider` thread of the history
// alone, never the office's internal notes, the customer's thread or the
// alerts; the patch and the seven commands find no row for it, the family's
// 404. The
// grant is `operate.tickets`, `view` to read, `create` to open a ticket and
// to comment, `edit` for the patch and the seven commands.
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
  TicketEvidence,
  TicketHold,
  TicketListQuery,
  TicketPatch,
  TicketReject,
  TicketReopen,
  TicketReplyWithEvidence,
  TicketStart,
  TicketWait,
  type TicketLinks,
  type TicketLinksSet,
} from "@waste/contracts/tickets"
import type { Tx } from "@waste/db/client"
import { propertyParty } from "@waste/db/schema/customers"
import { pickup, route } from "@waste/db/schema/execution"
import { ticket, ticketEvent } from "@waste/db/schema/resolution"
import { closedTicket, ticketTransition, type TicketCommand } from "@waste/domain/resolution/transitions"
import { CLOSED_TICKET_STATUSES, isClosedTicketStatus, OPEN_TICKET_STATUSES, type TicketStatus } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq, exists, gt, gte, inArray, isNull, lt, notInArray, or, type SQL } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { requireProject } from "../auth/projects"
import { providerIdOf, providerNameOf } from "../auth/provider"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { emit } from "../outbox"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { findReachedRoute, labelOf as routeLabelOf } from "./execution-shapes"
import {
  NOT_A_PICKUP,
  NOT_A_ROUTE,
  requireAccountInProject,
  requireAgreement,
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
import { alertOf, alertsNamingTicket, eventColumns, eventOf, eventsOfTicket, findReachedTicket, findTicket, historyReadable, labelOf, linksOf, noSuchTicket, PROVIDER_THREAD, ticketColumns, ticketOf, ticketReach, ticketScope, type TicketRow } from "./resolution-shapes"
import type { ClockOptions } from "./scheme-groups"
import { created, dayWindow, describeCreated, describeJson, IdParam, lockRow, requireNotAhead } from "./shared"
import { refuseUnofferedProduct } from "./statuses"
import { requireTicketWorkProduct } from "./ticket-charges"
import { recordCustomerReply, replyBody, stopEvidenceFor } from "./ticket-evidence"
import { appendTicketEvent, BY_SLA, openTicket, type TicketEventDraft } from "./ticket-writes"

const MODULE = "operate.tickets"

const TicketPage = Page(Ticket)
const EventPage = Page(TicketEvent)

/** What a body naming the ticket as its own parent is told, at `links.parentTicketId`. */
export const NOT_ITS_OWN_PARENT = "A ticket is not its own parent"

/** What a Service Provider's account is told when its ticket names no route it runs, at `links.routeId`. */
export const namesARouteItRuns = (provider: string): string => `A ticket ${provider} raises names a route ${provider} runs`
export const notARouteItRuns = (provider: string): string => `Not a route ${provider} runs`
/** What a provider's ticket in another project than its route's is told, at `projectId`. */
export const notTheRoutesProject = (route: string): string => `Not the project of route ${route}`
/** What a provider's ticket naming a source of the office's is told, at `source`. */
export const fromItsWorkspace = (provider: string): string => `A ticket ${provider} raises comes from its workspace: its source is service-provider`
export const OFFICE_ASSIGNS = "The office assigns a ticket"
export const OFFICE_LINKS_ALERTS = "The office links an alert to a ticket"
/** What a provider's comment meant for the customer is told, at `visibility`. */
export const OFFICE_SPEAKS_TO_CUSTOMERS = "The office speaks to the customer: a service provider's comment is for the office and the provider"

/**
 * A ticket a Service Provider's account raises (#291 slice 23b): about a
 * route its provider runs (`links.routeId`, as `GET /routes` reaches it), in
 * that route's project, from its workspace — the default source, which the
 * API writes as `service-provider`, and no other — with no assignee and no
 * alert, which are the office's. Every refusal a 400 at its field, listed
 * together in the body's order.
 */
async function requireProviderTicket(tx: Tx, principal: Principal, body: TicketCreate): Promise<void> {
  const provider = providerNameOf(principal)
  const issues: { path: string; message: string }[] = []
  const routeId = body.links?.routeId ?? null
  const named = routeId === null ? undefined : await findReachedRoute(tx, principal, routeId)
  if (named !== undefined && named.projectId !== body.projectId) issues.push({ path: "projectId", message: notTheRoutesProject(routeLabelOf(named)) })
  if (body.source !== "office") issues.push({ path: "source", message: fromItsWorkspace(provider) })
  if (body.assigneeUserAccountId != null) issues.push({ path: "assigneeUserAccountId", message: OFFICE_ASSIGNS })
  if (named === undefined) issues.push({ path: "links.routeId", message: routeId === null ? namesARouteItRuns(provider) : notARouteItRuns(provider) })
  if (body.alertId !== undefined) issues.push({ path: "alertId", message: OFFICE_LINKS_ALERTS })
  if (issues.length > 0) throw invalidRequest("body", issues)
}

/** What a completion naming a route that has ended is told: the #79 gate on the one reference a ticket makes that asks its row to run. */
export const routeHasEnded = (label: string, status: "completed" | "cancelled"): string => `Route ${label} is ${status}; a re-collection rides on a route that has not ended`

/** What a re-collection naming a stop that was missed is told: the re-collection is a stop still to be collected, or one collected. */
export const stopWasMissed = (position: number, route: string, status: "skipped" | "failed"): string => `Stop ${position} of route ${route} is ${status}; a re-collection names a stop that is planned or collected`

/** What a re-collection naming a work order is told, at `recollectionPickupId`: a repair or a wash collects nothing (O3 of #290). */
export const NOT_AN_EMPTYING = "A re-collection names a stop that empties its container, not a repair or a wash"

/** What a comment's attachment key naming another company's or another ticket's prefix is told, at `objectKey`. */
export const KEY_NAMES_ANOTHER = "The attachment key names another company or another ticket"

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

/**
 * The route a re-collection rides on: one of the project's (400 at
 * `recollectionRouteId`) that has not ended — a completed or cancelled route
 * is a 409 naming it and its status, the #79 gate on a new reference, after
 * the 400s. One statement for both, as `requireStatus` reads a status with
 * the proof the row is there. The stop the completion names beside it
 * (#111), where it names one, is a stop of that route (400 at
 * `recollectionPickupId`), asked between the two, and one that was missed —
 * skipped or failed, the original stop the ticket is about among them — is a
 * 409 after the route's: the re-collection is a stop to be collected, or one
 * collected.
 */
async function requireRouteNotEnded(tx: Tx, scope: Scope, routeId: string, pickupId: string | undefined): Promise<void> {
  const [found] = await tx
    .select({ number: route.number, status: route.status })
    .from(route)
    .where(and(eq(route.companyId, scope.companyId), eq(route.projectId, scope.projectId), eq(route.id, routeId)))
    .limit(1)
  if (found === undefined) throw invalidRequest("body", [{ path: "recollectionRouteId", message: NOT_A_ROUTE }])
  // The stop the office added for the re-collection (#111) is a stop of that route, a 400 at its field before the route's 409.
  const [stop] =
    pickupId === undefined
      ? [undefined]
      : await tx
          .select({ position: pickup.position, status: pickup.status, service: pickup.service })
          .from(pickup)
          .where(and(eq(pickup.companyId, scope.companyId), eq(pickup.routeId, routeId), eq(pickup.id, pickupId)))
          .limit(1)
  if (pickupId !== undefined && stop === undefined) throw invalidRequest("body", [{ path: "recollectionPickupId", message: NOT_A_PICKUP }])
  if (stop !== undefined && stop.service !== "empty") throw invalidRequest("body", [{ path: "recollectionPickupId", message: NOT_AN_EMPTYING }])
  if (found.status === "completed" || found.status === "cancelled") throw problem(409, { detail: routeHasEnded(routeLabelOf(found), found.status) })
  if (stop !== undefined && (stop.status === "skipped" || stop.status === "failed")) throw problem(409, { detail: stopWasMissed(stop.position, routeLabelOf(found), stop.status) })
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

/** The ticket with its history in recording order and the alerts naming it: what the read answers. A Service Provider's account reads its own thread of the history and no alert, both being the office's otherwise (#291 slice 23b). */
async function detailOf(tx: Tx, principal: Principal, row: TicketRow): Promise<TicketDetail> {
  const companyId = principal.companyId
  const office = providerIdOf(principal) === null
  const [events, alerts] = await Promise.all([eventsOfTicket(tx, companyId, row.id, historyReadable(principal)), office ? alertsNamingTicket(tx, companyId, row.id) : []])
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

/** The columns a machine command writes beside the status. */
type Closing = { resolution: string | null; recollectionRouteId: string | null; recollectionPickupId: string | null; chargeProductId: string | null; closedAt: Date | null }

const OPEN_AGAIN: Closing = { resolution: null, recollectionRouteId: null, recollectionPickupId: null, chargeProductId: null, closedAt: null }

const commandProblems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
  404: describeProblem(
    action === "edit"
      ? "No ticket with that id in the projects this account works in: a Service Provider's account reads, raises and comments, and moves no ticket."
      : "No ticket with that id in the projects this account works in, or, for a Service Provider's account, none about a route its provider runs.",
  ),
})

const CLOSED = "A completed or rejected ticket is refused (409, `Ticket T-8831 is completed; reopen it first`)."

/** The note on the `status-changed` row of a case the stop's record answered. */
const ANSWERED_BY_RECORD = "Answered with the stop's record."
/** The 409 of a reply with evidence on a ticket about no stop. */
const NO_STOP = "This ticket names no stop, so no record answers it"

/** An open ticket past its due date at `at` (`overdue=true`), or every other ticket (`false`): `slaStateOf`'s `overdue`, in SQL. */
function overdueAt(overdue: boolean, at: Date): SQL | undefined {
  const pastDue = and(inArray(ticket.status, [...OPEN_TICKET_STATUSES]), lt(ticket.dueAt, at))
  return overdue ? pastDue : or(notInArray(ticket.status, [...OPEN_TICKET_STATUSES]), isNull(ticket.dueAt), gte(ticket.dueAt, at))
}

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
          "One page of tickets, oldest first (ids are time-ordered, so a cursor over them is a cursor over time), from the projects the caller works in — or, for a Service Provider's account, which works in none, the tickets about a route its provider runs (as `GET /routes` reaches it). `projectId` narrows it to one of those projects; naming another is refused. `status` is one of the six, `open=true` the four open statuses and `open=false` the two closed (the two combine with `status`), `overdue=true` the open tickets whose `dueAt` has passed on the request's clock and `overdue=false` every other — closed, without a due date, or not due yet — `kind`, `priority` and `source` one each, `assigneeUserAccountId` one account's tickets, `propertyId`, `routeId`, `pickupId`, `containerId` and `driverId` the tickets naming that row, and `from` and `to` the tickets whose `occurredAt` falls in a window of days — both ends inclusive, on the UTC calendar day, so `to=2026-10-05` takes the whole of the 5th (`to` on or after `from`). `customerId` is the citizen portal's read model: the tickets naming the customer, or naming a property a party row names them on in any role — one row per ticket however many roles they hold — held to a customer of this company (400 on the query); its fence on the portal's own login is the portal issue's. Hand `nextCursor` back as `cursor` for the next page.",
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
        const { limit, cursor, projectId, status, open, overdue, kind, priority, source, assigneeUserAccountId, customerId, propertyId, routeId, pickupId, containerId, driverId, from, to } = c.req.valid("query")
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
              ticketReach(tx, principal),
              projectId === undefined ? undefined : eq(ticket.projectId, projectId),
              status === undefined ? undefined : eq(ticket.status, status),
              open === undefined ? undefined : inArray(ticket.status, [...(open ? OPEN_TICKET_STATUSES : CLOSED_TICKET_STATUSES)]),
              overdue === undefined ? undefined : overdueAt(overdue, now()),
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
              dayWindow(ticket.occurredAt, from, to),
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
          "Opens a case in a project the caller works in (400 at `projectId` otherwise): the number is taken from the company's counter (`T-<n>`, never renumbered), the row is written `open`, and a `created` event is appended with the assignee if one and the caller as its recorder. `source` is one of the office's doors and defaults to `office`; `driver-app` and `dispatch` are the outbox consumer's and are refused. `occurredAt` is when the issue or request happened, the request's clock when absent, and may run at most five minutes ahead of it (400) — with no lower bound, since the office records a complaint made yesterday. `dueAt` is the due date, null for none; absent, it is the project's SLA target of the ticket's kind and priority counted from `occurredAt` (`GET /projects/:id/ticket-sla`: the kind's own target, else every kind's), and none where the project sets neither. Every link named is held to the ticket's project (400 at `links.<field>`): a route of the project, a pickup of that route (a pickup is named with its route, 400 at `links.pickupId`), a container, a property, a shared collection point, an agreement, a driver and a parent ticket of the project, a customer of the company; no status gates a link — a ticket is about whatever it is about. `assigneeUserAccountId` is an account of this company that is not deactivated and works in the project (400). `alertId` is an alert of the project (400) that is not resolved (409, `This alert is resolved and does not change`) and not linked to another ticket (409, `This alert is linked to ticket T-8831; an alert links to one ticket`); its `ticketId` is set in the same transaction. The `ticket-opened` event is written in the same transaction, carrying the ticket as answered. A Service Provider's account opens a ticket about a route its provider runs alone: `links.routeId` names one (as `GET /routes` reaches it), `projectId` is that route's project, the source is left to its default — the API writes `service-provider` — and neither an assignee nor an alert is named, those being the office's; each refused (400) at its field. A `missed-collection` naming an emptying whose driver recorded the bin was not presented — skipped or failed, reason `not-presented`, and not since corrected by the office — is answered by that record as it opens, unless `answerFromRecord` is false: a customer-visible `comment` quoting the record (as `GET /tickets/{id}/evidence` writes it) is appended, the case is completed `answered`, and `ticket-completed` follows `ticket-opened`; the 201 answers it completed. The reply is recorded, not sent: sending is the communications slice's, and a reply recorded before it is never sent after it.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The ticket as opened, or completed `answered` where the stop's record answered it.", Ticket),
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
        const fromProvider = providerIdOf(principal) !== null
        if (fromProvider) await requireProviderTicket(tx, principal, body)
        else requireProject(principal, body.projectId)
        const scope: Scope = { companyId: principal.companyId, projectId: body.projectId }
        const at = now()
        const occurredAt = body.occurredAt === undefined ? at : new Date(body.occurredAt)
        // The 400s in body order: the clock, the assignee, the links; the alert's own 400 and its two 409s follow under its lock inside `openTicket` (routes/alert-links.ts), which spells them once for both doors, so nothing is checked here that it checks again.
        requireNotAhead(occurredAt, at)
        await requireAccountInProject(tx, scope, body.assigneeUserAccountId)
        const links = linksAfter(NO_LINKS, body.links)
        await requireLinks(tx, scope, links, namedIn(body.links))
        const { answered } = await openTicket(tx, {
          companyId: principal.companyId,
          draft: {
            projectId: body.projectId,
            kind: body.kind,
            priority: body.priority,
            source: fromProvider ? "service-provider" : body.source,
            subject: body.subject,
            description: body.description,
            occurredAt,
            dueAt: body.dueAt === undefined ? BY_SLA : body.dueAt === null ? null : new Date(body.dueAt),
            assigneeUserAccountId: body.assigneeUserAccountId ?? null,
            links,
            alertId: body.alertId ?? null,
          },
          createdBy: principal.user.id,
          sourceEventId: null,
          newId,
          now: () => at,
        })
        if (body.kind !== "missed-collection" || !body.answerFromRecord || links.pickupId === null) return created(c, "/tickets", answered)
        // A missed collection the stop's record answers is answered as it opens (M6): the reply that quotes the record, then the case completed `answered`, in this transaction.
        const opened = await findTicket(tx, principal, answered.id)
        const evidence = opened === undefined ? null : await stopEvidenceFor(tx, principal.companyId, opened)
        if (opened === undefined || evidence === null || !evidence.answeredByRecord) return created(c, "/tickets", answered)
        await recordCustomerReply(tx, { companyId: principal.companyId, projectId: opened.projectId, id: opened.id }, { status: opened.status as TicketStatus, assigneeUserAccountId: opened.assigneeUserAccountId }, evidence.reply, principal.user.id)
        const { row } = await moved(tx, principal, opened.id, "complete", ANSWERED_BY_RECORD, async () => ({ resolution: "answered", recollectionRouteId: null, recollectionPickupId: null, closedAt: at }))
        const completed = ticketOf(row)
        await emit(tx, principal, { aggregate: "ticket", aggregateId: row.id, kind: "ticket-completed", payload: completed, projectId: row.projectId, occurredAt: at })
        return created(c, "/tickets", completed)
      },
    )
    .get(
      "/tickets/:id",
      describeRoute({
        operationId: "getTicket",
        summary: "One ticket with its history and the alerts naming it",
        description:
          "One ticket of a project the caller works in, or about a route a Service Provider's account runs (as `GET /tickets` reaches it), as it now stands: the case, its history in recording order — the `created` row, every assignment and status change with its note, every comment with its visibility and attachment key — and the alerts linked to it. A ticket of another company, or one outside that reach, is a ticket that does not exist here.",
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
        const row = await findReachedTicket(tx, principal, id)
        if (row === undefined) throw noSuchTicket(id)
        return c.json(await detailOf(tx, principal, row))
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
          "The `complete` command: any open status becomes `completed` with the `resolution` — `recollected`, `serviced`, `answered`, `no-action` or `duplicate` — `closedAt` stamped with the request's clock, and a `status-changed` event carrying the resolution and the note. With `recollected`, and only then (400 at `recollectionRouteId` otherwise), the body may name the route the re-collection rides on: a route of the ticket's project (400, `Not a route of this project`) that has not ended — a completed or cancelled route is refused (409, `Route RC-1042 is completed; a re-collection rides on a route that has not ended`), the one status gate a ticket's links have, since this reference asks the route to run. Beside the route it may name the stop of it the re-collection is — the one the office added through `POST /routes/{id}/pickups` (#111), `recollectionPickupId` — which is a stop of that route (400, `Not a pickup of this route`), never named without it (400 at `recollectionPickupId`), and not one that was missed: a skipped or failed stop — the stop the ticket is about among them — is refused (409, `Stop 3 of route RC-1042 is failed; a re-collection names a stop that is planned or collected`). Resolution makes no route and no pickup: the re-collection is Execution's, and the ticket names it. With `recollected` or `serviced`, and only then (400 at `productId` otherwise), the body may name the product the work is charged at (#291 C3): a product of the ticket's project (400, `Not a product of this project`), never one sold by the month (400, `A product sold by the month is a recurring charge; …`), and offered (409, the #79 gate); without one, the project's charge for the ticket's kind stands in (`PUT /ticket-charges`). Finance prices the ticket's event at it. Not idempotent: a second completion is a change a person meant. Under the ticket's row lock. " +
          CLOSED +
          " The `ticket-completed` event is written in the same transaction, carrying the ticket as answered; Finance is its consumer.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The ticket, completed.", Ticket),
          400: describeProblem("The path does not hold an id, or the body is missing the resolution or the note, names a member the command does not take, names a re-collection route with another resolution, a re-collection stop without its route, a route that is not the project's or a stop that is not that route's, or a product with a resolution nothing is charged for, a product that is not the project's or one sold by the month."),
          ...commandProblems("edit"),
          409: describeProblem("The ticket is completed or rejected already, the re-collection route has ended, the re-collection stop was missed, or the product is not offered; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TicketComplete),
      async (c) => {
        const { id } = c.req.valid("param")
        const { resolution, note, recollectionRouteId, recollectionPickupId, productId } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const at = now()
        const { row } = await moved(tx, principal, id, "complete", note, async (current) => {
          const scope = { companyId: principal.companyId, projectId: current.projectId }
          // The product's 400s, then the route's, then the gate on the product: every 400 before a 409 that needs the body.
          const productStatus = productId === undefined ? undefined : await requireTicketWorkProduct(tx, scope, productId)
          if (recollectionRouteId !== undefined) await requireRouteNotEnded(tx, scope, recollectionRouteId, recollectionPickupId)
          refuseUnofferedProduct(productStatus)
          return { resolution, recollectionRouteId: recollectionRouteId ?? null, recollectionPickupId: recollectionPickupId ?? null, chargeProductId: productId ?? null, closedAt: at }
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
          "The `reopen` command: `completed` or `rejected` becomes `open` with the body's note as the `status-changed` event's body, and the closing columns — `resolution`, `recollectionRouteId` with `recollectionPickupId`, `chargeProductId` and `closedAt` — are cleared, since a reopened ticket is open; the closing stands in the history. A ticket that is open in any of the four open statuses answers 200 as it stands, without a write or an event. Under the ticket's row lock.",
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
      "/tickets/:id/evidence",
      describeRoute({
        operationId: "getTicketEvidence",
        summary: "What the stop a ticket is about recorded",
        description:
          "The stop the ticket names (`links.pickupId`), read as one thing for the office and for the reply its customer is sent: the stop's outcome and reason, what it is for (`service`), whether the outcome stands on the office's correction (`corrected`), when it was recorded, where the device stood for it — the latest completion's, skip's or failure's place, the office's correction's where one stands, the arrival's where the outcome recorded none — the proofs taken at the stop, the reply that quotes them on the project's clock, and whether the record alone answers the case (a `missed-collection` whose emptying the driver recorded skipped or failed `not-presented`, never on the office's correction). Read under the ticket's grant, the proofs are told narrowed to what the reply quotes — their kind, door, time, reason, corrected outcome and object key — and never with the device, the account, the session, the driver's note or a weight, which `GET /pickups/{id}` keeps under the stops' grant; a photo's or a signature's bytes are signed for through `GET /pickups/{id}/proof-objects`, under that grant too. `stop` is null for a ticket about no stop.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The stop's evidence, or null.", TicketEvidence),
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
        const answer: TicketEvidence = { stop: await stopEvidenceFor(tx, principal.companyId, row) }
        return c.json(answer)
      },
    )
    .post(
      "/tickets/:id/reply-with-evidence",
      describeRoute({
        operationId: "replyToTicketWithEvidence",
        summary: "Reply to the customer with the stop's record",
        description:
          "One step: a customer-visible `comment` whose body is the reply `GET /tickets/{id}/evidence` writes, the body's `note` after it, and with `complete` the case completed `answered` in the same transaction — the `status-changed` row, `closedAt` and the `ticket-completed` event, as `complete` writes them. Under the ticket's row lock. A ticket about no stop is refused (409, `This ticket names no stop, so no record answers it`); with `complete`, a completed or rejected ticket is refused as `complete` refuses it, while the reply alone is taken on a closed ticket, as a comment is. The reply is recorded, not sent: sending is the communications slice's, and a reply recorded before it is never sent after it. Answers 201 with the ticket's history, and no `Location`, like a comment.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The ticket with its history, the reply its last comment.", TicketDetail),
          400: describeProblem("The path does not hold an id, or the body names a member the command does not take."),
          ...commandProblems("edit"),
          409: describeProblem("The ticket names no stop, or `complete` was asked of a completed or rejected ticket."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TicketReplyWithEvidence),
      async (c) => {
        const { id } = c.req.valid("param")
        const { note, complete } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const at = now()
        const current = await lockedTicket(tx, principal, id)
        const evidence = await stopEvidenceFor(tx, principal.companyId, current)
        if (evidence === null) throw problem(409, { detail: NO_STOP })
        // A completion the machine refuses is a 409, which discards the request's transaction and the reply with it (the guard, auth/principal.ts).
        await recordCustomerReply(tx, { companyId: principal.companyId, projectId: current.projectId, id: current.id }, { status: current.status as TicketStatus, assigneeUserAccountId: current.assigneeUserAccountId }, replyBody(evidence, note), principal.user.id)
        const row = complete ? (await moved(tx, principal, id, "complete", ANSWERED_BY_RECORD, async () => ({ resolution: "answered", recollectionRouteId: null, recollectionPickupId: null, closedAt: at }))).row : current
        if (complete) await emit(tx, principal, { aggregate: "ticket", aggregateId: row.id, kind: "ticket-completed", payload: ticketOf(row), projectId: row.projectId, occurredAt: at })
        return c.json(await detailOf(tx, principal, row), 201)
      },
    )
    .get(
      "/tickets/:id/events",
      describeRoute({
        operationId: "listTicketEvents",
        summary: "One ticket's history",
        description:
          "One page of the ticket's history, oldest first — a cursor over time-ordered ids is a cursor over recording order — each row a snapshot of the status and the assignee after it: the `created` row, every `assigned` and `status-changed` with its note or reason, every `comment` with its body, who may read it and its attachment key. `kind` narrows it to one kind, `visibility` to the rows the office alone may read or to the customer's — `visibility=customer` is the thread the portal reads, and leaves every internal row out; `visibility=service-provider` the thread of the provider that runs the ticket's route. A Service Provider's account reads that thread alone. A ticket of another company, or one outside the caller's reach — its projects, or the tickets about a route a Service Provider's account runs — is a ticket that does not exist here. Hand `nextCursor` back as `cursor` for the next page.",
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
        if ((await findReachedTicket(tx, principal, id)) === undefined) throw noSuchTicket(id)
        const rows = await tx
          .select(eventColumns)
          .from(ticketEvent)
          .where(
            and(
              eq(ticketEvent.companyId, principal.companyId),
              eq(ticketEvent.ticketId, id),
              historyReadable(principal),
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
          "Appends a `comment` to the ticket's history: the `body`, who may read it (`internal`, the office's, unless `customer` is said — the row the portal then reads), and the Storage key of an attachment if one was uploaded. The key is `<companyId>/<ticketId>/<objectId>.<jpg|jpeg|png|webp|pdf>` in the bucket `ticket-attachments`: `<objectId>` is a UUID the client minted for the object before uploading it, and the first two segments are held to this ticket's company and id, so a caller cannot name another tenant's object or another ticket's (400 at `objectKey`, `The attachment key names another company or another ticket`). Taken on a closed ticket too — a note after the fact is a note — and touches the ticket's row not at all: nothing of the case moves, and `updatedAt` stays. Its snapshot, the status and the assignee after it, is read under the ticket's row lock, so a comment and a command on one ticket take turns and the history never shows a comment stamped with a status the row had already left. Answers 201 with the event and no `Location`, like the ledger's commands: a history row has no single-row read (`GET /tickets/{id}/events` is a list), and `Location` names where a row is read. `service-provider` is the thread the office and the Service Provider running the ticket's route read. A Service Provider's account comments on a ticket it reads (as `GET /tickets/{id}` reaches it) in that thread alone — the default is written as it — and `customer` is refused (400), since the office speaks to the customer.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The comment as it was appended.", TicketEvent),
          400: describeProblem("The path does not hold an id, or the body has no `body`, names a member the command does not take, gives an attachment key of the wrong shape, or gives one naming another company or another ticket."),
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
        // The row's lock, though the row is not written: the snapshot below is read under it, so a `start` in flight is waited for and the comment carries the status it wrote, never one the row has left. Read through the reach: a provider comments on the tickets it reads.
        await lockRow(tx, ticket, { companyId: principal.companyId, id })
        const current = await findReachedTicket(tx, principal, id)
        if (current === undefined) throw noSuchTicket(id)
        // A provider's comment is its thread's (the contracts default the visibility to `internal`, which from a provider's account is that thread too); the customer's is the office's to write.
        const fromProvider = providerIdOf(principal) !== null
        if (fromProvider && visibility === "customer") throw invalidRequest("body", [{ path: "visibility", message: OFFICE_SPEAKS_TO_CUSTOMERS }])
        // The key's first two segments are this row's company and ticket; its third is the object's id, a UUID the client minted before the upload, held to its shape by the contracts and to nothing else here. As specified (#109 §7.23) the third segment was the comment's event id, which the server mints, so no client could ever have posted a matching key and only the 400 was reachable; the rule was corrected at integration.
        if (objectKey !== undefined && !objectKey.startsWith(`${principal.companyId}/${current.id}/`)) {
          throw invalidRequest("body", [{ path: "objectKey", message: KEY_NAMES_ANOTHER }])
        }
        const ref = { companyId: principal.companyId, projectId: current.projectId, id: current.id }
        const snapshot = { status: current.status as TicketStatus, assigneeUserAccountId: current.assigneeUserAccountId }
        // A provider's comment is its thread (the contracts refuse it the customer's); a comment the customer reads is a reply, written the one way a reply is (ticket-evidence.ts), where its sending will be.
        const row =
          visibility === "customer" && !fromProvider
            ? await recordCustomerReply(tx, ref, snapshot, body, principal.user.id, objectKey ?? null)
            : await appendTicketEvent(tx, ref, { kind: "comment", ...snapshot, resolution: null, body, visibility: fromProvider ? PROVIDER_THREAD : visibility, objectKey: objectKey ?? null, recordedBy: principal.user.id, sourceEventId: null })
        return c.json(eventOf(row), 201)
      },
    )
}
