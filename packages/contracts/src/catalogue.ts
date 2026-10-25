// The master data a service is described in, on the wire (Issue #78): the
// waste fractions a company collects, the container types it owns, the
// cadences a project offers, and the Products a Subscription names. Each of
// them is a company's or a project's own vocabulary, not the code's — one
// company's "Plast/MDK" is another's "Hard plastic" — where the kinds,
// statuses and units beside them are closed lists from
// @waste/domain/registry/vocabulary, the same in every company and read from
// there so the enum at this boundary and the CHECK in the table cannot drift.
//
// A waste fraction has two names: `key`, the stable slug the rest of the
// system quotes, and `name`, what a person reads and may rename without
// breaking anything. The key is held to a lowercase slug here because the
// database holds it lowercase and unique per company, and two keys that
// differ by case or a space would be two rows nobody can tell apart. It is
// set once: the patch takes the name alone, because a report, a fixture or an
// import that quotes the old key would go on quoting it, and a fraction that
// needs another key is another fraction.
//
// `ServiceFrequency` carries the rule its table carries
// (`service_frequency_shape`): an interval needs a rate to belong to, and the
// two intervals are two ways of saying the same thing. It is spelled once as
// `serviceFrequencyShape` and applied three times, because a body refused at
// the boundary is a 400 naming the rule where the same body refused by the
// check constraint is a 500 naming nothing. The sentence it is refused with
// is exported too (`ONE_CADENCE`): a patch carries only a part of the
// picture, so the route holds it against the stored row, and one rule that
// two places can refuse should not have two ways of saying so.
//
// A Product's container type, waste fraction and frequency are all optional:
// only a container collection has a container and a fraction, and the
// frequency is a default a placement may override — the effective one is read
// through a coalesce and never copied. Prices are not here: a Price List and
// its rows are Finance & Contracting's (price-lists.ts). A product's invoice
// name, invoice code and VAT rate did come here with them (Issue #112), each
// nullable: what an invoice line calls the product, the code an external
// ledger books it under, and the whole-percent rate a billable event is
// priced at — zero being exempt, and a product without one blocking its
// events with `no-vat-rate`, which is the actionable reason.
import { DENSITY_KG_PER_CUBIC_METRE, SERVICE_SECONDS } from "@waste/domain/execution/workload"
import { FREE_DAYS_MAX, HIRE_UNIT } from "@waste/domain/finance/hire"
import { PRODUCT_KINDS, PRODUCT_STATUSES, PRODUCT_UNITS, WASTE_TREATMENTS } from "@waste/domain/registry/vocabulary"
import { WASTE_CODE_PATTERN, WASTE_CODE_SHAPE } from "@waste/domain/registry/waste-code"
import * as z from "zod"

import { Id } from "./ids"
import { changesSomething, PositiveInt, somethingToChange, stamped } from "./resource"
import { Label, Paragraph, Slug } from "./text"

/** What a Product delivers. */
export const ProductKind = z.enum(PRODUCT_KINDS)
export type ProductKind = z.infer<typeof ProductKind>

/** Where a Product stands in the catalogue; nothing gates a subscription on it today. */
export const ProductStatus = z.enum(PRODUCT_STATUSES)
export type ProductStatus = z.infer<typeof ProductStatus>

/** What one of a Product is: the unit its price is quoted per. */
export const ProductUnit = z.enum(PRODUCT_UNITS)
export type ProductUnit = z.infer<typeof ProductUnit>

/** A lowercase slug: `residual`, `food`, `hard-plastic` — the one key shape of text.ts. */
const FractionKey = Slug()

/** A fraction's entry of the European List of Waste, compact (`200301`, `200121*`): @waste/domain/registry/waste-code's shape, which the database's check reads too (#291 slice 29). */
export const WasteCode = z.string().regex(new RegExp(WASTE_CODE_PATTERN), WASTE_CODE_SHAPE)

/** How a fraction is treated once collected: the domain's list, the database's check. */
export const WasteTreatment = z.enum(WASTE_TREATMENTS)

/** A volume, a rate or an interval: a whole positive number, since zero is none of them. */
const Count = PositiveInt

/** What a cubic metre of a fraction weighs in a container, kg (O10 of #290): within the domain's bounds, the database's check. */
export const Density = z.int().min(DENSITY_KG_PER_CUBIC_METRE.min).max(DENSITY_KG_PER_CUBIC_METRE.max)

/** The seconds an emptying of a container type takes at the kerb (O10 of #290): within the domain's bounds, the database's check. */
export const ServiceSeconds = z.int().min(SERVICE_SECONDS.min).max(SERVICE_SECONDS.max)

