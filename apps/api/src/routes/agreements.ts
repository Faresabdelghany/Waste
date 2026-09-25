// What a Customer is entitled to, and until when (Issue #78, ADR-0005).
// `GET /agreements` lists them, `POST /agreements` writes one,
// `GET`/`PATCH /agreements/:id` read and amend one, and a subscription hangs
// off the agreement it belongs to: `GET`/`POST /agreements/:id/subscriptions`
// and `GET`/`PATCH /subscriptions/:id`. No delete anywhere: an agreement is
// terminated by giving it a `validTo`, which is what a period is for, and the
// audit log is its history.
//
// These are the first effective-dated resources the API answers, so three
// things are new here and will be the same in every family that follows.
//
// The period replaces a status. "Pending", "expiring", "expired" and
// "terminated" are readings of `validFrom`/`validTo` against a day, and
// `?validOn=` is how a caller asks for one (@waste/db/query/valid-on). The
// `status` column that is here says something else — whether the agreement is
// a draft, signed or cancelled — and cannot say when.
//
// Two of the same thing at once are refused by the database. `number` is
// deliberately not unique per company: one agreement of a number may be valid
// at a time, so `AGR-2408` may name a later agreement once the earlier one
// has ended, and that is an exclusion constraint (23P01) and not a unique
// one. `refuseOverlap` turns the two this module can foresee into the
// sentence a person reads — one for a number, one for the same product at the
// same place under one agreement.
//
// A period lies inside its parent's, and that is ours to hold: Postgres
// cannot say it across rows without a trigger. It is two rules, not one
// (routes/periods.ts) — a child that moves outside is a 400 naming the bound,
// since the caller chose it; a parent that shortens under its children is a
// 409 counting them, since the rows in the way are not in the body and have
// to be ended first. An agreement's children are its subscriptions and a
// subscription's are its placements, so a subscription's patch answers both.
//
// A status gates a new reference and never an existing one (routes/statuses.ts,
// Issue #79): the customer an agreement names, as holder or as payer, is
// active, the product a subscription names is active and its place is served
// — a property active, a point open or restricted — each refused otherwise
// with a 409 naming the state, after every 400 the route has. The agreements
// and subscriptions already made stand whatever their rows do afterwards, and
// a patch re-stating the customer the agreement already carries names nothing
// new. A subscription's patch names neither its product nor its place, so it
// has nothing to gate.
//
// The rest is the shape every project-scoped Registry family has: each
// statement carries the tenant and `inProjects` (auth/projects.ts), a create
// names a project the caller works in and a record never moves between
// projects. A subscription names neither its agreement nor its project — the
// path says the first and the agreement says the second — and its place is a
// Property or a Shared Collection Point, which the contracts hold to exactly
// one of and the database keys on through a generated column that stays off
// the wire.
//
// The grant is `customers.agreements` throughout, subscriptions included: a
// subscription is a line of an agreement and not a surface of its own.
import {
  Agreement,
  AgreementCreate,
  AgreementListQuery,
  AgreementPatch,
  Subscription,
  SubscriptionCreate,
  SubscriptionListQuery,
  SubscriptionPatch,
  type AgreementStatus,
  type BillingCadence,
} from "@waste/contracts/agreements"
import type { CustomerStatus } from "@waste/contracts/customers"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { containerServicePlacement } from "@waste/db/schema/containers"
import { count } from "@waste/domain/text"
import { and, asc, eq, gt, or } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { notWithin, periodAfter, periodOf, refuseStranded, requireOrdered, requireWithin, type Period } from "./periods"
import { requireCustomer, requirePriceList, requireProduct, requireProperty, requireSharedCollectionPoint, type Scope } from "./references"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseOverlap, stampsOf } from "./shared"
import { placeOf, refuseInactiveCustomer, refuseUnofferedProduct, refuseUnservedPlace, type Party } from "./statuses"

const MODULE = "customers.agreements"
const AgreementPage = Page(Agreement)
const SubscriptionPage = Page(Subscription)

const columns = {
  id: agreement.id,
  projectId: agreement.projectId,
  number: agreement.number,
  customerId: agreement.customerId,
  payerCustomerId: agreement.payerCustomerId,
  status: agreement.status,
  billingCadence: agreement.billingCadence,
  currency: agreement.currency,
  notes: agreement.notes,
  // The list the agreement is priced under (Issue #112): read here; the create and the patch hold it to a list of the project in the agreement's currency from slice 3 on.
  priceListId: agreement.priceListId,
  validFrom: agreement.validFrom,
  validTo: agreement.validTo,
  createdAt: agreement.createdAt,
  updatedAt: agreement.updatedAt,
}

