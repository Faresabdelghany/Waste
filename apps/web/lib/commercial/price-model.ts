import type { BusinessRecord } from "@/lib/data/business-modules"
import {
  isSoftDeleted,
  REGISTRY_VISIBILITY_FACT,
  SOFT_DELETED,
  softDeletedRecord,
  type SoftDeletion,
} from "@waste/domain/record-visibility"
import { count } from "@waste/domain/text"

// Deterministic "today" for status derivation.
export const PRICING_REFERENCE_DATE = "2026-08-20"

export type PriceUnit = "pickup" | "month" | "job"
export type PriceConditions = { zone?: string; customerType?: string; containerType?: string; wasteFraction?: string }
export type ScheduledChange = { newAmount: number; from: string; revertOn?: string; note: string }

export type PriceRowModel = {
  id: string
  productId: string
  amount: number
  unit: PriceUnit
  conditions: PriceConditions
  negotiatedCustomer?: string
  effectiveFrom: string
  effectiveTo?: string
  scheduled?: ScheduledChange
  tag?: string
}

export type PriceRowStatus = "Scheduled" | "Active" | "Expired"

export type ServiceProviderPriceModel = {
  id: string
  serviceProvider: string
  productId: string
  productName: string
  serviceArea: string
  bid: number
  currentFee: number
  unit: PriceUnit
  validFrom: string
  validUntil: string
  lastIndexed?: string
  lastIndexNote?: string
  components: { label: string; detail: string }[]
  indexation: { at: string; note: string; from: number; to: number; base: "bid" | "current fee" }[]
}

export type HistoryEntry = { at: string; who: string; what: string }

// The zones, customer types, container types, service levels and price
// lists a row may name are managed entities in the commercial-registries
// store (Settings → Commercial); the row's "Price list" fact stores the
// list's name as its tag. Nothing here spells them a second time.
export const SERVICE_PROVIDER_PERFORMANCE = {
  formula: "coefficient = 1 + a × (b − complaint share)",
  a: 0.5,
  targetComplaintShare: "4%",
  reliabilityGate: "≥ 98% of pickups completed inside the service window",
  cap: 1.03,
}
// The one spelling of how a price is resolved (spec §4.4). The two pricing
// modules state it in their rules and the Add price form in its description;
// resolvePrice in ./price-resolution is the sentence run as code.
export const RESOLUTION_RULE =
  "The row matching the most conditions wins. A negotiated row for the specific customer always wins. Remaining ties go to the row with the newest effective-from date."

// Fact keys — the single source of truth for how models serialize into
// BusinessRecord.facts. Fixtures and write paths use these exact strings,
// and the products and price-rows forms label their fields with them, since
// the generic write path stores a field under its label
// (lib/commercial/__tests__/price-model.test.ts holds the two in step).
export const ROW_FACTS = {
  amount: "Amount", unit: "Unit", zone: "Zone", customerType: "Customer type",
  containerType: "Container type", wasteFraction: "Waste fraction",
  negotiatedCustomer: "Negotiated customer", effectiveFrom: "Effective from",
  effectiveTo: "Effective to", tag: "Price list", scheduledAmount: "Scheduled amount",
  scheduledFrom: "Scheduled from", scheduledRevertOn: "Scheduled revert on",
  scheduledNote: "Scheduled note",
} as const
export const PRODUCT_FACTS = {
  type: "Type", unit: "Unit", vat: "VAT", invoiceName: "Invoice name",
  invoiceCode: "Invoice code", container: "Container", containerType: "Container type",
  wasteFraction: "Waste fraction", customer: "Customer", variations: "Variations",
  priceList: "Price list", materials: "Materials", services: "Included services",
  serviceLevels: "Service levels",
} as const
export const RATE_FACTS = {
  serviceProvider: "Service provider", product: "Product", serviceArea: "Service area",
  bid: "Bid (locked)", currentFee: "Current fee", unit: "Unit", validFrom: "Valid from",
  validUntil: "Valid until", lastIndexed: "Last indexed", lastIndexNote: "Last index note",
} as const
// Soft delete marks the record instead of removing it (the shape lives in
// @waste/domain/record-visibility; commitRecordAction in business-workspace.tsx
// writes it), so every pricing read path must skip marked records or a
// deleted row gets counted, adjusted and resurrected. Re-exported for the
// pricing callers that import everything from this model.
export { isSoftDeleted, REGISTRY_VISIBILITY_FACT, SOFT_DELETED }
export const COMPONENT_FACT_PREFIX = "Component · "
export const HISTORY_PREFIX = "History · "
export const INDEXED_PREFIX = "Indexed · "

