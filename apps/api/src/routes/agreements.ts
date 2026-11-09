// What a Customer is entitled to, and until when (Issue #78, ADR-0005).
// `GET /agreements` lists them, `POST /agreements` writes one,
// `GET`/`PATCH /agreements/:id` read and amend one, and a subscription hangs
// off the agreement it belongs to: `GET`/`POST /agreements/:id/subscriptions`
// and `GET`/`PATCH /subscriptions/:id`. No delete anywhere: an agreement is
// terminated by giving it a `validTo`, which is what a period is for, and the
// audit log is its history. Two commands do in one request what the periods
// alone take several for (#291, slice 10): `POST /subscriptions/:id/change`
// ends a subscription on a day and writes the one replacing it there, its
// containers handed on to it, and `POST /agreements/:id/terminate` ends the
// agreement, its subscriptions and their placements together on a day. A
// container stays in service through both — nothing moved, or the bin stays
// until someone removes it — so neither writes a stock movement, and a return
// closes whichever placement is in force (routes/lifecycle.ts). A termination
// asks generation runs of the schemes whose planned routes stop at its
// containers and names the stops no run will take away.
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
// to be ended first. An agreement's children are its subscriptions and the
// business credentials charged to it, a subscription's its placements and
// its pauses, each declared once (@waste/db/commands/agreement-periods), so
// a subscription's patch answers both sides and a termination ends them all.
//
// A status gates a new reference and never an existing one (@waste/domain/status-gates,
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
// subscription is a line of an agreement and not a surface of its own. The
// four writes are the exported functions above `agreementRoutes`, which the
// CSV import runs too.
import {
  Agreement,
  AgreementCreate,
  AgreementListQuery,
  AgreementPatch,
  Subscription,
  SubscriptionCreate,
  SubscriptionListQuery,
  SubscriptionPatch,
  SubscriptionsQuery,
  AgreementTerminated,
  AgreementTermination,
  SubscriptionChange,
} from "@waste/contracts/agreements"
import type { CustomerStatus } from "@waste/contracts/customers"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { agreement, subscription, subscriptionPause } from "@waste/db/schema/agreements"
import { placeOf, refuseUnservedPlace } from "@waste/domain/registry/served-places"
import { refuseInactiveCustomer, type Party } from "@waste/domain/registry/agreements"
import { refuseUnofferedProduct } from "@waste/domain/registry/catalogue"
import { and, asc, eq, gt, isNull, or } from "drizzle-orm"
import { newId } from "@waste/db/ids"
import { AGREEMENT_CHILDREN, carryPlacements, endAgreementHoldingsOn, endSubscriptionsOn, servingOn, SUBSCRIPTION_CHILDREN } from "@waste/db/commands/agreement-periods"
import { refuseStrandedChildren, runsPast } from "@waste/db/commands/periods"
import { lockRow, refuseOverlap } from "@waste/db/commands/shared"
import { pauseSubscription } from "@waste/db/commands/subscription-pauses"
import { stampsOf } from "@waste/db/shapes/times"

import type { Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import type { RouteDeps } from "../deps"
import { routes } from "../operation"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem } from "../problem"
import { periodAfter, periodOf, requireOrdered, requireWithin, type Period } from "./periods"
import { requireCustomer, requirePriceList, requireProduct, requireProperty, requireSharedCollectionPoint, type Scope } from "./references"
import { created, describeCreated, describeJson, IdParam } from "./shared"
import { askRuns, stopsLeft } from "./service-ends"
import { serviceWindowOf, serviceWindowValues } from "./time-windows"

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
  // The list the agreement is priced under (Issue #112): read here; the create and the patch hold it to a list of the project in the agreement's currency.
  priceListId: agreement.priceListId,
  serviceWindowStart: agreement.serviceWindowStart,
  serviceWindowEnd: agreement.serviceWindowEnd,
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
    status: row.status,
    billingCadence: row.billingCadence,
    currency: row.currency,
    notes: row.notes,
    priceListId: row.priceListId,
    serviceWindow: serviceWindowOf(row),
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