type Row = Pick<typeof agreement.$inferSelect, keyof typeof columns>

/** The row on the wire. The two coded fields are text with a CHECK in the database and an enum here; the vocabulary holds the two in lockstep. */
function agreementOf(row: Row): Agreement {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    customerId: row.customerId,
    payerCustomerId: row.payerCustomerId,
    status: row.status as AgreementStatus,
    billingCadence: row.billingCadence as BillingCadence,
    currency: row.currency,
    notes: row.notes,
    priceListId: row.priceListId,
    validFrom: row.validFrom,
    validTo: row.validTo,
    ...stampsOf(row),
  }
}

const subscriptionColumns = {
  id: subscription.id,
  projectId: subscription.projectId,
  agreementId: subscription.agreementId,
  productId: subscription.productId,
  propertyId: subscription.propertyId,
  sharedCollectionPointId: subscription.sharedCollectionPointId,
  quantity: subscription.quantity,
  validFrom: subscription.validFrom,
  validTo: subscription.validTo,
  createdAt: subscription.createdAt,
  updatedAt: subscription.updatedAt,
}

type SubscriptionRow = Pick<typeof subscription.$inferSelect, keyof typeof subscriptionColumns>

/** The row on the wire. `location_id`, the generated column the exclusion constraint keys on, is the database's device and is not here. */
function subscriptionOf(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    projectId: row.projectId,
    agreementId: row.agreementId,
    productId: row.productId,
    propertyId: row.propertyId,
    sharedCollectionPointId: row.sharedCollectionPointId,
    quantity: row.quantity,
    validFrom: row.validFrom,
    validTo: row.validTo,
    ...stampsOf(row),
  }
}

/** `EXCLUDE USING gist (company_id, number, daterange)`: one agreement of a number is valid at a time, and the next may follow it. */
const NUMBER_RUNNING = "agreement_no_overlap"
const numberRunning = (number: string) => `An agreement numbered ${number} is already valid over part of that period`

/** `EXCLUDE USING gist (company_id, agreement_id, product_id, location_id, daterange)`: one product at one place under one agreement at a time. */
const PLACE_SUBSCRIBED = "subscription_no_overlap"
const PLACE_SUBSCRIBED_SENTENCE = "The agreement already subscribes to that product at that place over part of that period"

/** What a bound outside the parent's period is told, on the create and on the patch alike. */
const OUTSIDE_AGREEMENT = "Outside the agreement's period"

/** "it" or "them": the sentence has just counted the rows, so the pronoun follows the count. */
const them = (rows: number) => (rows === 1 ? "it" : "them")

/** What a period a child does not fit inside is refused with; the rows in the way are not in the body, so the caller ends them first — a placement through the ledger's commands, since a form does not end one (Issue #101). */
const strandedSubscriptions = (rows: number) => `${count(rows, "subscription")} would fall outside the agreement's period; end ${them(rows)} first`
const strandedPlacements = (rows: number) =>
  `${count(rows, "placement")} would fall outside the subscription's period; end ${them(rows)} first through the container's return or decommission`

const noSuchAgreement = (id: string) => problem(404, { detail: `No agreement ${id} in the projects this account works in` })
const noSuchSubscription = (id: string) => problem(404, { detail: `No subscription ${id} in the projects this account works in` })

/** The rows of this company, in the projects the caller works in: what every agreement statement is bounded by. */
const scope = (principal: Principal) => and(eq(agreement.companyId, principal.companyId), inProjects(agreement.projectId, principal))

/** The same for a subscription, which carries the project its agreement is in. */
const subscriptionScope = (principal: Principal) =>
  and(eq(subscription.companyId, principal.companyId), inProjects(subscription.projectId, principal))

/** One agreement of this company by id, inside the caller's projects; undefined when it is neither. */
async function findAgreement(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(agreement)
    .where(and(scope(principal), eq(agreement.id, id)))
    .limit(1)
  return row
}

/**
 * One subscription, with the period of the agreement it hangs on: a patch has
 * to hold the new period inside that one and the join is already there, so it
 * is one statement rather than the row and then its parent.
 */
