// The resolver (Issue #112 §3): `RESOLUTION_RULE` as code, on the server.
// "The row matching the most conditions wins. A negotiated row for the
// specific customer always wins. Remaining ties go to the row with the newest
// effective-from date." — the sentence apps/web/lib/commercial/price-model.ts
// states and its price-resolution.ts runs over the prototype's rows; this is
// the same sentence over the rows of one Price List valid on one day, with
// the third tie-break the prototype left to array order and a server cannot
// (§7.5): a tie on the score and on `validFrom` goes to the lower `id`, a
// lower UUIDv7 being the row made first. The web keeps its copy until the
// adapter (#81) retires it; its test cases are ported into this module's, so
// the two resolvers agree until then.
//
// A row is eligible when it is valid on the day and every condition it names
// is met by the input — `planningAreaId` by the route's scheme's planning
// area (the prototype's Zone), `customerKind` by the agreement's customer's
// kind (its Customer type, the Registry's `CUSTOMER_KINDS`), `containerTypeId`
// by the pickup's container's type, `wasteFractionId` by the pickup's fraction
// on the day — and a row naming a `customerId` is eligible for that customer
// alone ("Negotiated for Østerbro Housing Association, not this customer").
// Its score is the number of conditions it names plus one hundred for a
// negotiated row; the highest wins. A row's reason for losing is one of the
// prototype's sentences ("Requires container type 660 L", "Waste fraction is
// Glass, not Residual", "Not effective until 2027-01-01", "Expired on
// 2026-12-31"), so the read is explainable in the glossary's sense. The
// sentences name what a person reads, so the caller may hand in `labels` —
// how an id of each kind is spelled — and an id stands where it gives none.
//
// The domain never reads a table: the route hands it the rows valid on the
// day (`GET /price-lists/:id/resolve`, and `priceDraft` for the consumer and
// the manual event), and `priceOccurrence` beside the resolver is the whole
// pricing of one occurrence — which list, whether the agreement is signed,
// the winning row, the product's VAT — answering a price or the one block
// reason that stands in the way, in the order `reprice` mends them
// (`agreement-draft`, `no-price-list`, `no-price-row`, `no-vat-rate`). Which
// list an agreement is priced under is `priceListIdFor`: the agreement's own
// when it names one, the project's default otherwise, none being
// `no-price-list`. Money is minor units and the VAT rounds as money.ts says.
import type { AgreementStatus, CustomerKind } from "../registry/vocabulary"
import { vatOf } from "./money"
import type { BlockReason } from "./vocabulary"

/** The one spelling of how a price is resolved (spec §4.4), verbatim from the web's price-model.ts. */
export const RESOLUTION_RULE = "The row matching the most conditions wins. A negotiated row for the specific customer always wins. Remaining ties go to the row with the newest effective-from date."

/** The four conditions a row may name beside a customer, in the order they are judged and spelled. */
export const PRICE_CONDITIONS = ["planningAreaId", "customerKind", "containerTypeId", "wasteFractionId"] as const
export type PriceCondition = (typeof PRICE_CONDITIONS)[number]

/** A row of a Price List as the resolver reads it: the price, the conditions, the period. A wire `PriceListRow` is one. */
export type PriceRow = {
  id: string
  unitPriceMinor: number
  /** The prototype's Zone: matched against the route's scheme's planning area. */
  planningAreaId: string | null
  /** The prototype's Customer type: matched against the agreement's customer's kind. */
  customerKind: CustomerKind | null
  containerTypeId: string | null
  wasteFractionId: string | null
  /** The negotiated row: eligible for this customer alone, and always winning for them. */
  customerId: string | null
  /** `YYYY-MM-DD`, the first day in force. */
  validFrom: string
  /** `YYYY-MM-DD`, the first day out of force; null while it runs. */
  validTo: string | null
}

/** What the occurrence is: the day, and the values the rows' conditions are matched against, each null or absent where the occurrence has none. */
export type PriceInput = {
  /** `YYYY-MM-DD`, the day the price is resolved on: the pickup's service date. */
  on: string
  planningAreaId?: string | null
  customerKind?: CustomerKind | null
  containerTypeId?: string | null
  wasteFractionId?: string | null
  /** The agreement's customer; a negotiated row for another customer is not eligible. */
  customerId?: string | null
}

