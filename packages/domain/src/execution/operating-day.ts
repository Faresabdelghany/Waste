// The day a dated route runs, judged against its project's calendar (O5 of
// #290): what the office's `reschedule` asks before it moves a route's
// operating date.
//
// The domain's calendar rule is generation's (route-schemes/occurrences.ts),
// read for one day: a holiday on the project's list is a day the scheme
// collects on only under the `collect` policy, and a weekend day matters only
// where the scheme does not serve that weekday — "a scheme whose service days
// include Saturday collects on Saturdays". So a day is non-working for a
// route when it is a holiday its scheme does not collect on, or a weekend day
// its scheme does not serve; the office's ad-hoc route (#111) has no scheme,
// and every holiday and weekend day is non-working for it.
//
// A non-working day is never refused outright: the office may run a route on
// one — a Saturday catch-up, a collection kept on a holiday — but only
// knowingly. The command is refused with the sentence below until its body
// says it runs on a non-working day: the refusal is the warning, naming the
// day for what it is, and the web's Reschedule dialog carries the box that
// says the move is meant, so the person ticks it and sends again.
//
// Pure: the calendar is the occurrence rule's `SchemeCalendar`, which the API
// reads from the project's weekend and its holiday list's collection
// calendars.

import type { HolidayPolicy } from "../planning/vocabulary"
import { formatOccurrenceShortDate, type SchemeCalendar } from "../route-schemes/occurrences"
import { serviceDayOf, SERVICE_DAY_LABELS, type ServiceDay } from "../route-schemes/recurrence"

/** What a generated route's scheme says of a holiday and of its weekdays; null for the office's ad-hoc route, which has no scheme. */
export type OperatingDayScheme = { holidayPolicy: HolidayPolicy; serviceDays: readonly ServiceDay[] }

/** A day to a route by its project's calendar: a working one, or a holiday or a weekend day it does not run on. */
export type OperatingDayReading = { kind: "working" } | { kind: "holiday"; name: string } | { kind: "weekend"; weekday: ServiceDay }

/** A day the route would not run on by its calendar. */
export type NonWorkingDay = Exclude<OperatingDayReading, { kind: "working" }>

/**
 * What `day` is to a route: a holiday of the project's list, unless the
 * route's scheme collects on holidays; else a weekend day of the project,
 * unless the scheme serves that weekday; else a working day.
 */
export function operatingDayReading(calendar: SchemeCalendar, day: string, scheme: OperatingDayScheme | null): OperatingDayReading {
  const holiday = calendar.holidays.get(day)
  if (holiday !== undefined && scheme?.holidayPolicy !== "collect") return { kind: "holiday", name: holiday }
  const weekday = serviceDayOf(day)
  if (calendar.weekend.includes(weekday) && !(scheme?.serviceDays.includes(weekday) ?? false)) return { kind: "weekend", weekday }
  return { kind: "working" }
}

/** The day said for what it is: "Fri 25 Dec is Christmas Day, a holiday on the project's calendar", "Sat 10 Oct is a Saturday of the project's weekend". */
export function nonWorkingDay(day: string, reading: NonWorkingDay): string {
  const shown = formatOccurrenceShortDate(day)
  return reading.kind === "holiday" ? `${shown} is ${reading.name}, a holiday on the project's calendar` : `${shown} is a ${SERVICE_DAY_LABELS[reading.weekday]} of the project's weekend`
}

/** The reschedule's refusal until the move says it runs on a non-working day: the day for what it is, then what to do. */
export const confirmNonWorkingDay = (label: string, day: string, reading: NonWorkingDay): string => `${nonWorkingDay(day, reading)}; confirm the move to run route ${label} on a non-working day`
