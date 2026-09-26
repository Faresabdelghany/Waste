// A company of the worker suite's own on the shared local database, with the
// rows the Finance consumer reads beside an event: the ground of
// record-billable-events.test.ts and run-billing.test.ts. Seeded the way the
// API's suites seed theirs (`apps/api/src/__tests__/tenant.ts`) — as
// `wms_api`, inside `withCompany`, the company row first with `company_id =
// id` so the fence's WITH CHECK passes, then everything else in dependency
// order — and dropped the same way in reverse, the ledgers as the owner, so a
// failing test leaves no rows behind. Every value unique across companies is
// random, so two files run at once without meeting each other or the demo
// company.
//
// The ground is what §3's table reads: a Copenhagen project on
// `Europe/Copenhagen` and a second, `onboarding`, project the schedule must
// skip; a customer with a signed agreement and one whose agreement is a
// draft; four products — a residual collection per pickup at 25 %, a glass
// collection per pickup under a product with no VAT rate, a bin rental per
// month, a bulky job — a default price list with a default row and a Centrum
// row for the residual collection, and a negotiated row for the housing
// association; a planning area the scheme names; a route scheme, a
// collection group and a completed route with the pickups a suite asks for,
// each bin placed under its subscription on the route's day; and a ticket a
// suite completes. Ids are minted by `testId`, the API's spelling of a
// UUIDv7 by hand.
import { randomBytes, randomInt, randomUUID } from "node:crypto"

import type { Database, Tx } from "@waste/db/client"
import { role, roleGrant, userAccount } from "@waste/db/schema/access"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { containerType, product, wasteFraction } from "@waste/db/schema/catalogue"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { customer, property } from "@waste/db/schema/customers"
import { outboxEvent, pickup, route } from "@waste/db/schema/execution"
import { billableEvent, billingRun, billingRunExclusion, invoice, invoiceLine, priceList, priceListRow } from "@waste/db/schema/finance"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { vehicleType } from "@waste/db/schema/fleet-types"
import { company, project } from "@waste/db/schema/organisation"
import { planningArea } from "@waste/db/schema/planning-areas"
import { ticket, ticketEvent } from "@waste/db/schema/resolution"
import { collectionGroup, routeScheme } from "@waste/db/schema/route-schemes"
import { withCompany } from "@waste/db/tenant"
import type { PickupStatus } from "@waste/domain/execution/vocabulary"
import type { TicketResolution } from "@waste/domain/resolution/vocabulary"
import { eq, sql } from "drizzle-orm"

