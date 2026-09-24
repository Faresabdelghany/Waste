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
// differ by case or a space would be two rows nobody can tell apart.
//
// `ServiceFrequency` carries the rule its table carries
// (`service_frequency_shape`): an interval needs a rate to belong to, and the
// two intervals are two ways of saying the same thing. It is spelled once as
// `serviceFrequencyShape` and applied three times, because a body refused at
// the boundary is a 400 naming the rule where the same body refused by the
// check constraint is a 500 naming nothing.
//
// A Product's container type, waste fraction and frequency are all optional:
// only a container collection has a container and a fraction, and the
// frequency is a default a placement may override — the effective one is read
// through a coalesce and never copied. Prices are not here: a Price List and
// its rows are Finance & Contracting's.
import { PRODUCT_KINDS, PRODUCT_STATUSES, PRODUCT_UNITS } from "@waste/domain/registry/vocabulary"
import * as z from "zod"

import { Id } from "./ids"
import { changesSomething, somethingToChange, stamped } from "./resource"
import { Label, Paragraph } from "./text"

/** What a Product delivers. */
export const ProductKind = z.enum(PRODUCT_KINDS)
export type ProductKind = z.infer<typeof ProductKind>

/** Whether a Product may be subscribed to. */
export const ProductStatus = z.enum(PRODUCT_STATUSES)
export type ProductStatus = z.infer<typeof ProductStatus>

/** What one of a Product is: the unit its price is quoted per. */
export const ProductUnit = z.enum(PRODUCT_UNITS)
export type ProductUnit = z.infer<typeof ProductUnit>

/** The longest a fraction key may be. A slug, not a sentence. */
const KEY_MAX = 50

/** A lowercase slug: `residual`, `food`, `hard-plastic`. */
const FractionKey = z
  .string()
  .max(KEY_MAX)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "a lowercase slug of letters, digits and single hyphens, such as food or hard-plastic")

/** A volume, a rate or an interval: a whole positive number, since zero is none of them. */
const Count = z.int().positive()

export const WasteFraction = z.object({
  ...stamped,
  /** The stable slug the rest of the system quotes; unique per company. */
  key: FractionKey,
  /** What a person reads; unique per company. */
  name: Label,
})
export type WasteFraction = z.infer<typeof WasteFraction>

export const WasteFractionCreate = z.strictObject({
  key: FractionKey,
  name: Label,
})
export type WasteFractionCreate = z.infer<typeof WasteFractionCreate>

export const WasteFractionPatch = z
  .strictObject({
    key: FractionKey.optional(),
    name: Label.optional(),
  })
  .refine(changesSomething, somethingToChange)
export type WasteFractionPatch = z.infer<typeof WasteFractionPatch>

export const ContainerType = z.object({
  ...stamped,
  name: Label,
  /** Null where nobody recorded one. */
  volumeLitres: Count.nullable(),
})
export type ContainerType = z.infer<typeof ContainerType>

export const ContainerTypeCreate = z.strictObject({
  name: Label,
  volumeLitres: Count.nullable().optional(),
})
export type ContainerTypeCreate = z.infer<typeof ContainerTypeCreate>

export const ContainerTypePatch = z
  .strictObject({
    name: Label.optional(),
    volumeLitres: Count.nullable().optional(),
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

const oneCadence = {
  message: "Give collectionsPerWeek with at most one of weeksBetween and daysBetween, or none of the three (on demand)",
}

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
})
export type Product = z.infer<typeof Product>

export const ProductCreate = z.strictObject({
  projectId: Id,
  name: Label,
  kind: ProductKind,
  status: ProductStatus.default("draft").describe("Defaults to draft when absent: a Product is not subscribed to until someone says it may be."),
  unit: ProductUnit,
  containerTypeId: Id.nullable().optional(),
  wasteFractionId: Id.nullable().optional(),
  serviceFrequencyId: Id.nullable().optional(),
})
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
  })
  .refine(changesSomething, somethingToChange)
export type ProductPatch = z.infer<typeof ProductPatch>
