// A Drop-off Point's two sets the office types (Issue #293, M3c): its weekly
// hours and its dated exceptions, each one text in the generic form, read
// into the wire's sets and written back the same, so a point edited and saved
// unchanged writes nothing. The rules the sets must keep are the domain's
// (`hoursIssues`, `exceptionIssues`), the ones the API and the public map hold
// them to, so the form refuses in the same words before the API sees them.
// A line is read whole or refused: nothing on it is skipped or carried over
// to the next day.
//
//   weekly hours   a line a day or a run of days, then its windows:
//                    Mon–Fri 10:00–18:00
//                    Sat 09:00–12:00, 13:00–17:00
//   exceptions     a line a date, then closed or its one window, then a note:
//                    2026-12-24 09:00–12:00 Christmas Eve
//                    2026-12-25 closed Christmas Day
//
// A day gone by is history (the audit log keeps it): an exception the point
// already held is dropped once its day has passed, and one typed for a day
// gone by is refused rather than quietly lost (`exceptionsToSave`).
import type { DropOffPointKind } from "@waste/domain/resources/vocabulary"
import { exceptionIssues, hoursIssues, type OpeningException, type WeeklyWindow } from "@waste/domain/resources/drop-off-points"
import { isIsoDate, SERVICE_DAY_SHORT_LABELS, SERVICE_DAYS, serviceDaysRangeLabel, type ServiceDay } from "@waste/domain/route-schemes/recurrence"

/** A point's two kinds as the form offers them and the table names them. */
export const DROP_OFF_KIND_OPTIONS: readonly { value: DropOffPointKind; label: string }[] = [
  { value: "recycling-centre", label: "Recycling centre" },
  { value: "bring-bank", label: "Bring bank" },
]

/** What the form is told about a text it cannot take, in a sentence. */
export type TextRefusal = { message: string }

const TIME = String.raw`(\d{1,2}):(\d{2})`
const WINDOW = String.raw`${TIME}\s*[–-]\s*${TIME}`
/** A line's windows, the whole of what follows its days: one window, or several separated by commas. */
const WINDOWS_ONLY = new RegExp(String.raw`^${WINDOW}(?:\s*,\s*${WINDOW})*$`)
const EACH_WINDOW = new RegExp(WINDOW, "g")
const FIRST_TIME = /\d{1,2}:\d{2}/
const pad = (hours: string, minutes: string) => `${hours.padStart(2, "0")}:${minutes}`

/** A day by its name or its first three letters, whatever the case. */
function dayOf(word: string): ServiceDay | null {
  const lowered = word.trim().toLowerCase()
  return SERVICE_DAYS.find((day) => day === lowered || SERVICE_DAY_SHORT_LABELS[day].toLowerCase() === lowered) ?? null
}

/** The days a line names: `Mon`, `Mon–Fri`, `Thursday, Sun`; at least one. */
function daysOf(text: string, line: number): ServiceDay[] | TextRefusal {
  const parts = text.split(",").map((piece) => piece.trim())
  if (parts.some((part) => part === "")) return { message: `Line ${line}: name the days before the hours, such as Mon–Fri or Sat, Sun` }
  const days: ServiceDay[] = []
  for (const part of parts) {
    const [from, to, ...rest] = part.split(/\s*[–-]\s*/)
    if (rest.length > 0 || from === undefined) return { message: `Line ${line}: "${part}" is not a day or a run of days` }
    const first = dayOf(from)
    if (first === null) return { message: `Line ${line}: "${from}" is not a day of the week` }
    if (to === undefined) {
      days.push(first)
      continue
    }
    const last = dayOf(to)
    if (last === null) return { message: `Line ${line}: "${to}" is not a day of the week` }
    const start = SERVICE_DAYS.indexOf(first)
    const end = SERVICE_DAYS.indexOf(last)
    if (end < start) return { message: `Line ${line}: a run of days goes from Monday towards Sunday, such as Mon–Fri` }
    days.push(...SERVICE_DAYS.slice(start, end + 1))
  }
  return days
}

/** The windows a text names, in the order written. */
const windowsOf = (text: string) => [...text.matchAll(EACH_WINDOW)].map((match) => ({ opensAt: pad(match[1]!, match[2]!), closesAt: pad(match[3]!, match[4]!) }))

const HOURS_LINE = "give the days, then their hours and nothing else, such as Mon–Fri 10:00–18:00 or Sat 09:00–12:00, 13:00–17:00"