/** A UUID version 7 for a test row: the clock in the first 48 bits, the version and variant nibbles, randomness in the rest. */
export function testId(now = Date.now()): string {
  const time = now.toString(16).padStart(12, "0")
  const random = randomBytes(10).toString("hex")
  const variant = (0x8 | (parseInt(random[3], 16) & 0x3)).toString(16)
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${random.slice(0, 3)}-${variant}${random.slice(4, 7)}-${random.slice(7, 19)}`
}

/** The Monday the seeded route ran on: service date and operating date alike. */
export const FIXTURE_DAY = "2026-10-05"

/** An instant on Copenhagen's clock (CEST, +02:00) on a day. */
export const at = (day: string, time: string): Date => new Date(`${day}T${time}:00+02:00`)

export type FinanceTenant = {
  companyId: string
  projects: { copenhagen: { id: string; timezone: string }; onboarding: { id: string } }
  users: { olivia: { id: string } }
  customers: { housing: { id: string }; anna: { id: string }; bo: { id: string } }
  products: { residual: { id: string }; glass: { id: string }; rental: { id: string }; bulky: { id: string } }
  fractions: { residual: { id: string }; glass: { id: string } }
  containerTypes: { bin: { id: string } }
  planningAreas: { centrum: { id: string } }
  priceList: { id: string; rows: { residual: { id: string; unitPriceMinor: number }; residualCentrum: { id: string; unitPriceMinor: number }; residualHousing: { id: string; unitPriceMinor: number }; bulky: { id: string; unitPriceMinor: number } } }
  agreements: { housing: { id: string }; anna: { id: string }; draft: { id: string } }
  properties: { parkvej: { id: string }; havnegade: { id: string } }
  scheme: { id: string; groupId: string }
  /** The truck and the driver every completed route here went out with: what `route_actual_shape` asks of a started route. */
  fleet: { vehicleTypeId: string; vehicleId: string; driverId: string }
}

const grants = (companyId: string, roleId: string) => [{ companyId, roleId, moduleKey: "commercial.events", action: "view" }]

/** Seeds the ground as `wms_api` and answers its ids; drop it with `dropFinanceTenant` in `after`. */
export async function seedFinanceTenant(pool: Database): Promise<FinanceTenant> {
  const companyId = testId()
  const slug = randomBytes(4).toString("hex")
  const tenant: FinanceTenant = {
    companyId,
    projects: { copenhagen: { id: testId(), timezone: "Europe/Copenhagen" }, onboarding: { id: testId() } },
    users: { olivia: { id: testId() } },
    customers: { housing: { id: testId() }, anna: { id: testId() }, bo: { id: testId() } },
    products: { residual: { id: testId() }, glass: { id: testId() }, rental: { id: testId() }, bulky: { id: testId() } },
    fractions: { residual: { id: testId() }, glass: { id: testId() } },
    containerTypes: { bin: { id: testId() } },
    planningAreas: { centrum: { id: testId() } },
    priceList: { id: testId(), rows: { residual: { id: testId(1), unitPriceMinor: 12_000 }, residualCentrum: { id: testId(2), unitPriceMinor: 13_500 }, residualHousing: { id: testId(3), unitPriceMinor: 10_000 }, bulky: { id: testId(4), unitPriceMinor: 35_000 } } },
    agreements: { housing: { id: testId() }, anna: { id: testId() }, draft: { id: testId() } },
    properties: { parkvej: { id: testId() }, havnegade: { id: testId() } },
    scheme: { id: testId(), groupId: testId() },
    fleet: { vehicleTypeId: testId(), vehicleId: testId(), driverId: testId() },
  }
  const copenhagen = tenant.projects.copenhagen.id
  const roleId = testId()

  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.insert(company).values({ id: companyId, companyId, name: `Worker Test ${slug}`, legalName: `Worker Test ${slug} A/S`, registrationNumber: String(randomInt(10_000_000, 100_000_000)), country: "DK", status: "active" })
    await tx.insert(project).values([
      { id: copenhagen, companyId, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: tenant.projects.copenhagen.timezone, status: "active" },
      { id: tenant.projects.onboarding.id, companyId, name: "Harbor Commercial", kind: "Business unit", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "onboarding" },
    ])
    await tx.insert(role).values({ id: roleId, companyId, key: null, name: "Viewer", scope: "Assigned projects", description: "Looks at events", system: false })
    await tx.insert(userAccount).values({ id: tenant.users.olivia.id, companyId, authUserId: randomUUID(), email: `olivia.larsen@${slug}.example`, fullName: "Olivia Larsen", roleId, allProjects: true, primaryAdministrator: true })
    await tx.insert(roleGrant).values(grants(companyId, roleId))
    await tx.insert(customer).values([
      { id: tenant.customers.housing.id, companyId, kind: "organisation", name: "Østerbro Housing Association", status: "active" },
      { id: tenant.customers.anna.id, companyId, kind: "person", name: "Anna Andersen", status: "active" },
      { id: tenant.customers.bo.id, companyId, kind: "person", name: "Bo Berg", status: "active" },
    ])
    await tx.insert(wasteFraction).values([
      { id: tenant.fractions.residual.id, companyId, key: "residual", name: "Residual waste" },
      { id: tenant.fractions.glass.id, companyId, key: "glass", name: "Glass" },
    ])
    await tx.insert(containerType).values({ id: tenant.containerTypes.bin.id, companyId, name: "240 L bin", volumeLitres: 240 })
    await tx.insert(product).values([
      { id: tenant.products.residual.id, companyId, projectId: copenhagen, name: "Residual collection", kind: "container-collection", status: "active", unit: "pickup", invoiceName: "Restaffald 240 L", invoiceCode: "4010", vatPercent: 25 },
      { id: tenant.products.glass.id, companyId, projectId: copenhagen, name: "Glass collection", kind: "container-collection", status: "active", unit: "pickup" },
      { id: tenant.products.rental.id, companyId, projectId: copenhagen, name: "Bin rental", kind: "recurring-service", status: "active", unit: "month", vatPercent: 25 },
      { id: tenant.products.bulky.id, companyId, projectId: copenhagen, name: "Bulky pickup", kind: "additional-service", status: "active", unit: "job", vatPercent: 25 },
    ])
    await tx.insert(planningArea).values({ id: tenant.planningAreas.centrum.id, companyId, projectId: copenhagen, code: "OP-CEN-01", name: "Centrum", purpose: "route-planning" })
    await tx.insert(priceList).values({ id: tenant.priceList.id, companyId, projectId: copenhagen, code: "pl-cph-2026", name: "Copenhagen tariff 2026", currency: "DKK", isDefault: true, validFrom: "2026-01-01", validTo: null })
    const { rows } = tenant.priceList
    const row = (fixture: { id: string; unitPriceMinor: number }, productId: string, conditions: { planningAreaId?: string; customerId?: string } = {}) => ({
      id: fixture.id,
      companyId,
      projectId: copenhagen,
      priceListId: tenant.priceList.id,
      productId,
      unitPriceMinor: fixture.unitPriceMinor,
      planningAreaId: conditions.planningAreaId ?? null,
      customerId: conditions.customerId ?? null,
      validFrom: "2026-01-01",
      validTo: null,
    })
    await tx.insert(priceListRow).values([
      row(rows.residual, tenant.products.residual.id),
      row(rows.residualCentrum, tenant.products.residual.id, { planningAreaId: tenant.planningAreas.centrum.id }),
      row(rows.residualHousing, tenant.products.residual.id, { customerId: tenant.customers.housing.id }),
      row(rows.bulky, tenant.products.bulky.id),
    ])
    const signed = (id: string, number: string, customerId: string, status = "active") => ({ id, companyId, projectId: copenhagen, number, customerId, payerCustomerId: customerId, status, billingCadence: "monthly", currency: "DKK", validFrom: "2026-01-01" })
    await tx.insert(agreement).values([signed(tenant.agreements.housing.id, "AGR-100", tenant.customers.housing.id), signed(tenant.agreements.anna.id, "AGR-102", tenant.customers.anna.id), signed(tenant.agreements.draft.id, "AGR-103", tenant.customers.bo.id, "draft")])
    const home = (id: string, name: string, address: string) => ({ id, companyId, projectId: copenhagen, name, address, kind: "residential", status: "active" })
    await tx.insert(property).values([home(tenant.properties.parkvej.id, "Parkvej 18", "Parkvej 18, 2100 København Ø"), home(tenant.properties.havnegade.id, "Havnegade 3", "Havnegade 3, 1058 København K")])
    await tx.insert(routeScheme).values({ id: tenant.scheme.id, companyId, projectId: copenhagen, name: "Centrum Mondays", planningAreaId: tenant.planningAreas.centrum.id, serviceType: "container-collection", frequency: "weekly", serviceDays: ["monday"], validFrom: "2026-01-01", status: "validated" })
    await tx.insert(collectionGroup).values({ id: tenant.scheme.groupId, companyId, projectId: copenhagen, routeSchemeId: tenant.scheme.id, name: "Group 1", position: 1, days: ["monday"], stopSource: "rule" })
    await tx.insert(vehicleType).values({ id: tenant.fleet.vehicleTypeId, companyId, key: "rear-loader", name: "Rear loader" })
    await tx.insert(vehicle).values({ id: tenant.fleet.vehicleId, companyId, projectId: copenhagen, registration: "AB 12 345", callsign: "WH-24", kind: "powered-vehicle", vehicleTypeId: tenant.fleet.vehicleTypeId, ownership: "company", status: "active", requiredLicenceClass: "c" })
    await tx.insert(driver).values({ id: tenant.fleet.driverId, companyId, projectId: copenhagen, name: "Mads Jensen", employment: "employee", licenceClass: "ce", licenceExpiry: "2030-12-31", status: "active" })
  })
  return tenant
}

/** A bin placed at a property under a subscription of an agreement for a product, over a period: what a pickup's event reaches its agreement through. */
export type PlacedBin = { containerId: string; subscriptionId: string; placementId: string; propertyId: string }

export type PlaceOptions = {
  agreementId: string
  productId: string
  propertyId?: string
  /** The placement's period; open from 2026-01-01 unless said. */
  validFrom?: string
  validTo?: string | null
  /** The fraction the placement collects; residual unless said. */
  wasteFractionId?: string
}

/**
 * Places a bin under a subscription, as the Registry's rows would have it: a
 * property of the bin's own unless said (`subscription_no_overlap` holds one
 * subscription of an agreement, a product and a place at a time, and a suite
 * places several bins under one agreement), the subscription, the placement.
 */
export async function placeBin(pool: Database, tenant: FinanceTenant, label: string, options: PlaceOptions): Promise<PlacedBin> {
  const { companyId } = tenant
  const projectId = tenant.projects.copenhagen.id
  const placed: PlacedBin = { containerId: testId(), subscriptionId: testId(), placementId: testId(), propertyId: options.propertyId ?? testId() }
  await withCompany(pool.db, companyId, async (tx: Tx) => {
    if (options.propertyId === undefined) {
      await tx.insert(property).values({ id: placed.propertyId, companyId, projectId, name: `${label}'s address`, address: `${label} 1, 2100 København Ø`, kind: "residential", status: "active" })
    }
    await tx.insert(container).values({ id: placed.containerId, companyId, projectId, label, containerTypeId: tenant.containerTypes.bin.id, ownership: "company" })
    await tx.insert(subscription).values({ id: placed.subscriptionId, companyId, projectId, agreementId: options.agreementId, productId: options.productId, propertyId: placed.propertyId, quantity: 1, validFrom: options.validFrom ?? "2026-01-01", validTo: options.validTo ?? null })
    await tx.insert(containerServicePlacement).values({ id: placed.placementId, companyId, projectId, containerId: placed.containerId, subscriptionId: placed.subscriptionId, wasteFractionId: options.wasteFractionId ?? tenant.fractions.residual.id, validFrom: options.validFrom ?? "2026-01-01", validTo: options.validTo ?? null })
  })
  return placed
}

