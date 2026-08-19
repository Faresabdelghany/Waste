// PROTOTYPE — throwaway code, do not ship.
// Local fixture data + price resolution for the Products & Prices redesign prototype.
// Spec: docs/superpowers/specs/2026-08-19-products-prices-redesign-design.md

export const PROTO_TODAY = "2026-08-19"

export type ProductType =
  | "Container collection"
  | "Recurring service"
  | "Additional service"
export type PriceUnit = "pickup" | "month" | "job"
export type ProductStatus = "Active" | "Draft" | "Inactive"

export type PriceConditions = {
  zone?: string
  customerType?: string
  containerType?: string
  wasteFraction?: string
}

export type PriceRow = {
  id: string
  productId: string
  amount: number
  conditions: PriceConditions
  negotiatedCustomer?: string
  effectiveFrom: string
  effectiveTo?: string
  scheduled?: { newAmount: number; from: string; revertOn?: string; note: string }
  tag?: string
}

export type HistoryEntry = {
  at: string
  who: string
  what: string
  diffs?: { field: string; from: string; to: string }[]
}

export type Product = {
  id: string
  name: string
  type: ProductType
  unit: PriceUnit
  vatRate: number
  invoiceName: string
  invoiceCode: string
  status: ProductStatus
  extras: { materials: string[]; services: string[]; serviceLevels: string[] }
  history: HistoryEntry[]
}

export type ContractorPrice = {
  id: string
  contractor: string
  productId: string
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

export type PrototypeDb = {
  products: Product[]
  priceRows: PriceRow[]
  contractorPrices: ContractorPrice[]
}

// Fixture invoices (spec §4.5 launch point c — invoice lines open Explain a
// price). Line amounts are NOT stored: they are resolved against the live db
// via explainPrice at render time, so the invoice always agrees with the sheet.
export type InvoiceLine = {
  productId: string
  qty: number
  date: string
}

export type InvoiceFixture = {
  id: string
  number: string
  customer: string
  zone: string
  customerType: string
  issued: string
  status: "Sent" | "Draft"
  lines: InvoiceLine[]
}

export const ZONES = ["Zone North", "City Centre", "Amager", "Harbor"] as const
export const CUSTOMER_TYPES = ["Household", "Commercial", "Municipal"] as const
export const CONTAINER_TYPES = ["240L bin", "660L container", "Igloo 3m³"] as const
export const WASTE_FRACTIONS = [
  "Residual",
  "Paper & cardboard",
  "Glass",
  "Organic",
] as const
export const PRICE_LIST_TAGS = ["PL-Copenhagen-2026", "PL-Harbor-2026"] as const
export const KNOWN_CUSTOMERS = [
  "Østerbro Housing Association",
  "Nørrebro CoWork ApS",
] as const

// --- One-time setup (spec §4.1) — owned by /settings → Commercial defaults ---

export const COMMERCIAL_DEFAULTS = {
  currency: "EUR",
  defaultVatRate: 0.25,
  invoiceCodePrefix: "WH-",
}

export const CONTRACTOR_PERFORMANCE = {
  formula: "coefficient = 1 + a × (b − complaint share)",
  a: 0.5,
  targetComplaintShare: "4%",
  reliabilityGate: "≥ 98% of pickups completed inside the service window",
  cap: 1.03,
}

export const RESOLUTION_RULE =
  "The row matching the most conditions wins. A negotiated row for the specific customer always wins. Remaining ties go to the row with the newest effective-from date."

export const SURCHARGE_RULES = [
  {
    id: "sur-weekend",
    name: "Weekend surcharge",
    kind: "percent" as const,
    value: 15,
    recurrence: "Every Saturday and Sunday",
    appliesTo: (date: string) => {
      const day = new Date(`${date}T12:00:00`).getDay()
      return day === 0 || day === 6
    },
    describe: "+15% on Saturdays and Sundays",
  },
  {
    id: "sur-holiday",
    name: "Public holiday surcharge",
    kind: "flat" as const,
    value: 25,
    recurrence: "Annual · 4 configured dates",
    appliesTo: (date: string) =>
      ["2026-12-24", "2026-12-25", "2026-12-31", "2027-01-01"].includes(date),
    describe: "+€25.00 on public holidays",
  },
]

// Read-mostly Price lists index (spec §4.6) — derived from the rows, no
// lifecycle container object.
export function priceListIndex(db: PrototypeDb) {
  const byTag = new Map<string, { rows: number; earliest: string }>()
  for (const row of db.priceRows) {
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
      status: entry.earliest <= PROTO_TODAY ? "Active" : "Scheduled",
      negotiated: tag.startsWith("Negotiated"),
    }))
    .sort((a, b) => a.tag.localeCompare(b.tag))
}

