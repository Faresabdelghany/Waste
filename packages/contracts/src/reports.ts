// The reports on the wire (#292: #291's slice 26, "KPI reads", and #290's
// O12, "tonnage reporting"): read-only aggregates over rows that exist, for
// the Dashboard and the Improve workspace. Nothing here is stored — a report
// counts the dated Routes and their Pickups, the Tickets, the Invoices and
// their lines, the Unloads with their weight reviews and the pickups' weight
// proofs at the moment it is asked — and what each count means is the
// domain's (@waste/domain/insight/readings), so a client reads these fields
// by the same rules the API counted them by.
//
// Four reads, each over a window of days and the caller's projects, each
// under two grants: the Improve module it is read in, and the module whose
// rows it counts, since a total is the content of the rows it totals and a
// role refused the rows is refused their count:
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
//   GET /reports/revenue  — what was invoiced: the documents issued over the
//                           window by currency, per interval and per product.
//                           `improve.analytics` and `commercial.invoices`.
//   GET /reports/tonnage  — what was tipped: the unloads' net weights by
//                           project, fraction, station and interval, split by
//                           weight review, and the weights recorded at the
//                           pickups. `improve.analytics` and
//                           `route-studio.weights`.
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
// A day is the project's: a route's, a pickup's and a pickup's weight's is
// the route's operating date, an invoice's its `issuedOn`, and a ticket's
// opening and closing and an unload's the instant rendered in
// `project.timezone`. The days a report reads begin at `REPORT_FIRST_DAY`.
// A rate is 0..1, or null where there was nothing to divide by — a rate of
// nothing is not zero (`rate`).
import { REPORT_INTERVALS } from "@waste/domain/insight/vocabulary"
import * as z from "zod"

import { IsoDate, IsoDateTime } from "./dates"
import { PickupReason } from "./execution"
import { Id } from "./ids"
import { Currency } from "./organisation"
import { dayWindowIsOrdered, dayWindowOrdered } from "./queries"
import { TicketKind } from "./resolution"
import { Minor, NonNegativeInt } from "./resource"

/** How a report's series cuts its window: by the day, the ISO week or the calendar month. */
export const ReportInterval = z.enum(REPORT_INTERVALS)
export type ReportInterval = z.infer<typeof ReportInterval>

/** The longest window a report reads: a year, a leap year's included. */
export const REPORT_WINDOW_MAX_DAYS = 366

/** What a window longer than that is told, at `to`. */
export const REPORT_WINDOW_TOO_LONG = `A report's window is at most ${REPORT_WINDOW_MAX_DAYS} days; ask for a year at a time`

/**
 * Whether a window spans at most `REPORT_WINDOW_MAX_DAYS`, both ends
 * inclusive. A backwards window is `dayWindowOrdered`'s to refuse and a day
 * that is not one `IsoDate`'s, so a window this cannot measure passes here
 * rather than being told a second, wrong sentence.
 */
export const reportWindowFits = (window: { from: string; to: string }): boolean => {
  const span = Date.parse(window.to) - Date.parse(window.from)
  return Number.isNaN(span) || span / 86_400_000 + 1 <= REPORT_WINDOW_MAX_DAYS
}
const reportWindowFitsAt = { message: REPORT_WINDOW_TOO_LONG, path: ["to"] }

/** The first day a report reads: Postgres has no year 0, and nothing this system records is older. */
export const REPORT_FIRST_DAY = "2000-01-01"

/** What a day before it is told, at its field. */
export const REPORT_DAY_TOO_EARLY = `A report reads days from ${REPORT_FIRST_DAY} on`

/** A day of a report's window: a calendar day, from `REPORT_FIRST_DAY` on; comparing two `YYYY-MM-DD` strings compares the days. */
const ReportDay = IsoDate.refine((day) => day >= REPORT_FIRST_DAY, REPORT_DAY_TOO_EARLY)

/** The parameters every report takes; each query restates the two rules on its window, since spreading takes the fields and not the rules. */
const windowFields = {
  /** One of the caller's projects; absent, every project they work in. */
  projectId: Id.optional(),
  /** The first day of the window, inclusive. */
  from: ReportDay,
  /** The last day, inclusive. */
  to: ReportDay,
  interval: ReportInterval.default("day").describe("How the series cuts the window; `day` when absent."),
}

/** `GET /reports/service`: one project's or all of them, one fraction's pickups, one scheme's routes. */
export const ServiceReportQuery = z
  .strictObject({
    ...windowFields,
    /** The pickups of one fraction, and the routes that hold one. */
    wasteFractionId: Id.optional(),
    routeSchemeId: Id.optional(),
  })
  .refine(dayWindowOrdered, dayWindowIsOrdered)
  .refine(reportWindowFits, reportWindowFitsAt)
export type ServiceReportQuery = z.infer<typeof ServiceReportQuery>

/** `GET /reports/tickets`. */
export const TicketReportQuery = z.strictObject(windowFields).refine(dayWindowOrdered, dayWindowIsOrdered).refine(reportWindowFits, reportWindowFitsAt)
export type TicketReportQuery = z.infer<typeof TicketReportQuery>

