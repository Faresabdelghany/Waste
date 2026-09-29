// Finance & Contracting's demo rows (Issue #156, decided in #143 and #127):
// the minimum approved Finance configuration, without which every consumer
// event on the Pilot blocks `no-price-list`, copied from the web prototype's
// fixtures (`apps/web/lib/data/business-modules.ts`, `commercial.price-rows`,
// and the price-list registry of `components/settings/commercial-registries-
// store.tsx`) under registry.ts's discipline. The catalogue's VAT and
// invoice fields are the products' own, in registry.ts.
//
//   Price lists. One default list per project the catalogue is in — Copenhagen
//   Central's and Harbor Commercial's — at the codes the fixtures tag their
//   rows with, `PL-Copenhagen-2026` and `PL-Harbor-2026`, named as the
//   Settings pane's registry names them (the code) and noted with its
//   description; in DKK, both projects' currency; from 2026-01-01, the day
//   the fixture rows start, open-ended.
//
//   Rows. #127's approved set and no other row: on each list the default row
//   — no condition — of Residual waste · 240L bin, Cardboard · 660L
//   container, Glass igloo emptying and Bulky waste pickup; and on
//   Copenhagen's, the two that show the resolver's precedence: the fixture's
//   Commercial row of Residual as the `organisation` customer kind (a
//   customer's kind is a person or an organisation, and a commercial
//   customer is an organisation), and the negotiated Residual row of Østerbro
//   Housing Association, which is the seeded customer Østerbro Housing by its
//   id — never a name looked up when the seed runs — its inclusive end,
//   2027-02-02, made the first day out of force; the fixture tags it with a
//   list of its own ("Negotiated · Østerbro Housing"), and it sits on
//   Copenhagen's default list here, where #127 put it. The fixtures tag every
//   default row to PL-Copenhagen-2026 alone; the per-project split is this
//   seed's, so Harbor's list repeats Copenhagen's four default amounts on
//   Harbor's products. An amount's numerals are copied as DKK minor units —
//   18.50 is 1 850 øre — a deliberate Pilot adaptation of the fixtures' euro
//   figures, not a currency conversion: demo values, not validated pricing.
//
//   Left out, outside #127's set: the zone rows (Zone North, City Centre,
//   Amager, Harbor — zones left the Price Lists UI with #127), the other
//   customer-type rows (Municipal is no customer kind), the two other
//   variations of the four products — Glass igloo emptying for the Igloo
//   3m³ container type, Bulky waste pickup for Organic — the scheduled +3 %
//   change of 2027-01-01, the Nørrebro CoWork negotiated row (no such
//   customer is seeded), and every row of a product outside the four. The
//   Settings pane's zones, customer types and service levels are a store the
//   browser keeps alone. Never seeded, being the running Pilot's: service
//   areas and their assignments, provider prices, billable events, billing
//   runs, invoices, settlements.
import type { CustomerKind } from "@waste/domain/registry/vocabulary"
import { addDays } from "@waste/domain/route-schemes/recurrence"

import type { Tx } from "../client"
import { priceList, priceListRow } from "../schema/finance"
import { counted, DEMO_COMPANY_ID, DEMO_PROJECT_IDS, keyed, required } from "./ids"
import { REGISTRY_IDS, type RegistryProject } from "./registry"
import { upsertOwned } from "./upsert"

const COMPANY_ID = DEMO_COMPANY_ID

/** An amount's numerals as minor units: `18.50` is 1850. */
function minorUnitsOf(amount: string): number {
  const match = /^(\d+)\.(\d{2})$/.exec(amount)
  if (!match) throw new Error(`finance seed: ${amount} is not an amount with two decimals`)
  return Number(match[1]) * 100 + Number(match[2])
}

type RowSpec = {
  key: string
  product: string
  /** The fixture's Amount. */
  amount: string
  customerKind?: CustomerKind
  /** A customer key: the negotiated row's. */
  customer?: string
  validFrom: string
  /** The fixture's inclusive last day, where it has one. */
  validThrough?: string
}
const RESIDUAL: RowSpec = { key: "price-row-res-default", product: "product-res-240", amount: "18.50", validFrom: "2026-01-01" }
const RESIDUAL_ORGANISATION: RowSpec = { key: "price-row-res-com", product: "product-res-240", amount: "24.50", customerKind: "organisation", validFrom: "2026-01-01" }
const RESIDUAL_OSTERBRO: RowSpec = {
  key: "price-row-res-osterbro",
  product: "product-res-240",
  amount: "15.90",
  customer: "company-osterbro-housing",
  validFrom: "2026-02-03",
  validThrough: "2027-02-02",
}
const CARDBOARD: RowSpec = { key: "price-row-card-default", product: "product-card-660", amount: "24.00", validFrom: "2026-01-01" }
const GLASS: RowSpec = { key: "price-row-glass-default", product: "product-glass-igloo", amount: "41.00", validFrom: "2026-01-01" }
const BULKY: RowSpec = { key: "price-row-bulky-default", product: "product-bulky", amount: "45.00", validFrom: "2026-01-01" }