export function money(amount: number) {
  return `€${amount.toFixed(2)}`
}

// Bulk-adjust math (spec §4.2) — optional rounding to the nearest €0.05.
export function computeAdjusted(
  amount: number,
  kind: "percent" | "fixed" | "multiply",
  value: number,
  round: boolean,
) {
  let next =
    kind === "percent"
      ? amount * (1 + value / 100)
      : kind === "fixed"
        ? amount + value
        : amount * value
  if (round) next = Math.round(next * 20) / 20
  return Math.round(next * 100) / 100
}

export function unitSuffix(unit: PriceUnit) {
  return unit === "pickup" ? "/pickup" : unit === "month" ? "/mo" : "/job"
}

// Indexation run (spec §4.3) — recompute current fees from the chosen base and
// append to each rate's indexation history. The bid itself never changes.
export function applyIndexToDb(
  db: PrototypeDb,
  rateIds: string[],
  opts: { label: string; percent: number; from: string; base: "bid" | "current fee" },
): PrototypeDb {
  const ids = new Set(rateIds)
  return {
    ...db,
    contractorPrices: db.contractorPrices.map((rate) => {
      if (!ids.has(rate.id)) return rate
      const baseAmount = opts.base === "bid" ? rate.bid : rate.currentFee
      const to = Math.round(baseAmount * (1 + opts.percent / 100) * 100) / 100
      return {
        ...rate,
        currentFee: to,
        lastIndexed: opts.from,
        lastIndexNote: `${opts.label} +${opts.percent}%`,
        indexation: [
          ...rate.indexation,
          {
            at: opts.from,
            note: `${opts.label} +${opts.percent}%`,
            from: rate.currentFee,
            to,
            base: opts.base,
          },
        ],
      }
    }),
  }
}

export function defaultRowOf(db: PrototypeDb, productId: string) {
  return db.priceRows.find(
    (row) =>
      row.productId === productId &&
      !row.negotiatedCustomer &&
      Object.keys(row.conditions).length === 0,
  )
}

export function variationsOf(db: PrototypeDb, productId: string) {
  return db.priceRows.filter(
    (row) =>
      row.productId === productId &&
      (row.negotiatedCustomer || Object.keys(row.conditions).length > 0),
  )
}

export function rowsOf(db: PrototypeDb, productId: string) {
  const rows = db.priceRows.filter((row) => row.productId === productId)
  const isDefault = (row: PriceRow) =>
    !row.negotiatedCustomer && Object.keys(row.conditions).length === 0
  return [...rows].sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)))
}

export function conditionLabels(conditions: PriceConditions) {
  const labels: string[] = []
  if (conditions.zone) labels.push(conditions.zone)
  if (conditions.customerType) labels.push(conditions.customerType)
  if (conditions.containerType) labels.push(conditions.containerType)
  if (conditions.wasteFraction) labels.push(conditions.wasteFraction)
  return labels
}

// --- Price resolution (§4.4 of the spec) ---

export type ExplainInput = {
  productId: string
  zone: string
  customerType: string
  containerType?: string
  wasteFraction?: string
  customer?: string
  date: string
}

export type RowVerdict = {
  row: PriceRow
  eligible: boolean
  reason?: string
  matched: string[]
  score: number
  winner: boolean
  amountOnDate: number
}

export type Explanation = {
  verdicts: RowVerdict[]
  winner?: RowVerdict
  surcharge?: { name: string; describe: string; amount: number }
  base: number
  vatRate: number
  vat: number
  total: number
}

function amountOnDate(row: PriceRow, date: string) {
  if (row.scheduled && row.scheduled.from <= date) {
    if (!row.scheduled.revertOn || date < row.scheduled.revertOn) {
      return row.scheduled.newAmount
    }
  }
  return row.amount
}

