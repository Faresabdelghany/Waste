import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { decodePolyline } from "../polyline"
import { encodePolyline } from "./polyline-encode"

describe("the encoded polyline VROOM's `g` returns (#171)", () => {
  test("decodes the format's own published example to [longitude, latitude] positions", () => {
    // developers.google.com/maps/documentation/utilities/polylinealgorithm: (38.5, -120.2), (40.7, -120.95), (43.252, -126.453) as latitude, longitude.
    assert.deepEqual(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@"), [
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ])
  })

  test("decodes a Copenhagen pair, positive on both axes, to five decimals", () => {
    // (55.6761, 12.5683) then (55.68, 12.575), encoded by hand: 5567610 and 1256830, then the deltas 390 and 670.
    assert.deepEqual(decodePolyline("sfyrI{vukAkW{h@"), [
      [12.5683, 55.6761],
      [12.575, 55.68],
    ])
  })

  test("the tests' own encoder writes both examples back, so the canned optimisation responses are spelled right", () => {
    assert.equal(encodePolyline(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")), "_p~iF~ps|U_ulLnnqC_mqNvxq`@")
    assert.equal(
      encodePolyline([
        [12.5683, 55.6761],
        [12.575, 55.68],
      ]),
      "sfyrI{vukAkW{h@",
    )
  })

  test("an empty geometry is no positions", () => {
    assert.deepEqual(decodePolyline(""), [])
  })

  test("refuses a string cut off inside a position, rather than inventing its last ordinate", () => {
    assert.throws(() => decodePolyline("_p~iF~ps|U_ulL"), /cut off/)
    assert.throws(() => decodePolyline("_p~iF~ps|U_"), /cut off/)
  })
})