export const WasteFraction = z.object({
  ...stamped,
  /** The stable slug the rest of the system quotes; unique per company. */
  key: FractionKey,
  /** What a person reads; unique per company. */
  name: Label,
  /** The European List of Waste entry the national waste-data system keys it by; null where nobody has set one. */
  wasteCode: WasteCode.nullable(),
  /** How it is treated once collected (M13 of #293), what the sustainability report's recycling rate reads; null where nobody has set one. */
  treatment: WasteTreatment.nullable(),
  /** What a cubic metre of it weighs in a container, kg (O10 of #290): a stop's expected weight is its container's litres times this; null where nobody has set one. */
  densityKgPerCubicMetre: Density.nullable(),
})
export type WasteFraction = z.infer<typeof WasteFraction>

export const WasteFractionCreate = z.strictObject({
  key: FractionKey,
  name: Label,
  wasteCode: WasteCode.nullable().optional(),
  treatment: WasteTreatment.nullable().optional(),
  densityKgPerCubicMetre: Density.nullable().optional(),
})
export type WasteFractionCreate = z.infer<typeof WasteFractionCreate>

/** The name, the waste code, the treatment and the density: the key is the slug the rest of the system quotes, and a fraction that needs another one is another fraction. Null clears the code, the treatment or the density. */
export const WasteFractionPatch = z
  .strictObject({
    name: Label.optional(),
    wasteCode: WasteCode.nullable().optional(),
    treatment: WasteTreatment.nullable().optional(),
    densityKgPerCubicMetre: Density.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type WasteFractionPatch = z.infer<typeof WasteFractionPatch>

export const ContainerType = z.object({
  ...stamped,
  name: Label,
  /** Null where nobody recorded one. */
  volumeLitres: Count.nullable(),
  /** The seconds an emptying of one takes at the kerb (O10 of #290), its stop's service time; null where nobody has set one. */
  serviceSeconds: ServiceSeconds.nullable(),
})
export type ContainerType = z.infer<typeof ContainerType>

export const ContainerTypeCreate = z.strictObject({
  name: Label,
  volumeLitres: Count.nullable().optional(),
  serviceSeconds: ServiceSeconds.nullable().optional(),
})
export type ContainerTypeCreate = z.infer<typeof ContainerTypeCreate>

export const ContainerTypePatch = z
  .strictObject({
    name: Label.optional(),
    volumeLitres: Count.nullable().optional(),
    serviceSeconds: ServiceSeconds.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type ContainerTypePatch = z.infer<typeof ContainerTypePatch>

/** The three numbers the shape rule is about, as a resource, a create body or a patch gives them. */
export type ServiceFrequencyShape = {
  collectionsPerWeek?: number | null
  weeksBetween?: number | null
  daysBetween?: number | null
}

/**
 * What a body that breaks the rule below is told, wherever it is caught. The
 * schemas here refuse a create body, which carries the whole picture; a patch
 * carries a part of it, so the route that has the stored row holds the two
 * together and refuses in these same words (apps/api/src/routes/catalogue.ts).
 * One rule, one sentence.
 */
export const ONE_CADENCE = "Give collectionsPerWeek with at most one of weeksBetween and daysBetween, or none of the three (on demand)"

/**
 * The definition's own rule, the one the database's `service_frequency_shape`
 * check holds: an interval needs a rate to belong to, and `weeksBetween` and
 * `daysBetween` are two ways of saying the same thing. A rate that was not
 * given at all is not judged — that is a patch leaving it alone, and only the
 * route, which has the stored row, can hold the rule against the two together.
 */
export function serviceFrequencyShape(value: ServiceFrequencyShape): boolean {
  const { collectionsPerWeek, weeksBetween, daysBetween } = value
  if (weeksBetween != null && daysBetween != null) return false
  if (collectionsPerWeek === undefined) return true
  return collectionsPerWeek !== null || (weeksBetween == null && daysBetween == null)
}

/** A create body says on demand by leaving the rate out, so an absent field reads as the null the row will hold. */
const asStored = (body: ServiceFrequencyShape): ServiceFrequencyShape => ({
  collectionsPerWeek: body.collectionsPerWeek ?? null,
  weeksBetween: body.weeksBetween ?? null,
  daysBetween: body.daysBetween ?? null,
})

const oneCadence = { message: ONE_CADENCE }

/** The cadence a project offers, the domain's `ServiceFrequencyDefinition` as a row. */
export const ServiceFrequency = z
  .object({
    ...stamped,
    projectId: Id,
    name: Label,
    description: Paragraph.nullable(),
    /** Null is on demand; 1 with neither interval is monthly, since a month is not a number of weeks. */
    collectionsPerWeek: Count.nullable(),
    /** Once a week or less often. */
    weeksBetween: Count.nullable(),
    /** More often than once a week. */
    daysBetween: Count.nullable(),
  })
  .refine(serviceFrequencyShape, oneCadence)
export type ServiceFrequency = z.infer<typeof ServiceFrequency>

export const ServiceFrequencyCreate = z
  .strictObject({
    projectId: Id,
    name: Label,
    description: Paragraph.nullable().optional(),
    collectionsPerWeek: Count.nullable().optional(),
    weeksBetween: Count.nullable().optional(),
    daysBetween: Count.nullable().optional(),
  })
  .refine((body) => serviceFrequencyShape(asStored(body)), oneCadence)
export type ServiceFrequencyCreate = z.infer<typeof ServiceFrequencyCreate>

export const ServiceFrequencyPatch = z
  .strictObject({
    name: Label.optional(),
    description: Paragraph.nullable().optional(),
    collectionsPerWeek: Count.nullable().optional(),
    weeksBetween: Count.nullable().optional(),
    daysBetween: Count.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
  .refine(serviceFrequencyShape, oneCadence)
export type ServiceFrequencyPatch = z.infer<typeof ServiceFrequencyPatch>

/** A VAT rate in whole percent: zero is exempt, and nothing is taxed at more than the whole (Issue #112). */
const VatPercent = z.int().min(0).max(100)

/** A hire product's free days (M14 of #293): each placement's first days, charged nothing; none to a year. */
const FreeDays = z.int().min(0).max(FREE_DAYS_MAX)

/** What a product sold by anything but the day is told of free days. */
export const FREE_DAYS_ARE_A_HIRES = "Free days are a hire product's: sell it by the day, or give it none"

export const Product = z.object({
  ...stamped,
  projectId: Id,
  name: Label,
  kind: ProductKind,
  status: ProductStatus,
  unit: ProductUnit,
  /** A container collection's type; null for a service. */
  containerTypeId: Id.nullable(),
  /** A container collection's fraction; null for a service. */
  wasteFractionId: Id.nullable(),
  /** The default cadence a placement may override; null where the Product has none. */
  serviceFrequencyId: Id.nullable(),
  /** What an invoice line calls the product (Issue #112); the name when null. */
  invoiceName: Label.nullable(),
  /** The code an external ledger books the product under; unique per project where given. */
  invoiceCode: Label.nullable(),
  /** The rate a billable event is priced at; a product without one blocks its events with `no-vat-rate`. */
  vatPercent: VatPercent.nullable(),
  /** A hire product's free days (M14 of #293): each placement's first days on site, charged nothing; null for none, and for every product not sold by the day. */
  freeDays: FreeDays.nullable(),
})
export type Product = z.infer<typeof Product>

export const ProductCreate = z.strictObject({
  projectId: Id,
  name: Label,
  kind: ProductKind,
  status: ProductStatus.default("draft").describe("Defaults to draft when absent: a Product is written before it is offered, and only an active one can be subscribed to."),
  unit: ProductUnit,
  containerTypeId: Id.nullable().optional(),
  wasteFractionId: Id.nullable().optional(),
  serviceFrequencyId: Id.nullable().optional(),
  invoiceName: Label.nullable().optional(),
  invoiceCode: Label.nullable().optional(),
  vatPercent: VatPercent.nullable().optional(),
  freeDays: FreeDays.nullable().optional(),
}).refine((body) => body.freeDays == null || body.unit === HIRE_UNIT, { message: FREE_DAYS_ARE_A_HIRES, path: ["freeDays"] })
export type ProductCreate = z.infer<typeof ProductCreate>

export const ProductPatch = z
  .strictObject({
    name: Label.optional(),
    kind: ProductKind.optional(),
    status: ProductStatus.optional(),
    unit: ProductUnit.optional(),
    containerTypeId: Id.nullable().optional(),
    wasteFractionId: Id.nullable().optional(),
    serviceFrequencyId: Id.nullable().optional(),
    invoiceName: Label.nullable().optional(),
    invoiceCode: Label.nullable().optional(),
    vatPercent: VatPercent.nullable().optional(),
    /** Null clears them; a product with free days keeps the day, which the route judges against the stored unit. */
    freeDays: FreeDays.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type ProductPatch = z.infer<typeof ProductPatch>
