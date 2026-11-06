// The fleet's emissions (M10 of #293) as migration 0039 wrote them: a fuel's
// factor over its period, in grams per unit from zero to 10 000, with the
// source it is quoted from, and a vehicle type's consumption by fuel, once
// per type and fuel, from one to 10 000. Below drizzle-kit's statements the
// file carries the two tables' fences and triggers, the factors' exclusion
// of two periods of one fuel at once, and their audit trail. Both tables were
// dropped with the emission factors (`drop_emissions`), so the schema holds
// them no more: the file is held to what drizzle-kit diffs between the
// snapshot before it and its own, and the hand-written statements below it
// are frozen as the merged file spells them, the fuels and the bounds as they
// were that day. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { normalised, statementsOf } from "../sql/hand-written"
import { companyFk, createTable, oneOfCheck, ref, tenantFk, uniqueKey, VALIDITY, validityCheck } from "./rendering"

const MIGRATION = "0039_fleet_emissions.sql"
/** The snapshot before the migration's own, by number: what drizzle-kit diffed against. */
const BEFORE = String(Number(MIGRATION.slice(0, 4)) - 1).padStart(4, "0")

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

/** Resources' fuels as 0039 spelled them into both tables' checks. */
const FUELS_AS_OF_0039 = ["diesel", "hvo", "biogas", "electric", "hybrid", "other"]

const GRAMS = `${ref("fuel_emission_factor", "grams_per_unit")} between 0 and 10000`
const SOURCE = `length(btrim(${ref("fuel_emission_factor", "source")})) > 0`
const CONSUMPTION = `${ref("vehicle_type_consumption", "milli_units_per_km")} between 1 and 10000`

const generated = [
  createTable("fuel_emission_factor", "tenant", [
    '"fuel" text NOT NULL',
    '"grams_per_unit" integer NOT NULL',
    '"source" text NOT NULL',
    ...VALIDITY,
    oneOfCheck("fuel_emission_factor", "fuel", ...FUELS_AS_OF_0039),
    `CONSTRAINT "fuel_emission_factor_grams_per_unit_bounds" CHECK (${GRAMS})`,
    `CONSTRAINT "fuel_emission_factor_source_given" CHECK (${SOURCE})`,
    validityCheck("fuel_emission_factor"),
  ]),
  createTable("vehicle_type_consumption", "tenant", [
    '"vehicle_type_id" uuid NOT NULL',
    '"fuel" text NOT NULL',
    '"milli_units_per_km" integer NOT NULL',
    uniqueKey("vehicle_type_consumption_type_fuel_key", "company_id", "vehicle_type_id", "fuel"),
    oneOfCheck("vehicle_type_consumption", "fuel", ...FUELS_AS_OF_0039),
    `CONSTRAINT "vehicle_type_consumption_milli_units_per_km_bounds" CHECK (${CONSUMPTION})`,
  ]),
  companyFk("fuel_emission_factor"),
  companyFk("vehicle_type_consumption"),
  tenantFk("vehicle_type_consumption", "vehicle_type_id", "vehicle_type"),
]

/** The hand-written statements below drizzle-kit's, as the merged file spells them: each table's fence and trigger, the factors' exclusion by fuel, and the audit trail, the consumption's as a set of its vehicle type. */
const TAIL = [
  'ALTER TABLE "wms"."fuel_emission_factor" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "fuel_emission_factor_tenant_fence" ON "wms"."fuel_emission_factor" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));',
  'CREATE TRIGGER "fuel_emission_factor_touch_updated_at" BEFORE UPDATE ON "wms"."fuel_emission_factor" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();',
  'ALTER TABLE "wms"."vehicle_type_consumption" ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY "vehicle_type_consumption_tenant_fence" ON "wms"."vehicle_type_consumption" AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));',
  'CREATE TRIGGER "vehicle_type_consumption_touch_updated_at" BEFORE UPDATE ON "wms"."vehicle_type_consumption" FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();',
  `ALTER TABLE "wms"."fuel_emission_factor" ADD CONSTRAINT "fuel_emission_factor_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "fuel" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);`,
  `CREATE TRIGGER "fuel_emission_factor_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."fuel_emission_factor" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('', '');`,
  `CREATE TRIGGER "vehicle_type_consumption_audit_trail" AFTER INSERT OR UPDATE OR DELETE ON "wms"."vehicle_type_consumption" FOR EACH ROW EXECUTE FUNCTION wms.audit_row('vehicle_type', 'vehicle_type_id');`,
]

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the emissions as migration 0039 wrote them", () => {
  test("drizzle-kit, diffing the snapshot before against 0039's own, writes a fuel's factor over its period with its source, and a vehicle type's consumption once per fuel", async () => {
    assert.deepEqual((await generateMigration(await snapshot(BEFORE), await snapshot(MIGRATION.slice(0, 4)))).map(normalised), generated.map(normalised))
  })

  test("migration 0039 is exactly that, then the fences and triggers, the factors' exclusion by fuel, and the audit trail", async () => {
    assert.deepEqual(await fileStatements(), [...generated, ...TAIL].map(normalised))
  })
})
