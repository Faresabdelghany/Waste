// A project's branding (M22 of #293) as drizzle-kit writes it: one colour and
// two https addresses, three nullable columns on `project` — null is none —
// each held to its shape (`@waste/domain/access/branding`); the colour's
// contrast is the API's to judge. The migration is exactly those statements:
// no table is new, so nothing is written by hand. The file is found by its
// name, not its number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { BRAND_COLOR_PATTERN, HTTPS_ADDRESS_MAX, HTTPS_ADDRESS_PATTERN } from "@waste/domain/access/branding"

import { MIGRATIONS_FOLDER } from "../migrate"
import { statementsOf } from "../sql/hand-written"
import { ref } from "./rendering"

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<string[]> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_project_branding\.sql$/.test(name))
  assert.ok(file !== undefined, "the project branding's migration")
  return statementsOf(await readFile(join(MIGRATIONS_FOLDER, file), "utf8"))
}

const https = (label: string, column: string) =>
  `ALTER TABLE "wms"."project" ADD CONSTRAINT "project_${label}" CHECK (${ref("project", column)} ~ '${HTTPS_ADDRESS_PATTERN}' and char_length(${ref("project", column)}) <= ${HTTPS_ADDRESS_MAX});`

describe("a project's branding as drizzle-kit writes it", () => {
  test("three nullable columns, the colour's shape and each address https within the length: exactly the migration", async () => {
    assert.deepEqual(await migration(), [
      'ALTER TABLE "wms"."project" ADD COLUMN "brand_color" text;',
      'ALTER TABLE "wms"."project" ADD COLUMN "logo_url" text;',
      'ALTER TABLE "wms"."project" ADD COLUMN "accessibility_statement_url" text;',
      `ALTER TABLE "wms"."project" ADD CONSTRAINT "project_brand_color_shape" CHECK (${ref("project", "brand_color")} ~ '${BRAND_COLOR_PATTERN}');`,
      https("logo_url_shape", "logo_url"),
      https("accessibility_statement_url_shape", "accessibility_statement_url"),
    ])
  })
})
