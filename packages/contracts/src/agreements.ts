// What a Customer is entitled to, and until when (Issue #78). These are the
// first effective-dated resources of the system (ADR-0005): each carries the
// period it is in force for instead of a status that says the same thing
// later and worse, and the database refuses two of the same thing at once
// with an exclusion constraint over that period.
//
// `number` is the number a person quotes (`AGR-2408`) and is deliberately not
// unique: one agreement of that number may be valid at a time, so a number
// may name a later agreement once the earlier one has ended. "Pending",
// "expiring", "expired" and "terminated" are readings of the period against a
// day and none of them is a status here; `AgreementListQuery.validOn` is how
// a caller asks for one.
//
// A Subscription is one Product delivered at one place under one Agreement.
// The place is a Property or a Shared Collection Point, exactly one of the
// two, which the create body says as a rule and the database says as a check;
// `location_id`, the generated column its exclusion constraint keys on, is
// the database's device and is not on the wire. The agreement is the path's
// (`POST /agreements/:id/subscriptions`) and the project is the agreement's,
// so a create body names neither: an id in two places is an id that can
// disagree with itself.
//
// Neither patch carries the place or the product: a subscription that moves
// is a subscription that ended and another that began, which is what the
// period is for. And neither patch can say whether the new period still lies
// inside the agreement's, or the agreement's inside its subscriptions' —
// Postgres cannot hold that across rows without a trigger and this schema
// cannot see the stored row, so the route holds it.
import { AGREEMENT_STATUSES, BILLING_CADENCES } from "@waste/domain/registry/vocabulary"
import * as z from "zod"

import { IsoDate } from "./dates"
import { Id } from "./ids"
import { Currency } from "./organisation"
import { PageRequest } from "./pagination"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, somethingToChange, stamped } from "./resource"
import { Label, Paragraph } from "./text"
import { endsAfterItStarts, Validity, ValidityCreate, validityOrdered } from "./validity"

/** Where the Agreement stands; expiry is a reading of the period, never a status. */
export const AgreementStatus = z.enum(AGREEMENT_STATUSES)
export type AgreementStatus = z.infer<typeof AgreementStatus>

/** How often the Agreement is billed. */
export const BillingCadence = z.enum(BILLING_CADENCES)
export type BillingCadence = z.infer<typeof BillingCadence>

/** A count of one thing subscribed to: whole and positive, since zero of a product is no subscription. */
const Quantity = z.int().positive()

export const Agreement = z
  .object({
    ...stamped,
    projectId: Id,
    /** The number a person quotes: `AGR-2408`. Unique among the agreements valid at one time, which the database holds. */
    number: Label,
    customerId: Id,
    /** Who is invoiced; the same Customer as `customerId` in the common case, a housing administrator in the interesting one. */
    payerCustomerId: Id,
    status: AgreementStatus,
    billingCadence: BillingCadence,
    /** ISO 4217; the form defaults it to the project's. */
    currency: Currency,
    /** Internal, never the portal's. */
    notes: Paragraph.nullable(),
    ...Validity.shape,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type Agreement = z.infer<typeof Agreement>

export const AgreementCreate = z
  .strictObject({
    projectId: Id,
    number: Label,
    customerId: Id,
    payerCustomerId: Id,
    status: AgreementStatus.default("draft").describe("Defaults to draft when absent: an agreement is written before it is signed."),
    billingCadence: BillingCadence,
    currency: Currency,
    notes: Paragraph.nullable().optional(),
    ...ValidityCreate,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type AgreementCreate = z.infer<typeof AgreementCreate>

/** Amending an agreement changes the row; the audit log is its history. Whether the new period still contains its subscriptions' is the route's question. */
export const AgreementPatch = z
  .strictObject({
    number: Label.optional(),
    customerId: Id.optional(),
    payerCustomerId: Id.optional(),
    status: AgreementStatus.optional(),
    billingCadence: BillingCadence.optional(),
    currency: Currency.optional(),
    notes: Paragraph.nullable().optional(),
    validFrom: IsoDate.optional(),
    /** Null reopens the period; a day ends it. */
    validTo: IsoDate.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
  .refine(validityOrdered, endsAfterItStarts)
export type AgreementPatch = z.infer<typeof AgreementPatch>

export const Subscription = z
  .object({
    ...stamped,
    projectId: Id,
    agreementId: Id,
    productId: Id,
    /** The place, where it is a Property; null when it is a Point. */
    propertyId: Id.nullable(),
    /** The place, where it is a Shared Collection Point; null when it is a Property. */
    sharedCollectionPointId: Id.nullable(),
    quantity: Quantity,
    ...Validity.shape,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type Subscription = z.infer<typeof Subscription>

const onePlace = {
  message: "Give exactly one of propertyId and sharedCollectionPointId: a subscription is delivered at one place",
}
const exactlyOnePlace = (body: { propertyId?: string | null; sharedCollectionPointId?: string | null }) =>
  [body.propertyId, body.sharedCollectionPointId].filter((place) => place != null).length === 1

/**
 * The agreement is the path's and the project is the agreement's, so neither
 * is here. Either place may be given as null: a form with both fields sends
 * the one it has and null for the other, and the resource says null too, so
 * refusing it would refuse the natural body for no reason the rule cares
 * about — `exactlyOnePlace` counts a null as a place not given.
 */
export const SubscriptionCreate = z
  .strictObject({
    productId: Id,
    propertyId: Id.nullable().optional(),
    sharedCollectionPointId: Id.nullable().optional(),
    quantity: Quantity.default(1).describe("Defaults to one when absent: one of the product at the place."),
    ...ValidityCreate,
  })
  .refine(exactlyOnePlace, onePlace)
  .refine(validityOrdered, endsAfterItStarts)
export type SubscriptionCreate = z.infer<typeof SubscriptionCreate>

/** The place and the product do not change: end this subscription and write the one that replaces it. */
export const SubscriptionPatch = z
  .strictObject({
    quantity: Quantity.optional(),
    validFrom: IsoDate.optional(),
    validTo: IsoDate.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
  .refine(validityOrdered, endsAfterItStarts)
export type SubscriptionPatch = z.infer<typeof SubscriptionPatch>

/** A page of agreements: one project's, one customer's, by the number a person quoted, valid on a day. */
export const AgreementListQuery = ProjectScopedListQuery.extend({
  /** The agreements this customer holds; a payer's are found the same way. */
  customerId: Id.optional(),
  number: Label.optional(),
  /** The day the period is read against; absent asks for every agreement, whenever it ran. */
  validOn: IsoDate.optional(),
})
export type AgreementListQuery = z.infer<typeof AgreementListQuery>

/** A page of one agreement's subscriptions (`GET /agreements/:id/subscriptions`): the path says the agreement, so only the day is asked for. */
export const SubscriptionListQuery = PageRequest.extend({
  validOn: IsoDate.optional(),
})
export type SubscriptionListQuery = z.infer<typeof SubscriptionListQuery>
