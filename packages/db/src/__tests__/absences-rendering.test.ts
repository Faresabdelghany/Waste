// When a driver or a vehicle is not there (O6 of #290) as drizzle-kit writes
// it: two tables of dated periods, each a validity under its `validPeriod`
// check and its reason's `one_of`, keyed to its driver or its vehicle through
// the project. Then the migration, which begins with exactly those statements
// and carries below them each table's fence and trigger, its exclusion over
// the driver or the vehicle (one period covers a day), and the audit trail's
// two triggers, each naming its parent (ABSENCES_AUDITED). No database.
import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { DRIVER_ABSENCE_REASONS, VEHICLE_UNAVAILABILITY_REASONS } from "@waste/domain/resources/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { driverAbsence, vehicleUnavailability } from "../schema/availability"
import { ABSENCES_AUDITED, auditTrail } from "../sql/audit-trail"
import { excludeOverlapping } from "../sql/exclude-overlapping"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, companyFk, createTable, index, oneOfCheck, projectFk, projectFkTo, ref } from "./rendering"
import { statementsBetween } from "./specimen"

/** The file's name ends `_absences.sql`; its number is the next free one on main when it merges. */
const migration = async (): Promise<string> => {
  const [name] = (await readdir(MIGRATIONS_FOLDER)).filter((file) => file.endsWith("_absences.sql"))
  assert.ok(name, "the absences migration")
  return name
}

const validity = (table: string): string => `CONSTRAINT "${table}_validity" CHECK (${ref(table, "valid_to")} is null or ${ref(table, "valid_to")} > ${ref(table, "valid_from")})`

const expected = [
  createTable("driver_absence", "dated", ['"driver_id" uuid NOT NULL', '"reason" text NOT NULL', '"note" text', validity("driver_absence"), oneOfCheck("driver_absence", "reason", ...DRIVER_ABSENCE_REASONS)]),
  createTable("vehicle_unavailability", "dated", ['"vehicle_id" uuid NOT NULL', '"reason" text NOT NULL', '"note" text', validity("vehicle_unavailability"), oneOfCheck("vehicle_unavailability", "reason", ...VEHICLE_UNAVAILABILITY_REASONS)]),
  companyFk("driver_absence"),
  projectFk("driver_absence"),
  projectFkTo("driver_absence", "driver_id", "driver"),
  companyFk("vehicle_unavailability"),
  projectFk("vehicle_unavailability"),
  projectFkTo("vehicle_unavailability", "vehicle_id", "vehicle"),
  index("driver_absence", "driver_absence_project_id_valid_from_idx", "company_id", "project_id", "valid_from"),
  index("vehicle_unavailability", "vehicle_unavailability_project_id_valid_from_idx", "company_id", "project_id", "valid_from"),
]

const handWritten = [
  ...handWrittenStatements(driverAbsence),
  ...excludeOverlapping(driverAbsence, [driverAbsence.driverId]),
  ...handWrittenStatements(vehicleUnavailability),
  ...excludeOverlapping(vehicleUnavailability, [vehicleUnavailability.vehicleId]),
  ...ABSENCES_AUDITED.flatMap(auditTrail),
]

describe("absences and unavailability as drizzle-kit writes them", () => {
  test("two tables of dated periods, each keyed to its driver or its vehicle through the project, with its reason held to the domain's list", async () => {
    assert.deepEqual(await statementsBetween({}, { driverAbsence, vehicleUnavailability }), expected)
  })

  test("the migration is exactly that, then each table's fence, trigger and exclusion, then the audit trail's two triggers naming their parents", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, await migration()), "utf8"))
    assert.deepEqual(statements, [...expected, ...handWritten].map(normalised))
    assert.equal(statements.filter((statement) => statement.includes("EXCLUDE USING gist")).length, 2, "one period of a driver, or of a vehicle, covers a day")
    assert.ok(statements.some((statement) => statement.includes(`wms.audit_row('driver', 'driver_id')`)), "a driver's history reads its absences")
    assert.ok(statements.some((statement) => statement.includes(`wms.audit_row('vehicle', 'vehicle_id')`)), "a vehicle's reads its unavailability")
  })

  test("each checks its period and its reason, and nothing else", () => {
    assert.deepEqual([...checksOf(driverAbsence).keys()], ["driver_absence_validity", "driver_absence_reason_one_of"])
    assert.deepEqual([...checksOf(vehicleUnavailability).keys()], ["vehicle_unavailability_validity", "vehicle_unavailability_reason_one_of"])
  })
})
