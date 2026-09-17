// Public-holiday names by date, per holiday list. Collection Calendar records
// store holiday DATES only (submittedValues.holidayDates), so the guided
// setup's next-dates preview needs a name lookup to read "Shifted from Thu 24
// Dec · Christmas Eve". The lookup follows the project's holiday list name
// (holidayNamesFor): Danish names for "Danish public holidays", Egyptian
// fixed-date names for "Egyptian public holidays", nothing for a list this
// module does not know — such dates read "Holiday". Gap adapter: replace with
// calendar-carried names once the calendar model has them. Pure date math
// over ISO `yyyy-mm-dd` strings.

import { addDays } from "./recurrence"

const FIXED_HOLIDAYS: Readonly<Record<string, string>> = {
  "01-01": "New Year's Day",
  "06-05": "Constitution Day",
  "12-24": "Christmas Eve",
  "12-25": "Christmas Day",
  "12-26": "2nd Christmas Day",
  "12-31": "New Year's Eve",
}

/** Easter Sunday (Gregorian, anonymous algorithm) as ISO. */
export function easterSunday(year: number): string {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

const EASTER_RELATIVE: ReadonlyArray<[offset: number, name: string]> = [
  [-3, "Maundy Thursday"],
  [-2, "Good Friday"],
  [0, "Easter Sunday"],
  [1, "Easter Monday"],
  [39, "Ascension Day"],
  [49, "Whit Sunday"],
  [50, "Whit Monday"],
]

const cache = new Map<number, Map<string, string>>()

function holidaysOfYear(year: number): Map<string, string> {
  const cached = cache.get(year)
  if (cached) return cached
  const names = new Map<string, string>()
  for (const [monthDay, name] of Object.entries(FIXED_HOLIDAYS)) {
    names.set(`${year}-${monthDay}`, name)
  }
  const easter = easterSunday(year)
  for (const [offset, name] of EASTER_RELATIVE) {
    names.set(addDays(easter, offset), name)
  }
  cache.set(year, names)
  return names
}

/** The Danish public-holiday name for the date, or undefined for an ordinary day. */
export function danishHolidayName(iso: string): string | undefined {
  const year = Number(iso.slice(0, 4))
  if (!Number.isInteger(year)) return undefined
  return holidaysOfYear(year).get(iso)
}

/** Egyptian fixed-date public holidays; Eid and Sham El-Nessim move each year and are not named here. */
const EGYPTIAN_FIXED_HOLIDAYS: Readonly<Record<string, string>> = {
  "01-07": "Coptic Christmas",
  "01-25": "Revolution Day",
  "04-25": "Sinai Liberation Day",
  "05-01": "Labour Day",
  "06-30": "30 June Revolution",
  "07-23": "Revolution Day",
  "10-06": "Armed Forces Day",
}

/** The Egyptian fixed-date holiday name for the date, or undefined. */
export function egyptianHolidayName(iso: string): string | undefined {
  return EGYPTIAN_FIXED_HOLIDAYS[iso.slice(5)]
}

export type HolidayNameLookup = (iso: string) => string | undefined

const HOLIDAY_NAME_LOOKUPS: Readonly<Record<string, HolidayNameLookup>> = {
  "Danish public holidays": danishHolidayName,
  "Egyptian public holidays": egyptianHolidayName,
}

const noNames: HolidayNameLookup = () => undefined

/** The name lookup for a project's holiday list; an unknown list names nothing. */
export function holidayNamesFor(listName: string | undefined): HolidayNameLookup {
  return (listName && HOLIDAY_NAME_LOOKUPS[listName]) || noNames
}

/** The label a calendar holiday shows: its name on the list, else the generic word. */
export function holidayLabel(iso: string, names: HolidayNameLookup): string {
  return names(iso) ?? "Holiday"
}
