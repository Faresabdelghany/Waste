// The fleet's emissions (M10 of #293) as drizzle-kit writes them: a fuel's
// factor over its period, in grams per unit from zero to the domain's bound,
// with the source it is quoted from, and a vehicle type's consumption by
// fuel, once per type and fuel, from one to the domain's bound. Then
// migration 0039, which has to begin with exactly those statements and carry
// below them the two tables' fences and triggers, the factors' exclusion of
// two periods of one fuel at once, and their audit trail
// (`EMISSIONS_AUDITED`). No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { GRAMS_PER_UNIT_MAX, MILLI_UNITS_PER_KM_MAX } from "@waste/domain/resources/emissions"
import { FUEL_TYPES } from "@waste/domain/resources/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { fuelEmissionFactor, vehicleTypeConsumption } from "../schema/emissions"
import { vehicleType } from "../schema/fleet-types"
import { auditTrail, EMISSIONS_AUDITED } from "../sql/audit-trail"
import { excludeOverlapping } from "../sql/exclude-overlapping"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, columns, companyFk, createTable, oneOfCheck, ref, tenantFk, uniqueKey, VALIDITY, validityCheck } from "./rendering"
import { statementsFor } from "./specimen"

const MIGRATION = "0039_fleet_emissions.sql"

const GRAMS = `${ref("fuel_emission_factor", "grams_per_unit")} between 0 and ${GRAMS_PER_UNIT_MAX}`
const SOURCE = `length(btrim(${ref("fuel_emission_factor", "source")})) > 0`
const CONSUMPTION = `${ref("vehicle_type_consumption", "milli_units_per_km")} between 1 and ${MILLI_UNITS_PER_KM_MAX}`

const expected = [
  createTable("fuel_emission_factor", "tenant", [
    '"fuel" text NOT NULL',
    '"grams_per_unit" integer NOT NULL',
    '"source" text NOT NULL',
    ...VALIDITY,
    oneOfCheck("fuel_emission_factor", "fuel", ...FUEL_TYPES),
    `CONSTRAINT "fuel_emission_factor_grams_per_unit_bounds" CHECK (${GRAMS})`,
    `CONSTRAINT "fuel_emission_factor_source_given" CHECK (${SOURCE})`,
    validityCheck("fuel_emission_factor"),
  ]),
  createTable("vehicle_type_consumption", "tenant", [
    '"vehicle_type_id" uuid NOT NULL',
    '"fuel" text NOT NULL',
    '"milli_units_per_km" integer NOT NULL',
    uniqueKey("vehicle_type_consumption_type_fuel_key", "company_id", "vehicle_type_id", "fuel"),
    oneOfCheck("vehicle_type_consumption", "fuel", ...FUEL_TYPES),
    `CONSTRAINT "vehicle_type_consumption_milli_units_per_km_bounds" CHECK (${CONSUMPTION})`,
  ]),
  companyFk("fuel_emission_factor"),
  companyFk("vehicle_type_consumption"),
  tenantFk("vehicle_type_consumption", "vehicle_type_id", "vehicle_type"),
]

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the emissions as drizzle-kit writes them", () => {
  test("a fuel's factor over its period with its source, and a vehicle type's consumption once per fuel", async () => {
    assert.deepEqual(await statementsFor({ fuelEmissionFactor, vehicleTypeConsumption }), expected)
  })

  test("migration 0039 is exactly that, then the fences and triggers, the factors' exclusion by fuel, and the audit trail", async () => {
    assert.deepEqual(
      await fileStatements(),
      [
        ...expected,
        ...[fuelEmissionFactor, vehicleTypeConsumption].flatMap((table) => handWrittenStatements(table)),
        ...excludeOverlapping(fuelEmissionFactor, [fuelEmissionFactor.fuel]),
        ...EMISSIONS_AUDITED.flatMap(auditTrail),
      ].map(normalised),
    )
  })

  test("two periods of one fuel never hold a day together, within the company", () => {
    assert.deepEqual(excludeOverlapping(fuelEmissionFactor, [fuelEmissionFactor.fuel]), [
      `ALTER TABLE "wms"."fuel_emission_factor" ADD CONSTRAINT "fuel_emission_factor_no_overlap" EXCLUDE USING gist (${columns("company_id")} WITH =, ${columns("fuel")} WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);`,
    ])
  })
})

describe("the checks", () => {
  test("a factor is a fuel of Resources' vocabulary, zero to the domain's bound, with a source and an ordered period", () => {
    assert.deepEqual([...checksOf(fuelEmissionFactor).keys()], ["fuel_emission_factor_fuel_one_of", "fuel_emission_factor_grams_per_unit_bounds", "fuel_emission_factor_source_given", "fuel_emission_factor_validity"])
    assert.equal(checksOf(fuelEmissionFactor).get("fuel_emission_factor_grams_per_unit_bounds"), GRAMS)
  })

  test("a consumption is a fuel of the vocabulary, one to the domain's bound", () => {
    assert.deepEqual([...checksOf(vehicleTypeConsumption).keys()], ["vehicle_type_consumption_fuel_one_of", "vehicle_type_consumption_milli_units_per_km_bounds"])
    assert.equal(checksOf(vehicleTypeConsumption).get("vehicle_type_consumption_milli_units_per_km_bounds"), CONSUMPTION)
  })

  test("0039 audits both under master data, the consumption as a set of its vehicle type", () => {
    assert.deepEqual(EMISSIONS_AUDITED.map((entry) => [entry.table, entry.module]), [
      [fuelEmissionFactor, "configure.master"],
      [vehicleTypeConsumption, "configure.master"],
    ])
    assert.equal(EMISSIONS_AUDITED[0].parent, undefined)
    assert.deepEqual(EMISSIONS_AUDITED[1].parent, { table: vehicleType, column: vehicleTypeConsumption.vehicleTypeId })
  })
})
