# Products & Prices Real Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the verified Variant A Products & Prices prototype with the real implementation inside the app's canonical machinery — products, price rows and contractor prices become registry-backed `BusinessRecord`s persisted through the record store, rendered by the **generic workspace views the whole system already uses**; product management moves to Settings; the Commercial workspace is relabeled **Price Engine**; the prototype folder is deleted at the end.

**Architecture:** Three layers. (1) `lib/commercial/` — a typed price model with record⇄model converters plus the ported §4.4 resolution engine, gated by an in-repo tsx harness. (2) A single atomic registry cutover in `lib/data/` — the `products` module reworked, `pricing` retired, `price-rows` and `contractor-prices` modules added, form schemas swapped in the same commit (the schema integrity gate requires exactly one schema per public module). (3) Flows through existing machinery only — the generic module table (fact columns), the generic record detail sheet, `BusinessRecordFormDialog` for every form (create, edit, Adjust prices, Apply index), `recordKind` branches in `handleFormSubmit` for the two flows that compute money (the established "Contract area assignment" pattern), and `RelatedRecordsTable` for the contractor Prices tab.

**Tech stack:** Next.js App Router, TypeScript, Tailwind CSS v4, shadcn/ui, `tsx` for the harness. No test framework exists — the gates are `npx tsc --noEmit`, `npx tsx scripts/price-resolution-harness.ts`, and a browser walkthrough.

**Spec:** `docs/superpowers/specs/2026-08-19-products-prices-redesign-design.md` (§4 design, §5 real-build constraint map, §6 conscious cuts, §10 verdict + follow-ups). The spec travels with this plan; executors read both. Where this plan and the spec's presentation details disagree, the 2026-08-20 decisions below win.

## Decisions this plan encodes (Fares, 2026-08-20 planning session)

Binding for every task:

1. **Generic views only.** Fares, verbatim: *"we will use the UI components that we have and all what we have already — don't add new components, don't create new things; we will use the same list, same filters, views that we have in all system."* Concretely: the workspace modules render through the standard `BusinessWorkspace` table, search, view options and record detail sheet — no custom module bodies, no custom filter bars, no custom full-page product detail, no row-selection checkboxes, no bespoke dialogs. The prototype's custom UI (catalogue table, detail page, Vary/Schedule/Negotiate/Adjust dialogs, contractor lane, rate sheet) is **not ported**; its data model and flows are re-expressed through records, schemas and the existing form dialog.
2. **Settings owns the product catalogue.** Settings → Commercial → Products is the management surface: users **add and edit products there** (identity, attributes, invoice & tax, born-priced default price). The workspace consumes those products.
3. **The workspace is renamed "Price Engine"** (sidebar + workspace label). Label-only: workspace id stays `commercial`, route stays `/commercial`, module ids unchanged. Name swappable at review.
4. Standing spec decisions stay: **Explain-a-price UI stays cut** (engine survives in `lib/` + harness), the products table carries the **four attribute columns** (Container, Container type, Customer, Waste fraction — as facts), price lists remain **tags + a derived settings index**, and the Settings **Commercial section** (Products / Zones / Service / Customer types) exists alongside Commercial defaults.

Consequences worth naming so nobody "fixes" them:
- **Price rows become a visible module** ("Price rows" tab in Price Engine). With no custom product detail page, rows must be workable through the standard views; §4.1 supports this (rows are adjusted repeatedly → workspace). Vary this price / Negotiated deal collapse into the module's generic **New price row** form; Schedule a change is the generic **edit** of a row's scheduled fields.
- **Adjust prices** and **Apply index** are schema-driven dialogs (existing `BusinessRecordFormDialog`, review step via the existing `reviewBeforeSubmit` mechanism) with the math in `handleFormSubmit` `recordKind` branches. Bulk scope is chosen **inside the form** (tag / product multiselect), not by table checkboxes.
- The product's **Customer** and **Variations** columns are denormalized facts on the product record, kept in sync by the write paths (generic fact columns can't join across modules).
- **Bid immutability falls out of the machinery**: the contractor-prices module's registered schema is the Apply-index action schema, so the generic edit path never opens for those records.

**Still deferred** (spec §6 + handoff, do not build): guided-setup stepper, Agreement surfacing of negotiated deals, per-row invoice override disclosure, group-by-tag, New-contractor-price creation flow, xlsx import/export, margin strip, named change sets, performance-formula editing. The real `invoices` module is **untouched**.

## Global Constraints

- **Generic views only** (decision 1 above) — the strongest constraint in this plan. New client code is limited to: the `lib/commercial/` logic, schema/registry data, `handleFormSubmit` branches, small wiring (header-button swap, related-tab data plumbing), and the Settings pane (Settings has its own established custom-pane idiom — `AssetManagementSettings` precedent — and Fares explicitly asked for product management there).
- **Domain language** per `CONTEXT.md`: Agreement (never Subscription), **Contractor price** (never "rates" in UI copy), Contract Area, Price list (a tag on rows + a derived index), Billable Event.
- **§4.4 resolution rule** (exact copy, shown in module rules and enforced by the engine): "The row matching the most conditions wins. A negotiated row for the specific customer always wins. Remaining ties go to the row with the newest effective-from date."
- **Negotiated rows are excluded by default** from bulk adjustments (opt-in checkbox with warning copy). **The bid is contractually immutable.**
- **Registry mechanics** (spec §5): every fixture record id must be registered in a scope array in `lib/data/business-modules.ts` (`copenhagenFixtureRecordIds` / `harborFixtureRecordIds` / `companyWideFixtureRecordIds`) or `record()` throws; contractor-owned records also map in `fixtureContractorIdByRecordId`. The schema gate in `lib/data/business-form-schemas.ts` demands exactly one schema per `workspaceId.moduleId` in `publicWorkspaceDomains` — **`business-domain.ts`, `business-modules.ts` and the schema files change in the same task**.
- **Gates:** `npx tsc --noEmit` exit 0 is the only type gate (`pnpm build` ignores TS errors; eslint is broken; no test suite). Plus `npx tsx scripts/price-resolution-harness.ts` (added by Task 1) and browser verification per task. A dev server is usually already on :3000 (`curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/`); if the volta pnpm shim fails, `npm run dev` works.
- **Persistence:** only via `BusinessRecordStoreProvider` (`getRecords`/`upsertRecord`, localStorage key `wastehero-business-records-v1`). No new storage keys. Client-created records may omit companyId/projectIds.
- **Money display:** `€` two decimals (`money()`), unit suffixes `/pickup`, `/mo`, `/job`.
- The prototype folder `components/wastehero/products-prices-prototype/` **stays in the tree until the final task** — fixture values are ported from it by line reference. Never import from it in new code.
- Browser verification: **serialize Playwright**; clear `wastehero-business-records-v1` when stale created records confuse a check; the intermittent radix-useId hydration warning is pre-existing app chrome noise — leave it.

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `lib/commercial/price-model.ts` | Typed price domain: model types, registry constants, fact-key maps, record⇄model converters, history/indexation codecs, pure helpers |
| `lib/commercial/price-resolution.ts` | The §4.4 engine: `resolvePrice`, `SURCHARGE_RULES` |
| `scripts/price-resolution-harness.ts` | In-repo harness (replaces `/tmp/resolution-scenarios.ts`): engine scenarios + registry/converter/adjust checks; exit 1 on failure |
| `components/settings/commercial-settings.tsx` | `CommercialDefaultsExtras` + `CommercialSectionPane` incl. the Products management pane (settings-pane idiom, `AssetManagementSettings` precedent) |

**Modify:** `lib/data/business-domain.ts` · `lib/data/business-modules.ts` · `lib/data/business-form-schemas-commercial-improve.ts` · `lib/data/business-form-schemas.ts` · `lib/data/business-form-schemas-customers-resources.ts` · `lib/data/business-links.ts` · `lib/data/sidebar.ts` · `components/wastehero/business-workspace.tsx` · `components/wastehero/contractor-details-page.tsx` · `components/settings/SettingsDialog.tsx` · `app/commercial/page.tsx`

**Delete (final task only):** `components/wastehero/products-prices-prototype/` (all 7 files).

**Explicitly NOT created** (decision 1): no products-catalogue component, no product-details page, no price-row dialogs, no contractor-prices lane/sheet, no contractor-prices-tab component, no shared badge/chip atoms.

---

### Task 1: Price model + resolution engine + harness (`lib/commercial/`)

**Files:**
- Create: `lib/commercial/price-model.ts`
- Create: `lib/commercial/price-resolution.ts`
- Create: `scripts/price-resolution-harness.ts`
- Reference (read-only): `components/wastehero/products-prices-prototype/prototype-data.ts` (engine 286–423, helpers 160–284, constants 99–156)

**Interfaces:**
- Consumes: `BusinessRecord` type from `@/lib/data/business-modules` (type-only import).
- Produces (used by Tasks 2–4 — exact names):
  - Types: `ProductType`, `PriceUnit`, `PriceConditions`, `ScheduledChange`, `PriceRowModel`, `ProductModel`, `ContractorPriceModel`, `HistoryEntry`, `ResolveInput`, `RowVerdict`, `Resolution`
  - Constants: `PRICING_REFERENCE_DATE`, `ZONES`, `CUSTOMER_TYPES`, `CONTAINER_TYPES`, `WASTE_FRACTIONS`, `PRICE_LIST_TAGS`, `KNOWN_CUSTOMERS`, `COMMERCIAL_DEFAULTS`, `CONTRACTOR_PERFORMANCE`, `RESOLUTION_RULE`, `ROW_FACTS`, `PRODUCT_FACTS`, `RATE_FACTS`, `COMPONENT_FACT_PREFIX`, `HISTORY_PREFIX`, `INDEXED_PREFIX`
  - Functions: `money`, `unitSuffix`, `computeAdjusted`, `conditionLabels`, `rowDisplayName`, `rowsOf`, `defaultRowOf`, `variationsOf`, `negotiatedCustomersOf`, `priceListIndex`, `recordToPriceRow`, `priceRowToRecord`, `recordToProduct`, `recordToContractorPrice`, `contractorPriceToRecord`, `encodeHistory`, `decodeHistory`, `encodeIndexation`, `decodeIndexation`, `applyIndexToRate`; from price-resolution: `resolvePrice`, `SURCHARGE_RULES`

