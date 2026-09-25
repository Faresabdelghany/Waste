// The Billable Event as the office reads, enters and moves it (Issue #112
// §3, §5; ADR-0003, ADR-0005): "a validated occurrence that is eligible to
// become an invoice line" (CONTEXT.md). `GET /billable-events` lists them —
// every row with its `status`, the reading, and the line that invoiced it —
// `POST /billable-events` enters the office's manual one, `GET
// /billable-events/:id` reads one, and two commands move one: `reprice` runs
// the resolver again over a blocked event and `cancel` stamps a ready or
// blocked one. No patch and no delete: a billable event is written by three
// doors and moved by two commands, never by a form save of the whole record,
// and a priced event is what the customer will be told — a wrong one is
// cancelled and entered again, or credited once invoiced.
//
// The manual create is one of the three doors, the others being the
// consumer's (part B, through the same `recordBillableEvent` in
// routes/billable-writes.ts): an agreement and a product of the project, a
// quantity, a service date, a note, and either the resolver's price —
// `priceDraft`, the list valid on the day, the row that wins, the product's
// VAT, or the block reason that stands in the way — or the person's
// `unitPriceMinor` with an `overrideReason`, the pair the contracts hold. A
// price of one's own still needs what only the rows can say: the agreement's
// currency and the product's rate. So a hand-priced event under a draft
// agreement or a product with no VAT rate is refused (409, naming the row's
// state) rather than blocked, since the table holds a blocked row to carry
// no price and no override reason, and dropping the person's price and
// reason to block the row would lose what they typed; without an override
// the same two states block the row, a fact to keep and reprice later.
//
// Every command takes `lockRow(billable_event)` before it reads, so two
// commands on one event take turns; the event's own state is judged first
// (§3's sentences, one per status), then the body's 400s, then the one
// status gate — a product the body names afresh is offered (#79). `reprice`
// is blocked-only: on a `ready`, `invoiced`, `cancelled` or `reversed` event
// it is 409 in the status's words; a ticket's event takes the `productId` the
// office picked and any other kind refuses one (400); the resolver runs over
// the event's agreement, the product, and the conditions a pickup event
// carries (its route's scheme's planning area, its container's type, its
// fraction on the day, read off the pickup), and the row is written priced or
// with the same block or the next one — `updatedAt` moves, since a reprice
// is the row's history (ADR-0005). An event blocked with `no-subscription`
// has no agreement to price under and answers as it stands. `cancel` stamps a
// ready or a blocked event with the caller, the clock and the office's
// reason; an invoiced or a reversed one is 409, a cancelled one answers 200
// without a write, and a `reversal` is 409 — it is the correction, not a
// charge. Nothing here writes the outbox: no other context acts on a
// recording, a reprice or a cancellation.
//
// Every statement carries the tenant and `inProjects`; the grant is
// `commercial.events`, `view` to read, `create` to enter, `edit` for the two
// commands.
import { BillableEvent, BillableEventCancel, BillableEventCreate, BillableEventListQuery, BillableEventReprice } from "@waste/contracts/billable-events"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { agreement } from "@waste/db/schema/agreements"
import { container } from "@waste/db/schema/containers"
import { pickup, route } from "@waste/db/schema/execution"
import { billableEvent } from "@waste/db/schema/finance"
import { routeScheme } from "@waste/db/schema/route-schemes"
import type { BillableEventLinks } from "@waste/domain/finance/from-event"
import { vatOf } from "@waste/domain/finance/money"
import type { PricedAmounts } from "@waste/domain/finance/pricing"
import type { BillableEventStatus, BlockReason } from "@waste/domain/finance/vocabulary"
import { and, asc, eq, exists, gt, gte, lte, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { agreementFacts, billableEventShapeIssue, priceDraft, productFacts, recordBillableEvent, type ComposedEvent } from "./billable-writes"
import { eventColumns, eventOf, eventScope, eventsFrom, findEvent, noSuchEvent, statusIs, statusOf, UNNAMED, type EventReading } from "./billing-shapes"
import { requireAgreement, requireCustomer, requireProduct, type Scope } from "./references"
import type { ClockOptions } from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, lockRow } from "./shared"
import { refuseUnofferedProduct } from "./statuses"

const MODULE = "commercial.events"

const EventPage = Page(BillableEvent)

