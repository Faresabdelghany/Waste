// PostGIS geometry columns that read and write as the GeoJSON the contracts
// carry (@waste/contracts/geojson): `geometry.point()` is a
// `geometry(Point, 4326)` column typed `Point`, `geometry.lineString()` a
// `geometry(LineString, 4326)` column typed `LineString` (#169, the plan
// leg), `geometry.polygon()` a `geometry(Polygon, 4326)` column typed
// `Polygon`.
//
// Writes. The value goes to the database as one GeoJSON parameter through
// ST_GeomFromGeoJSON, which reads a GeoJSON without a crs member as WGS 84
// (SRID 4326, the one CRS GeoJSON has). The column's type modifier refuses any
// other SRID, the wrong shape, or a third dimension with SQLSTATE 22023;
// nothing here relabels a geometry with ST_SetSRID, so a mislabelled one is
// refused rather than renamed. Before serialising, every ordinate has to be a
// finite number (JSON would turn NaN or Infinity into null, and PostGIS reads
// null as 0: a point stored on the prime meridian without a word), and a
// trailing undefined altitude, legal in the Position tuple, is dropped (JSON
// would make it null, PostGIS a Z of 0, and the flat column would refuse the
// row for a reason nobody gave). Two things the type does not do: `.array()`
// (a write is a SQL fragment, which Drizzle cannot put inside an array
// literal; geometries are rows, not arrays) and `.default(<GeoJSON>)` (a
// default goes into the migration file verbatim, so it has to be a `sql`
// expression).
//
// Reads. A column arrives as hex EWKB and is decoded by geometry/ewkb.ts; an
// SRID other than 4326 is refused, so an expression mapped with the column
// (`sql\`st_transform(...)\`.mapWith(column)`) cannot pass other coordinates
// off as GeoJSON. When Drizzle nests a row in json (a relational query's
// `with`, or json_build_array), PostGIS's json cast has already turned the
// geometry into GeoJSON with a `crs` member naming the SRID (absent for SRID
// 0); that object is accepted when the crs is EPSG:4326 and returned without
// it.
//
// Drizzle's own `geometry` column is not used: drizzle-kit knows only its
// point form and rewrites a polygon column to point on generate
// (drizzle-team/drizzle-orm#3040). A custom type's string goes into the
// migration file as written, with one rule: drizzle-kit quotes any type that
// does not start with a name on its native list, and `geometry` is on it while
// `extensions.geometry` is not (a schema prefix is emitted for enums only). So
// the column type is spelled `geometry(Point, 4326)` unqualified, and the
// migrator sends `search_path = wms, extensions` as a startup parameter
// (migrate.ts), so the name resolves the same way on every server and the same
// way it does for the API role's login. The function calls in the SQL this
// module writes itself are qualified, so they resolve whatever the connecting
// role's search path says. The rendering is pinned against drizzle-kit's own
// generator in __tests__/geometry-rendering.test.ts.
//
// `validGeometry(column)` is the check a table adds beside such a column,
// named `<table>_<column>_valid` through names.ts, which refuses a name
// Postgres would truncate (silently, and two truncated names collide). The
// contracts hold the shape of a ring (closed, four positions, three distinct)
// and leave the rest to the database: ST_IsValid refuses a self-intersecting
// ring with SQLSTATE 23514; an empty geometry is refused too (PostGIS calls
// POLYGON EMPTY valid, but it has no coordinates for GeoJSON); and the WGS 84
// range the contracts define (±180, ±90) is held here as well, since the type
// modifier does not check it and a row outside it could never be read back
// through a contracts-validated response.
import type { LineString, Point, Polygon, Position } from "@waste/contracts/geojson"
import { sql } from "drizzle-orm"
import { check, customType, type CheckBuilder, type PgColumn } from "drizzle-orm/pg-core"

import { decodeEwkbHex } from "../geometry/ewkb"
import { columnName, tableObjectName } from "../names"

/** WGS 84: the coordinate reference system of GeoJSON and of every geometry column. */
export const SRID = 4326
/** How PostGIS's json cast names the SRID, in the `crs` member it adds. */
const CRS_NAME = `EPSG:${SRID}`