- [ ] **Step 1: Write the failing harness**

Create `scripts/price-resolution-harness.ts` — it imports the not-yet-existing lib, so it fails first. Full content (the durable replacement for `/tmp/resolution-scenarios.ts`; scenario rows mirror the registry fixtures Task 2 installs):

```ts
// Headless checks for the Price Engine pricing lib (spec §4.4 resolution rule,
// §4.2 bulk-adjust math, surcharges, effective dating) plus, from Task 2 on,
// registry/converter integration checks. Run: npx tsx scripts/price-resolution-harness.ts
import {
  computeAdjusted,
  type PriceRowModel,
} from "../lib/commercial/price-model"
import { resolvePrice } from "../lib/commercial/price-resolution"

let passed = 0
let failed = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) passed += 1
  else failed += 1
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`)
}

const rows: PriceRowModel[] = [
  { id: "price-row-res-default", productId: "product-res-240", amount: 18.5, unit: "pickup", conditions: {}, effectiveFrom: "2026-01-01", tag: "PL-Copenhagen-2026", scheduled: { newAmount: 19.06, from: "2027-01-01", note: "+3% annual adjustment" } },
  { id: "price-row-res-north", productId: "product-res-240", amount: 17.25, unit: "pickup", conditions: { zone: "Zone North" }, effectiveFrom: "2026-01-01", tag: "PL-Copenhagen-2026" },
  { id: "price-row-res-centre", productId: "product-res-240", amount: 21.0, unit: "pickup", conditions: { zone: "City Centre" }, effectiveFrom: "2026-01-01", tag: "PL-Copenhagen-2026" },
  { id: "price-row-res-com", productId: "product-res-240", amount: 24.5, unit: "pickup", conditions: { customerType: "Commercial" }, effectiveFrom: "2026-01-01", tag: "PL-Copenhagen-2026" },
  { id: "price-row-res-centre-com", productId: "product-res-240", amount: 26.0, unit: "pickup", conditions: { zone: "City Centre", customerType: "Commercial" }, effectiveFrom: "2026-03-01", tag: "PL-Copenhagen-2026" },
  { id: "price-row-res-osterbro", productId: "product-res-240", amount: 15.9, unit: "pickup", conditions: {}, negotiatedCustomer: "Østerbro Housing Association", effectiveFrom: "2026-02-03", effectiveTo: "2027-02-02", tag: "Negotiated · Østerbro Housing" },
  { id: "price-row-glass-default", productId: "product-glass-igloo", amount: 41.0, unit: "pickup", conditions: {}, effectiveFrom: "2026-01-01", tag: "PL-Copenhagen-2026" },
  { id: "price-row-glass-igloo3", productId: "product-glass-igloo", amount: 52.0, unit: "pickup", conditions: { containerType: "Igloo 3m³" }, effectiveFrom: "2026-01-01", tag: "PL-Copenhagen-2026" },
  { id: "price-row-bulky-default", productId: "product-bulky", amount: 45.0, unit: "job", conditions: {}, effectiveFrom: "2026-01-01", tag: "PL-Copenhagen-2026" },
  { id: "price-row-bulky-organic", productId: "product-bulky", amount: 42.0, unit: "job", conditions: { wasteFraction: "Organic" }, effectiveFrom: "2026-01-01", tag: "PL-Copenhagen-2026" },
  { id: "price-row-bagtag-default", productId: "product-bagtag", amount: 3.5, unit: "job", conditions: {}, effectiveFrom: "2026-01-01", tag: "PL-Copenhagen-2026" },
  { id: "price-row-xmas-default", productId: "product-xmas", amount: 15.0, unit: "job", conditions: {}, effectiveFrom: "2027-01-02" },
]
const of = (productId: string) => rows.filter((row) => row.productId === productId)