/** One agreement of the caller's projects as the wire carries it; undefined for one they do not reach. */
export async function readAgreement(tx: Tx, principal: Principal, id: string): Promise<Agreement | undefined> {
  const row = await findAgreement(tx, principal, id)
  return row === undefined ? undefined : agreementOf(row)
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

/** One subscription of the caller's projects as the wire carries it; undefined for one they do not reach. */
export async function readSubscription(tx: Tx, principal: Principal, id: string): Promise<Subscription | undefined> {
  const row = await findSubscription(tx, principal, id)
  if (row === undefined) return undefined
  const { agreement: _period, ...held } = row
  return subscriptionOf(held)
}

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

/** The customer gate over both fields: each an inactive customer is refused in its own sentence (@waste/domain/status-gates). */
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

// The writes, the one spelling these routes and the CSV import (#291 slice 12)
// run, so an imported agreement is held to every rule a form's is. Each takes
// the request's transaction, or a savepoint of it, and the caller; the grant
// is the caller's to have checked.

/** Writes an agreement in one of the caller's projects. */
export async function createAgreement(tx: Tx, principal: Principal, body: AgreementCreate): Promise<Agreement> {
  const { serviceWindow, ...values } = body
  requireProject(principal, values.projectId)
  const parties = await partyStatuses(tx, principal.companyId, values.customerId, values.payerCustomerId)
  await requireAgreementList(tx, { companyId: principal.companyId, projectId: values.projectId }, values.priceListId, values.currency)
  refuseInactiveParties(parties)
  const [row] = await refuseOverlap({ [NUMBER_RUNNING]: numberRunning(values.number) }, () =>
    tx
      .insert(agreement)
      .values({ ...values, ...serviceWindowValues(serviceWindow), id: newId(), companyId: principal.companyId })
      .returning(columns),
  )
  return agreementOf(row)
}

/** Amends one agreement of the caller's projects; a 404 for one they do not reach. */
export async function patchAgreement(tx: Tx, principal: Principal, id: string, body: AgreementPatch): Promise<Agreement> {
  const { serviceWindow, ...patch } = body
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

  // Every 400 above, every 409 below (@waste/domain/status-gates).
  refuseInactiveParties(parties)
  if (period !== undefined) await refuseStrandedChildren(tx, AGREEMENT_CHILDREN, { companyId: principal.companyId, id }, period)

  const [row] = await refuseOverlap({ [NUMBER_RUNNING]: numberRunning(patch.number ?? current.number) }, () =>
    tx
      .update(agreement)
      .set({ ...patch, ...serviceWindowValues(serviceWindow) })
      .where(and(scope(principal), eq(agreement.id, id)))
      .returning(columns),
  )
  if (row === undefined) throw noSuchAgreement(id)
  return agreementOf(row)
}

/** Writes a subscription on one agreement of the caller's projects; a 404 for an agreement they do not reach. */
export async function createSubscription(tx: Tx, principal: Principal, id: string, values: SubscriptionCreate): Promise<Subscription> {
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

  // Every 400 above, every 409 below (@waste/domain/status-gates).
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
  return subscriptionOf(row)
}

/** Amends one subscription of the caller's projects; a 404 for one they do not reach. */
export async function patchSubscription(tx: Tx, principal: Principal, id: string, patch: SubscriptionPatch): Promise<Subscription> {
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
    await refuseStrandedChildren(tx, SUBSCRIPTION_CHILDREN, { companyId: principal.companyId, id }, period)
  }

  const [row] = await refuseOverlap({ [PLACE_SUBSCRIBED]: PLACE_SUBSCRIBED_SENTENCE }, () =>
    tx
      .update(subscription)
      .set(patch)
      .where(and(subscriptionScope(principal), eq(subscription.id, id)))
      .returning(subscriptionColumns),
  )
  if (row === undefined) throw noSuchSubscription(id)
  return subscriptionOf(row)
}

