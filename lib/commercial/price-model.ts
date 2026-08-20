import type { BusinessRecord } from "@/lib/data/business-modules"

// Deterministic "today" for status derivation and harness runs.
export const PRICING_REFERENCE_DATE = "2026-08-20"

export type ProductType = "Container collection" | "Recurring service" | "Additional service"
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

export type ProductModel = {
  id: string
  name: string
  type: ProductType
  unit: PriceUnit
  vatRate: number
  invoiceName: string
  invoiceCode: string
  status: string
  container?: string
  containerType?: string
  wasteFraction?: string
  materials: string[]
  services: string[]
  serviceLevels: string[]
}

export type ContractorPriceModel = {
  id: string
  contractor: string
  productId: string
  productName: string
  contractArea: string
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

// Registries (spec §4.1 read-mostly; values from prototype-data.ts:99–128)
export const ZONES = ["Zone North", "City Centre", "Amager", "Harbor"] as const
export const CUSTOMER_TYPES = ["Household", "Commercial", "Municipal"] as const
export const CONTAINER_TYPES = ["240L bin", "660L container", "Igloo 3m³"] as const
export const WASTE_FRACTIONS = ["Residual", "Paper & cardboard", "Glass", "Organic"] as const
export const PRICE_LIST_TAGS = ["PL-Copenhagen-2026", "PL-Harbor-2026"] as const
export const KNOWN_CUSTOMERS = ["Østerbro Housing Association", "Nørrebro CoWork ApS"] as const
export const COMMERCIAL_DEFAULTS = { currency: "EUR", defaultVatRate: 0.25, invoiceCodePrefix: "WH-" }
export const CONTRACTOR_PERFORMANCE = {
  formula: "coefficient = 1 + a × (b − complaint share)",
  a: 0.5,
  targetComplaintShare: "4%",
  reliabilityGate: "≥ 98% of pickups completed inside the service window",
  cap: 1.03,
}
export const RESOLUTION_RULE =
  "The row matching the most conditions wins. A negotiated row for the specific customer always wins. Remaining ties go to the row with the newest effective-from date."

// Fact keys — the single source of truth for how models serialize into
// BusinessRecord.facts. Fixtures (Task 2) and write paths (Task 3) use these
// exact strings; the harness registry checks fail loudly if they drift.
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
  contractor: "Contractor", product: "Product", contractArea: "Contract area",
  bid: "Bid (locked)", currentFee: "Current fee", unit: "Unit", validFrom: "Valid from",
  validUntil: "Valid until", lastIndexed: "Last indexed", lastIndexNote: "Last index note",
} as const
export const COMPONENT_FACT_PREFIX = "Component · "
export const HISTORY_PREFIX = "History · "
export const INDEXED_PREFIX = "Indexed · "