// 1. Most conditions wins: City Centre + Commercial beats both single-condition rows.
{
  const r = resolvePrice(of("product-res-240"), 0.25, { zone: "City Centre", customerType: "Commercial", date: "2026-08-19" })
  check("most-conditions wins (2-cond row €26.00)", [r.winner?.row.id, r.base], ["price-row-res-centre-com", 26.0])
}
// 2. Negotiated always wins, despite fewer matched conditions.
{
  const r = resolvePrice(of("product-res-240"), 0.25, { zone: "Zone North", customerType: "Household", customer: "Østerbro Housing Association", date: "2026-08-19" })
  check("negotiated row always wins (€15.90)", [r.winner?.row.id, r.base], ["price-row-res-osterbro", 15.9])
}
// 3. Same negotiated row is ineligible for a different customer; zone row wins instead.
{
  const r = resolvePrice(of("product-res-240"), 0.25, { zone: "Zone North", customerType: "Household", customer: "Nørrebro CoWork ApS", date: "2026-08-19" })
  const negotiated = r.verdicts.find((v) => v.row.id === "price-row-res-osterbro")
  check("negotiated row disqualified for other customers", [r.winner?.row.id, negotiated?.eligible], ["price-row-res-north", false])
}
// 4. Scheduled amount applies on/after its from-date (default €18.50 → €19.06 from 2027-01-01).
{
  const before = resolvePrice(of("product-res-240"), 0.25, { zone: "Amager", customerType: "Household", date: "2026-12-30" })
  const after = resolvePrice(of("product-res-240"), 0.25, { zone: "Amager", customerType: "Household", date: "2027-01-05" })
  check("scheduled amount applies on future dates", [before.base, after.base], [18.5, 19.06])
}
// 5. Weekend surcharge applied before VAT (2026-08-22 is a Saturday).
{
  const r = resolvePrice(of("product-bulky"), 0.25, { zone: "Amager", customerType: "Household", date: "2026-08-22" })
  check("weekend surcharge +15% before VAT", [r.base, r.surcharge?.amount, r.total], [45.0, 6.75, (45.0 + 6.75) * 1.25])
}
// 6. Flat holiday surcharge (2026-12-24) applies; percent rule does not (Thursday).
{
  const r = resolvePrice(of("product-bagtag"), 0.25, { zone: "Amager", customerType: "Household", date: "2026-12-24" })
  check("flat holiday surcharge +€25", [r.base, r.surcharge?.amount], [3.5, 25])
}
// 7. Container-type condition wins for the matching container.
{
  const r = resolvePrice(of("product-glass-igloo"), 0.25, { zone: "City Centre", customerType: "Municipal", containerType: "Igloo 3m³", date: "2026-08-19" })
  check("container-type condition (€52.00)", [r.winner?.row.id, r.base], ["price-row-glass-igloo3", 52.0])
}
// 8. Waste-fraction condition wins when provided; default without.
{
  const withFraction = resolvePrice(of("product-bulky"), 0.25, { zone: "Amager", customerType: "Household", wasteFraction: "Organic", date: "2026-08-19" })
  const withoutFraction = resolvePrice(of("product-bulky"), 0.25, { zone: "Amager", customerType: "Household", date: "2026-08-19" })
  check("waste-fraction condition (€42.00, default without)", [withFraction.winner?.row.id, withFraction.base, withoutFraction.base], ["price-row-bulky-organic", 42.0, 45.0])
}
// 9. Not-yet-effective rows are unsellable (draft Christmas trees, effective 2027-01-02).
{
  const r = resolvePrice(of("product-xmas"), 0.25, { zone: "Amager", customerType: "Household", date: "2026-08-19" })
  check("not-yet-effective → no sellable row", [r.winner ?? null, r.base], [null, 0])
}
// 10. Expired negotiated deal (effectiveTo 2027-02-02) falls back to the zone row.
{
  const r = resolvePrice(of("product-res-240"), 0.25, { zone: "Zone North", customerType: "Household", customer: "Østerbro Housing Association", date: "2027-03-01" })
  check("expired negotiated row falls back to zone row", [r.winner?.row.id, r.base], ["price-row-res-north", 17.25])
}
// 11. Equal-specificity tie breaks to the newest effective-from.
{
  const synthetic: PriceRowModel[] = [
    { id: "syn-old", productId: "product-bagtag", amount: 4.0, unit: "job", conditions: { zone: "Harbor" }, effectiveFrom: "2026-01-01" },
    { id: "syn-new", productId: "product-bagtag", amount: 4.5, unit: "job", conditions: { customerType: "Municipal" }, effectiveFrom: "2026-06-01" },
  ]
  const r = resolvePrice([...of("product-bagtag"), ...synthetic], 0.25, { zone: "Harbor", customerType: "Municipal", date: "2026-08-19" })
  check("tie → newest effective-from wins", [r.winner?.row.id, r.base], ["syn-new", 4.5])
}
// 12. Bulk-adjust math: percent / fixed / multiply, cents + €0.05 rounding.
{
  check("adjust +3% (cents rounding)", computeAdjusted(18.5, "percent", 3, false), 19.06)
  check("adjust +3% rounded to €0.05", computeAdjusted(18.5, "percent", 3, true), 19.05)
  check("adjust fixed +€2.00", computeAdjusted(18.5, "fixed", 2, false), 20.5)
  check("adjust multiply ×1.02", computeAdjusted(24.0, "multiply", 1.02, false), 24.48)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
```

- [ ] **Step 2: Run the harness to verify it fails**

Run: `npx tsx scripts/price-resolution-harness.ts`
Expected: FAIL — cannot find module `../lib/commercial/price-model`.

- [ ] **Step 3: Write `lib/commercial/price-model.ts`**

Full skeleton with every exported symbol; bodies marked "port from prototype-data.ts:<lines>" are mechanical ports of already-verified code, not reinventions:

```ts
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
  // port verbatim from prototype-data.ts:188–202
}
export function conditionLabels(conditions: PriceConditions): string[] {
  // port from prototype-data.ts:277–284
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
  // port from prototype-data.ts:260–268
}
export function priceListIndex(rows: readonly PriceRowModel[]): { tag: string; rows: number; effectiveFrom: string; status: string; negotiated: boolean }[] {
  // port from prototype-data.ts:160–181, using PRICING_REFERENCE_DATE instead of PROTO_TODAY
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
```

- [ ] **Step 4: Write `lib/commercial/price-resolution.ts`**

Port `explainPrice` (prototype-data.ts:286–423) as `resolvePrice` — verified algorithm, mechanical port; only the signature changes (pre-filtered rows + vatRate instead of db + productId):

```ts
import { type PriceRowModel } from "./price-model"

export type ResolveInput = {
  zone: string
  customerType: string
  containerType?: string
  wasteFraction?: string
  customer?: string
  date: string
}
export type RowVerdict = {
  row: PriceRowModel
  eligible: boolean
  reason?: string
  matched: string[]
  score: number
  winner: boolean
  amountOnDate: number
}
export type Resolution = {
  verdicts: RowVerdict[]
  winner?: RowVerdict
  surcharge?: { name: string; describe: string; amount: number }
  base: number
  vatRate: number
  vat: number
  total: number
}

export const SURCHARGE_RULES = [
  // port both rules verbatim from prototype-data.ts:133–156 (weekend +15%, holiday +€25)
]

function amountOnDate(row: PriceRowModel, date: string): number {
  // port from prototype-data.ts:318–325
}

export function resolvePrice(rows: readonly PriceRowModel[], vatRate: number, input: ResolveInput): Resolution {
  // port from prototype-data.ts:327–423 with exactly two renames:
  //   db.priceRows.filter(productId) → rows (caller pre-filters)
  //   product?.vatRate ?? 0.25      → vatRate parameter
  // Matching, reasons, score (negotiated?100:0 + condition count), sort by
  // score then effectiveFrom desc, surcharge highest-wins, subtotal + VAT:
  // all IDENTICAL to the prototype.
}
```

- [ ] **Step 5: Run the harness to verify it passes**

Run: `npx tsx scripts/price-resolution-harness.ts`
Expected: `15 passed, 0 failed`, exit 0.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add lib/commercial/ scripts/price-resolution-harness.ts
git commit -m "Add commercial price model, §4.4 resolution engine, and in-repo harness"
```

---

### Task 2: Registry cutover — modules, domain map, schemas, rename (atomic)

Everything here lands in **one commit**: the schema integrity gate throws unless `business-domain.ts` moduleIds, the schema files, and the module registry agree.

**Files:**
- Modify: `lib/data/business-domain.ts` (commercial `moduleIds` ~line 317; module domain entries ~742–754)
- Modify: `lib/data/business-modules.ts` (scope arrays 35–196; `fixtureContractorIdByRecordId` 198; commercial workspace from 2917)
- Modify: `lib/data/business-form-schemas-commercial-improve.ts` (products schema 13–173; pricing schema 174–~370)
- Modify: `lib/data/business-form-schemas.ts` (field hooks ~135, ~395–410; `actionExecutions` line 22)
- Modify: `lib/data/business-form-schemas-customers-resources.ts` (~814–822)
- Modify: `lib/data/business-links.ts` (~79–80)
- Modify: `lib/data/sidebar.ts` (line 43)
- Modify: `components/wastehero/business-workspace.tsx` (line 552 only)
- Reference (read-only): `prototype-data.ts` — fixture values: products 462–597, price rows 599–770, contractor prices 772–856

**Interfaces:**
- Consumes: Task 1's fact-key strings (fixtures must match `ROW_FACTS`/`PRODUCT_FACTS`/`RATE_FACTS` exactly) and id scheme.
- Produces: modules `commercial.products` (reworked), `commercial.price-rows` (visible), `commercial.contractor-prices`; fixture ids `product-*` (7), `price-row-*` (20), `contractor-price-*` (5); schemas `commercial.products` (create — hosted by Settings in Task 4), `commercial.price-rows` (create — "New price row"), `commercial.contractor-prices` (**action** — "Apply index"); an exported non-registered `adjustPricesFormSchema`; workspace label **Price Engine**.

- [ ] **Step 1: Extend the harness with failing registry-integration checks**

Append to `scripts/price-resolution-harness.ts`:

```ts
// --- Registry integration (Task 2): fixtures → converters → engine ---
import { businessWorkspaces } from "../lib/data/business-modules"
import { recordToContractorPrice, recordToPriceRow, recordToProduct } from "../lib/commercial/price-model"
{
  const commercial = businessWorkspaces.commercial
  const productRecords = commercial.modules.find((m) => m.id === "products")?.records ?? []
  const rowRecords = commercial.modules.find((m) => m.id === "price-rows")?.records ?? []
  const rateRecords = commercial.modules.find((m) => m.id === "contractor-prices")?.records ?? []
  const registryRows = rowRecords.map(recordToPriceRow).filter((row): row is NonNullable<typeof row> => row !== null)
  check("fixtures: 7 products, 20 rows, 5 contractor prices", [productRecords.length, registryRows.length, rateRecords.length], [7, 20, 5])
  check("fixtures: 2 negotiated rows, 1 scheduled change", [registryRows.filter((r) => r.negotiatedCustomer).length, registryRows.filter((r) => r.scheduled).length], [2, 1])
  const res240 = registryRows.filter((r) => r.productId === "product-res-240")
  const vat = recordToProduct(productRecords.find((r) => r.id === "product-res-240")!).vatRate
  const negotiated = resolvePrice(res240, vat, { zone: "Zone North", customerType: "Household", customer: "Østerbro Housing Association", date: "2026-08-19" })
  check("registry: negotiated €15.90 wins via converters", [negotiated.winner?.row.id, negotiated.base, vat], ["price-row-res-osterbro", 15.9, 0.25])
  const nordrenRes = rateRecords.find((r) => r.id === "contractor-price-nordren-res")
  const rate = nordrenRes ? recordToContractorPrice(nordrenRes) : null
  check("registry: NordRen residual bid locked €11.20, fee €11.76, 1 indexation", [rate?.bid, rate?.currentFee, rate?.indexation.length], [11.2, 11.76, 1])
}
```

Run: `npx tsx scripts/price-resolution-harness.ts` → new checks FAIL (modules missing), original 15 still pass.

- [ ] **Step 2: Update `business-domain.ts`**

Commercial workspace entry (~317), new `moduleIds`:

```ts
    moduleIds: [
      "products",
      "price-rows",
      "contractor-prices",
      "settlements",
      "events",
      "billing",
      "invoices",
    ],
```

Replace the `commercial.pricing` module-domain entry (742–754) with:

```ts
  {
    key: "commercial.price-rows",
    workspaceId: "commercial",
    moduleId: "price-rows",
    primaryBlueprintModule: "M05",
    supportingBlueprintModules: ["M16"],
    canonicalOwner: "Commercial · Price Rows",
    personas: ["Pricing manager", "Finance specialist"],
    upstream: ["M01", "M02", "M03", "M05"],
    downstream: ["M03", "M05", "M15", "M16", "M18", "M23"],
    boundaryNote:
      "One price model: every sellable price (default, variation, negotiated) is a row; the default price is a row with no conditions.",
  },
  {
    key: "commercial.contractor-prices",
    workspaceId: "commercial",
    moduleId: "contractor-prices",
    primaryBlueprintModule: "M15",
    supportingBlueprintModules: ["M05", "M23"],
    canonicalOwner: "Commercial · Contractor Prices",
    personas: ["Office contract manager", "Finance specialist", "Contractor manager"],
    upstream: ["M05", "M08", "M15"],
    downstream: ["M15", "M18", "M20", "M23"],
    boundaryNote:
      "The bid is contractually immutable; indexation changes only the current fee. Contractor Price and Settlement remain separate records.",
  },
```

Update `commercial.products` boundaryNote (~739) to: `"A Product is the sellable definition, managed in Settings; its prices are rows in the price-rows module, worked in Price Engine."`

- [ ] **Step 3: Rework the commercial modules in `business-modules.ts`**

3a. Scope arrays — remove `"price-cph-2026"`, `"price-commercial-2026"`, `"product-organic-240"`, `"product-recollection"`, `"product-sensor"`. Add:
- `companyWideFixtureRecordIds`: `"product-res-240", "product-card-660", "product-glass-igloo", "product-clean-monthly", "product-bulky", "product-bagtag", "product-xmas"`
- `copenhagenFixtureRecordIds`: all 20 `price-row-*` ids except `price-row-glass-harbor`, plus the 5 `contractor-price-*` ids
- `harborFixtureRecordIds`: `"price-row-glass-harbor"`

3b. `fixtureContractorIdByRecordId` additions:

```ts
  "contractor-price-nordren-res": FIXTURE_CONTRACTOR_IDS.nordren,
  "contractor-price-nordren-card": FIXTURE_CONTRACTOR_IDS.nordren,
  "contractor-price-nordren-glass": FIXTURE_CONTRACTOR_IDS.nordren,
  "contractor-price-cityhaul-res": FIXTURE_CONTRACTOR_IDS.cityhaul,
  "contractor-price-cityhaul-bulky": FIXTURE_CONTRACTOR_IDS.cityhaul,
```

3c. Workspace label (2918): `label: "Price Engine"`; description: `"Price the sellable catalogue, manage contractor prices and settlement, and convert delivered work into auditable money flows."`

3d. Replace the `products` module definition (2921–2989):

```ts
    {
      id: "products",
      label: "Products",
      title: "Products & Prices",
      description:
        "The sellable catalogue as the price list: the default price reads from each product's no-conditions row. Products are added and edited in Settings → Commercial → Products.",
      entityLabel: "Product",
      contextLabel: "Type · unit",
      valueLabel: "Default price",
      primaryAction: "Adjust prices",
      metrics: [
        { label: "Products", value: "7", helper: "3 fixed types" },
        { label: "Negotiated deals", value: "2", helper: "Excluded from bulk adjust by default" },
        { label: "Scheduled changes", value: "1", helper: "+3% on 2027-01-01", tone: "warning" },
        { label: "Price lists", value: "2 + 2", helper: "Annual tariffs + negotiated tags" },
      ],
      lifecycle: ["Draft", "Active", "Inactive"],
      rules: [
        "The row matching the most conditions wins. A negotiated row for the specific customer always wins. Remaining ties go to the row with the newest effective-from date.",
        "A product is born priced — the default price is a row with no conditions.",
        "Prices are effective-dated and selection is explainable.",
        "VAT and invoice fields live once, on the product.",
        "Negotiated rows are excluded from bulk adjustments unless explicitly included.",
      ],
      records: [ /* 7 product records — step 3g */ ],
    },
```

3e. Delete the `pricing` module (2990–3043); in its place:

```ts
    {
      id: "price-rows",
      label: "Price rows",
      title: "Price Rows",
      description:
        "Every sellable price is a row — default, variation, or negotiated deal — with conditions, effective dates and a price-list tag. Variations and negotiated deals are created here.",
      entityLabel: "Price row",
      contextLabel: "Product",
      valueLabel: "Amount",
      primaryAction: "New price row",
      metrics: [
        { label: "Rows", value: "20", helper: "7 defaults · 11 variations · 2 negotiated" },
        { label: "Tagged", value: "19", helper: "PL-Copenhagen-2026 · PL-Harbor-2026 · negotiated" },
        { label: "Scheduled", value: "1", helper: "Effective 2027-01-01", tone: "warning" },
        { label: "Expiring", value: "1", helper: "Negotiated deal ends 2027-02-02" },
      ],
      lifecycle: ["Scheduled", "Active", "Expired"],
      rules: [
        "The row matching the most conditions wins. A negotiated row for the specific customer always wins. Remaining ties go to the row with the newest effective-from date.",
        "One price model: the Products table's default price reads the no-conditions row.",
        "Schedule a change by editing a row's scheduled fields; the amount switches on the scheduled date.",
      ],
      records: [ /* 20 price-row records — step 3g */ ],
    },
    {
      id: "contractor-prices",
      label: "Contractor prices",
      title: "Contractor Prices",
      description:
        "What we pay per contractor × product × contract area: the contractually locked bid and the indexed current fee.",
      entityLabel: "Contractor price",
      contextLabel: "Contract area · validity",
      valueLabel: "Current fee",
      primaryAction: "Apply index",
      metrics: [
        { label: "Contractor prices", value: "5", helper: "2 contractors · 2 contract areas" },
        { label: "Indexed in 2026", value: "2", helper: "CPI +5% · Fuel +3%" },
        { label: "Bids locked", value: "5", helper: "Contractually immutable" },
        { label: "Expiring", value: "2", helper: "CA-AM-1 ends 31 Dec 2026", tone: "warning" },
      ],
      lifecycle: ["Upcoming", "Active", "Expiring", "Expired"],
      rules: [
        "The bid is contractually immutable; indexation changes only the current fee.",
        "Customer and contractor prices are separate confidential records.",
        "Each Apply index run appends to the contractor price's indexation history.",
      ],
      records: [ /* 5 contractor-price records — step 3g */ ],
    },
```

3f. Fact-key contract (must equal Task 1's maps exactly; the harness enforces it):
- **Product facts**, in this insertion order (fact order drives the generic table's column candidates): `Type`, `Container`, `Container type`, `Customer` (comma-joined negotiated customers, or omitted), `Waste fraction`, `VAT` (e.g. `"25%"`), `Variations` (count as string), `Price list` (the default row's tag), `Unit`, `Invoice name`, `Invoice code`, then when present `Materials` / `Included services` / `Service levels` (comma-joined). History entries go into `related` as `History · <date> · <who> · <what>`.
- **Price-row facts:** `Amount` (`"18.50"`), `Unit`, `Effective from`, plus when present `Zone`, `Customer type`, `Container type`, `Waste fraction`, `Negotiated customer`, `Effective to`, `Price list`, `Scheduled amount`, `Scheduled from`, `Scheduled revert on`, `Scheduled note`. RelationRef `{ fieldId: "productId", workspaceId: "commercial", moduleId: "products", recordId, label }`. `record()` doesn't take relationRefs — spread: `{ ...record(...), recordKind: "Price row", relationRefs: [...] }`.
- **Contractor-price facts:** `Contractor` (canonical names `NordRen ApS` / `CityHaul A/S`), `Product`, `Contract area`, `Bid (locked)`, `Current fee`, `Unit`, `Valid from`, `Valid until`, optional `Last indexed` / `Last index note`, one fact per component keyed `Component · <label>`. Indexation entries in `related` as `Indexed · <at> · <note> · €<from> → €<to> · base: <bid|current fee>`. RelationRefs: productId ref + `{ fieldId: "contractorId", workspaceId: "contractors", moduleId: "contractors", recordId: "contractor-nordren" | "contractor-cityhaul", label }`.

3g. Fixture inventory — port every value from `prototype-data.ts` (products 462–597, rows 599–770, rates 772–856) under the id mapping:

| Prototype id | New record id |
|---|---|
| p-res-240 / p-card-660 / p-glass / p-clean / p-bulky / p-bagtag / p-xmas | product-res-240 / product-card-660 / product-glass-igloo / product-clean-monthly / product-bulky / product-bagtag / product-xmas |
| row-* (20) | same slug with `price-row-` prefix (row-res-default → price-row-res-default, row-glass-igloo3 → price-row-glass-igloo3, row-bulky-cowork → price-row-bulky-cowork, …) |
| cp-nordren-res / cp-nordren-card / cp-nordren-glass / cp-cityhaul-res / cp-cityhaul-bulky | contractor-price-nordren-res / -nordren-card / -nordren-glass / -cityhaul-res / -cityhaul-bulky |

Statuses: rows all `"Active"` except `price-row-xmas-default` → `"Scheduled"`. Products all `"Active"` except `product-xmas` → `"Draft"`. Contractor prices: NordRen three `"Active"`, CityHaul two `"Expiring"`.

Three fully-written examples that set the pattern (all remaining records copy it with their own prototype values):

```ts
        {
          ...record(
            "product-res-240",
            "Residual waste · 240L bin",
            "Container collection · /pickup",
            "Active",
            "Pricing",
            "€18.50/pickup",
            "2 weeks ago",
            "Residual collection with a rented 240L bin. Default price applies to everyone; 5 variations including one negotiated deal.",
            {
              Type: "Container collection",
              Container: "240L bin (rental)",
              "Container type": "240L bin",
              Customer: "Østerbro Housing Association",
              "Waste fraction": "Residual",
              VAT: "25%",
              Variations: "5",
              "Price list": "PL-Copenhagen-2026",
              Unit: "pickup",
              "Invoice name": "Residual waste collection 240L",
              "Invoice code": "RES-240",
              Materials: "240L bin (rental)",
              "Included services": "Bin cleaning · monthly",
              "Service levels": "Standard kerbside, Backdoor service",
            },
            [
              "History · 2026-06-15 · Mette Holm · Adjust prices · +3% scheduled for 1 Jan 2027 — Default price €18.50 → €19.06 (scheduled)",
              "History · 2026-02-03 · Mette Holm · Negotiated deal added for Østerbro Housing Association",
              "History · 2025-11-02 · Jonas Friis · Product created (Quick create)",
            ],
            "Price Engine",
            "Live",
          ),
          recordKind: "Product",
        },
```

```ts
        {
          ...record(
            "price-row-res-osterbro",
            "Negotiated · Østerbro Housing Association",
            "Residual waste · 240L bin",
            "Active",
            "Pricing",
            "€15.90/pickup",
            "2026-02-03",
            "Negotiated price row for Østerbro Housing Association on Residual waste · 240L bin.",
            {
              Amount: "15.90",
              Unit: "pickup",
              "Effective from": "2026-02-03",
              "Effective to": "2027-02-02",
              "Negotiated customer": "Østerbro Housing Association",
              "Price list": "Negotiated · Østerbro Housing",
            },
            [],
            "Price Engine",
            "Live",
          ),
          recordKind: "Price row",
          relationRefs: [
            { fieldId: "productId", workspaceId: "commercial", moduleId: "products", recordId: "product-res-240", label: "Residual waste · 240L bin" },
          ],
        },
```

```ts
        {
          ...record(
            "contractor-price-nordren-res",
            "NordRen ApS · Residual waste · 240L bin",
            "CA-Ø-2 · 2025-01-01 → 2027-12-31",
            "Active",
            "Contract Team",
            "€11.76/pickup",
            "2026-03-01",
            "Contractor price: locked bid €11.20, current fee indexed CPI +5% on 2026-03-01.",
            {
              Contractor: "NordRen ApS",
              Product: "Residual waste · 240L bin",
              "Contract area": "CA-Ø-2",
              "Bid (locked)": "11.20",
              "Current fee": "11.76",
              Unit: "pickup",
              "Valid from": "2025-01-01",
              "Valid until": "2027-12-31",
              "Last indexed": "2026-03-01",
              "Last index note": "CPI +5%",
              "Component · Base collection": "€10.00 flat per pickup",
              "Component · Fuel adjustment": "8% of base",
              "Component · Tonnage (metered)": "€4.20/t × ~86 t measured monthly",
            },
            ["Indexed · 2026-03-01 · CPI +5% · €11.20 → €11.76 · base: bid"],
            "Contract management",
            "Live",
          ),
          recordKind: "Contractor price",
          relationRefs: [
            { fieldId: "productId", workspaceId: "commercial", moduleId: "products", recordId: "product-res-240", label: "Residual waste · 240L bin" },
            { fieldId: "contractorId", workspaceId: "contractors", moduleId: "contractors", recordId: "contractor-nordren", label: "NordRen ApS" },
          ],
        },
```

The other products' `Customer` fact: `product-bulky` → `"Nørrebro CoWork ApS"`; all others omit it. `Variations` facts: res-240 `"5"`, card-660 `"2"`, glass-igloo `"2"`, clean-monthly `"1"`, bulky `"3"`, bagtag/xmas omit (0). `Price list` fact = the default row's tag (`PL-Copenhagen-2026` for all but `product-xmas`, which omits it).

3h. Sweep legacy references: `grep -rn "product-organic-240\|product-recollection\|product-sensor\|price-cph-2026\|price-commercial-2026" lib/ components/ app/` → update every hit (e.g. agreement fixture relationRefs) to the new ids or plain text.

- [ ] **Step 4: Swap the form schemas**

4a. Replace the `commercial.products` schema (commercial-improve file, 13–173) with the Quick-create contract (hosted by the Settings pane in Task 4; also powers the generic edit dialog):

```ts
  {
    key: "commercial.products",
    mode: "create",
    recordKind: "Product",
    title: "New product",
    description:
      "Create a sellable product. A product is born priced — the default price becomes the row with no conditions ('Everyone'); variations, schedules and negotiated deals are price rows in Price Engine.",
    submitLabel: "Create product",
    nameField: "productName",
    contextFieldIds: ["productType", "priceUnit", "effectiveFrom"],
    sections: [
      {
        id: "identity",
        title: "Product identity",
        description:
          "Validation: name is required. The three product types are fixed — templates, categories and types collapsed into one axis.",
        fields: [
          { id: "productName", label: "Product name", type: "text", required: true, placeholder: "Residual waste · 240L bin" },
          {
            id: "productType",
            label: "Type",
            type: "select",
            required: true,
            options: [
              { value: "Container collection", label: "Container collection" },
              { value: "Recurring service", label: "Recurring service" },
              { value: "Additional service", label: "Additional service" },
            ],
          },
          {
            id: "status",
            label: "Status",
            type: "select",
            required: true,
            defaultValue: "Active",
            options: [
              { value: "Active", label: "Active" },
              { value: "Draft", label: "Draft" },
            ],
          },
        ],
      },
      {
        id: "default-price",
        title: "Default price",
        description: "A product is born priced: this default applies to everyone until variation rows narrow it.",
        fields: [
          { id: "defaultPrice", label: "Default price", type: "number", required: true, min: 0, unit: "EUR" },
          {
            id: "priceUnit",
            label: "Unit",
            type: "select",
            required: true,
            options: [
              { value: "pickup", label: "€ per pickup" },
              { value: "month", label: "€ per month" },
              { value: "job", label: "€ per job" },
            ],
          },
          {
            id: "priceListTag",
            label: "Price list",
            type: "select",
            description: "Optional tag — a price list is a tag on price rows, not a container object.",
            options: [
              { value: "PL-Copenhagen-2026", label: "PL-Copenhagen-2026" },
              { value: "PL-Harbor-2026", label: "PL-Harbor-2026" },
            ],
          },
          { id: "effectiveFrom", label: "Effective from", type: "date", required: true, defaultValue: "2026-08-20" },
        ],
      },
      {
        id: "invoice-tax",
        title: "Invoice & tax",
        description: "The only home of VAT and invoice fields; price rows never duplicate them.",
        fields: [
          {
            id: "vatRate",
            label: "VAT rate",
            type: "select",
            required: true,
            defaultValue: "25",
            options: [
              { value: "25", label: "25%" },
              { value: "0", label: "0%" },
            ],
          },
          { id: "invoiceName", label: "Invoice name", type: "text", description: "Defaults to the product name when left blank." },
          { id: "invoiceCode", label: "Invoice code", type: "text", placeholder: "WH-RES-240", description: "Suggested from the company prefix WH-." },
        ],
      },
      {
        id: "attributes",
        title: "Catalogue attributes",
        description: "Shown as catalogue columns; services usually leave them unset.",
        fields: [
          { id: "container", label: "Container (rental)", type: "text", placeholder: "240L bin (rental)" },
          {
            id: "containerType",
            label: "Container type",
            type: "select",
            options: [
              { value: "240L bin", label: "240L bin" },
              { value: "660L container", label: "660L container" },
              { value: "Igloo 3m³", label: "Igloo 3m³" },
            ],
          },
          {
            id: "wasteFraction",
            label: "Waste fraction",
            type: "select",
            options: [
              { value: "Residual", label: "Residual" },
              { value: "Paper & cardboard", label: "Paper & cardboard" },
              { value: "Glass", label: "Glass" },
              { value: "Organic", label: "Organic" },
            ],
          },
        ],
      },
    ],
  },
```

4b. Replace the `commercial.pricing` schema (174 to its closing brace) with the two new module schemas. **`commercial.price-rows` (create)** — field labels equal the `ROW_FACTS` strings so the generic create path lands values in the right facts:

```ts
  {
    key: "commercial.price-rows",
    mode: "create",
    recordKind: "Price row",
    title: "New price row",
    description:
      "Add a variation or a negotiated deal. Leave every condition empty for a default row. The row matching the most conditions wins; a negotiated row for the specific customer always wins; ties go to the newest effective-from date.",
    submitLabel: "Create price row",
    contextFieldIds: ["productId", "amount", "effectiveFrom"],
    sections: [
      {
        id: "row-target",
        title: "Product and amount",
        fields: [
          { id: "productId", label: "Product", type: "select", required: true, relation: { workspaceId: "commercial", moduleId: "products" } },
          { id: "amount", label: "Amount", type: "number", required: true, min: 0, unit: "EUR" },
          {
            id: "unit",
            label: "Unit",
            type: "select",
            required: true,
            description: "Match the product's unit.",
            options: [
              { value: "pickup", label: "€ per pickup" },
              { value: "month", label: "€ per month" },
              { value: "job", label: "€ per job" },
            ],
          },
          {
            id: "tag",
            label: "Price list",
            type: "select",
            options: [
              { value: "PL-Copenhagen-2026", label: "PL-Copenhagen-2026" },
              { value: "PL-Harbor-2026", label: "PL-Harbor-2026" },
            ],
          },
        ],
      },
      {
        id: "row-conditions",
        title: "Conditions",
        description: "Each filled condition narrows who pays this amount. Empty conditions + empty customer = the product's default row.",
        fields: [
          { id: "zone", label: "Zone", type: "select", options: [
            { value: "Zone North", label: "Zone North" },
            { value: "City Centre", label: "City Centre" },
            { value: "Amager", label: "Amager" },
            { value: "Harbor", label: "Harbor" },
          ] },
          { id: "customerType", label: "Customer type", type: "select", options: [
            { value: "Household", label: "Household" },
            { value: "Commercial", label: "Commercial" },
            { value: "Municipal", label: "Municipal" },
          ] },
          { id: "containerType", label: "Container type", type: "select", options: [
            { value: "240L bin", label: "240L bin" },
            { value: "660L container", label: "660L container" },
            { value: "Igloo 3m³", label: "Igloo 3m³" },
          ] },
          { id: "wasteFraction", label: "Waste fraction", type: "select", options: [
            { value: "Residual", label: "Residual" },
            { value: "Paper & cardboard", label: "Paper & cardboard" },
            { value: "Glass", label: "Glass" },
            { value: "Organic", label: "Organic" },
          ] },
          {
            id: "negotiatedCustomer",
            label: "Negotiated customer",
            type: "text",
            description: "Filling this makes it a negotiated deal — it always wins for that customer and is excluded from bulk adjustments by default.",
            placeholder: "Østerbro Housing Association",
          },
        ],
      },
      {
        id: "row-dates",
        title: "Effective period",
        fields: [
          { id: "effectiveFrom", label: "Effective from", type: "date", required: true, defaultValue: "2026-08-20" },
          { id: "effectiveTo", label: "Effective to", type: "date", description: "Optional end date." },
          { id: "scheduledAmount", label: "Scheduled amount", type: "number", min: 0, unit: "EUR", description: "Optional: a future amount that takes over on the scheduled date." },
          { id: "scheduledFrom", label: "Scheduled from", type: "date" },
          { id: "scheduledRevertOn", label: "Scheduled revert on", type: "date" },
        ],
      },
    ],
  },
```

**`commercial.contractor-prices` (action — Apply index).** Because it's the module's registered schema, the workspace's primary-action button opens it through the completely standard plumbing, and the generic edit path never opens for these records (bid immutability for free):

```ts
  {
    key: "commercial.contractor-prices",
    mode: "action",
    recordKind: "Contractor price indexation",
    title: "Apply index",
    description:
      "Recompute current fees for the selected contractor prices. The base is the original bid or the current fee (current compounds earlier changes; the bid never moves). Each run appends to the indexation history.",
    submitLabel: "Apply index",
    contextFieldIds: ["indexLabel", "percent", "effectiveFrom"],
    sections: [
      {
        id: "index-scope",
        title: "Scope",
        fields: [
          {
            id: "rateIds",
            label: "Contractor prices",
            type: "multiselect",
            required: true,
            relation: { workspaceId: "commercial", moduleId: "contractor-prices" },
            description: "Pick the rows to index — filter by contractor or contract area as you select.",
          },
        ],
      },
      {
        id: "index-terms",
        title: "Index terms",
        fields: [
          { id: "indexLabel", label: "Index", type: "text", required: true, placeholder: "CPI" },
          { id: "percent", label: "Percent", type: "number", required: true, unit: "%" },
          {
            id: "base",
            label: "Base",
            type: "select",
            required: true,
            defaultValue: "current fee",
            options: [
              { value: "current fee", label: "Current fee (compounds earlier changes)" },
              { value: "bid", label: "Original bid (never moves)" },
            ],
          },
          { id: "effectiveFrom", label: "Effective from", type: "date", required: true, defaultValue: "2026-08-20" },
        ],
      },
    ],
  },
```

4c. Add the **non-registered** Adjust-prices schema as a separate named export at the bottom of `business-form-schemas-commercial-improve.ts` (it is NOT added to the exported array — the gate allows exactly one registered schema per module; this one is hosted by a header-button swap in Task 3):

```ts
// Bulk annual-increase flow (spec §4.2). Hosted by the Products header button;
// deliberately not in the registered array (commercial.products' registered
// schema is the create contract used by Settings).
export const adjustPricesFormSchema: BusinessFormSchema = {
  key: "commercial.products",
  mode: "action",
  recordKind: "Price adjustment",
  title: "Adjust prices",
  description:
    "Schedule a bulk change across price rows. Negotiated rows are excluded unless explicitly included. Affected rows carry a Scheduled amount until the effective date.",
  submitLabel: "Schedule adjustment",
  contextFieldIds: ["adjustKind", "adjustValue", "effectiveFrom"],
  execution: {
    kind: "start-workflow",
    reviewBeforeSubmit: true,
    completionMessage: "Adjustment scheduled across the selected price rows.",
  },
  validationRules: [],
  sections: [
    {
      id: "adjust-scope",
      title: "Scope",
      description: "Every non-negotiated row of the selected products (or the whole tag) is adjusted.",
      fields: [
        {
          id: "priceListTag",
          label: "Price list",
          type: "select",
          options: [
            { value: "all", label: "All price rows" },
            { value: "PL-Copenhagen-2026", label: "PL-Copenhagen-2026" },
            { value: "PL-Harbor-2026", label: "PL-Harbor-2026" },
          ],
          defaultValue: "all",
        },
        {
          id: "productIds",
          label: "Products",
          type: "multiselect",
          relation: { workspaceId: "commercial", moduleId: "products" },
          description: "Optional narrowing — empty means every product in the chosen price list.",
        },
        {
          id: "includeNegotiated",
          label: "Include negotiated rows",
          type: "checkbox",
          defaultValue: false,
          description: "Warning: negotiated deals are customer commitments. Including them reprices those commitments.",
        },
      ],
    },
    {
      id: "adjust-terms",
      title: "Adjustment",
      fields: [
        {
          id: "adjustKind",
          label: "Kind",
          type: "select",
          required: true,
          defaultValue: "percent",
          options: [
            { value: "percent", label: "Percent (+/−)" },
            { value: "fixed", label: "Fixed amount (+/−)" },
            { value: "multiply", label: "Multiply" },
          ],
        },
        { id: "adjustValue", label: "Value", type: "number", required: true },
        { id: "roundTo05", label: "Round to nearest €0.05", type: "checkbox", defaultValue: false },
        { id: "effectiveFrom", label: "Effective from", type: "date", required: true, defaultValue: "2027-01-01" },
        { id: "revertOn", label: "Auto-revert on", type: "date", description: "Optional: the amount reverts on this date." },
      ],
    },
  ],
}
```

4d. In `business-form-schemas.ts`:
- Delete the `"commercial.products.componentQuantity"` conditional entry (~135) and the `"commercial.products.changeReason"` / `"commercial.products.categoryId"` blocks (~395–410) — those fields no longer exist.
- In `actionExecutions` (line 22) add / adjust and remove any stale `commercial.pricing` entry:

```ts
  "commercial.products": {
    kind: "create-record",
    reviewBeforeSubmit: true,
    completionMessage: "Product created and born priced — its default row applies to everyone.",
  },
  "commercial.price-rows": {
    kind: "create-record",
    reviewBeforeSubmit: true,
    completionMessage: "Price row created — resolution follows the most-conditions rule.",
  },
  "commercial.contractor-prices": {
    kind: "start-workflow",
    reviewBeforeSubmit: true,
    completionMessage: "Index applied — current fees recomputed, bids untouched.",
  },
```

(If `enhanceSchema` would attach a default execution to a mode:"action" schema differently, follow the existing action-schema precedents in that file — the executor checks one, e.g. `commercial.billing`.)

4e. `business-form-schemas-customers-resources.ts` (~814–822) — price lists are tags now, not records:

```ts
          {
            id: "priceListId",
            label: "Price list",
            type: "select",
            description: "A price list is a tag on price rows; the agreement stores the tag.",
            options: [
              { value: "PL-Copenhagen-2026", label: "PL-Copenhagen-2026" },
              { value: "PL-Harbor-2026", label: "PL-Harbor-2026" },
            ],
          },
```

- [ ] **Step 5: Navigation + rename touches**

- `lib/data/sidebar.ts:43`: `{ id: "commercial", label: "Price Engine", href: "/commercial", badge: 14 }`
- `business-workspace.tsx:552`: `commercial: ["products", "price-rows", "contractor-prices", "settlements", "events"],` (billing/invoices stay in the More menu; no `workspace-page-shell.tsx` allowlist needed — every commercial module is public now)
- `lib/data/business-links.ts` (~79–80): merge into one entry, delete the pricing line: `{ workspaceId: "commercial", moduleId: "products", terms: ["product", "products", "price list", "price lists", "pricing"] },`

- [ ] **Step 6: Run the gates**

- `npx tsx scripts/price-resolution-harness.ts` → all pass (15 engine + registry block). A "Missing explicit fixture scope" / schema-gate error names the missing id — fix it.
- `npx tsc --noEmit` → exit 0.
- Browser: `/commercial?module=products` → generic table shows the 7 products with fact columns (open the view options / column picker and confirm Container, Container type, Customer, Waste fraction, VAT, Variations, Price list are available; set the visible set to Type · Container · Container type · Customer · Waste fraction · VAT · Variations · Price list if the default set differs — note in the task report how many columns show by default). Breadcrumb + sidebar say **Price Engine**. Module pills: Products / Price rows / Contractor prices / Settlements / Events. `?module=price-rows` lists 20 rows; `?module=contractor-prices` lists 5; record detail sheets show the facts and the `History ·`/`Indexed ·` related entries. `/commercial?variant=a` still renders the prototype (untouched until the final task).

- [ ] **Step 7: Commit**

```bash
git add lib/data/ components/wastehero/business-workspace.tsx scripts/price-resolution-harness.ts
git commit -m "Cut over commercial registry: products/price-rows/contractor-prices modules, pricing retired, Price Engine rename"
```

---

### Task 3: The two money flows — Adjust prices + Apply index (existing dialog machinery)

**Files:**
- Modify: `components/wastehero/business-workspace.tsx` (header-button swap for `commercial.products`; two `recordKind` branches in `handleFormSubmit` at line 1965; write-sync helper)
- Reference: the `"Contract area assignment"` branch (1968–2058) — the established pattern for bespoke submits; `RouteCreateEntry` usage (~2668) — the established pattern for swapping a module's header button.

**Interfaces:**
- Consumes: Task 1 (`recordToPriceRow`, `priceRowToRecord`, `computeAdjusted`, `applyIndexToRate`, `recordToContractorPrice`, `contractorPriceToRecord`, `encodeHistory`, `money`, `unitSuffix`, `PRICING_REFERENCE_DATE`, `PRODUCT_FACTS`, fact keys), Task 2 schemas (`adjustPricesFormSchema` import; registered contractor-prices action schema resolves via the normal `activeModuleFormSchema` path).
- Produces: working bulk flows writing through `upsertRecord`; a `syncProductPricingFacts(productRecord, rows)` helper other tasks reuse.

- [ ] **Step 1: Add the products header-button swap**

In the header action area (~2667, next to the `isRouteCreateFlow` ternary): when `workspace.id === "commercial" && activeModule.id === "products"`, render the standard `<Button>` labeled **Adjust prices** that opens `BusinessRecordFormDialog` with `schema={adjustPricesFormSchema}` (a second dialog instance alongside the create one, same props wiring: `relationOptions={getFormRelationOptions}`, `onSubmit={handleFormSubmit}`, controlled by a new `isAdjustOpen` state). The module's registered create schema is NOT opened from the workspace — product creation lives in Settings (Task 4).

- [ ] **Step 2: Write the `"Price adjustment"` submit branch**

At the top of `handleFormSubmit` (pattern: the Contract-area-assignment branch), keyed on `formSchema.recordKind === "Price adjustment"`:

```tsx
const rowsModule = workspace.modules.find((m) => m.id === "price-rows")
const productsModule = workspace.modules.find((m) => m.id === "products")
if (!rowsModule || !productsModule) return
const rowRecords = getRecords("commercial", "price-rows", rowsModule.records)
const productRecords = getRecords("commercial", "products", productsModule.records)
const tag = typeof values.priceListTag === "string" ? values.priceListTag : "all"
const pickedProducts = typeof values.productIds === "string" && values.productIds ? values.productIds.split(",") : []
const includeNegotiated = values.includeNegotiated === true
const kind = (values.adjustKind || "percent") as "percent" | "fixed" | "multiply"
const value = Number(values.adjustValue)
const round = values.roundTo05 === true
const from = typeof values.effectiveFrom === "string" ? values.effectiveFrom : PRICING_REFERENCE_DATE
const revertOn = typeof values.revertOn === "string" && values.revertOn ? values.revertOn : undefined
if (!Number.isFinite(value)) { toast.error("Enter a numeric adjustment value."); return }
const note = kind === "percent" ? `${value > 0 ? "+" : ""}${value}%` : kind === "fixed" ? `${value > 0 ? "+" : ""}€${value}` : `×${value}`
let adjusted = 0
const touchedProducts = new Map<string, string[]>()
for (const rowRecord of rowRecords) {
  const row = recordToPriceRow(rowRecord)
  if (!row) continue
  if (row.negotiatedCustomer && !includeNegotiated) continue
  if (tag !== "all" && row.tag !== tag) continue
  if (pickedProducts.length > 0 && !pickedProducts.includes(row.productId)) continue
  const newAmount = computeAdjusted(row.amount, kind, value, round)
  const product = productRecords.find((p) => p.id === row.productId)
  const updated = priceRowToRecord(
    { ...row, scheduled: { newAmount, from, revertOn, note: `Adjust prices ${note}` } },
    { id: row.productId, name: product?.name ?? rowRecord.context },
  )
  upsertRecord("commercial", "price-rows", { ...rowRecord, ...updated, related: rowRecord.related, companyId: rowRecord.companyId, projectIds: rowRecord.projectIds, contractorId: rowRecord.contractorId })
  adjusted += 1
  const diffs = touchedProducts.get(row.productId) ?? []
  diffs.push(`${rowDisplayName(row)} ${money(row.amount)} → ${money(newAmount)} (scheduled)`)
  touchedProducts.set(row.productId, diffs)
}
for (const [productId, diffs] of touchedProducts) {
  const product = productRecords.find((p) => p.id === productId)
  if (!product) continue
  upsertRecord("commercial", "products", {
    ...product,
    updated: "Now",
    related: [encodeHistory({ at: PRICING_REFERENCE_DATE, who: "Olivia Larsen", what: `Adjust prices · ${note} scheduled for ${from} — ${diffs.join("; ")}` }), ...product.related],
  })
}
setIsAdjustOpen(false)
toast.success("Adjustment scheduled", { description: `${adjusted} price row${adjusted === 1 ? "" : "s"} scheduled ${note} from ${from}${includeNegotiated ? " (negotiated rows included)" : " (negotiated rows excluded)"}.` })
return
```

- [ ] **Step 3: Write the `"Contractor price indexation"` submit branch**

Keyed on `formSchema.recordKind === "Contractor price indexation"`:

```tsx
const ratesModule = workspace.modules.find((m) => m.id === "contractor-prices")
if (!ratesModule) return
const rateRecords = getRecords("commercial", "contractor-prices", ratesModule.records)
const pickedIds = typeof values.rateIds === "string" && values.rateIds ? values.rateIds.split(",") : []
const label = typeof values.indexLabel === "string" ? values.indexLabel.trim() : ""
const percent = Number(values.percent)
const base = values.base === "bid" ? ("bid" as const) : ("current fee" as const)
const from = typeof values.effectiveFrom === "string" ? values.effectiveFrom : PRICING_REFERENCE_DATE
if (pickedIds.length === 0 || !label || !Number.isFinite(percent)) { toast.error("Pick contractor prices, an index label, and a percent."); return }
let indexed = 0
for (const rateRecord of rateRecords) {
  if (!pickedIds.includes(rateRecord.id)) continue
  const updated = applyIndexToRate(recordToContractorPrice(rateRecord), { label, percent, from, base })
  upsertRecord("commercial", "contractor-prices", contractorPriceToRecord(updated, rateRecord))
  indexed += 1
}
setIsCreateOpen(false)
setRelatedCreateTarget(null)
toast.success("Index applied", { description: `${indexed} contractor price${indexed === 1 ? "" : "s"} recomputed from ${base} (${label} +${percent}%). Bids untouched.` })
return
```

(Multiselect value shape: check how `BusinessRecordFormDialog` encodes multiselect values — if it stores arrays or another joiner instead of comma-joined strings, adapt the two `split(",")` sites and the `productIds` one above to match; the form component is the source of truth.)

- [ ] **Step 4: Keep product pricing facts honest on row writes**

Add a small helper near the branches and call it at the end of both branches for every touched product (and export the logic for Task 4's settings pane via `lib/commercial/price-model.ts` if more convenient there):

```tsx
const syncProductPricingFacts = (product: BusinessRecord, rows: PriceRowModel[]) => {
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
```

Also call it in the **generic create path** when a `commercial.price-rows` record is created (after the generic upsert, look up the row's product and upsert the synced product with a history entry `Variation added` / `Negotiated deal added for <customer>` depending on the negotiatedCustomer field) — hook it right after the generic create completes for that module key (small `if (resolvedTarget.module.id === "price-rows") { … }` block). While there, make the generic-created row record carry the correct derived `name` (`rowDisplayName`) and `value` (`€…/unit`) by post-processing the record the generic path built.

- [ ] **Step 5: Verify in the browser**

- `/commercial?module=products` → **Adjust prices** button opens the standard form dialog; choose PL-Copenhagen-2026 / +3% / round / from 2027-01-01 → review step → confirm → toast reports rows scheduled with "negotiated rows excluded"; `?module=price-rows` shows Scheduled-amount facts on affected rows; res-240 product record's History gains the entry. Reload → persisted.
- With "Include negotiated rows" checked, the negotiated rows are included (toast says so).
- `?module=price-rows` → **New price row**: create a City Centre variation for Bin cleaning → review → create; the row lists with the right name/facts; the product's Variations fact bumps and History shows "Variation added". Create a row with a Negotiated customer → product's Customer fact updates.
- Edit a price row (generic edit) → change Scheduled amount/date → facts update (Schedule-a-change flow).
- `?module=contractor-prices` → **Apply index**: pick the two CityHaul rows, Fuel +2%, base current fee → review → confirm → Current fee facts recompute (€12.77 → €13.03, €31.00 → €31.62), `Indexed ·` entries appear in related, bids untouched. Reload → persisted.
- `npx tsc --noEmit` exit 0; harness green. Clear localStorage afterwards.

- [ ] **Step 6: Commit**

```bash
git add components/wastehero/business-workspace.tsx
git commit -m "Add Adjust prices and Apply index flows through the standard form dialog"
```

---

### Task 4: Settings — product management pane + permanent Commercial panes

**Files:**
- Create: `components/settings/commercial-settings.tsx`
- Modify: `components/settings/SettingsDialog.tsx` (lines 46–52 imports/gate, 130–163 sections, 1332–1400 pane defs, 1841–1846 render hooks)
- Reference (read-only): `settings-commercial-defaults.tsx` (all), `settings-commercial-section.tsx` (all) — the settings-pane idiom to keep; `asset-management-settings.tsx` — the full-bleed settings pane precedent

**Interfaces:**
- Consumes: Task 1 lib; Task 2 records + `getBusinessFormSchema("commercial", "products")`; existing `BusinessRecordFormDialog`, `useBusinessRecordStore`, `businessWorkspaces`.
- Produces: `CommercialDefaultsExtras()` and `CommercialSectionPane({ paneId })` — same names/props the SettingsDialog hooks already use, so the render lines only change their import path.

- [ ] **Step 1: Build `commercial-settings.tsx`**

Port both prototype settings files into one real module, replacing every `makeFixtureDb()` with store reads:

```tsx
const { getRecords, upsertRecord } = useBusinessRecordStore()
const commercial = businessWorkspaces.commercial
const fixturesOf = (moduleId: string) => commercial.modules.find((m) => m.id === moduleId)?.records ?? []
const productRecords = getRecords("commercial", "products", fixturesOf("products"))
const rowRecords = getRecords("commercial", "price-rows", fixturesOf("price-rows"))
const rows = rowRecords.map(recordToPriceRow).filter((r): r is NonNullable<typeof r> => r !== null)
```

- `CommercialDefaultsExtras`: Materials registry (counts from product `Materials` facts), surcharge-rules table (`SURCHARGE_RULES`), contractor-performance read-only card (`CONTRACTOR_PERFORMANCE`), price-lists index (`priceListIndex(rows)`) with links to `/commercial?module=products` and the caption using `PRICING_REFERENCE_DATE`. Keep `RegistryCard` / `usageLabel` / `Registry` (ported as-is — they follow the existing settings-card idiom). Rename/Retire stubs keep a toast with honest copy: `toast("Not in v1", { description: "Rename / merge / retire is deferred." })`.
- `CommercialSectionPane`: Zones / Service / Customer types panes as prototyped (usage counts from `rows` / product facts). The **Products pane becomes the management surface**:
  - Table as prototyped (Name · Type · Container · Container type · Customer · Waste fraction · Price · Status) — Customer/price cells now derive from `rows` — plus an Edit button per row and a **New product** header button; "Open in Price Engine" links to `/commercial`.
  - **New product** opens `BusinessRecordFormDialog` with `schema={getBusinessFormSchema("commercial", "products")!}` and `relationOptions={() => []}`. `onSubmit` performs the born-priced double write:

```tsx
const text = (id: string) => (typeof values[id] === "string" ? (values[id] as string).trim() : "")
const name = text("productName")
const unit = (text("priceUnit") || "pickup") as PriceUnit
const amount = Number(text("defaultPrice"))
const productId = `product-${Date.now().toString(36)}`
const facts: Record<string, string> = {
  [PRODUCT_FACTS.type]: text("productType"),
  ...(text("container") ? { [PRODUCT_FACTS.container]: text("container") } : {}),
  ...(text("containerType") ? { [PRODUCT_FACTS.containerType]: text("containerType") } : {}),
  ...(text("wasteFraction") ? { [PRODUCT_FACTS.wasteFraction]: text("wasteFraction") } : {}),
  [PRODUCT_FACTS.vat]: `${text("vatRate") || "25"}%`,
  ...(text("priceListTag") ? { [PRODUCT_FACTS.priceList]: text("priceListTag") } : {}),
  [PRODUCT_FACTS.unit]: unit,
  [PRODUCT_FACTS.invoiceName]: text("invoiceName") || name,
  [PRODUCT_FACTS.invoiceCode]: text("invoiceCode") || `${COMMERCIAL_DEFAULTS.invoiceCodePrefix}${name.slice(0, 12).toUpperCase().replace(/[^A-Z0-9]+/g, "-")}`,
}
upsertRecord("commercial", "products", {
  id: productId,
  name,
  context: `${text("productType")} · ${unitSuffix(unit)}`,
  status: text("status") || "Active",
  owner: "Pricing",
  value: `${money(amount)}${unitSuffix(unit)}`,
  updated: "Now",
  description: `${text("productType")} product created in Settings; born priced at ${money(amount)}${unitSuffix(unit)}.`,
  facts,
  related: [encodeHistory({ at: PRICING_REFERENCE_DATE, who: "You", what: "Product created (Quick create)" })],
  source: "Price Engine",
  freshness: "Now",
  recordKind: "Product",
  submittedValues: values,
})
upsertRecord("commercial", "price-rows", priceRowToRecord(
  { id: `price-row-${Date.now().toString(36)}`, productId, amount, unit, conditions: {}, effectiveFrom: text("effectiveFrom") || PRICING_REFERENCE_DATE, tag: text("priceListTag") || undefined },
  { id: productId, name },
))
toast.success("Product created", { description: "Born priced — the default row applies to everyone." })
```

  - **Edit** opens the same dialog with `initialValueOverrides` from a `productRecordToFormValues(record, rows)` helper (reads `submittedValues` when present, else derives: `defaultPrice` from the default row's amount, `vatRate` from the VAT fact stripped of `%`, etc.). Submit **upserts over the same record id**: merge new name/status/facts onto the existing record, append `encodeHistory({ at: PRICING_REFERENCE_DATE, who: "You", what: "Product edited in Settings" })`, and when `defaultPrice` changed also upsert the default row with the new amount (keep the one-price-model invariant).

- [ ] **Step 2: Make the SettingsDialog panes permanent**

- Delete the prototype imports (46–49) and `SHOW_COMMERCIAL_DEFAULTS` (52); import `{ CommercialDefaultsExtras, CommercialSectionPane }` from `@/components/settings/commercial-settings`.
- `settingsSections`: unwrap both conditional spreads (135–138, 144–162) into plain entries.
- `visiblePaneDefinitions` (1332–1400): unwrap the conditional; update `commercial-products` description to `"The sellable catalogue — add and edit products here. Prices are managed in Price Engine."`; replace "Commercial workspace" wording with "Price Engine" in the `pricing` pane text.
- Render hooks (1841–1846): drop the `SHOW_COMMERCIAL_DEFAULTS &&` conditions and the PROTOTYPE comments.

- [ ] **Step 3: Verify in the browser**

- `/settings?pane=commercial-products`: **New product** → Quick create → review → create → appears in the settings table AND in `/commercial?module=products` with its default price (born priced) and in `?module=price-rows` as an Everyone row; persists on reload.
- Edit a product (rename + waste fraction + default price) → both surfaces reflect it; the price-rows module shows the changed default amount; History entry added.
- `/settings?pane=pricing`: defaults controls + Materials + surcharges + performance card + price-lists index (link round-trips to Price Engine).
- Zones / Service / Customer types panes show usage counts; settings search finds "Products" under Commercial.
- `grep -rn "SHOW_COMMERCIAL_DEFAULTS" components/` → no hits. `npx tsc --noEmit` exit 0; harness green.

- [ ] **Step 4: Commit**

```bash
git add components/settings/
git commit -m "Make Settings the product management surface; Commercial panes permanent and store-backed"
```

---

### Task 5: Contractor details Prices tab (existing RelatedRecordsTable)

**Files:**
- Modify: `components/wastehero/contractor-details-page.tsx` (prototype import + gate at 28–33; tab trigger 322–327; tab content 391–396; props)
- Modify: `components/wastehero/business-workspace.tsx` (pass contractor-price records to `ContractorDetailsPage`, call site ~2607)

**Interfaces:**
- Consumes: `commercial.contractor-prices` records (already scoped with `contractorId` by `record()`); existing `RelatedRecordsTable` in contractor-details-page.tsx.
- Produces: `ContractorDetailsPage` gains a `contractorPrices: readonly BusinessRecord[]` prop.

- [ ] **Step 1: Replace the prototype tab with a RelatedRecordsTable**

In `contractor-details-page.tsx`: delete the prototype import and `SHOW_PRICES_TAB` (28–33); add `contractorPrices` to the component props; render the trigger unconditionally with the count (`Prices <span …>{contractorPrices.length}</span>`, same markup as the other triggers); replace the prototype TabsContent with:

```tsx
        <TabsContent value="prices" className="mt-0 min-h-0 flex-1">
          <RelatedRecordsTable
            records={contractorPrices}
            entityLabel="Contractor price"
            contextLabel="Contract area · validity"
            valueLabel="Current fee"
            emptyLabel="No contractor prices"
            actionLabel="Apply index"
            onCreate={() => onCreate("contractor-price")}
            workspaceId="commercial"
            moduleId="contractor-prices"
          />
        </TabsContent>
```

(If `RelatedRecordsTable`'s props require `onCreate`, wire `"contractor-price"` through the page's `onCreate` kind union; in BusinessWorkspace's `requestContractorRelatedCreate`, map that kind to the `commercial.contractor-prices` module so the button opens the standard **Apply index** dialog. If the plumbing resists a non-create action there, drop `actionLabel`/`onCreate` and keep the tab read-only with deep links — the module header remains the Apply-index entry point.)

- [ ] **Step 2: Plumb the data**

In `business-workspace.tsx`, next to the other contractor-related memos (~904–940), add:

```tsx
const relatedContractorPrices = useMemo(() => {
  if (!selectedContractorId) return []
  const commercialWorkspace = getWorkspaceDefinition("commercial")
  const ratesModule = commercialWorkspace.modules.find((module) => module.id === "contractor-prices")
  if (!ratesModule) return []
  return getRecords("commercial", ratesModule.id, ratesModule.records).filter(
    (record) => record.contractorId === selectedContractorId,
  )
}, [getRecords, selectedContractorId])
```

Pass `contractorPrices={relatedContractorPrices}` at the `ContractorDetailsPage` call site (~2607).

- [ ] **Step 3: Verify in the browser**

- `/contractors?module=contractors&record=contractor-nordren` → Prices tab shows exactly the 3 NordRen rows (locked-bid fact visible in each record's sheet); `contractor-cityhaul` shows its 2 Expiring rows. After an Apply index run in Price Engine, the tab reflects the new fees (same records). No `NODE_ENV` gating remains in the file.
- `npx tsc --noEmit` exit 0; harness green.

- [ ] **Step 4: Commit**

```bash
git add components/wastehero/contractor-details-page.tsx components/wastehero/business-workspace.tsx
git commit -m "Show contractor prices on the contractor details page via RelatedRecordsTable"
```

---

### Task 6: Cutover — retire the prototype, docs, full verification

**Files:**
- Modify: `app/commercial/page.tsx`
- Delete: `components/wastehero/products-prices-prototype/` (entire folder)
- Modify: `docs/superpowers/specs/2026-08-19-products-prices-redesign-design.md` (§10 append), `docs/BUSINESS_MODULE_MAP.md`

- [ ] **Step 1: Replace the commercial page**

`app/commercial/page.tsx` becomes exactly:

```tsx
import { WorkspacePageShell } from "@/components/wastehero/workspace-page-shell"

export default function CommercialPage() {
  return <WorkspacePageShell workspaceId="commercial" />
}
```

- [ ] **Step 2: Delete the prototype and sweep**

```bash
git rm -r components/wastehero/products-prices-prototype
grep -rn "products-prices-prototype\|PROTOTYPE — Products & Prices\|SHOW_COMMERCIAL_DEFAULTS\|SHOW_PRICES_TAB\|variant=a" app/ components/ lib/ --include="*.ts" --include="*.tsx"
```

Expected: zero hits. Fix any straggler.

- [ ] **Step 3: Update the docs**

- Spec §10: append a dated 2026-08-20 block — implementation shipped; record the three planning decisions (generic views only; Settings-managed products; Price Engine rename) and that Explain remains cut with the engine in `lib/commercial/` + `scripts/price-resolution-harness.ts`.
- `docs/BUSINESS_MODULE_MAP.md`: Commercial's display label is now Price Engine (id unchanged); mark the M05 P1 gap as addressed.

- [ ] **Step 4: Full gates**

- `npx tsc --noEmit` → exit 0. `npx tsx scripts/price-resolution-harness.ts` → all pass.
- Browser walkthrough (clear `wastehero-business-records-v1` first; serialized Playwright):
  1. Sidebar shows **Price Engine** → `/commercial` lands on the generic Products module (no prototype chrome, no Explain anywhere).
  2. Products table: attribute fact columns visible; record sheet shows Invoice & tax facts + History entries; module rules show the §4.4 sentence.
  3. **Adjust prices** end-to-end with review, negotiated exclusion; price-rows facts update; persists on reload.
  4. **New price row** (variation + negotiated) and generic row edit (schedule change); product Customer/Variations facts sync.
  5. **Apply index** from the module; contractor record → Prices tab shows the same updated records.
  6. Settings: create + edit product round-trip into Price Engine; defaults pane; zones/service/customer-types; price-list index link.
  7. `?module=settlements|events|billing|invoices` render unchanged; `?record=product-res-240` opens the product sheet; old `?variant=a` now just renders the workspace.
  8. Console: no new errors (radix-useId warning is pre-existing).
- `npm run build` completes (catches deleted-file imports that tsc's ignoreBuildErrors would let build).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Retire Products & Prices prototype; Price Engine is the real Commercial surface"
```

---

## Self-review notes (kept for executors)

- **Spec coverage:** §4.2 SELL lane → Tasks 2–4 (creation in Settings per the 2026-08-20 decision; table = generic module table; Vary/Schedule/Negotiate = price-rows create/edit; Adjust = schema dialog; guided setup deferred per §6). §4.3 PAY lane → Tasks 2–3 + 5 (Apply index = registered action schema; components/indexation as facts/related; creation flow deferred). §4.4 → Task 1 engine + module rules copy. §4.5 Explain → deliberately absent (§10 rev 1). §4.6 tags → row facts + settings index. §4.1 → Settings/Price Engine split per the amended lane boundary. §5 constraints → Task 2. §8 mitigations → negotiated exclusion (Task 3), tie-break (Task 1), price-list survival (Tasks 2/4), contractor-first entry (Task 5).
- **Fares's generic-views constraint** is honored by construction: zero new workspace UI components; the only new component file is the Settings pane (his explicit ask, following the existing settings-pane idiom). The prototype's custom catalogue/detail/dialog/lane UI is consciously not ported.
- **Type consistency:** names in Interfaces blocks are the contract; fact-key strings live once in Task 1 (`ROW_FACTS`/`PRODUCT_FACTS`/`RATE_FACTS`) and the harness registry block fails if fixtures drift. `rowDisplayName`, `syncProductPricingFacts`, `applyIndexToRate`, `contractorPriceToRecord` are each defined once and reused.
- **Known intentional oddities:** `price-rows` is a visible module (no custom product page to host rows); the products header button is swapped to Adjust prices (RouteCreateEntry precedent) while creation lives in Settings; contractor-prices' action-mode schema doubles as the bid lock; denormalized `Customer`/`Variations`/`Price list` product facts are maintained by every row write; `PRICING_REFERENCE_DATE` fixed at 2026-08-20 for determinism; invoices module untouched.
- **Executor verify-first spots (existing machinery whose exact behavior the plan depends on):** multiselect value encoding in `BusinessRecordFormDialog` (Task 3 branches), the generic create path's fact-building for `price-rows` (Task 3 step 4), `RelatedRecordsTable` required props (Task 5), the fact-column picker's default column set (Task 2 step 6). Each is called out inline where it matters.