/** How an id of each kind is spelled in a sentence; an id stands where the caller gives no spelling. */
export type PriceLabels = Partial<Record<PriceCondition | "customerId", (id: string) => string>>

/** One row's verdict: eligible or not, why not, what it matched, its score, and whether it won. */
export type RowVerdict<Row extends PriceRow = PriceRow> = {
  row: Row
  eligible: boolean
  /** The prototype's sentence for a row that lost; null for an eligible row. */
  reason: string | null
  /** What the row matched, in the order judged: the negotiated customer, then each condition. */
  matched: string[]
  /** Conditions named plus one hundred for a negotiated row; -1 for a row that is not eligible. */
  score: number
  winner: boolean
}

/** Every verdict, the winner first, and the winner by itself or null when no row is eligible. */
export type PriceResolution<Row extends PriceRow = PriceRow> = {
  verdicts: RowVerdict<Row>[]
  winner: RowVerdict<Row> | null
}

/** How each condition reads in a sentence: "Waste fraction is Glass, not Residual". */
export const CONDITION_NAMES: Readonly<Record<PriceCondition, string>> = {
  planningAreaId: "Planning area",
  customerKind: "Customer kind",
  containerTypeId: "Container type",
  wasteFractionId: "Waste fraction",
}

/** The value of a condition spelled as a person reads it: the caller's label, or the value itself. */
const spelled = (labels: PriceLabels, condition: PriceCondition | "customerId", value: string): string => labels[condition]?.(value) ?? value

/** The sentences a row loses with, spelled once. */
export const notEffectiveUntil = (validFrom: string): string => `Not effective until ${validFrom}`
export const expiredOn = (validTo: string): string => `Expired on ${validTo}`
export const negotiatedForAnother = (customer: string): string => `Negotiated for ${customer}, not this customer`
export const requiresCondition = (condition: PriceCondition, required: string): string => `Requires ${CONDITION_NAMES[condition].toLowerCase()} ${required}`
export const conditionDiffers = (condition: PriceCondition, required: string, provided: string): string => `${CONDITION_NAMES[condition]} is ${required}, not ${provided}`

/** The score of an eligible row: the conditions it names, plus one hundred for a negotiated row. */
export const scoreOf = (row: PriceRow): number => (row.customerId === null ? 0 : 100) + PRICE_CONDITIONS.filter((condition) => row[condition] !== null).length

/** One row judged against the input on the day: the prototype's checks in the prototype's order — the customer, the period, then each condition. */
function judge<Row extends PriceRow>(row: Row, input: PriceInput, labels: PriceLabels): RowVerdict<Row> {
  const matched: string[] = []
  let reason: string | null = null
  if (row.customerId !== null) {
    if (input.customerId != null && input.customerId === row.customerId) matched.push(`Negotiated · ${spelled(labels, "customerId", row.customerId)}`)
    else reason = negotiatedForAnother(spelled(labels, "customerId", row.customerId))
  }
  // The period is half-open: the row is in force from `validFrom` and out of it from `validTo`.
  if (reason === null && row.validFrom > input.on) reason = notEffectiveUntil(row.validFrom)
  if (reason === null && row.validTo !== null && row.validTo <= input.on) reason = expiredOn(row.validTo)
  if (reason === null) {
    for (const condition of PRICE_CONDITIONS) {
      const required = row[condition]
      if (required === null) continue
      const provided = input[condition]
      if (provided == null) {
        reason = requiresCondition(condition, spelled(labels, condition, required))
        break
      }
      if (provided !== required) {
        reason = conditionDiffers(condition, spelled(labels, condition, required), spelled(labels, condition, provided))
        break
      }
      matched.push(`${CONDITION_NAMES[condition]} ${spelled(labels, condition, required)}`)
    }
  }
  const eligible = reason === null
  return { row, eligible, reason, matched, score: eligible ? scoreOf(row) : -1, winner: false }
}

/** Two ids in string order: for a UUIDv7, the order the rows were made in. */
const byId = (a: RowVerdict, b: RowVerdict): number => (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0)

