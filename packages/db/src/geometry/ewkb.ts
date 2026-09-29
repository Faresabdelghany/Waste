// PostGIS hands a geometry column to the client as hex EWKB: WKB (ISO 19125)
// with PostGIS's flag bits in the type word for Z, M and an embedded SRID.
// This decodes that text into the GeoJSON the contracts carry, for the three
// shapes the columns store: a Point, a LineString (#169, the plan leg) and a
// Polygon, two-dimensional or with a Z that becomes the position's altitude.
// Everything else is refused by name rather than guessed at: a measure (M) has
// no place in a GeoJSON position, a multi-shape or a collection has no column,
// and an empty geometry has no coordinates to give.
//
// The decoder does not re-check ring closure or validity: the `validGeometry`
// check beside the column (schema/geometry.ts) holds those at write time, and
// a decoder that second-guessed the database would only hide a broken row. It
// does refuse a ring of fewer than four positions, which no closed ring has
// and the contracts' LinearRing could not hold.
import type { LineString, Point, Polygon, Position } from "@waste/contracts/geojson"

export type DecodedGeometry = {
  /** The SRID embedded in the EWKB, null when there is none (plain WKB). */
  srid: number | null
  geometry: Point | LineString | Polygon
}

// WKB geometry type codes, the ones this package may meet.
const POINT = 1
const LINESTRING = 2
const POLYGON = 3
const TYPE_NAMES: Readonly<Record<number, string>> = {
  1: "Point",
  2: "LineString",
  3: "Polygon",
  4: "MultiPoint",
  5: "MultiLineString",
  6: "MultiPolygon",
  7: "GeometryCollection",
}
// PostGIS's EWKB flags, in the high bits of the type word.
const HAS_Z = 0x8000_0000
const HAS_M = 0x4000_0000
const HAS_SRID = 0x2000_0000
const TYPE_MASK = 0x1fff_ffff

// A declaration, not an arrow: TypeScript treats a call to a declared
// never-returning function as the end of the path, so a check can `fail`.
function fail(message: string): never {
  throw new Error(`decodeEwkbHex: ${message}`)
}

const typeName = (type: number): string => TYPE_NAMES[type] ?? `WKB type ${type}`

/** Buffer's hex decoder stops silently at the first pair that is not hex, so its length says whether it read everything. */
function bytesFromHex(hex: string): Uint8Array {
  if (hex.length === 0) fail("empty")
  if (hex.length % 2 !== 0) fail(`odd number of hex digits (${hex.length})`)
  const bytes = Buffer.from(hex, "hex")
  if (bytes.length * 2 !== hex.length) {
    const at = bytes.length * 2
    fail(`"${hex.slice(at, at + 2)}" at offset ${at} is not hex`)
  }
  // The same memory as a plain view (Buffer may sit inside Node's pool).
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** A cursor over the bytes; the byte order marker decides how the numbers after it read. */
class Reader {
  private offset = 0
  private littleEndian = true
  private readonly view: DataView

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get remaining(): number {
    return this.view.byteLength - this.offset
  }

  byteOrder(): void {
    const marker = this.uint8()
    if (marker === 0) this.littleEndian = false
    else if (marker === 1) this.littleEndian = true
    else fail(`byte order marker ${marker} is neither 0 (big-endian) nor 1 (little-endian)`)
  }

  uint8(): number {
    this.need(1)
    return this.view.getUint8(this.offset++)
  }

  uint32(): number {
    this.need(4)
    const value = this.view.getUint32(this.offset, this.littleEndian)
    this.offset += 4
    return value
  }

  int32(): number {
    this.need(4)
    const value = this.view.getInt32(this.offset, this.littleEndian)
    this.offset += 4
    return value
  }

  float64(): number {
    this.need(8)
    const value = this.view.getFloat64(this.offset, this.littleEndian)
    this.offset += 8
    return value
  }

  private need(count: number): void {
    if (this.remaining < count) fail(`${count} byte(s) needed at offset ${this.offset}, ${this.remaining} left: truncated`)
  }
}

const position = (reader: Reader, hasZ: boolean): Position => {
  const x = reader.float64()
  const y = reader.float64()
  return hasZ ? [x, y, reader.float64()] : [x, y]
}

export function decodeEwkbHex(hex: string): DecodedGeometry {
  const reader = new Reader(bytesFromHex(hex))
  reader.byteOrder()
  const word = reader.uint32()
  const type = word & TYPE_MASK
  const hasZ = (word & HAS_Z) !== 0
  const srid = (word & HAS_SRID) !== 0 ? reader.int32() : null
  if ((word & HAS_M) !== 0) fail(`${typeName(type)} carries a measure (M), which a GeoJSON position cannot hold`)

  let geometry: Point | LineString | Polygon
  if (type === POINT) {
    const coordinates = position(reader, hasZ)
    if (coordinates.some((value) => Number.isNaN(value))) fail("an empty point has no position")
    geometry = { type: "Point", coordinates }
  } else if (type === LINESTRING) {
    const positionCount = reader.uint32()
    if (positionCount === 0) fail("an empty line string has no positions")
    if (positionCount < 2) fail(`${positionCount} position(s); a line string has at least two`)
    const coordinates: Position[] = []
    for (let index = 0; index < positionCount; index += 1) coordinates.push(position(reader, hasZ))
    geometry = { type: "LineString", coordinates }
  } else if (type === POLYGON) {
    const ringCount = reader.uint32()
    if (ringCount === 0) fail("an empty polygon has no rings")
    const coordinates: Position[][] = []
    for (let ring = 0; ring < ringCount; ring += 1) {
      const positionCount = reader.uint32()
      if (positionCount < 4) fail(`ring ${ring + 1} has ${positionCount} position(s); a ring closes on its fourth or later`)
      const positions: Position[] = []
      for (let index = 0; index < positionCount; index += 1) positions.push(position(reader, hasZ))
      coordinates.push(positions)
    }
    geometry = { type: "Polygon", coordinates }
  } else {
    fail(`${typeName(type)} is not stored here: only Point, LineString and Polygon columns exist`)
  }

  if (reader.remaining > 0) fail(`${reader.remaining} byte(s) left after the geometry`)
  return { srid, geometry }
}
