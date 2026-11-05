// Public-holiday names by date, per holiday list. A Collection Calendar
// record edited in the Holiday lists pane carries its own names
// (`holidayNames`, holidays.ts, since 2026-09-24); this lookup names the
// dates of a record that carries none, so the guided setup's next-dates
// preview still reads "Shifted from Thu 24 Dec · Christmas Eve" for the
// seeded years, and it is what "Create next year" places a moveable feast
// by (holiday-lists.ts). The lookup follows the project's holiday list name
// (holidayNamesFor): Danish names for "Danish public holidays", Egyptian
// fixed-date names for "Egyptian public holidays", nothing for a list this
// module does not know — such dates read "Holiday". Pure date math over ISO
// `yyyy-mm-dd` strings.

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

/** A list this module knows: its usual name, the country it is of (ISO 3166-1 alpha-2), and how it names its dates. */
type KnownHolidayList = { name: string; country: string; names: HolidayNameLookup }

const KNOWN_HOLIDAY_LISTS: readonly KnownHolidayList[] = [
  { name: "Danish public holidays", country: "DK", names: danishHolidayName },
  { name: "Egyptian public holidays", country: "EG", names: egyptianHolidayName },
]

/** The list names this module can name dates for — what the Holiday lists pane offers first. */
export const KNOWN_HOLIDAY_LIST_NAMES: readonly string[] = KNOWN_HOLIDAY_LISTS.map((list) => list.name)

/** The country a known list's name is of (`Danish public holidays` → `DK`), or undefined for a name this module does not know. */
export function knownHolidayListCountry(listName: string): string | undefined {
  return KNOWN_HOLIDAY_LISTS.find((list) => list.name === listName)?.country
}

/** The usual name of a country's known list (`DK` → `Danish public holidays`), or undefined for a country this module does not know. */
export function knownHolidayListName(country: string): string | undefined {
  return KNOWN_HOLIDAY_LISTS.find((list) => list.country === country)?.name
}

const noNames: HolidayNameLookup = () => undefined

/** The name lookup for a project's holiday list; an unknown list names nothing. */
export function holidayNamesFor(listName: string | undefined): HolidayNameLookup {
  return KNOWN_HOLIDAY_LISTS.find((list) => list.name === listName)?.names ?? noNames
}

/** The name lookup for a country's holidays (`DK`, `EG`); a country this module does not know names nothing. */
export function holidayNamesForCountry(country: string | undefined): HolidayNameLookup {
  return KNOWN_HOLIDAY_LISTS.find((list) => list.country === country)?.names ?? noNames
}

/** A lookup that answers the carried names first and falls back to another. */
export function withCarriedNames(
  carried: ReadonlyMap<string, string>,
  fallback: HolidayNameLookup,
): HolidayNameLookup {
  return (iso) => carried.get(iso) ?? fallback(iso)
}

/** The label a calendar holiday shows: its name on the list, else the generic word. */
export function holidayLabel(iso: string, names: HolidayNameLookup): string {
  return names(iso) ?? "Holiday"
}
