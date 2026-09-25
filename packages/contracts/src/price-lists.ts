// The Price List and its rows on the wire (Issue #112): "an effective-dated
// set of explainable customer pricing rules and price rows" (CONTEXT.md). A
// list is a project's tariff (`PL-CPH-2026`) or a named list an agreement is
// priced under; its `code` is a `Slug` set once, like a fraction's key, since
// a list's code is quoted like one; its `currency` is set once too, and every
// row's amount is in it — a default list in its project's currency and an
// agreement's list in the agreement's, which the route holds. `isDefault`
// names the one list an agreement without one is priced under, one per
// project whatever its period (the database's partial unique), so a new
// tariff year is new rows in it and not a second default list.
//
// A row is one price under a condition set: the product, the unit price in
// minor units, and up to five conditions — the prototype's Zone as a Planning
// Area, its Customer type as the Registry's customer kind, a container type,
// a waste fraction, and the negotiated customer a row is for alone — each
// nullable, since the default price is a row with no conditions. The
// prototype's scheduled amount, from and revert-on are a second row with its
// own period (ADR-0005), the exclusion constraint keeping the two apart; the
// generated `condition_key` that constraint keys on is the database's device
// and never on the wire. A row's patch moves its price, its note and its end
// — a condition or a start never, since they are the key and the period: end
// the row and add another. Whether a row's period lies inside its list's is
// the route's question (routes/periods.ts).
//
// `GET /price-lists/:id/resolve` is the read a person makes of the resolver
// (@waste/domain/finance/pricing): `PriceResolveQuery` names the product, the
// day and the conditions, and `PriceResolution` answers every row's verdict —
// eligible or not, why not, what it matched, its score, whether it won — so
// the office sees why a row lost, beside the winner's price, the product's
// VAT rate and the list's currency.
import { CustomerKind } from "./customers"
import { IsoDate } from "./dates"
import { Id } from "./ids"
import { Currency } from "./organisation"
import { PageRequest } from "./pagination"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, Minor, NonNegativeMinor, somethingToChange, stamped } from "./resource"
import { Label, Paragraph, Slug } from "./text"
import { endsAfterItStarts, Validity, ValidityCreate, validityOrdered } from "./validity"
import * as z from "zod"

/** The stable code a person quotes, `PL-CPH-2026` spelled as a slug: `pl-cph-2026`. The one key shape of text.ts. */
const PriceListCode = Slug()

