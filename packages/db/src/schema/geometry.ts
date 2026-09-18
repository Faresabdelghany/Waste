// PostGIS geometry columns that read and write as the GeoJSON the contracts
// carry (@waste/contracts/geojson): `geometry.point()` is a
// `geometry(Point, 4326)` column typed `Point`, `geometry.polygon()` a
// `geometry(Polygon, 4326)` column typed `Polygon`. A write goes through
// ST_GeomFromGeoJSON, which reads a GeoJSON without a crs member as WGS 84
// (SRID 4326, the one CRS GeoJSON has), and the column's type modifier refuses
// any other SRID, the wrong shape, or a third dimension with SQLSTATE 22023;
// nothing here relabels a geometry with ST_SetSRID, so a mislabelled one is
// refused rather than renamed. A read arrives as hex EWKB and is decoded by
// geometry/ewkb.ts.
//
// Drizzle's own `geometry` column is not used: drizzle-kit knows only its
// point form and rewrites a polygon column to point on generate
// (drizzle-team/drizzle-orm#3040). A custom type's string goes into the
// migration file as written, with one rule: drizzle-kit quotes any type that
// does not start with a name on its native list, and `geometry` is on it while
// `extensions.geometry` is not (a schema prefix is emitted for enums only). So
// the column type is spelled `geometry(Point, 4326)` unqualified and resolves
// through the migrating owner's search path, which Supabase sets at role level
// to include `extensions` on every database of the cluster; on another server
// the first geometry table fails loudly with "type geometry does not exist".
// The function calls in the SQL this module writes itself are qualified, so
// they resolve whatever the connecting role's search path says. The specimen
// test pins the rendering against drizzle-kit's own generator.
//
// `validGeometry(column)` is the check a table adds beside such a column. The
// contracts hold the shape of a ring (closed, four positions, three distinct)
// and leave geometric validity to the database, so ST_IsValid refuses a
// self-intersecting ring here, with SQLSTATE 23514. The check refuses an empty
// geometry too: PostGIS calls POLYGON EMPTY valid, but it has no coordinates
// for GeoJSON and the decoder would fail the read.
import type { Point, Polygon } from "@waste/contracts/geojson"
import { getTableName, sql } from "drizzle-orm"
import { toSnakeCase } from "drizzle-orm/casing"
import { check, customType, type CheckBuilder, type PgColumn } from "drizzle-orm/pg-core"

import { decodeEwkbHex } from "../geometry/ewkb"

/** WGS 84: the coordinate reference system of GeoJSON and of every geometry column. */
export const SRID = 4326

type Shape = { Point: Point; Polygon: Polygon }

const geometryOf = <T extends keyof Shape>(type: T) =>
  customType<{ data: Shape[T]; driverData: string }>({
    dataType: () => `geometry(${type}, ${SRID})`,
    toDriver: (value) => sql`extensions.st_geomfromgeojson(${JSON.stringify(value)})`,
    fromDriver: (hex) => {
      const { geometry } = decodeEwkbHex(hex)
      if (geometry.type !== type) throw new Error(`geometry.${type.toLowerCase()}: the column holds a ${geometry.type}`)
      return geometry as Shape[T]
    },
  })

export const geometry = {
  point: geometryOf("Point"),
  polygon: geometryOf("Polygon"),
}

/** The column's name as Drizzle's snake_case casing writes it; an explicit name is kept as given. */
const columnName = (column: PgColumn): string => (column.keyAsName ? toSnakeCase(column.name) : column.name)

export function validGeometry(column: PgColumn): CheckBuilder {
  return check(
    `${getTableName(column.table)}_${columnName(column)}_valid`,
    sql`extensions.st_isvalid(${column}) and not extensions.st_isempty(${column})`,
  )
}
