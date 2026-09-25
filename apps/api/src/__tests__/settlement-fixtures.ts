// What the settlements suite needs of Finance beyond its own routes (Issue
// #112, slice 5): an award with its assignment and its prices, and the
// billable events served under it, written directly through `tx` as
// `wms_api` inside `withCompany`, the way execution-fixtures.ts seeds the
// routes generation would have written — the suite proves the calculation
// and the three commands, not the price lists, the areas or the consumer,
// whose routes are slices 3 and 4 — and dropped with the rest of the company
// by `dropTenant`. Minimal on purpose: slice 3 owns `finance-fixtures.ts`,
// the ground the nine Finance suites share, and the integrator folds this
// into it.
//
// The ground, on the tenant's Copenhagen Central over `seedExecution`'s
// scheme: the scheme is given Centrum (OP-CEN-01) as its planning area, so
// its routes are served under an award over Centrum; a second planning area,
// OP-CEN-02, with a scheme of its own, is the ground for a route no NordRen
// award covers. Then a customer with an agreement (DKK, active), two
// products — one NordRen is paid for and one it is not — the project's
// default price list with a row per product (a `pickup` event names the row
// that priced it), NordRen's award `CA-Ø-2` over Centrum assigned from
// 2026-07-01 with its price for the first product in two rows, 50.00 kr
// until October and 55.00 kr indexed from it, and CityHaul's award `CA-Ø-3`
// over OP-CEN-02 assigned from January. Then the events, each a completed
// pickup on a completed route of its own day, priced by the list's row:
//
//   early            2026-09-07, the first product        — settled at 50.00
//   late             2026-10-05, the first product        — settled at 55.00, the indexed fee
//   unpriced         2026-09-14, the second product       — a line with no price, which blocks close
//   reversal         of `early`, on its service date      — a line at −50.00, reaching the route through the original
//   beforeAssignment 2026-06-15, in Centrum               — left out: the assignment was not yet valid
//   otherArea        2026-09-21, on OP-CEN-02             — left out: CityHaul's area, not NordRen's
//   cancelled        2026-09-28, cancelled by a correction — left out
//   blocked          2026-09-28, `no-price-row`           — left out: unpriced events are not served
//   manual           2026-09-28, the office's, no route   — left out: nothing places it in an area
//
// So a settlement over 2026-06-01 to 2026-11-01 calculates exactly four lines
// and a net of 5 500 øre, and the suite grows the ground from there.
import type { Database, Tx } from "@waste/db/client"
import { agreement } from "@waste/db/schema/agreements"
import { product } from "@waste/db/schema/catalogue"
import { customer } from "@waste/db/schema/customers"
import { billableEvent, priceList, priceListRow, serviceArea, serviceAreaAssignment, serviceAreaPlanningArea, serviceAreaWasteFraction, serviceProviderPrice } from "@waste/db/schema/finance"
import { planningArea } from "@waste/db/schema/planning-areas"
import { routeScheme } from "@waste/db/schema/route-schemes"
import { withCompany } from "@waste/db/tenant"
import { and, eq } from "drizzle-orm"

import { at, seedRoute, type ExecutionFixtures, type SchemeFixture, type SeededRoute } from "./execution-fixtures"
import type { FleetFixtures, PlanningFixtures } from "./scheme-fixtures"
import { testId, type Tenant } from "./tenant"

/** A billable event as the suite names it: its id, its service date, and the route and pickup it charges for. */
export type EventFixture = { id: string; serviceDate: string; route: SeededRoute | null }