export const PriceList = z
  .object({
    ...stamped,
    projectId: Id,
    /** Set once; one list of a code in force at a time. */
    code: PriceListCode,
    name: Label,
    /** ISO 4217, set once; every row's amount is in it. */
    currency: Currency,
    /** The list an agreement without one is priced under: one per project. */
    isDefault: z.boolean(),
    notes: Paragraph.nullable(),
    ...Validity.shape,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type PriceList = z.infer<typeof PriceList>

/** `POST /price-lists`: the currency is the project's when absent, and must be the project's when the list is the default. */
export const PriceListCreate = z
  .strictObject({
    projectId: Id,
    code: PriceListCode,
    name: Label,
    currency: Currency.optional().describe("The project's currency when absent; a default list is always in it."),
    isDefault: z.boolean().default(false).describe("Defaults to false when absent: a named list an agreement is priced under, not the project's tariff."),
    notes: Paragraph.nullable().optional(),
    ...ValidityCreate,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type PriceListCreate = z.infer<typeof PriceListCreate>

/** `PATCH /price-lists/:id`: the name, the default flag, the notes and the period; never the code or the currency, which the rows are quoted in. */
export const PriceListPatch = z
  .strictObject({
    name: Label.optional(),
    isDefault: z.boolean().optional(),
    notes: Paragraph.nullable().optional(),
    validFrom: IsoDate.optional(),
    /** Null reopens the period; a day ends it. */
    validTo: IsoDate.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
  .refine(validityOrdered, endsAfterItStarts)
export type PriceListPatch = z.infer<typeof PriceListPatch>

/** The five conditions a row may name, each null where it names none; `conditionKey` is the database's and not here. */
const conditions = {
  /** The prototype's Zone: matched against the route's scheme's planning area. */
  planningAreaId: Id.nullable(),
  /** The prototype's Customer type: matched against the agreement's customer's kind. */
  customerKind: CustomerKind.nullable(),
  containerTypeId: Id.nullable(),
  wasteFractionId: Id.nullable(),
  /** The negotiated row: eligible for this customer alone, and always winning for them. */
  customerId: Id.nullable(),
}

export const PriceListRow = z
  .object({
    ...stamped,
    projectId: Id,
    priceListId: Id,
    productId: Id,
    /** Per the product's unit, in the list's currency; a free service is a price of zero. */
    unitPriceMinor: NonNegativeMinor,
    ...conditions,
    note: Paragraph.nullable(),
    ...Validity.shape,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type PriceListRow = z.infer<typeof PriceListRow>

/** `POST /price-lists/:id/rows`: the list is the path's and the project the list's, so neither is here; every condition may be given as null, the two-field convention. */
export const PriceListRowCreate = z
  .strictObject({
    productId: Id,
    unitPriceMinor: NonNegativeMinor,
    planningAreaId: Id.nullable().optional(),
    customerKind: CustomerKind.nullable().optional(),
    containerTypeId: Id.nullable().optional(),
    wasteFractionId: Id.nullable().optional(),
    customerId: Id.nullable().optional(),
    note: Paragraph.nullable().optional(),
    ...ValidityCreate,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type PriceListRowCreate = z.infer<typeof PriceListRowCreate>

/** `PATCH /price-list-rows/:id`: the price, the note and the end; a condition or the start never, since they are the key and the period — end the row and add another. */
export const PriceListRowPatch = z
  .strictObject({
    unitPriceMinor: NonNegativeMinor.optional(),
    note: Paragraph.nullable().optional(),
    /** Null reopens the row; a day ends it. */
    validTo: IsoDate.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type PriceListRowPatch = z.infer<typeof PriceListRowPatch>

/** A page of lists: one project's, in force on a day, the default one. */
export const PriceListListQuery = ProjectScopedListQuery.extend({
  /** The day the period is read against; absent asks for every list, whenever it ran. */
  validOn: IsoDate.optional(),
  /** A query string spells a boolean as `true` or `false`, exactly. */
  isDefault: z.stringbool({ truthy: ["true"], falsy: ["false"], case: "sensitive" }).optional(),
})
export type PriceListListQuery = z.infer<typeof PriceListListQuery>

/** A page of one list's rows (`GET /price-lists/:id/rows`): for one product, in force on a day. */
export const PriceListRowListQuery = PageRequest.extend({
  productId: Id.optional(),
  validOn: IsoDate.optional(),
})
export type PriceListRowListQuery = z.infer<typeof PriceListRowListQuery>

/** `GET /price-lists/:id/resolve`: the product, the day, and the conditions the rows are judged against — the caller names them, and the read looks at no agreement. */
export const PriceResolveQuery = z.object({
  productId: Id,
  /** The day the price is resolved on: the pickup's service date, or the day a person asks about. */
  on: IsoDate,
  planningAreaId: Id.optional(),
  customerKind: CustomerKind.optional(),
  containerTypeId: Id.optional(),
  wasteFractionId: Id.optional(),
  customerId: Id.optional(),
})
export type PriceResolveQuery = z.infer<typeof PriceResolveQuery>

/** One row's verdict: the domain's `RowVerdict` on the wire. */
export const RowVerdict = z.object({
  row: PriceListRow,
  eligible: z.boolean(),
  /** The sentence a row lost with; null for an eligible row. */
  reason: z.string().nullable(),
  /** What the row matched, in the order judged. */
  matched: z.string().array(),
  /** Conditions named plus one hundred for a negotiated row; -1 for a row that is not eligible. */
  score: z.int(),
  winner: z.boolean(),
})
export type RowVerdict = z.infer<typeof RowVerdict>

/** What the resolve read answers: every verdict, the winner first, the winning price, the product's VAT rate and the list's currency. */
export const PriceResolution = z.object({
  verdicts: z.array(RowVerdict),
  winner: RowVerdict.nullable(),
  /** The winner's unit price; null when no row is eligible. */
  unitPriceMinor: Minor.nullable(),
  /** The product's rate on the day; null where the product has none, which would block the event with `no-vat-rate`. */
  vatPercent: z.int().nullable(),
  currency: Currency,
})
export type PriceResolution = z.infer<typeof PriceResolution>