/** The order the rule ranks eligible rows in — the score, then the later start, then the lower id, every tie decided — with the ineligible after them, by id, so a list of verdicts reads the same twice. */
export function compareVerdicts(a: RowVerdict, b: RowVerdict): number {
  if (a.eligible !== b.eligible) return a.eligible ? -1 : 1
  if (!a.eligible) return byId(a, b)
  if (a.score !== b.score) return b.score - a.score
  if (a.row.validFrom !== b.row.validFrom) return a.row.validFrom > b.row.validFrom ? -1 : 1
  return byId(a, b)
}

/**
 * `RESOLUTION_RULE` over the rows of one list on one day: every row's
 * verdict, the winner first, and the winner marked — or none when no row is
 * eligible. The rows are the caller's, already of one list; whether they were
 * valid on the day is judged here again, so a caller may hand in every row of
 * the list and read why the others lost.
 */
export function resolvePrice<Row extends PriceRow>(rows: readonly Row[], input: PriceInput, labels: PriceLabels = {}): PriceResolution<Row> {
  const verdicts = rows.map((row) => judge(row, input, labels)).sort(compareVerdicts)
  const winner = verdicts[0]?.eligible ? verdicts[0] : null
  if (winner) winner.winner = true
  return { verdicts, winner }
}

/** Which list an agreement is priced under: its own when it names one, the project's default otherwise, none when neither. */
export const priceListIdFor = (agreement: { priceListId: string | null }, defaultPriceListId: string | null): string | null => agreement.priceListId ?? defaultPriceListId

/** A Price List as `priceOccurrence` reads it: its currency and the rows the caller read for the day. */
export type PricedList<Row extends PriceRow = PriceRow> = { id: string; currency: string; rows: readonly Row[] }

/** What `priceOccurrence` is handed: the agreement's standing, the list it is priced under (or none), the product's VAT rate, how many, and the conditions on the day. */
export type Occurrence<Row extends PriceRow = PriceRow> = {
  agreement: { status: AgreementStatus }
  priceList: PricedList<Row> | null
  product: { vatPercent: number | null }
  quantity: number
  input: PriceInput
}

/** The price as resolved and frozen on an event: the row that won, the unit price, the net, the rate, the VAT and the currency, all in minor units. */
export type PricedAmounts = {
  priceListRowId: string | null
  unitPriceMinor: number
  netMinor: number
  vatPercent: number
  vatMinor: number
  currency: string
}

/** What an occurrence is worth: a price, or the one block reason that stands in the way, with the resolution where one was made so the office reads why. */
export type PricingOutcome<Row extends PriceRow = PriceRow> = { blockReason: null; price: PricedAmounts; resolution: PriceResolution<Row> } | { blockReason: BlockReason; price: null; resolution: PriceResolution<Row> | null }

/**
 * The whole pricing of one occurrence, in the order `reprice` mends the
 * blocks: an unsigned agreement is `agreement-draft`; no list is
 * `no-price-list`; a list with no eligible row is `no-price-row`; a winner
 * under a product with no VAT rate is `no-vat-rate`; otherwise the price,
 * `net = unit × quantity` and `vat = vatOf(net, rate)`, frozen on the event.
 */
export function priceOccurrence<Row extends PriceRow>(occurrence: Occurrence<Row>, labels: PriceLabels = {}): PricingOutcome<Row> {
  if (occurrence.agreement.status === "draft") return { blockReason: "agreement-draft", price: null, resolution: null }
  if (occurrence.priceList === null) return { blockReason: "no-price-list", price: null, resolution: null }
  const resolution = resolvePrice(occurrence.priceList.rows, occurrence.input, labels)
  if (resolution.winner === null) return { blockReason: "no-price-row", price: null, resolution }
  if (occurrence.product.vatPercent === null) return { blockReason: "no-vat-rate", price: null, resolution }
  const unitPriceMinor = resolution.winner.row.unitPriceMinor
  const netMinor = unitPriceMinor * occurrence.quantity
  return {
    blockReason: null,
    price: {
      priceListRowId: resolution.winner.row.id,
      unitPriceMinor,
      netMinor,
      vatPercent: occurrence.product.vatPercent,
      vatMinor: vatOf(netMinor, occurrence.product.vatPercent),
      currency: occurrence.priceList.currency,
    },
    resolution,
  }
}
