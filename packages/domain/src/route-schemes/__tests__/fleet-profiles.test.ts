// The fleet readers Guided Setup step 3 judges drivers by (issue #37): a
// driver's licence class and expiry and a vehicle's required class are typed
// fields on the records — no free-text parse, no derivation from capacity —
// and a record without a readable class is unknown, which never passes.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { schemeLicenceDay } from "../../planning/checks"
import {
  LICENCE_CLASSES,
  NO_LICENCE_ON_RECORD,
  NO_VEHICLE_LICENCE_CLASS,
  collectionVehicles,
  driverEligibility,
  driverHoldsLicence,
  driverIneligibilityReason,
  driverOptionLabel,
  driverOptions,
  driverProfile,
  eligibleDrivers,
  groupDriverIssueOf,
  isLicenceClass,
  parseTonnes,
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

const wh24 = record(
  "vehicle-wh24",
  "WH-24 · CN 42 018",
  "Rear loader 18 t · Nordhavn",
  { Capacity: "18 t" },
  { requiredLicenceClass: "C" },
)
const van = record(
  "vehicle-van",
  "WH-12 · EV 10 001",
  "Electric van 1.2 t · Nordhavn",
  { Capacity: "1.2 t" },
  { requiredLicenceClass: "B" },
)
const trailer = record(
  "trailer-wh12",
  "WH-T12 · Closed trailer",
  "18 t trailer · Nordhavn",
  { Capacity: "18 t", Type: "Closed trailer" },
  { requiredLicenceClass: "CE" },
)
/** A vehicle stored before the field existed: capacity says heavy, but nothing says which class. */
const unclassed = record("vehicle-old", "WH-40 · AA 11 222", "Rear loader 18 t · Nordhavn", {
  Capacity: "18 t",
})

describe("licence classes", () => {
  test("the vocabulary is B, C, CE and nothing else", () => {
    assert.deepEqual([...LICENCE_CLASSES], ["B", "C", "CE"])
    assert.equal(isLicenceClass("CE"), true)
    assert.equal(isLicenceClass("ce"), false)
    assert.equal(isLicenceClass("C/CE"), false)
    assert.equal(isLicenceClass(""), false)
    assert.equal(isLicenceClass(undefined), false)
  })
})

describe("vehicleProfile", () => {
  test("reads callsign, canonical type, capacity, and the typed required licence class", () => {
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

  test("the class is the record's, whatever the capacity says", () => {
    assert.equal(vehicleProfile(van).licenceClass, "B")
    assert.equal(vehicleProfile(van).type, "Electric van")
    assert.equal(vehicleProfile(trailer).isTrailer, true)
    assert.equal(vehicleProfile(trailer).licenceClass, "CE")
    // A light van registered as needing C is judged as C — the field is the model.
    const heavyVan = record("v", "WH-13", "Electric van 1.2 t", {}, { requiredLicenceClass: "C" })
    assert.equal(vehicleProfile(heavyVan).licenceClass, "C")
  })

  test("a vehicle without a readable class is unknown — never derived from capacity or kind", () => {
    assert.equal(vehicleProfile(unclassed).capacityT, 18)
    assert.equal(vehicleProfile(unclassed).licenceClass, null)
    const oldTrailer = record("t", "T-1", "Trailer", {}, { resourceKind: "trailer" })
    assert.equal(vehicleProfile(oldTrailer).isTrailer, true)
    assert.equal(vehicleProfile(oldTrailer).licenceClass, null)
    const misspelt = record("v", "WH-14", "Rear loader", {}, { requiredLicenceClass: "c" })
    assert.equal(vehicleProfile(misspelt).licenceClass, null)
  })

  test("form-created vehicles read the typed capacity and resource kind", () => {
    const created = record("vehicle-new", "WH-40 · AA 11 222", "Rear loader · Nordhavn", {}, {
      capacity: "14",
      resourceKind: "powered-vehicle",
      requiredLicenceClass: "C",
    })
    assert.equal(vehicleProfile(created).capacityT, 14)
    assert.equal(vehicleProfile(created).licenceClass, "C")
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
    record("driver-mads", "Mads Jensen", "Kystbyen · residual · mixed", { Licence: "CE · valid to 31 Dec 2028" }, {
      licenceClass: "CE",
      licenceExpiry: "2028-12-31",
    }),
  )
  const lars = driverProfile(
    record("driver-lars", "Lars Møller", "NordRen ApS · organic", { Licence: "C · expires 5 Sep 2026" }, {
      licenceClass: "C",
      licenceExpiry: "2026-09-05",
    }),
  )
  const emil = driverProfile(
    record("driver-emil", "Emil Kristensen", "Kystbyen", {}, { licenceClass: "B" }),
  )
  const unknown = driverProfile(record("driver-new", "New Driver", "Kystbyen", {}))

  test("reads the typed licence class and expiry", () => {
    assert.deepEqual(mads, {
      id: "driver-mads",
      name: "Mads Jensen",
      licenceClass: "CE",
      licenceExpiry: "2028-12-31",
    })
    assert.equal(lars.licenceClass, "C")
    assert.equal(lars.licenceExpiry, "2026-09-05")
    // The expiry is optional; a class without one is still a class.
    assert.equal(emil.licenceClass, "B")
    assert.equal(emil.licenceExpiry, null)
  })

  test("the free-text Licence fact is never read — the typed field is the model", () => {
    // A fixture-shaped fact with no typed class: unknown, not "C/CE".
    const factOnly = driverProfile(
      record("driver-fact", "Fact Only", "Kystbyen", { Licence: "C/CE · valid 2028" }),
    )
    assert.equal(factOnly.licenceClass, null)
    // A master-data id under the old relation field is not a class either.
    const relationId = driverProfile(
      record("driver-rel", "Relation Id", "Kystbyen", { Licence: "C/CE · valid 2028" }, {
        licenceClass: "master-licence-c",
      }),
    )
    assert.equal(relationId.licenceClass, null)
    assert.deepEqual(unknown, { id: "driver-new", name: "New Driver", licenceClass: null, licenceExpiry: null })
  })

  test("an expiry that is not a calendar day reads as none", () => {
    const odd = driverProfile(
      record("d", "D", "Kystbyen", {}, { licenceClass: "C", licenceExpiry: "valid 2028" }),
    )
    assert.equal(odd.licenceClass, "C")
    assert.equal(odd.licenceExpiry, null)
    const notADay = driverProfile(
      record("d", "D", "Kystbyen", {}, { licenceClass: "C", licenceExpiry: "2026-02-30" }),
    )
    assert.equal(notADay.licenceExpiry, null)
  })

  test("eligibility follows the vehicle's class, with implied classes: CE covers C, C covers B", () => {
    const truck = vehicleProfile(wh24)
    assert.deepEqual(
      eligibleDrivers([mads, lars, emil, unknown], truck).map((driver) => driver.id),
      ["driver-mads", "driver-lars"],
    )
    assert.equal(driverHoldsLicence(mads, "B"), true)
    assert.equal(driverHoldsLicence(mads, "CE"), true)
    assert.equal(driverHoldsLicence(emil, "C"), false)
    assert.equal(driverHoldsLicence(lars, "CE"), false)
    assert.deepEqual(
      eligibleDrivers([mads, lars, emil], vehicleProfile(trailer)).map((driver) => driver.id),
      ["driver-mads"],
    )
    assert.deepEqual(
      eligibleDrivers([mads, lars, emil, unknown], vehicleProfile(van)).map((driver) => driver.id),
      ["driver-mads", "driver-lars", "driver-emil"],
    )
  })

  test("an unknown licence is never eligible — listed, disabled, with the reason", () => {
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

  test("a vehicle without a class on record can judge nobody — every driver disabled with the vehicle's reason", () => {
    const old = vehicleProfile(unclassed)
    assert.equal(driverHoldsLicence(mads, null), false)
    assert.deepEqual(
      driverOptions([mads, emil, unknown], old).map((option) => [option.driver.id, option.eligible, option.reason]),
      [
        ["driver-mads", false, NO_VEHICLE_LICENCE_CLASS],
        ["driver-emil", false, NO_VEHICLE_LICENCE_CLASS],
        ["driver-new", false, NO_VEHICLE_LICENCE_CLASS],
      ],
    )
    assert.deepEqual(eligibleDrivers([mads, emil], old), [])
  })

  test("without a vehicle every driver is listed and nothing is judged", () => {
    assert.equal(eligibleDrivers([mads, emil, unknown], null).length, 3)
    assert.ok(driverOptions([unknown], null).every((option) => option.eligible))
  })

  describe("judged on the day the API judges a group's driver on (#178)", () => {
    const truck = vehicleProfile(wh24)
    const startsNextMonth = schemeLicenceDay("2026-10-01", "2026-09-30")
    const startedInAugust = schemeLicenceDay("2026-08-04", "2026-09-30")

    test("a licence that has run out by the scheme's first day does not hold: listed, disabled, in the API's own sentence", () => {
      assert.deepEqual(
        driverOptions([mads, lars], truck, startsNextMonth).map((option) => [option.driver.id, option.eligible, option.reason]),
        [
          ["driver-mads", true, undefined],
          ["driver-lars", false, "Lars Møller's licence expires on 2026-09-05, before the scheme starts"],
        ],
      )
    })

    test("a scheme that started before today judges the licence on today", () => {
      assert.equal(driverOptions([lars], truck, startedInAugust)[0].reason, "Lars Møller's licence expires on 2026-09-05, before today")
    })

    test("the expiry is the last day the licence holds", () => {
      const onItsLastDay = schemeLicenceDay("2026-09-05", "2026-09-01")
      assert.equal(driverOptions([lars], truck, onItsLastDay)[0].eligible, true)
    })

    test("a group's driver and vehicle read as the API's own sentence, or nothing when the driver may take it", () => {
      assert.equal(groupDriverIssueOf(lars, truck, startsNextMonth), "Lars Møller's licence expires on 2026-09-05, before the scheme starts")
      assert.equal(groupDriverIssueOf(emil, truck, startsNextMonth), "Emil Kristensen needs a C licence for WH-24")
      assert.equal(groupDriverIssueOf(unknown, truck, startsNextMonth), "New Driver holds no licence class on record")
      assert.equal(groupDriverIssueOf(mads, truck, startsNextMonth), undefined)
      assert.equal(groupDriverIssueOf(mads, vehicleProfile(unclassed), startsNextMonth), undefined, "a vehicle without a class on record judges nobody; the picker says so")
    })

    test("the class is judged first, and nothing about a day is judged without one", () => {
      assert.equal(driverOptions([emil], truck, startsNextMonth)[0].reason, "Needs C licence")
      assert.equal(driverOptions([lars], truck)[0].eligible, true, "every other caller keeps the class-only reading")
      assert.deepEqual(driverEligibility(lars, "C"), { driver: lars, eligible: true })
    })
  })

  test("option labels carry the class, the name alone when it is unknown", () => {
    assert.equal(driverOptionLabel(mads), "Mads Jensen · CE")
    assert.equal(driverOptionLabel(emil), "Emil Kristensen · B")
    assert.equal(driverOptionLabel(unknown), "New Driver")
  })

  test("driverIneligibilityReason: the reason beside a disabled driver, unknown ⇒ ineligible, nothing judged without a vehicle", () => {
    const madsRecord = record("driver-mads", "Mads Jensen", "Kystbyen", {}, { licenceClass: "CE" })
    const emilRecord = record("driver-emil", "Emil Kristensen", "Kystbyen", {}, { licenceClass: "B" })
    const unknownRecord = record("driver-new", "New Driver", "Kystbyen", {})
    assert.equal(driverIneligibilityReason(emilRecord, wh24), "Needs C licence")
    assert.equal(driverIneligibilityReason(unknownRecord, wh24), NO_LICENCE_ON_RECORD)
    assert.equal(driverIneligibilityReason(madsRecord, wh24), undefined)
    assert.equal(driverIneligibilityReason(madsRecord, unclassed), NO_VEHICLE_LICENCE_CLASS)
    assert.equal(driverIneligibilityReason(unknownRecord, undefined), undefined)
    assert.equal(driverIneligibilityReason(undefined, wh24), undefined)
  })
})
