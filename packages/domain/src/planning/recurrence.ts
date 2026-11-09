// Route Scheme recurrence engine.
// Pure date math over ISO `yyyy-mm-dd` strings — no UI, store, or fixture
// dependencies — so the scheme form preview and the route generation engine
// share one definition of "which dates does this scheme serve".
//
// Semantics (validated in the prototype on branch prototype/route-schemes):
//   matches(date):
//     date within [effectiveFrom, effectiveTo] (inclusive; empty To = open)
//     weekday(date) ∈ serviceDays
//     every-2-weeks → ISO-week parity of date == the scheme's week rotation
//     once-a-month → dayOfMonth(date) <= 7 (the first occurrence of each
//                    selected weekday in the month)
//     the cadence is the season's in force on the date, if any (seasons.ts)
//   Route identity = (schemeId, collectionGroupId, serviceDate) — deterministic, so
//   regeneration can upsert instead of duplicating.
//
// The closed lists live in ../planning/vocabulary since Issue #97, where the
// database and the contracts read them too; the day arithmetic is ../days.

import { addDays, daysBetween, isoWeek, mondayOf, SERVICE_DAY_SHORT_LABELS, SERVICE_DAYS, type ServiceDay, serviceDayOf } from "../days"
import { RECURRENCE_FREQUENCIES, type RecurrenceFrequency, type WeekRotation } from "./vocabulary"
import { seasonOn, seasonStartOf, type SchemeSeason } from "./seasons"

/**
 * daily (2026-09-16): every date in the effective window — the scheme serves
 * all seven weekdays, so its stored service days are always the full week.
 * every-3-weeks / every-4-weeks anchor on the ISO week of the scheme's
 * effective-from date: the anchor week and every third / fourth week after
 * it serve. Unlike the fortnight rotations they are true 21- / 28-day
 * cadences, so they do not follow the 53-week ISO-year boundary behaviour
 * below. every-4-weeks is kept for stored records; the forms offer the
 * other five. The tuple is the vocabulary's `RECURRENCE_FREQUENCIES`.
 */
export const RECURRENCE_FREQUENCY_LABELS: Record<RecurrenceFrequency, string> = {
  daily: "Daily",
  weekly: "Every week",
  "every-2-weeks": "Every 2 weeks",
  "every-3-weeks": "Every 3 weeks",
  "every-4-weeks": "Every 4 weeks",
  monthly: "Once a month",
}

/** The cadences the create forms offer, in display order. */
export const OFFERED_RECURRENCE_FREQUENCIES: readonly RecurrenceFrequency[] = [
  "daily",
  "weekly",
  "every-2-weeks",
  "every-3-weeks",
  "monthly",
]

/**
 * Nominal collections per week each cadence delivers on one service day —
 * the shared scale the reconciliation validation (issue #21) compares scheme
 * recurrence against promised service frequencies on. Monthly is 12
 * collections across a 52-week year, not 1/4: the first-weekday rule serves
 * calendar months. The promise side derives its rate from the interval
 * vocabulary (`intervalCollectionsPerWeek`, planning/frequency-reconciliation), so
 * every-N-weeks promises order naturally against these without needing a
 * scheme-cadence counterpart.
 */
export const RECURRENCE_WEEKLY_RATES: Record<RecurrenceFrequency, number> = {
  // A daily scheme collects every container it serves seven times a week.
  daily: 7,
  weekly: 1,
  "every-2-weeks": 1 / 2,
  "every-3-weeks": 1 / 3,
  "every-4-weeks": 1 / 4,
  monthly: 12 / 52,
}

/**
 * How many dates a week the recurrence serves on the given days, averaged
 * over one full cycle of its rotation (#280): a fortnight's Mon and Thu are
 * one a week, three weeks' Tue is a third. Daily serves every date, so each
 * day given counts once a week — its weekly rate is per container, the
 * whole week. Monthly's first weekdays count on the weekly rates' 52-week
 * year. The guided setup's routes per week sums it over the groups' days.
 */
