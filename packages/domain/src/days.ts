// Calendar days, `YYYY-MM-DD`: the bottom of the domain, which every context
// may import and which imports nothing. A calendar day has no clock, so the
// arithmetic is over UTC midnights, where every day is 86 400 000 ms long; the
// day an instant falls on is the project clock's question (clock.ts).
//
// Labels are hand-rolled tables, never `toLocaleDateString`: ICU spells
// September `Sept` in en-GB from version 72 and `Sep` before it, so a label
// read from the runtime would drift between Node, browsers and CI.

/** The seven weekdays, Monday first: a scheme's service days, a group's days, a project's weekend. */
export const SERVICE_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const
export type ServiceDay = (typeof SERVICE_DAYS)[number]

export const SERVICE_DAY_LABELS: Record<ServiceDay, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
}

export const SERVICE_DAY_SHORT_LABELS: Record<ServiceDay, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
}

/** The months, January first. */
export const MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const

export const MONTH_SHORT_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

const DAY_MS = 86_400_000

const parseDay = (day: string): Date => new Date(`${day}T00:00:00Z`)
const dayOf = (date: Date): string => date.toISOString().slice(0, 10)

// Shape alone is not enough: "9999-99-99" matches the pattern but parses to
// an Invalid Date, and "2026-02-30" silently rolls over to March — the
// round trip catches both.
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Whether a string is a calendar day that exists, `YYYY-MM-DD`. */
export const isIsoDate = (value: string): boolean => DAY_PATTERN.test(value) && !Number.isNaN(parseDay(value).getTime()) && dayOf(parseDay(value)) === value

export function addDays(day: string, days: number): string {
  const date = parseDay(day)
  date.setUTCDate(date.getUTCDate() + days)
  return dayOf(date)
}

/** Whole days from `from` to `to`: the days of the half-open span `[from, to)`, negative where `to` comes first. */
export const daysBetween = (from: string, to: string): number => Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / DAY_MS)

/** The days a span holds with both ends in it: one for a single day. */
export const daysInclusive = (first: string, last: string): number => daysBetween(first, last) + 1

export function serviceDayOf(day: string): ServiceDay {
  // getUTCDay: 0 = Sunday; SERVICE_DAYS is Monday-first.
  return SERVICE_DAYS[(parseDay(day).getUTCDay() + 6) % 7]
}

/** The Monday of the ISO week the day falls in. */
export const mondayOf = (day: string): string => addDays(day, -SERVICE_DAYS.indexOf(serviceDayOf(day)))

export function isoWeek(day: string): number {
  const date = parseDay(day)
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7))
  const week1 = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  return 1 + Math.round(((date.getTime() - week1.getTime()) / DAY_MS - 3 + ((week1.getUTCDay() + 6) % 7)) / 7)
}

/** `day` moved by `months` calendar months, rolling over like Date#setMonth where the month lacks the day (31 January + 1 month is 3 March). */
export function addMonthsRolling(day: string, months: number): string {
  const [year, month, date] = day.split("-").map(Number)
  return dayOf(new Date(Date.UTC(year, month - 1 + months, date)))
}

/** `day` moved by `months` calendar months; a day the month lacks lands on its last day (30 November + 3 months is 28 February). */
export function addMonthsClamped(day: string, months: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  const index = year * 12 + (month - 1) + months
  const targetYear = Math.floor(index / 12)
  const targetMonth = (index % 12) + 1
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate()
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth).padStart(2, "0")}-${String(Math.min(date, lastDay)).padStart(2, "0")}`
}

/** "5 Oct": a day of the month and its month. */
export function formatDayMonth(day: string): string {
  const [, month, date] = day.split("-").map(Number)
  return `${date} ${MONTH_SHORT_LABELS[month - 1]}`
}

/** "Thu 24 Dec": a day as a short list or a sentence names it. */
export const formatShortDay = (day: string): string => `${SERVICE_DAY_SHORT_LABELS[serviceDayOf(day)]} ${formatDayMonth(day)}`

/** ISO date → holiday name: the days a project rests on besides its weekend, by the name each is known by. */
export type HolidayList = ReadonlyMap<string, string>

export const NO_HOLIDAYS: HolidayList = new Map()