/** What a reprice of an event that is not blocked is told, in the status's words. */
export function notRepriced(id: string, status: Exclude<BillableEventStatus, "blocked">): string {
  switch (status) {
    case "ready":
      return `Billable event ${id} is ready; a priced event is not repriced — cancel it and enter it again`
    case "invoiced":
      return `Billable event ${id} is invoiced; correct it with a credit note`
    case "cancelled":
      return `Billable event ${id} is cancelled`
    case "reversed":
      return `Billable event ${id} is reversed`
  }
}

/** What a cancellation of an event a line or a reversal names is told: the same two sentences, since the correction is the same door. */
export const notCancelled = (id: string, status: "invoiced" | "reversed"): string => notRepriced(id, status)

/** What a cancellation of a `reversal` is told. */
export const REVERSAL_NOT_CANCELLED = "A reversal is not cancelled; it is the correction"

/** What a reprice naming a product on anything but a ticket's event is told, at `productId`. */
export const ONLY_A_TICKETS_EVENT_TAKES_A_PRODUCT = "Only a ticket's event takes a product here"

/** What a hand-priced manual event under a draft agreement is told: the row's state, after every 400. */
export const DRAFT_AGREEMENT_BY_HAND = "The agreement is a draft; an event priced by hand needs a signed agreement"

/** What a hand-priced manual event under a product with no VAT rate is told. */
export const NO_VAT_RATE_BY_HAND = "The product has no VAT rate; an event priced by hand needs the product's rate — set it first"

/** A manual event links to nothing. */
const NO_LINKS: BillableEventLinks = { routeId: null, pickupId: null, ticketId: null, reversesEventId: null }

/** The conditions a pickup event carries into the resolver; none on a manual or a ticket event. */
type Conditions = { planningAreaId: string | null; containerTypeId: string | null; wasteFractionId: string | null }
const NO_CONDITIONS: Conditions = { planningAreaId: null, containerTypeId: null, wasteFractionId: null }

/** The five price columns as a write sets them: the frozen price, or the nulls of a block. */
const priceColumns = (price: PricedAmounts | null) => ({
  unitPriceMinor: price?.unitPriceMinor ?? null,
  netMinor: price?.netMinor ?? null,
  vatPercent: price?.vatPercent ?? null,
  vatMinor: price?.vatMinor ?? null,
  currency: price?.currency ?? null,
  priceListRowId: price?.priceListRowId ?? null,
})

/**
 * What a pickup event's occurrence was, read off the pickup: its route's
 * scheme's planning area (the price row's zone), its container's type, its
 * fraction on the day. One statement; a pickup the row names and the table
 * does not have is a broken key, not a client's doing, and is thrown.
 */
async function conditionsOf(tx: Tx, companyId: string, row: EventReading): Promise<Conditions> {
  if (row.pickupId === null || row.routeId === null) return NO_CONDITIONS
  const [found] = await tx
    .select({ planningAreaId: routeScheme.planningAreaId, containerTypeId: container.containerTypeId, wasteFractionId: pickup.wasteFractionId })
    .from(pickup)
    .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
    .innerJoin(routeScheme, and(eq(routeScheme.companyId, route.companyId), eq(routeScheme.id, route.routeSchemeId)))
    .innerJoin(container, and(eq(container.companyId, pickup.companyId), eq(container.id, pickup.containerId)))
    .where(and(eq(pickup.companyId, companyId), eq(pickup.id, row.pickupId), eq(pickup.routeId, row.routeId)))
    .limit(1)
  if (found === undefined) throw new Error(`billable event ${row.id} names pickup ${row.pickupId} of route ${row.routeId}, which is not there`)
  return found
}

/** The events whose agreement is billed to one customer: the payer, through the agreement. */
const payerIs = (tx: Tx, companyId: string, customerId: string) =>
  exists(
    tx
      .select({ one: sql`1` })
      .from(agreement)
      .where(and(eq(agreement.companyId, companyId), eq(agreement.id, billableEvent.agreementId), eq(agreement.payerCustomerId, customerId))),
  )

/** The event the path names, locked and read with its reading: both commands hold a rule the API holds, so they take the row lock first and read afterwards (routes/shared.ts). */
async function lockedEvent(tx: Tx, principal: Principal, id: string): Promise<EventReading> {
  await lockRow(tx, billableEvent, { companyId: principal.companyId, id })
  const current = await findEvent(tx, principal, id)
  if (current === undefined) throw noSuchEvent(id)
  return current
}