export function money(amount: number) { return `€${amount.toFixed(2)}` }
export function unitSuffix(unit: PriceUnit) { return unit === "pickup" ? "/pickup" : unit === "month" ? "/mo" : "/job" }
/** "+5%" / "-2%" / "0%" — a percent with its sign written once, for a toast or an index note. */
export function signedPercent(percent: number) { return `${percent > 0 ? "+" : ""}${percent}%` }
function conditionLabels(conditions: PriceConditions): string[] {
  const labels: string[] = []
  if (conditions.zone) labels.push(conditions.zone)
  if (conditions.customerType) labels.push(conditions.customerType)
  if (conditions.containerType) labels.push(conditions.containerType)
  if (conditions.wasteFraction) labels.push(conditions.wasteFraction)
  return labels
}
export function rowDisplayName(row: PriceRowModel): string {
  if (row.negotiatedCustomer) return `Negotiated · ${row.negotiatedCustomer}`
  const labels = conditionLabels(row.conditions)
  return labels.length ? labels.join(" · ") : "Everyone"
}
const isDefaultRow = (row: PriceRowModel) => !row.negotiatedCustomer && Object.keys(row.conditions).length === 0
function rowsOf(rows: readonly PriceRowModel[], productId: string): PriceRowModel[] {
  return rows.filter((row) => row.productId === productId).sort((a, b) => Number(isDefaultRow(b)) - Number(isDefaultRow(a)))
}
export function defaultRowOf(rows: readonly PriceRowModel[], productId: string): PriceRowModel | undefined {
  return rows.find((row) => row.productId === productId && isDefaultRow(row))
}
function negotiatedCustomersOf(rows: readonly PriceRowModel[], productId: string): string[] {
  return [
    ...new Set(
      rows
        .filter((row) => row.productId === productId && row.negotiatedCustomer)
        .map((row) => row.negotiatedCustomer as string),
    ),
  ]
}
// --- History / indexation codecs (BusinessRecord.related entries) ---
// `History · <date> · <who> · <what>` — the what may itself contain " · ",
// so decode takes the first two segments and joins the rest.
export function encodeHistory(entry: HistoryEntry): string {
  return `${HISTORY_PREFIX}${entry.at} · ${entry.who} · ${entry.what}`
}
export function decodeHistory(related: readonly string[]): HistoryEntry[] {
  return related
    .filter((item) => item.startsWith(HISTORY_PREFIX))
    .map((item) => {
      const parts = item.slice(HISTORY_PREFIX.length).split(" · ")
      return { at: parts[0] ?? "", who: parts[1] ?? "", what: parts.slice(2).join(" · ") }
    })
}
// `Indexed · <at> · <note> · €<from> → €<to> · base: <bid|current fee>` —
// the note may itself contain " · " (an index label such as "CPI · Denmark"),
// so decode reads the date off the front, the amounts and the base off the
// back, and joins whatever stands between as the note.
export function encodeIndexation(entry: ServiceProviderPriceModel["indexation"][number]): string {
  return `${INDEXED_PREFIX}${entry.at} · ${entry.note} · ${money(entry.from)} → ${money(entry.to)} · base: ${entry.base}`
}
export function decodeIndexation(related: readonly string[]): ServiceProviderPriceModel["indexation"] {
  return related
    .filter((item) => item.startsWith(INDEXED_PREFIX))
    .map((item) => {
      const parts = item.slice(INDEXED_PREFIX.length).split(" · ")
      const amounts = /€([\d.]+) → €([\d.]+)/.exec(parts[parts.length - 2] ?? "")
      const base = (parts[parts.length - 1] ?? "").replace("base: ", "") === "bid" ? ("bid" as const) : ("current fee" as const)
      return {
        at: parts[0] ?? "",
        note: parts.slice(1, -2).join(" · "),
        from: Number(amounts?.[1] ?? 0),
        to: Number(amounts?.[2] ?? 0),
        base,
      }
    })
}

// --- Record ⇄ model converters ---
/** The product a price row belongs to — its one link, read by every row path. */
export function productIdOfPriceRow(record: BusinessRecord): string | undefined {
  return record.relationRefs?.find((ref) => ref.fieldId === "productId")?.recordId
}

