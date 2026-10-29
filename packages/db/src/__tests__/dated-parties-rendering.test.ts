// A Property's parties dated (#374) as the migration writes them: the unique
// key over the property, the customer and the role dropped, `valid_from`
// added nullable, every party written before it backfilled with the day it was
// written on its project's clock (src/sql/dated-parties.ts) and only then
// required, `valid_to`, an index on the property the key no longer leads
// with, the validity check, and the exclusion constraint that holds one role
// of a customer at a property once at a time. drizzle-kit writes `valid_from`
// as one NOT NULL `ADD COLUMN`, which a database holding parties refuses, so
// the file splits it around the backfill, as the invoice's parties were. The
// file is found by its name, not its number, which it takes at its turn. No
// database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { propertyParty } from "../schema/customers"
import { datedPartiesBackfill, datedPartiesRequired } from "../sql/dated-parties"
import { excludeOverlapping } from "../sql/exclude-overlapping"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"

/** The migration as it has to be: drizzle-kit's statements, `valid_from` split around the backfill, then the exclusion constraint. */
const DATED = [
  'ALTER TABLE "wms"."property_party" DROP CONSTRAINT "property_party_property_id_customer_id_role_key";',
  'ALTER TABLE "wms"."property_party" ADD COLUMN "valid_from" date;',
  datedPartiesBackfill(),
  datedPartiesRequired(),
  'ALTER TABLE "wms"."property_party" ADD COLUMN "valid_to" date;',
  'CREATE INDEX "property_party_property_id_idx" ON "wms"."property_party" USING btree ("company_id","property_id");',
  `ALTER TABLE "wms"."property_party" ADD CONSTRAINT "property_party_validity" CHECK (${ref("property_party", "valid_to")} is null or ${ref("property_party", "valid_to")} > ${ref("property_party", "valid_from")});`,
  ...excludeOverlapping(propertyParty, [propertyParty.propertyId, propertyParty.customerId, propertyParty.role]),
]

/** The migration's file, by its name: it takes its number at its turn. */
async function migrationFile(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_dated_parties\.sql$/.test(name))
  assert.ok(file !== undefined, "the dated parties' migration")
  return readFile(join(MIGRATIONS_FOLDER, file), "utf8")
}

describe("a Property's parties dated, as the migration writes them", () => {
  test("the unique key dropped, the first day added nullable, backfilled and required, the last day, the index, the check and the exclusion constraint — and nothing else", async () => {
    assert.deepEqual(statementsOf(await migrationFile()), DATED.map(normalised))
  })

  test("its header says plainly that the parties written before it hold their role from the day each was written", async () => {
    assert.match(await migrationFile(), /^-- A Property's parties dated \(#374\): parties written before this migration hold their role from the day each was written/m)
  })

  test("the schema is what the statements make: a NOT NULL first day, a nullable last one, and the validity check", () => {
    assert.deepEqual({ type: propertyParty.validFrom.getSQLType(), notNull: propertyParty.validFrom.notNull }, { type: "date", notNull: true })
    assert.deepEqual({ type: propertyParty.validTo.getSQLType(), notNull: propertyParty.validTo.notNull }, { type: "date", notNull: false })
    assert.equal(checksOf(propertyParty).get("property_party_validity"), `${ref("property_party", "valid_to")} is null or ${ref("property_party", "valid_to")} > ${ref("property_party", "valid_from")}`)
  })

  test("the backfill takes each party's day on its own project's clock, from the project of the same company", () => {
    assert.match(datedPartiesBackfill(), /\(pp\."created_at" AT TIME ZONE p\."timezone"\)::date/)
    assert.match(datedPartiesBackfill(), /p\."company_id" = pp\."company_id" AND p\."id" = pp\."project_id"/)
  })
})
