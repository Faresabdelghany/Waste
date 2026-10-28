// Routes above one optimisation's size (O15 of #290, #350's large routes).
// One request takes fifty locations (`OPTIMISER_MAX_LOCATIONS`), so a larger
// route is optimised in parts: its stops swept by their bearing from the
// depot — the classic sweep, cluster first and route second — and cut into
// as few parts as hold them, as even as the count allows. Each part is one
// request, chained: it starts where the part before it ended, at the time
// that part finished, and only the last returns to the depot by way of the
// station, so the parts' legs are the trip's, each once (packages/routing).
//
// The sweep starts after the widest empty bearing around the depot, so no
// part straddles the gap that splits the area in two; ties go to the stop
// listed first, so the same stops always make the same parts. A route that
// needs more than `OPTIMISER_MAX_PARTS` requests is measured as a baseline
// instead, as one above fifty stops was before (`optimiseSolver`): each part
// spends one of the day's optimisations (#132), and a route that size is
// better split by the office.

/** `[longitude, latitude]`, the flat position a part is cut by. */
export type PartPosition = readonly [number, number]

/** The parts one optimised route may be asked in: ten requests, up to some 490 stops. */
export const OPTIMISER_MAX_PARTS = 10

/** How many requests `stops` take at `size` stops each. */
export const partsNeeded = (stops: number, size: number): number => Math.max(1, Math.ceil(stops / size))

/**
 * The stops cut into parts of at most `size`, each a list of indices into
 * `stops` in the order the sweep met them, the parts in the order driven. One
 * part holds every stop where they fit one request.
 */
export function sweepParts(depot: PartPosition, stops: readonly PartPosition[], size: number): number[][] {
  if (size < 1) throw new Error("sweepParts: a part holds at least one stop")
  const count = partsNeeded(stops.length, size)
  if (count === 1) return [stops.map((_, index) => index)]
  // Bearings on a plane scaled to the depot's latitude, so a degree east weighs what it measures there.
  const scale = Math.cos((depot[1] * Math.PI) / 180)
  const bearings = stops.map((stop, index) => ({ index, angle: Math.atan2(stop[1] - depot[1], (stop[0] - depot[0]) * scale) }))
  bearings.sort((a, b) => a.angle - b.angle || a.index - b.index)
  // Start after the widest gap between neighbouring bearings, the wrap-around one included.
  let start = 0
  let widest = -1
  for (let at = 0; at < bearings.length; at += 1) {
    // The wrap-around gap runs from the last bearing round to the first: a whole turn where every stop shares one bearing.
    const gap = at === bearings.length - 1 ? bearings[0].angle + 2 * Math.PI - bearings[at].angle : bearings[at + 1].angle - bearings[at].angle
    if (gap > widest) {
      widest = gap
      start = (at + 1) % bearings.length
    }
  }
  const swept = [...bearings.slice(start), ...bearings.slice(0, start)].map((bearing) => bearing.index)
  // As even as the count allows: the first parts take one stop more where it does not divide.
  const parts: number[][] = []
  let from = 0
  for (let part = 0; part < count; part += 1) {
    const take = Math.floor(swept.length / count) + (part < swept.length % count ? 1 : 0)
    parts.push(swept.slice(from, from + take))
    from += take
  }
  return parts
}
