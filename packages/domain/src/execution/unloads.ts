// The weighbridge in the office (O9 of #290). A station may refuse a load —
// contaminated, a fraction it does not take, hazardous, too heavy — and the
// refusal is recorded with the unload, a ledger row, with its reason and, for
// `other`, its words (`refusalIssue`). An accepted unload is of a fraction the
// station takes: the office's capture is refused otherwise (`doesNotTake`),
// while the driver's, the load tipped already, is recorded all the same and
// the office given a task to mend it (`unloadNotAccepted`). And each unload is
// read against what the stops of its fraction weighed on board since the
// route's last unload of it (`onBoardByUnload`), within the project's
// tolerance or above it (`loadReading`).
import { roundHalfAwayFromZero } from "../finance/money"
import type { UnloadRefusalReason } from "./vocabulary"

/** The tolerance a project starts with, in percent of the on-board load: the prototype's "Above 5% tolerance". */
export const DEFAULT_WEIGHT_TOLERANCE_PERCENT = 5
/** The tolerance a project may set, in whole percent. */
export const WEIGHT_TOLERANCE_PERCENT = { min: 1, max: 100 } as const

/** What a refusal for another reason is told without the station's words. */
export const SAY_WHY_REFUSED = "Say why the station refused the load"

/** The first way a refusal will not do, at its field; undefined where it will. A reason may say more in a note, `other` must, and a note goes with a reason. */
export function refusalIssue(refusal: { reason: UnloadRefusalReason | null; note: string | null }): { path: "reason" | "note"; message: string } | undefined {
  if (refusal.reason === null) return refusal.note === null ? undefined : { path: "reason", message: "A note goes with a refusal's reason" }
  if (refusal.reason === "other" && refusal.note === null) return { path: "note", message: SAY_WHY_REFUSED }
  return undefined
}

/** What an accepted unload of a fraction the station does not take is told. */
export const doesNotTake = (stationName: string, fractionName: string): string => `Station ${stationName} does not take ${fractionName}`

/** What it is told where the station names no fraction it takes. */
export const takesNoneSet = (stationName: string): string => `Station ${stationName} has no accepted fractions set`

/** Whole kilograms as a person reads them: 8,240. */
const kilograms = (kg: number): string => String(kg).replace(/\B(?=(\d{3})+(?!\d))/g, ",")

/** The office's task for a driver's unload of a fraction the station does not take, recorded all the same since the load is tipped. */
export function unloadNotAccepted(facts: { stationName: string; fractionName: string; routeLabel: string; netKg: number; recordedAt: string; stationTakesAny: boolean }): { kind: "internal-task"; priority: "medium"; subject: string; description: string } {
  const why = facts.stationTakesAny
    ? `${doesNotTake(facts.stationName, facts.fractionName)}. Check the station's accepted fractions, or review the unload in weight control.`
    : `${takesNoneSet(facts.stationName)}. Set them on the station, then review the unload in weight control.`
  return {
    kind: "internal-task",
    priority: "medium",
    subject: `Unload of ${facts.fractionName} at ${facts.stationName} on ${facts.routeLabel} not accepted`,
    description: `The driver recorded ${kilograms(facts.netKg)} kg of ${facts.fractionName} at ${facts.stationName} on route ${facts.routeLabel} at ${facts.recordedAt}, but ${why}`,
  }
}

/** An unload as the on-board reading attributes to it; a refused one leaves its load on board. */
type UnloadAt = { id: string; wasteFractionId: string; occurredAt: string; refused: boolean }
/** A stop's weight recorded on board. */
type WeightAt = { wasteFractionId: string; occurredAt: string; weightKg: number }

/**
 * What each of a route's unloads carried by the stops' own weights: the
 * weights of its fraction recorded after the route's previous accepted unload
 * of that fraction and at or before its own instant — a refused load stays on
 * board, so the next unload carries it too, and unloads at one instant share
 * their load, since weight control's correction is a new row at the instant
 * of the one it corrects. An unload with no such weight is absent from the
 * map: nothing was weighed on board to compare.
 */
export function onBoardByUnload(unloads: readonly UnloadAt[], weights: readonly WeightAt[]): Map<string, number> {
  const loads = new Map<string, number>()
  const byFraction = new Map<string, UnloadAt[]>()
  for (const unload of unloads) {
    const ofFraction = byFraction.get(unload.wasteFractionId)
    if (ofFraction === undefined) byFraction.set(unload.wasteFractionId, [unload])
    else ofFraction.push(unload)
  }
  for (const [fraction, ofFraction] of byFraction) {
    const ordered = ofFraction.toSorted((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))
    // `since`: the last accepted unload before the current instant; `tipped`: the last accepted one so far.
    let since: string | undefined
    let tipped: string | undefined
    for (const unload of ordered) {
      if (tipped !== undefined && tipped < unload.occurredAt) since = tipped
      const kg = weights
        .filter((weight) => weight.wasteFractionId === fraction && (since === undefined || weight.occurredAt > since) && weight.occurredAt <= unload.occurredAt)
        .reduce((sum, weight) => sum + weight.weightKg, 0)
      if (kg > 0) loads.set(unload.id, kg)
      if (!unload.refused) tipped = unload.occurredAt
    }
  }
  return loads
}

/** The weighbridge's net against the load on board, in percent of the load to one decimal, and whether that is within the tolerance; null with nothing weighed on board. */
export function loadReading(unload: { netKg: number; onBoardKg: number | undefined }, tolerancePercent: number): { onBoardKg: number; deviationPercent: number; withinTolerance: boolean } | null {
  if (unload.onBoardKg === undefined || unload.onBoardKg <= 0) return null
  const difference = unload.netKg - unload.onBoardKg
  // To one decimal, half away from zero as money rounds; the bound is judged on the whole kilograms, exactly, never on the rounded figure.
  const deviationPercent = roundHalfAwayFromZero((difference * 1000) / unload.onBoardKg) / 10
  return { onBoardKg: unload.onBoardKg, deviationPercent, withinTolerance: Math.abs(difference) * 100 <= tolerancePercent * unload.onBoardKg }
}
