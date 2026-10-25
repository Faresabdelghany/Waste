// Fleet emissions (M10 of #293): what a route's planned distance burns. A
// fuel's emission factor is grams of CO₂e per unit of the fuel — a litre, a
// kilogram of gas, a kilowatt-hour — effective-dated per company, since the
// published factors are revised each year; a vehicle type's consumption is
// thousandths of its fuel's unit per kilometre — millilitres, grams or
// watt-hours — by the fuel a vehicle of it runs on, since one type may be a
// diesel truck or an electric one. Both are whole numbers, as money is minor
// units, so nothing on the wire is a decimal and the one rounding is here.
//
// A route is measured from its active Plan's distance, its planned vehicle's
// fuel and type, and the factor in force on its operating date; a route
// missing any is unmeasured, with the first gap in EMISSION_GAPS' order, and
// never counted as zero. A factor of zero is measured: the published rules
// count a biofuel documented as sustainable as nothing burnt. A route's grams
// are shared over its stops' fractions by count — an approximation, which
// the report says — and the optimiser's saving is its active Plan against
// the baseline, the generated order measured.
import type { EmissionGap, EnergyUnit, FuelType } from "./vocabulary"

/** The unit each fuel is burnt and its factor given in. */
export const FUEL_UNIT: Readonly<Record<FuelType, EnergyUnit>> = { diesel: "litre", hvo: "litre", biogas: "kg", electric: "kwh", hybrid: "litre", other: "litre" }

/** The bounds a factor and a consumption are held to: no fuel emits ten kilograms per unit, and no truck burns ten units a kilometre. */
export const GRAMS_PER_UNIT_MAX = 10_000
export const MILLI_UNITS_PER_KM_MAX = 10_000

/**
 * The grams of CO₂e driving `metres` burns at `milliUnitsPerKm` with a factor
 * of `gramsPerUnit`: metres × milli × grams / 10⁶, rounded half up once. The
 * product is taken in whole numbers, since a Plan's distance is any `integer`
 * and at the bounds it outgrows a double's exact integers; all three are
 * non-negative, so half up is the money rule's half away from zero
 * (finance/money.ts) without its division in floating point.
 */
export function drivenGrams(metres: number, milliUnitsPerKm: number, gramsPerUnit: number): number {
  const product = BigInt(metres) * BigInt(milliUnitsPerKm) * BigInt(gramsPerUnit)
  return Number((product + BigInt(500_000)) / BigInt(1_000_000))
}

/** One fuel's factor over its half-open period: `validTo` is the first day out of force, null while it runs. */
export type EmissionFactorPeriod = { fuel: FuelType; gramsPerUnit: number; validFrom: string; validTo: string | null }

/** The factor in force for a fuel on a day, or null where none holds it. */
export function factorInForce(factors: readonly EmissionFactorPeriod[], fuel: FuelType, day: string): number | null {
  const found = factors.find((factor) => factor.fuel === fuel && factor.validFrom <= day && (factor.validTo === null || day < factor.validTo))
  return found === undefined ? null : found.gramsPerUnit
}

/**
 * What a route is measured from: its active Plan (null for none; `metres`
 * null while it is not measured), its planned vehicle's type and fuel (both
 * null for no vehicle), and the consumption and the factor its caller looked
 * up for that type and fuel on the route's day, null for none.
 */
export type RouteEmissionFacts = {
  plan: { metres: number | null } | null
  vehicleTypeId: string | null
  fuel: FuelType | null
  consumption: number | null
  factor: number | null
}

export type RouteEmission = { measured: true; metres: number; grams: number } | { measured: false; gap: EmissionGap }

/** A route's planned emission, or the first fact it lacks, the gaps judged in EMISSION_GAPS' order: the Plan before the vehicle before the numbers. */
export function routeEmission(facts: RouteEmissionFacts): RouteEmission {
  if (facts.plan === null) return { measured: false, gap: "no-plan" }
  if (facts.plan.metres === null) return { measured: false, gap: "plan-unmeasured" }
  if (facts.vehicleTypeId === null) return { measured: false, gap: "no-vehicle" }
  if (facts.fuel === null) return { measured: false, gap: "no-fuel" }
  if (facts.consumption === null) return { measured: false, gap: "no-consumption" }
  if (facts.factor === null) return { measured: false, gap: "no-factor" }
  return { measured: true, metres: facts.plan.metres, grams: drivenGrams(facts.plan.metres, facts.consumption, facts.factor) }
}

/**
 * A route's grams shared over its stops' fractions by how many stops each
 * has: each its whole share, then the grams left one at a time to the
 * largest remainders, a tie to the fraction named first, so the parts sum to
 * the route's. A route without a counted stop splits into nothing.
 */
export function splitByStops<Key>(grams: number, stops: ReadonlyMap<Key, number>): Map<Key, number> {
  const counted = [...stops].filter(([, n]) => n > 0)
  const total = counted.reduce((sum, [, n]) => sum + n, 0)
  if (total === 0) return new Map()
  const shares = counted.map(([key, n], order) => ({ key, order, whole: Math.floor((grams * n) / total), remainder: (grams * n) % total }))
  let left = grams - shares.reduce((sum, share) => sum + share.whole, 0)
  for (const share of [...shares].sort((a, b) => b.remainder - a.remainder || a.order - b.order)) {
    if (left === 0) break
    share.whole += 1
    left -= 1
  }
  return new Map(shares.map((share) => [share.key, share.whole]))
}

/** The optimiser's saving on a route: its measured baseline less its active optimised Plan, in metres and in grams at the route's consumption and factor; null where the active Plan is not the optimiser's or no baseline was measured. Negative where the optimiser drove further. */
export function savingOf(active: { solver: string; metres: number }, baselineMetres: number | null, consumption: number, factor: number): { metres: number; grams: number } | null {
  if (active.solver !== "optimiser" || baselineMetres === null) return null
  return { metres: baselineMetres - active.metres, grams: drivenGrams(baselineMetres, consumption, factor) - drivenGrams(active.metres, consumption, factor) }
}
