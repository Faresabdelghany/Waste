// What the Finance suites need beyond their own routes (Issue #112, slice
// 3): a product or two to price, a tariff with rows, an award with its
// assignment and a provider price under it. The rows are written directly
// through `tx` as `wms_api` inside `withCompany`, the way tenant.ts seeds its
// company and scheme-fixtures.ts seeds Planning — a suite proves its own
// routes and takes the neighbouring context's rows as given — and
// `dropTenant` drops them with the rest of the company.
//
// Three builders and one ground: `seedProducts` writes two Copenhagen
// Central products with a VAT rate, `seedPriceList` one list with the rows
// the caller spells, `seedServiceArea` one award over the planning areas the
// caller names with its first assignment and, when asked, one provider price
// under it; `seedFinance` lays the §6 ground once — a default list with
// rows, a named list, NordRen's area over two Copenhagen planning areas with
// its assignment, and one provider price — for the suites that read it
// (provider-reach.test.ts here; the event, run and settlement suites of the
// sibling slices). A second Copenhagen planning area is written here too,
// since scheme-fixtures.ts seeds one per project and an award over two is
// what the one-award rule and the predicate are proved against.
import type { CustomerKind } from "@waste/contracts/customers"
import type { Database, Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { priceList, priceListRow, serviceArea, serviceAreaAssignment, serviceAreaPlanningArea, serviceAreaWasteFraction, serviceProviderPrice } from "@waste/db/schema/finance"
import { planningArea } from "@waste/db/schema/planning-areas"
import { withCompany } from "@waste/db/tenant"

import type { PlanningFixtures } from "./scheme-fixtures"
import { testId, type Tenant } from "./tenant"

/** A product as a sentence and a price name it. */
export type FixtureProduct = { id: string; name: string }

export type ProductFixtures = {
  /** A residual collection per pickup, VAT 25 %. */
  residual: FixtureProduct
  /** A glass collection per pickup, VAT 25 %. */
  glass: FixtureProduct
  /** A monthly bin rental, VAT 25 %: the `month` unit a consumer records nothing for. */
  rental: FixtureProduct
  /** A product with no VAT rate: what blocks an event with `no-vat-rate`. */
  unrated: FixtureProduct
}

/** Copenhagen Central's catalogue, as far as a price needs one. */
export async function seedProducts(pool: Database, tenant: Tenant, projectId = tenant.projects.copenhagen.id): Promise<ProductFixtures> {
  const { companyId } = tenant
  const fixtures: ProductFixtures = {
    residual: { id: testId(), name: "Residual collection" },
    glass: { id: testId(), name: "Glass collection" },
    rental: { id: testId(), name: "Bin rental" },
    unrated: { id: testId(), name: "Unrated service" },
  }
  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.insert(product).values([
      { id: fixtures.residual.id, companyId, projectId, name: fixtures.residual.name, kind: "container-collection", status: "active", unit: "pickup", invoiceName: "Residual waste collection", invoiceCode: "4010", vatPercent: 25 },
      { id: fixtures.glass.id, companyId, projectId, name: fixtures.glass.name, kind: "container-collection", status: "active", unit: "pickup", vatPercent: 25 },
      { id: fixtures.rental.id, companyId, projectId, name: fixtures.rental.name, kind: "recurring-service", status: "active", unit: "month", vatPercent: 25 },
      { id: fixtures.unrated.id, companyId, projectId, name: fixtures.unrated.name, kind: "additional-service", status: "active", unit: "job" },
    ])
  })
  return fixtures
}

/** One row to seed on a list: the product, the price, and the conditions it names, each null where it names none. */
export type RowSeed = {
  productId: string
  unitPriceMinor: number
  planningAreaId?: string | null
  customerKind?: CustomerKind | null
  containerTypeId?: string | null
  wasteFractionId?: string | null
  customerId?: string | null
  note?: string | null
  validFrom?: string
  validTo?: string | null
}

export type PriceListSeed = {
  projectId?: string
  code: string
  name?: string
  currency?: string
  isDefault?: boolean
  validFrom?: string
  validTo?: string | null
  rows?: RowSeed[]
}

export type SeededPriceList = { id: string; code: string; currency: string; rowIds: string[] }

