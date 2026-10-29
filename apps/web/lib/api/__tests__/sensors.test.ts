// The fill-level Sensors on the adapter (O26 of #290): a sensor becomes a
// record of Resources › Sensors with the container it measures today and its
// newest reading; the generic form's record becomes the bodies the API's
// contracts accept, held here against the contracts' own zod schemas; and the
// pairing commands send what the API takes, the end spelled as the last day
// in force to a person and the first day out on the wire.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Project } from "@waste/contracts/organisation"
import { SensorCreate, SensorPairingCreate, SensorPairingPatch, SensorPatch, type Sensor } from "@waste/contracts/sensors"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { NOTHING_RESOLVED, type CommandInput, type MappingContext } from "../records/adapter"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { CHANGE_PAIRING, PAIR_SENSOR, pairingLine, readingLine, SENSOR_COMMANDS, sensorAdapter } from "../records/sensors"
import { loaded, resolverOver } from "../records/server-records"

const NOW = new Date("2026-10-29T09:00:00Z")
const STAMPS = { createdAt: "2026-10-20T09:00:00.000Z", updatedAt: "2026-10-21T09:30:00.000Z" }
const PROJECT = "01a0d2a4-a280-7002-8000-000000000001"
const BIN = "01a0d2a4-a280-7999-8000-000000000010"
const copenhagen: Project = { id: PROJECT, ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false, privacyPolicy: { positionRetentionDays: null, proofRetentionDays: null, gpsPurpose: null }, branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } }
const copenhagenRecord = projectAdapter.toRecord(copenhagen, { fixtures: getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? [], resolve: NOTHING_RESOLVED, now: NOW })
const resolve = resolverOver(new Map([["configure.organization", loaded({ records: [copenhagenRecord], serverIds: new Map([[copenhagenRecord.id, PROJECT]]) }, 1)]]))
const context: MappingContext = { fixtures: [], resolve, companyRecordId: FIXTURE_COMPANY_ID, now: NOW }

const sensor: Sensor = {
  id: "01a0d2a4-a280-7999-8000-000000000001",
  ...STAMPS,
  projectId: PROJECT,
  identifier: "70B3D57ED0051A2F",
  network: "lorawan",
  status: "active",
  notes: null,
  pairing: { id: "01a0d2a4-a280-7999-8000-000000000002", ...STAMPS, projectId: PROJECT, sensorId: "01a0d2a4-a280-7999-8000-000000000001", containerId: BIN, fullThresholdPercent: 85, booksEmptying: true, validFrom: "2026-10-01", validTo: "2026-11-01" },
  lastReading: { id: "01a0d2a4-a280-7999-8000-000000000003", recordedAt: STAMPS.createdAt, projectId: PROJECT, sensorId: "01a0d2a4-a280-7999-8000-000000000001", pairingId: "01a0d2a4-a280-7999-8000-000000000002", containerId: BIN, measuredAt: "2026-10-29T07:40:00.000Z", fillPercent: 62, batteryPercent: 91, rssiDbm: -97 },
}

const commandBody = (name: keyof typeof SENSOR_COMMANDS, input: CommandInput, record: BusinessRecord) => SENSOR_COMMANDS[name].toBody!(input, record, context)

