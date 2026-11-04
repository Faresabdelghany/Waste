// A move (#374, #291 C11): `POST /properties/:id/moves` changes a Property's
// occupant on a day, in the request's one transaction. The outgoing
// customer's parties at the property end on `on` and the incoming customer
// takes the same roles from it, so a sale and a tenant change are the same
// command (the owner's decision on #374); another customer's parties are not
// the move's. The outgoing customer's subscriptions at the property that run
// past `on` end there with their placements and their pauses, as a
// termination ends them (routes/agreements.ts), and the outgoing agreement
// ends too where nothing of it runs past `on` elsewhere. One agreement for the
// incoming customer begins on `on`, `active`, under the number the body typed
// and the outgoing agreement's cadence, currency, list and service window,
// invoicing the body's payer or the incoming customer; it carries the same
// products and quantities, and every container serving an ended subscription
// on the day goes on under its replacement from `on` with the same fraction
// and frequency override, so it never leaves service and no stock movement is
// written — `POST /subscriptions/:id/change`'s rule. A pause is the outgoing
// customer's, and is not carried.
//
// What the move does not do is reprice (the owner's decision on #374): a
// recurring charge is minted in advance, so the outgoing subscriptions'
// charges whose period crosses or follows `on` are answered in
// `chargesToCredit`, invoiced or not as their status reads, for the office
// to credit or cancel. A termination is to share the rule (#328).
//
// The outgoing customer subscribing at the property under two agreements is
// refused (409, naming them): the office ends one first, and the move then
// writes one agreement under one number. A property it subscribes at nowhere
// moves its parties alone and owes no number.
//
// Judged as every route is: the property (404), the body's customers and the
// number a move with subscriptions owes (400), then the property's state
// against the body (409) — the outgoing customer no party on the day, a role,
// a subscription, a placement or a pause beginning on or after it, two
// agreements, an inactive incoming customer — and the writes' own 409s
// through the writers they share with their routes. Under the property's lock,
// then the outgoing agreement's, then its subscriptions' in id order.
//
// `dryRun` runs the same statements inside a savepoint that always rolls back,
// and answers what they made: the agreement and subscriptions it would write
// carry ids nothing keeps.
import { MoveCreate, MoveOutcome } from "@waste/contracts/moves"
import type { Subscription } from "@waste/contracts/agreements"
import type { Tx } from "@waste/db/client"
import { eventOf, eventsFrom } from "@waste/db/commands/billing-shapes"
import { agreement, subscription, subscriptionPause } from "@waste/db/schema/agreements"
import { containerServicePlacement } from "@waste/db/schema/containers"
import { property, propertyParty } from "@waste/db/schema/customers"
import { billableEvent } from "@waste/db/schema/finance"
import { and, asc, eq, gt, gte, inArray, isNull, lte, or } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import {
  createAgreement,
  createSubscription,
  patchAgreement,
  patchSubscription,
  pausesBeginLater,
  pausesPast,
  placementsBeginLater,
  placementsPast,
  readAgreement,
} from "./agreements"
import { refuseStranded } from "./periods"
import { findProperty, noSuchProperty, propertyWithParties } from "./property-writes"
import { requireCustomer } from "./references"
import type { ClockOptions } from "./scheme-groups"
import { describeJson, IdParam, lockRow, lockRows, refuseOverlap, stamp } from "./shared"
import { refuseInactiveCustomer } from "./statuses"

/** What a move with subscriptions to carry and no number for the incoming agreement is told. */
export const NUMBER_OWED = "The outgoing customer subscribes at this property, so the incoming customer's agreement needs a number"
const noParty = (on: string) => `The outgoing customer is no party of this property on ${on}; a move ends roles held on its day`
const roleBeginsLater = (on: string) => `A role the outgoing customer holds at this property begins on or after ${on}; correct it through the property's parties instead`
const subscribedTwice = (numbers: readonly string[]) => `The outgoing customer subscribes at this property under ${numbers.join(" and ")}; end all but one of them first, so the move writes one agreement`
const subscriptionsBeginLater = (on: string) => (rows: number) => `${rows === 1 ? "A subscription" : `${rows} subscriptions`} of the outgoing customer at this property ${rows === 1 ? "begins" : "begin"} on or after ${on}; end ${rows === 1 ? "it" : "them"} first`
const PARTY_OVERLAP = "property_party_no_overlap"
const ROLE_HELD = "The incoming customer already holds one of those roles at this property over part of that period"

