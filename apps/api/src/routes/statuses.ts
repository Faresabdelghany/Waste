// A status gates a new reference and never an existing one (Issue #79).
//
// Every Registry record that is not effective-dated carries a status — a
// Customer active or inactive, a Property the same, a Product draft, active
// or inactive, a Shared Collection Point draft, open, restricted or closed —
// and until this module nothing read one: an inactive customer could take a
// new agreement and a closed point a new subscription. The rule is one
// sentence. A body that names a customer, a product or a place is making a
// new reference, and the row it names has to be in the state that reference
// needs: a Customer active to hold or to be billed for an agreement, a
// Product active to be subscribed to, a place served — a Property active, a
// Point open or restricted — to be delivered at or to have a container put
// into service at. A reference already made stands whatever the row does
// afterwards — an agreement of a customer that goes inactive runs on, a
// placement at a point that closes is ended by its period and not by the
// status — and a row's own status never blocks a write to the row itself: a
// draft product is patched, a customer is set inactive with agreements
// standing. A patch that re-states the id a record already carries names
// nothing new, so it is not held here either: a client that sends the record
// whole is not refused for the customer it already has.
//
// The refusal is a 409, not a 400 and not a 404: the id is right and the row
// is there, and what refuses is the state it is in. A 400 says "fix the id"
// and a 404 says "there is no such row", and neither is what happened. It is
// a sentence naming the status the row has and the state the reference needs,
// so a person reads what to change, and each is spelled here once per family;
// "served" is defined once for the two references that ask it, so a
// subscription and a placement cannot disagree about which places take waste.
//
// These are gates over a status already read, not lookups. routes/references.ts
// answers the status with the proof the row is there, and a route runs every
// 400 it has first — the ids that are not there, the period outside its
// parent's — and these after, so a body that is wrong is told so before a
// state it did not choose: 400 before any 409, as in every route here.
//
// No row lock is taken for this rule, unlike for containment
// (routes/periods.ts), because it has one side and not two: a status change
// never looks at what references the row, so there is no pair of reads to
// serialise. A reference made the instant before the state changed is exactly
// an existing reference, and stands.
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
import type { CustomerStatus, PropertyStatus, SharedCollectionPointStatus } from "@waste/contracts/customers"
import type { WarehouseStatus } from "@waste/domain/resources/vocabulary"

import { problem } from "../problem"
import type { WarehouseRef } from "./references"

/** The two fields an agreement names a customer in: as its holder, and as the customer it is billed to. */
export type Party = "customerId" | "payerCustomerId"

/** What an inactive customer is told in each field; the sentence says which, and a payer is a Customer in the glossary's terms. */
const INACTIVE_PARTY: Readonly<Record<Party, string>> = {
  customerId: "The customer is inactive; an agreement needs an active customer",
  payerCustomerId: "The customer named as payer is inactive; an agreement needs an active one",
}

/** The states a Point takes waste in: from anybody when open, from its members when restricted. The one definition, for every reference that asks. */
const SERVING_POINT: readonly SharedCollectionPointStatus[] = ["open", "restricted"]

/** The place a subscription is delivered at, as the statuses of its two possible rows: one is null, since a subscription has one place. */
export type Place = { propertyStatus: PropertyStatus | null; sharedCollectionPointStatus: SharedCollectionPointStatus | null }

/** A place as two lookups answer it, an id not named being a row not there. */
export const placeOf = (propertyStatus: PropertyStatus | undefined, sharedCollectionPointStatus: SharedCollectionPointStatus | undefined): Place => ({
  propertyStatus: propertyStatus ?? null,
  sharedCollectionPointStatus: sharedCollectionPointStatus ?? null,
})

/** What names the place, and how its sentence begins: a subscription names it itself, a placement reaches it through its subscription. */
type PlaceReference = "subscription" | "placement"
const PLACE_OF: Readonly<Record<PlaceReference, string>> = { subscription: "The", placement: "The subscription's" }

/** A Customer an agreement names, in either field: active, or the sentence for that field. Nothing named is nothing to gate. */
export function refuseInactiveCustomer(status: CustomerStatus | undefined, path: Party): void {
  if (status === undefined || status === "active") return
  throw problem(409, { detail: INACTIVE_PARTY[path] })
}

/** A Product a subscription names: offered, or the sentence naming the status it has instead. */
export function refuseUnofferedProduct(status: ProductStatus | undefined): void {
  if (status === undefined || status === "active") return
  throw problem(409, { detail: `The product is ${status}; only an active product can be subscribed to` })
}

/**
 * The place a subscription is delivered at, or a placement reaches through
 * its subscription: served, or the sentence naming the status it has and
 * what the reference needs. One definition for both, so a point a
 * subscription may not be made at is a point a container may not be placed
 * at either, drafted again or closed alike.
 */
export function refuseUnservedPlace(place: Place, reference: PlaceReference): void {
  const { propertyStatus, sharedCollectionPointStatus } = place
  if (propertyStatus !== null && propertyStatus !== "active") {
    throw problem(409, { detail: `${PLACE_OF[reference]} property is ${propertyStatus}; a ${reference} needs an active property` })
  }
  if (sharedCollectionPointStatus !== null && !SERVING_POINT.includes(sharedCollectionPointStatus)) {
    throw problem(409, {
      detail: `${PLACE_OF[reference]} shared collection point is ${sharedCollectionPointStatus}; a ${reference} needs an open or restricted point`,
    })
  }
}

// Resources (Issue #101, its review rounds) applies the same rule to its own
// rows: a record that is closed, a draft or inactive takes no new row pointing
// at it, and every row already pointing at it stands. The refusal is the same
// 409 naming the status — the row the caller named is really there, so it is
// not the 400 a missing id earns, and no better body would do while the record
// stands as it does — with the family's own sentence, since what "closed"
// forbids differs from a warehouse to a product. `requireStatus` is the one
// mechanism; each round appends its gates below it, under its own heading.

/** Refuses a status a new reference may not point at, with the family's sentence; any other status passes. */
export function requireStatus<Status extends string>(status: Status, closedTo: readonly Status[], sentence: (status: Status) => string): void {
  if (closedTo.includes(status)) throw problem(409, { detail: sentence(status) })
}

// Resources, round A (Issue #101 review): the warehouse a movement arrives at.
// A closed or draft warehouse takes no new stock — nothing is received,
// returned, transferred or adjusted into it — and what stands there stands:
// the ledger's rows are never rewritten, the projection goes on reading them,
// and a transfer out of it is a movement into somewhere else, which is the
// way to empty it. `active` and `restricted` take stock; what `restricted`
// restricts is inventory's question, not the ledger's.

/** The warehouse statuses a movement may not arrive at. */
export const WAREHOUSE_TAKES_NO_STOCK: readonly WarehouseStatus[] = ["draft", "closed"]

/** What a movement into a closed or draft warehouse is told, naming the warehouse and its status. */
export const takesNoStock = (name: string, status: WarehouseStatus): string => `${name} is ${status}; a movement arrives only at an active or restricted warehouse`

/** Holds the warehouse a movement arrives at open for stock: the #79 rule as the ledger applies it, a 409 naming the status. */
export function requireWarehouseTakesStock(found: WarehouseRef): void {
  requireStatus(found.status, WAREHOUSE_TAKES_NO_STOCK, (status) => takesNoStock(found.name, status))
}