export function explainPrice(db: PrototypeDb, input: ExplainInput): Explanation {
  const product = db.products.find((p) => p.id === input.productId)
  const rows = db.priceRows.filter((row) => row.productId === input.productId)
  const inputValues: Record<keyof PriceConditions, string | undefined> = {
    zone: input.zone,
    customerType: input.customerType,
    containerType: input.containerType,
    wasteFraction: input.wasteFraction,
  }
  const conditionNames: Record<keyof PriceConditions, string> = {
    zone: "Zone",
    customerType: "Customer type",
    containerType: "Container type",
    wasteFraction: "Waste fraction",
  }

  const verdicts: RowVerdict[] = rows.map((row) => {
    const matched: string[] = []
    let reason: string | undefined

    if (row.negotiatedCustomer) {
      if (input.customer === row.negotiatedCustomer) {
        matched.push(`Negotiated · ${row.negotiatedCustomer}`)
      } else {
        reason = `Negotiated for ${row.negotiatedCustomer}, not this customer`
      }
    }
    if (!reason && row.effectiveFrom > input.date) {
      reason = `Not effective until ${row.effectiveFrom}`
    }
    if (!reason && row.effectiveTo && row.effectiveTo < input.date) {
      reason = `Expired on ${row.effectiveTo}`
    }
    if (!reason) {
      for (const key of Object.keys(row.conditions) as (keyof PriceConditions)[]) {
        const required = row.conditions[key]
        if (!required) continue
        const provided = inputValues[key]
        if (!provided) {
          reason = `Requires ${conditionNames[key].toLowerCase()} ${required}`
          break
        }
        if (provided !== required) {
          reason = `${conditionNames[key]} is ${required}, not ${provided}`
          break
        }
        matched.push(required)
      }
    }

    const eligible = !reason
    const score = eligible
      ? (row.negotiatedCustomer ? 100 : 0) + Object.keys(row.conditions).length
      : -1
    return {
      row,
      eligible,
      reason,
      matched,
      score,
      winner: false,
      amountOnDate: amountOnDate(row, input.date),
    }
  })

  const eligible = verdicts.filter((verdict) => verdict.eligible)
  eligible.sort(
    (a, b) =>
      b.score - a.score || b.row.effectiveFrom.localeCompare(a.row.effectiveFrom),
  )
  const winner = eligible[0]
  if (winner) winner.winner = true

  const base = winner ? winner.amountOnDate : 0
  const applicable = SURCHARGE_RULES.filter((rule) => rule.appliesTo(input.date)).map(
    (rule) => ({
      name: rule.name,
      describe: rule.describe,
      amount: rule.kind === "percent" ? (base * rule.value) / 100 : rule.value,
    }),
  )
  // Highest wins on overlap.
  applicable.sort((a, b) => b.amount - a.amount)
  const surcharge = applicable[0]
  const vatRate = product?.vatRate ?? 0.25
  const subtotal = base + (surcharge?.amount ?? 0)
  const vat = subtotal * vatRate
  return {
    verdicts: verdicts.sort((a, b) => b.score - a.score),
    winner,
    surcharge,
    base,
    vatRate,
    vat,
    total: subtotal + vat,
  }
}

export const INVOICES: InvoiceFixture[] = [
  {
    id: "inv-2026-0142",
    number: "INV-2026-0142",
    customer: "Østerbro Housing Association",
    zone: "Zone North",
    customerType: "Household",
    issued: "2026-08-01",
    status: "Sent",
    lines: [
      // Negotiated €15.90 row wins over the Zone North variation.
      { productId: "p-res-240", qty: 112, date: "2026-07-15" },
      { productId: "p-clean", qty: 14, date: "2026-07-01" },
      // 2026-07-18 is a Saturday — the weekend surcharge shows up in Explain.
      { productId: "p-bulky", qty: 2, date: "2026-07-18" },
    ],
  },
  {
    id: "inv-2026-0155",
    number: "INV-2026-0155",
    customer: "Nørrebro CoWork ApS",
    zone: "City Centre",
    customerType: "Commercial",
    issued: "2026-08-05",
    status: "Draft",
    lines: [
      // Two-condition row (City Centre + Commercial, €26.00) beats both singles.
      { productId: "p-res-240", qty: 8, date: "2026-07-10" },
      // Negotiated €39.00 for Nørrebro CoWork wins.
      { productId: "p-bulky", qty: 1, date: "2026-07-22" },
    ],
  },
]

