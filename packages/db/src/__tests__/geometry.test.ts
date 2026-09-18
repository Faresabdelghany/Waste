import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { Point, Polygon } from "@waste/contracts/geojson"
import { sql } from "drizzle-orm"
import { integer } from "drizzle-orm/pg-core"

import { createDb, type Database } from "../client"
import { decodeEwkbHex } from "../geometry/ewkb"
import { migrateDatabase } from "../migrate"
import { API_ROLE } from "../roles"
import { geometry, SRID, validGeometry } from "../schema/geometry"
import { wms } from "../schema/wms"
import { databaseUnderTest } from "./database"
import { refusedWith, withSpecimen, type Tx } from "./specimen"

const database = databaseUnderTest()

// The shape a located record takes: a point, a polygon, a validity check each.
const specimen = wms.table(
  "specimen_geometry",
  {
    id: integer().primaryKey(),
    location: geometry.point(),
    boundary: geometry.polygon(),
  },
  (table) => [validGeometry(table.location), validGeometry(table.boundary)],
)

// Inner Copenhagen, roughly, with a hole where the lakes are.
const copenhagen: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [12.45, 55.62],
      [12.65, 55.62],
      [12.65, 55.73],
      [12.45, 55.73],
      [12.45, 55.62],
    ],
    [
      [12.55, 55.68],
      [12.58, 55.68],
      [12.58, 55.695],
      [12.55, 55.68],
    ],
  ],
}
const aarhus: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [10.1, 56.1],
      [10.3, 56.1],
      [10.3, 56.2],
      [10.1, 56.2],
      [10.1, 56.1],
    ],
  ],
}
const townHall: Point = { type: "Point", coordinates: [12.5683, 55.6761] }
const onTheLakes: Point = { type: "Point", coordinates: [12.57, 55.685] }
const bowTie: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [2, 2],
      [2, 0],
      [0, 2],
      [0, 0],
    ],
  ],
}

