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
import { CHANGE_NAMES_SOMETHING, ONE_PLACE } from "@waste/domain/registry/agreements"
import { AGREEMENT_STATUSES, BILLING_CADENCES } from "@waste/domain/registry/vocabulary"
import { placesNamed } from "@waste/domain/registry/served-places"
import * as z from "zod"

import { Currency } from "./codes"
import { IsoDate } from "./dates"
import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { ProjectScopedListQuery } from "./queries"
import { PositiveInt, stamped } from "./resource"
import { TimeWindow } from "./shifts"
import { Label, Paragraph } from "./text"
import { effectiveDated, effectiveDatedBodies } from "./validity"

/** Where the Agreement stands; expiry is a reading of the period, never a status. */
export const AgreementStatus = z.enum(AGREEMENT_STATUSES)
export type AgreementStatus = z.infer<typeof AgreementStatus>

export const BillingCadence = z.enum(BILLING_CADENCES)
export type BillingCadence = z.infer<typeof BillingCadence>

/** A count of one thing subscribed to: whole and positive, since zero of a product is no subscription. */
const Quantity = PositiveInt

export const Agreement = effectiveDated(
  z.object({
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
    /** The Price List the agreement is priced under (Issue #112), a list of the project in the agreement's currency; null is the project's default list. */
    priceListId: Id.nullable(),
    /** The window the agreement promises its stops are served in (O14 of #290), on the project's clock; null is any time. A stop's window is where it and its property's access hours overlap. */
    serviceWindow: TimeWindow.nullable(),
  }),
)
export type Agreement = z.infer<typeof Agreement>

/**
 * The price list is a list of the project in the agreement's currency,
 * absent or null the project's default; the service window is written whole,
 * absent or null any time of the day. Amending an agreement changes the row,
 * the audit log being its history; a patch's null clears the list or the
 * window, and reopens the period. Whether the new period still contains its
 * subscriptions' is the route's question.
 */
const agreementBodies = effectiveDatedBodies(
  {
    projectId: Id,
    number: Label,
    customerId: Id,
    payerCustomerId: Id,
    status: AgreementStatus.default("draft").describe("Defaults to draft when absent: an agreement is written before it is signed."),
    billingCadence: BillingCadence,
    currency: Currency,
    notes: Paragraph.nullable().optional(),
    priceListId: Id.nullable().optional(),
    serviceWindow: TimeWindow.nullable().optional(),
  },
  { createOnly: { projectId: true } },
)

export const AgreementCreate = agreementBodies.create
export type AgreementCreate = z.infer<typeof AgreementCreate>

export const AgreementPatch = agreementBodies.patch
export type AgreementPatch = z.infer<typeof AgreementPatch>

export const Subscription = effectiveDated(
  z.object({
    ...stamped,
    projectId: Id,
    agreementId: Id,
    productId: Id,
    /** The place, where it is a Property; null when it is a Point. */
    propertyId: Id.nullable(),
    /** The place, where it is a Shared Collection Point; null when it is a Property. */
    sharedCollectionPointId: Id.nullable(),
    quantity: Quantity,
  }),
)
export type Subscription = z.infer<typeof Subscription>

/**
 * The agreement is the path's and the project is the agreement's, so neither
 * is here. Either place may be given as null: a form with both fields sends
 * the one it has and null for the other, and the resource says null too, so
 * refusing it would refuse the natural body for no reason the rule cares
 * about — `placesNamed` counts a null as a place not given. The place and the
 * product do not change: a patch ends this subscription's period, and the one
 * that replaces it is written.
 */
const subscriptionBodies = effectiveDatedBodies(
  {
    productId: Id,
    propertyId: Id.nullable().optional(),
    sharedCollectionPointId: Id.nullable().optional(),
    quantity: Quantity.default(1).describe("Defaults to one when absent: one of the product at the place."),
  },
  { createOnly: { productId: true, propertyId: true, sharedCollectionPointId: true } },
)

export const SubscriptionCreate = subscriptionBodies.create.refine((body) => placesNamed(body) === 1, { message: ONE_PLACE })
export type SubscriptionCreate = z.infer<typeof SubscriptionCreate>

export const SubscriptionPatch = subscriptionBodies.patch
export type SubscriptionPatch = z.infer<typeof SubscriptionPatch>

/**
 * A change of service (#291, slice 10, scenario 12.4): the subscription ends
 * on `on` and the one replacing it begins there, at the same place under the
 * same agreement, with the product or the quantity the body names — what it
 * leaves out is the subscription's — and every container serving it serves
 * the replacement from `on`. Nothing moves physically, so no stock movement
 * is written. `on` lies inside the subscription's period, after its first
 * day; whether the body changes anything is the route's to judge, since only
 * it sees the stored row.
 */
