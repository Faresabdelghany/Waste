// A waste fraction's waste code (#291 slice 29) as drizzle-kit writes it:
// `waste_code`, nullable, and `waste_fraction_waste_code_shape`, which holds
// it to the European List of Waste's six digits as
// @waste/domain/registry/waste-code spells them — two ALTER TABLE statements,
// held to what drizzle-kit diffs between the 0028 and 0029 snapshots it
// wrote, so the committed SQL is `pnpm db:generate`'s; registry-rendering.test.ts
// maps today's table back onto 0004's (`CHANGED_IN_0029`). No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { WASTE_CODE_PATTERN } from "@waste/domain/registry/waste-code"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { wasteFraction } from "../schema/catalogue"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"

const MIGRATION = "0029_waste_code.sql"

const snapshot = async (n: string): Promise<Parameters<typeof generateMigration>[0]> =>
  JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Parameters<typeof generateMigration>[0]

const SHAPE = `${ref("waste_fraction", "waste_code")} ~ '${WASTE_CODE_PATTERN}'`

const altered = [
  `ALTER TABLE "wms"."waste_fraction" ADD COLUMN "waste_code" text;`,
  `ALTER TABLE "wms"."waste_fraction" ADD CONSTRAINT "waste_fraction_waste_code_shape" CHECK (${SHAPE});`,
]

describe("a waste fraction's waste code as drizzle-kit writes it", () => {
  test("drizzle-kit, diffing 0028's snapshot against 0029's, adds the nullable column and its shape check", async () => {
    assert.deepEqual(await generateMigration(await snapshot("0028"), await snapshot("0029")), altered)
  })

  test("the schema's column is nullable text and its check the domain's pattern", () => {
    assert.deepEqual({ sqlType: wasteFraction.wasteCode.getSQLType(), notNull: wasteFraction.wasteCode.notNull }, { sqlType: "text", notNull: false })
    assert.equal(checksOf(wasteFraction).get("waste_fraction_waste_code_shape"), SHAPE)
  })

  test("migration 0029 is exactly that, and nothing hand-written: the fence, the trigger and the audit trail are the table's", async () => {
    assert.deepEqual(statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8")), altered.map(normalised))
  })
})
