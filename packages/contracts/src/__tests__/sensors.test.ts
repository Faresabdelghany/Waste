// Fill-level Sensors on the wire (O26 of #290, row 9.10): a sensor by its
// identifier, a pairing over a period with its threshold, and the ingest's
// batch and outcomes.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SENSOR_READING_BATCH_MAX } from "@waste/domain/resources/sensors"

import { FillReadingBatch, FillReadingOutcome, Sensor, SensorCreate, SensorPairing, SensorPairingCreate, SensorPairingPatch, SensorPatch } from "../sensors"
import { ENDS_AFTER_IT_STARTS } from "../validity"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const STAMP = "2026-10-28T09:00:00.000Z"

const pairing = { id: OTHER, projectId: ID, sensorId: ID, containerId: OTHER, fullThresholdPercent: 85, validFrom: "2026-10-01", validTo: null, createdAt: STAMP, updatedAt: STAMP }
const reading = { id: OTHER, projectId: ID, sensorId: ID, pairingId: OTHER, containerId: OTHER, measuredAt: STAMP, fillPercent: 62, batteryPercent: 91, rssiDbm: -97, recordedAt: STAMP }

describe("Sensor", () => {
  test("is the project's, by its identifier, on a network, with the pairing in force and its newest reading read beside it", () => {
    const sensor = { id: ID, projectId: ID, identifier: "70B3D57ED0051A2F", network: "lorawan", status: "active", notes: null, pairing, lastReading: reading, createdAt: STAMP, updatedAt: STAMP }
    assert.deepEqual(Sensor.parse(sensor), sensor)
    assert.deepEqual(Sensor.parse({ ...sensor, pairing: null, lastReading: null }).pairing, null)
    assert.equal(Sensor.safeParse({ ...sensor, network: "wifi" }).success, false)
  })

  test("a create names the project, the identifier and the network, and starts active by the server's word", () => {
    assert.deepEqual(SensorCreate.parse({ projectId: ID, identifier: "S-401", network: "sigfox" }), { projectId: ID, identifier: "S-401", network: "sigfox" })
    assert.equal(SensorCreate.safeParse({ projectId: ID, identifier: "S-401", network: "sigfox", status: "retired" }).success, false, "a new sensor is active")
    refusesWhatTheServerOwns(SensorCreate, { projectId: ID, identifier: "S-401", network: "sigfox" })
  })

  test("a patch corrects it or retires it, never moves its project, and changes something", () => {
    assert.deepEqual(SensorPatch.parse({ status: "retired" }), { status: "retired" })
    assert.equal(SensorPatch.safeParse({ projectId: ID }).success, false)
    refusesAnEmptyPatch(SensorPatch)
  })
})

describe("SensorPairing", () => {
  test("names a container over a half-open period at a whole-percent threshold from 1 to 100, 85 when absent", () => {
    assert.deepEqual(SensorPairing.parse(pairing), pairing)
    assert.deepEqual(SensorPairingCreate.parse({ containerId: OTHER, validFrom: "2026-10-01" }), { containerId: OTHER, fullThresholdPercent: 85, validFrom: "2026-10-01" })
    for (const fullThresholdPercent of [0, 101, 85.5]) assert.equal(SensorPairingCreate.safeParse({ containerId: OTHER, validFrom: "2026-10-01", fullThresholdPercent }).success, false, String(fullThresholdPercent))
    assert.deepEqual(refusal(SensorPairingCreate.safeParse({ containerId: OTHER, validFrom: "2026-10-01", validTo: "2026-10-01" })), [{ path: "validTo", message: ENDS_AFTER_IT_STARTS }])
    refusesWhatTheServerOwns(SensorPairingCreate, { containerId: OTHER, validFrom: "2026-10-01" })
  })

  test("a patch moves the threshold or the end, never the container or the start", () => {
    assert.deepEqual(SensorPairingPatch.parse({ validTo: null }), { validTo: null })
    assert.equal(SensorPairingPatch.safeParse({ containerId: OTHER }).success, false)
    assert.equal(SensorPairingPatch.safeParse({ validFrom: "2026-10-02" }).success, false)
    refusesAnEmptyPatch(SensorPairingPatch)
  })
})

describe("the ingest", () => {
  const one = { sensorIdentifier: "S-401", measuredAt: STAMP, fillPercent: 88 }

  test("takes one to the domain's cap of readings by the sensor's identifier, the battery and the signal where the vendor gives them", () => {
    assert.deepEqual(FillReadingBatch.parse({ readings: [one, { ...one, batteryPercent: 40, rssiDbm: -110 }] }).readings.length, 2)
    assert.equal(FillReadingBatch.safeParse({ readings: [] }).success, false)
    assert.equal(FillReadingBatch.safeParse({ readings: Array.from({ length: SENSOR_READING_BATCH_MAX + 1 }, () => one) }).success, false)
    assert.equal(FillReadingBatch.safeParse({ readings: [{ ...one, fillPercent: 101 }] }).success, false)
    assert.equal(FillReadingBatch.safeParse({ readings: [{ ...one, rssiDbm: 5 }] }).success, false)
    assert.equal(FillReadingBatch.safeParse({ readings: [{ ...one, sensorId: ID }] }).success, false, "a reading names its sensor by the identifier alone")
  })

  test("answers each reading recorded, replayed or refused with why", () => {
    assert.equal(FillReadingOutcome.parse({ outcome: "recorded", id: ID }).outcome, "recorded")
    assert.equal(FillReadingOutcome.parse({ outcome: "refused", reason: "unknown-sensor", detail: "No active sensor S-9" }).outcome, "refused")
    assert.equal(FillReadingOutcome.safeParse({ outcome: "refused", reason: "late" }).success, false)
  })
})