export type StopSeed = { containerId: string; propertyId: string; status?: PickupStatus; wasteFractionId?: string }

export type SeededRoute = { id: string; number: number; serviceDate: string; pickupIds: string[] }

/** The next route number of the company, the way generation takes it. */
async function nextRouteNumber(tx: Tx, companyId: string): Promise<number> {
  const [row] = await tx
    .update(company)
    .set({ nextRouteNumber: sql`${company.nextRouteNumber} + 1` })
    .where(eq(company.id, companyId))
    .returning({ next: company.nextRouteNumber })
  if (row === undefined) throw new Error(`no company ${companyId} to number a route in`)
  return row.next - 1
}

/**
 * A completed route of the scheme on a day with the stops given, each
 * `completed` unless said, with the stamps a completed route carries. Its
 * group is minted per route, since the generation key holds one route per
 * scheme, group and service date.
 */
export async function seedCompletedRoute(pool: Database, tenant: FinanceTenant, stops: StopSeed[], serviceDate = FIXTURE_DAY): Promise<SeededRoute> {
  const { companyId } = tenant
  const projectId = tenant.projects.copenhagen.id
  const minted = Date.now()
  const id = testId(minted)
  const groupId = testId(minted)
  const pickupIds = stops.map((_, index) => testId(minted + 1 + index))
  let number = 0
  await withCompany(pool.db, companyId, async (tx: Tx) => {
    number = await nextRouteNumber(tx, companyId)
    await tx.insert(collectionGroup).values({ id: groupId, companyId, projectId, routeSchemeId: tenant.scheme.id, name: `Group ${number}`, position: number, days: ["monday"], stopSource: "rule" })
    await tx.insert(route).values({
      id,
      companyId,
      projectId,
      routeSchemeId: tenant.scheme.id,
      collectionGroupId: groupId,
      serviceDate,
      operatingDate: serviceDate,
      status: "completed",
      number,
      dispatchedAt: at(serviceDate, "05:30"),
      startedAt: at(serviceDate, "06:00"),
      completedAt: at(serviceDate, "13:00"),
      // A completed route went out: `route_actual_shape` wants the driver and the vehicle that started it.
      plannedVehicleId: tenant.fleet.vehicleId,
      plannedDriverId: tenant.fleet.driverId,
      actualVehicleId: tenant.fleet.vehicleId,
      actualDriverId: tenant.fleet.driverId,
    })
    await tx.insert(pickup).values(
      stops.map((stop, index) => {
        const status = stop.status ?? "completed"
        return {
          id: pickupIds[index],
          companyId,
          projectId,
          routeId: id,
          containerId: stop.containerId,
          position: index + 1,
          status,
          propertyId: stop.propertyId,
          sharedCollectionPointId: null,
          wasteFractionId: stop.wasteFractionId ?? tenant.fractions.residual.id,
          arrivedAt: status === "planned" ? null : at(serviceDate, "06:40"),
          outcomeAt: status === "planned" ? null : at(serviceDate, "06:45"),
          reason: status === "skipped" ? "not-presented" : status === "failed" ? "not-presented" : null,
        }
      }),
    )
  })
  return { id, number, serviceDate, pickupIds }
}

