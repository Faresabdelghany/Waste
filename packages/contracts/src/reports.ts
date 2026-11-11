// The reports on the wire (#292: #291's slice 26, "KPI reads"): read-only
// aggregates over rows that exist, for the Dashboard. Nothing here is stored
// — a report counts the dated Routes and their Pickups and the Tickets at the
// moment it is asked — and what each count means is the domain's
// (@waste/domain/insight/readings), so a client reads these fields by the
// same rules the API counted them by.
//
// Two reads, each over a window of days and the caller's projects, each
// under two grants: Improve's Performance, the module it is read in, and the
// module whose rows it counts, since a total is the content of the rows it
// totals and a role refused the rows is refused their count:
//
//   GET /reports/service  — the routes that ran and whether they started on
//                           time, and their pickups: collected, missed (by
//                           reason), open and withdrawn, with the collection
//                           and missed rates; per interval and per Route
//                           Scheme. `improve.performance` and
//                           `route-studio.routes`.
//   GET /reports/tickets  — tickets opened and closed over the window, closed
//                           by their due time or after it, and the open ones
//                           now, overdue among them. `improve.performance`
//                           and `operate.tickets`.
//
// The window is two days, `from` and `to`, both inclusive, as the route and
// pickup lists take theirs (`dayWindowOrdered`), and at most
// `REPORT_WINDOW_MAX_DAYS` long, so a report is one bounded answer and never
// a page. `interval` cuts it into the series (`intervalsOver`, the domain's:
// days, ISO weeks, calendar months, the first and last clipped to the
// window), and `projectId` narrows it to one of the caller's projects —
// absent, the report spans every project the caller works in. Every query is
// strict, so a parameter this API does not read is refused by name rather
// than silently ignored: a misspelt filter would otherwise answer the whole
// company's numbers as if they were one fraction's.
//
// A day is the project's: a route's and a pickup's is the route's operating
// date, and a ticket's opening and closing the instant rendered in
// `project.timezone`. The days a report reads begin at `REPORT_FIRST_DAY`.
// A rate is 0..1, or null where there was nothing to divide by — a rate of
// nothing is not zero (`rate`).
import { REPORT_DAY_TOO_EARLY, REPORT_FIRST_DAY, REPORT_WINDOW_MAX_DAYS, REPORT_WINDOW_TOO_LONG } from "@waste/domain/insight/reports"
import { REPORT_INTERVALS } from "@waste/domain/insight/vocabulary"
import * as z from "zod"

import { IsoDate, IsoDateTime } from "./dates"
import { PickupReason } from "./execution"
import { Id } from "./ids"
import { requiredDayWindow } from "./queries"
import { TicketKind } from "./resolution"
import { NonNegativeTotal } from "./resource"

/** How a report's series cuts its window: by the day, the ISO week or the calendar month. */
export const ReportInterval = z.enum(REPORT_INTERVALS)
export type ReportInterval = z.infer<typeof ReportInterval>

/** A day of a report's window: a calendar day, from `REPORT_FIRST_DAY` on; comparing two `YYYY-MM-DD` strings compares the days. */
export const ReportDay = IsoDate.refine((day) => day >= REPORT_FIRST_DAY, REPORT_DAY_TOO_EARLY)

/** The window every report reads, its two rules with it: one of the caller's projects, or every project they work in where it is absent, over `from` to `to`. */
const reportWindow = requiredDayWindow(z.strictObject({ projectId: Id.optional() }), { day: ReportDay, maxDays: { days: REPORT_WINDOW_MAX_DAYS, tooLong: REPORT_WINDOW_TOO_LONG } })

const interval = ReportInterval.default("day").describe("How the series cuts the window; `day` when absent.")

/** `GET /reports/service`: one project's or all of them, one fraction's pickups, one scheme's routes. */
export const ServiceReportQuery = reportWindow.safeExtend({
  interval,
  /** The pickups of one fraction, and the routes that hold one. */
  wasteFractionId: Id.optional(),
  routeSchemeId: Id.optional(),
})
export type ServiceReportQuery = z.infer<typeof ServiceReportQuery>

/** `GET /reports/tickets`. */
export const TicketReportQuery = reportWindow.safeExtend({ interval })
export type TicketReportQuery = z.infer<typeof TicketReportQuery>

/** A count of rows: zero or more, summed and never written, so with no `integer` bound. */
const Count = NonNegativeTotal

/** A rate, 0..1, or null where there was nothing to divide by. */
export const Rate = z.number().min(0).max(1).nullable()
export type Rate = z.infer<typeof Rate>

