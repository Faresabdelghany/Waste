import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  NO_LICENCE_ON_RECORD,
  collectionVehicles,
  driverEligibility,
  driverHoldsLicence,
  driverIneligibilityReason,
  driverOptionLabel,
  driverOptions,
  driverProfile,
  eligibleDrivers,
  parseDriverLicences,
  parseTonnes,
  requiredLicenceClass,
  vehicleOptionLabel,
  vehicleProfile,
} from "../fleet-profiles"

const record = (
  id: string,
  name: string,
  context: string,
  facts: Record<string, string>,
  submittedValues?: Record<string, string | boolean>,
) => ({ id, name, context, facts, submittedValues })

const wh24 = record("vehicle-wh24", "WH-24 · CN 42 018", "Rear loader 18 t · Nordhavn", {
  Capacity: "18 t",
})
const van = record("vehicle-van", "WH-12 · EV 10 001", "Electric van 1.2 t · Nordhavn", {
  Capacity: "1.2 t",
})
const trailer = record("trailer-wh12", "WH-T12 · Closed trailer", "18 t trailer · Nordhavn", {
  Capacity: "18 t",
  Type: "Closed trailer",
})

describe("vehicleProfile", () => {
  test("reads callsign, canonical type, capacity, and licence class from a fixture", () => {
    const profile = vehicleProfile(wh24)
    assert.deepEqual(profile, {
      id: "vehicle-wh24",
      callsign: "WH-24",
      type: "Rear loader",
      capacityT: 18,
      licenceClass: "C",
      isTrailer: false,
    })
    assert.equal(vehicleOptionLabel(profile), "WH-24 · Rear loader · 18 t")
  })

  test("light vehicles need a B licence, trailers CE", () => {
    assert.equal(vehicleProfile(van).licenceClass, "B")
    assert.equal(vehicleProfile(van).type, "Electric van")
    assert.equal(vehicleProfile(trailer).isTrailer, true)
    assert.equal(vehicleProfile(trailer).licenceClass, "CE")
  })

  test("form-created vehicles read the typed capacity and resource kind", () => {
    const created = record("vehicle-new", "WH-40 · AA 11 222", "Rear loader · Nordhavn", {}, {
      capacity: "14",
      resourceKind: "powered-vehicle",
    })
    assert.equal(vehicleProfile(created).capacityT, 14)
    assert.equal(vehicleProfile(created).licenceClass, "C")
    const createdTrailer = record("t", "T-1", "Trailer", {}, { resourceKind: "trailer" })
    assert.equal(vehicleProfile(createdTrailer).isTrailer, true)
  })

  test("collectionVehicles drops trailers", () => {
    assert.deepEqual(
      collectionVehicles([wh24, trailer, van]).map((vehicle) => vehicle.id),
      ["vehicle-wh24", "vehicle-van"],
    )
  })

  test("parseTonnes", () => {
    assert.equal(parseTonnes("18 t"), 18)
    assert.equal(parseTonnes("1,2 t"), 1.2)
    assert.equal(parseTonnes("14"), 14)
    assert.equal(parseTonnes("Rear loader"), null)
    assert.equal(parseTonnes(undefined), null)
  })
})