/** Moves a pickup's status the way a correction does, without the proof: what a `pickup-corrected` event's facts read. */
export async function movePickup(pool: Database, tenant: FinanceTenant, pickupId: string, status: PickupStatus): Promise<void> {
  await withCompany(pool.db, tenant.companyId, async (tx: Tx) => {
    await tx
      .update(pickup)
      .set({ status, reason: status === "skipped" || status === "failed" ? "not-presented" : null, outcomeAt: status === "planned" ? null : at(FIXTURE_DAY, "07:00") })
      .where(eq(pickup.id, pickupId))
  })
}

export type TicketSeed = {
  resolution: TicketResolution | null
  agreementId?: string | null
  /** A pickup of a route the ticket names, for the agreement reached through its placement. */
  pickup?: { routeId: string; pickupId: string } | null
  /** When it closed; a completed ticket carries one, an open one none. */
  closedAt?: Date | null
}

/** A ticket as Resolution would have written it, completed with a resolution or open, on Olivia's word. */
export async function seedTicket(pool: Database, tenant: FinanceTenant, seed: TicketSeed): Promise<{ id: string }> {
  const { companyId } = tenant
  const id = testId()
  const closedAt = seed.resolution === null ? null : (seed.closedAt ?? at("2026-10-07", "23:30"))
  await withCompany(pool.db, companyId, async (tx: Tx) => {
    const [numbered] = await tx
      .update(company)
      .set({ nextTicketNumber: sql`${company.nextTicketNumber} + 1` })
      .where(eq(company.id, companyId))
      .returning({ next: company.nextTicketNumber })
    await tx.insert(ticket).values({
      id,
      companyId,
      projectId: tenant.projects.copenhagen.id,
      number: (numbered?.next ?? 1) - 1,
      kind: "missed-collection",
      status: seed.resolution === null ? "open" : "completed",
      source: "phone",
      subject: "Bin not emptied",
      description: "The bin at Parkvej 18 was not emptied on Monday.",
      occurredAt: at(FIXTURE_DAY, "09:00"),
      createdBy: tenant.users.olivia.id,
      agreementId: seed.agreementId ?? null,
      routeId: seed.pickup?.routeId ?? null,
      pickupId: seed.pickup?.pickupId ?? null,
      resolution: seed.resolution,
      closedAt,
    })
  })
  return { id }
}