/** `GET /reports/revenue`. */
export const RevenueReportQuery = z.strictObject(windowFields).refine(dayWindowOrdered, dayWindowIsOrdered).refine(reportWindowFits, reportWindowFitsAt)
export type RevenueReportQuery = z.infer<typeof RevenueReportQuery>

/** `GET /reports/tonnage`: one fraction's weights, one station's unloads. */
export const TonnageReportQuery = z
  .strictObject({
    ...windowFields,
    wasteFractionId: Id.optional(),
    /** The unloads tipped at one station; a pickup's weight is weighed at the kerb and is not narrowed by it. */
    unloadingStationId: Id.optional(),
  })
  .refine(dayWindowOrdered, dayWindowIsOrdered)
  .refine(reportWindowFits, reportWindowFitsAt)
export type TonnageReportQuery = z.infer<typeof TonnageReportQuery>

/** A count of rows: zero or more. */
const Count = NonNegativeInt

/** A rate, 0..1, or null where there was nothing to divide by. */
export const Rate = z.number().min(0).max(1).nullable()
export type Rate = z.infer<typeof Rate>

/** Whole kilograms, summed. */
const Kilograms = NonNegativeInt

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

/** The missed pickups of one reason, skipped and failed. */
export const MissedReason = z.object({ reason: PickupReason, skipped: Count, failed: Count })
export type MissedReason = z.infer<typeof MissedReason>

/** The three rates: collected and missed over the pickups with an outcome, on time over the routes judged. */
export const ServiceRates = z.object({ collection: Rate, missed: Rate, onTime: Rate })
export type ServiceRates = z.infer<typeof ServiceRates>

/** One interval of the series: its routes and their pickups. Every interval of the window is present, a quiet one at zero. */
export const ServiceInterval = z.object({ ...intervalFields, routes: RouteCounts, pickups: PickupStandings })
export type ServiceInterval = z.infer<typeof ServiceInterval>

/** One Route Scheme's routes and their pickups over the window, with its rates. */
export const ServiceScheme = z.object({
  routeSchemeId: Id,
  name: z.string(),
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
  /** The schemes with a route in the window, by name in English collation. */
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

/** What a set of documents of one currency comes to: how many invoices and credit notes, and their totals in minor units, a credit note's negative. */
const documentTotals = {
  currency: Currency,
  invoices: Count,
  creditNotes: Count,
  netMinor: Minor,
  vatMinor: Minor,
  grossMinor: Minor,
}

/** One currency's documents issued over the window. */
export const RevenueTotals = z.object(documentTotals)
export type RevenueTotals = z.infer<typeof RevenueTotals>

/** One interval's documents of one currency; an interval without any is absent. */
export const RevenueInterval = z.object({ ...intervalFields, ...documentTotals })
export type RevenueInterval = z.infer<typeof RevenueInterval>

/** One product's lines of one currency: the quantity, a credited or reversed line's counted against it, and the net. */
export const RevenueProduct = z.object({ productId: Id, name: z.string(), currency: Currency, quantity: z.int(), netMinor: Minor })
export type RevenueProduct = z.infer<typeof RevenueProduct>

/** `GET /reports/revenue`. */
export const RevenueReport = z.object({
  window: ReportWindow,
  /** By currency, in code order: amounts of two currencies are never summed. */
  currencies: z.array(RevenueTotals),
  intervals: z.array(RevenueInterval),
  /** By currency, then the net, largest first. */
  products: z.array(RevenueProduct),
})
export type RevenueReport = z.infer<typeof RevenueReport>

/** Net weights by weight review: what counts (approved and captured, apart), and what was rejected beside it. */
const weighedFields = {
  /** Approved and captured: the tonnage. */
  netKg: Kilograms,
  approvedKg: Kilograms,
  /** Nobody has reviewed it yet. */
  capturedKg: Kilograms,
  /** The unloads counted in `netKg`. */
  unloads: Count,
  rejectedKg: Kilograms,
  rejectedUnloads: Count,
}

/** One project's unloads of one fraction at one station over one interval; a combination without any is absent. */
export const TonnageRow = z.object({
  ...intervalFields,
  projectId: Id,
  wasteFractionId: Id,
  wasteFractionName: z.string(),
  unloadingStationId: Id,
  unloadingStationName: z.string(),
  ...weighedFields,
})
export type TonnageRow = z.infer<typeof TonnageRow>

/** One project's pickup weights of one fraction over one interval: each collected pickup's latest reading, on its route's operating day. */
export const PickupWeightRow = z.object({
  ...intervalFields,
  projectId: Id,
  wasteFractionId: Id,
  wasteFractionName: z.string(),
  weightKg: Kilograms,
  pickups: Count,
})
export type PickupWeightRow = z.infer<typeof PickupWeightRow>

/** `GET /reports/tonnage`. */
export const TonnageReport = z.object({
  window: ReportWindow,
  totals: z.object({ ...weighedFields, pickupWeightKg: Kilograms, weighedPickups: Count }),
  /** By interval, then project, fraction name and station name in English collation. */
  unloads: z.array(TonnageRow),
  /** By interval, then project and fraction name. */
  pickupWeights: z.array(PickupWeightRow),
})
export type TonnageReport = z.infer<typeof TonnageReport>