// Returns null for a record that cannot be read as a live price row —
// including a soft-deleted one. That single guard keeps every consumer
// honest (the product-fact sync, the Settings reads) instead of
// each of them having to remember the visibility marker.
export function recordToPriceRow(record: BusinessRecord): PriceRowModel | null {
  if (isSoftDeleted(record)) return null
  const productId = productIdOfPriceRow(record)
  const amount = Number(record.facts[ROW_FACTS.amount])
  const effectiveFrom = record.facts[ROW_FACTS.effectiveFrom]
  if (!productId || !effectiveFrom || !Number.isFinite(amount)) return null
  const conditions: PriceConditions = {}
  if (record.facts[ROW_FACTS.zone]) conditions.zone = record.facts[ROW_FACTS.zone]
  if (record.facts[ROW_FACTS.customerType]) conditions.customerType = record.facts[ROW_FACTS.customerType]
  if (record.facts[ROW_FACTS.containerType]) conditions.containerType = record.facts[ROW_FACTS.containerType]
  if (record.facts[ROW_FACTS.wasteFraction]) conditions.wasteFraction = record.facts[ROW_FACTS.wasteFraction]
  const scheduledAmount = Number(record.facts[ROW_FACTS.scheduledAmount])
  const scheduledFrom = record.facts[ROW_FACTS.scheduledFrom]
  return {
    id: record.id,
    productId,
    amount,
    unit: (record.facts[ROW_FACTS.unit] as PriceUnit) || "pickup",
    conditions,
    negotiatedCustomer: record.facts[ROW_FACTS.negotiatedCustomer] || undefined,
    effectiveFrom,
    effectiveTo: record.facts[ROW_FACTS.effectiveTo] || undefined,
    scheduled: Number.isFinite(scheduledAmount) && scheduledFrom
      ? { newAmount: scheduledAmount, from: scheduledFrom, revertOn: record.facts[ROW_FACTS.scheduledRevertOn] || undefined, note: record.facts[ROW_FACTS.scheduledNote] || "" }
      : undefined,
    tag: record.facts[ROW_FACTS.tag] || undefined,
  }
}

// A row's lifecycle state is its effective period against the reference
// date, never the form's first lifecycle state: Scheduled before it starts,
// Expired once it has ended, Active in between (an end on the reference
// date is still in force).
export function priceRowStatus(
  row: Pick<PriceRowModel, "effectiveFrom" | "effectiveTo">,
  referenceDate: string = PRICING_REFERENCE_DATE,
): PriceRowStatus {
  if (row.effectiveFrom > referenceDate) return "Scheduled"
  if (row.effectiveTo && row.effectiveTo < referenceDate) return "Expired"
  return "Active"
}

export function priceRowToRecord(row: PriceRowModel, product: { id: string; name: string }): BusinessRecord {
  const facts: Record<string, string> = {
    [ROW_FACTS.amount]: row.amount.toFixed(2),
    [ROW_FACTS.unit]: row.unit,
    [ROW_FACTS.effectiveFrom]: row.effectiveFrom,
  }
  if (row.conditions.zone) facts[ROW_FACTS.zone] = row.conditions.zone
  if (row.conditions.customerType) facts[ROW_FACTS.customerType] = row.conditions.customerType
  if (row.conditions.containerType) facts[ROW_FACTS.containerType] = row.conditions.containerType
  if (row.conditions.wasteFraction) facts[ROW_FACTS.wasteFraction] = row.conditions.wasteFraction
  if (row.negotiatedCustomer) facts[ROW_FACTS.negotiatedCustomer] = row.negotiatedCustomer
  if (row.effectiveTo) facts[ROW_FACTS.effectiveTo] = row.effectiveTo
  if (row.tag) facts[ROW_FACTS.tag] = row.tag
  if (row.scheduled) {
    facts[ROW_FACTS.scheduledAmount] = row.scheduled.newAmount.toFixed(2)
    facts[ROW_FACTS.scheduledFrom] = row.scheduled.from
    if (row.scheduled.revertOn) facts[ROW_FACTS.scheduledRevertOn] = row.scheduled.revertOn
    if (row.scheduled.note) facts[ROW_FACTS.scheduledNote] = row.scheduled.note
  }
  return {
    id: row.id,
    name: rowDisplayName(row),
    context: product.name,
    status: priceRowStatus(row),
    owner: "Pricing",
    value: `${money(row.amount)}${unitSuffix(row.unit)}`,
    updated: "Now",
    description: row.negotiatedCustomer
      ? `Negotiated price row for ${row.negotiatedCustomer} on ${product.name}.`
      : `Price row on ${product.name} (${rowDisplayName(row)}).`,
    facts,
    related: [],
    source: "Price Engine",
    freshness: "Now",
    recordKind: "Price row",
    relationRefs: [{ fieldId: "productId", workspaceId: "commercial", moduleId: "products", recordId: product.id, label: product.name }],
  }
}