const commandProblems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
  404: describeProblem("No billable event with that id in the projects this account works in."),
})

export function billableEventRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/billable-events",
      describeRoute({
        operationId: "listBillableEvents",
        summary: "The billable events of the caller's projects",
        description:
          "One page of billable events, oldest first (ids are time-ordered, so a cursor over them is a cursor over time), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. Every row carries its `status`, a reading and never a column — `blocked` is a block reason, `cancelled` a cancellation stamp, `invoiced` an invoice line naming it (its id in `invoiceLineId`), `reversed` a reversal naming it, `ready` none of those, the later fact winning — and `status` filters by that same reading in SQL. `kind` and `blockReason` are one each; `agreementId`, `productId`, `routeId`, `pickupId` and `ticketId` the events naming that row; `customerId` the payer, through the agreement, held to a customer of this company (400 on the query); `from` and `to` a window of service dates, both inclusive (`to` on or after `from`). Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of billable events.", EventPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, the window runs backwards, `projectId` is not a project this account works in, or `customerId` is not a customer of this company."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", BillableEventListQuery),
      async (c) => {
        const { limit, cursor, projectId, status, kind, blockReason, agreementId, customerId, productId, routeId, pickupId, ticketId, from, to } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        if (customerId !== undefined) await requireCustomer(tx, principal.companyId, customerId, "customerId", "query")
        const { query, line, reversing } = eventsFrom(tx, principal.companyId)
        const rows = await query
          .where(
            and(
              eventScope(principal),
              projectId === undefined ? undefined : eq(billableEvent.projectId, projectId),
              status === undefined ? undefined : statusIs(status, { line, reversing }),
              kind === undefined ? undefined : eq(billableEvent.kind, kind),
              blockReason === undefined ? undefined : eq(billableEvent.blockReason, blockReason),
              agreementId === undefined ? undefined : eq(billableEvent.agreementId, agreementId),
              customerId === undefined ? undefined : payerIs(tx, principal.companyId, customerId),
              productId === undefined ? undefined : eq(billableEvent.productId, productId),
              routeId === undefined ? undefined : eq(billableEvent.routeId, routeId),
              pickupId === undefined ? undefined : eq(billableEvent.pickupId, pickupId),
              ticketId === undefined ? undefined : eq(billableEvent.ticketId, ticketId),
              from === undefined ? undefined : gte(billableEvent.serviceDate, from),
              to === undefined ? undefined : lte(billableEvent.serviceDate, to),
              after === undefined ? undefined : gt(billableEvent.id, after),
            ),
          )
          .orderBy(asc(billableEvent.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(eventOf), limit))
      },
    )
    .post(
      "/billable-events",
      describeRoute({
        operationId: "createBillableEvent",
        summary: "Enter a billable event by hand",
        description:
          "The office's manual event, in a project the caller works in (400 at `projectId` otherwise): a `manual` event under an agreement of the project (400 at `agreementId`, `Not an agreement of this project`) for a product of the project (400 at `productId`, `Not a product of this project`) that is offered — a draft or inactive product is refused (409, `The product is inactive; only an active product can be subscribed to`) — with a `quantity` in the product's unit, the `serviceDate` it is priced and billed on, and a `note`. Priced by the resolver unless the body prices it: the list the agreement is priced under and in force on the day (its own, else the project's default), the row that wins under the agreement's customer's kind and the negotiated rows for that customer, the product's VAT rate — or blocked with the reason that stood in the way (`agreement-draft`, `no-price-list`, `no-price-row`, `no-vat-rate`), a fact to keep and reprice once mended. With `unitPriceMinor` and `overrideReason` — the pair, neither without the other (400 at `overrideReason`) — the person's price stands with no row, in the agreement's currency at the product's rate; a draft agreement (409, `The agreement is a draft; an event priced by hand needs a signed agreement`) or a product with no VAT rate (409, `The product has no VAT rate; an event priced by hand needs the product's rate — set it first`) refuses it, since a blocked row carries no price and the person's word would be lost. The status, the links, the origin and the stamps are the server's. Nothing is published.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The event as recorded, `ready` or `blocked`.", BillableEvent),
          400: describeProblem("The body is missing a field, names a member the server owns, gives a price without its reason or a reason without a price, or names a project, agreement or product the rules above refuse — each at the field that is wrong."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`create\` on \`${MODULE}\`.`),
          409: describeProblem("The product is not offered, or a hand-priced event's agreement is a draft or its product has no VAT rate; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", BillableEventCreate),
      async (c) => {
        const body: BillableEventCreate = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, body.projectId)
        const scope: Scope = { companyId: principal.companyId, projectId: body.projectId }
        // The 400s in body order, then the one gate (routes/statuses.ts).
        await requireAgreement(tx, scope, body.agreementId)
        const productStatus = await requireProduct(tx, scope, body.productId)
        refuseUnofferedProduct(productStatus)
        let price: PricedAmounts | null
        let blockReason: BlockReason | null
        if (body.unitPriceMinor !== undefined) {
          const facts = await agreementFacts(tx, scope, body.agreementId)
          if (facts === undefined) throw new Error(`agreement ${body.agreementId} went between statements`)
          if (facts.status === "draft") throw problem(409, { detail: DRAFT_AGREEMENT_BY_HAND })
          const priced = await productFacts(tx, scope, body.productId)
          if (priced === undefined) throw new Error(`product ${body.productId} went between statements`)
          if (priced.vatPercent === null) throw problem(409, { detail: NO_VAT_RATE_BY_HAND })
          const netMinor = body.unitPriceMinor * body.quantity
          price = { priceListRowId: null, unitPriceMinor: body.unitPriceMinor, netMinor, vatPercent: priced.vatPercent, vatMinor: vatOf(netMinor, priced.vatPercent), currency: facts.currency }
          blockReason = null
        } else {
          const outcome = await priceDraft(tx, scope, { agreementId: body.agreementId, productId: body.productId, quantity: body.quantity, serviceDate: body.serviceDate })
          price = outcome.price
          blockReason = outcome.blockReason
        }
        const { answered } = await recordBillableEvent(tx, {
          companyId: principal.companyId,
          projectId: body.projectId,
          draft: { kind: "manual", serviceDate: body.serviceDate, agreementId: body.agreementId, subscriptionId: null, productId: body.productId, quantity: body.quantity, price, blockReason, links: NO_LINKS },
          overrideReason: body.overrideReason ?? null,
          note: body.note ?? null,
          createdBy: principal.user.id,
          sourceEventId: null,
          newId,
        })
        return created(c, "/billable-events", answered)
      },
    )
    .get(
      "/billable-events/:id",
      describeRoute({
        operationId: "getBillableEvent",
        summary: "One billable event",
        description:
          "One billable event of a project the caller works in, as it now stands, with its `status` read off the row and the two rows that may name it, and `invoiceLineId`, the line that charges for it once a run has put it on one. An event of another company, or of a project this account does not work in, is an event that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The billable event.", BillableEvent),
          400: describeProblem("The path does not hold an id."),
          ...commandProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findEvent(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchEvent(id)
        return c.json(eventOf(row))
      },
    )
    .post(
      "/billable-events/:id/reprice",
      describeRoute({
        operationId: "repriceBillableEvent",
        summary: "Run the resolver again over a blocked event",
        description:
          "The `reprice` command, on a `blocked` event only: the resolver runs again — the list the agreement is priced under and in force on the service date, the row that wins, the product's VAT rate, with the conditions a pickup's event carries (its route's scheme's planning area, its container's type, its fraction on the day) — and the row is written priced, or with the same block or the next one (`no-price-list` mended to `no-price-row`, then to `no-vat-rate`), answering the reading after. A ticket's event, blocked `no-product`, takes the `productId` the office picked — a product of the project (400, `Not a product of this project`) that is offered (409, the #79 gate, since the event is a new reference to it) — and any other kind refuses one (400 at `productId`, `Only a ticket's event takes a product here`). An event blocked `no-subscription` has no agreement to price under and answers as it stands. A `ready` event is refused (409, `Billable event <id> is ready; a priced event is not repriced — cancel it and enter it again`), an `invoiced` one (409, `… is invoiced; correct it with a credit note`), a `cancelled` one (409, `… is cancelled`) and a `reversed` one (409, `… is reversed`). Under the event's row lock; `updatedAt` moves, since a reprice is the row's history. Nothing is published.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The event as it now stands, `ready` or `blocked`.", BillableEvent),
          400: describeProblem("The path does not hold an id, or the body names a member the command does not take, names a product on an event that is not a ticket's, or names a product that is not the project's."),
          ...commandProblems("edit"),
          409: describeProblem("The event is not blocked, or the product named is not offered; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", BillableEventReprice),
      async (c) => {
        const { id } = c.req.valid("param")
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedEvent(tx, principal, id)
        // The row's own state first, as every command judges it.
        const status = statusOf(current)
        if (status !== "blocked") throw problem(409, { detail: notRepriced(id, status) })
        if (body.productId !== undefined && current.kind !== "ticket") throw invalidRequest("body", [{ path: "productId", message: ONLY_A_TICKETS_EVENT_TAKES_A_PRODUCT }])
        const scope: Scope = { companyId: principal.companyId, projectId: current.projectId }
        // A product the body names is a new reference: held to the project (400), then to being offered (409). The stored one is no new reference.
        if (body.productId !== undefined) refuseUnofferedProduct(await requireProduct(tx, scope, body.productId))
        const productId = body.productId ?? current.productId
        // Nothing to price under, or nothing to price: the block stands as it is.
        if (current.agreementId === null) return c.json(eventOf(current))
        const outcome =
          productId === null
            ? { price: null, blockReason: "no-product" as const }
            : await priceDraft(tx, scope, { agreementId: current.agreementId, productId, quantity: current.quantity, serviceDate: current.serviceDate, ...(await conditionsOf(tx, principal.companyId, current)) })
        const after: ComposedEvent = { ...current, productId, blockReason: outcome.blockReason, ...priceColumns(outcome.price), kind: current.kind as ComposedEvent["kind"] }
        const issue = billableEventShapeIssue(after)
        if (issue !== undefined) throw new Error(`billable event ${id}: ${issue}`)
        const [row] = await tx
          .update(billableEvent)
          .set({ productId, blockReason: outcome.blockReason, ...priceColumns(outcome.price) })
          .where(and(eventScope(principal), eq(billableEvent.id, id)))
          .returning(eventColumns)
        if (row === undefined) throw noSuchEvent(id)
        // A blocked event had no line and no reversal naming it, and a reprice makes neither.
        return c.json(eventOf({ ...row, ...UNNAMED }))
      },
    )
    .post(
      "/billable-events/:id/cancel",
      describeRoute({
        operationId: "cancelBillableEvent",
        summary: "Cancel a ready or blocked event",
        description:
          "The `cancel` command: a `ready` or a `blocked` event is stamped with the caller, the request's clock and the office's `reason` — `duplicate`, `not-delivered` or `other`; `pickup-corrected` is the consumer's and is refused — and the body's `note`, when given, replaces the event's. There is nothing to invoice on a blocked event either, so it is cancelled too. An `invoiced` event is refused (409, `Billable event <id> is invoiced; correct it with a credit note`), as is a `reversed` one (409, `… is reversed`); a `cancelled` one answers 200 as it stands, without a write; and a `reversal` is refused whatever its status (409, `A reversal is not cancelled; it is the correction`). Under the event's row lock; `updatedAt` moves. Nothing is published.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The event, cancelled.", BillableEvent),
          400: describeProblem("The path does not hold an id, or the body is missing the reason, names the consumer's reason, or names a member the command does not take."),
          ...commandProblems("edit"),
          409: describeProblem("The event is invoiced or reversed, or is a reversal; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", BillableEventCancel),
      async (c) => {
        const { id } = c.req.valid("param")
        const { reason, note } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedEvent(tx, principal, id)
        if (current.kind === "reversal") throw problem(409, { detail: REVERSAL_NOT_CANCELLED })
        const status = statusOf(current)
        if (status === "invoiced" || status === "reversed") throw problem(409, { detail: notCancelled(id, status) })
        if (status === "cancelled") return c.json(eventOf(current))
        const [row] = await tx
          .update(billableEvent)
          .set({ cancelledAt: now(), cancelledBy: principal.user.id, cancelReason: reason, note: note ?? current.note })
          .where(and(eventScope(principal), eq(billableEvent.id, id)))
          .returning(eventColumns)
        if (row === undefined) throw noSuchEvent(id)
        return c.json(eventOf({ ...row, ...UNNAMED }))
      },
    )
}
