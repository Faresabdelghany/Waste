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
