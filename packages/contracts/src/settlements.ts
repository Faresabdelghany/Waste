// The Settlement on the wire (Issue #112): "the period calculation and record
// of amounts due to or from a service provider" (CONTEXT.md). The record is
// the row that owns the lines: an assignment's, over a period — the one
// effective-dated resource whose end is required (`validTo: IsoDate`, not
// nullable, `A_PERIOD_ENDS`), since a settlement without an end is not a
// period — with a status its period cannot say (open, calculated, closed) and
// the stamps the status carries, the project's currency, and the
// calculation's totals, frozen at close by the lines standing still. The
// calculation is `SettlementLine`s: one Billable Event of the period served
// under the assignment, priced with the provider price valid on its service
// date, or unpriced — the price, the unit price and the net null together —
// when no price of the assignment covers the product on the day, which blocks
// `close`. No VAT: a settlement is a calculation between two businesses, and
// the provider's invoice to the company is the provider's document. The
// history is `SettlementEvent`, a ledger row per `calculate`, `close` and
// `reopen` carrying the snapshot after it and, on a reopening, its reason.
//
// `POST /settlements` opens one for an assignment over a period; `calculate`
// and `close` say nothing (the `AlertAcknowledge` shape: a body with a member
// is refused); `reopen` gives its reason, which the history keeps. The
// machine is the domain's (@waste/domain/finance/transitions); a command
// already done answers 200 without a write. A Service Provider's manager
// reads its own settlements and their lines through the list, bounded by the
// route.
import { IsoDate, IsoDateTime } from "./dates"
import { SettlementEventKind, SettlementStatus } from "./finance"
import { Id } from "./ids"
import { Currency } from "./organisation"
import { PageRequest } from "./pagination"
import { ProjectScopedListQuery } from "./queries"
import { Minor, NonNegativeMinor, PositiveInt, recorded, stamped } from "./resource"
import { Paragraph } from "./text"
import { endsAfterItStarts, validityOrdered } from "./validity"
import * as z from "zod"

/** What a settlement without an end is told: it is a period. */
export const A_PERIOD_ENDS = "A settlement settles a period, so validTo is the first day after it and is given"

/** The end of a settlement's period, required: the sentence for a missing one, zod's own for a malformed day. */
const SettlementEnd = z.iso.date({ error: (issue) => (issue.input === undefined || issue.input === null ? A_PERIOD_ENDS : undefined) })

/** A settlement's fields, spelled once for the two resources that carry them; each refines `validityOrdered` again, since spreading takes the fields and not the rule. */
const settlementFields = {
  ...stamped,
  projectId: Id,
  /** Whose period it settles; the provider and the area through it. */
  serviceAreaAssignmentId: Id,
  status: SettlementStatus,
  /** The project's. */
  currency: Currency,
  calculatedAt: IsoDateTime.nullable(),
  closedAt: IsoDateTime.nullable(),
  closedBy: Id.nullable(),
  /** The calculation's totals; frozen at close. */
  lineCount: z.int().min(0),
  netMinor: Minor,
  /** The first day of the period. */
  validFrom: IsoDate,
  /** The first day after it; required, the one effective-dated resource whose end is. */
  validTo: SettlementEnd,
}

export const Settlement = z.object(settlementFields).refine(validityOrdered, endsAfterItStarts)
export type Settlement = z.infer<typeof Settlement>

/** What a line priced by half is told. */
export const PRICED_TOGETHER = "A line carries its price, its unit price and its net together or none of them"
const pricedTogether = { message: PRICED_TOGETHER, path: ["serviceProviderPriceId"] }

/** The three nullable columns are null together or none of them. */
export const pricedWhole = (line: { serviceProviderPriceId: string | null; unitPriceMinor: number | null; netMinor: number | null }): boolean =>
  (line.serviceProviderPriceId === null) === (line.netMinor === null) && (line.netMinor === null) === (line.unitPriceMinor === null)

export const SettlementLine = z
  .object({
    ...stamped,
    settlementId: Id,
    billableEventId: Id,
    /** The provider price valid on the event's service date; null when none covers the product on the day, which blocks close. */
    serviceProviderPriceId: Id.nullable(),
    quantity: PositiveInt,
    unitPriceMinor: NonNegativeMinor.nullable(),
    /** Negative on a reversal's line. */
    netMinor: Minor.nullable(),
  })
  .refine(pricedWhole, pricedTogether)
export type SettlementLine = z.infer<typeof SettlementLine>

/** One row of a settlement's history: what was done, the status and the totals after it, the reason of a reopening, and who did it. */
export const SettlementEvent = z.object({
  ...recorded,
  settlementId: Id,
  kind: SettlementEventKind,
  /** The settlement's status after the event. */
  status: SettlementStatus,
  lineCount: z.int().min(0),
  netMinor: Minor,
  /** On a reopening: why. */
  reason: Paragraph.nullable(),
  recordedBy: Id,
})
export type SettlementEvent = z.infer<typeof SettlementEvent>

/** A settlement with its lines, by event. */
export const SettlementDetail = z
  .object({
    ...settlementFields,
    lines: z.array(SettlementLine),
  })
  .refine(validityOrdered, endsAfterItStarts)
export type SettlementDetail = z.infer<typeof SettlementDetail>

/** `POST /settlements`: the assignment and the period, both days given; the project is the assignment's and the currency the project's. */
export const SettlementCreate = z
  .strictObject({
    serviceAreaAssignmentId: Id,
    validFrom: IsoDate,
    validTo: SettlementEnd,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type SettlementCreate = z.infer<typeof SettlementCreate>

/** `POST /settlements/:id/calculate`: nothing to say; a body with a member is refused. */
export const SettlementCalculate = z.strictObject({})
export type SettlementCalculate = z.infer<typeof SettlementCalculate>

/** `POST /settlements/:id/close`: likewise. */
export const SettlementClose = z.strictObject({})
export type SettlementClose = z.infer<typeof SettlementClose>

/** `POST /settlements/:id/reopen`: why, which the history keeps. */
export const SettlementReopen = z.strictObject({ reason: Paragraph })
export type SettlementReopen = z.infer<typeof SettlementReopen>

/** A page of settlements: one project's, one assignment's, one provider's, of one status, covering a day. */
export const SettlementListQuery = ProjectScopedListQuery.extend({
  serviceAreaAssignmentId: Id.optional(),
  /** The settlements of every assignment naming this provider. */
  serviceProviderId: Id.optional(),
  status: SettlementStatus.optional(),
  /** The day the period is read against. */
  validOn: IsoDate.optional(),
})
export type SettlementListQuery = z.infer<typeof SettlementListQuery>

/** A page of one settlement's history: by kind. */
export const SettlementEventListQuery = PageRequest.extend({
  kind: SettlementEventKind.optional(),
})
export type SettlementEventListQuery = z.infer<typeof SettlementEventListQuery>