/** Deletes everything of the company, the ledgers as the owner first, children before parents. */
export async function dropFinanceTenant(pool: Database, owner: Database, companyId: string): Promise<void> {
  await owner.db.delete(invoiceLine).where(eq(invoiceLine.companyId, companyId))
  await owner.db.delete(invoice).where(eq(invoice.companyId, companyId))
  await owner.db.delete(billingRunExclusion).where(eq(billingRunExclusion.companyId, companyId))
  await owner.db.delete(ticketEvent).where(eq(ticketEvent.companyId, companyId))
  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.delete(billingRun).where(eq(billingRun.companyId, companyId))
    await tx.delete(billableEvent).where(eq(billableEvent.companyId, companyId))
    await tx.delete(priceListRow).where(eq(priceListRow.companyId, companyId))
    await tx.delete(ticket).where(eq(ticket.companyId, companyId))
    await tx.delete(outboxEvent).where(eq(outboxEvent.companyId, companyId))
    await tx.delete(pickup).where(eq(pickup.companyId, companyId))
    await tx.delete(route).where(eq(route.companyId, companyId))
    await tx.delete(collectionGroup).where(eq(collectionGroup.companyId, companyId))
    await tx.delete(routeScheme).where(eq(routeScheme.companyId, companyId))
    await tx.delete(vehicle).where(eq(vehicle.companyId, companyId))
    await tx.delete(driver).where(eq(driver.companyId, companyId))
    await tx.delete(vehicleType).where(eq(vehicleType.companyId, companyId))
    await tx.delete(planningArea).where(eq(planningArea.companyId, companyId))
    await tx.delete(containerServicePlacement).where(eq(containerServicePlacement.companyId, companyId))
    await tx.delete(subscription).where(eq(subscription.companyId, companyId))
    await tx.delete(agreement).where(eq(agreement.companyId, companyId))
    await tx.delete(priceList).where(eq(priceList.companyId, companyId))
    await tx.delete(container).where(eq(container.companyId, companyId))
    await tx.delete(product).where(eq(product.companyId, companyId))
    await tx.delete(property).where(eq(property.companyId, companyId))
    await tx.delete(customer).where(eq(customer.companyId, companyId))
    await tx.delete(containerType).where(eq(containerType.companyId, companyId))
    await tx.delete(wasteFraction).where(eq(wasteFraction.companyId, companyId))
    await tx.delete(roleGrant).where(eq(roleGrant.companyId, companyId))
    await tx.delete(userAccount).where(eq(userAccount.companyId, companyId))
    await tx.delete(role).where(eq(role.companyId, companyId))
    await tx.delete(project).where(eq(project.companyId, companyId))
    await tx.delete(company).where(eq(company.companyId, companyId))
  })
}
