// The stop's service (O3 of #290) as drizzle-kit writes it: `pickup.service`
// backfilled `empty` by its default, its vocabulary and its two shapes, and
// `pickup_route_id_container_id_key` relaxed from a constraint to a unique
// index over generation's stops alone, so the office may repeat a container
// on a route — six statements diffed from the pickup as 0016 left it
// (pickup-as-of.ts), since an applied file is never edited;
// execution-rendering.test.ts maps the table back (`CHANGED_IN_0023`), and
// the pickup as 0023 left it is pickup-as-of.ts's, since 0032 (O3b) changed it
// again.
// Then migration 0023, which is exactly those statements under its header:
// no table is new, so nothing is hand-written, and every row present passes
// the checks and the narrower key, so nothing is guarded. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { PICKUP_SERVICES } from "@waste/domain/execution/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { wasteFraction } from "../schema/catalogue"
import { container } from "../schema/containers"
import { property, sharedCollectionPoint } from "../schema/customers"
import { route } from "../schema/execution"
import { company, project } from "../schema/organisation"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, list, ref } from "./rendering"
import { pickupAsOf0016, pickupAsOf0023 } from "./pickup-as-of"
import { statementsBetween } from "./specimen"

const MIGRATION = "0023_stop_service.sql"

const referenced = { company, project, route, container, property, sharedCollectionPoint, wasteFraction }

describe("the stop's service as drizzle-kit writes it", () => {
  const generated = statementsBetween({ ...referenced, pickup: pickupAsOf0016 }, { ...referenced, pickup: pickupAsOf0023 })

  test("the service, backfilled empty, its vocabulary and its two shapes, and one stop per container held to generation's stops alone", async () => {
    assert.deepEqual(await generated, [
      'ALTER TABLE "wms"."pickup" DROP CONSTRAINT "pickup_route_id_container_id_key";',
      `ALTER TABLE "wms"."pickup" ADD COLUMN "service" text DEFAULT 'empty' NOT NULL;`,
      `CREATE UNIQUE INDEX "pickup_route_id_container_id_key" ON "wms"."pickup" USING btree ("company_id","route_id","container_id") WHERE ${ref("pickup", "origin")} = 'generation';`,
      `ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_service_one_of" CHECK (${ref("pickup", "service")} in (${list(...PICKUP_SERVICES)}));`,
      `ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_service_origin_shape" CHECK (${ref("pickup", "service")} = 'empty' or ${ref("pickup", "origin")} = 'office');`,
      `ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_service_container_shape" CHECK (${ref("pickup", "service")} = 'empty' or ${ref("pickup", "container_id")} is not null);`,
    ])
  })

  test("migration 0023 is exactly those statements", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
    assert.deepEqual(statements, (await generated).map(normalised))
  })

  test("the service defaults to empty — every stop before it emptied its container — and its checks render without parameters", () => {
    assert.deepEqual({ notNull: pickupAsOf0023.service.notNull, default: pickupAsOf0023.service.default }, { notNull: true, default: "empty" })
    assert.equal(checksOf(pickupAsOf0023).get("pickup_service_container_shape"), `${ref("pickup", "service")} = 'empty' or ${ref("pickup", "container_id")} is not null`)
  })
})
