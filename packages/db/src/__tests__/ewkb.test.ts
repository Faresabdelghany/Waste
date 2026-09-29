// Vectors produced by PostGIS 3.3 on the local stack (each comment says how),
// so the decoder is held to what a geometry column really hands the client.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { decodeEwkbHex } from "../geometry/ewkb"

// ST_GeomFromGeoJSON('{"type":"Point","coordinates":[12.5683,55.6761]}')::text
const POINT = "0101000020E610000034A2B437F8222940AD69DE718AD64B40"
// encode(ST_AsEWKB(<the same>, 'XDR'), 'hex'): big-endian, lowercase
const POINT_BIG_ENDIAN = "0020000001000010e6402922f837b4a234404bd68a71de69ad"
// ST_GeomFromGeoJSON('{"type":"Point","coordinates":[12.5683,55.6761,7.25]}')::text
const POINT_Z = "01010000A0E610000034A2B437F8222940AD69DE718AD64B400000000000001D40"
// 'SRID=4326;POINTM(12.5683 55.6761 3)'::geometry::text
const POINT_M = "0101000060E610000034A2B437F8222940AD69DE718AD64B400000000000000840"
// 'POINT(12.5683 55.6761)'::geometry::text: plain WKB, no SRID
const POINT_NO_SRID = "010100000034A2B437F8222940AD69DE718AD64B40"
// ST_GeomFromGeoJSON of a square with a triangular hole (see the expectation)
const POLYGON_WITH_HOLE =
  "0103000020E610000002000000050000000000000000002940CDCCCCCCCCCC4B403333333333332940CDCCCCCCCCCC4B40" +
  "33333333333329409A99999999D94B4000000000000029409A99999999D94B400000000000002940CDCCCCCCCCCC4B40" +
  "040000000AD7A3703D0A29408FC2F5285CCF4B4014AE47E17A1429408FC2F5285CCF4B4014AE47E17A14294052B81E85EBD14B40" +
  "0AD7A3703D0A29408FC2F5285CCF4B40"
// 'SRID=4326;POINT EMPTY'::geometry::text: a point of NaNs
const EMPTY_POINT = "0101000020E6100000000000000000F87F000000000000F87F"
// ST_GeomFromGeoJSON('{"type":"Polygon","coordinates":[]}')::text: zero rings
const EMPTY_POLYGON = "0103000020E610000000000000"
// 'SRID=4326;LINESTRING(0 0, 1 1)'::geometry::text
const LINESTRING = "0102000020E61000000200000000000000000000000000000000000000000000000000F03F000000000000F03F"

describe("decodeEwkbHex", () => {
  test("decodes a little-endian point with its SRID", () => {
    assert.deepEqual(decodeEwkbHex(POINT), {
      srid: 4326,
      geometry: { type: "Point", coordinates: [12.5683, 55.6761] },
    })
  })

  test("decodes the same point big-endian, in lowercase hex", () => {
    assert.deepEqual(decodeEwkbHex(POINT_BIG_ENDIAN), decodeEwkbHex(POINT))
  })

  test("a Z coordinate becomes the position's altitude", () => {
    assert.deepEqual(decodeEwkbHex(POINT_Z).geometry, { type: "Point", coordinates: [12.5683, 55.6761, 7.25] })
  })

  test("plain WKB has no SRID", () => {
    assert.deepEqual(decodeEwkbHex(POINT_NO_SRID), {
      srid: null,
      geometry: { type: "Point", coordinates: [12.5683, 55.6761] },
    })
  })

  test("decodes a polygon ring by ring, holes included, to the exact doubles", () => {
    assert.deepEqual(decodeEwkbHex(POLYGON_WITH_HOLE), {
      srid: 4326,
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [12.5, 55.6],
            [12.6, 55.6],
            [12.6, 55.7],
            [12.5, 55.7],
            [12.5, 55.6],
          ],
          [
            [12.52, 55.62],
            [12.54, 55.62],
            [12.54, 55.64],
            [12.52, 55.62],
          ],
        ],
      },
    })
  })

  test("refuses a measure: a GeoJSON position has no M", () => {
    assert.throws(() => decodeEwkbHex(POINT_M), /Point carries a measure \(M\)/)
  })

  test("decodes a line string position by position (#169, the first stored line string)", () => {
    assert.deepEqual(decodeEwkbHex(LINESTRING), {
      srid: 4326,
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    })
  })

  test("a line string's Z becomes each position's altitude", () => {
    // 'SRID=4326;LINESTRING Z (0 0 1, 1 1 1)'::geometry: word 0xA0000002 little-endian.
    const hex = "01020000A0E610000002000000" + "0000000000000000".repeat(2) + "000000000000F03F" + "000000000000F03F".repeat(3)
    assert.deepEqual(decodeEwkbHex(hex).geometry, {
      type: "LineString",
      coordinates: [
        [0, 0, 1],
        [1, 1, 1],
      ],
    })
  })

  test("refuses the shapes no column stores, by name", () => {
    // 'SRID=4326;MULTIPOINT((0 0))'::geometry's header: the decoder refuses at the type word.
    assert.throws(() => decodeEwkbHex("0104000020E6100000"), /MultiPoint is not stored here/)
    // An ISO WKB dimension code (1000 + type) is not how PostGIS spells EWKB.
    assert.throws(() => decodeEwkbHex("01E9030000" + "0000000000000000" + "0000000000000000"), /WKB type 1001 is not stored here/)
  })

  test("refuses a line string of fewer than two positions", () => {
    // Zero positions: what 'LINESTRING EMPTY' stores.
    assert.throws(() => decodeEwkbHex("0102000020E610000000000000"), /an empty line string has no positions/)
    // One position, (0 0).
    assert.throws(() => decodeEwkbHex("0102000020E610000001000000" + "0000000000000000".repeat(2)), /1 position\(s\); a line string has at least two/)
  })

  test("refuses an empty geometry: nothing to give GeoJSON", () => {
    assert.throws(() => decodeEwkbHex(EMPTY_POINT), /empty point/)
    assert.throws(() => decodeEwkbHex(EMPTY_POLYGON), /empty polygon/)
  })

  test("refuses a ring of fewer than four positions, which no closed ring has", () => {
    // One ring, zero positions: PostGIS 3.3 stores such a polygon if handed the raw EWKB.
    assert.throws(() => decodeEwkbHex("0103000020E61000000100000000000000"), /ring 1 has 0 position\(s\); a ring closes on its fourth or later/)
    // One ring, two positions (0 0) and (1 1).
    assert.throws(
      () => decodeEwkbHex("0103000020E6100000" + "01000000" + "02000000" + "0".repeat(32) + "000000000000F03F000000000000F03F"),
      /ring 1 has 2 position\(s\)/,
    )
  })

  test("refuses bytes it cannot account for", () => {
    assert.throws(() => decodeEwkbHex(POINT + "00"), /1 byte\(s\) left after the geometry/)
    assert.throws(() => decodeEwkbHex(POINT.slice(0, -2)), /truncated/)
    assert.throws(() => decodeEwkbHex(""), /empty/)
    assert.throws(() => decodeEwkbHex("0101"), /truncated/)
  })

  test("refuses text that is not hex, and a byte order it does not know", () => {
    assert.throws(() => decodeEwkbHex("0g" + POINT.slice(2)), /not hex/)
    assert.throws(() => decodeEwkbHex(POINT.slice(1)), /odd number of hex digits/)
    assert.throws(() => decodeEwkbHex("02" + POINT.slice(2)), /byte order marker 2/)
  })
})