// What the generic create and edit paths hand over is shaped by the form —
// the module lifecycle's first state as status, the context fields joined
// with " · ", a select fact as its option label — where a fixture row and a
// Settings-written row carry the product's name as context, a status read
// off the effective period and the raw PriceUnit under Unit. This derives
// all four from the row so a row reads the same whichever door it came
// through; `unit` is the raw submitted enum, written over the label the
// generic path stored. A record that is not a live row is returned as it
// came (with the unit applied), since there is nothing to derive from.
export function normalizePriceRowRecord(
  record: BusinessRecord,
  options: { unit?: string; referenceDate?: string } = {},
): BusinessRecord {
  const withUnit = options.unit
    ? { ...record, facts: { ...record.facts, [ROW_FACTS.unit]: options.unit } }
    : record
  const row = recordToPriceRow(withUnit)
  if (!row) return withUnit
  const productLabel = record.relationRefs?.find((ref) => ref.fieldId === "productId")?.label
  return {
    ...withUnit,
    name: rowDisplayName(row),
    context: productLabel || withUnit.context,
    status: priceRowStatus(row, options.referenceDate),
    value: `${money(row.amount)}${unitSuffix(row.unit)}`,
  }
}

// A price row has no meaning without its product — recordToPriceRow reads
// it through the product link — so a product's soft delete takes its live
// rows with it under the same deletion log: the marked copies of every row
// naming the product that is not already marked. Rows of other products and
// rows already deleted are left alone.
export function softDeletedPriceRowsOf(
  rowRecords: readonly BusinessRecord[],
  productId: string,
  deletion: SoftDeletion,
): BusinessRecord[] {
  return rowRecords
    .filter((record) => !isSoftDeleted(record) && productIdOfPriceRow(record) === productId)
    .map((record) => softDeletedRecord(record, deletion))
}

// Contract-bound validity → lifecycle status. "Expiring" mirrors the fixture
// convention: an end date within ~6 months of the reference date.
export function deriveServiceProviderPriceStatus(
  validFrom: string,
  validUntil?: string,
  referenceDate: string = PRICING_REFERENCE_DATE,
): "Upcoming" | "Active" | "Expiring" | "Expired" {
  if (validFrom > referenceDate) return "Upcoming"
  if (validUntil && validUntil < referenceDate) return "Expired"
  if (validUntil) {
    const horizon = new Date(referenceDate)
    horizon.setUTCDate(horizon.getUTCDate() + 180)
    if (validUntil <= horizon.toISOString().slice(0, 10)) return "Expiring"
  }
  return "Active"
}

export function recordToServiceProviderPrice(record: BusinessRecord): ServiceProviderPriceModel {
  const productRef = record.relationRefs?.find((ref) => ref.fieldId === "productId")
  return {
    id: record.id,
    serviceProvider: record.facts[RATE_FACTS.serviceProvider] || "",
    productId: productRef?.recordId ?? "",
    productName: record.facts[RATE_FACTS.product] || productRef?.label || "",
    serviceArea: record.facts[RATE_FACTS.serviceArea] || "",
    bid: Number(record.facts[RATE_FACTS.bid] || 0),
    currentFee: Number(record.facts[RATE_FACTS.currentFee] || 0),
    unit: (record.facts[RATE_FACTS.unit] as PriceUnit) || "pickup",
    validFrom: record.facts[RATE_FACTS.validFrom] || "",
    validUntil: record.facts[RATE_FACTS.validUntil] || "",
    lastIndexed: record.facts[RATE_FACTS.lastIndexed] || undefined,
    lastIndexNote: record.facts[RATE_FACTS.lastIndexNote] || undefined,
    components: Object.entries(record.facts)
      .filter(([key]) => key.startsWith(COMPONENT_FACT_PREFIX))
      .map(([key, detail]) => ({ label: key.slice(COMPONENT_FACT_PREFIX.length), detail })),
    indexation: decodeIndexation(record.related),
  }
}

// Serializes an indexed rate back over its existing record: keeps identity,
// rewrites the money facts, replaces the Indexed· entries. Never touches Bid.
export function serviceProviderPriceToRecord(rate: ServiceProviderPriceModel, existing: BusinessRecord): BusinessRecord {
  return {
    ...existing,
    updated: "Now",
    freshness: "Now",
    value: `${money(rate.currentFee)}${unitSuffix(rate.unit)}`,
    facts: {
      ...existing.facts,
      [RATE_FACTS.currentFee]: rate.currentFee.toFixed(2),
      ...(rate.lastIndexed ? { [RATE_FACTS.lastIndexed]: rate.lastIndexed } : {}),
      ...(rate.lastIndexNote ? { [RATE_FACTS.lastIndexNote]: rate.lastIndexNote } : {}),
    },
    related: [
      ...rate.indexation.map(encodeIndexation),
      ...existing.related.filter((item) => !item.startsWith(INDEXED_PREFIX)),
    ],
  }
}

