// Seasons of a Route Scheme (O17 of #290): a summer or winter cadence that
// recurs every year. A season is a stretch of the calendar year, given by the
// month and day it starts on and the month and day it ends before — half-open
// like every period here (ADR-0005), so `startsOn` is its first day and
// `endsOn` the first day out of it. A season whose end comes before its start
// runs over the new year: winter from 11-01 to 04-01 is November to March.
// Inside a season the scheme serves its own service days at the season's
// cadence; outside every season, at its own. The seasons of one scheme never
// share a day, so at most one is in force on any date.
//
// A season begins on a day every year has, so 02-29 is refused: a season
// that started on a leap day would not start at all three years in four. The
// end may be any such day too; a season running to the end of February ends
// before 03-01.
//
// An every-3-weeks or every-4-weeks cadence is anchored on a week. Inside a
// season it is the week the season started in that year (or the scheme's
// first week, where the scheme starts during the season), so each year's
// summer starts its count afresh; outside, the scheme's first week as before.
// The fortnight rotations are ISO-week parity and need no anchor.
//
// Pure date math over ISO `yyyy-mm-dd` strings and `mm-dd` month-days.

import type { SeasonFrequency, WeekRotation } from "../planning/vocabulary"

/** The most seasons a scheme may have: a form's list, and more than a year's quarters and halves need. The contracts bound a body by it. */
export const SEASONS_MAX = 6

/** `mm-dd`: a day of the calendar year, never 02-29. */
export type MonthDay = string

export type SchemeSeason = {
  /** Unique within the scheme: "Summer". */
  name: string
  /** The first day of the season, every year. */
  startsOn: MonthDay
  /** The first day out of the season, every year; before `startsOn` for a season over the new year. */
  endsOn: MonthDay
  frequency: SeasonFrequency
  /** Which ISO-week parity an every-2-weeks season serves; given with that cadence and with nothing else. */
  weekRotation?: WeekRotation
}

/** The days each month has in a year without a leap day, the one every season is read in. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * A day every calendar year has, spelt `mm-dd`, as one regular expression:
 * the database's check on a season's two days reads this source, and the
 * contracts and `isMonthDay` match it, so the three cannot drift.
 */
export const MONTH_DAY_SOURCE = "^((01|03|05|07|08|10|12)-(0[1-9]|[12][0-9]|3[01])|(04|06|09|11)-(0[1-9]|[12][0-9]|30)|02-(0[1-9]|1[0-9]|2[0-8]))$"
const MONTH_DAY_PATTERN = new RegExp(MONTH_DAY_SOURCE)

/** A day every calendar year has, spelt `mm-dd`. */
export function isMonthDay(value: string): boolean {
  return MONTH_DAY_PATTERN.test(value)
}

/** Whether the season runs over the new year: its end comes before its start in the calendar. */
const wraps = (season: Pick<SchemeSeason, "startsOn" | "endsOn">): boolean => season.endsOn < season.startsOn

/**
 * Whether the date lies in the season. A leap year's 29 February belongs to
 * the season that holds 28 February: no season starts or ends on 02-29, so
 * in a reading of `mm-dd` text the leap day falls wherever the day before it
 * does.
 */
export function seasonContains(season: Pick<SchemeSeason, "startsOn" | "endsOn">, iso: string): boolean {
  const day = iso.slice(5)
  return wraps(season) ? day >= season.startsOn || day < season.endsOn : day >= season.startsOn && day < season.endsOn
}

/** The season in force on the date, if any; the seasons of a scheme share no day, so there is at most one. */
export function seasonOn<T extends Pick<SchemeSeason, "startsOn" | "endsOn">>(seasons: readonly T[] | undefined, iso: string): T | undefined {
  return seasons?.find((season) => seasonContains(season, iso))
}

/** The first day of the stretch of the season that holds the date: this year's start, or last year's for the new-year half of a season that wraps. */
export function seasonStartOf(season: Pick<SchemeSeason, "startsOn" | "endsOn">, iso: string): string {
  const year = Number(iso.slice(0, 4))
  const startYear = wraps(season) && iso.slice(5) < season.startsOn ? year - 1 : year
  return `${String(startYear).padStart(4, "0")}-${season.startsOn}`
}

/** Every day of the year without a leap day, `mm-dd`, the walk an overlap is judged over. */
const YEAR = MONTH_DAYS.flatMap((days, month) => Array.from({ length: days }, (_, day) => `${String(month + 1).padStart(2, "0")}-${String(day + 1).padStart(2, "0")}`))

/** Whether two seasons share a day of the year. */
export function seasonsOverlap(a: Pick<SchemeSeason, "startsOn" | "endsOn">, b: Pick<SchemeSeason, "startsOn" | "endsOn">): boolean {
  return YEAR.some((day) => seasonContains(a, `2001-${day}`) && seasonContains(b, `2001-${day}`))
}

/** Whether the seasons hold every day of the year between them, leaving the scheme's own cadence no day to run on. */
export function seasonsCoverYear(seasons: readonly Pick<SchemeSeason, "startsOn" | "endsOn">[]): boolean {
  return seasons.length > 0 && YEAR.every((day) => seasons.some((season) => seasonContains(season, `2001-${day}`)))
}

/** The first pair of seasons of a list that share a day, by their places in it; none when the seasons keep apart. */
export function overlappingSeasons(seasons: readonly Pick<SchemeSeason, "startsOn" | "endsOn">[]): [number, number] | undefined {
  for (let later = 1; later < seasons.length; later += 1) {
    for (let earlier = 0; earlier < later; earlier += 1) {
      if (seasonsOverlap(seasons[earlier], seasons[later])) return [earlier, later]
    }
  }
  return undefined
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "1 May": a month-day as the forms show it. */
export function formatMonthDay(monthDay: MonthDay): string {
  const [month, day] = monthDay.split("-").map(Number)
  return `${day} ${MONTHS[month - 1]}`
}

/** The last day in the season, the day before `endsOn`: what a reader calls its end. */
export function seasonLastDay(season: Pick<SchemeSeason, "endsOn">): MonthDay {
  const index = YEAR.indexOf(season.endsOn)
  return YEAR[(index + YEAR.length - 1) % YEAR.length]
}

/** "1 May – 30 Sep": the stretch of the year a season holds, both days in it. */
export function seasonSpanLabel(season: Pick<SchemeSeason, "startsOn" | "endsOn">): string {
  return `${formatMonthDay(season.startsOn)} – ${formatMonthDay(seasonLastDay(season))}`
}
