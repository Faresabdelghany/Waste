// Weight to billing (O28 of #290, C32 of #291): a product sold by the tonne
// is charged by the reviewed weight of what its stops tipped, never per
// collection. Pure arithmetic over an Unload's net, its route's stops and the
// route's other unloads, so the Finance consumer and its tests read one rule.
//
// Which stops an Unload carried is `onBoardByUnload`'s reading turned round
// (execution/unloads.ts): the completed stops of its fraction on its route
// whose outcome fell after the route's previous accepted unload of that
// fraction and at or before its own instant. A refused load stays on board,
// so a refused unload carries nothing and the next accepted one carries its
// stops; two accepted unloads of one fraction at one instant are one tipping,
// the first by id carrying the stops — a correction is a new row at the
// instant of the one it corrects, which the caller has already left out.
//
// The Unload's reviewed net is shared among the stops it carried by their
// on-board weights where every one of them was weighed, and in equal parts
// where any was not; either way by the largest remainder, so the shares are
// whole kilograms that add up to the net. A share of nothing is no share.
//
// A share is priced as a pickup is, by the resolver on the route's service
// date under the placement's agreement, at the row's price per tonne: the
// event is one weighed load, its unit price and net the rate times the
// tonnes, rounded half away from zero to the minor unit as money is rounded
// (finance/money.ts), and its VAT `vatOf` that net. Its quantity stays one,
// so an invoice line and a credit note read it as any other line; the weight
// is kept beside it.
import type { ProductUnit } from "../registry/vocabulary"
import { fitsMinor, vatOf } from "./money"
import type { PricedAmounts } from "./pricing"

/** The unit a product is sold by when its stops are charged by weight. */
export const TONNE_UNIT = "tonne" as const satisfies ProductUnit

/** Kilograms in a tonne: weights are whole kilograms, prices per tonne. */
export const KG_PER_TONNE = 1000

/** Whether a product is charged by the reviewed weight of its stops rather than per collection. */
export const chargedByWeight = (unit: ProductUnit): boolean => unit === TONNE_UNIT

/** An unload of the route, as the window reads it: its fraction, its instant, and whether the station refused it. */
export type RouteUnload = { id: string; wasteFractionId: string; occurredAt: string; refused: boolean }

/** A stop of the route, as the window reads it: its fraction, when its outcome fell, whether it was collected, and what it weighed on board (null where nothing was weighed). */
export type RouteStop = { pickupId: string; wasteFractionId: string; outcomeAt: string | null; completed: boolean; onBoardKg: number | null }

/**
 * The stops an Unload carried, in the route's order of their outcomes: none
 * for a refused unload; else the completed stops of its fraction whose
 * outcome fell after the route's previous accepted unload of that fraction
 * and at or before its own instant. `unloads` are the route's standing rows,
 * the one asked about among them.
 */
export function stopsCarried(unload: RouteUnload, unloads: readonly RouteUnload[], stops: readonly RouteStop[]): RouteStop[] {
  if (unload.refused) return []
  const accepted = unloads.filter((other) => other.wasteFractionId === unload.wasteFractionId && !other.refused)
  // One tipping at one instant: the first by id carries the stops.
  if (accepted.some((other) => other.occurredAt === unload.occurredAt && other.id < unload.id)) return []
  const since = accepted
    .filter((other) => other.occurredAt < unload.occurredAt)
    .map((other) => other.occurredAt)
    .reduce<string | undefined>((latest, at) => (latest === undefined || at > latest ? at : latest), undefined)
  return stops
    .filter((stop) => stop.completed && stop.wasteFractionId === unload.wasteFractionId && stop.outcomeAt !== null && stop.outcomeAt <= unload.occurredAt && (since === undefined || stop.outcomeAt > since))
    .toSorted((a, b) => (a.outcomeAt ?? "").localeCompare(b.outcomeAt ?? "") || a.pickupId.localeCompare(b.pickupId))
}

/** A stop's share of an Unload's net, whole kilograms. */
export type TonnageShare = { pickupId: string; weightKg: number }

/**
 * The net shared among the stops by the largest remainder: by their on-board
 * weights where every stop was weighed, in equal parts otherwise. The shares
 * add up to the net; a share of nothing is left out.
 */
export function tonnageShares(netKg: number, stops: readonly Pick<RouteStop, "pickupId" | "onBoardKg">[]): TonnageShare[] {
  if (stops.length === 0 || netKg <= 0) return []
  const weighed = stops.every((stop) => stop.onBoardKg !== null && stop.onBoardKg > 0)
  const weights = stops.map((stop) => (weighed ? (stop.onBoardKg ?? 0) : 1))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const exact = weights.map((weight) => (netKg * weight) / total)
  const floors = exact.map(Math.floor)
  let left = netKg - floors.reduce((sum, kg) => sum + kg, 0)
  // The kilograms the floors left go to the largest remainders, the earlier stop first on a tie.
  const order = exact.map((value, index) => ({ index, rest: value - Math.floor(value) })).toSorted((a, b) => b.rest - a.rest || a.index - b.index)
  for (const { index } of order) {
    if (left === 0) break
    floors[index] += 1
    left -= 1
  }
  return stops.flatMap((stop, index) => (floors[index] > 0 ? [{ pickupId: stop.pickupId, weightKg: floors[index] }] : []))
}

/** A rate per tonne times whole kilograms, in minor units, half away from zero: exact in integers, since both are whole and not negative. */
export function tonnesAt(rateMinor: number, weightKg: number): number {
  const product = rateMinor * weightKg
  const whole = Math.floor(product / KG_PER_TONNE)
  return (product - whole * KG_PER_TONNE) * 2 >= KG_PER_TONNE ? whole + 1 : whole
}

/** A per-tonne price turned into one weighed load's: the unit price and the net the rate times the tonnes, the VAT on that net; null where the amount does not fit the event's columns. */
export function weighedLoad(price: PricedAmounts, weightKg: number): PricedAmounts | null {
  const amount = tonnesAt(price.unitPriceMinor, weightKg)
  const vatMinor = vatOf(amount, price.vatPercent)
  if (![amount, vatMinor].every(fitsMinor)) return null
  return { ...price, unitPriceMinor: amount, netMinor: amount, vatMinor }
}