describe("a sensor on the adapter", () => {
  test("is a record of Resources › Sensors with its pairing in force and its newest reading, the end told as the last day in force", () => {
    const record = sensorAdapter.toRecord(sensor, context)
    assert.equal(record.id, `sensor-${sensor.id}`)
    assert.deepEqual([record.name, record.status, record.value, record.recordKind], ["70B3D57ED0051A2F", "Active", "62%", "Sensor"])
    assert.equal(record.facts.Network, "LoRaWAN")
    assert.equal(record.facts["Last measurement"], "2026-10-29 08:40", "on the project's clock")
    assert.equal(record.facts.Container, `asset-${BIN} from 2026-10-01 to 2026-10-31 · full at 85% · books an emptying`)
    assert.deepEqual([record.facts["Fill level"], record.facts.Battery, record.facts.RSSI], ["62%", "91%", "-97 dBm"])
    assert.deepEqual([record.submittedValues?.pairingId, record.submittedValues?.lastDayIn, record.submittedValues?.booksEmptying], [sensor.pairing!.id, "2026-10-31", true])
    const bare = sensorAdapter.toRecord({ ...sensor, pairing: null, lastReading: null }, context)
    assert.deepEqual([bare.facts.Container, bare.facts["Fill level"], bare.facts["Last measurement"], bare.submittedValues?.pairingId], ["Not paired today", "No reading yet", "Never", ""])
  })

  test("is registered from the form by project, identifier and network, active, and corrected or retired by a patch the contracts take", () => {
    const record = sensorAdapter.toRecord({ ...sensor, pairing: null, lastReading: null }, context)
    const typed = { ...record, id: "sensor-new", submittedValues: { projectId: copenhagenRecord.id, identifier: "S-401", network: "sigfox", notes: "Under the lid" } }
    const body = sensorAdapter.toCreateBody!(typed, context)
    assert.deepEqual(body, { projectId: PROJECT, identifier: "S-401", network: "sigfox", notes: "Under the lid" })
    assert.equal(SensorCreate.safeParse(body).success, true)
    const retired = sensorAdapter.toPatchBody(record, { ...record, status: "Retired" }, context)
    assert.deepEqual(retired, { status: "retired" })
    assert.equal(SensorPatch.safeParse(retired).success, true)
  })

  test("Pair sends the container, the first day, the threshold and the booking the contracts take", () => {
    const record = sensorAdapter.toRecord({ ...sensor, pairing: null }, context)
    const body = commandBody(PAIR_SENSOR, { containerId: `asset-${BIN}`, validFrom: "2026-11-01", fullThresholdPercent: "90", booksEmptying: true }, record)
    assert.deepEqual(body, { containerId: BIN, validFrom: "2026-11-01", fullThresholdPercent: 90, booksEmptying: true })
    assert.equal(SensorPairingCreate.safeParse(body).success, true)
    assert.deepEqual(commandBody(PAIR_SENSOR, { validFrom: "2026-11-01" }, record), { path: "containerId", message: "Pick the container the sensor measures" })
    assert.deepEqual(commandBody(PAIR_SENSOR, { containerId: `asset-${BIN}`, validFrom: "2026-11-01", fullThresholdPercent: "0" }, record), { path: "fullThresholdPercent", message: "Give the full threshold as a whole percent from 1 to 100" })
  })

  test("Change pairing moves the threshold, the booking or the end, the last day typed going out as the first day out, blank as open", () => {
    const record = sensorAdapter.toRecord(sensor, context)
    const ended = commandBody(CHANGE_PAIRING, { fullThresholdPercent: "80", booksEmptying: false, lastDayIn: "2026-11-15" }, record) as { pairingId: string; change: object }
    assert.deepEqual(ended, { pairingId: sensor.pairing!.id, change: { fullThresholdPercent: 80, booksEmptying: false, validTo: "2026-11-16" } })
    assert.equal(SensorPairingPatch.safeParse(ended.change).success, true)
    assert.deepEqual((commandBody(CHANGE_PAIRING, { lastDayIn: "" }, record) as { change: object }).change, { validTo: null })
    const unpaired = sensorAdapter.toRecord({ ...sensor, pairing: null }, context)
    assert.deepEqual(commandBody(CHANGE_PAIRING, { lastDayIn: "" }, unpaired), { path: "", message: "70B3D57ED0051A2F measures no container today" })
  })

  test("its lines and its place among the switched modules: after the containers its pairings name", () => {
    assert.equal(readingLine({ fillPercent: 40, batteryPercent: null, rssiDbm: -101 }), "40% · -101 dBm")
    assert.equal(pairingLine({ validFrom: "2026-10-01", validTo: null, fullThresholdPercent: 85, booksEmptying: false }, "BIN-82014"), "BIN-82014 from 2026-10-01 · full at 85%")
    assert.ok(isServerBacked("resources", "sensors"))
    assert.ok(SERVER_MODULE_KEYS.indexOf("resources.containers") < SERVER_MODULE_KEYS.indexOf("resources.sensors"))
  })
})