type ListSpec = { key: string; project: RegistryProject; code: string; description: string; rows: readonly RowSpec[] }
const LISTS: readonly ListSpec[] = [
  {
    key: "price-list-copenhagen-2026",
    project: "copenhagen",
    code: "PL-Copenhagen-2026",
    description: "Annual tariff for Copenhagen municipal collection.",
    rows: [RESIDUAL, RESIDUAL_ORGANISATION, RESIDUAL_OSTERBRO, CARDBOARD, GLASS, BULKY],
  },
  { key: "price-list-harbor-2026", project: "harbor", code: "PL-Harbor-2026", description: "Annual tariff for the Harbor service area.", rows: [RESIDUAL, CARDBOARD, GLASS, BULKY] },
]

/** The day every list is in force from. */
const LISTS_FROM = "2026-01-01"

/* --------------------------------- rows ----------------------------------- */

/** Every Finance id, keyed by the prototype's record id. */
export type FinanceIds = {
  priceLists: Readonly<Record<string, string>>
  /** Per project, as the catalogue's products are: a fixture row is on each list it is copied to. */
  priceListRows: Readonly<Record<RegistryProject, Readonly<Record<string, string>>>>
}

type FinanceRows = {
  priceLists: (typeof priceList.$inferInsert)[]
  priceListRows: (typeof priceListRow.$inferInsert)[]
}

/** How many rows the Finance seed holds per table. */
export type FinanceCounts = { [K in keyof FinanceRows]: number }

function build(): { ids: FinanceIds; rows: FinanceRows } {
  const listIds = keyed(LISTS, (spec) => spec.key, "priceList")
  const next = counted("priceListRow")
  const rowIds = Object.fromEntries(LISTS.map((list) => [list.project, Object.fromEntries(list.rows.map((row) => [row.key, next()]))])) as Record<RegistryProject, Record<string, string>>

  return {
    ids: { priceLists: listIds, priceListRows: rowIds },
    rows: {
      priceLists: LISTS.map((spec) => ({
        id: required(listIds, spec.key, "price list"),
        companyId: COMPANY_ID,
        projectId: DEMO_PROJECT_IDS[spec.project],
        validFrom: LISTS_FROM,
        validTo: null,
        code: spec.code,
        name: spec.code,
        currency: "DKK",
        isDefault: true,
        notes: spec.description,
      })),
      priceListRows: LISTS.flatMap((list) =>
        list.rows.map((spec) => ({
          id: required(rowIds[list.project], spec.key, `${list.project} price row`),
          companyId: COMPANY_ID,
          projectId: DEMO_PROJECT_IDS[list.project],
          validFrom: spec.validFrom,
          validTo: spec.validThrough === undefined ? null : addDays(spec.validThrough, 1),
          priceListId: required(listIds, list.key, "price list"),
          productId: required(REGISTRY_IDS.products[list.project], spec.product, `${list.project} product`),
          unitPriceMinor: minorUnitsOf(spec.amount),
          planningAreaId: null,
          customerKind: spec.customerKind ?? null,
          containerTypeId: null,
          wasteFractionId: null,
          customerId: spec.customer === undefined ? null : required(REGISTRY_IDS.customers, spec.customer, "customer"),
          note: null,
        })),
      ),
    },
  }
}

const built = build()

/** Every Finance id the seed writes. */
export const FINANCE_IDS: FinanceIds = built.ids

const FINANCE_ROWS: Readonly<FinanceRows> = built.rows

export const FINANCE_COUNTS: FinanceCounts = Object.fromEntries(Object.entries(built.rows).map(([table, rows]) => [table, rows.length])) as FinanceCounts

/** Writes Finance into an open transaction, after the Registry whose products and customers its rows name, and answers how many rows it changed. */
export async function applyFinance(tx: Tx): Promise<number> {
  const rows = FINANCE_ROWS
  let changed = 0
  // A list's `code` is set once (finance.ts of the schema): spelled on insert, never rewritten.
  changed += await upsertOwned(tx, priceList, rows.priceLists, [priceList.validFrom, priceList.validTo, priceList.name, priceList.currency, priceList.isDefault, priceList.notes])
  changed += await upsertOwned(tx, priceListRow, rows.priceListRows, [
    priceListRow.validFrom,
    priceListRow.validTo,
    priceListRow.priceListId,
    priceListRow.productId,
    priceListRow.unitPriceMinor,
    priceListRow.planningAreaId,
    priceListRow.customerKind,
    priceListRow.containerTypeId,
    priceListRow.wasteFractionId,
    priceListRow.customerId,
    priceListRow.note,
  ])
  return changed
}
