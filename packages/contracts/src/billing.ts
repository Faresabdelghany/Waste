// The Billing Run on the wire (Issue #112): "a controlled batch that converts
// eligible billable events into invoices" (CONTEXT.md). A run is the record
// of one batch — the service dates it selected, both inclusive, its status,
// who asked for it, when it completed, the counts and the totals as
// completed, over every currency the run touched summed as integers (a report
// reads the invoices for a per-currency figure) — frozen once `completed`,
// which part A writes in the transaction that made its invoices. Its
// exclusions are the payers the run found events for and invoiced nothing,
// one ledger row each with the reason, so no customer is silently skipped;
// `BillingRunDetail` carries them and the ids of the invoices it issued.
//
// `POST /billing-runs` takes the project and the period (`periodOrdered`:
// the last day comes on or after the first) and runs synchronously in the
// request; `POST /billing-runs/preview` takes the same body and answers
// `BillingRunPreview` — the counts, the totals per currency and the
// exclusions — writing nothing. There is no patch: a run is a record of what
// it did.
import { IsoDate, IsoDateTime } from "./dates"
import { BillingRunStatus, ExclusionReason } from "./finance"
import { Id } from "./ids"
import { Currency } from "./organisation"
import { dayWindowIsOrdered, dayWindowOrdered, ProjectScopedListQuery } from "./queries"
import { Minor, NonNegativeInt, PositiveInt, recorded, stamped } from "./resource"
import { Paragraph } from "./text"
import * as z from "zod"

/** What a period whose last day comes before its first is told, at the end, the bound a caller can move. */
export const PERIOD_ORDERED = "periodTo is the last day of the period, so it comes on or after periodFrom"
const periodIsOrdered = { message: PERIOD_ORDERED, path: ["periodTo"] }

/** Both days inclusive, so one day is a period; comparing two `YYYY-MM-DD` strings compares the days. */
export const periodOrdered = (period: { periodFrom: string; periodTo: string }): boolean => period.periodTo >= period.periodFrom

/** A count of what a run did: zero or more. */
const Count = NonNegativeInt

/** A run's fields, spelled once for the two resources that carry them; each refines `periodOrdered` again, since spreading takes the fields and not the rule. */
const billingRunFields = {
  ...stamped,
  projectId: Id,
  /** The service dates selected, both inclusive. */
  periodFrom: IsoDate,
  periodTo: IsoDate,
  status: BillingRunStatus,
  /** The caller; null for the worker's scheduled run. */
  requestedBy: Id.nullable(),
  completedAt: IsoDateTime.nullable(),
  eventCount: Count,
  invoiceCount: Count,
  excludedCustomerCount: Count,
  /** The totals as completed, over every currency summed as integers. */
  netMinor: Minor,
  vatMinor: Minor,
  note: Paragraph.nullable(),
}

export const BillingRun = z.object(billingRunFields).refine(periodOrdered, periodIsOrdered)
export type BillingRun = z.infer<typeof BillingRun>

/** One payer the run found events for and invoiced nothing, with the reason and how many events: a ledger row. */
export const BillingRunExclusion = z.object({
  ...recorded,
  billingRunId: Id,
  /** The payer. */
  customerId: Id,
  reason: ExclusionReason,
  eventCount: PositiveInt,
})
export type BillingRunExclusion = z.infer<typeof BillingRunExclusion>

/** A run with its exclusions and the ids of the invoices it issued. */
export const BillingRunDetail = z
  .object({
    ...billingRunFields,
    exclusions: z.array(BillingRunExclusion),
    invoiceIds: z.array(Id),
  })
  .refine(periodOrdered, periodIsOrdered)
export type BillingRunDetail = z.infer<typeof BillingRunDetail>

/** `POST /billing-runs` and `POST /billing-runs/preview`: the project and the period; the status, the counts and the totals are what the run finds. */
export const BillingRunCreate = z
  .strictObject({
    projectId: Id,
    periodFrom: IsoDate,
    periodTo: IsoDate,
    note: Paragraph.optional(),
  })
  .refine(periodOrdered, periodIsOrdered)
export type BillingRunCreate = z.infer<typeof BillingRunCreate>

/** What a preview answers: the counts, the totals per currency, and the payers a run would exclude. */
export const BillingRunPreview = z.object({
  eventCount: Count,
  invoiceCount: Count,
  totals: z.array(
    z.object({
      currency: Currency,
      netMinor: Minor,
      vatMinor: Minor,
    }),
  ),
  exclusions: z.array(
    z.object({
      customerId: Id,
      reason: ExclusionReason,
      eventCount: PositiveInt,
    }),
  ),
})
export type BillingRunPreview = z.infer<typeof BillingRunPreview>

/** A page of runs: one project's, of one status, over a window of `periodFrom`. */
export const BillingRunListQuery = ProjectScopedListQuery.extend({
  status: BillingRunStatus.optional(),
  /** The first day of the window over `periodFrom`, inclusive. */
  from: IsoDate.optional(),
  /** The last day, inclusive. */
  to: IsoDate.optional(),
}).refine(dayWindowOrdered, dayWindowIsOrdered)
export type BillingRunListQuery = z.infer<typeof BillingRunListQuery>