/** Thrown through a dry run's savepoint so it rolls back, carrying what the move would have answered. */
class Rehearsal extends Error {
  constructor(readonly outcome: MoveOutcome) {
    super("a dry run of a move")
  }
}

/** The move itself, in `tx`: every statement, every refusal, and what it leaves. */
async function performMove(tx: Tx, principal: Principal, id: string, body: MoveCreate, now: () => Date): Promise<MoveOutcome> {
  const { companyId } = principal
  const { on } = body

  await lockRow(tx, property, { companyId, id })
  const row = await findProperty(tx, principal, id)
  if (row === undefined) throw noSuchProperty(id)

  // The body's own 400s: three customers of this company, and the number the subscriptions owe.
  await requireCustomer(tx, companyId, body.outgoingCustomerId, "outgoingCustomerId")
  const incomingStatus = await requireCustomer(tx, companyId, body.incomingCustomerId, "incomingCustomerId")
  await requireCustomer(tx, companyId, body.payerCustomerId, "payerCustomerId")
  const subscribed = await tx
    .select({ id: subscription.id, agreementId: subscription.agreementId, validFrom: subscription.validFrom, number: agreement.number })
    .from(subscription)
    .innerJoin(agreement, and(eq(agreement.companyId, subscription.companyId), eq(agreement.id, subscription.agreementId)))
    .where(and(eq(subscription.companyId, companyId), eq(subscription.propertyId, id), eq(agreement.customerId, body.outgoingCustomerId), or(isNull(subscription.validTo), gt(subscription.validTo, on))))
    .orderBy(asc(subscription.id))
  if (subscribed.length > 0 && body.agreementNumber === undefined) throw invalidRequest("body", [{ path: "agreementNumber", message: NUMBER_OWED }])

  // Every 400 above, every 409 below (routes/statuses.ts).
  const leaving = await tx
    .select({ id: propertyParty.id, role: propertyParty.role, validFrom: propertyParty.validFrom, validTo: propertyParty.validTo })
    .from(propertyParty)
    .where(and(eq(propertyParty.companyId, companyId), eq(propertyParty.propertyId, id), eq(propertyParty.customerId, body.outgoingCustomerId), lte(propertyParty.validFrom, on), or(isNull(propertyParty.validTo), gt(propertyParty.validTo, on))))
    .orderBy(asc(propertyParty.role))
  if (leaving.length === 0) throw problem(409, { detail: noParty(on) })
  if (leaving.some((party) => party.validFrom >= on)) throw problem(409, { detail: roleBeginsLater(on) })
  const numbers = [...new Set(subscribed.map((held) => held.number))].sort()
  if (numbers.length > 1) throw problem(409, { detail: subscribedTwice(numbers) })
  const beginningLater = subscribed.filter((held) => held.validFrom >= on).length
  if (beginningLater > 0) throw problem(409, { detail: subscriptionsBeginLater(on)(beginningLater) })
  refuseInactiveCustomer(incomingStatus, "customerId")

  const ending = subscribed.map((held) => held.id)
  const outgoingId = subscribed[0]?.agreementId
  const outgoing = { agreement: null as MoveOutcome["outgoing"]["agreement"], subscriptions: [] as Subscription[] }
  const incoming = { agreement: null as MoveOutcome["incoming"]["agreement"], subscriptions: [] as Subscription[] }
  const containersCarried: string[] = []
  let chargesToCredit: MoveOutcome["chargesToCredit"] = []

  if (outgoingId !== undefined) {
    await lockRow(tx, agreement, { companyId, id: outgoingId })
    await lockRows(tx, subscription, companyId, ending)
    await refuseStranded(tx, containerServicePlacement, and(eq(containerServicePlacement.companyId, companyId), inArray(containerServicePlacement.subscriptionId, ending), gte(containerServicePlacement.validFrom, on)), placementsBeginLater)
    await refuseStranded(tx, subscriptionPause, and(eq(subscriptionPause.companyId, companyId), inArray(subscriptionPause.subscriptionId, ending), gte(subscriptionPause.validFrom, on)), pausesBeginLater)

    // What the outgoing subscriptions are and what serves them on the day, read before anything ends.
    const sold = await tx
      .select({ id: subscription.id, productId: subscription.productId, propertyId: subscription.propertyId, quantity: subscription.quantity, validTo: subscription.validTo })
      .from(subscription)
      .where(and(eq(subscription.companyId, companyId), inArray(subscription.id, ending)))
      .orderBy(asc(subscription.id))
    const serving = await tx
      .select({
        id: containerServicePlacement.id,
        subscriptionId: containerServicePlacement.subscriptionId,
        containerId: containerServicePlacement.containerId,
        wasteFractionId: containerServicePlacement.wasteFractionId,
        serviceFrequencyId: containerServicePlacement.serviceFrequencyId,
        validTo: containerServicePlacement.validTo,
      })
      .from(containerServicePlacement)
      .where(placementsPast(companyId, ending, on))
      .orderBy(asc(containerServicePlacement.id))

    // The outgoing half ends: its placements first, so no subscription strands one, then its pauses and the subscriptions.
    if (serving.length > 0) {
      await tx
        .update(containerServicePlacement)
        .set({ validTo: on })
        .where(and(eq(containerServicePlacement.companyId, companyId), inArray(containerServicePlacement.id, serving.map((placement) => placement.id))))
    }
    await tx.update(subscriptionPause).set({ validTo: on }).where(pausesPast(companyId, ending, on))
    for (const subscriptionId of ending) outgoing.subscriptions.push(await patchSubscription(tx, principal, subscriptionId, { validTo: on }))
    const runningElsewhere = await tx
      .select({ id: subscription.id })
      .from(subscription)
      .where(and(eq(subscription.companyId, companyId), eq(subscription.agreementId, outgoingId), or(isNull(subscription.validTo), gt(subscription.validTo, on))))
      .limit(1)
    outgoing.agreement = runningElsewhere.length === 0 ? await patchAgreement(tx, principal, outgoingId, { validTo: on }) : ((await readAgreement(tx, principal, outgoingId)) ?? null)
    const ended = outgoing.agreement
    if (ended === null) throw noSuchProperty(id)

    // The incoming half begins: its agreement as any agreement is written, then each replacement and the containers it carries.
    const started = await createAgreement(tx, principal, {
      projectId: ended.projectId,
      number: body.agreementNumber as string,
      customerId: body.incomingCustomerId,
      payerCustomerId: body.payerCustomerId ?? body.incomingCustomerId,
      status: "active",
      billingCadence: ended.billingCadence,
      currency: ended.currency,
      priceListId: ended.priceListId,
      serviceWindow: ended.serviceWindow,
      validFrom: on,
    })
    incoming.agreement = started
    for (const held of sold) {
      const replacement = await createSubscription(tx, principal, started.id, { productId: held.productId, propertyId: held.propertyId ?? undefined, quantity: held.quantity, validFrom: on, validTo: held.validTo })
      incoming.subscriptions.push(replacement)
      const carried = serving.filter((placement) => placement.subscriptionId === held.id)
      if (carried.length === 0) continue
      await tx.insert(containerServicePlacement).values(
        carried.map((placement) => ({
          id: newId(),
          companyId,
          projectId: ended.projectId,
          containerId: placement.containerId,
          subscriptionId: replacement.id,
          wasteFractionId: placement.wasteFractionId,
          serviceFrequencyId: placement.serviceFrequencyId,
          validFrom: on,
          validTo: placement.validTo,
        })),
      )
      containersCarried.push(...carried.map((placement) => placement.containerId))
    }

    // The charges a move does not reprice: each ended subscription's recurring charge, live, whose period crosses or follows the day.
    const { query, reversing } = eventsFrom(tx, companyId)
    const charged = await query
      .where(and(eq(billableEvent.companyId, companyId), eq(billableEvent.kind, "subscription"), inArray(billableEvent.subscriptionId, ending), gt(billableEvent.chargePeriodTo, on), isNull(billableEvent.cancelledAt), isNull(reversing.id)))
      .orderBy(asc(billableEvent.chargePeriodFrom), asc(billableEvent.id))
    chargesToCredit = charged.map(eventOf)
  }

  // The parties last: the outgoing customer's roles end on the day, and the incoming customer's begin there, each until the end the outgoing role had.
  await tx.update(propertyParty).set({ validTo: on }).where(and(eq(propertyParty.companyId, companyId), inArray(propertyParty.id, leaving.map((party) => party.id))))
  await refuseOverlap({ [PARTY_OVERLAP]: ROLE_HELD }, () =>
    tx.insert(propertyParty).values(
      leaving.map((party) => ({ id: newId(), companyId, projectId: row.projectId, propertyId: id, customerId: body.incomingCustomerId, role: party.role, validFrom: on, validTo: party.validTo })),
    ),
  )
  // The parties are part of the property on the wire, so the property moved.
  const [stamped] = await tx.update(property).set(stamp()).where(and(eq(property.companyId, companyId), eq(property.id, id))).returning({ id: property.id })
  if (stamped === undefined) throw noSuchProperty(id)
  const moved = await findProperty(tx, principal, id)
  if (moved === undefined) throw noSuchProperty(id)

  return {
    dryRun: false,
    on,
    property: await propertyWithParties(tx, companyId, moved, now()),
    outgoing,
    incoming,
    containersCarried,
    chargesToCredit,
  }
}

