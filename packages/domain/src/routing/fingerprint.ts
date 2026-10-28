// The Plan fingerprint (#124 §4, corrected by #132 §6): the one key of
// idempotency, deduplication and the cache. In S2 the cache is one Route's —
// `plansMatching` (@waste/db/commands/plans) looks up by route and fingerprint,
// and a job's singleton is the Plan's id — and #124's cross-route reuse ("two
// Routes over the same stops on two days are one call") arrives with the
// adapter's own cache in S3+. It keys request inputs only — the provider,
// the profile, the solver and its configuration, the coordinates rounded to
// about a metre, and every constraint that can affect the result — because
// the provider reports its engine version and graph date only in the
// response; those are provenance on the Plan, never part of the key.
//
// The string is canonical, not hashed: object keys are written in a fixed
// order, numbers in coordinate places at exactly FINGERPRINT_DECIMALS
// decimals, and the stops sorted for `optimiser` (whose input is a set) and
// kept in order for `manual` and `baseline` (whose input is the order). A
// caller that wants something shorter may hash it; two fingerprints are equal
// exactly when the requests' inputs are, so when their answers are. It keys
// places, not pickups: two stops at one address, or a stop regeneration
// re-minted at the same place, key alike, so an equal fingerprint does not
// say a Plan names the request's stops — the cache asks that too
// (`answersRequest`, ./plans.ts; #212).
import type { Reload } from "./reloads"
import type { PlanSolver } from "./vocabulary"

/** Five decimals ≈ 1.1 m at Danish latitudes: the "about a metre" #124 meant, pinned. */
export const FINGERPRINT_DECIMALS = 5

const FACTOR = 10 ** FINGERPRINT_DECIMALS

/** Half away from zero, like finance/money.ts, so a negative ordinate rounds the same distance as its mirror. */
export const roundCoordinate = (ordinate: number): number => (ordinate < 0 ? -Math.round(-ordinate * FACTOR) : Math.round(ordinate * FACTOR)) / FACTOR

/** `[longitude, latitude]`: the flat position a fingerprint reads; altitude never keys a route. */
export type FingerprintPosition = readonly [number, number]

export type FingerprintInputs = {
  /** The routing provider's name: `fake`, `openrouteservice`. */
  provider: string
  /** The routing profile: `driving-hgv`, `driving-car`. */
  profile: string
  solver: PlanSolver
  /** The solver's own switches, flat scalars only, so spelling is canonical. */
  configuration?: Readonly<Record<string, string | number | boolean>>
  depot?: FingerprintPosition | null
  station?: FingerprintPosition | null
  /**
   * Ordered for `manual` and `baseline`; a set (sorted here) for `optimiser`.
   * A stop whose place has no location keys by the string its caller names it
   * with — the pickup's id, say — so the request still fingerprints, its
   * measurement fails with the sentence instead, and two different orders
   * over unlocated stops stay two fingerprints (#170): a dispatcher's second
   * reorder is never swallowed by the first's cache entry.
   */
  stops: readonly (FingerprintPosition | string)[]
  /**
   * Each stop's window and seconds at the kerb (O14 of #290), by its index
   * into `stops`, where a window or a break can move the order; absent, a
   * stop keys by its place alone, as before. A window is seconds of the
   * operating date, or `disjoint` where no time serves the stop.
   */
  stopTimes?: readonly { window: readonly [number, number] | null | "disjoint"; serviceSeconds: number }[]
  /** Every constraint that can affect the result, flat scalars only. */
  constraints?: Readonly<Record<string, string | number | boolean>>
  /**
   * The payload and each stop's load, by its index into `stops`, where the
   * request unloads on the way (O15 of #290, `reloadOf`); absent, a request
   * tips once at the end and keys as before.
   */
  reload?: Reload | null
}

const spell = (position: FingerprintPosition): string => `${roundCoordinate(position[0]).toFixed(FINGERPRINT_DECIMALS)},${roundCoordinate(position[1]).toFixed(FINGERPRINT_DECIMALS)}`

const spellRecord = (record: Readonly<Record<string, string | number | boolean>> = {}): string =>
  Object.keys(record)
    .sort()
    .map((key) => `${key}=${JSON.stringify(record[key])}`)
    .join("&")

const spellTime = (time: NonNullable<FingerprintInputs["stopTimes"]>[number] | undefined): string => {
  if (time === undefined) return ""
  const window = time.window === null ? "any" : time.window === "disjoint" ? "disjoint" : `${time.window[0]}-${time.window[1]}`
  return `@${window}+${time.serviceSeconds}`
}

/**
 * The request a Plan answers, spelt so equal requests share one answer. A
 * stop's seconds at the kerb (O10 of #290) are sent to the optimiser and
 * spelt here only beside a time window or a break (O14 of #290), which is
 * when they can move the order: without one the solver's cost is the drive,
 * so they never change the order or a leg, and spelling them would send
 * every active Plan back to the provider once for an answer it already holds.
 * A timed request's departure and break are its `constraints`, and a request
 * that unloads on the way (O15) spells each stop's load beside it and the
 * payload among them.
 */
export function planFingerprint(inputs: FingerprintInputs): string {
  const { reload } = inputs
  const stops = inputs.stops.map(
    (stop, index) => (typeof stop === "string" ? `none(${stop})` : spell(stop)) + spellTime(inputs.stopTimes?.[index]) + (reload ? `~${reload.amounts[index] ?? 0}` : ""),
  )
  if (inputs.solver === "optimiser") stops.sort()
  return [
    `provider=${inputs.provider}`,
    `profile=${inputs.profile}`,
    `solver=${inputs.solver}`,
    `configuration=${spellRecord(inputs.configuration)}`,
    `depot=${inputs.depot ? spell(inputs.depot) : "none"}`,
    `station=${inputs.station ? spell(inputs.station) : "none"}`,
    `stops=${stops.join(";")}`,
    `constraints=${spellRecord(reload ? { ...inputs.constraints, capacityKg: reload.capacityKg } : inputs.constraints)}`,
  ].join("|")
}