/** One list with its rows, in Copenhagen Central unless said otherwise; the rows' periods default to the list's. */
export async function seedPriceList(pool: Database, tenant: Tenant, seed: PriceListSeed): Promise<SeededPriceList> {
  const { companyId } = tenant
  const projectId = seed.projectId ?? tenant.projects.copenhagen.id
  const currency = seed.currency ?? "DKK"
  const validFrom = seed.validFrom ?? "2026-01-01"
  const validTo = seed.validTo === undefined ? null : seed.validTo
  const id = testId()
  const rows = seed.rows ?? []
  // One clock for the rows' ids, a millisecond apart, so their order is the order given and the resolver's last tie-break is predictable.
  const minted = Date.now()
  const rowIds = rows.map((_, index) => testId(minted + 1 + index))
  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.insert(priceList).values({ id, companyId, projectId, code: seed.code, name: seed.name ?? `Price list ${seed.code}`, currency, isDefault: seed.isDefault ?? false, validFrom, validTo })
    if (rows.length > 0) {
      await tx.insert(priceListRow).values(
        rows.map((row, index) => ({
          id: rowIds[index],
          companyId,
          projectId,
          priceListId: id,
          productId: row.productId,
          unitPriceMinor: row.unitPriceMinor,
          planningAreaId: row.planningAreaId ?? null,
          customerKind: row.customerKind ?? null,
          containerTypeId: row.containerTypeId ?? null,
          wasteFractionId: row.wasteFractionId ?? null,
          customerId: row.customerId ?? null,
          note: row.note ?? null,
          validFrom: row.validFrom ?? validFrom,
          validTo: row.validTo === undefined ? validTo : row.validTo,
        })),
      )
    }
  })
  return { id, code: seed.code, currency, rowIds }
}

export type ServiceAreaSeed = {
  projectId?: string
  code: string
  name?: string
  planningAreaIds?: string[]
  wasteFractionIds?: string[]
  validFrom?: string
  validTo?: string | null
  /** The first assignment; none when absent. Its period defaults to the area's. */
  assignment?: { serviceProviderId: string; validFrom?: string; validTo?: string | null }
  /** One provider price under the assignment; needs one. Its period defaults to the assignment's. */
  price?: { productId: string; bidMinor: number; unitPriceMinor?: number; validFrom?: string; validTo?: string | null }
}

export type SeededServiceArea = {
  id: string
  code: string
  projectId: string
  validFrom: string
  validTo: string | null
  /** Null when the seed made none. */
  assignmentId: string | null
  /** Null when the seed made none. */
  priceId: string | null
}

/** One award with its two sets, its first assignment and a provider price under it, in Copenhagen Central unless said otherwise. */
export async function seedServiceArea(pool: Database, tenant: Tenant, seed: ServiceAreaSeed): Promise<SeededServiceArea> {
  const { companyId } = tenant
  const projectId = seed.projectId ?? tenant.projects.copenhagen.id
  const validFrom = seed.validFrom ?? "2026-01-01"
  const validTo = seed.validTo === undefined ? null : seed.validTo
  const id = testId()
  const assignmentId = seed.assignment === undefined ? null : testId()
  const priceId = seed.price === undefined ? null : testId()
  if (priceId !== null && assignmentId === null) throw new Error(`seedServiceArea ${seed.code}: a price needs an assignment to hang on`)
  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.insert(serviceArea).values({ id, companyId, projectId, code: seed.code, name: seed.name ?? `Service area ${seed.code}`, boundaryText: `The contract's boundary for ${seed.code}`, validFrom, validTo })
    const planningAreaIds = seed.planningAreaIds ?? []
    if (planningAreaIds.length > 0) {
      await tx.insert(serviceAreaPlanningArea).values(planningAreaIds.map((planningAreaId) => ({ id: testId(), companyId, projectId, serviceAreaId: id, planningAreaId })))
    }
    const wasteFractionIds = seed.wasteFractionIds ?? []
    if (wasteFractionIds.length > 0) {
      await tx.insert(serviceAreaWasteFraction).values(wasteFractionIds.map((wasteFractionId) => ({ id: testId(), companyId, projectId, serviceAreaId: id, wasteFractionId })))
    }
    if (seed.assignment !== undefined && assignmentId !== null) {
      const assignmentFrom = seed.assignment.validFrom ?? validFrom
      const assignmentTo = seed.assignment.validTo === undefined ? validTo : seed.assignment.validTo
      await tx.insert(serviceAreaAssignment).values({ id: assignmentId, companyId, projectId, serviceAreaId: id, serviceProviderId: seed.assignment.serviceProviderId, validFrom: assignmentFrom, validTo: assignmentTo })
      if (seed.price !== undefined && priceId !== null) {
        await tx.insert(serviceProviderPrice).values({
          id: priceId,
          companyId,
          projectId,
          serviceAreaAssignmentId: assignmentId,
          productId: seed.price.productId,
          bidMinor: seed.price.bidMinor,
          unitPriceMinor: seed.price.unitPriceMinor ?? seed.price.bidMinor,
          currency: "DKK",
          validFrom: seed.price.validFrom ?? assignmentFrom,
          validTo: seed.price.validTo === undefined ? assignmentTo : seed.price.validTo,
        })
      }
    }
  })
  return { id, code: seed.code, projectId, validFrom, validTo, assignmentId, priceId }
}

