// The Dashboard's Compliance tab on the Pilot (#291 slice 29): the
// waste-data report the office files with the national waste-data system by
// hand, read under Improve's Compliance and the weights' grant
// (`GET /reports/waste-data`, its file `.csv`). What the screen reads off it
// is here, so it is tested without a browser: the filing periods — the
// calendar year before, which the national system is reported for, the year
// so far, the quarter and the month before, or one the person spells — the
// separator the file is asked for by the browser's locale, and the name a
// downloaded file is saved under.
//
// A period is days on the project's clock, both inclusive, as the report
// reads them. A period the person spells is held here to what the report
// takes — both days, the last on or after the first, at most a year's days —
// so the tab says why in a plain sentence rather than asking; from which day
// the report reads is the API's to judge, in its own sentence.
import { windowDays } from "@waste/domain/insight/intervals"
import { addDays } from "@waste/domain/route-schemes/recurrence"

import type { FileSeparator, WasteDataQuery } from "@/lib/api/reports"

import { dayLabel, type DayWindow } from "./dashboard"

/** The periods a filing is asked for: the national system's year first, which the tab opens on. */
export const COMPLIANCE_PERIODS = [
  { id: "last-year", label: "Last year" },
  { id: "this-year", label: "This year so far" },
  { id: "last-quarter", label: "Last quarter" },
  { id: "last-month", label: "Last month" },
  { id: "custom", label: "Custom period" },
] as const

export type CompliancePeriodId = (typeof COMPLIANCE_PERIODS)[number]["id"]

export const DEFAULT_PERIOD: CompliancePeriodId = "last-year"

/** The first day of a month counted from January of year 0, so a month before January is December of the year before. */
function firstOf(months: number): string {
  const year = Math.floor(months / 12)
  const month = months - year * 12 + 1
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`
}

/** The months from `from` (counted as `firstOf` counts) for `count` months: their first and last day. */
const monthsFrom = (from: number, count: number): DayWindow => ({ from: firstOf(from), to: addDays(firstOf(from + count), -1) })

/** A preset's days around today, a day on the project's clock; null for a custom period, which the person spells. */
export function periodOf(id: CompliancePeriodId, today: string): DayWindow | null {
  const year = Number(today.slice(0, 4))
  const month = year * 12 + Number(today.slice(5, 7)) - 1
  switch (id) {
    case "last-year":
      return monthsFrom((year - 1) * 12, 12)
    case "this-year":
      return { from: firstOf(year * 12), to: today }
    case "last-quarter":
      return monthsFrom(month - (month % 3) - 3, 3)
    case "last-month":
      return monthsFrom(month - 1, 1)
    case "custom":
      return null
  }
}

/** The longest window a report reads (`@waste/contracts/reports`, REPORT_WINDOW_MAX_DAYS), spelled again since the contracts reach the bundle as types alone; a test holds the two equal. */
export const REPORT_WINDOW_MAX_DAYS = 366

/** What the tab says of a period the report would refuse, in place of asking the API. */
export const PERIOD_INCOMPLETE = "Pick the period's first and last day"
export const PERIOD_BACKWARDS = "The period's last day comes on or after its first"
export const PERIOD_TOO_LONG = `A filing's period is at most ${REPORT_WINDOW_MAX_DAYS} days; ask for a year at a time`

/** Why a period cannot be asked for, or null when it can: both days given, in order, a year's days at most. */
export function periodRefusal(period: DayWindow): string | null {
  if (period.from === "" || period.to === "") return PERIOD_INCOMPLETE
  if (period.to < period.from) return PERIOD_BACKWARDS
  return windowDays(period) > REPORT_WINDOW_MAX_DAYS ? PERIOD_TOO_LONG : null
}

/** A period as a heading reads it: `Jan 1 – Dec 31 2025`, each day with its year where the two years differ. */
export function periodLabel(period: DayWindow): string {
  const [fromYear, toYear] = [period.from.slice(0, 4), period.to.slice(0, 4)]
  if (fromYear !== toYear) return `${dayLabel(period.from)} ${fromYear} – ${dayLabel(period.to)} ${toYear}`
  return period.from === period.to ? `${dayLabel(period.from)} ${toYear}` : `${dayLabel(period.from)} – ${dayLabel(period.to)} ${toYear}`
}

/** The file's separators as the tab offers them. */
export const SEPARATORS = [
  { id: "comma", label: "Commas" },
  { id: "semicolon", label: "Semicolons" },
] as const satisfies readonly { id: FileSeparator; label: string }[]

/**
 * The separator a spreadsheet under the locale opens a CSV with: semicolons
 * where the locale writes a decimal comma (Danish, German), since its
 * spreadsheet reads a comma as the decimal, and commas otherwise.
 */
export function separatorFor(locale: string | undefined): FileSeparator {
  try {
    const decimal = new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal")?.value
    return decimal === "," ? "semicolon" : "comma"
  } catch {
    return "comma"
  }
}

/** The name a downloaded file is saved under: the API's, else the one it would give. */
export function wasteDataFileName(fileName: string | null, query: WasteDataQuery): string {
  return fileName ?? `waste-data-${query.from}-${query.to}.csv`
}