export type SettlementFixtures = {
  /** OP-CEN-02, a second Copenhagen planning area, and the scheme whose routes run there. */
  second: { planningArea: { id: string }; scheme: SchemeFixture }
  customer: { id: string }
  agreement: { id: string }
  /** The product NordRen is paid for, and the one it is not. */
  products: { collection: { id: string }; unpriced: { id: string } }
  priceList: { id: string }
  rows: { collection: { id: string }; unpriced: { id: string } }
  areas: { nordren: { id: string; code: string }; cityhaul: { id: string; code: string } }
  assignments: { nordren: { id: string }; cityhaul: { id: string } }
  /** NordRen's fee for the first product: 5 000 øre until 2026-10-01, then 5 500 indexed from it. */
  prices: { early: { id: string; unitPriceMinor: number }; indexed: { id: string; unitPriceMinor: number } }
  events: {
    early: EventFixture
    late: EventFixture
    unpriced: EventFixture
    reversal: EventFixture
    beforeAssignment: EventFixture
    otherArea: EventFixture
    cancelled: EventFixture
    blocked: EventFixture
    manual: EventFixture
  }
}

/** The customer's price on the list: 120.00 kr a pickup at 25 % VAT, what every priced event here was billed at. */
export const CUSTOMER_PRICE = { unitPriceMinor: 12_000, netMinor: 12_000, vatPercent: 25, vatMinor: 3000, currency: "DKK" }

/** What a `pickup` event of the consumer's carries: the price frozen, the row that won, the outbox event it came from, no person. */
type PickupEventSeed = {
  id: string
  projectId: string
  serviceDate: string
  productId: string
  rowId: string
  route: SeededRoute
  cancelled?: boolean
  blocked?: boolean
}

/** A completed route of one day with one completed pickup on the first bin: the stop an event charges for. */
async function completedRoute(pool: Database, tenant: Tenant, fleet: FleetFixtures, ex: ExecutionFixtures, day: string, scheme: SchemeFixture = ex.schemes.copenhagen): Promise<SeededRoute> {
  return await seedRoute(
    pool,
    tenant,
    fleet,
    { ...ex, schemes: { ...ex.schemes, copenhagen: scheme } },
    {
      status: "completed",
      operatingDate: day,
      plannedDriverId: fleet.drivers.mads.id,
      plannedVehicleId: fleet.vehicles.wh24.id,
      depotId: fleet.depots.nordhavn.id,
      unloadingStationId: fleet.stations.amager.id,
      pickups: [{ containerId: ex.containers.bin1.id, propertyId: ex.properties.parkvej.id, status: "completed", arrivedAt: at(day, "06:40"), outcomeAt: at(day, "06:45") }],
    },
  )
}