export type FinanceFixtures = {
  products: ProductFixtures
  /** A second Copenhagen Central planning area, `OP-CEN-02`, beside Planning's `OP-CEN-01`. */
  areas: { centrumNorth: { id: string; code: string } }
  lists: {
    /** The project's default tariff, `pl-cph-2026`, DKK, 2026: a default row and a Centrum row for the residual collection, a default row for glass. */
    default: SeededPriceList
    /** A named list an agreement may be priced under, `pl-housing-2026`, DKK, 2026: one cheaper residual row. */
    named: SeededPriceList
  }
  /** NordRen's award, `CA-Ø-2`, over both Copenhagen planning areas, 2026, with its assignment from 2026-03-01 and one residual price under it. */
  nordren: SeededServiceArea
}

/** The days the ground is cut from. */
export const FINANCE_YEAR = { from: "2026-01-01", to: "2027-01-01" } as const
/** The day NordRen's assignment starts: the award ran two months before anyone held it. */
export const NORDREN_ASSIGNED_FROM = "2026-03-01"

/** The §6 ground: the products, the two lists, NordRen's award. */
export async function seedFinance(pool: Database, tenant: Tenant, planning: PlanningFixtures): Promise<FinanceFixtures> {
  const { companyId } = tenant
  const copenhagen = tenant.projects.copenhagen.id
  const products = await seedProducts(pool, tenant)
  const centrumNorth = { id: testId(), code: "OP-CEN-02" }
  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.insert(planningArea).values({ id: centrumNorth.id, companyId, projectId: copenhagen, code: centrumNorth.code, name: "Centrum Nord", purpose: "route-planning" })
  })
  const defaultList = await seedPriceList(pool, tenant, {
    code: "pl-cph-2026",
    name: "Copenhagen Central 2026",
    isDefault: true,
    validFrom: FINANCE_YEAR.from,
    validTo: FINANCE_YEAR.to,
    rows: [
      { productId: products.residual.id, unitPriceMinor: 4_500 },
      { productId: products.residual.id, unitPriceMinor: 5_200, planningAreaId: planning.areas.centrum.id },
      { productId: products.glass.id, unitPriceMinor: 6_000 },
    ],
  })
  const named = await seedPriceList(pool, tenant, {
    code: "pl-housing-2026",
    name: "Housing associations 2026",
    validFrom: FINANCE_YEAR.from,
    validTo: FINANCE_YEAR.to,
    rows: [{ productId: products.residual.id, unitPriceMinor: 3_900 }],
  })
  const nordren = await seedServiceArea(pool, tenant, {
    code: "CA-Ø-2",
    name: "Østerbro 2",
    planningAreaIds: [planning.areas.centrum.id, centrumNorth.id],
    validFrom: FINANCE_YEAR.from,
    validTo: FINANCE_YEAR.to,
    assignment: { serviceProviderId: tenant.serviceProviders.nordren.id, validFrom: NORDREN_ASSIGNED_FROM },
    price: { productId: products.residual.id, bidMinor: 3_000 },
  })
  return { products, areas: { centrumNorth }, lists: { default: defaultList, named }, nordren }
}