export function moveRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>().post(
    "/properties/:id/moves",
    describeRoute({
      operationId: "moveProperty",
      summary: "Move a property's occupant out and another in on a day",
      description:
        "A move (#374): the property changes occupant on `on`, in one transaction. Every role the outgoing customer holds at the property on `on` ends there and the incoming customer holds the same roles from it, until the end each had — so a sale and a tenant change are one command, and another customer's roles are untouched. The outgoing customer's subscriptions at the property running past `on` end there with their placements and their pauses, and the outgoing agreement ends too where nothing of it runs past `on` elsewhere. One agreement for the incoming customer begins on `on`, `active`, numbered `agreementNumber`, under the outgoing agreement's cadence, currency, price list and service window, invoicing `payerCustomerId` or the incoming customer; it has the same products and quantities, and every container serving an ended subscription on `on` goes on under its replacement from `on` with the same fraction and frequency override — it never leaves service and no stock movement is written. Nothing is repriced: `chargesToCredit` lists the ended subscriptions' recurring charges whose period crosses or follows `on`, their status saying which are invoiced, for the office to credit or cancel. A property the outgoing customer subscribes at nowhere moves its parties alone and owes no number. `dryRun` answers what the move would do and writes nothing; the agreement and subscriptions it answers carry ids nothing keeps. Under the property's lock, then the outgoing agreement's and its subscriptions', in id order.",
      security: BEARER_SECURITY,
      responses: {
        200: describeJson("What ended, what began, the containers carried over and the charges left for the office.", MoveOutcome),
        400: describeProblem("The path does not hold an id, a field will not do, a customer named is not one of this company, or the outgoing customer subscribes at the property and the body names no `agreementNumber`."),
        401: describeProblem("No usable token (see WWW-Authenticate)."),
        403: describeProblem("No active account here, or the caller's role does not allow `edit` on both `customers.properties` and `customers.agreements`."),
        404: describeProblem("No property with that id in the projects this account works in."),
        409: describeProblem(
          "The outgoing customer is no party of the property on `on`, or a role, subscription, placement or pause of theirs here begins on or after it; they subscribe here under two agreements; the incoming customer or the payer is inactive, already holds one of the roles over part of the period, or the agreement number is already valid over part of it; or a product is no longer offered.",
        ),
      },
    }),
    guard,
    requireGrant("customers.properties", "edit"),
    requireGrant("customers.agreements", "edit"),
    validate("param", IdParam),
    validate("json", MoveCreate),
    async (c) => {
      const { id } = c.req.valid("param")
      const body = c.req.valid("json")
      const tx = c.get("tx")
      const principal = c.get("principal")
      if (!body.dryRun) return c.json(await performMove(tx, principal, id, body, now))
      try {
        await tx.transaction(async (savepoint) => {
          throw new Rehearsal(await performMove(savepoint as unknown as Tx, principal, id, body, now))
        })
      } catch (thrown) {
        if (thrown instanceof Rehearsal) return c.json({ ...thrown.outcome, dryRun: true } satisfies MoveOutcome)
        throw thrown
      }
      throw new Error("a dry run's savepoint rolls back by throwing, so it never commits")
    },
  )
}
