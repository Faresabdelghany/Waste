// A waste fraction's hazardous flag (O18 of #290) as the migration writes it:
// `hazardous`, NOT NULL and false by default, and the check that holds a
// fraction under a starred code to hazardous. drizzle-kit, diffing the
// snapshot before the migration against its own, writes the column and the
// check; the file is them with the backfill between, which sets every
// fraction already under a starred code before the check is added. The file
// is found by its name, not its number, which it takes at its turn;
// registry-rendering.test.ts maps today's CREATE TABLE back onto 0050's
// (`CHANGED_FOR_HAZARDOUS`). No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { wasteFraction } from "../schema/catalogue"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"

export const HAZARDOUS_SHAPE = `${ref("waste_fraction", "hazardous")} or ${ref("waste_fraction", "waste_code")} is null or ${ref("waste_fraction", "waste_code")} not like '%*'`

const ADDED = 'ALTER TABLE "wms"."waste_fraction" ADD COLUMN "hazardous" boolean DEFAULT false NOT NULL;'
const BACKFILL = `UPDATE "wms"."waste_fraction" SET "hazardous" = true WHERE "waste_code" like '%*';`
const CHECKED = `ALTER TABLE "wms"."waste_fraction" ADD CONSTRAINT "waste_fraction_hazardous_shape" CHECK (${HAZARDOUS_SHAPE});`

/** The migration's file name, by its name: it takes its number at its turn. */
async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_fraction_hazardous\.sql$/.test(name))
  assert.ok(file !== undefined, "the hazardous flag's migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

describe("a waste fraction's hazardous flag as the migration writes it", () => {
  test("drizzle-kit, diffing the snapshot before against the migration's own, adds the column and its check", async () => {
    const own = (await migrationName()).slice(0, 4)
    const before = String(Number(own) - 1).padStart(4, "0")
    assert.deepEqual(await generateMigration(await snapshot(before), await snapshot(own)), [ADDED, CHECKED])
  })

  test("the migration is the column, the backfill of the starred codes, then the check, under its header", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    assert.deepEqual(statementsOf(text), [ADDED, BACKFILL, CHECKED].map(normalised))
    assert.match(text, /^-- A waste fraction's hazardous flag \(O18 of #290, row 1\.16\)/)
  })

  test("the schema is what the statements make: a boolean, false by default, and the check over the code's asterisk", () => {
    assert.deepEqual({ type: wasteFraction.hazardous.getSQLType(), notNull: wasteFraction.hazardous.notNull, default: wasteFraction.hazardous.default }, { type: "boolean", notNull: true, default: false })
    assert.equal(checksOf(wasteFraction).get("waste_fraction_hazardous_shape"), HAZARDOUS_SHAPE)
  })
})
