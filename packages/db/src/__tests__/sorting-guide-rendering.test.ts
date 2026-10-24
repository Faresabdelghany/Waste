// The Sorting Guide and the public slug (Issue #293, M1) as drizzle-kit writes
// them: one table of items, and the ALTER TABLEs that give `project` the
// slug it publishes itself under, diffed from 0006's spelling
// (project-as-of.ts), since an applied file is never edited. Then migration
// 0017, which has to begin with exactly those statements and to carry below
// them the item table's fence and trigger and the public door's role, grants
// and policies as src/sql/public-door.ts spells them (ADR-0010). The role as
// a database sees it is public-door.test.ts's. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { SORTING_GUIDE_ITEM_STATUSES } from "@waste/domain/sorting-guide/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { project } from "../schema/organisation"
import { sortingGuideItem } from "../schema/sorting-guide"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { publicDoorStatements } from "../sql/public-door"
import { checksOf, companyFk, createTable, index, oneOfCheck, projectFk, ref, tenantFk, uniqueKey } from "./rendering"
import { projectAsOf } from "./project-as-of"
import { statementsBetween } from "./specimen"

const MIGRATION = "0017_sorting_guide.sql"

const SLUG = `${ref("project", "public_slug")} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(${ref("project", "public_slug")}) between 3 and 63`

const expected = [
  createTable("sorting_guide_item", "project", [
    '"name" text NOT NULL',
    `"synonyms" text[] DEFAULT '{}'::text[] NOT NULL`,
    '"waste_fraction_id" uuid',
    '"instructions" text',
    '"status" text NOT NULL',
    uniqueKey("sorting_guide_item_project_id_name_key", "company_id", "project_id", "name"),
    uniqueKey("sorting_guide_item_project_key", "company_id", "project_id", "id"),
    oneOfCheck("sorting_guide_item", "status", ...SORTING_GUIDE_ITEM_STATUSES),
  ]),
  `ALTER TABLE "wms"."project" ADD COLUMN "public_slug" text;`,
  companyFk("sorting_guide_item"),
  projectFk("sorting_guide_item"),
  tenantFk("sorting_guide_item", "waste_fraction_id", "waste_fraction"),
  index("sorting_guide_item", "sorting_guide_item_waste_fraction_id_idx", "company_id", "waste_fraction_id"),
  `ALTER TABLE "wms"."project" ADD CONSTRAINT "project_public_slug_key" UNIQUE("public_slug");`,
  `ALTER TABLE "wms"."project" ADD CONSTRAINT "project_public_slug_shape" CHECK (${SLUG});`,
]

const generated = (): Promise<string[]> => statementsBetween({ project: projectAsOf("0006") }, { project, sortingGuideItem })

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the Sorting Guide and the public slug as drizzle-kit writes them", () => {
  test("one table of items, and the project's slug as a column, a key across every company and a shape", async () => {
    assert.deepEqual(await generated(), expected)
  })

  test("migration 0017 is exactly that, then the item table's fence and trigger, then the public door", async () => {
    const statements = await fileStatements()
    assert.deepEqual(statements, [...expected, ...handWrittenStatements(sortingGuideItem), ...publicDoorStatements()].map(normalised))
    assert.equal(statements.filter((statement) => statement.includes("TO wms_api USING")).length, 1, "one tenant fence: the item table's")
    assert.equal(statements.filter((statement) => statement.startsWith("CREATE POLICY") && statement.includes("TO wms_public")).length, 3, "one public policy per table the door reads")
  })
})

describe("the checks", () => {
  test("an item's status reads the guide's vocabulary, and the slug's shape is the domain's", () => {
    assert.deepEqual([...checksOf(sortingGuideItem).keys()], ["sorting_guide_item_status_one_of"])
    assert.equal(checksOf(project).get("project_public_slug_shape"), SLUG)
  })
})
