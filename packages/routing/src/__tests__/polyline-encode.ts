// The encoder the canned optimisation responses are written with: the
// format's own algorithm, independent of the decoder under test (which
// polyline.test.ts holds to the format's published example).
import type { Position2D } from "@waste/contracts/geojson"

const encodeValue = (value: number): string => {
  let shifted = value < 0 ? ~(value << 1) : value << 1
  let out = ""
  while (shifted >= 0x20) {
    out += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63)
    shifted >>= 5
  }
  return out + String.fromCharCode(shifted + 63)
}

/** [longitude, latitude] positions as VROOM's `geometry` spells them: latitude first, five decimals, deltas. */
export function encodePolyline(positions: readonly Position2D[]): string {
  let latitude = 0
  let longitude = 0
  let out = ""
  for (const [lon, lat] of positions) {
    const nextLatitude = Math.round(lat * 1e5)
    const nextLongitude = Math.round(lon * 1e5)
    out += encodeValue(nextLatitude - latitude) + encodeValue(nextLongitude - longitude)
    latitude = nextLatitude
    longitude = nextLongitude
  }
  return out
}