// --- The pricing sentence of a product's description ---
// A product's description is its own prose plus one sentence about its
// pricing, and that sentence is derived from the rows like the Variations,
// Customer and Price list facts are — hand-written, it went stale the moment
// a row was added or deleted. Every sentence that opens like a pricing
// sentence is replaced, so a description never carries two.
const PRICING_SENTENCE = /^(Default price\b|No default price\b|Unpriced\b)/
const UNPRICED_SENTENCE = "Unpriced — add its price in Price Engine with Add price."

/** The pricing sentence for one product's rows (the default row's standing, then the variations). */
export function pricingSentence(
  productRows: readonly PriceRowModel[],
  referenceDate: string = PRICING_REFERENCE_DATE,
): string {
  const defaultRow = productRows.find(isDefaultRow)
  const variations = productRows.filter((row) => !isDefaultRow(row))
  if (!defaultRow && variations.length === 0) return UNPRICED_SENTENCE
  const negotiated = variations.filter((row) => row.negotiatedCustomer).length
  const tail =
    variations.length === 0
      ? "no variations"
      : `${count(variations.length, "variation")}${negotiated > 0 ? ` including ${count(negotiated, "negotiated deal")}` : ""}`
  if (!defaultRow) return `No default price; ${tail}.`
  const status = priceRowStatus(defaultRow, referenceDate)
  const head =
    status === "Scheduled"
      ? `Default price takes effect ${defaultRow.effectiveFrom}`
      : status === "Expired"
        ? `Default price expired ${defaultRow.effectiveTo}`
        : "Default price applies to everyone"
  return `${head}; ${tail}.`
}

function withPricingSentence(description: string, sentence: string): string {
  // Sentences end in ". "; a decimal or an abbreviation has no space after
  // its period, so it stays inside its sentence.
  const parts = description.split(". ")
  const sentences = parts
    .map((part, index) => (index < parts.length - 1 ? `${part}.` : part))
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !PRICING_SENTENCE.test(part))
  return [...sentences, sentence].join(" ")
}

// Recomputes a product's derived pricing facts (Price list / Variations /
// Customer), its headline value string and the pricing sentence of its
// description from the current price-row set. Shared by every write path
// that touches price rows — the Add price / row-edit / row-delete branches
// in business-workspace.tsx and the Settings product editor — so they all
// keep the product in sync the same way instead of duplicating the
// derivation.
export function syncProductPricingFacts(product: BusinessRecord, rows: readonly PriceRowModel[]): BusinessRecord {
  const productRows = rowsOf(rows, product.id)
  const defaultRow = defaultRowOf(rows, product.id)
  const negotiated = negotiatedCustomersOf(rows, product.id)
  const facts = { ...product.facts }
  // No default row (or an untagged one) means the product has no price list —
  // drop the key rather than leaving the previous tag behind as a stale fact
  // or writing an empty string the detail sheet would render as a blank row.
  if (defaultRow?.tag) facts[PRODUCT_FACTS.priceList] = defaultRow.tag
  else delete facts[PRODUCT_FACTS.priceList]
  const variations = productRows.length - (defaultRow ? 1 : 0)
  if (variations > 0) facts[PRODUCT_FACTS.variations] = String(variations)
  else delete facts[PRODUCT_FACTS.variations]
  if (negotiated.length > 0) facts[PRODUCT_FACTS.customer] = negotiated.join(", ")
  else delete facts[PRODUCT_FACTS.customer]
  return {
    ...product,
    value: defaultRow ? `${money(defaultRow.amount)}${unitSuffix(defaultRow.unit)}` : "Unpriced",
    description: withPricingSentence(product.description, pricingSentence(productRows)),
    facts,
  }
}

// Indexation run (spec §4.3): recompute the current fee from the chosen base,
// append to the indexation history. The bid itself never changes.
export function applyIndexToRate(rate: ServiceProviderPriceModel, opts: { label: string; percent: number; from: string; base: "bid" | "current fee" }): ServiceProviderPriceModel {
  const baseAmount = opts.base === "bid" ? rate.bid : rate.currentFee
  const to = Math.round(baseAmount * (1 + opts.percent / 100) * 100) / 100
  const note = `${opts.label} ${signedPercent(opts.percent)}`
  return {
    ...rate,
    currentFee: to,
    lastIndexed: opts.from,
    lastIndexNote: note,
    indexation: [...rate.indexation, { at: opts.from, note, from: rate.currentFee, to, base: opts.base }],
  }
}