describe("drivers", () => {
  const mads = driverProfile(
    record("driver-mads", "Mads Jensen", "Kystbyen · residual · mixed", { Licence: "C/CE · valid 2028" }),
  )
  const freja = driverProfile(
    record("driver-freja", "Freja Nielsen", "Kystbyen · glass · crane", {
      Licence: "C/CE + crane · valid 2027",
    }),
  )
  const lars = driverProfile(
    record("driver-lars", "Lars Møller", "NordRen ApS · organic", { Licence: "C · expires 5 Sep 2026" }),
  )
  const emil = driverProfile(record("driver-emil", "Emil Kristensen", "Kystbyen", { Licence: "B · valid 2030" }))
  const unknown = driverProfile(record("driver-new", "New Driver", "Kystbyen", {}))

  test("parses licence classes out of the free-text fact", () => {
    assert.deepEqual(mads.licences, ["C", "CE"])
    assert.deepEqual(freja.licences, ["C", "CE"])
    assert.deepEqual(lars.licences, ["C"])
    assert.deepEqual(emil.licences, ["B"])
    assert.deepEqual(unknown.licences, [])
    assert.deepEqual(parseDriverLicences("B, C"), ["B", "C"])
    assert.deepEqual(parseDriverLicences("Not on record"), [])
  })

  test("eligibility follows the vehicle's licence class, with implied classes", () => {
    const truck = vehicleProfile(wh24)
    assert.deepEqual(
      eligibleDrivers([mads, freja, lars, emil, unknown], truck).map((driver) => driver.id),
      ["driver-mads", "driver-freja", "driver-lars"],
    )
    assert.equal(driverHoldsLicence(mads, "B"), true)
    assert.equal(driverHoldsLicence(emil, "C"), false)
    assert.equal(driverHoldsLicence(lars, "CE"), false)
  })

  test("an unknown or unreadable licence is never eligible — listed, disabled, with the reason", () => {
    const truck = vehicleProfile(wh24)
    assert.equal(driverHoldsLicence(unknown, "B"), false)
    assert.equal(driverHoldsLicence(unknown, "CE"), false)
    assert.deepEqual(driverEligibility(unknown, "C"), {
      driver: unknown,
      eligible: false,
      reason: NO_LICENCE_ON_RECORD,
    })
    assert.deepEqual(driverEligibility(emil, "C"), { driver: emil, eligible: false, reason: "Needs C licence" })
    assert.deepEqual(
      driverOptions([mads, emil, unknown], truck).map((option) => [option.driver.id, option.eligible, option.reason]),
      [
        ["driver-mads", true, undefined],
        ["driver-emil", false, "Needs C licence"],
        ["driver-new", false, NO_LICENCE_ON_RECORD],
      ],
    )
  })

  test("without a vehicle every driver is listed and nothing is judged", () => {
    assert.equal(eligibleDrivers([mads, emil, unknown], null).length, 3)
    assert.ok(driverOptions([unknown], null).every((option) => option.eligible))
  })

  test("requiredLicenceClass: trailer → CE, over 3.5 t → C, light → B, unknown capacity → C", () => {
    assert.equal(requiredLicenceClass({ isTrailer: true, capacityT: 1 }), "CE")
    assert.equal(requiredLicenceClass({ isTrailer: false, capacityT: 18 }), "C")
    assert.equal(requiredLicenceClass({ isTrailer: false, capacityT: 3.5 }), "B")
    assert.equal(requiredLicenceClass({ isTrailer: false, capacityT: null }), "C")
  })

  test("option labels", () => {
    assert.equal(driverOptionLabel(mads), "Mads Jensen · C, CE")
    assert.equal(driverOptionLabel(unknown), "New Driver")
  })

  test("driverIneligibilityReason: the reason beside a disabled driver, unknown ⇒ ineligible, nothing judged without a vehicle", () => {
    const madsRecord = record("driver-mads", "Mads Jensen", "Kystbyen", { Licence: "C/CE · valid 2028" })
    const emilRecord = record("driver-emil", "Emil Kristensen", "Kystbyen", { Licence: "B · valid 2030" })
    const unknownRecord = record("driver-new", "New Driver", "Kystbyen", {})
    assert.equal(driverIneligibilityReason(emilRecord, wh24), "Needs C licence")
    assert.equal(driverIneligibilityReason(unknownRecord, wh24), NO_LICENCE_ON_RECORD)
    assert.equal(driverIneligibilityReason(madsRecord, wh24), undefined)
    assert.equal(driverIneligibilityReason(unknownRecord, undefined), undefined)
  })
})