/** The window a report answers, as it read the query: the interval as defaulted, the project as asked or null for every one of the caller's. */
export const ReportWindow = z.object({
  projectId: Id.nullable(),
  from: IsoDate,
  to: IsoDate,
  interval: ReportInterval,
})
export type ReportWindow = z.infer<typeof ReportWindow>

/** An interval of a series: its first and last day, both inclusive and inside the window. */
const intervalFields = { from: IsoDate, to: IsoDate }

/** The routes operating in the window, a regeneration's cancellations left out: by status, whether they went out, and whether they went out on time. */
export const RouteCounts = z.object({
  total: Count,
  planned: Count,
  ready: Count,
  active: Count,
  completed: Count,
  cancelled: Count,
  /** Went out: a session started them. */
  started: Count,
  /** Started no later than the planned start, plus the domain's grace, on the project's clock. */
  onTime: Count,
  late: Count,
  /** Started with no planned start time to judge by. */
  unjudged: Count,
})
export type RouteCounts = z.infer<typeof RouteCounts>

/** The pickups of those routes by their standing (@waste/domain/insight/readings): `due` is completed, missed and open; withdrawn pickups are counted apart and in nothing else. */
export const PickupStandings = z.object({
  due: Count,
  completed: Count,
  /** Skipped and failed, together. */
  missed: Count,
  skipped: Count,
  failed: Count,
  /** Still planned. */
  open: Count,
  /** Taken off by a regeneration or removed by the dispatcher. */
  withdrawn: Count,
})
export type PickupStandings = z.infer<typeof PickupStandings>

export const MissedReason = z.object({ reason: PickupReason, skipped: Count, failed: Count })
export type MissedReason = z.infer<typeof MissedReason>

/** The three rates: collected and missed over the pickups with an outcome, on time over the routes judged. */
export const ServiceRates = z.object({ collection: Rate, missed: Rate, onTime: Rate })
export type ServiceRates = z.infer<typeof ServiceRates>

/** One interval of the series: its routes and their pickups. Every interval of the window is present, a quiet one at zero. */
export const ServiceInterval = z.object({ ...intervalFields, routes: RouteCounts, pickups: PickupStandings })
export type ServiceInterval = z.infer<typeof ServiceInterval>

/** One Route Scheme's routes and their pickups over the window, with its rates; or one project's ad-hoc routes, the office's own with no scheme (#111), `routeSchemeId` and `name` null. */
export const ServiceScheme = z.object({
  routeSchemeId: Id.nullable(),
  name: z.string().nullable(),
  projectId: Id,
  routes: RouteCounts,
  pickups: PickupStandings,
  rates: ServiceRates,
})
export type ServiceScheme = z.infer<typeof ServiceScheme>

/** `GET /reports/service`. */
export const ServiceReport = z.object({
  window: ReportWindow,
  routes: RouteCounts,
  pickups: PickupStandings,
  rates: ServiceRates,
  /** The missed pickups by reason, the reasons with any, in the vocabulary's order. */
  missedByReason: z.array(MissedReason),
  intervals: z.array(ServiceInterval),
  /** The schemes with a route in the window, by name in English collation, then each project's ad-hoc routes. */
  schemes: z.array(ServiceScheme),
})
export type ServiceReport = z.infer<typeof ServiceReport>

/** One kind's tickets: opened and closed over the window, and open now. */
export const TicketKindCounts = z.object({ kind: TicketKind, opened: Count, closed: Count, open: Count })
export type TicketKindCounts = z.infer<typeof TicketKindCounts>

/** `GET /reports/tickets`. */
export const TicketReport = z.object({
  window: ReportWindow,
  /** The request's instant: what "open now" and "overdue" were read at. */
  asOf: IsoDateTime,
  /** Opened over the window: made, by the project's clock, on one of its days — when the ticket was opened, not its `occurredAt`, which the ticket list's window reads. */
  opened: Count,
  /** Closed over the window, completed or rejected. */
  closed: Count,
  completed: Count,
  rejected: Count,
  /** Of the closed, those that had a due time, and those closed by it. */
  closedWithDue: Count,
  closedWithinDue: Count,
  /** Open now, whatever the window. */
  open: Count,
  /** Open now and past their due time. */
  overdue: Count,
  /** The routes the open tickets name, each once. */
  openOnRoutes: Count,
  rates: z.object({ closedWithinDue: Rate }),
  /** The kinds with any ticket opened, closed or open, in the vocabulary's order. */
  byKind: z.array(TicketKindCounts),
  /** Every interval of the window, a quiet one at zero. */
  intervals: z.array(z.object({ ...intervalFields, opened: Count, closed: Count })),
})
export type TicketReport = z.infer<typeof TicketReport>