type Shape = { Point: Point; LineString: LineString; Polygon: Polygon }
type ShapeName = keyof Shape
type Geometry = Shape[ShapeName]

/** What PostGIS's json cast makes of a geometry. */
type CastGeoJson = { type?: unknown; coordinates?: unknown; crs?: { properties?: { name?: unknown } } }

function fail(type: ShapeName, message: string): never {
  throw new Error(`geometry.${type.toLowerCase()}: ${message}`)
}

/** Finite ordinates only, a trailing undefined altitude dropped. */
const cleanPosition = (type: ShapeName, position: Position): Position => {
  const kept = position.length === 3 && position[2] === undefined ? position.slice(0, 2) : position
  if (kept.length < 2 || kept.length > 3) fail(type, `a position has two or three ordinates, not ${kept.length}`)
  for (const ordinate of kept) {
    if (typeof ordinate !== "number" || !Number.isFinite(ordinate)) fail(type, `${String(ordinate)} is not a finite ordinate`)
  }
  return kept as Position
}

const cleanGeometry = (type: ShapeName, value: Geometry): Geometry => {
  if (value.type === "Point") return { type: "Point", coordinates: cleanPosition(type, value.coordinates) }
  if (value.type === "LineString") {
    return { type: "LineString", coordinates: value.coordinates.map((position) => cleanPosition(type, position)) }
  }
  if (value.type === "Polygon") {
    return { type: "Polygon", coordinates: value.coordinates.map((ring) => ring.map((position) => cleanPosition(type, position))) }
  }
  fail(type, `${String((value as { type?: unknown }).type)} is not a GeoJSON Point, LineString or Polygon`)
}

const fromEwkb = (type: ShapeName, hex: string): Geometry => {
  const { srid, geometry } = decodeEwkbHex(hex)
  if (srid !== SRID) fail(type, `SRID ${srid ?? "none"} is not ${SRID}; only WGS 84 geometries read as GeoJSON`)
  return geometry
}

const fromCastJson = (type: ShapeName, value: unknown): Geometry => {
  if (typeof value !== "object" || value === null) fail(type, `a ${typeof value} is neither hex EWKB nor GeoJSON`)
  const { type: shape, coordinates, crs } = value as CastGeoJson
  const name = crs?.properties?.name
  if (name !== CRS_NAME) fail(type, `crs ${name === undefined ? "missing (SRID 0)" : String(name)} is not ${CRS_NAME}`)
  if ((shape !== "Point" && shape !== "LineString" && shape !== "Polygon") || !Array.isArray(coordinates)) {
    fail(type, `${String(shape)} is not a GeoJSON Point, LineString or Polygon`)
  }
  return { type: shape, coordinates } as Geometry
}

const geometryOf = <T extends ShapeName>(type: T) =>
  customType<{ data: Shape[T]; driverData: string | Record<string, unknown> }>({
    dataType: () => `geometry(${type}, ${SRID})`,
    toDriver: (value) => sql`extensions.st_geomfromgeojson(${JSON.stringify(cleanGeometry(type, value))})`,
    fromDriver: (value) => {
      const geometry = typeof value === "string" ? fromEwkb(type, value) : fromCastJson(type, value)
      if (geometry.type !== type) fail(type, `the column holds a ${geometry.type}`)
      return geometry as Shape[T]
    },
  })

export const geometry = {
  point: geometryOf("Point"),
  lineString: geometryOf("LineString"),
  polygon: geometryOf("Polygon"),
}

export function validGeometry(column: PgColumn): CheckBuilder {
  return check(
    tableObjectName(column.table, `${columnName(column)}_valid`, "validGeometry"),
    sql`extensions.st_isvalid(${column}) and not extensions.st_isempty(${column}) and extensions.st_xmin(${column}) >= -180 and extensions.st_xmax(${column}) <= 180 and extensions.st_ymin(${column}) >= -90 and extensions.st_ymax(${column}) <= 90`,
  )
}