/** Seeds the ground above and answers its ids; `seedPlanning`, `seedFleet` and `seedExecution` must have run. */
export async function seedSettlementFixtures(pool: Database, tenant: Tenant, planning: PlanningFixtures, fleet: FleetFixtures, ex: ExecutionFixtures): Promise<SettlementFixtures> {
  const { companyId } = tenant
  const copenhagen = tenant.projects.copenhagen.id
  const ground = {
    second: { planningArea: { id: testId() }, scheme: { id: testId() } },
    customer: { id: testId() },
    agreement: { id: testId() },
    products: { collection: { id: testId() }, unpriced: { id: testId() } },
    priceList: { id: testId() },
    rows: { collection: { id: testId() }, unpriced: { id: testId() } },
    areas: { nordren: { id: testId(), code: "CA-Ø-2" }, cityhaul: { id: testId(), code: "CA-Ø-3" } },
    assignments: { nordren: { id: testId() }, cityhaul: { id: testId() } },
    prices: { early: { id: testId(), unitPriceMinor: 5000 }, indexed: { id: testId(), unitPriceMinor: 5500 } },
  }

  await withCompany(pool.db, companyId, async (tx: Tx) => {
    // The scheme every Copenhagen route of `seedExecution` names runs in Centrum; the second scheme in the other area.
    await tx
      .update(routeScheme)
      .set({ planningAreaId: planning.areas.centrum.id })
      .where(and(eq(routeScheme.companyId, companyId), eq(routeScheme.id, ex.schemes.copenhagen.id)))
    await tx.insert(planningArea).values({ id: ground.second.planningArea.id, companyId, projectId: copenhagen, code: "OP-CEN-02", name: "Centrum Vest", purpose: "route-planning" })
    await tx.insert(routeScheme).values({
      id: ground.second.scheme.id,
      companyId,
      projectId: copenhagen,
      name: "Centrum Vest Mondays",
      serviceType: "container-collection",
      frequency: "weekly",
      serviceDays: ["monday"],
      validFrom: "2026-01-01",
      status: "validated",
      planningAreaId: ground.second.planningArea.id,
      depotId: fleet.depots.nordhavn.id,
      unloadingStationId: fleet.stations.amager.id,
    })
    await tx.insert(customer).values({ id: ground.customer.id, companyId, kind: "organisation", name: "Østerbro Boligforening", status: "active" })
    await tx.insert(product).values([
      { id: ground.products.collection.id, companyId, projectId: copenhagen, name: "Residual collection · 240 L", kind: "container-collection", status: "active", unit: "pickup", vatPercent: 25 },
      { id: ground.products.unpriced.id, companyId, projectId: copenhagen, name: "Bulky waste collection", kind: "additional-service", status: "active", unit: "job", vatPercent: 25 },
    ])
    await tx.insert(agreement).values({
      id: ground.agreement.id,
      companyId,
      projectId: copenhagen,
      number: "AGR-2408",
      customerId: ground.customer.id,
      payerCustomerId: ground.customer.id,
      status: "active",
      billingCadence: "monthly",
      currency: "DKK",
      validFrom: "2026-01-01",
    })
    await tx.insert(priceList).values({ id: ground.priceList.id, companyId, projectId: copenhagen, code: "PL-CPH-2026", name: "Copenhagen tariff 2026", currency: "DKK", isDefault: true, validFrom: "2026-01-01" })
    await tx.insert(priceListRow).values([
      { id: ground.rows.collection.id, companyId, projectId: copenhagen, priceListId: ground.priceList.id, productId: ground.products.collection.id, unitPriceMinor: CUSTOMER_PRICE.unitPriceMinor, validFrom: "2026-01-01" },
      { id: ground.rows.unpriced.id, companyId, projectId: copenhagen, priceListId: ground.priceList.id, productId: ground.products.unpriced.id, unitPriceMinor: CUSTOMER_PRICE.unitPriceMinor, validFrom: "2026-01-01" },
    ])
    await tx.insert(serviceArea).values([
      { id: ground.areas.nordren.id, companyId, projectId: copenhagen, code: ground.areas.nordren.code, name: "Østerbro 2", boundaryText: "Østerbro east of Østerbrogade, the harbour side excluded", validFrom: "2026-01-01" },
      { id: ground.areas.cityhaul.id, companyId, projectId: copenhagen, code: ground.areas.cityhaul.code, name: "Centrum Vest", boundaryText: "The inner city west of Nørreport", validFrom: "2026-01-01" },
    ])
    await tx.insert(serviceAreaPlanningArea).values([
      { id: testId(), companyId, projectId: copenhagen, serviceAreaId: ground.areas.nordren.id, planningAreaId: planning.areas.centrum.id },
      { id: testId(), companyId, projectId: copenhagen, serviceAreaId: ground.areas.cityhaul.id, planningAreaId: ground.second.planningArea.id },
    ])
    await tx.insert(serviceAreaWasteFraction).values([
      { id: testId(), companyId, projectId: copenhagen, serviceAreaId: ground.areas.nordren.id, wasteFractionId: ex.fractions.residual.id },
      { id: testId(), companyId, projectId: copenhagen, serviceAreaId: ground.areas.cityhaul.id, wasteFractionId: ex.fractions.residual.id },
    ])
    await tx.insert(serviceAreaAssignment).values([
      { id: ground.assignments.nordren.id, companyId, projectId: copenhagen, serviceAreaId: ground.areas.nordren.id, serviceProviderId: tenant.serviceProviders.nordren.id, validFrom: "2026-07-01" },
      { id: ground.assignments.cityhaul.id, companyId, projectId: copenhagen, serviceAreaId: ground.areas.cityhaul.id, serviceProviderId: tenant.serviceProviders.cityhaul.id, validFrom: "2026-01-01" },
    ])
    await tx.insert(serviceProviderPrice).values([
      {
        id: ground.prices.early.id,
        companyId,
        projectId: copenhagen,
        serviceAreaAssignmentId: ground.assignments.nordren.id,
        productId: ground.products.collection.id,
        bidMinor: 5000,
        unitPriceMinor: ground.prices.early.unitPriceMinor,
        currency: "DKK",
        validFrom: "2026-07-01",
        validTo: "2026-10-01",
      },
      {
        id: ground.prices.indexed.id,
        companyId,
        projectId: copenhagen,
        serviceAreaAssignmentId: ground.assignments.nordren.id,
        productId: ground.products.collection.id,
        bidMinor: 5000,
        unitPriceMinor: ground.prices.indexed.unitPriceMinor,
        currency: "DKK",
        indexedFromId: ground.prices.early.id,
        indexLabel: "CPI",
        indexBasisPoints: 1000,
        indexBase: "current-fee",
        validFrom: "2026-10-01",
      },
    ])
  })

  const routes = {
    early: await completedRoute(pool, tenant, fleet, ex, "2026-09-07"),
    late: await completedRoute(pool, tenant, fleet, ex, "2026-10-05"),
    unpriced: await completedRoute(pool, tenant, fleet, ex, "2026-09-14"),
    beforeAssignment: await completedRoute(pool, tenant, fleet, ex, "2026-06-15"),
    otherArea: await completedRoute(pool, tenant, fleet, ex, "2026-09-21", ground.second.scheme),
    cancelled: await completedRoute(pool, tenant, fleet, ex, "2026-09-28"),
  }
  const events: SettlementFixtures["events"] = {
    early: { id: testId(), serviceDate: "2026-09-07", route: routes.early },
    late: { id: testId(), serviceDate: "2026-10-05", route: routes.late },
    unpriced: { id: testId(), serviceDate: "2026-09-14", route: routes.unpriced },
    reversal: { id: testId(), serviceDate: "2026-09-07", route: null },
    beforeAssignment: { id: testId(), serviceDate: "2026-06-15", route: routes.beforeAssignment },
    otherArea: { id: testId(), serviceDate: "2026-09-21", route: routes.otherArea },
    cancelled: { id: testId(), serviceDate: "2026-09-28", route: routes.cancelled },
    blocked: { id: testId(), serviceDate: "2026-09-28", route: routes.cancelled },
    manual: { id: testId(), serviceDate: "2026-09-28", route: null },
  }
  const pickupEvent = (seed: PickupEventSeed) => ({
    id: seed.id,
    companyId,
    projectId: seed.projectId,
    kind: "pickup",
    serviceDate: seed.serviceDate,
    agreementId: ground.agreement.id,
    subscriptionId: null,
    productId: seed.productId,
    quantity: 1,
    ...(seed.blocked ? { unitPriceMinor: null, netMinor: null, vatPercent: null, vatMinor: null, currency: null, priceListRowId: null, blockReason: "no-price-row" } : { ...CUSTOMER_PRICE, priceListRowId: seed.rowId, blockReason: null }),
    routeId: seed.route.id,
    pickupId: seed.route.pickupIds[0],
    sourceEventId: testId(),
    createdBy: null,
    ...(seed.cancelled ? { cancelledAt: at(seed.serviceDate, "15:00"), cancelledBy: null, cancelReason: "pickup-corrected" } : {}),
  })
  await withCompany(pool.db, companyId, async (tx: Tx) => {
    const collection = (fixture: EventFixture, extra: Partial<PickupEventSeed> = {}): PickupEventSeed => ({
      id: fixture.id,
      projectId: copenhagen,
      serviceDate: fixture.serviceDate,
      productId: ground.products.collection.id,
      rowId: ground.rows.collection.id,
      route: fixture.route as SeededRoute,
      ...extra,
    })
    await tx.insert(billableEvent).values([
      pickupEvent(collection(events.early)),
      pickupEvent(collection(events.late)),
      pickupEvent(collection(events.unpriced, { productId: ground.products.unpriced.id, rowId: ground.rows.unpriced.id })),
      pickupEvent(collection(events.beforeAssignment)),
      pickupEvent(collection(events.otherArea)),
      pickupEvent(collection(events.cancelled, { cancelled: true })),
      pickupEvent(collection(events.blocked, { blocked: true })),
      // The reversal of `early`: the original's amounts negated, the original named, no pickup of its own, the consumer's.
      {
        id: events.reversal.id,
        companyId,
        projectId: copenhagen,
        kind: "reversal",
        serviceDate: events.early.serviceDate,
        agreementId: ground.agreement.id,
        subscriptionId: null,
        productId: ground.products.collection.id,
        quantity: 1,
        unitPriceMinor: CUSTOMER_PRICE.unitPriceMinor,
        netMinor: -CUSTOMER_PRICE.netMinor,
        vatPercent: CUSTOMER_PRICE.vatPercent,
        vatMinor: -CUSTOMER_PRICE.vatMinor,
        currency: CUSTOMER_PRICE.currency,
        priceListRowId: null,
        blockReason: null,
        routeId: null,
        pickupId: null,
        reversesEventId: events.early.id,
        sourceEventId: testId(),
        createdBy: null,
      },
      // The office's own entry: a person's, priced by the row, on no route.
      {
        id: events.manual.id,
        companyId,
        projectId: copenhagen,
        kind: "manual",
        serviceDate: events.manual.serviceDate,
        agreementId: ground.agreement.id,
        subscriptionId: null,
        productId: ground.products.collection.id,
        quantity: 2,
        unitPriceMinor: CUSTOMER_PRICE.unitPriceMinor,
        netMinor: 2 * CUSTOMER_PRICE.netMinor,
        vatPercent: CUSTOMER_PRICE.vatPercent,
        vatMinor: 2 * CUSTOMER_PRICE.vatMinor,
        currency: CUSTOMER_PRICE.currency,
        priceListRowId: ground.rows.collection.id,
        blockReason: null,
        sourceEventId: null,
        createdBy: tenant.users.olivia.id,
        note: "Two extra collections after the festival",
      },
    ])
  })

  return { ...ground, events }
}

