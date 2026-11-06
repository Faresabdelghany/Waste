// The sustainability report's configuration (M13 of #293) as migration 0043
// wrote it: a waste fraction's treatment, nullable over the domain's list,
// and a fraction's emission factor over its period, kilograms per tonne from
// zero to 10 000, with the source it is quoted from. The migration has to be
// exactly what drizzle-kit diffs between the snapshot before it and its own
// — so the committed SQL is `pnpm db:generate`'s — and carry below it the
// factors' fence and trigger, their exclusion of two periods of one fraction
// at once, and their audit trail; registry-rendering.test.ts maps today's
// fraction back (`CHANGED_IN_0043`). The factors' table was dropped with the
// emission factors (`drop_emissions`), so the schema holds it no more and
// the statements below drizzle-kit's are frozen as the merged file spells
// them; the treatment stays the fraction's. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { WASTE_TREATMENTS } from "@waste/domain/registry/vocabulary"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { wasteFraction } from "../schema/catalogue"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, companyFk, createTable, index, ref, tenantFk, VALIDITY, validityCheck } from "./rendering"

const MIGRATION = "0043_sustainability.sql"
/** The snapshot before the migration's own, by number: what drizzle-kit diffed against. */
const BEFORE = String(Number(MIGRATION.slice(0, 4)) - 1).padStart(4, "0")

const snapshot = async (n: string): Promise<Parameters<typeof generateMigration>[0]> =>
  JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Parameters<typeof generateMigration>[0]

const bounds = (column: string) => `${ref("waste_fraction_emission_factor", column)} between 0 and 10000`
const SOURCE = `length(btrim(${ref("waste_fraction_emission_factor", "source")})) > 0`
const TREATMENT = `${ref("waste_fraction", "treatment")} in (${WASTE_TREATMENTS.map((value) => `'${value}'`).join(", ")})`

const factorTable = createTable("waste_fraction_emission_factor", "tenant", [
  '"waste_fraction_id" uuid NOT NULL',
  '"footprint_kg_per_tonne" integer NOT NULL',
  '"avoided_kg_per_tonne" integer',
  '"source" text NOT NULL',
  ...VALIDITY,
  `CONSTRAINT "waste_fraction_emission_factor_footprint_bounds" CHECK (${bounds("footprint_kg_per_tonne")})`,
  `CONSTRAINT "waste_fraction_emission_factor_avoided_bounds" CHECK (${bounds("avoided_kg_per_tonne")})`,
  `CONSTRAINT "waste_fraction_emission_factor_source_given" CHECK (${SOURCE})`,
  validityCheck("waste_fraction_emission_factor"),
])

/** What drizzle-kit writes for the migration: the factors' table and the fraction's two additions, the column and its check. */
const generated = [
  factorTable,
  `ALTER TABLE "wms"."waste_fraction" ADD COLUMN "treatment" text;`,
  companyFk("waste_fraction_emission_factor"),
  tenantFk("waste_fraction_emission_factor", "waste_fraction_id", "waste_fraction"),
  index("waste_fraction_emission_factor", "waste_fraction_emission_factor_waste_fraction_id_idx", "company_id", "waste_fraction_id"),
  `ALTER TABLE "wms"."waste_fraction" ADD CONSTRAINT "waste_fraction_treatment_one_of" CHECK (${TREATMENT});`,
]

/** The hand-written statements below drizzle-kit's, as the merged file spells them: the factors' fence and trigger, their exclusion by fraction, and their audit trail. */
const TAIL = [
  'ALTER TABLE "wms"."waste_fraction_emission_factor" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "waste_fraction_emission_factor_tenant_fence" ON "wms"."waste_fraction_emission_factor" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));',
  'CREATE TRIGGER "waste_fraction_emission_factor_touch_updated_at" BEFORE UPDATE ON "wms"."waste_fraction_emission_factor" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();',
  `ALTER TABLE "wms"."waste_fraction_emission_factor" ADD CONSTRAINT "waste_fraction_emission_factor_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "waste_fraction_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);`,
  `CREATE TRIGGER "waste_fraction_emission_factor_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."waste_fraction_emission_factor" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');`,
]

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the sustainability report's configuration as migration 0043 wrote it", () => {
  test("drizzle-kit, diffing the snapshot before against the migration's own, adds the table and the fraction's treatment with its check", async () => {
    assert.deepEqual((await generateMigration(await snapshot(BEFORE), await snapshot(MIGRATION.slice(0, 4)))).map(normalised), generated.map(normalised))
  })

  test("the migration is exactly that, then the factors' fence and trigger, their exclusion by fraction, and their audit trail", async () => {
    assert.deepEqual(await fileStatements(), [...generated, ...TAIL].map(normalised))
  })
})

describe("the checks", () => {
  test("a fraction's treatment is nullable text of the domain's list", () => {
    assert.deepEqual({ sqlType: wasteFraction.treatment.getSQLType(), notNull: wasteFraction.treatment.notNull }, { sqlType: "text", notNull: false })
    assert.equal(checksOf(wasteFraction).get("waste_fraction_treatment_one_of"), TREATMENT)
  })
})
