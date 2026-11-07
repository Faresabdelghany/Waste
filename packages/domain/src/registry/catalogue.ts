// The catalogue's rules (Issue #97, #112): a service frequency's cadence and a
// product's VAT rate. The database's `service_frequency_shape` and
// `product_vat_percent_range` checks hold the same, the contracts refuse a
// body by them, and the API holds a patch to the cadence against the stored
// row, since a patch carries a part of it — one rule, one sentence. And what
// a set naming a waste fraction twice is told, wherever a set names fractions.
// And a product named afresh — subscribed to, priced, charged — is offered
// (`../status-gates`); a subscription or a rule's step made before it was
// withdrawn stands.
import { eachOnceSentence } from "../requests"
import { refuseUnless } from "../status-gates"
import { OFFERED_PRODUCT_STATUSES, type ProductStatus } from "./vocabulary"

/** The three numbers a cadence is made of, as a resource, a create body or a patch gives them. */
export type ServiceFrequencyShape = {
  collectionsPerWeek?: number | null
  weeksBetween?: number | null
  daysBetween?: number | null
}

/**
 * A cadence's rule: an interval needs a rate to belong to, and `weeksBetween`
 * and `daysBetween` are two ways of saying the same thing. A rate not given
 * at all is not judged — that is a patch leaving it alone.
 */
export function serviceFrequencyShape(value: ServiceFrequencyShape): boolean {
  const { collectionsPerWeek, weeksBetween, daysBetween } = value
  if (weeksBetween != null && daysBetween != null) return false
  if (collectionsPerWeek === undefined) return true
  return collectionsPerWeek !== null || (weeksBetween == null && daysBetween == null)
}

/** What a cadence breaking the rule is told, wherever it is caught. */
export const ONE_CADENCE = "Give collectionsPerWeek with at most one of weeksBetween and daysBetween, or none of the three (on demand)"

/** A product's VAT rate in whole percent: zero is exempt, and nothing is taxed at more than the whole. */
export const VAT_PERCENT = { min: 0, max: 100 } as const

/** What a set naming a waste fraction twice is told: a place's, a compartment's, an award's, a contaminant code's. */
export const EACH_FRACTION_ONCE = eachOnceSentence("waste fraction")

/** A status a product is not offered in. */
export type UnofferedStatus = Exclude<ProductStatus, (typeof OFFERED_PRODUCT_STATUSES)[number]>

/** What a body naming a product that is not offered is told: the status it has, and what the reference needs. Read by the descriptions that quote it, so the document says what the route says. */
export const unofferedProduct = (status: UnofferedStatus): string => `The product is ${status}; only an active product can be subscribed to`

/** A Product a subscription, a price or a charge names: offered, or the conflict naming the status it has instead. Nothing named is nothing to gate. */
export function refuseUnofferedProduct(status: ProductStatus | undefined): void {
  refuseUnless(status, OFFERED_PRODUCT_STATUSES, unofferedProduct)
}

/** What a rule's step naming a product that is not offered is told. */
export const unofferedStep = (position: number, status: UnofferedStatus): string => `The product on step ${position} is ${status}; a rule charges an active product`
