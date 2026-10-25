// The stop's ledger bookings (O3b of #290) as drizzle-kit writes them: a
// delivery's subscription, a removal's or a swap's warehouse and a swap's
// replacement, each held to its service; the stock container a planned
// delivery or swap holds back, generated from the row and unique per company
// among the planned stops — fourteen statements diffed from the pickup as
// 0023 left it (pickup-as-of.ts), since an applied file is never edited;
// execution-rendering.test.ts maps today's table back (`CHANGED_IN_0032`).
// Then migration 0032, which is exactly those statements under its header:
// no table is new, so nothing is hand-written, and every row present is an
// emptying, a repair or a wash, which books nothing and holds nothing back, so
// nothing is guarded. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { subscription } from "../schema/agreements"
import { wasteFraction } from "../schema/catalogue"
import { container } from "../schema/containers"
import { property, sharedCollectionPoint } from "../schema/customers"
import { pickup, route } from "../schema/execution"
import { company, project } from "../schema/organisation"
import { warehouse } from "../schema/places"
import { normalised, statementsOf } from "../sql/hand-written"
import { BOOKED_SHAPES, RESERVED_CONTAINER, TAKEN_CONTAINER } from "./execution-shapes"
import { pickupAsOf0023 } from "./pickup-as-of"
import { checksOf, ref } from "./rendering"
import { statementsBetween } from "./specimen"

const MIGRATION = "0032_stop_ledger.sql"

const referenced = { company, project, route, container, property, sharedCollectionPoint, wasteFraction, subscription, warehouse }

const fk = (column: string, target: string) =>
  `ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_${column}_fk" FOREIGN KEY ("company_id","project_id","${column}") REFERENCES "wms"."${target}"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;`
const indexOf = (column: string) => `CREATE INDEX "pickup_${column}_idx" ON "wms"."pickup" USING btree ("company_id","${column}");`
const shapeOf = (constraint: string) => `ALTER TABLE "wms"."pickup" ADD ${constraint};`

describe("the stop's ledger bookings as drizzle-kit writes them", () => {
  const generated = statementsBetween({ ...referenced, pickup: pickupAsOf0023 }, { ...referenced, pickup })

  test("the three bookings with their keys and indexes, each held to its service, and one planned stop per reserved container and per taken one", async () => {
    assert.deepEqual(await generated, [
      'ALTER TABLE "wms"."pickup" ADD COLUMN "subscription_id" uuid;',
      'ALTER TABLE "wms"."pickup" ADD COLUMN "warehouse_id" uuid;',
      'ALTER TABLE "wms"."pickup" ADD COLUMN "replacement_container_id" uuid;',
      `ALTER TABLE "wms"."pickup" ADD COLUMN "reserved_container_id" uuid GENERATED ALWAYS AS (${RESERVED_CONTAINER}) STORED;`,
      `ALTER TABLE "wms"."pickup" ADD COLUMN "taken_container_id" uuid GENERATED ALWAYS AS (${TAKEN_CONTAINER}) STORED;`,
      fk("subscription_id", "subscription"),
      fk("warehouse_id", "warehouse"),
      fk("replacement_container_id", "container"),
      `CREATE UNIQUE INDEX "pickup_reserved_container_id_key" ON "wms"."pickup" USING btree ("company_id","reserved_container_id") WHERE ${ref("pickup", "reserved_container_id")} is not null;`,
      `CREATE UNIQUE INDEX "pickup_taken_container_id_key" ON "wms"."pickup" USING btree ("company_id","taken_container_id") WHERE ${ref("pickup", "taken_container_id")} is not null;`,
      indexOf("subscription_id"),
      indexOf("warehouse_id"),
      indexOf("replacement_container_id"),
      ...BOOKED_SHAPES.map(shapeOf),
    ])
  })

  test("migration 0032 is exactly those statements", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
    assert.deepEqual(statements, (await generated).map(normalised))
  })

  test("the checks render without parameters, a swap's replacement never the container it replaces", () => {
    assert.equal(checksOf(pickup).get("pickup_replacement_shape"), `(${ref("pickup", "service")} = 'swap') = (${ref("pickup", "replacement_container_id")} is not null) and (${ref("pickup", "replacement_container_id")} is null or ${ref("pickup", "replacement_container_id")} <> ${ref("pickup", "container_id")})`)
  })
})