export function money(amount: number) { return `€${amount.toFixed(2)}` }
export function unitSuffix(unit: PriceUnit) { return unit === "pickup" ? "/pickup" : unit === "month" ? "/mo" : "/job" }
export function computeAdjusted(amount: number, kind: "percent" | "fixed" | "multiply", value: number, round: boolean): number {
  let next =
    kind === "percent"
      ? amount * (1 + value / 100)
      : kind === "fixed"
        ? amount + value
        : amount * value
  if (round) next = Math.round(next * 20) / 20
  return Math.round(next * 100) / 100
}
export function conditionLabels(conditions: PriceConditions): string[] {
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
export function rowsOf(rows: readonly PriceRowModel[], productId: string): PriceRowModel[] {
  return rows.filter((row) => row.productId === productId).sort((a, b) => Number(isDefaultRow(b)) - Number(isDefaultRow(a)))
}
export function defaultRowOf(rows: readonly PriceRowModel[], productId: string): PriceRowModel | undefined {
  return rows.find((row) => row.productId === productId && isDefaultRow(row))
}
export function variationsOf(rows: readonly PriceRowModel[], productId: string): PriceRowModel[] {
  return rows.filter((row) => row.productId === productId && !isDefaultRow(row))
}
export function negotiatedCustomersOf(rows: readonly PriceRowModel[], productId: string): string[] {
  return [
    ...new Set(
      rows
        .filter((row) => row.productId === productId && row.negotiatedCustomer)
        .map((row) => row.negotiatedCustomer as string),
    ),
  ]
}
export function priceListIndex(rows: readonly PriceRowModel[]): { tag: string; rows: number; effectiveFrom: string; status: string; negotiated: boolean }[] {
  const byTag = new Map<string, { rows: number; earliest: string }>()
  for (const row of rows) {
    if (!row.tag) continue
    const entry = byTag.get(row.tag)
    if (!entry) {
      byTag.set(row.tag, { rows: 1, earliest: row.effectiveFrom })
    } else {
      entry.rows += 1
      if (row.effectiveFrom < entry.earliest) entry.earliest = row.effectiveFrom
    }
  }
  return [...byTag.entries()]
    .map(([tag, entry]) => ({
      tag,
      rows: entry.rows,
      effectiveFrom: entry.earliest,
      status: entry.earliest <= PRICING_REFERENCE_DATE ? "Active" : "Scheduled",
      negotiated: tag.startsWith("Negotiated"),
    }))
    .sort((a, b) => a.tag.localeCompare(b.tag))
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
// `Indexed · <at> · <note> · €<from> → €<to> · base: <bid|current fee>`
export function encodeIndexation(entry: ContractorPriceModel["indexation"][number]): string {
  return `${INDEXED_PREFIX}${entry.at} · ${entry.note} · ${money(entry.from)} → ${money(entry.to)} · base: ${entry.base}`
}
export function decodeIndexation(related: readonly string[]): ContractorPriceModel["indexation"] {
  return related
    .filter((item) => item.startsWith(INDEXED_PREFIX))
    .map((item) => {
      const parts = item.slice(INDEXED_PREFIX.length).split(" · ")
      const amounts = /€([\d.]+) → €([\d.]+)/.exec(parts[2] ?? "")
      const base = (parts[3] ?? "").replace("base: ", "") === "bid" ? ("bid" as const) : ("current fee" as const)
      return { at: parts[0] ?? "", note: parts[1] ?? "", from: Number(amounts?.[1] ?? 0), to: Number(amounts?.[2] ?? 0), base }
    })
}

// --- Record ⇄ model converters ---
export function recordToPriceRow(record: BusinessRecord): PriceRowModel | null {
  const productId = record.relationRefs?.find((ref) => ref.fieldId === "productId")?.recordId
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
  const status = row.effectiveFrom > PRICING_REFERENCE_DATE ? "Scheduled" : row.effectiveTo && row.effectiveTo < PRICING_REFERENCE_DATE ? "Expired" : "Active"
  return {
    id: row.id,
    name: rowDisplayName(row),
    context: product.name,
    status,
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

export function recordToProduct(record: BusinessRecord): ProductModel {
  const splitList = (value?: string) => (value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [])
  return {
    id: record.id,
    name: record.name,
    type: (record.facts[PRODUCT_FACTS.type] as ProductType) || "Additional service",
    unit: (record.facts[PRODUCT_FACTS.unit] as PriceUnit) || "pickup",
    vatRate: Number.parseFloat(record.facts[PRODUCT_FACTS.vat] || "25") / 100,
    invoiceName: record.facts[PRODUCT_FACTS.invoiceName] || record.name,
    invoiceCode: record.facts[PRODUCT_FACTS.invoiceCode] || "",
    status: record.status,
    container: record.facts[PRODUCT_FACTS.container] || undefined,
    containerType: record.facts[PRODUCT_FACTS.containerType] || undefined,
    wasteFraction: record.facts[PRODUCT_FACTS.wasteFraction] || undefined,
    materials: splitList(record.facts[PRODUCT_FACTS.materials]),
    services: splitList(record.facts[PRODUCT_FACTS.services]),
    serviceLevels: splitList(record.facts[PRODUCT_FACTS.serviceLevels]),
  }
}

export function recordToContractorPrice(record: BusinessRecord): ContractorPriceModel {
  const productRef = record.relationRefs?.find((ref) => ref.fieldId === "productId")
  return {
    id: record.id,
    contractor: record.facts[RATE_FACTS.contractor] || "",
    productId: productRef?.recordId ?? "",
    productName: record.facts[RATE_FACTS.product] || productRef?.label || "",
    contractArea: record.facts[RATE_FACTS.contractArea] || "",
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
export function contractorPriceToRecord(rate: ContractorPriceModel, existing: BusinessRecord): BusinessRecord {
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

// Recomputes a product's derived pricing facts (Price list / Variations /
// Customer) and its headline value string from the current price-row set.
// Shared by every write path that touches price rows — Task 3's bulk-adjust
// and price-row create/edit branches in business-workspace.tsx, and Task 4's
// Settings product editor — so they all keep the product's facts in sync the
// same way instead of duplicating the derivation.
export function syncProductPricingFacts(product: BusinessRecord, rows: readonly PriceRowModel[]): BusinessRecord {
  const productRows = rowsOf(rows, product.id)
  const defaultRow = defaultRowOf(rows, product.id)
  const negotiated = negotiatedCustomersOf(rows, product.id)
  const facts = { ...product.facts }
  if (defaultRow) facts[PRODUCT_FACTS.priceList] = defaultRow.tag ?? ""
  const variations = productRows.length - (defaultRow ? 1 : 0)
  if (variations > 0) facts[PRODUCT_FACTS.variations] = String(variations)
  else delete facts[PRODUCT_FACTS.variations]
  if (negotiated.length > 0) facts[PRODUCT_FACTS.customer] = negotiated.join(", ")
  else delete facts[PRODUCT_FACTS.customer]
  return {
    ...product,
    value: defaultRow ? `${money(defaultRow.amount)}${unitSuffix(defaultRow.unit)}` : "Unpriced",
    facts,
  }
}

// Indexation run (spec §4.3): recompute the current fee from the chosen base,
// append to the indexation history. The bid itself never changes.
export function applyIndexToRate(rate: ContractorPriceModel, opts: { label: string; percent: number; from: string; base: "bid" | "current fee" }): ContractorPriceModel {
  const baseAmount = opts.base === "bid" ? rate.bid : rate.currentFee
  const to = Math.round(baseAmount * (1 + opts.percent / 100) * 100) / 100
  return {
    ...rate,
    currentFee: to,
    lastIndexed: opts.from,
    lastIndexNote: `${opts.label} +${opts.percent}%`,
    indexation: [...rate.indexation, { at: opts.from, note: `${opts.label} +${opts.percent}%`, from: rate.currentFee, to, base: opts.base }],
  }
}
