// A status gates a new reference and never an existing one (Issue #79).
//
// Every Registry record that is not effective-dated carries a status — a
// Customer active or inactive, a Property the same, a Product draft, active
// or inactive, a Shared Collection Point draft, open, restricted or closed —
// and until this module nothing read one: an inactive customer could take a
// new agreement and a closed point a new subscription. The rule is one
// sentence. A body that names a customer, a product or a place is making a
// new reference, and the row it names has to be in the state that reference
// needs: a Customer active to hold or pay for an agreement, a Product active
// to be subscribed to, a Property active or a Point open or restricted to be
// delivered at, and a place not gone inactive or closed to have a container
// put into service at it. A reference already made stands whatever the row
// does afterwards — an agreement of a customer that goes inactive runs on, a
// placement at a point that closes is ended by its period and not by the
// status — and a row's own status never blocks a write to the row itself: a
// draft product is patched, a customer is set inactive with agreements
// standing.
//
// The refusal is a 409, not a 400 and not a 404: the id is right and the row
// is there, and what refuses is the state it is in. A 400 says "fix the id"
// and a 404 says "there is no such row", and neither is what happened. It is
// a sentence naming the status the row has and the state the reference needs,
// so a person reads what to change, and each is spelled here once per family.
// The existence check underneath is routes/references.ts's, which answers the
// status with the proof the row is there, so the gate is no second statement
// and a row that is not there is still the 400 naming the field, before any
// of this.
//
// No row lock is taken here, unlike for containment (routes/periods.ts),
// because this rule has one side and not two: a status change never looks at
// what references the row, so there is no pair of reads to serialise. A
// reference made the instant before the state changed is exactly an existing
// reference, and stands.
//
// What stays informational, by decision and not by omission: `project.status`,
// since an onboarding project is one being set up and setting one up is
// writing these records; `property_group.status`, since a group is built
// while draft; and `agreement.status`, since the period says the stronger
// thing (ADR-0005) — an agreement is valid on a day or it is not. The
// set-shaped references (a Property's parties, a Group's or a Point's members)
// and the customer a Group or a Point answers to are not gated in this issue
// either.
import type { ProductStatus } from "@waste/contracts/catalogue"
import type { PropertyStatus, SharedCollectionPointStatus } from "@waste/contracts/customers"
import type { Tx } from "@waste/db/client"

import { problem } from "../problem"
import { requireCustomer, requireProduct, requireProperty, requireSharedCollectionPoint } from "./references"

/** What a project-scoped lookup is bounded by: the caller's company, and the project the parent record is in. */
type Scope = { companyId: string; projectId: string }

/** The two fields an agreement names a customer in, each with its own sentence, since the refusal says which. */
type Party = "customerId" | "payerCustomerId"
const INACTIVE_PARTY: Readonly<Record<Party, string>> = {
  customerId: "The customer is inactive; an agreement needs an active customer",
  payerCustomerId: "The payer is inactive; an agreement needs an active payer",
}

/** The states a Point takes waste in: from anybody when open, from its members when restricted. */
const SERVING_POINT: readonly SharedCollectionPointStatus[] = ["open", "restricted"]

const productNotOffered = (status: ProductStatus) => `The product is ${status}; only an active product can be subscribed to`
const propertyNotServed = (status: PropertyStatus) => `The property is ${status}; a subscription needs an active property`
const pointNotServing = (status: SharedCollectionPointStatus) =>
  `The shared collection point is ${status}; a subscription needs an open or restricted point`

/** What a placement is told about the place it reaches through its subscription; the place is the subscription's, so the sentence says so. */
const PLACED_AT_INACTIVE_PROPERTY = "The subscription's property is inactive; a container cannot be placed at an inactive property"
const PLACED_AT_CLOSED_POINT = "The subscription's shared collection point is closed; a container cannot be placed at a closed point"

/** A Customer an agreement names, as its holder or its payer: there, and active. */
export async function requireActiveCustomer(tx: Tx, companyId: string, id: string | null | undefined, path: Party): Promise<void> {
  const status = await requireCustomer(tx, companyId, id, path)
  if (status === undefined || status === "active") return
  throw problem(409, { detail: INACTIVE_PARTY[path] })
}

/** A Product a subscription names: there, in the agreement's project, and offered. */
export async function requireActiveProduct(tx: Tx, scope: Scope, id: string | null | undefined): Promise<void> {
  const status = await requireProduct(tx, scope, id)
  if (status === undefined || status === "active") return
  throw problem(409, { detail: productNotOffered(status) })
}

/** A Property a subscription is delivered at: there, in the agreement's project, and served. */
export async function requireActiveProperty(tx: Tx, scope: Scope, id: string | null | undefined): Promise<void> {
  const status = await requireProperty(tx, scope, id)
  if (status === undefined || status === "active") return
  throw problem(409, { detail: propertyNotServed(status) })
}

/** A Shared Collection Point a subscription is delivered at: there, in the agreement's project, and taking waste. */
export async function requireServingPoint(tx: Tx, scope: Scope, id: string | null | undefined): Promise<void> {
  const status = await requireSharedCollectionPoint(tx, scope, id)
  if (status === undefined || SERVING_POINT.includes(status)) return
  throw problem(409, { detail: pointNotServing(status) })
}

/**
 * The place a placement reaches through its subscription, as the statement
 * that proved the subscription is there reads it: one of the two is null,
 * since a subscription is delivered at one place. A property that has gone
 * inactive and a point that has closed refuse a new container. A point that
 * is draft is not refused here: the subscription's own gate already holds a
 * new subscription to an open or restricted point, and this is the decision
 * for a place that stopped serving after the subscription was made.
 */
export function refuseUnservedPlace(place: { propertyStatus: string | null; sharedCollectionPointStatus: string | null }): void {
  if (place.propertyStatus === "inactive") throw problem(409, { detail: PLACED_AT_INACTIVE_PROPERTY })
  if (place.sharedCollectionPointStatus === "closed") throw problem(409, { detail: PLACED_AT_CLOSED_POINT })
}