/**
 * One more priced `pickup` event of the first product on a completed route of
 * the day given, in Centrum: what the suite records after a calculation to
 * prove a close waits for the next one.
 */
export async function recordServedEvent(pool: Database, tenant: Tenant, fleet: FleetFixtures, ex: ExecutionFixtures, fixtures: SettlementFixtures, day: string): Promise<EventFixture> {
  const route = await completedRoute(pool, tenant, fleet, ex, day)
  const fixture: EventFixture = { id: testId(), serviceDate: day, route }
  await withCompany(pool.db, tenant.companyId, async (tx: Tx) => {
    await tx.insert(billableEvent).values({
      id: fixture.id,
      companyId: tenant.companyId,
      projectId: tenant.projects.copenhagen.id,
      kind: "pickup",
      serviceDate: day,
      agreementId: fixtures.agreement.id,
      subscriptionId: null,
      productId: fixtures.products.collection.id,
      quantity: 1,
      ...CUSTOMER_PRICE,
      priceListRowId: fixtures.rows.collection.id,
      blockReason: null,
      routeId: route.id,
      pickupId: route.pickupIds[0],
      sourceEventId: testId(),
      createdBy: null,
    })
  })
  return fixture
}

/** NordRen's fee for the second product, added the way slice 3's route would write it: 20.00 kr a job from the assignment's start. */
export async function priceTheUnpricedProduct(pool: Database, tenant: Tenant, fixtures: SettlementFixtures): Promise<{ id: string; unitPriceMinor: number }> {
  const price = { id: testId(), unitPriceMinor: 2000 }
  await withCompany(pool.db, tenant.companyId, async (tx: Tx) => {
    await tx.insert(serviceProviderPrice).values({
      id: price.id,
      companyId: tenant.companyId,
      projectId: tenant.projects.copenhagen.id,
      serviceAreaAssignmentId: fixtures.assignments.nordren.id,
      productId: fixtures.products.unpriced.id,
      bidMinor: price.unitPriceMinor,
      unitPriceMinor: price.unitPriceMinor,
      currency: "DKK",
      validFrom: "2026-07-01",
    })
  })
  return price
}