export const SubscriptionChange = z
  .strictObject({
    /** The replacement's first day: the first day the subscription is no longer in force. */
    on: IsoDate,
    productId: Id.optional(),
    quantity: Quantity.optional(),
  })
  .refine((body) => body.productId !== undefined || body.quantity !== undefined, { message: CHANGE_NAMES_SOMETHING })
export type SubscriptionChange = z.infer<typeof SubscriptionChange>

/**
 * A termination (#291, slice 10, scenario 12.6): the agreement, every
 * subscription in force past `on` and every placement serving them end
 * together on `on`, the first day none of them is in force. A container stays
 * in service until it is returned — a termination ends the service, and the
 * bin stays until someone removes it.
 */
export const AgreementTermination = z.strictObject({
  on: IsoDate,
})
export type AgreementTermination = z.infer<typeof AgreementTermination>

/**
 * A stop still standing at a container a command took out of service, which
 * no generation run will take away: one on a dispatched or running route,
 * which generation never refreshes, or the office's own on a planned one,
 * which it never touches. The office removes it by hand.
 */
export const StopToRemove = z.object({
  routeId: Id,
  /** `RC-1042`. */
  routeLabel: z.string(),
  operatingDate: IsoDate,
  pickupId: Id,
  containerId: Id,
})
export type StopToRemove = z.infer<typeof StopToRemove>

/** What a termination answers: the agreement as it now stands, and the stops still standing at its containers from `on`, oldest first. */
export const AgreementTerminated = z.object({
  agreement: Agreement,
  stopsToRemove: z.array(StopToRemove),
})
export type AgreementTerminated = z.infer<typeof AgreementTerminated>

/**
 * A Subscription's pause (#291, slice 10, scenario 12.5): an effective-dated
 * suspension — a holiday, a season — through which no stop is generated for
 * the containers serving it. Half-open like every period: `validTo` is the
 * day collections resume, and an open end is a pause until the office
 * resumes it. One pause of a subscription is in force at a time, inside the
 * subscription's period; the project is the subscription's.
 */
export const SubscriptionPause = effectiveDated(
  z.object({
    ...stamped,
    projectId: Id,
    subscriptionId: Id,
  }),
)
export type SubscriptionPause = z.infer<typeof SubscriptionPause>

/**
 * A pause's period; the subscription is the path's (`POST
 * /subscriptions/:id/pauses`). It begins today or later, which only the route
 * can judge. Moving one moves its first day while it has not begun, and its
 * end — the day collections resume, a resume today included — while it has
 * not ended; a null end leaves it open, a pause until it is resumed.
 */
const subscriptionPauseBodies = effectiveDatedBodies({})

export const SubscriptionPauseCreate = subscriptionPauseBodies.create
export type SubscriptionPauseCreate = z.infer<typeof SubscriptionPauseCreate>

export const SubscriptionPausePatch = subscriptionPauseBodies.patch
export type SubscriptionPausePatch = z.infer<typeof SubscriptionPausePatch>

/** `POST /subscription-pauses/:id/cancel`: a pause that has not begun, removed. Takes nothing. */
export const SubscriptionPauseCancel = z.strictObject({})
export type SubscriptionPauseCancel = z.infer<typeof SubscriptionPauseCancel>

/** What a pause written or moved answers: the pause as it now stands, and the stops still standing at its containers on its days that no run will take away, oldest first. */
export const SubscriptionPaused = z.object({
  pause: SubscriptionPause,
  stopsToRemove: z.array(StopToRemove),
})
export type SubscriptionPaused = z.infer<typeof SubscriptionPaused>

/** A page of pauses (`GET /subscription-pauses`): one project's, one subscription's, in force on a day. */
export const SubscriptionPauseListQuery = ProjectScopedListQuery.extend({
  subscriptionId: Id.optional(),
  validOn: IsoDate.optional(),
})
export type SubscriptionPauseListQuery = z.infer<typeof SubscriptionPauseListQuery>

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

/**
 * A page of subscriptions across agreements (`GET /subscriptions`, Issue
 * #183): one project's, one agreement's, valid on a day — the flat list a
 * client that holds a module whole reads once, as placements are read across
 * containers, where the list under an agreement answers one agreement's.
 */
export const SubscriptionsQuery = ProjectScopedListQuery.extend({
  agreementId: Id.optional(),
  validOn: IsoDate.optional(),
})
export type SubscriptionsQuery = z.infer<typeof SubscriptionsQuery>
