// A route's workload (O10 of #290) as the migration writes it: a waste
// fraction's density, kg per cubic metre, and a container type's service
// seconds, each nullable and held to the domain's bounds. drizzle-kit,
// diffing the snapshot before the migration against its own, writes exactly
// those four statements, and the file is them under its header: no table is
// new, so nothing is hand-written, and every row present passes. The file is
// found by its name, not its number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { DENSITY_KG_PER_CUBIC_METRE, SERVICE_SECONDS } from "@waste/domain/execution/workload"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { containerType, wasteFraction } from "../schema/catalogue"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"

const DENSITY_RANGE = `${ref("waste_fraction", "density_kg_per_cubic_metre")} between ${DENSITY_KG_PER_CUBIC_METRE.min} and ${DENSITY_KG_PER_CUBIC_METRE.max}`
const SERVICE_RANGE = `${ref("container_type", "service_seconds")} between ${SERVICE_SECONDS.min} and ${SERVICE_SECONDS.max}`

const GREW = [
  'ALTER TABLE "wms"."container_type" ADD COLUMN "service_seconds" integer;',
  'ALTER TABLE "wms"."waste_fraction" ADD COLUMN "density_kg_per_cubic_metre" integer;',
  `ALTER TABLE "wms"."container_type" ADD CONSTRAINT "container_type_service_seconds_range" CHECK (${SERVICE_RANGE});`,
  `ALTER TABLE "wms"."waste_fraction" ADD CONSTRAINT "waste_fraction_density_kg_per_cubic_metre_range" CHECK (${DENSITY_RANGE});`,
]

/** The migration's file name, by its name: it takes its number at its turn. */
async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_workload\.sql$/.test(name))
  assert.ok(file !== undefined, "the workload's migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

describe("a route's workload as the migration writes it", () => {
  test("drizzle-kit, diffing the snapshot before against the migration's own, adds the two columns and their ranges", async () => {
    const own = (await migrationName()).slice(0, 4)
    const before = String(Number(own) - 1).padStart(4, "0")
    assert.deepEqual((await generateMigration(await snapshot(before), await snapshot(own))).map(normalised).sort(), GREW.map(normalised).sort())
  })

  test("the migration is exactly those statements under its header, and nothing hand-written", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    assert.deepEqual(statementsOf(text), GREW.map(normalised))
    assert.match(text, /^-- A route's workload \(O10 of #290\)/)
  })

  test("the schema is what the statements make: two nullable integers, and the ranges the domain's bounds spell", () => {
    assert.deepEqual({ type: wasteFraction.densityKgPerCubicMetre.getSQLType(), notNull: wasteFraction.densityKgPerCubicMetre.notNull }, { type: "integer", notNull: false })
    assert.deepEqual({ type: containerType.serviceSeconds.getSQLType(), notNull: containerType.serviceSeconds.notNull }, { type: "integer", notNull: false })
    assert.equal(checksOf(wasteFraction).get("waste_fraction_density_kg_per_cubic_metre_range"), DENSITY_RANGE)
    assert.equal(checksOf(containerType).get("container_type_service_seconds_range"), SERVICE_RANGE)
  })
})
