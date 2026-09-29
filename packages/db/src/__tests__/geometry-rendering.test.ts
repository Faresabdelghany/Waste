// The geometry type before and after the database: the DDL drizzle-kit writes
// for it, the parameter a write sends, and what a read makes of what comes
// back. No database.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Point } from "@waste/contracts/geojson"
import type { SQL } from "drizzle-orm"
import { getTableConfig, integer, PgDialect, type PgColumn } from "drizzle-orm/pg-core"

import { CASING } from "../casing"
import { geometry, validGeometry } from "../schema/geometry"
import { wms } from "../schema/wms"
import { statementsFor } from "./specimen"

const specimen = wms.table(
  "specimen_geometry_rendering",
  {
    id: integer().primaryKey(),
    location: geometry.point(),
    boundary: geometry.polygon(),
    path: geometry.lineString(),
  },
  (table) => [validGeometry(table.location), validGeometry(table.boundary), validGeometry(table.path)],
)

const column = (name: string): PgColumn => {
  const found = getTableConfig(specimen).columns.find((candidate) => candidate.name === name)
  assert.ok(found, name)
  return found
}
const location = column("location")
const boundary = column("boundary")

const dialect = new PgDialect({ casing: CASING })
/** The SQL and parameters a write sends, as `toDriver` shapes them. */
const written = (target: PgColumn, value: unknown) => dialect.sqlToQuery(target.mapToDriverValue(value) as unknown as SQL)

const townHall: Point = { type: "Point", coordinates: [12.5683, 55.6761] }
// ST_GeomFromGeoJSON('{"type":"Point","coordinates":[12.5683,55.6761]}')::text
const POINT_4326 = "0101000020E610000034A2B437F8222940AD69DE718AD64B40"
// The same point with SRID 3857 (0x0F11) in the header
const POINT_3857 = "0101000020110F000034A2B437F8222940AD69DE718AD64B40"
// 'POINT(12.5683 55.6761)'::geometry::text: plain WKB, no SRID
const POINT_NO_SRID = "010100000034A2B437F8222940AD69DE718AD64B40"
// ST_GeomFromGeoJSON of a square with a triangular hole
const POLYGON_4326 =
  "0103000020E610000002000000050000000000000000002940CDCCCCCCCCCC4B403333333333332940CDCCCCCCCCCC4B40" +
  "33333333333329409A99999999D94B4000000000000029409A99999999D94B400000000000002940CDCCCCCCCCCC4B40" +
  "040000000AD7A3703D0A29408FC2F5285CCF4B4014AE47E17A1429408FC2F5285CCF4B4014AE47E17A14294052B81E85EBD14B40" +
  "0AD7A3703D0A29408FC2F5285CCF4B40"
/** PostGIS's json cast of a geometry: GeoJSON plus a crs naming the SRID. */
const cast = (epsg: number | null) => ({
  type: "Point",
  ...(epsg === null ? {} : { crs: { type: "name", properties: { name: `EPSG:${epsg}` } } }),
  coordinates: [12.5683, 55.6761],
})