async function findSubscription(
  tx: Tx,
  principal: Principal,
  id: string,
): Promise<(SubscriptionRow & { agreement: Period }) | undefined> {
  const [row] = await tx
    .select({ ...subscriptionColumns, agreementValidFrom: agreement.validFrom, agreementValidTo: agreement.validTo })
    .from(subscription)
    .innerJoin(
      agreement,
      and(eq(agreement.companyId, subscription.companyId), eq(agreement.id, subscription.agreementId)),
    )
    .where(and(subscriptionScope(principal), eq(subscription.id, id)))
    .limit(1)
  if (row === undefined) return undefined
  const { agreementValidFrom, agreementValidTo, ...held } = row
  return { ...held, agreement: { validFrom: agreementValidFrom, validTo: agreementValidTo } }
}

/** A child table of an effective-dated record: the tenant, the period, and the column naming the parent. */
type ChildTable = PgTable & { companyId: PgColumn; validFrom: PgColumn; validTo: PgColumn }

/**
 * The `where` of the children a parent's move would strand, for
 * `refuseStranded` (routes/periods.ts): this company's rows of the parent
 * whose period leaves the new one. Both parents here ask it — an agreement of
 * its subscriptions, a subscription of its placements — so it is spelled
 * once; the count and the 409 are the shared helper's.
 */
const strandedChildren = (table: ChildTable, parentColumn: PgColumn, parent: { companyId: string; id: string }, period: Period) =>
  and(eq(table.companyId, parent.companyId), eq(parentColumn, parent.id), notWithin(table, period))

/** The status of the customer each field names, as `partyStatuses` answers it. */
type Parties = Readonly<Record<Party, CustomerStatus | undefined>>

/**
 * The customer an agreement names, as holder and as payer, looked up once
 * when both fields name the same customer, which is the common case. Each
 * lookup is the 400 for an id that is not there (routes/references.ts), and
 * the statuses come back for the gate the route runs after its other 400s
 * (`refuseInactiveParties`). An id not named is not looked up.
 */
async function partyStatuses(tx: Tx, companyId: string, customerId: string | undefined, payerCustomerId: string | undefined): Promise<Parties> {
  const customer = await requireCustomer(tx, companyId, customerId, "customerId")
  const payer = payerCustomerId === customerId ? customer : await requireCustomer(tx, companyId, payerCustomerId, "payerCustomerId")
  return { customerId: customer, payerCustomerId: payer }
}

/** The customer gate over both fields: each an inactive customer is refused in its own sentence (routes/statuses.ts). */
function refuseInactiveParties(parties: Parties): void {
  refuseInactiveCustomer(parties.customerId, "customerId")
  refuseInactiveCustomer(parties.payerCustomerId, "payerCustomerId")
}

/**
 * The id a patch carries where it differs from the stored one. A patch that
 * re-states the customer the agreement already has names nothing new, so it
 * is neither looked up nor gated: a client sending the record whole is not
 * refused for a customer that has since gone inactive.
 */
const changed = (named: string | undefined, stored: string): string | undefined => (named === stored ? undefined : named)

/** What an agreement naming a list in another currency is refused with, at `priceListId` (Issue #112 §3). */
export const listCurrencyDiffers = (list: string, agreement: string): string => `The price list is in ${list}; the agreement is billed in ${agreement}`

/**
 * The Price List an agreement is priced under (Issue #112): a list of the
 * agreement's project (routes/references.ts, 400 on `priceListId`) in the
 * agreement's currency — "The price list is in EUR; the agreement is billed
 * in DKK" — so every event under the agreement is in its currency by
 * construction and a billing run never converts. Null or absent is the
 * project's default list, whose currency is the project's, and names nothing
 * to check.
 */
async function requireAgreementList(tx: Tx, within: Scope, priceListId: string | null | undefined, currency: string): Promise<void> {
  const list = await requirePriceList(tx, within, priceListId)
  if (list !== undefined && list.currency !== currency) throw invalidRequest("body", [{ path: "priceListId", message: listCurrencyDiffers(list.currency, currency) }])
}