export function occurrencesPerWeek(frequency: RecurrenceFrequency, days: readonly ServiceDay[]): number {
  const perDay = frequency === "daily" ? 1 : RECURRENCE_WEEKLY_RATES[frequency]
  return new Set(days).size * perDay
}

export type SchemeRecurrence = {
  frequency: RecurrenceFrequency
  serviceDays: ServiceDay[]
  /** Which ISO-week parity an every-2-weeks scheme serves. */
  weekRotation?: WeekRotation
  effectiveFrom: string
  /** Empty string = open-ended (the form requires it; the math tolerates it). */
  effectiveTo: string
  /** Planned start time ("06:30"); carried for facts, not used in date math. */
  startTime?: string
  /**
   * The cadences the scheme runs at for part of every year (O17 of #290,
   * seasons.ts); outside every season the frequency above. The seasons share
   * no day. Absent or empty, the scheme runs at one cadence all year.
   */
  seasons?: readonly SchemeSeason[]
}

/** Today as ISO in the browser's local time — the "now" all date pickers seed from. */
export function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

// Odd/even ISO-week rotations are calendar-anchored, not a strict fortnightly
// cadence: a 53-week ISO year (2026 is one) ends on week 53 (odd) and the next
// year starts on week 1 (odd), so an odd-rotation scheme serves two consecutive
// weeks at that boundary and an even-rotation scheme skips three. That is how
// odd/even-week municipal collection behaves in the real world (the retired
// Collection Weeks module's rotation labels mapped to the same parity); a
// scheme needing an unbroken 14-day cadence across such a boundary needs a
// new scheme version there.
export function isoWeekRotation(iso: string): WeekRotation {
  return isoWeek(iso) % 2 === 1 ? "odd" : "even"
}

/** Whole ISO weeks from the effective-from week to the date's week (negative before it). */
export function weeksFromEffectiveFrom(recurrence: Pick<SchemeRecurrence, "effectiveFrom">, iso: string): number {
  return Math.round(daysBetween(mondayOf(recurrence.effectiveFrom), mondayOf(iso)) / 7)
}

const ANCHORED_WEEK_INTERVALS: Partial<Record<RecurrenceFrequency, number>> = {
  "every-3-weeks": 3,
  "every-4-weeks": 4,
}

/** The cadence a recurrence runs at on one date: its own, or that of the season in force, anchored as seasons.ts says. */
export type CadenceOn = {
  frequency: RecurrenceFrequency
  weekRotation?: WeekRotation
  /** The day an every-3/4-weeks count starts from; empty where there is none. */
  anchor: string
  season?: SchemeSeason
}

export function cadenceOn(recurrence: SchemeRecurrence, iso: string): CadenceOn {
  const season = seasonOn(recurrence.seasons, iso)
  if (season === undefined) {
    return { frequency: recurrence.frequency, ...(recurrence.weekRotation === undefined ? {} : { weekRotation: recurrence.weekRotation }), anchor: recurrence.effectiveFrom }
  }
  // Each year's stretch counts from its own first day, or from the scheme's where the scheme starts inside it.
  const start = seasonStartOf(season, iso)
  const anchor = recurrence.effectiveFrom && recurrence.effectiveFrom > start ? recurrence.effectiveFrom : start
  return { frequency: season.frequency, ...(season.weekRotation === undefined ? {} : { weekRotation: season.weekRotation }), anchor, season }
}

export function matchesRecurrence(recurrence: SchemeRecurrence, iso: string): boolean {
  if (recurrence.effectiveFrom && iso < recurrence.effectiveFrom) return false
  if (recurrence.effectiveTo && iso > recurrence.effectiveTo) return false
  const cadence = cadenceOn(recurrence, iso)
  // Daily serves every weekday, whatever the stored service days say.
  if (cadence.frequency === "daily") return true
  if (!recurrence.serviceDays.includes(serviceDayOf(iso))) return false
  if (
    cadence.frequency === "every-2-weeks" &&
    isoWeekRotation(iso) !== cadence.weekRotation
  ) {
    return false
  }
  // Without an effective-from there is no anchor week; the cadence then
  // degrades to weekly rather than matching nothing (the form requires From).
  const interval = ANCHORED_WEEK_INTERVALS[cadence.frequency]
  if (
    interval &&
    cadence.anchor &&
    weeksFromEffectiveFrom({ effectiveFrom: cadence.anchor }, iso) % interval !== 0
  ) {
    return false
  }
  if (cadence.frequency === "monthly" && Number(iso.slice(8, 10)) > 7) return false
  return true
}

