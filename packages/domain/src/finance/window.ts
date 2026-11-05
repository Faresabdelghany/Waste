// The scale house's window prices (M16b of #293): a load sold by the tonne
// is priced at its weighed kilograms, one sold by the cubic metre at its
// declared litres, each the rate per unit times thousandths of it, rounded
// half away from zero as a weighed load is (finance/tonnage.ts). The tier a
// line meets is judged on the same quantity, in the product's unit: 2,340 kg
// is 2.34 tonnes, 1,500 litres 1.5 m³. A product sold by any other unit is
// not the window's to price.
import type { ProductUnit } from "../registry/vocabulary"
import type { PricedAmounts } from "./pricing"
import { KG_PER_TONNE, TONNE_UNIT, weighedLoad } from "./tonnage"

/** The unit a load is sold by its volume. */
export const CUBIC_METRE_UNIT = "m3" as const satisfies ProductUnit

/** Litres in a cubic metre. */
export const LITRES_PER_M3 = 1000

/** Whether the window prices a product: by the tonne or by the cubic metre. */
export const soldAtTheWindow = (unit: ProductUnit): boolean => unit === TONNE_UNIT || unit === CUBIC_METRE_UNIT

/** A window line's measure in thousandths of its product's unit — kilograms of a tonne, litres of a cubic metre — or null where the line does not carry it. */
export function thousandthsOf(unit: ProductUnit, line: { netKg: number; volumeLitres: number | null }): number | null {
  if (unit === TONNE_UNIT) return line.netKg
  if (unit === CUBIC_METRE_UNIT) return line.volumeLitres
  return null
}

/** The quantity a tier is judged against: the measure in the product's unit, kilograms and litres alike a thousandth of it. */
export const quantityOf = (thousandths: number): number => thousandths / KG_PER_TONNE

/** A per-unit price turned into one line's: the rate times the thousandths, the VAT on that net; null where the amount does not fit the event's columns. */
export const windowLoad = (price: PricedAmounts, thousandths: number): PricedAmounts | null => weighedLoad(price, thousandths)
