// Moving stops between routes (O23 of #290) as drizzle-kit writes it: the
// pickup gains the stop it was moved from, with its route, diffed from the
// pickup as 0053 left it (pickup-as-of.ts), since an applied file is never
// edited. Then migration 0055, which is exactly those statements: two
// columns on a table that has its fence and its trigger already owe the file
// nothing by migrations/README.md. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { subscription } from "../schema/agreements"
import { bulkyBooking } from "../schema/bulky"
import { wasteFraction } from "../schema/catalogue"
import { container } from "../schema/containers"
import { property, sharedCollectionPoint } from "../schema/customers"
import { pickup, route } from "../schema/execution"
import { company, project } from "../schema/organisation"
import { contaminantCode } from "../schema/pickup-exceptions"
import { warehouse } from "../schema/places"
import { normalised, statementsOf } from "../sql/hand-written"
import { ref } from "./rendering"
import { pickupAsOf0053 } from "./pickup-as-of"
import { statementsBetween } from "./specimen"

const MIGRATION = "0055_moved_stops.sql"

const referenced = { company, project, route, container, property, sharedCollectionPoint, wasteFraction, subscription, warehouse, contaminantCode, bulkyBooking }

/** What drizzle-kit writes for 0055: the pickup from its 0053 spelling to today's. */
const generated = (): Promise<string[]> => statementsBetween({ ...referenced, pickup: pickupAsOf0053 }, { ...referenced, pickup })

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the stop a moved stop was moved from, as drizzle-kit writes it", () => {
  test("two columns, a key through the route into the pickup itself, one stop moved from each, its index, and the shape: both or neither, on the office's stop alone", async () => {
    assert.deepEqual(await generated(), [
      'ALTER TABLE "wms"."pickup" ADD COLUMN "moved_from_route_id" uuid;',
      'ALTER TABLE "wms"."pickup" ADD COLUMN "moved_from_pickup_id" uuid;',
      'ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_moved_from_route_id_moved_from_pickup_id_fk" FOREIGN KEY ("company_id","project_id","moved_from_route_id","moved_from_pickup_id") REFERENCES "wms"."pickup"("company_id","project_id","route_id","id") ON DELETE no action ON UPDATE no action;',
      `CREATE UNIQUE INDEX "pickup_moved_from_pickup_id_key" ON "wms"."pickup" USING btree ("company_id","moved_from_pickup_id") WHERE ${ref("pickup", "moved_from_pickup_id")} is not null;`,
      'CREATE INDEX "pickup_moved_from_route_id_moved_from_pickup_id_idx" ON "wms"."pickup" USING btree ("company_id","moved_from_route_id","moved_from_pickup_id");',
      `ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_moved_from_shape" CHECK ((${ref("pickup", "moved_from_route_id")} is null) = (${ref("pickup", "moved_from_pickup_id")} is null) and (${ref("pickup", "moved_from_pickup_id")} is null or ${ref("pickup", "origin")} = 'office'));`,
    ])
  })
})

describe("migration 0055", () => {
  test("is exactly what drizzle-kit generates for it, and nothing below", async () => {
    assert.deepEqual(await fileStatements(), (await generated()).map(normalised))
  })
})
