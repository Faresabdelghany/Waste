// A product sold by the item (#449) as the migration writes it: the product's
// unit check dropped and added again with `item`, a bulky-waste booking's
// things priced by their count. drizzle-kit's two statements are the whole
// file under its header: no table is new and no product present is of the
// new unit. The file is found by its name, not its number. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { PRODUCT_UNITS } from "@waste/domain/registry/vocabulary"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { product } from "../schema/catalogue"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, list, ref } from "./rendering"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_item_product_unit\.sql$/.test(name))
  assert.ok(file !== undefined, "the item unit's migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

/** The units the item's migration wrote: today's less the weight charges' `tonne`, which a later migration added (O28 of #290). */
const UNITS_AS_OF_ITEM = PRODUCT_UNITS.filter((unit) => unit !== "tonne")

const UNIT_ONE_OF = `ALTER TABLE "wms"."product" ADD CONSTRAINT "product_unit_one_of" CHECK (${ref("product", "unit")} in (${list(...UNITS_AS_OF_ITEM)}));`

describe("the item unit's migration", () => {
  test("is drizzle-kit's statements alone: the unit check dropped and added with the item", async () => {
    const file = await migrationName()
    const own = file.slice(0, 4)
    const generated = (await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own))).map(normalised)
    const expected = ['ALTER TABLE "wms"."product" DROP CONSTRAINT "product_unit_one_of";', UNIT_ONE_OF].map(normalised)
    assert.deepEqual(generated, expected)
    const text = await readFile(join(MIGRATIONS_FOLDER, file), "utf8")
    assert.deepEqual(statementsOf(text), expected)
    assert.match(text, /^-- A product sold by the item \(#449\)/)
  })

  test("the units grew by the item, last as of its migration, and the schema's check spells today's", () => {
    assert.equal(UNITS_AS_OF_ITEM.at(-1), "item")
    assert.equal(checksOf(product).get("product_unit_one_of"), `${ref("product", "unit")} in (${list(...PRODUCT_UNITS)})`)
  })
})
