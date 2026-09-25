import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { driverHoldsLicence, LICENCE_CLASSES as DISPLAY_CLASSES } from "../../route-schemes/fleet-profiles"
import { coversClass, displayLicenceClass, holdsLicence, IMPLIED_BY, isLicenceClassToken, licenceRefusal, licenceSentence } from "../licence"
import { LICENCE_CLASSES } from "../vocabulary"

const DAY = "2026-09-25"
const names = { driver: "Mads Jensen", vehicle: "WH-24" }

describe("the licence implication", () => {
  test("ce covers c covers b: every class covers itself and every class below it, and nothing above", () => {
    assert.deepEqual(IMPLIED_BY, { b: ["b", "c", "ce"], c: ["c", "ce"], ce: ["ce"] })
    for (const [n, required] of LICENCE_CLASSES.entries()) {
      for (const [m, held] of LICENCE_CLASSES.entries()) {
        assert.equal(coversClass(held, required), m >= n, `${held} for ${required}`)
        assert.equal(holdsLicence({ licenceClass: held, licenceExpiry: null }, required, DAY), m >= n, `${held} for ${required}`)
      }
    }
  })

  test("is spelled once: the web's driverHoldsLicence over the display tuple answers what coversClass answers over the tokens", () => {
    for (const [n, required] of DISPLAY_CLASSES.entries()) {
      for (const [m, held] of DISPLAY_CLASSES.entries()) {
        assert.equal(driverHoldsLicence({ id: "d", name: "Mads", licenceClass: held, licenceExpiry: null }, required), coversClass(LICENCE_CLASSES[m], LICENCE_CLASSES[n]), `${held} for ${required}`)
      }
    }
  })

  test("isLicenceClassToken knows the three tokens and nothing else, the display spelling included", () => {
    for (const licenceClass of LICENCE_CLASSES) assert.equal(isLicenceClassToken(licenceClass), true)
    for (const other of ["CE", "B", "d", "", null, undefined, 3]) assert.equal(isLicenceClassToken(other), false, String(other))
  })
})

describe("licenceRefusal", () => {
  test("unknown never passes: a driver with no class on record is refused for every vehicle", () => {
    for (const required of LICENCE_CLASSES) {
      assert.deepEqual(licenceRefusal({ licenceClass: null, licenceExpiry: null }, required, DAY), { reason: "no-class" })
    }
  })

  test("a class below the one required is refused naming the required class, before the expiry is looked at", () => {
    assert.deepEqual(licenceRefusal({ licenceClass: "b", licenceExpiry: null }, "c", DAY), { reason: "class-too-low", required: "c" })
    assert.deepEqual(licenceRefusal({ licenceClass: "c", licenceExpiry: "2020-01-01" }, "ce", DAY), { reason: "class-too-low", required: "ce" }, "the class is the thing to fix")
  })

  test("the expiry is the last day the licence holds: it holds on that day and not the day after", () => {
    const expiring = { licenceClass: "ce" as const, licenceExpiry: "2026-09-05" }
    assert.equal(licenceRefusal(expiring, "c", "2026-09-05"), undefined)
    assert.equal(licenceRefusal(expiring, "c", "2026-09-04"), undefined)
    assert.deepEqual(licenceRefusal(expiring, "c", "2026-09-06"), { reason: "expired", licenceExpiry: "2026-09-05" })
    assert.equal(licenceRefusal({ licenceClass: "b", licenceExpiry: null }, "b", "2099-12-31"), undefined, "no expiry on record is no expiry")
  })

  test("refuses a day that is not a YYYY-MM-DD calendar day — an instant included, which would read a licence as expired on its last valid day", () => {
    const expiring = { licenceClass: "ce" as const, licenceExpiry: "2026-09-05" }
    for (const notADay of ["2026-09-05T22:00:00Z", "2026-09-05T23:59:59+02:00", "2026-9-5", "2026-02-30", "Sep 5 2026", ""]) {
      assert.throws(() => licenceRefusal(expiring, "c", notADay), new RegExp(`licenceRefusal: "${notADay.replaceAll("+", "\\+")}" is not a YYYY-MM-DD day; turn an instant into the day it falls on in the project's timezone first`), notADay)
      assert.throws(() => holdsLicence(expiring, "c", notADay), /is not a YYYY-MM-DD day/, notADay)
    }
    assert.deepEqual(licenceRefusal(expiring, "c", "2028-02-29"), { reason: "expired", licenceExpiry: "2026-09-05" }, "a leap day is a day, and is judged")
  })
})

describe("licenceSentence", () => {
  test("spells the three refusals naming the driver, the vehicle and the day", () => {
    assert.equal(licenceSentence({ reason: "no-class" }, names), "Mads Jensen holds no licence class on record")
    assert.equal(licenceSentence({ reason: "class-too-low", required: "c" }, names), "Mads Jensen needs a C licence for WH-24")
    assert.equal(licenceSentence({ reason: "class-too-low", required: "ce" }, names), "Mads Jensen needs a CE licence for WH-24")
    assert.equal(licenceSentence({ reason: "expired", licenceExpiry: "2026-09-05" }, names), "Mads Jensen's licence expires on 2026-09-05, before the window ends")
    assert.equal(licenceSentence({ reason: "expired", licenceExpiry: "2026-09-05" }, names, "the scheme starts"), "Mads Jensen's licence expires on 2026-09-05, before the scheme starts")
  })

  test("a class is spelled uppercase in a sentence, as a person reads it off the card, and that spelling is the web's tuple", () => {
    assert.deepEqual(LICENCE_CLASSES.map(displayLicenceClass), [...DISPLAY_CLASSES])
  })
})
