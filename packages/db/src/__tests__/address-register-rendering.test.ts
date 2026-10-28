// The address register (#291 C13) as the migration writes it: a property's
// address register id and the address's parts, all nullable, with the shape
// check that keeps the parts with the id and the two four-digit codes.
// drizzle-kit, diffing the snapshot before the migration against its own,
// writes exactly the columns and their checks, and the file is them under its
// header: no table is new, so nothing is hand-written, and every row present
// passes. The file is found by its name, not its number, which it takes at
// its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { FOUR_DIGITS_PATTERN } from "@waste/domain/registry/address"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { property } from "../schema/customers"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"

const addColumn = (column: string, type: string) => `ALTER TABLE "wms"."property" ADD COLUMN "${column}" ${type};`
const addCheck = (name: string, text: string) => `ALTER TABLE "wms"."property" ADD CONSTRAINT "${name}" CHECK (${text});`

const PARTS = ["street_name", "house_number", "floor", "door", "postcode", "post_town", "municipality_code"]
/** The parts every found address has; a floor and a door only a unit. */
const ALWAYS = ["street_name", "house_number", "postcode", "post_town", "municipality_code"]
const SHAPE = `${ALWAYS.map((column) => `(${ref("property", "address_id")} is null) = (${ref("property", column)} is null)`).join(" and ")} and (${ref("property", "address_id")} is not null or (${ref("property", "floor")} is null and ${ref("property", "door")} is null))`
const fourDigits = (column: string) => `${ref("property", column)} ~ '${FOUR_DIGITS_PATTERN}'`

const GREW = [
  addColumn("address_id", "uuid"),
  ...PARTS.map((column) => addColumn(column, "text")),
  addCheck("property_address_shape", SHAPE),
  addCheck("property_postcode_shape", fourDigits("postcode")),
  addCheck("property_municipality_code_shape", fourDigits("municipality_code")),
]

/** The migration's file name, by its name: it takes its number at its turn. */
async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_address_register\.sql$/.test(name))
  assert.ok(file !== undefined, "the address register's migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

describe("the address register as the migration writes it", () => {
  test("drizzle-kit, diffing the snapshot before against the migration's own, adds the columns and their checks", async () => {
    const own = (await migrationName()).slice(0, 4)
    const before = String(Number(own) - 1).padStart(4, "0")
    assert.deepEqual((await generateMigration(await snapshot(before), await snapshot(own))).map(normalised).sort(), GREW.map(normalised).sort())
  })

  test("the migration is exactly those statements under its header, and nothing hand-written", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    assert.deepEqual(statementsOf(text), GREW.map(normalised))
    assert.match(text, /^-- The address register \(#291 C13, #290 O29\)/)
  })

  test("the schema is what the statements make: a nullable uuid and nullable texts, and the checks the domain's pattern spells", () => {
    assert.deepEqual({ type: property.addressId.getSQLType(), notNull: property.addressId.notNull }, { type: "uuid", notNull: false })
    for (const column of [property.streetName, property.houseNumber, property.floor, property.door, property.postcode, property.postTown, property.municipalityCode]) {
      assert.deepEqual({ type: column.getSQLType(), notNull: column.notNull }, { type: "text", notNull: false }, column.name)
    }
    assert.equal(checksOf(property).get("property_address_shape"), SHAPE)
    assert.equal(checksOf(property).get("property_postcode_shape"), fourDigits("postcode"))
    assert.equal(checksOf(property).get("property_municipality_code_shape"), fourDigits("municipality_code"))
  })
})
