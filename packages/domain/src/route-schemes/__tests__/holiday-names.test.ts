import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  KNOWN_HOLIDAY_LIST_NAMES,
  danishHolidayName,
  easterSunday,
  holidayLabel,
  holidayNamesFor,
  withCarriedNames,
} from "../holiday-names"

describe("the lists this module knows, and carried names in front of them", () => {
  test("the known list names are the ones holidayNamesFor answers for", () => {
    assert.deepEqual(KNOWN_HOLIDAY_LIST_NAMES, ["Danish public holidays", "Egyptian public holidays"])
    for (const name of KNOWN_HOLIDAY_LIST_NAMES) {
      assert.notEqual(holidayNamesFor(name), holidayNamesFor("Somewhere else"))
    }
  })

  test("withCarriedNames answers the carried name first, the fallback otherwise", () => {
    const names = withCarriedNames(new Map([["2026-12-24", "Juleaften"]]), danishHolidayName)
    assert.equal(names("2026-12-24"), "Juleaften")
    assert.equal(names("2026-12-25"), "Christmas Day")
    assert.equal(names("2026-12-27"), undefined)
  })
})

describe("Danish holiday names", () => {
  test("Easter Sunday", () => {
    assert.equal(easterSunday(2026), "2026-04-05")
    assert.equal(easterSunday(2027), "2027-03-28")
    assert.equal(easterSunday(2024), "2024-03-31")
  })

  test("names every date in the Copenhagen Central 2026 calendar fixture", () => {
    const fixture: Record<string, string> = {
      "2026-01-01": "New Year's Day",
      "2026-04-02": "Maundy Thursday",
      "2026-04-03": "Good Friday",
      "2026-04-05": "Easter Sunday",
      "2026-04-06": "Easter Monday",
      "2026-05-14": "Ascension Day",
      "2026-05-24": "Whit Sunday",
      "2026-05-25": "Whit Monday",
      "2026-06-05": "Constitution Day",
      "2026-12-25": "Christmas Day",
      "2026-12-26": "2nd Christmas Day",
    }
    for (const [date, name] of Object.entries(fixture)) {
      assert.equal(danishHolidayName(date), name, date)
    }
  })

  test("prototype table dates", () => {
    assert.equal(danishHolidayName("2026-12-24"), "Christmas Eve")
    assert.equal(danishHolidayName("2026-12-31"), "New Year's Eve")
    assert.equal(danishHolidayName("2027-03-25"), "Maundy Thursday")
    assert.equal(danishHolidayName("2027-03-29"), "Easter Monday")
    assert.equal(danishHolidayName("2027-05-06"), "Ascension Day")
    assert.equal(danishHolidayName("2027-05-17"), "Whit Monday")
  })

  test("ordinary days have no name and fall back to the generic label", () => {
    assert.equal(danishHolidayName("2026-09-16"), undefined)
    assert.equal(holidayLabel("2026-09-16", danishHolidayName), "Holiday")
    assert.equal(holidayLabel("2026-12-25", danishHolidayName), "Christmas Day")
  })
})