/** The agreement of one of the caller's projects with this number that starts on this day: the key a file names an agreement by. */
export async function agreementStarting(tx: Tx, principal: Principal, projectId: string, number: string, validFrom: string): Promise<Agreement | undefined> {
  const [row] = await tx
    .select(columns)
    .from(agreement)
    .where(and(scope(principal), eq(agreement.projectId, projectId), eq(agreement.number, number), eq(agreement.validFrom, validFrom)))
    .limit(1)
  return row === undefined ? undefined : agreementOf(row)
}

/** The agreement's subscription to this product at this place that starts on this day: the key a file names a subscription by. */
export async function subscriptionStarting(
  tx: Tx,
  principal: Principal,
  agreementId: string,
  key: { productId: string; propertyId: string | null; sharedCollectionPointId: string | null; validFrom: string },
): Promise<Subscription | undefined> {
  const [row] = await tx
    .select(subscriptionColumns)
    .from(subscription)
    .where(
      and(
        subscriptionScope(principal),
        eq(subscription.agreementId, agreementId),
        eq(subscription.productId, key.productId),
        key.propertyId === null ? isNull(subscription.propertyId) : eq(subscription.propertyId, key.propertyId),
        key.sharedCollectionPointId === null ? isNull(subscription.sharedCollectionPointId) : eq(subscription.sharedCollectionPointId, key.sharedCollectionPointId),
        eq(subscription.validFrom, key.validFrom),
      ),
    )
    .limit(1)
  return row === undefined ? undefined : subscriptionOf(row)
}

/** What a day of a change or a termination outside the period is told: it falls after the first day and before the end. */
export const INSIDE_SUBSCRIPTION = "After the subscription's first day and before its end"
export const INSIDE_AGREEMENT = "After the agreement's first day and before its end"

/** What a change that leaves the product and the quantity as they are is told. */
export const CHANGES_NOTHING = "The subscription already has that product and that quantity"

/** The day of a change or a termination: after the period's first day and before its end, so both halves it leaves are periods (400 at `on`). */
function requireStrictlyInside(period: Period, on: string, message: string): void {
  if (period.validFrom < on && (period.validTo === null || on < period.validTo)) return
  throw invalidRequest("body", [{ path: "on", message }])
}

/**
 * A change of service from a day (#291): the subscription ends on `on` and
 * the one replacing it begins there with the product or the quantity named,
 * its containers and its pause carried over. The route's handler, and a
 * right-sizing proposal's approve (M23b of #293), which runs it in its own
 * transaction; answers the replacement.
 */
export async function changeSubscription(tx: Tx, principal: Principal, id: string, { on, productId, quantity }: SubscriptionChange): Promise<Subscription> {
  const { companyId } = principal

  // The agreement first and then the subscription, top down, as its patch takes them, and the row read again underneath.
  const found = await findSubscription(tx, principal, id)
  if (found === undefined) throw noSuchSubscription(id)
  await lockRow(tx, agreement, { companyId, id: found.agreementId })
  await lockRow(tx, subscription, { companyId, id })
  const current = await findSubscription(tx, principal, id)
  if (current === undefined) throw noSuchSubscription(id)

  requireStrictlyInside(current, on, INSIDE_SUBSCRIPTION)
  const named = productId === undefined ? undefined : changed(productId, current.productId)
  const productStatus = await requireProduct(tx, { companyId, projectId: current.projectId }, named)
  const takes = { productId: named ?? current.productId, quantity: quantity ?? current.quantity }
  if (named === undefined && takes.quantity === current.quantity) throw invalidRequest("body", [{ path: "", message: CHANGES_NOTHING }])

  // Every 400 above, every 409 below (@waste/domain/status-gates).
  refuseUnofferedProduct(productStatus)

  // The containers serving it on the day and the pause in force past it, read before they end, since each one's replacement keeps its end.
  const serving = await servingOn(tx, companyId, [id], on)
  const [pausing] = await tx
    .select({ validTo: subscriptionPause.validTo })
    .from(subscriptionPause)
    .where(and(eq(subscriptionPause.companyId, companyId), eq(subscriptionPause.subscriptionId, id), runsPast(subscriptionPause, on)))

  // Each half ends before the other begins, so no exclusion constraint sees two at once: the subscription ends with what it holds
  // (`endSubscriptionsOn`, refused where a placement or a pause begins on or after the day), and the replacement is written as any
  // subscription is (`createSubscription`, the CSV import's writer too): an active product and a served place, a period inside the
  // agreement's, no second of it at the place.
  await endSubscriptionsOn(tx, companyId, [id], on)
  const replacement = await createSubscription(tx, principal, current.agreementId, {
    productId: takes.productId,
    propertyId: current.propertyId,
    sharedCollectionPointId: current.sharedCollectionPointId,
    quantity: takes.quantity,
    validFrom: on,
    validTo: current.validTo,
  })
  await carryPlacements(tx, { companyId, projectId: current.projectId }, serving, replacement.id, on)
  // The pause in force on the day goes on under the replacement, as the containers do (#291).
  if (pausing !== undefined) await pauseSubscription(tx, companyId, replacement, { id: newId(), validFrom: on, validTo: pausing.validTo })
  return replacement
}