// Open-ended monthly schemes need ~8 months of scanning for an 8-date
// preview; two years bounds the walk for any well-formed recurrence.
const SCAN_LIMIT_DAYS = 731

export function nextServiceDates(
  recurrence: SchemeRecurrence,
  options: { from: string; count: number },
): string[] {
  const dates: string[] = []
  if (recurrence.serviceDays.length === 0 || options.count <= 0) return dates
  let cursor =
    recurrence.effectiveFrom && recurrence.effectiveFrom > options.from
      ? recurrence.effectiveFrom
      : options.from
  for (let step = 0; step < SCAN_LIMIT_DAYS && dates.length < options.count; step += 1) {
    if (recurrence.effectiveTo && cursor > recurrence.effectiveTo) break
    if (matchesRecurrence(recurrence, cursor)) dates.push(cursor)
    cursor = addDays(cursor, 1)
  }
  return dates
}

export function sortServiceDays(days: readonly ServiceDay[]): ServiceDay[] {
  return [...days].sort((a, b) => SERVICE_DAYS.indexOf(a) - SERVICE_DAYS.indexOf(b))
}

/**
 * "Mon–Fri" for three or more consecutive days, otherwise "Mon, Wed" — the
 * compact day label the guided setup's rail, review, and list rows share.
 */
export function serviceDaysRangeLabel(days: readonly ServiceDay[]): string {
  const indexes = SERVICE_DAYS.map((day, index) => (days.includes(day) ? index : -1)).filter(
    (index) => index >= 0,
  )
  if (indexes.length === 0) return ""
  const consecutive = indexes.every((value, i) => i === 0 || value === indexes[i - 1] + 1)
  if (consecutive && indexes.length >= 3) {
    return `${SERVICE_DAY_SHORT_LABELS[SERVICE_DAYS[indexes[0]]]}–${SERVICE_DAY_SHORT_LABELS[SERVICE_DAYS[indexes[indexes.length - 1]]]}`
  }
  return indexes.map((index) => SERVICE_DAY_SHORT_LABELS[SERVICE_DAYS[index]]).join(", ")
}

/**
 * The cadence alone — "Every week", "Every 2 weeks (even ISO weeks)",
 * "Once a month" — shared by recurrenceSentence and the schemes list's
 * Recurrence column (issue #30), so the fortnight-rotation copy lives once.
 */
export function recurrenceCadenceLabel(
  recurrence: Pick<SchemeRecurrence, "frequency" | "weekRotation">,
): string {
  const label = RECURRENCE_FREQUENCY_LABELS[recurrence.frequency]
  return recurrence.frequency === "every-2-weeks"
    ? `${label} (${recurrence.weekRotation} ISO weeks)`
    : label
}

export function recurrenceSentence(recurrence: SchemeRecurrence): string {
  if (recurrence.frequency === "daily") return "Daily"
  if (recurrence.serviceDays.length === 0) return "No service days selected"
  const days = sortServiceDays(recurrence.serviceDays)
    .map((day) => SERVICE_DAY_SHORT_LABELS[day])
    .join(", ")
  if (recurrence.frequency === "monthly") return `Once a month (first ${days} of the month)`
  return `${recurrenceCadenceLabel(recurrence)} on ${days}`
}

export const isRecurrenceFrequency = (
  value: unknown,
): value is RecurrenceFrequency =>
  typeof value === "string" && (RECURRENCE_FREQUENCIES as readonly string[]).includes(value)