describe("geometry columns against the database", { skip: database.skip }, () => {
  let admin: Database

  before(async () => {
    await migrateDatabase(database.adminUrl)
    admin = createDb(database.adminUrl, { max: 2 })
  })
  after(() => admin.close())

  const inSpecimen = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSpecimen(admin.db, { specimen }, fn)

  test("ST_GeomFromGeoJSON reads a GeoJSON without crs as SRID 4326, which is what the write relies on", async () => {
    const [row] = await admin.sql<{ srid: number }[]>`
      select extensions.st_srid(extensions.st_geomfromgeojson(${JSON.stringify(townHall)})) as srid`
    assert.equal(row.srid, SRID)
  })

  test("a polygon written from GeoJSON reads back equal, hole included; an unset column reads null", () =>
    inSpecimen(async (tx) => {
      await tx.insert(specimen).values({ id: 1, boundary: copenhagen })
      const rows = await tx.select().from(specimen)
      assert.deepEqual(rows, [{ id: 1, location: null, boundary: copenhagen }])
    }))

  test("a [lng, lat] point round-trips; the column is flat and refuses an altitude with 22023", () =>
    inSpecimen(async (tx) => {
      await tx.insert(specimen).values({ id: 1, location: townHall })
      const [row] = await tx.select({ location: specimen.location }).from(specimen)
      assert.deepEqual(row.location, townHall)
      const withAltitude: Point = { type: "Point", coordinates: [12.5683, 55.6761, 7.25] }
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(specimen).values({ id: 2, location: withAltitude })),
        refusedWith("22023", /Geometry has Z dimension but column does not/),
      )
    }))

  test("the column pins the shape and the SRID: the wrong one is refused with 22023, not relabelled", () =>
    inSpecimen(async (tx) => {
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(specimen).values({ id: 1, location: copenhagen as unknown as Point })),
        refusedWith("22023", /Geometry type \(Polygon\) does not match column type \(Point\)/),
      )
      await assert.rejects(
        tx.transaction((savepoint) =>
          savepoint.execute(sql`insert into ${specimen} (id, location) values (2, extensions.st_geomfromtext('POINT(12.5683 55.6761)', 3857))`),
        ),
        refusedWith("22023", /Geometry SRID \(3857\) does not match column SRID \(4326\)/),
      )
    }))

  test("validGeometry refuses a self-intersecting ring and an empty polygon with 23514, naming the constraint", () =>
    inSpecimen(async (tx) => {
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(specimen).values({ id: 1, boundary: bowTie })),
        refusedWith("23514", /specimen_geometry_boundary_valid/),
      )
      // POLYGON EMPTY is valid to PostGIS; the check refuses it all the same,
      // because there is no GeoJSON to read it back as.
      await assert.rejects(
        tx.transaction((savepoint) =>
          savepoint.execute(sql`insert into ${specimen} (id, boundary) values (2, extensions.st_geomfromgeojson('{"type":"Polygon","coordinates":[]}'))`),
        ),
        refusedWith("23514", /specimen_geometry_boundary_valid/),
      )
    }))

  test("validGeometry holds the WGS 84 range too: a point past 180° or 90° is refused with 23514", () =>
    inSpecimen(async (tx) => {
      const offTheGlobe: Point = { type: "Point", coordinates: [200, 95] }
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(specimen).values({ id: 1, location: offTheGlobe })),
        refusedWith("23514", /specimen_geometry_location_valid/),
      )
      const southPole: Point = { type: "Point", coordinates: [-180, -90] }
      await tx.insert(specimen).values({ id: 2, location: southPole })
      const [row] = await tx.select({ location: specimen.location }).from(specimen)
      assert.deepEqual(row.location, southPole, "the boundary of the range is inside it")
    }))

  test("the two faces: a Drizzle select maps the column to GeoJSON, a raw row carries hex EWKB", () =>
    inSpecimen(async (tx) => {
      await tx.insert(specimen).values({ id: 1, location: townHall })
      const raw = await tx.execute<{ location: string }>(sql`select ${specimen.location} as location from ${specimen}`)
      assert.match(raw[0].location, /^0101000020E6100000[0-9A-F]{32}$/)
      assert.deepEqual(decodeEwkbHex(raw[0].location), { srid: SRID, geometry: townHall })
    }))

  test("an expression mapped with the column: PostGIS's json cast reads as GeoJSON, another SRID is refused", () =>
    inSpecimen(async (tx) => {
      await tx.insert(specimen).values({ id: 1, location: townHall })
      const [row] = await tx.select({ asJson: sql`to_jsonb(${specimen.location})`.mapWith(specimen.location) }).from(specimen)
      assert.deepEqual(row.asJson, townHall)
      await assert.rejects(
        tx.select({ mercator: sql`extensions.st_transform(${specimen.location}, 3857)`.mapWith(specimen.location) }).from(specimen),
        /geometry\.point: SRID 3857 is not 4326/,
      )
    }))

  test("as wms_api through its own search path, ST_Within says which area a point is in, holes honoured", () =>
    inSpecimen(async (tx) => {
      // The table exists; from here on the transaction is the API role, with
      // the search path its login gets (role settings do not apply on SET ROLE).
      await tx.execute(sql`set local role ${sql.raw(API_ROLE)}`)
      await tx.execute(sql`set local search_path = wms, extensions`)
      await tx.insert(specimen).values([
        { id: 1, boundary: copenhagen },
        { id: 2, boundary: aarhus },
      ])
      const areaOf = async (point: Point): Promise<number[]> => {
        const rows = await tx.execute<{ id: number }>(sql`
          select id from ${specimen}
          where st_within(st_geomfromgeojson(${JSON.stringify(point)}), ${specimen.boundary})
          order by id`)
        return rows.map((row) => row.id)
      }
      assert.deepEqual(await areaOf(townHall), [1])
      assert.deepEqual(await areaOf(onTheLakes), [], "a point in the hole is in no area")
      assert.deepEqual(await areaOf({ type: "Point", coordinates: [10.2, 56.15] }), [2])
    }))
})