describe("the geometry columns as drizzle-kit writes them", () => {
  test("a point and a polygon column with SRID 4326, and a validity check for each", async () => {
    const [createTable, ...rest] = await statementsFor({ specimen })
    assert.equal(rest.length, 0)
    assert.match(createTable, /^CREATE TABLE "wms"\."specimen_geometry_rendering" \(/)
    assert.match(createTable, /\t"location" geometry\(Point, 4326\),\n/)
    assert.match(createTable, /\t"boundary" geometry\(Polygon, 4326\),\n/)
    assert.match(createTable, /\t"path" geometry\(LineString, 4326\),\n/)
    const ref = '"wms"."specimen_geometry_rendering"."boundary"'
    assert.ok(
      createTable.includes(
        `CONSTRAINT "specimen_geometry_rendering_boundary_valid" CHECK (extensions.st_isvalid(${ref}) and not extensions.st_isempty(${ref}) and extensions.st_xmin(${ref}) >= -180 and extensions.st_xmax(${ref}) <= 180 and extensions.st_ymin(${ref}) >= -90 and extensions.st_ymax(${ref}) <= 90)`,
      ),
      createTable,
    )
    assert.match(createTable, /CONSTRAINT "specimen_geometry_rendering_location_valid" CHECK \(extensions\.st_isvalid\("wms"\."specimen_geometry_rendering"\."location"\)/)
  })

  test("names the check after the table and the column as the database spells it", () => {
    const named = wms.table(
      "specimen_named",
      { serviceBoundary: geometry.polygon(), centre: geometry.point("explicit_name") },
      (table) => [validGeometry(table.serviceBoundary), validGeometry(table.centre)],
    )
    assert.deepEqual(
      getTableConfig(named).checks.map((check) => check.name),
      ["specimen_named_service_boundary_valid", "specimen_named_explicit_name_valid"],
    )
  })

  test("refuses a check name Postgres would truncate, at definition time", () => {
    const long = wms.table(
      "specimen_with_a_table_name_that_goes_on_and_on",
      { boundaryOfThePrimaryServiceArea: geometry.polygon() },
      (table) => [validGeometry(table.boundaryOfThePrimaryServiceArea)],
    )
    assert.throws(() => getTableConfig(long), /is 89 bytes; Postgres would truncate it to 63 silently, and two truncated names collide/)
  })
})

describe("the write side of the geometry type", () => {
  test("sends the GeoJSON as one parameter to ST_GeomFromGeoJSON", () => {
    const query = written(location, townHall)
    assert.equal(query.sql, "extensions.st_geomfromgeojson($1)")
    assert.deepEqual(query.params, ['{"type":"Point","coordinates":[12.5683,55.6761]}'])
  })

  test("a line string writes the same way, and its ordinates are held finite (#169)", () => {
    const path = column("path")
    const line = { type: "LineString", coordinates: [[12.5, 55.7], [12.6, 55.71]] }
    const query = written(path, line)
    assert.equal(query.sql, "extensions.st_geomfromgeojson($1)")
    assert.deepEqual(query.params, ['{"type":"LineString","coordinates":[[12.5,55.7],[12.6,55.71]]}'])
    assert.throws(
      () => written(path, { type: "LineString", coordinates: [[12.5, 55.7], [NaN, 55.71]] }),
      /geometry\.linestring: NaN is not a finite ordinate/,
    )
  })

  test("drops an undefined altitude, which JSON would make null and PostGIS a Z of 0", () => {
    const withUndefined: Point = { type: "Point", coordinates: [12.5683, 55.6761, undefined] }
    assert.deepEqual(written(location, withUndefined).params, ['{"type":"Point","coordinates":[12.5683,55.6761]}'])
  })

  test("refuses an ordinate that is not a finite number, which JSON would make null and PostGIS 0", () => {
    assert.throws(() => written(location, { type: "Point", coordinates: [NaN, 55.6761] }), /geometry\.point: NaN is not a finite ordinate/)
    assert.throws(
      () =>
        written(boundary, {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, Infinity],
              [0, 0],
            ],
          ],
        }),
      /geometry\.polygon: Infinity is not a finite ordinate/,
    )
    assert.throws(() => written(location, { type: "Point", coordinates: ["12.5", 55.6] }), /12\.5 is not a finite ordinate/)
    assert.throws(() => written(location, { type: "Point", coordinates: [12.5] }), /two or three ordinates, not 1/)
  })
})

describe("the read side of the geometry type", () => {
  test("hex EWKB in SRID 4326 becomes GeoJSON", () => {
    assert.deepEqual(location.mapFromDriverValue(POINT_4326), townHall)
  })

  test("another SRID, or none, is refused: an expression mapped with the column cannot pass other coordinates off as GeoJSON", () => {
    assert.throws(() => location.mapFromDriverValue(POINT_3857), /geometry\.point: SRID 3857 is not 4326/)
    assert.throws(() => location.mapFromDriverValue(POINT_NO_SRID), /geometry\.point: SRID none is not 4326/)
  })

  test("the wrong shape for the column is refused", () => {
    assert.throws(() => location.mapFromDriverValue(POLYGON_4326), /geometry\.point: the column holds a Polygon/)
    assert.throws(() => boundary.mapFromDriverValue(POINT_4326), /geometry\.polygon: the column holds a Point/)
  })

  test("PostGIS's json cast, met when Drizzle nests a row in json, is accepted for EPSG:4326 and returned without its crs", () => {
    assert.deepEqual(location.mapFromDriverValue(cast(4326)), townHall)
  })

  test("the json cast is refused for another crs, for none (SRID 0), and for anything that is not GeoJSON", () => {
    assert.throws(() => location.mapFromDriverValue(cast(3857)), /geometry\.point: crs EPSG:3857 is not EPSG:4326/)
    assert.throws(() => location.mapFromDriverValue(cast(null)), /geometry\.point: crs missing \(SRID 0\) is not EPSG:4326/)
    assert.throws(() => location.mapFromDriverValue(42), /a number is neither hex EWKB nor GeoJSON/)
    // A LineString is a stored shape since #169, so a cast of one under a point column is a column mismatch, not an unknown shape.
    assert.throws(() => location.mapFromDriverValue({ ...cast(4326), type: "LineString" }), /geometry\.point: the column holds a LineString/)
    assert.throws(() => location.mapFromDriverValue({ ...cast(4326), type: "MultiPoint" }), /MultiPoint is not a GeoJSON Point, LineString or Polygon/)
  })
})