export function agreementRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/agreements",
      describeRoute({
        operationId: "listAgreements",
        summary: "The agreements the caller's projects hold",
        description:
          "One page of agreements, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `customerId` answers the agreements that customer holds or pays for, since the payer is a customer in their own right. `number` is exact: a number may name more than one agreement over time, one valid at a time. `validOn` asks for the agreements in force on that day, `validFrom` inclusive and `validTo` exclusive, which is how \"running\", \"expired\" and \"pending\" are asked for. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of agreements.", AgreementPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.agreements`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", AgreementListQuery),
      async (c) => {
        const { limit, cursor, projectId, customerId, number, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(columns)
          .from(agreement)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(agreement.projectId, projectId),
              customerId === undefined ? undefined : or(eq(agreement.customerId, customerId), eq(agreement.payerCustomerId, customerId)),
              number === undefined ? undefined : eq(agreement.number, number),
              day === undefined ? undefined : validOn(agreement, day),
              after === undefined ? undefined : gt(agreement.id, after),
            ),
          )
          .orderBy(asc(agreement.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(agreementOf), limit))
      },
    )
    .post(
      "/agreements",
      describeRoute({
        operationId: "createAgreement",
        summary: "Write an agreement",
        description:
          "Writes an agreement in one project, which must be a project the caller works in. The customer and the payer are customers of this company — the same one in the common case, a housing administrator in the interesting one — and must be active in both fields: an inactive one is refused (409) in a sentence saying whether as holder or as payer, while the agreements a customer already holds stand when it goes inactive, since a status gates a new reference and never an existing one. The status defaults to `draft`, since an agreement is written before it is signed, and the period is half-open: `validFrom` is the first day in force and `validTo` the first day out of it, absent meaning the agreement is still running. The number is not unique: one agreement of a number may be valid at a time, so a number may name a later agreement once the earlier one has ended, and an overlapping one is refused. `priceListId` is the price list the agreement is priced under — a list of the project, in the agreement's currency (400 on `priceListId`, `The price list is in EUR; the agreement is billed in DKK`); absent or null, the agreement is priced under the project's default list. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The agreement as it was written.", Agreement),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, names a project this account does not work in, ends on or before the day it starts, names a customer or payer that is not this company's, or names a price list that is not the project's or is in another currency than the agreement's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `customers.agreements`."),
          409: describeProblem("An agreement of that number is already valid over part of that period, or the customer, as holder or as payer, is inactive."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", AgreementCreate),
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        const parties = await partyStatuses(tx, principal.companyId, values.customerId, values.payerCustomerId)
        await requireAgreementList(tx, { companyId: principal.companyId, projectId: values.projectId }, values.priceListId, values.currency)
        refuseInactiveParties(parties)
        const [row] = await refuseOverlap({ [NUMBER_RUNNING]: numberRunning(values.number) }, () =>
          tx
            .insert(agreement)
            .values({ ...values, id: newId(), companyId: principal.companyId })
            .returning(columns),
        )
        return created(c, "/agreements", agreementOf(row))
      },
    )
    .get(
      "/agreements/:id",
      describeRoute({
        operationId: "getAgreement",
        summary: "One agreement",
        description:
          "One agreement of a project the caller works in. An agreement of another company, or of a project this account does not work in, is an agreement that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The agreement.", Agreement),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.agreements`."),
          404: describeProblem("No agreement with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findAgreement(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchAgreement(id)
        return c.json(agreementOf(row))
      },
    )
    .patch(
      "/agreements/:id",
      describeRoute({
        operationId: "patchAgreement",
        summary: "Amend an agreement",
        description:
          "Amends one agreement of a project the caller works in; every field is optional and at least one must be given. Amending changes the row and the audit log is the history. The project is not patchable, since a record does not move between projects. A customer the patch newly names, as holder or as payer, must be active (409, saying which); re-stating the customer the agreement already carries names nothing new, so a patch sending the record whole is taken after its customer has gone inactive. Moving the period is held to two rules: the end still comes after the start, which a body naming one bound cannot see by itself, and the new period still contains every subscription of the agreement — a shortening that would strand one is refused (409) and the subscriptions have to be ended first. A period that overlaps another agreement of the same number is refused too. `priceListId` moves the agreement onto a price list of the project in the agreement's currency, or back to the project's default list with null; a list or a currency the patch changes is held to the other (400 on `priceListId`).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The agreement as it now stands.", Agreement),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (the project included), ends on or before the day it starts, names a customer or payer that is not this company's, or names a price list that is not the project's or is in another currency than the agreement's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `customers.agreements`."),
          404: describeProblem("No agreement with that id in the projects this account works in."),
          409: describeProblem("Subscriptions of the agreement would fall outside the new period, another agreement of that number is already valid over part of it, or the customer the patch newly names, as holder or as payer, is inactive."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", AgreementPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The row this patch counts children against, locked before it is
        // read: a shortening and a subscription being added to it are the
        // two halves of one rule, and they serialise here (routes/shared.ts).
        await lockRow(tx, agreement, { companyId: principal.companyId, id })
        const current = await findAgreement(tx, principal, id)
        if (current === undefined) throw noSuchAgreement(id)
        const parties = await partyStatuses(
          tx,
          principal.companyId,
          changed(patch.customerId, current.customerId),
          changed(patch.payerCustomerId, current.payerCustomerId),
        )
        const period = patch.validFrom !== undefined || patch.validTo !== undefined ? periodAfter(current, patch) : undefined
        if (period !== undefined) requireOrdered(period)
        // The list the patch leaves the agreement priced under, in the currency it leaves it billed in: judged when either moved, so a currency changed under a stored list is refused too.
        if (patch.priceListId !== undefined || patch.currency !== undefined) {
          await requireAgreementList(tx, { companyId: principal.companyId, projectId: current.projectId }, patch.priceListId === undefined ? current.priceListId : patch.priceListId, patch.currency ?? current.currency)
        }

        // Every 400 above, every 409 below (routes/statuses.ts).
        refuseInactiveParties(parties)
        if (period !== undefined) {
          await refuseStranded(tx, subscription, strandedChildren(subscription, subscription.agreementId, { companyId: principal.companyId, id }, period), strandedSubscriptions)
        }

        const [row] = await refuseOverlap({ [NUMBER_RUNNING]: numberRunning(patch.number ?? current.number) }, () =>
          tx
            .update(agreement)
            .set(patch)
            .where(and(scope(principal), eq(agreement.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchAgreement(id)
        return c.json(agreementOf(row))
      },
    )
    .get(
      "/agreements/:id/subscriptions",
      describeRoute({
        operationId: "listAgreementSubscriptions",
        summary: "One agreement's subscriptions",
        description:
          "One page of the agreement's subscriptions, oldest first (ids are time-ordered). The path says the agreement, so the only filter is `validOn`: the subscriptions in force on that day, `validFrom` inclusive and `validTo` exclusive. An agreement of another company, or of a project this account does not work in, is an agreement that does not exist here. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the agreement's subscriptions.", SubscriptionPage),
          400: describeProblem("The path does not hold an id, the page size is outside 1..200, the cursor is not one this API wrote, or `validOn` is not a calendar day."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.agreements`."),
          404: describeProblem("No agreement with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", SubscriptionListQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit, cursor, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if ((await findAgreement(tx, principal, id)) === undefined) throw noSuchAgreement(id)
        const rows = await tx
          .select(subscriptionColumns)
          .from(subscription)
          .where(
            and(
              subscriptionScope(principal),
              eq(subscription.agreementId, id),
              day === undefined ? undefined : validOn(subscription, day),
              after === undefined ? undefined : gt(subscription.id, after),
            ),
          )
          .orderBy(asc(subscription.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(subscriptionOf), limit))
      },
    )
    .post(
      "/agreements/:id/subscriptions",
      describeRoute({
        operationId: "createSubscription",
        summary: "Subscribe an agreement to a product at a place",
        description:
          "Adds one product delivered at one place under the agreement the path names. The agreement says the project, so the body names neither: the product and the place must both be that project's. The place is exactly one of `propertyId` and `sharedCollectionPointId`; either may be sent as null, which is a place not given. The product must be active and the place served — a property active, a point open or restricted — each refused otherwise (409) in a sentence naming the status it has; the subscriptions already made stand when a product is withdrawn or a place closes, since a status gates a new reference and never an existing one. The quantity defaults to one. The period lies inside the agreement's — a `validFrom` before it, or an end beyond it or absent where the agreement has one, is refused naming the bound — and the agreement may not already subscribe to that product at that place over part of it. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The subscription as it was written.", Subscription),
          400: describeProblem(
            "The path does not hold an id, or the body is missing a field, names a member the server owns, names other than one place, ends on or before the day it starts, falls outside the agreement's period, or names a product or a place that is not this agreement's project's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `customers.agreements`."),
          404: describeProblem("No agreement with that id in the projects this account works in."),
          409: describeProblem("The agreement already subscribes to that product at that place over part of that period, or the product is draft or inactive, or the place is not served: an inactive property, or a draft or closed point."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", SubscriptionCreate),
      async (c) => {
        const { id } = c.req.valid("param")
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The agreement this subscription is held inside, locked before it
        // is read, so a patch shortening it cannot commit between the two.
        await lockRow(tx, agreement, { companyId: principal.companyId, id })
        const parent = await findAgreement(tx, principal, id)
        if (parent === undefined) throw noSuchAgreement(id)
        const within = { companyId: principal.companyId, projectId: parent.projectId }
        const productStatus = await requireProduct(tx, within, values.productId)
        const propertyStatus = await requireProperty(tx, within, values.propertyId)
        const pointStatus = await requireSharedCollectionPoint(tx, within, values.sharedCollectionPointId)
        requireWithin(parent, periodOf(values), OUTSIDE_AGREEMENT)

        // Every 400 above, every 409 below (routes/statuses.ts).
        refuseUnofferedProduct(productStatus)
        refuseUnservedPlace(placeOf(propertyStatus, pointStatus), "subscription")

        const [row] = await refuseOverlap({ [PLACE_SUBSCRIBED]: PLACE_SUBSCRIBED_SENTENCE }, () =>
          tx
            .insert(subscription)
            .values({
              ...values,
              id: newId(),
              companyId: principal.companyId,
              projectId: parent.projectId,
              agreementId: parent.id,
              propertyId: values.propertyId ?? null,
              sharedCollectionPointId: values.sharedCollectionPointId ?? null,
            })
            .returning(subscriptionColumns),
        )
        return created(c, "/subscriptions", subscriptionOf(row))
      },
    )
    .get(
      "/subscriptions/:id",
      describeRoute({
        operationId: "getSubscription",
        summary: "One subscription",
        description:
          "One subscription of a project the caller works in. A subscription of another company, or of a project this account does not work in, is a subscription that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The subscription.", Subscription),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.agreements`."),
          404: describeProblem("No subscription with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findSubscription(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchSubscription(id)
        return c.json(subscriptionOf(row))
      },
    )
    .patch(
      "/subscriptions/:id",
      describeRoute({
        operationId: "patchSubscription",
        summary: "Change a subscription",
        description:
          "Changes the quantity or the period of one subscription; every field is optional and at least one must be given. The product and the place do not change: a subscription that moves is a subscription that ended and another that began, which is what the period is for. A new period is held to three rules — the end still comes after the start, it still lies inside the agreement's (400 naming the bound), and it still contains every placement of the subscription, an open placement included, a shortening that would strand one being refused (409) so the containers are returned or decommissioned first, which is how a placement ends (`POST /containers/{id}/return`, `/decommission`) — and it may not overlap another subscription of the same product at the same place under the agreement.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The subscription as it now stands.", Subscription),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (the product and the place included), ends on or before the day it starts, or falls outside the agreement's period.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `customers.agreements`."),
          404: describeProblem("No subscription with that id in the projects this account works in."),
          409: describeProblem("Placements of the subscription would fall outside the new period (end them through the container's return or decommission first), or the agreement already subscribes to that product at that place over part of it."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", SubscriptionPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        let current = await findSubscription(tx, principal, id)
        if (current === undefined) throw noSuchSubscription(id)

        if (patch.validFrom !== undefined || patch.validTo !== undefined) {
          // This patch is both a child of its agreement and the parent of
          // its placements, so it takes both row locks — top down, the
          // agreement first — and reads again underneath them, since the
          // read above only said which agreement to lock.
          await lockRow(tx, agreement, { companyId: principal.companyId, id: current.agreementId })
          await lockRow(tx, subscription, { companyId: principal.companyId, id })
          current = await findSubscription(tx, principal, id)
          if (current === undefined) throw noSuchSubscription(id)

          const period = periodAfter(current, patch)
          requireWithin(current.agreement, period, OUTSIDE_AGREEMENT)
          await refuseStranded(
            tx,
            containerServicePlacement,
            strandedChildren(containerServicePlacement, containerServicePlacement.subscriptionId, { companyId: principal.companyId, id }, period),
            strandedPlacements,
          )
        }

        const [row] = await refuseOverlap({ [PLACE_SUBSCRIBED]: PLACE_SUBSCRIBED_SENTENCE }, () =>
          tx
            .update(subscription)
            .set(patch)
            .where(and(subscriptionScope(principal), eq(subscription.id, id)))
            .returning(subscriptionColumns),
        )
        if (row === undefined) throw noSuchSubscription(id)
        return c.json(subscriptionOf(row))
      },
    )
}
