// Fill-level Sensors (O26 of #290, row 9.10) as the migration writes them: a
// sensor identified once across the company, on one of the three networks,
// active or retired; a pairing of a sensor of the project with a container of
// the project over a period, its threshold a whole percent from 1 to 100; and
// the readings, a ledger, one per sensor and instant. Then the file:
// drizzle-kit's statements, then the sensor's and the pairing's fences,
// touches and audit trails with the pairing's two exclusion constraints, then
// the readings' fence and revoke. The file is found by its name, not its
// number. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { SENSOR_NETWORKS, SENSOR_STATUSES } from "@waste/domain/resources/vocabulary"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { alert } from "../schema/resolution"
import { fillReading, sensor, sensorPairing } from "../schema/sensors"
import { auditTrail, SENSORS_AUDITED } from "../sql/audit-trail"
import { excludeOverlapping } from "../sql/exclude-overlapping"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { ALERT_RULES_AS_OF_SENSORS } from "./alert-as-of"
import { checksOf, list, ref } from "./rendering"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_fill_level_sensors\.sql$/.test(name))
  assert.ok(file !== undefined, "the fill-level sensors' migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

/** What drizzle-kit writes for the migration, diffing the snapshot before against its own. */
async function generated(): Promise<string[]> {
  const own = (await migrationName()).slice(0, 4)
  return (await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own))).map(normalised)
}

describe("the fill-level sensors as drizzle-kit writes them", () => {
  test("a sensor's identifier is the company's once; a pairing names a sensor and a container of its project; a reading names a sensor and a pairing of its project, once per instant", async () => {
    const statements = await generated()
    for (const statement of [
      'ALTER TABLE "wms"."sensor_pairing" ADD CONSTRAINT "sensor_pairing_sensor_id_fk" FOREIGN KEY ("company_id","project_id","sensor_id") REFERENCES "wms"."sensor"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;',
      'ALTER TABLE "wms"."sensor_pairing" ADD CONSTRAINT "sensor_pairing_container_id_fk" FOREIGN KEY ("company_id","project_id","container_id") REFERENCES "wms"."container"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;',
      'ALTER TABLE "wms"."fill_reading" ADD CONSTRAINT "fill_reading_sensor_id_fk" FOREIGN KEY ("company_id","project_id","sensor_id") REFERENCES "wms"."sensor"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;',
      'ALTER TABLE "wms"."fill_reading" ADD CONSTRAINT "fill_reading_pairing_id_fk" FOREIGN KEY ("company_id","project_id","pairing_id") REFERENCES "wms"."sensor_pairing"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;',
      'CREATE INDEX "fill_reading_pairing_id_idx" ON "wms"."fill_reading" USING btree ("company_id","pairing_id","measured_at");',
    ]) {
      assert.ok(statements.includes(normalised(statement)), statement)
    }
    assert.match(statements.find((statement) => statement.startsWith('CREATE TABLE "wms"."sensor"')) ?? "", /CONSTRAINT "sensor_identifier_key" UNIQUE\("company_id","identifier"\)/)
    assert.match(statements.find((statement) => statement.startsWith('CREATE TABLE "wms"."fill_reading"')) ?? "", /CONSTRAINT "fill_reading_sensor_id_measured_at_key" UNIQUE\("company_id","sensor_id","measured_at"\)/)
    assert.equal(checksOf(sensor).get("sensor_network_one_of"), `${ref("sensor", "network")} in (${list(...SENSOR_NETWORKS)})`)
    assert.equal(checksOf(sensor).get("sensor_status_one_of"), `${ref("sensor", "status")} in (${list(...SENSOR_STATUSES)})`)
    assert.equal(checksOf(sensorPairing).get("sensor_pairing_threshold_range"), `${ref("sensor_pairing", "full_threshold_percent")} between 1 and 100`)
    assert.equal(checksOf(fillReading).get("fill_reading_fill_range"), `${ref("fill_reading", "fill_percent")} between 0 and 100`)
  })

  test("the alert's rule grows by the filling container", async () => {
    const statements = await generated()
    assert.ok(statements.includes(normalised('ALTER TABLE "wms"."alert" DROP CONSTRAINT "alert_rule_one_of";')))
    assert.ok(statements.includes(normalised(`ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_rule_one_of" CHECK (${ref("alert", "rule")} in (${list(...ALERT_RULES_AS_OF_SENSORS)}));`)))
    assert.equal(ALERT_RULES_AS_OF_SENSORS.at(-1), "fill-threshold")
    assert.ok(checksOf(alert).has("alert_rule_one_of"))
  })
})

describe("the fill-level sensors' migration", () => {
  test("is drizzle-kit's statements, then the sensor's and the pairing's, then the readings' as a ledger", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    const statements = statementsOf(text)
    const drizzle = await generated()
    const [sensorTrail, pairingTrail] = SENSORS_AUDITED.map(auditTrail)
    assert.deepEqual([...statements.slice(0, drizzle.length)].sort(), [...drizzle].sort())
    assert.deepEqual(
      statements.slice(drizzle.length),
      [
        ...handWrittenStatements(sensor),
        ...sensorTrail!,
        ...excludeOverlapping(sensorPairing, [sensorPairing.sensorId]),
        ...excludeOverlapping(sensorPairing, [sensorPairing.containerId], "container"),
        ...handWrittenStatements(sensorPairing),
        ...pairingTrail!,
        ...handWrittenStatements(fillReading),
      ].map(normalised),
    )
    assert.match(text, /^-- Fill-level Sensors \(O26 of #290, row 9\.10\)/)
  })

  test("a sensor's history is its own and a pairing's its sensor's, both under the sensors' grant; the readings keep none", () => {
    assert.deepEqual(
      SENSORS_AUDITED.map((entry) => [entry.table, entry.module, entry.parent]),
      [
        [sensor, "resources.sensors", undefined],
        [sensorPairing, "resources.sensors", { table: sensor, column: sensorPairing.sensorId }],
      ],
    )
  })
})
