// The sustainability report's configuration (M13 of #293) as drizzle-kit
// writes it: a waste fraction's treatment, nullable over the domain's list,
// and a fraction's emission factor over its period, kilograms per tonne from
// zero to the domain's bound, with the source it is quoted from. Then the
// migration, which has to be exactly what drizzle-kit diffs between the
// snapshot before it and its own — so the committed SQL is
// `pnpm db:generate`'s — and carry below it the factors' fence and trigger,
// their exclusion of two periods of one fraction at once, and their audit
// trail (`SUSTAINABILITY_AUDITED`); registry-rendering.test.ts maps today's
// fraction back (`CHANGED_IN_0043`). No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { KG_PER_TONNE_MAX } from "@waste/domain/insight/sustainability"
import { WASTE_TREATMENTS } from "@waste/domain/registry/vocabulary"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { wasteFraction } from "../schema/catalogue"
import { wasteFractionEmissionFactor } from "../schema/sustainability"
import { auditTrail, SUSTAINABILITY_AUDITED } from "../sql/audit-trail"
import { excludeOverlapping } from "../sql/exclude-overlapping"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, columns, companyFk, createTable, index, ref, tenantFk, VALIDITY, validityCheck } from "./rendering"
import { statementsFor } from "./specimen"

const MIGRATION = "0043_sustainability.sql"
/** The snapshot before the migration's own, by number: what drizzle-kit diffed against. */
const BEFORE = String(Number(MIGRATION.slice(0, 4)) - 1).padStart(4, "0")

const snapshot = async (n: string): Promise<Parameters<typeof generateMigration>[0]> =>
  JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Parameters<typeof generateMigration>[0]

const bounds = (column: string) => `${ref("waste_fraction_emission_factor", column)} between 0 and ${KG_PER_TONNE_MAX}`
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

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the sustainability report's configuration as drizzle-kit writes it", () => {
  test("a fraction's factor over its period, both factors within the domain's bound, with a source", async () => {
    assert.deepEqual(await statementsFor({ wasteFractionEmissionFactor }), [factorTable, companyFk("waste_fraction_emission_factor"), tenantFk("waste_fraction_emission_factor", "waste_fraction_id", "waste_fraction"), generated[4]])
  })

  test("drizzle-kit, diffing the snapshot before against the migration's own, adds the table and the fraction's treatment with its check", async () => {
    assert.deepEqual((await generateMigration(await snapshot(BEFORE), await snapshot(MIGRATION.slice(0, 4)))).map(normalised), generated.map(normalised))
  })

  test("the migration is exactly that, then the factors' fence and trigger, their exclusion by fraction, and their audit trail", async () => {
    assert.deepEqual(
      await fileStatements(),
      [...generated, ...handWrittenStatements(wasteFractionEmissionFactor), ...excludeOverlapping(wasteFractionEmissionFactor, [wasteFractionEmissionFactor.wasteFractionId]), ...SUSTAINABILITY_AUDITED.flatMap(auditTrail)].map(normalised),
    )
  })

  test("two periods of one fraction never hold a day together, within the company", () => {
    assert.deepEqual(excludeOverlapping(wasteFractionEmissionFactor, [wasteFractionEmissionFactor.wasteFractionId]), [
      `ALTER TABLE "wms"."waste_fraction_emission_factor" ADD CONSTRAINT "waste_fraction_emission_factor_no_overlap" EXCLUDE USING gist (${columns("company_id")} WITH =, ${columns("waste_fraction_id")} WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);`,
    ])
  })
})

describe("the checks", () => {
  test("a fraction's treatment is nullable text of the domain's list", () => {
    assert.deepEqual({ sqlType: wasteFraction.treatment.getSQLType(), notNull: wasteFraction.treatment.notNull }, { sqlType: "text", notNull: false })
    assert.equal(checksOf(wasteFraction).get("waste_fraction_treatment_one_of"), TREATMENT)
  })

  test("a factor's two figures are zero to the domain's bound, the avoided one nullable, with a source and an ordered period", () => {
    assert.deepEqual([...checksOf(wasteFractionEmissionFactor).keys()], ["waste_fraction_emission_factor_footprint_bounds", "waste_fraction_emission_factor_avoided_bounds", "waste_fraction_emission_factor_source_given", "waste_fraction_emission_factor_validity"])
    assert.equal(wasteFractionEmissionFactor.avoidedKgPerTonne.notNull, false)
  })

  test("the factors are audited under master data, their own rows, not a set of the fraction", () => {
    assert.deepEqual(SUSTAINABILITY_AUDITED.map((entry) => [entry.table, entry.module, entry.parent]), [[wasteFractionEmissionFactor, "configure.master", undefined]])
  })
})
