// A weighbridge's tickets read automatically (O27 of #290, row 8.8). A
// weighbridge knows its own station, its ticket's number, the plate of the
// vehicle on it, when it weighed, the weights, and the product it was told —
// a fraction's key or a waste code — and nothing of a Route. So a ticket is
// kept as itself and matched: to the route its vehicle was out on when it was
// weighed — the session that spans the instant, else the vehicle's one route
// that ran on the day — and to the fraction it names, which the station must
// take. A matched ticket becomes that route's Unload, `source = integration`;
// an unmatched one waits for the office with the first reason it failed on.
//
// The same load may then be an Unload twice: the driver's, recorded at the
// tip, and the weighbridge's. Neither is wrong to record, so both stand and
// weight control settles it: each is marked a possible duplicate of the other
// while both are open (`possibleDuplicates`), and the desk rejects one.
import type { ExecutionSource, WeighbridgeUnmatchedReason } from "./vocabulary"

/** The tickets one ingest may carry. */
export const WEIGHBRIDGE_BATCH_MAX = 500

/** The bytes one ingest may carry: a full batch of tickets with room to spare. */
export const WEIGHBRIDGE_BODY_MAX_BYTES = 256 * 1024

/** The batches one company may send a minute. */
export const WEIGHBRIDGE_BATCHES_PER_MINUTE = 120

/** A plate as the match reads it: letters and digits alone, upper case, so `cn 42-018` is the vehicle registered `CN 42 018`. */
export const plateKey = (plate: string): string => plate.normalize("NFC").toUpperCase().replace(/[^\p{L}\p{N}]/gu, "")

/** A fraction as the match may name it. */
export type FractionCandidate = { id: string; key: string; wasteCode: string | null }

/**
 * The fraction a ticket names: the one of its key, else the one fraction
 * filed under its waste code (compact, `200301`); null where neither names
 * exactly one, since two fractions under one code is not a match.
 */
export function fractionNamed(sent: { fractionKey: string | null; wasteCode: string | null }, fractions: readonly FractionCandidate[]): string | null {
  if (sent.fractionKey !== null) {
    const byKey = fractions.find((fraction) => fraction.key === sent.fractionKey)
    if (byKey !== undefined) return byKey.id
  }
  if (sent.wasteCode === null) return null
  const coded = fractions.filter((fraction) => fraction.wasteCode === sent.wasteCode)
  return coded.length === 1 ? coded[0].id : null
}

/** What the match found for one ticket, each looked up by the caller. */
export type MatchFacts = {
  /** The vehicle of the ticket's plate in the caller's reach, or null. */
  vehicleId: string | null
  /** The routes whose session on that vehicle spans the instant weighed. */
  sessionRouteIds: readonly string[]
  /** The vehicle's active or completed routes on the day weighed, on their project's clock. */
  dayRouteIds: readonly string[]
  /** The fraction the ticket names (`fractionNamed`), or null. */
  wasteFractionId: string | null
  /** Whether the station takes that fraction. */
  stationTakes: boolean
}

/** What a ticket comes to: a route and a fraction to write its Unload on, or the first reason it found none. */
export type MatchDecision = { kind: "matched"; routeId: string; wasteFractionId: string } | { kind: "unmatched"; reason: WeighbridgeUnmatchedReason }

/** The one route a set names, the reason where it names none or several. */
function oneRoute(routeIds: readonly string[]): { routeId: string } | { reason: "no-route" | "several-routes" } {
  const distinct = [...new Set(routeIds)]
  if (distinct.length === 1) return { routeId: distinct[0] }
  return { reason: distinct.length === 0 ? "no-route" : "several-routes" }
}

/** A ticket matched, in order: the vehicle, its route (the session's first, the day's else), the fraction, and the station's acceptance of it. */
export function matchTicket(facts: MatchFacts): MatchDecision {
  if (facts.vehicleId === null) return { kind: "unmatched", reason: "unknown-vehicle" }
  const route = oneRoute(facts.sessionRouteIds.length > 0 ? facts.sessionRouteIds : facts.dayRouteIds)
  if ("reason" in route) return { kind: "unmatched", reason: route.reason }
  if (facts.wasteFractionId === null) return { kind: "unmatched", reason: "unknown-fraction" }
  if (!facts.stationTakes) return { kind: "unmatched", reason: "fraction-not-accepted" }
  return { kind: "matched", routeId: route.routeId, wasteFractionId: facts.wasteFractionId }
}

/** An Unload as the duplicate rule reads it: where and what, who recorded it, and whether it is still open to review. */
export type DuplicateCandidate = {
  id: string
  routeId: string
  wasteFractionId: string
  source: ExecutionSource
  /** The station refused the load: nothing was tipped to double. */
  refused: boolean
  /** Weight control rejected or corrected it: the desk has settled it. */
  settled: boolean
}

/**
 * The Unloads each one may duplicate: on the same route and of the same
 * fraction, one the weighbridge's (`integration`) and the other recorded by
 * hand, both taken and both still open. A route is one day, so the same
 * route is the same day. An Unload with none is absent from the map.
 */
export function possibleDuplicates(unloads: readonly DuplicateCandidate[]): Map<string, string[]> {
  const open = unloads.filter((unload) => !unload.refused && !unload.settled)
  const found = new Map<string, string[]>()
  for (const weighed of open.filter((unload) => unload.source === "integration")) {
    for (const recorded of open.filter((unload) => unload.source !== "integration" && unload.routeId === weighed.routeId && unload.wasteFractionId === weighed.wasteFractionId)) {
      found.set(weighed.id, [...(found.get(weighed.id) ?? []), recorded.id])
      found.set(recorded.id, [...(found.get(recorded.id) ?? []), weighed.id])
    }
  }
  return found
}
