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
// two intervals are two ways of saying the same thing. The rule and its
// sentence are the domain's (@waste/domain/registry/catalogue), applied here
// three times, because a body refused at the boundary is a 400 naming the
// rule where the same body refused by the check constraint is a 500 naming
// nothing; a patch carries only a part of the picture, so the route holds it
// against the stored row in the same words.
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
import { FREE_DAYS_ARE_A_HIRES, FREE_DAYS_MAX, HIRE_UNIT } from "@waste/domain/finance/hire"
import { ONE_CADENCE, serviceFrequencyShape, VAT_PERCENT, type ServiceFrequencyShape } from "@waste/domain/registry/catalogue"
import { PRODUCT_KINDS, PRODUCT_STATUSES, PRODUCT_UNITS, WASTE_TREATMENTS } from "@waste/domain/registry/vocabulary"
import { HAZARDOUS_CODE, hazardousAgrees, WASTE_CODE_PATTERN, WASTE_CODE_SHAPE } from "@waste/domain/registry/waste-code"
import * as z from "zod"

import { Id } from "./ids"
import { PositiveInt, resourceBodies, stamped } from "./resource"
import { Label, Paragraph, Slug } from "./text"

export const ProductKind = z.enum(PRODUCT_KINDS)
export type ProductKind = z.infer<typeof ProductKind>

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

/** A body naming a starred code and `hazardous: false` together contradicts the list (O18 of #290); a patch naming one of them is judged against the row by the API. */
const starredIsHazardous = (body: { wasteCode?: string | null; hazardous?: boolean }): boolean => body.hazardous !== false || hazardousAgrees(body.wasteCode ?? null, false)

export const WasteFraction = z.object({
  ...stamped,
  /** The stable slug the rest of the system quotes; unique per company. */
  key: FractionKey,
  /** What a person reads; unique per company. */
  name: Label,
  /** The European List of Waste entry the national waste-data system keys it by; null where nobody has set one. */
  wasteCode: WasteCode.nullable(),
  /** How it is treated once collected (M13 of #293); null where nobody has set one. */
  treatment: WasteTreatment.nullable(),
  /** What a cubic metre of it weighs in a container, kg (O10 of #290): a stop's expected weight is its container's litres times this; null where nobody has set one. */
  densityKgPerCubicMetre: Density.nullable(),
  /** Whether it is hazardous waste (O18 of #290), what its transfer note says: always under a starred waste code, and the office's call under any other or none. */
  hazardous: z.boolean(),
})
export type WasteFraction = z.infer<typeof WasteFraction>

/**
 * The key is the slug the rest of the system quotes, set once: a fraction
 * that needs another one is another fraction. A patch's null clears the code,
 * the treatment or the density. The hazardous flag left out of a create is
 * hazardous exactly where the waste code is starred; left out of a patch, a
 * starred code the patch sets makes the fraction hazardous and anything else
 * leaves the flag as it is.
 */
const wasteFractionBodies = resourceBodies(
  {
    key: FractionKey,
    name: Label,
    wasteCode: WasteCode.nullable().optional(),
    treatment: WasteTreatment.nullable().optional(),
    densityKgPerCubicMetre: Density.nullable().optional(),
    hazardous: z.boolean().optional(),
  },
  { createOnly: { key: true } },
)

export const WasteFractionCreate = wasteFractionBodies.create.refine(starredIsHazardous, { message: HAZARDOUS_CODE, path: ["hazardous"] })
export type WasteFractionCreate = z.infer<typeof WasteFractionCreate>

export const WasteFractionPatch = wasteFractionBodies.patch.refine(starredIsHazardous, { message: HAZARDOUS_CODE, path: ["hazardous"] })
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

const containerTypeBodies = resourceBodies({
  name: Label,
  volumeLitres: Count.nullable().optional(),
  serviceSeconds: ServiceSeconds.nullable().optional(),
})

export const ContainerTypeCreate = containerTypeBodies.create
export type ContainerTypeCreate = z.infer<typeof ContainerTypeCreate>

export const ContainerTypePatch = containerTypeBodies.patch
export type ContainerTypePatch = z.infer<typeof ContainerTypePatch>

/** A create body says on demand by leaving the rate out, so an absent field reads as the null the row will hold. */
const asStored = (body: ServiceFrequencyShape): ServiceFrequencyShape => ({
  collectionsPerWeek: body.collectionsPerWeek ?? null,
  weeksBetween: body.weeksBetween ?? null,
  daysBetween: body.daysBetween ?? null,
})

const oneCadence = { message: ONE_CADENCE }

/** The cadence a project offers, @waste/fixtures' `ServiceFrequencyDefinition` as a row. */
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

const serviceFrequencyBodies = resourceBodies(
  {
    projectId: Id,
    name: Label,
    description: Paragraph.nullable().optional(),
    collectionsPerWeek: Count.nullable().optional(),
    weeksBetween: Count.nullable().optional(),
    daysBetween: Count.nullable().optional(),
  },
  { createOnly: { projectId: true } },
)

export const ServiceFrequencyCreate = serviceFrequencyBodies.create.refine((body) => serviceFrequencyShape(asStored(body)), oneCadence)
export type ServiceFrequencyCreate = z.infer<typeof ServiceFrequencyCreate>

export const ServiceFrequencyPatch = serviceFrequencyBodies.patch.refine(serviceFrequencyShape, oneCadence)
export type ServiceFrequencyPatch = z.infer<typeof ServiceFrequencyPatch>

/** A VAT rate in whole percent (Issue #112, @waste/domain/registry/catalogue). */
const VatPercent = z.int().min(VAT_PERCENT.min).max(VAT_PERCENT.max)

/** A hire product's free days (M14 of #293): each placement's first days, charged nothing; none to a year. */
const FreeDays = z.int().min(0).max(FREE_DAYS_MAX)

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

/** A patch's null clears the free days; a product with free days keeps the day, which the route judges against the stored unit. */
const productBodies = resourceBodies(
  {
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
  },
  { createOnly: { projectId: true } },
)

export const ProductCreate = productBodies.create.refine((body) => body.freeDays == null || body.unit === HIRE_UNIT, { message: FREE_DAYS_ARE_A_HIRES, path: ["freeDays"] })
export type ProductCreate = z.infer<typeof ProductCreate>

export const ProductPatch = productBodies.patch
export type ProductPatch = z.infer<typeof ProductPatch>