// --- Fixtures (honest municipal-scale sample, per spec §5) ---

export function makeFixtureDb(): PrototypeDb {
  const products: Product[] = [
    {
      id: "p-res-240",
      name: "Residual waste · 240L bin",
      type: "Container collection",
      unit: "pickup",
      vatRate: 0.25,
      invoiceName: "Residual waste collection 240L",
      invoiceCode: "RES-240",
      status: "Active",
      extras: {
        materials: ["240L bin (rental)"],
        services: ["Bin cleaning · monthly"],
        serviceLevels: ["Standard kerbside", "Backdoor service"],
      },
      history: [
        {
          at: "2026-06-15",
          who: "Mette Holm",
          what: "Adjust prices · +3% scheduled for 1 Jan 2027",
          diffs: [{ field: "Default price", from: "€18.50", to: "€19.06 (scheduled)" }],
        },
        {
          at: "2026-02-03",
          who: "Mette Holm",
          what: "Negotiated deal added for Østerbro Housing Association",
          diffs: [{ field: "Rows", from: "5", to: "6" }],
        },
        { at: "2025-11-02", who: "Jonas Friis", what: "Product created (Quick create)" },
      ],
    },
    {
      id: "p-card-660",
      name: "Cardboard · 660L container",
      type: "Container collection",
      unit: "pickup",
      vatRate: 0.25,
      invoiceName: "Cardboard collection 660L",
      invoiceCode: "CRD-660",
      status: "Active",
      extras: {
        materials: ["660L container (rental)"],
        services: [],
        serviceLevels: ["Standard kerbside"],
      },
      history: [
        { at: "2025-11-02", who: "Jonas Friis", what: "Product created (Quick create)" },
      ],
    },
    {
      id: "p-glass",
      name: "Glass igloo emptying",
      type: "Container collection",
      unit: "pickup",
      vatRate: 0.25,
      invoiceName: "Glass igloo emptying",
      invoiceCode: "GLS-IGL",
      status: "Active",
      extras: { materials: [], services: [], serviceLevels: ["Crane emptying"] },
      history: [
        { at: "2025-12-10", who: "Mette Holm", what: "Product created (Guided setup)" },
      ],
    },
    {
      id: "p-clean",
      name: "Bin cleaning · monthly",
      type: "Recurring service",
      unit: "month",
      vatRate: 0.25,
      invoiceName: "Bin cleaning subscription",
      invoiceCode: "SRV-CLN",
      status: "Active",
      extras: { materials: [], services: [], serviceLevels: [] },
      history: [
        { at: "2026-01-20", who: "Jonas Friis", what: "Product created (Quick create)" },
      ],
    },
    {
      id: "p-bulky",
      name: "Bulky waste pickup",
      type: "Additional service",
      unit: "job",
      vatRate: 0.25,
      invoiceName: "Bulky waste pickup",
      invoiceCode: "SRV-BLK",
      status: "Active",
      extras: { materials: [], services: [], serviceLevels: ["Same-week", "Next-day"] },
      history: [
        {
          at: "2026-04-08",
          who: "Mette Holm",
          what: "Negotiated deal added for Nørrebro CoWork ApS",
        },
        { at: "2025-11-02", who: "Jonas Friis", what: "Product created (Quick create)" },
      ],
    },
    {
      id: "p-bagtag",
      name: "Extra bag tag",
      type: "Additional service",
      unit: "job",
      vatRate: 0.25,
      invoiceName: "Extra bag tag",
      invoiceCode: "SRV-TAG",
      status: "Active",
      extras: { materials: [], services: [], serviceLevels: [] },
      history: [
        { at: "2026-03-14", who: "Jonas Friis", what: "Product created (Quick create)" },
      ],
    },
    {
      id: "p-xmas",
      name: "Christmas tree collection",
      type: "Additional service",
      unit: "job",
      vatRate: 0.25,
      invoiceName: "Christmas tree collection",
      invoiceCode: "SRV-XMS",
      status: "Draft",
      extras: { materials: [], services: [], serviceLevels: [] },
      history: [
        { at: "2026-08-01", who: "Mette Holm", what: "Product created (Quick create)" },
      ],
    },
  ]

  const priceRows: PriceRow[] = [
    // Residual 240L — default + 5 variations, one negotiated, default has a scheduled change
    {
      id: "row-res-default",
      productId: "p-res-240",
      amount: 18.5,
      conditions: {},
      effectiveFrom: "2026-01-01",
      tag: "PL-Copenhagen-2026",
      scheduled: { newAmount: 19.06, from: "2027-01-01", note: "+3% annual adjustment" },
    },
    {
      id: "row-res-north",
      productId: "p-res-240",
      amount: 17.25,
      conditions: { zone: "Zone North" },
      effectiveFrom: "2026-01-01",
      tag: "PL-Copenhagen-2026",
    },
    {
      id: "row-res-centre",
      productId: "p-res-240",
      amount: 21.0,
      conditions: { zone: "City Centre" },
      effectiveFrom: "2026-01-01",
      tag: "PL-Copenhagen-2026",
    },
    {
      id: "row-res-com",
      productId: "p-res-240",
      amount: 24.5,
      conditions: { customerType: "Commercial" },
      effectiveFrom: "2026-01-01",
      tag: "PL-Copenhagen-2026",
    },
    {
      id: "row-res-centre-com",
      productId: "p-res-240",
      amount: 26.0,
      conditions: { zone: "City Centre", customerType: "Commercial" },
      effectiveFrom: "2026-03-01",
      tag: "PL-Copenhagen-2026",
    },
    {
      id: "row-res-osterbro",
      productId: "p-res-240",
      amount: 15.9,
      conditions: {},
      negotiatedCustomer: "Østerbro Housing Association",
      effectiveFrom: "2026-02-03",
      effectiveTo: "2027-02-02",
      tag: "Negotiated · Østerbro Housing",
    },
    // Cardboard 660L
    {
      id: "row-card-default",
      productId: "p-card-660",
      amount: 24.0,
      conditions: {},
      effectiveFrom: "2026-01-01",
      tag: "PL-Copenhagen-2026",
    },
    {
      id: "row-card-amager",
      productId: "p-card-660",
      amount: 22.5,
      conditions: { zone: "Amager" },
      effectiveFrom: "2026-01-01",
      tag: "PL-Copenhagen-2026",
    },
    {
      id: "row-card-muni",
      productId: "p-card-660",
      amount: 20.0,
      conditions: { customerType: "Municipal" },
      effectiveFrom: "2026-01-01",
      tag: "PL-Copenhagen-2026",
    },
    // Glass igloo
    {
      id: "row-glass-default",
      productId: "p-glass",
      amount: 41.0,
      conditions: {},
      effectiveFrom: "2026-01-01",
      tag: "PL-Copenhagen-2026",
    },
    {
      id: "row-glass-harbor",
      productId: "p-glass",
      amount: 46.0,
      conditions: { zone: "Harbor" },
      effectiveFrom: "2026-01-01",
      tag: "PL-Harbor-2026",
    },
    {
      id: "row-glass-igloo3",
      productId: "p-glass",
      amount: 52.0,
      conditions: { containerType: "Igloo 3m³" },
      effectiveFrom: "2026-01-01",
      tag: "PL-Copenhagen-2026",
    },
    // Bin cleaning
    {
      id: "row-clean-default",
      productId: "p-clean",
      amount: 12.0,
      conditions: {},
      effectiveFrom: "2026-01-01",
      tag: "PL-Copenhagen-2026",
    },
    {
      id: "row-clean-com",
      productId: "p-clean",
      amount: 18.0,
      conditions: { customerType: "Commercial" },
      effectiveFrom: "2026-01-01",
      tag: "PL-Copenhagen-2026",
    },
    // Bulky waste
    {
      id: "row-bulky-default",
      productId: "p-bulky",
      amount: 45.0,
      conditions: {},
      effectiveFrom: "2026-01-01",
      tag: "PL-Copenhagen-2026",
    },
    {
      id: "row-bulky-centre",
      productId: "p-bulky",
      amount: 55.0,
      conditions: { zone: "City Centre" },
      effectiveFrom: "2026-01-01",
      tag: "PL-Copenhagen-2026",
    },
    {
      id: "row-bulky-cowork",
      productId: "p-bulky",
      amount: 39.0,
      conditions: {},
      negotiatedCustomer: "Nørrebro CoWork ApS",
      effectiveFrom: "2026-04-08",
      tag: "Negotiated · Nørrebro CoWork",
    },
    {
      id: "row-bulky-organic",
      productId: "p-bulky",
      amount: 42.0,
      conditions: { wasteFraction: "Organic" },
      effectiveFrom: "2026-01-01",
      tag: "PL-Copenhagen-2026",
    },
    // Extra bag tag — born priced, default only
    {
      id: "row-bagtag-default",
      productId: "p-bagtag",
      amount: 3.5,
      conditions: {},
      effectiveFrom: "2026-01-01",
      tag: "PL-Copenhagen-2026",
    },
    // Christmas trees — draft
    {
      id: "row-xmas-default",
      productId: "p-xmas",
      amount: 15.0,
      conditions: {},
      effectiveFrom: "2027-01-02",
    },
  ]

  const contractorPrices: ContractorPrice[] = [
    {
      id: "cp-nordren-res",
      contractor: "NordRen A/S",
      productId: "p-res-240",
      contractArea: "CA-Ø-2",
      bid: 11.2,
      currentFee: 11.76,
      unit: "pickup",
      validFrom: "2025-01-01",
      validUntil: "2027-12-31",
      lastIndexed: "2026-03-01",
      lastIndexNote: "CPI +5%",
      components: [
        { label: "Base collection", detail: "€10.00 flat per pickup" },
        { label: "Fuel adjustment", detail: "8% of base" },
        { label: "Tonnage (metered)", detail: "€4.20/t × ~86 t measured monthly" },
      ],
      indexation: [
        { at: "2026-03-01", note: "CPI +5%", from: 11.2, to: 11.76, base: "bid" },
      ],
    },
    {
      id: "cp-nordren-card",
      contractor: "NordRen A/S",
      productId: "p-card-660",
      contractArea: "CA-Ø-2",
      bid: 14.0,
      currentFee: 14.0,
      unit: "pickup",
      validFrom: "2025-01-01",
      validUntil: "2027-12-31",
      components: [
        { label: "Base collection", detail: "€14.00 flat per pickup" },
        { label: "Baling (metered)", detail: "€2.10/t × ~31 t measured monthly" },
      ],
      indexation: [],
    },
    {
      id: "cp-nordren-glass",
      contractor: "NordRen A/S",
      productId: "p-glass",
      contractArea: "CA-Ø-2",
      bid: 28.5,
      currentFee: 28.5,
      unit: "pickup",
      validFrom: "2025-06-01",
      validUntil: "2027-12-31",
      components: [{ label: "Crane emptying", detail: "€28.50 flat per emptying" }],
      indexation: [],
    },
    {
      id: "cp-cityhaul-res",
      contractor: "CityHaul ApS",
      productId: "p-res-240",
      contractArea: "CA-AM-1",
      bid: 12.4,
      currentFee: 12.77,
      unit: "pickup",
      validFrom: "2025-01-01",
      validUntil: "2026-12-31",
      lastIndexed: "2026-05-01",
      lastIndexNote: "Fuel +3%",
      components: [
        { label: "Base collection", detail: "€11.10 flat per pickup" },
        { label: "Fuel adjustment", detail: "12% of base" },
      ],
      indexation: [
        { at: "2026-05-01", note: "Fuel +3%", from: 12.4, to: 12.77, base: "current fee" },
      ],
    },
    {
      id: "cp-cityhaul-bulky",
      contractor: "CityHaul ApS",
      productId: "p-bulky",
      contractArea: "CA-AM-1",
      bid: 31.0,
      currentFee: 31.0,
      unit: "job",
      validFrom: "2025-01-01",
      validUntil: "2026-12-31",
      components: [{ label: "Crew + vehicle", detail: "€31.00 flat per job" }],
      indexation: [],
    },
  ]

  return { products, priceRows, contractorPrices }
}
