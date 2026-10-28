// Seasons of a Route Scheme (O17 of #290): the month-day reading, the season
// in force on a date, the overlap rule, and the cadence each season gives the
// occurrences — through generateOccurrences, the one occurrence function —
// and how a scheme record carries them (scheme-seasons.ts).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { generateOccurrences, NO_HOLIDAYS } from "../occurrences"
import { cadenceOn, isoWeek, matchesRecurrence, recurrenceFromValues, serviceDayOf, type SchemeRecurrence } from "../recurrence"
import { SCHEME_SEASONS_KEY, seasonProblems, seasonsFromValues, seasonsValue, storedSeasonsFromValues, type StoredSchemeSeason } from "../scheme-seasons"
import { isMonthDay, overlappingSeasons, seasonContains, seasonLastDay, seasonOn, seasonSpanLabel, seasonStartOf, seasonsOverlap, type SchemeSeason } from "../seasons"

const calendar = { holidays: NO_HOLIDAYS, weekend: ["saturday", "sunday"] as const }

const summer: SchemeSeason = { name: "Summer", startsOn: "05-01", endsOn: "10-01", frequency: "weekly" }
const winter: SchemeSeason = { name: "Winter", startsOn: "11-01", endsOn: "04-01", frequency: "every-2-weeks", weekRotation: "odd" }

/** Every other Monday all year, weekly in summer, odd weeks in winter. */
const recurrence: SchemeRecurrence = {
  frequency: "every-2-weeks",
  weekRotation: "even",
  serviceDays: ["monday"],
  effectiveFrom: "2026-01-05",
  effectiveTo: "",
  seasons: [summer, winter],
}

const dates = (input: SchemeRecurrence, from: string, to: string) =>
  generateOccurrences({ recurrence: input, window: { from, to }, holidayPolicy: "skip", calendar: { ...calendar, weekend: [...calendar.weekend] } })

describe("a month-day", () => {
  test("is a day every year has, spelt mm-dd", () => {
    for (const day of ["01-01", "02-28", "04-30", "12-31"]) assert.ok(isMonthDay(day), day)
    for (const day of ["02-29", "04-31", "13-01", "00-10", "1-01", "01-1", "01-00", "2026-01-01", ""]) assert.ok(!isMonthDay(day), day)
  })
})

describe("the season in force", () => {
  test("a season holds its first day and not the day it ends before", () => {
    assert.ok(seasonContains(summer, "2026-05-01"))
    assert.ok(seasonContains(summer, "2026-09-30"))
    assert.ok(!seasonContains(summer, "2026-10-01"))
    assert.ok(!seasonContains(summer, "2026-04-30"))
  })

  test("a season over the new year holds both its ends of the calendar", () => {
    assert.ok(seasonContains(winter, "2026-11-01"))
    assert.ok(seasonContains(winter, "2027-01-15"))
    assert.ok(seasonContains(winter, "2027-03-31"))
    assert.ok(!seasonContains(winter, "2027-04-01"))
    assert.ok(!seasonContains(winter, "2026-10-31"))
  })

  test("a leap day belongs to the season that holds 28 February", () => {
    assert.ok(seasonContains(winter, "2028-02-29"))
    assert.ok(seasonContains({ startsOn: "02-01", endsOn: "03-01" }, "2028-02-29"))
    assert.ok(!seasonContains({ startsOn: "03-01", endsOn: "06-01" }, "2028-02-29"))
  })

  test("at most one season holds a date; between seasons none does", () => {
    assert.equal(seasonOn([summer, winter], "2026-07-01")?.name, "Summer")
    assert.equal(seasonOn([summer, winter], "2026-12-01")?.name, "Winter")
    assert.equal(seasonOn([summer, winter], "2026-10-15"), undefined)
    assert.equal(seasonOn(undefined, "2026-10-15"), undefined)
  })

  test("a stretch starts on this year's first day, or last year's for a season's new-year half", () => {
    assert.equal(seasonStartOf(summer, "2026-07-01"), "2026-05-01")
    assert.equal(seasonStartOf(winter, "2026-12-01"), "2026-11-01")
    assert.equal(seasonStartOf(winter, "2027-02-01"), "2026-11-01")
  })

  test("seasons that share a day overlap, and the first such pair is named by place", () => {
    assert.ok(!seasonsOverlap(summer, winter))
    assert.ok(seasonsOverlap(summer, { startsOn: "09-30", endsOn: "11-01" }))
    assert.ok(!seasonsOverlap(summer, { startsOn: "10-01", endsOn: "11-01" }))
    assert.ok(seasonsOverlap(winter, { startsOn: "03-31", endsOn: "05-01" }))
    assert.equal(overlappingSeasons([summer, winter]), undefined)
    assert.deepEqual(overlappingSeasons([summer, winter, { startsOn: "12-24", endsOn: "12-27" }]), [1, 2])
  })

  test("a season is shown with its last day in it", () => {
    assert.equal(seasonLastDay(summer), "09-30")
    assert.equal(seasonLastDay({ endsOn: "01-01" }), "12-31")
    assert.equal(seasonLastDay({ endsOn: "03-01" }), "02-28")
    assert.equal(seasonSpanLabel(summer), "1 May – 30 Sep")
    assert.equal(seasonSpanLabel(winter), "1 Nov – 31 Mar")
  })
})