/** The weekly hours a text names, or why it cannot be taken. */
export function weeklyHoursOf(text: string): WeeklyWindow[] | TextRefusal {
  const hours: WeeklyWindow[] = []
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim()
    if (line === "") continue
    const at = line.search(FIRST_TIME)
    const windows = line.slice(Math.max(at, 0)).trim()
    if (at <= 0 || !WINDOWS_ONLY.test(windows)) return { message: `Line ${index + 1}: ${HOURS_LINE}` }
    const days = daysOf(line.slice(0, at), index + 1)
    if ("message" in days) return days
    for (const weekday of days) for (const window of windowsOf(windows)) hours.push({ weekday, ...window })
  }
  const [issue] = hoursIssues(hours)
  return issue === undefined ? hours : { message: issue }
}

/** The weekly hours as the form shows them: a line per run of days with the same windows, in the week's order. */
export function weeklyHoursText(hours: readonly WeeklyWindow[]): string {
  const windowsByDay = new Map<ServiceDay, string>()
  for (const day of SERVICE_DAYS) {
    const windows = hours
      .filter((window) => window.weekday === day)
      .sort((a, b) => a.opensAt.localeCompare(b.opensAt))
      .map((window) => `${window.opensAt}–${window.closesAt}`)
    if (windows.length > 0) windowsByDay.set(day, windows.join(", "))
  }
  const lines: { days: ServiceDay[]; windows: string }[] = []
  for (const [day, windows] of windowsByDay) {
    const same = lines.find((line) => line.windows === windows)
    if (same !== undefined) same.days.push(day)
    else lines.push({ days: [day], windows })
  }
  return lines.map((line) => `${serviceDaysRangeLabel(line.days)} ${line.windows}`).join("\n")
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})\b/
const ONE_WINDOW = new RegExp(String.raw`^${WINDOW}`)

/** The exceptions a text names, or why it cannot be taken. */
export function exceptionsOf(text: string): OpeningException[] | TextRefusal {
  const exceptions: OpeningException[] = []
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim()
    if (line === "") continue
    const dated = DATE.exec(line)
    if (dated === null) return { message: `Line ${index + 1}: begin with the date, such as 2026-12-24, then closed or the hours` }
    const date = dated[0]
    if (!isIsoDate(date)) return { message: `Line ${index + 1}: ${date} is not a date` }
    const rest = line.slice(date.length).trim()
    const closed = /^closed\b/i.exec(rest)
    const window = closed === null ? ONE_WINDOW.exec(rest) : null
    if (closed === null && window === null) return { message: `Line ${index + 1}: after the date, write closed or the hours, such as 09:00–12:00` }
    const note = rest.slice((closed ?? window)![0].length).trim()
    // An exception has one window; a second time on the line is a window it cannot hold, never a note residents read.
    if (note.startsWith(",") || FIRST_TIME.test(note)) return { message: `Line ${index + 1}: an exception is closed or one window, such as 09:00–12:00, then its note` }
    exceptions.push(
      window === null
        ? { date, opensAt: null, closesAt: null, note: note === "" ? null : note }
        : { date, opensAt: pad(window[1]!, window[2]!), closesAt: pad(window[3]!, window[4]!), note: note === "" ? null : note },
    )
  }
  const [issue] = exceptionIssues(exceptions)
  return issue === undefined ? exceptions : { message: issue }
}

/** The exceptions as the form shows them: a line a date, in date order. */
export function exceptionsText(exceptions: readonly OpeningException[]): string {
  return [...exceptions]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((exception) => [exception.date, exception.opensAt === null || exception.closesAt === null ? "closed" : `${exception.opensAt}–${exception.closesAt}`, exception.note].filter((part) => part !== null && part !== "").join(" "))
    .join("\n")
}

/**
 * The exceptions a save keeps, from `today` on: one the point already held
 * (`held`, the dates it was read with) is history once its day has passed and
 * dropped; one typed for a day gone by is refused, never quietly lost.
 */
export function exceptionsToSave(exceptions: readonly OpeningException[], today: string, held: ReadonlySet<string>): OpeningException[] | TextRefusal {
  const typedPast = exceptions.find((exception) => exception.date < today && !held.has(exception.date))
  if (typedPast !== undefined) return { message: `${typedPast.date} has gone by: an exception is for today or a day ahead` }
  return exceptions.filter((exception) => exception.date >= today)
}
