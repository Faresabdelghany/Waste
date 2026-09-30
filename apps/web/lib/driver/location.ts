// A command's position (Issue #145, decided on #125, Q7 and Q14): best-effort
// only, and never a reason to hold a command back. One `getCurrentPosition`
// per tap — a fix at most a minute old (`maximumAge`) within three seconds
// (`timeout`) — attached when it is 100 m or better and that recent, and
// otherwise the command goes without one. The three seconds are this
// helper's bound too, since a browser does not count a permission prompt
// still on screen against `timeout`. No `watchPosition`: a position travels
// only with the driver's actions, never continuously or in the background.
//
// High accuracy is asked for because a stop is a kerb, not a district; a
// phone whose satellite fix is cold answers late or coarse, and the command
// then goes without one, which is the rule.
import type { FlatPoint } from "@waste/contracts/geojson"

import { BROWSER_TIMERS, type Timers } from "./timers"

/** What a located command's body carries: the point and how well the phone knew it, in whole metres. */
export type Fix = { location: FlatPoint; accuracyM: number }

export const LOCATION_RULES = {
  /** The oldest fix a command takes. */
  maximumAgeMs: 60_000,
  /** How long a tap waits for one. */
  timeoutMs: 3_000,
  /** The coarsest fix a command takes. */
  accuracyM: 100,
} as const

export type LookupOptions = { now?: () => number; timers?: Timers }

/** The fix for a command being recorded now, or null when there is none good enough in time. */
export function lookupFix(geolocation: Pick<Geolocation, "getCurrentPosition"> | null | undefined, { now = Date.now, timers = BROWSER_TIMERS }: LookupOptions = {}): Promise<Fix | null> {
  if (!geolocation) return Promise.resolve(null)
  return new Promise((resolve) => {
    let answered = false
    const answer = (fix: Fix | null) => {
      if (answered) return
      answered = true
      timers.clear(bound)
      resolve(fix)
    }
    const bound = timers.set(() => answer(null), LOCATION_RULES.timeoutMs)
    try {
      geolocation.getCurrentPosition(
        ({ coords, timestamp }) => {
          const recent = now() - timestamp <= LOCATION_RULES.maximumAgeMs
          const accurate = coords.accuracy <= LOCATION_RULES.accuracyM
          answer(recent && accurate ? { location: { type: "Point", coordinates: [coords.longitude, coords.latitude] }, accuracyM: Math.max(1, Math.ceil(coords.accuracy)) } : null)
        },
        () => answer(null),
        { maximumAge: LOCATION_RULES.maximumAgeMs, timeout: LOCATION_RULES.timeoutMs, enableHighAccuracy: true },
      )
    } catch {
      // A browser that throws instead of calling back (an insecure origin in some) has no position to give.
      answer(null)
    }
  })
}
