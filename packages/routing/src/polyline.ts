// The encoded polyline format (#171): how VROOM, behind OpenRouteService's
// `/vroom/v0`, returns an optimised route's geometry when asked with `g`.
// Each ordinate is the delta from the one before it, rounded to five
// decimals, zig-zag signed and written in five-bit groups offset into
// printable ASCII, latitude before longitude — so the decoder answers GeoJSON's
// [longitude, latitude] and refuses a string cut off inside a position rather
// than invent the ordinate it lacks.
import type { Position2D } from "@waste/contracts/geojson"

/** VROOM's precision, and the format's usual one: five decimals. */
const FACTOR = 1e5

export function decodePolyline(encoded: string): Position2D[] {
  const positions: Position2D[] = []
  let at = 0
  let latitude = 0
  let longitude = 0
  /** One zig-zag signed delta, read from `at`. */
  const nextDelta = (): number => {
    let result = 0
    let shift = 0
    for (;;) {
      if (at >= encoded.length) throw new Error("decodePolyline: the geometry is cut off inside a position")
      const group = encoded.charCodeAt(at++) - 63
      result |= (group & 0x1f) << shift
      shift += 5
      if (group < 0x20) break
    }
    return result & 1 ? ~(result >> 1) : result >> 1
  }
  while (at < encoded.length) {
    latitude += nextDelta()
    longitude += nextDelta()
    positions.push([longitude / FACTOR, latitude / FACTOR])
  }
  return positions
}
