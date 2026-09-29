// The Plan fingerprint (#124 §4, corrected by #132 §6): the one key of
// idempotency, deduplication and the adapter's cache, within a Route and
// across Routes on an exact match. It keys request inputs only — the provider,
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
// exactly when the requests are.
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
  /** Every constraint that can affect the result, flat scalars only. */
  constraints?: Readonly<Record<string, string | number | boolean>>
}

const spell = (position: FingerprintPosition): string => `${roundCoordinate(position[0]).toFixed(FINGERPRINT_DECIMALS)},${roundCoordinate(position[1]).toFixed(FINGERPRINT_DECIMALS)}`

const spellRecord = (record: Readonly<Record<string, string | number | boolean>> = {}): string =>
  Object.keys(record)
    .sort()
    .map((key) => `${key}=${JSON.stringify(record[key])}`)
    .join("&")

export function planFingerprint(inputs: FingerprintInputs): string {
  const stops = inputs.stops.map((stop) => (typeof stop === "string" ? `none(${stop})` : spell(stop)))
  if (inputs.solver === "optimiser") stops.sort()
  return [
    `provider=${inputs.provider}`,
    `profile=${inputs.profile}`,
    `solver=${inputs.solver}`,
    `configuration=${spellRecord(inputs.configuration)}`,
    `depot=${inputs.depot ? spell(inputs.depot) : "none"}`,
    `station=${inputs.station ? spell(inputs.station) : "none"}`,
    `stops=${stops.join(";")}`,
    `constraints=${spellRecord(inputs.constraints)}`,
  ].join("|")
}