export function agreementRoutes(deps: RouteDeps) {
  const { now, jobs } = deps
  return routes(deps)
    .get(
      "/agreements",
      {
        operationId: "listAgreements",
        summary: "The agreements the caller's projects hold",
        description:
          "One page of agreements, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `customerId` answers the agreements that customer holds or pays for, since the payer is a customer in their own right. `number` is exact: a number may name more than one agreement over time, one valid at a time. `validOn` asks for the agreements in force on that day, `validFrom` inclusive and `validTo` exclusive, which is how \"running\", \"expired\" and \"pending\" are asked for. Hand `nextCursor` back as `cursor` for the next page.",
        module: MODULE,
        action: "view",
        query: AgreementListQuery,
        invalid: ["a filter is malformed", "`projectId` is not a project this account works in"],
        responses: {
          200: describeJson("One page of agreements.", AgreementPage),
        },
      },
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
      {
        operationId: "createAgreement",
        summary: "Write an agreement",
        description:
          "Writes an agreement in one project, which must be a project the caller works in. The customer and the payer are customers of this company — the same one in the common case, a housing administrator in the interesting one — and must be active in both fields: an inactive one is refused (409) in a sentence saying whether as holder or as payer, while the agreements a customer already holds stand when it goes inactive, since a status gates a new reference and never an existing one. The status defaults to `draft`, since an agreement is written before it is signed, and the period is half-open: `validFrom` is the first day in force and `validTo` the first day out of it, absent meaning the agreement is still running. The number is not unique: one agreement of a number may be valid at a time, so a number may name a later agreement once the earlier one has ended, and an overlapping one is refused. `priceListId` is the price list the agreement is priced under — a list of the project, in the agreement's currency (400 on `priceListId`, `The price list is in EUR; the agreement is billed in DKK`); absent or null, the agreement is priced under the project's default list. The server mints the id.",
        module: MODULE,
        action: "create",
        body: AgreementCreate,
        invalid: ["the body is missing a field, names a member the server owns, names a project this account does not work in, ends on or before the day it starts, names a customer or payer that is not this company's, or names a price list that is not the project's or is in another currency than the agreement's"],
        responses: {
          201: describeCreated("The agreement as it was written.", Agreement),
          409: describeProblem("An agreement of that number is already valid over part of that period, or the customer, as holder or as payer, is inactive."),
        },
      },
      async (c) => created(c, "/agreements", await createAgreement(c.get("tx"), c.get("principal"), c.req.valid("json"))),
    )
    .get(
      "/agreements/:id",
      {
        operationId: "getAgreement",
        summary: "One agreement",
        description:
          "One agreement of a project the caller works in. An agreement of another company, or of a project this account does not work in, is an agreement that does not exist here.",
        module: MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The agreement.", Agreement),
          404: describeProblem("No agreement with that id in the projects this account works in."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findAgreement(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchAgreement(id)
        return c.json(agreementOf(row))
      },
    )
    .patch(
      "/agreements/:id",
      {
        operationId: "patchAgreement",
        summary: "Amend an agreement",
        description:
          "Amends one agreement of a project the caller works in; every field is optional and at least one must be given. Amending changes the row and the audit log is the history. The project is not patchable, since a record does not move between projects. A customer the patch newly names, as holder or as payer, must be active (409, saying which); re-stating the customer the agreement already carries names nothing new, so a patch sending the record whole is taken after its customer has gone inactive. Moving the period is held to two rules: the end still comes after the start, which a body naming one bound cannot see by itself, and the new period still contains every subscription of the agreement and every business access credential charged to it — a shortening that would strand one is refused (409), counting them, and they have to be ended first. A period that overlaps another agreement of the same number is refused too. `priceListId` moves the agreement onto a price list of the project in the agreement's currency, or back to the project's default list with null; a list or a currency the patch changes is held to the other (400 on `priceListId`).",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: AgreementPatch,
        invalid: ["the patch is empty, names a field the caller does not own (the project included), ends on or before the day it starts, names a customer or payer that is not this company's, or names a price list that is not the project's or is in another currency than the agreement's"],
        responses: {
          200: describeJson("The agreement as it now stands.", Agreement),
          404: describeProblem("No agreement with that id in the projects this account works in."),
          409: describeProblem("Subscriptions of the agreement, or access credentials charged to it, would fall outside the new period, another agreement of that number is already valid over part of it, or the customer the patch newly names, as holder or as payer, is inactive."),
        },
      },
      async (c) => c.json(await patchAgreement(c.get("tx"), c.get("principal"), c.req.valid("param").id, c.req.valid("json"))),
    )
    .get(
      "/agreements/:id/subscriptions",
      {
        operationId: "listAgreementSubscriptions",
        summary: "One agreement's subscriptions",
        description:
          "One page of the agreement's subscriptions, oldest first (ids are time-ordered). The path says the agreement, so the only filter is `validOn`: the subscriptions in force on that day, `validFrom` inclusive and `validTo` exclusive. An agreement of another company, or of a project this account does not work in, is an agreement that does not exist here. Hand `nextCursor` back as `cursor` for the next page.",
        module: MODULE,
        action: "view",
        params: IdParam,
        query: SubscriptionListQuery,
        invalid: ["`validOn` is not a calendar day"],
        responses: {
          200: describeJson("One page of the agreement's subscriptions.", SubscriptionPage),
          404: describeProblem("No agreement with that id in the projects this account works in."),
        },
      },
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
      {
        operationId: "createSubscription",
        summary: "Subscribe an agreement to a product at a place",
        description:
          "Adds one product delivered at one place under the agreement the path names. The agreement says the project, so the body names neither: the product and the place must both be that project's. The place is exactly one of `propertyId` and `sharedCollectionPointId`; either may be sent as null, which is a place not given. The product must be active and the place served — a property active, a point open or restricted — each refused otherwise (409) in a sentence naming the status it has; the subscriptions already made stand when a product is withdrawn or a place closes, since a status gates a new reference and never an existing one. The quantity defaults to one. The period lies inside the agreement's — a `validFrom` before it, or an end beyond it or absent where the agreement has one, is refused naming the bound — and the agreement may not already subscribe to that product at that place over part of it. The server mints the id.",
        module: MODULE,
        action: "create",
        params: IdParam,
        body: SubscriptionCreate,
        invalid: ["the body is missing a field, names a member the server owns, names other than one place, ends on or before the day it starts, falls outside the agreement's period, or names a product or a place that is not this agreement's project's"],
        responses: {
          201: describeCreated("The subscription as it was written.", Subscription),
          404: describeProblem("No agreement with that id in the projects this account works in."),
          409: describeProblem("The agreement already subscribes to that product at that place over part of that period, or the product is draft or inactive, or the place is not served: an inactive property, or a draft or closed point."),
        },
      },
      async (c) => created(c, "/subscriptions", await createSubscription(c.get("tx"), c.get("principal"), c.req.valid("param").id, c.req.valid("json"))),
    )
    .get(
      "/subscriptions",
      {
        operationId: "listSubscriptions",
        summary: "The subscriptions the caller's projects hold",
        description:
          "One page of subscriptions across agreements, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none reads an empty page. The list under an agreement (`GET /agreements/{id}/subscriptions`) answers one agreement's; this one answers a client that holds the family whole, as `GET /placements` does for placements (Issue #183). `projectId` narrows it to one of those projects; naming another is refused. `agreementId` narrows it to one agreement's, an agreement of another company or project being one that has none here. `validOn` asks for the subscriptions in force on that day, `validFrom` inclusive and `validTo` exclusive. Hand `nextCursor` back as `cursor` for the next page.",
        module: MODULE,
        action: "view",
        query: SubscriptionsQuery,
        invalid: ["a filter is malformed", "`projectId` is not a project this account works in"],
        responses: {
          200: describeJson("One page of subscriptions.", SubscriptionPage),
        },
      },
      async (c) => {
        const { limit, cursor, projectId, agreementId, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(subscriptionColumns)
          .from(subscription)
          .where(
            and(
              subscriptionScope(principal),
              projectId === undefined ? undefined : eq(subscription.projectId, projectId),
              agreementId === undefined ? undefined : eq(subscription.agreementId, agreementId),
              day === undefined ? undefined : validOn(subscription, day),
              after === undefined ? undefined : gt(subscription.id, after),
            ),
          )
          .orderBy(asc(subscription.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(subscriptionOf), limit))
      },
    )
    .get(
      "/subscriptions/:id",
      {
        operationId: "getSubscription",
        summary: "One subscription",
        description:
          "One subscription of a project the caller works in. A subscription of another company, or of a project this account does not work in, is a subscription that does not exist here.",
        module: MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The subscription.", Subscription),
          404: describeProblem("No subscription with that id in the projects this account works in."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findSubscription(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchSubscription(id)
        return c.json(subscriptionOf(row))
      },
    )
    .patch(
      "/subscriptions/:id",
      {
        operationId: "patchSubscription",
        summary: "Change a subscription",
        description:
          "Changes the quantity or the period of one subscription; every field is optional and at least one must be given. The product and the place do not change: a subscription that moves is a subscription that ended and another that began, which is what the period is for. A new period is held to three rules — the end still comes after the start, it still lies inside the agreement's (400 naming the bound), and it still contains every placement of the subscription, an open placement included, a shortening that would strand one being refused (409) so the containers are returned or decommissioned first, which is how a placement ends (`POST /containers/{id}/return`, `/decommission`) — and it may not overlap another subscription of the same product at the same place under the agreement.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: SubscriptionPatch,
        invalid: ["the patch is empty, names a field the caller does not own (the product and the place included), ends on or before the day it starts, or falls outside the agreement's period"],
        responses: {
          200: describeJson("The subscription as it now stands.", Subscription),
          404: describeProblem("No subscription with that id in the projects this account works in."),
          409: describeProblem("Placements of the subscription would fall outside the new period (end them through the container's return or decommission first), or the agreement already subscribes to that product at that place over part of it."),
        },
      },
      async (c) => c.json(await patchSubscription(c.get("tx"), c.get("principal"), c.req.valid("param").id, c.req.valid("json"))),
    )
    .post(
      "/subscriptions/:id/change",
      {
        operationId: "changeSubscription",
        summary: "Change a subscription's service from a day",
        description:
          "A change of service (#291): the subscription ends on `on` and the one replacing it begins there, at the same place under the same agreement, with the product or the quantity the body names — what it leaves out is the subscription's — until the subscription's own end. Every container serving the subscription on `on` serves the replacement from then: its placement ends on `on` and the same container's placement under the replacement begins there, with the same fraction and frequency override, so the container stays in service and no stock movement is written, since nothing moved. `on` lies after the subscription's first day and before its end (400 on `on`), a product the body names must be this project's (400 on `productId`), and a change that leaves both the product and the quantity as they are is refused (400). Then no placement of the subscription may begin on or after `on` (409, counting them), and the replacement is written as any subscription is — the CSV import's writer too — so its product must be active and its place served (409 naming the status) and the agreement may not already subscribe to that product at that place from `on` (409). Answers the replacement, with its `Location`; the subscription it replaces is read again at its own address. Under the agreement's lock and then the subscription's, as its patch takes them.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: SubscriptionChange,
        invalid: ["the body names neither the product nor the quantity, names a member it does not own, puts `on` outside the subscription's period or on its first day, names a product that is not the project's, or changes nothing"],
        responses: {
          201: describeCreated("The subscription replacing it, from `on`.", Subscription),
          404: describeProblem("No subscription with that id in the projects this account works in."),
          409: describeProblem("A placement of the subscription begins on or after `on`, the product is draft or inactive or the place is not served, or the agreement already subscribes to that product at that place from `on`."),
        },
      },
      async (c) => created(c, "/subscriptions", await changeSubscription(c.get("tx"), c.get("principal"), c.req.valid("param").id, c.req.valid("json"))),
    )
    .post(
      "/agreements/:id/terminate",
      {
        operationId: "terminateAgreement",
        summary: "Terminate an agreement on a day",
        description:
          "A termination (#291): the agreement, every one of its subscriptions in force past `on`, every placement serving them and every pause of them, and every business access credential charged to it, end together on `on`, the first day none of them is in force. A container stays in service — the bin stays where it is until it is returned, and its return then records the placement that ended without ending it again. `on` lies after the agreement's first day and before its end (400 on `on`). A subscription, a placement, a pause or a credential that begins on or after `on` would be stranded, and is refused (409, counting them) so it is ended first. Generation's planned routes from `on` stop at those containers no more once a run has read them again: a run of each scheme whose planned routes do is asked in the same transaction, from `on` (or the project's today, or the scheme's first day, if later) through the last such route — where the caller may ask one (`edit` on `route-studio.schemes`), of a validated scheme, absorbed by one already queued, and never a refusal: where no worker has made the queue yet, the next run drops them. Stops no run will take away — on a dispatched or running route, which generation never refreshes, or the office's own — are answered in `stopsToRemove`, for the office to remove by hand, and so is a planned delivery booked under a subscription that ends, from `on` (O3b of #290); a removal or a swap of one of the containers is kept, since it is how the container leaves service. Under the agreement's lock and then its subscriptions', in id order.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: AgreementTermination,
        invalid: ["the body is not one `on`, or `on` is outside the agreement's period or its first day"],
        responses: {
          200: describeJson("The agreement as it now stands, and the stops left to remove by hand.", AgreementTerminated),
          404: describeProblem("No agreement with that id in the projects this account works in."),
          409: describeProblem("A subscription of the agreement, a placement serving one, a pause of one, or a credential charged to it, begins on or after `on`."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const { on } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const { companyId } = principal

        await lockRow(tx, agreement, { companyId, id })
        const current = await findAgreement(tx, principal, id)
        if (current === undefined) throw noSuchAgreement(id)
        requireStrictlyInside(current, on, INSIDE_AGREEMENT)

        // Everything the agreement holds ends on the day, refused (409) where a subscription, a placement, a pause or a credential
        // begins on or after it, and the agreement's own patch then strands nothing.
        const { subscriptionIds: ending, containerIds } = await endAgreementHoldingsOn(tx, companyId, id, on)
        const terminated = await patchAgreement(tx, principal, id, { validTo: on })

        const within = { companyId, projectId: current.projectId }
        // The planned deliveries booked under the subscriptions ending are listed too (O3b of #290): their bin would go into service under a subscription out of force.
        const { toRemove, runs } = await stopsLeft(tx, within, containerIds, { from: on, to: null }, ending)
        await askRuns(tx, principal, jobs, within, runs, now)
        return c.json({ agreement: terminated, stopsToRemove: toRemove } satisfies AgreementTerminated)
      },
    )
}