describe("the cadence a season gives the occurrences", () => {
  test("in summer every Monday, in winter the odd weeks, between them the scheme's even weeks", () => {
    const rows = dates(recurrence, "2026-01-01", "2027-12-31")
    assert.ok(rows.length > 0)
    for (const row of rows) {
      assert.equal(serviceDayOf(row.date), "monday", row.date)
      const season = seasonOn([summer, winter], row.date)
      assert.equal(row.season, season?.name, row.date)
      if (season === winter) assert.equal(isoWeek(row.date) % 2, 1, row.date)
      if (season === undefined) assert.equal(isoWeek(row.date) % 2, 0, row.date)
    }
    const summerRows = rows.filter((row) => row.season === "Summer" && row.date.startsWith("2026"))
    // Every Monday from 4 May to 28 Sep 2026: 22 of them.
    assert.equal(summerRows.length, 22)
    assert.equal(summerRows[0].date, "2026-05-04")
    assert.equal(summerRows.at(-1)?.date, "2026-09-28")
  })

  test("the rows are numbered across the seasons without a gap", () => {
    const rows = dates(recurrence, "2026-01-01", "2026-12-31")
    assert.deepEqual(rows.map((row) => row.n), rows.map((_, n) => n + 1))
  })

  test("an every-3-weeks season counts from its own first week each year", () => {
    const anchored: SchemeRecurrence = { ...recurrence, seasons: [{ name: "Summer", startsOn: "06-01", endsOn: "09-01", frequency: "every-3-weeks" }] }
    const summer2026 = dates(anchored, "2026-06-01", "2026-08-31").map((row) => row.date)
    // 1 Jun 2026 is a Monday: that week, then every third.
    assert.deepEqual(summer2026, ["2026-06-01", "2026-06-22", "2026-07-13", "2026-08-03", "2026-08-24"])
    // 1 Jun 2027 is a Tuesday: its week's Monday is 31 May, outside the season, so the first is three weeks on.
    const summer2027 = dates(anchored, "2027-06-01", "2027-08-31").map((row) => row.date)
    assert.deepEqual(summer2027, ["2027-06-21", "2027-07-12", "2027-08-02", "2027-08-23"])
  })

  test("a scheme that starts inside a season counts from its own first week", () => {
    const late: SchemeRecurrence = { ...recurrence, effectiveFrom: "2026-06-08", seasons: [{ name: "Summer", startsOn: "06-01", endsOn: "09-01", frequency: "every-3-weeks" }] }
    assert.equal(cadenceOn(late, "2026-07-01").anchor, "2026-06-08")
    assert.deepEqual(dates(late, "2026-06-01", "2026-07-31").map((row) => row.date), ["2026-06-08", "2026-06-29", "2026-07-20"])
  })

  test("a monthly season serves the first of each service weekday in the month", () => {
    const monthly: SchemeRecurrence = { ...recurrence, seasons: [{ name: "Winter", startsOn: "12-01", endsOn: "03-01", frequency: "monthly" }] }
    assert.deepEqual(dates(monthly, "2026-12-01", "2027-02-28").map((row) => row.date), ["2026-12-07", "2027-01-04", "2027-02-01"])
  })

  test("a scheme without seasons runs at its own cadence and names no season", () => {
    const plain: SchemeRecurrence = { ...recurrence, seasons: [] }
    const rows = dates(plain, "2026-05-01", "2026-09-30")
    assert.ok(rows.every((row) => row.season === undefined && isoWeek(row.date) % 2 === 0))
    assert.equal(cadenceOn(plain, "2026-07-01").frequency, "every-2-weeks")
  })

  test("the scheme's period still bounds every season", () => {
    const ended: SchemeRecurrence = { ...recurrence, effectiveTo: "2026-06-30" }
    assert.ok(!matchesRecurrence(ended, "2026-07-06"))
    assert.ok(matchesRecurrence(ended, "2026-06-29"))
  })
})

