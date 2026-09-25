// What the company pays a provider per product under an assignment, on the
// wire (Issue #112): "the contractually locked bid and the indexed current
// fee". A price is effective-dated, and an indexation is a **new row**, never
// an update — the fee on a day is a `validOn` read, so a settlement
// recalculated for March after a June indexation reads March's fee, and the
// prototype's indexation history is the chain of rows through
// `indexedFromId`. The bid is set on the first row of a chain and copied onto
// every indexed row, so the patch never takes it; the fee moves through
// `POST /service-provider-prices/:id/index` alone, which ends this row on
// `appliedFrom` and writes the next from it with the new fee (the domain's
// `indexedFee`, half away from zero), the label, the basis points — negative
// allowed, a deflator — and what was multiplied. The currency is the
// project's and not on the create. Whether a price's period lies inside its
// assignment's is the route's question. A Service Provider's manager reads
// the prices of its own assignments through the list, bounded by the route.
import { IsoDate } from "./dates"
import { IndexBase } from "./finance"
import { Id } from "./ids"
import { Currency } from "./organisation"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, NonNegativeMinor, somethingToChange, stamped } from "./resource"
import { Label, Paragraph } from "./text"
import { endsAfterItStarts, Validity, ValidityCreate, validityOrdered } from "./validity"
import * as z from "zod"

export const ServiceProviderPrice = z
  .object({
    ...stamped,
    projectId: Id,
    /** The award priced: provider and area at once. */
    serviceAreaAssignmentId: Id,
    productId: Id,
    /** The contractually locked bid, set on the first row of a chain and copied onto every indexed row. */
    bidMinor: NonNegativeMinor,
    /** The current fee, per the product's unit, in the project's currency. */
    unitPriceMinor: NonNegativeMinor,
    currency: Currency,
    /** The row this one was indexed from; null on the first row of a chain. */
    indexedFromId: Id.nullable(),
    /** What the indexation was: `CPI`. */
    indexLabel: Label.nullable(),
    /** 500 for +5 %; a negative figure is a deflator. */
    indexBasisPoints: z.int().nullable(),
    /** What was multiplied: the bid, or the fee it replaced. */
    indexBase: IndexBase.nullable(),
    notes: Paragraph.nullable(),
    ...Validity.shape,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type ServiceProviderPrice = z.infer<typeof ServiceProviderPrice>

/** `POST /service-provider-prices`: the first row of a chain; the fee is the bid when absent, the currency the project's. */
export const ServiceProviderPriceCreate = z
  .strictObject({
    serviceAreaAssignmentId: Id,
    productId: Id,
    bidMinor: NonNegativeMinor,
    unitPriceMinor: NonNegativeMinor.optional().describe("The bid when absent: a price starts at what was bid."),
    notes: Paragraph.nullable().optional(),
    ...ValidityCreate,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type ServiceProviderPriceCreate = z.infer<typeof ServiceProviderPriceCreate>

/** `PATCH /service-provider-prices/:id`: the notes and the end; the bid never, the fee by `index` alone. */
export const ServiceProviderPricePatch = z
  .strictObject({
    notes: Paragraph.nullable().optional(),
    /** Null reopens the price; a day ends it. */
    validTo: IsoDate.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type ServiceProviderPricePatch = z.infer<typeof ServiceProviderPricePatch>

/** `POST /service-provider-prices/:id/index`: the indexation as a new row from `appliedFrom`, this row ended on it. */
export const ServiceProviderPriceIndex = z.strictObject({
  /** What the indexation is: `CPI`. */
  label: Label,
  /** 500 for +5 %; negative allowed, a deflator. */
  basisPoints: z.int(),
  base: IndexBase,
  /** The first day the new fee holds: after this row's start, and inside its period when it has an end. */
  appliedFrom: IsoDate,
})
export type ServiceProviderPriceIndex = z.infer<typeof ServiceProviderPriceIndex>

/** A page of prices: one project's, one assignment's, one provider's, one product's, in force on a day. */
export const ServiceProviderPriceListQuery = ProjectScopedListQuery.extend({
  serviceAreaAssignmentId: Id.optional(),
  /** The prices under every assignment naming this provider. */
  serviceProviderId: Id.optional(),
  productId: Id.optional(),
  validOn: IsoDate.optional(),
})
export type ServiceProviderPriceListQuery = z.infer<typeof ServiceProviderPriceListQuery>