describe("a scheme record's seasons", () => {
  const stored = [
    { name: "Winter", startsOn: "11-01", endsOn: "04-01", frequency: "every-2-weeks", weekRotation: "odd" },
    { name: "Summer", startsOn: "05-01", endsOn: "10-01", frequency: "weekly", weekRotation: null },
  ] as const satisfies readonly StoredSchemeSeason[]

  test("ride as JSON by the day they start, and read back for the date math with the null rotation left out", () => {
    const values = { [SCHEME_SEASONS_KEY]: seasonsValue(stored) }
    assert.deepEqual(storedSeasonsFromValues(values).map((season) => season.name), ["Summer", "Winter"])
    assert.deepEqual(seasonsFromValues(values), [summer, winter])
  })

  test("a record without them, with JSON that is not a list, or with entries that are not seasons reads none of those", () => {
    assert.deepEqual(storedSeasonsFromValues({}), [])
    assert.deepEqual(storedSeasonsFromValues({ [SCHEME_SEASONS_KEY]: "not json" }), [])
    assert.deepEqual(storedSeasonsFromValues({ [SCHEME_SEASONS_KEY]: "{}" }), [])
    assert.deepEqual(storedSeasonsFromValues({ [SCHEME_SEASONS_KEY]: JSON.stringify([{ ...stored[1], startsOn: "02-29" }, { ...stored[1], frequency: "daily" }, stored[0]]) }).map((season) => season.name), ["Winter"])
  })

  test("a set the date math may not read together is read as none, and the editor says why", () => {
    const overlapping = [stored[1], { ...stored[1], name: "Autumn", startsOn: "09-01", endsOn: "11-01" }]
    assert.deepEqual(seasonsFromValues({ [SCHEME_SEASONS_KEY]: JSON.stringify(overlapping) }), [])
    assert.deepEqual(seasonProblems(overlapping), ["Seasons share no day: Autumn overlaps Summer"])
    assert.deepEqual(seasonProblems([stored[1], { ...stored[0], name: "Summer", weekRotation: null }]), ["Summer: pick the week rotation for every 2 weeks", "A season name is used once in a scheme"])
    assert.deepEqual(seasonProblems([{ ...stored[1], name: " ", endsOn: "05-01" }]), ["Every season needs a name", "A season: a season ends on another day than it starts; a season of the whole year is the scheme's own cadence"])
    assert.deepEqual(seasonProblems(stored), [])
  })

  test("recurrenceFromValues carries them, except on a daily scheme", () => {
    const values = { frequency: "weekly", serviceDays: "monday", effectiveFrom: "2026-01-05", [SCHEME_SEASONS_KEY]: seasonsValue(stored) }
    assert.deepEqual(recurrenceFromValues(values)?.seasons, [summer, winter])
    assert.equal(recurrenceFromValues({ ...values, frequency: "daily" })?.seasons, undefined)
    assert.equal(recurrenceFromValues({ ...values, [SCHEME_SEASONS_KEY]: undefined })?.seasons, undefined)
  })
})
