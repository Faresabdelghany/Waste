// What the consumer's suite needs of a tenant and its Execution rows (Issue
// #109 part B): a company with one project, a driver, a route scheme with a
// group, a route in the state a test asks for with its pickups at addresses
// with bins, and the receipts a rejection's event carries — written directly
// through `tx` as `wms_api` inside `withCompany`, the way the API's suites
// seed theirs (apps/api/src/__tests__/tenant.ts, execution-fixtures.ts), since
// the worker's suite proves the consumer and not the office's routes. Every
// value unique across companies (the registration number) is random, so the
// worker's files run beside the API's on the shared local database without
// meeting each other or the demo company, and `dropTenant` sweeps the rows in
// key order — the ledgers as the owner where the suite has one, since
// `wms_api` may not delete from `ticket_event`, `proof_of_service` or
// `driver_command`.
//
// The events a test hands the job are built here too, as the applier would
// have emitted them (apps/api/src/routes/driver.ts): a `pickup-failed` or
// `pickup-skipped` carries the `Pickup` with the proof the command made, a
// route-level `pickup-problem-reported` the `Route` with `proofs`, a
// `command-rejected` the `DriverCommandReceipt` — the contracts' shapes,
// which the consumer parses, so a shape the applier does not write does not
// pass here either.
import { randomBytes, randomInt } from "node:crypto"

import type { DriverCommandReceipt } from "@waste/contracts/driver-commands"
import { routeLabel } from "@waste/contracts/execution"
import type { Pickup } from "@waste/contracts/pickups"
import type { ProofOfService } from "@waste/contracts/proofs"
import type { Route } from "@waste/contracts/routes"
import type { Database, Tx } from "@waste/db/client"
import { nextNumber } from "@waste/db/commands/shared"
import { createIdMinter } from "@waste/db/ids"
import { containerType, wasteFraction } from "@waste/db/schema/catalogue"
import { container } from "@waste/db/schema/containers"
import { property } from "@waste/db/schema/customers"
import { driverCommand, outboxEvent, pickup, proofOfService, route } from "@waste/db/schema/execution"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { vehicleType } from "@waste/db/schema/fleet-types"
import { company, project } from "@waste/db/schema/organisation"
import { alert, ticket, ticketEvent } from "@waste/db/schema/resolution"
import { collectionGroup, routeScheme } from "@waste/db/schema/route-schemes"
import { withCompany } from "@waste/db/tenant"
import type { PickupReason, PickupStatus, RouteStatus } from "@waste/domain/execution/vocabulary"
import { eq } from "drizzle-orm"

import type { OutboxJob } from "../outbox/queues"

/** Ids that count up from the wall clock: a UUIDv7 the contracts accept, one sequence for the suite. */
export const testId = createIdMinter()

/** The Monday the fixtures' routes run on, and Copenhagen's clock on it (CEST). */
export const FIXTURE_DAY = "2026-10-05"
export const at = (time: string): Date => new Date(`${FIXTURE_DAY}T${time}:00+02:00`)

export type ConsumerTenant = {
  companyId: string
  projectId: string
  /** Mads Jensen, the driver every route here is planned for. */
  driverId: string
  /** A second driver, for the fold's boundary. */
  otherDriverId: string
  /** WH-24, the vehicle every started route here went out on (`route_actual_shape` wants one). */
  vehicleId: string
  schemeId: string
  fractionId: string
  containerTypeId: string
  /** Two service addresses with a bin each: `BIN-1` at Parkvej 18, `BIN-2` at Havnegade 3. */
  properties: { parkvej: { id: string; address: string }; havnegade: { id: string; address: string } }
  containers: { bin1: { id: string; label: string }; bin2: { id: string; label: string } }
}

/** Seeds the company, its project, the two drivers, the vehicle, the scheme and the Registry rows a pickup names, as `wms_api`. */
export async function seedConsumerTenant(pool: Database): Promise<ConsumerTenant> {
  const companyId = testId()
  const slug = randomBytes(4).toString("hex")
  const vehicleTypeId = testId()
  const tenant: ConsumerTenant = {
    companyId,
    projectId: testId(),
    driverId: testId(),
    otherDriverId: testId(),
    vehicleId: testId(),
    schemeId: testId(),
    fractionId: testId(),
    containerTypeId: testId(),
    properties: {
      parkvej: { id: testId(), address: "Parkvej 18, 2100 København Ø" },
      havnegade: { id: testId(), address: "Havnegade 3, 1058 København K" },
    },
    containers: { bin1: { id: testId(), label: "BIN-1" }, bin2: { id: testId(), label: "BIN-2" } },
  }
  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.insert(company).values({ id: companyId, companyId, name: `Consumer Test ${slug}`, legalName: `Consumer Test ${slug} A/S`, registrationNumber: String(randomInt(10_000_000, 100_000_000)), country: "DK", status: "active" })
    await tx.insert(project).values({ id: tenant.projectId, companyId, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
    await tx.insert(driver).values([
      { id: tenant.driverId, companyId, projectId: tenant.projectId, name: "Mads Jensen", employment: "employee", licenceClass: "ce", licenceExpiry: "2030-12-31", status: "active" },
      { id: tenant.otherDriverId, companyId, projectId: tenant.projectId, name: "Freja Holm", employment: "employee", licenceClass: "ce", licenceExpiry: "2030-12-31", status: "active" },
    ])
    await tx.insert(vehicleType).values({ id: vehicleTypeId, companyId, key: "rear-loader", name: "Rear loader" })
    await tx.insert(vehicle).values({ id: tenant.vehicleId, companyId, projectId: tenant.projectId, registration: `CN ${randomInt(10, 99)} ${randomInt(100, 999)}`, callsign: "WH-24", kind: "powered-vehicle", vehicleTypeId, ownership: "company", status: "active", requiredLicenceClass: "c" })
    await tx.insert(routeScheme).values({ id: tenant.schemeId, companyId, projectId: tenant.projectId, name: "Centrum Mondays", serviceType: "container-collection", frequency: "weekly", serviceDays: ["monday"], validFrom: "2026-01-01", status: "validated" })
    await tx.insert(wasteFraction).values({ id: tenant.fractionId, companyId, key: "residual", name: "Residual waste" })
    await tx.insert(containerType).values({ id: tenant.containerTypeId, companyId, name: "240 L bin", volumeLitres: 240 })
    await tx.insert(property).values([
      { id: tenant.properties.parkvej.id, companyId, projectId: tenant.projectId, name: "Parkvej 18", address: tenant.properties.parkvej.address, kind: "residential", status: "active" },
      { id: tenant.properties.havnegade.id, companyId, projectId: tenant.projectId, name: "Havnegade 3", address: tenant.properties.havnegade.address, kind: "residential", status: "active" },
    ])
    await tx.insert(container).values([
      { id: tenant.containers.bin1.id, companyId, projectId: tenant.projectId, label: "BIN-1", containerTypeId: tenant.containerTypeId, ownership: "company" },
      { id: tenant.containers.bin2.id, companyId, projectId: tenant.projectId, label: "BIN-2", containerTypeId: tenant.containerTypeId, ownership: "company" },
    ])
  })
  return tenant
}

/** A route as a test names it: its id, its number and label, and its pickups in position order. */
export type SeededRoute = { id: string; number: number; label: string; pickupIds: string[]; collectionGroupId: string }

export type RouteSeed = {
  /** `completed` unless said otherwise: the route Mads went out on and ended; `cancelled` is the dispatcher's, started by nobody. */
  status?: Extract<RouteStatus, "completed" | "cancelled" | "active">
  /** The stops in position order; both bins, decided as given. */
  pickups?: { container: "bin1" | "bin2"; status: PickupStatus; reason?: PickupReason; note?: string }[]
}

/** The stamps a status carries (`route_stamps_shape`) and the actual assignment (`route_actual_shape`): a started route has Mads on it, a cancelled one nobody. */
function stampsFor(status: NonNullable<RouteSeed["status"]>) {
  const none = { dispatchedAt: null, startedAt: null, completedAt: null, cancelledAt: null }
  switch (status) {
    case "active":
      return { ...none, dispatchedAt: at("05:30"), startedAt: at("06:00") }
    case "completed":
      return { ...none, dispatchedAt: at("05:30"), startedAt: at("06:00"), completedAt: at("13:00") }
    case "cancelled":
      return { ...none, cancelledAt: at("05:00") }
  }
}

/** One route with its pickups, written as `wms_api`; the number off the company's counter the way generation takes it. */
export async function seedRoute(pool: Database, tenant: ConsumerTenant, seed: RouteSeed = {}): Promise<SeededRoute> {
  const { companyId, projectId } = tenant
  const status = seed.status ?? "completed"
  const stamps = stampsFor(status)
  const wentOut = stamps.startedAt !== null
  const routeId = testId()
  const collectionGroupId = testId()
  const stops = seed.pickups ?? [
    { container: "bin1", status: "failed", reason: "not-presented", note: "No bin at the kerb" },
    { container: "bin2", status: "skipped", reason: "route-ended" },
  ]
  const pickupIds = stops.map(() => testId())
  let number = 0
  await withCompany(pool.db, companyId, async (tx: Tx) => {
    number = await nextNumber(tx, companyId, "nextRouteNumber")
    await tx.insert(collectionGroup).values({ id: collectionGroupId, companyId, projectId, routeSchemeId: tenant.schemeId, name: `Group ${number}`, position: number, days: ["monday"], stopSource: "rule" })
    await tx.insert(route).values({
      id: routeId,
      companyId,
      projectId,
      routeSchemeId: tenant.schemeId,
      collectionGroupId,
      serviceDate: FIXTURE_DAY,
      operatingDate: FIXTURE_DAY,
      status,
      number,
      plannedDriverId: tenant.driverId,
      plannedVehicleId: tenant.vehicleId,
      actualDriverId: wentOut ? tenant.driverId : null,
      actualVehicleId: wentOut ? tenant.vehicleId : null,
      actualTrailerId: null,
      ...stamps,
    })
    await tx.insert(pickup).values(
      stops.map((stop, index) => {
        const bin = tenant.containers[stop.container]
        const place = stop.container === "bin1" ? tenant.properties.parkvej : tenant.properties.havnegade
        return {
          id: pickupIds[index],
          companyId,
          projectId,
          routeId,
          containerId: bin.id,
          position: index + 1,
          status: stop.status,
          reason: stop.reason ?? null,
          note: stop.note ?? null,
          propertyId: place.id,
          sharedCollectionPointId: null,
          wasteFractionId: tenant.fractionId,
          arrivedAt: null,
          outcomeAt: stop.status === "planned" ? null : at("07:12"),
        }
      }),
    )
  })
  return { id: routeId, number, label: routeLabel(number), pickupIds, collectionGroupId }
}

const STAMPS = { createdAt: at("06:00").toISOString(), updatedAt: at("07:12").toISOString() }

/** The `Pickup` as the wire carries it, for a payload; `proofs` beside it where the door wrote one. */
export function pickupPayload(tenant: ConsumerTenant, routeId: string, pickupId: string, stop: { container: "bin1" | "bin2"; status: PickupStatus; reason?: PickupReason; note?: string; position?: number }, proofs?: ProofOfService[]): Pickup & { proofs?: ProofOfService[] } {
  const place = stop.container === "bin1" ? tenant.properties.parkvej : tenant.properties.havnegade
  return {
    id: pickupId,
    projectId: tenant.projectId,
    routeId,
    containerId: tenant.containers[stop.container].id,
    position: stop.position ?? 1,
    status: stop.status,
    reason: stop.reason ?? null,
    note: stop.note ?? null,
    propertyId: place.id,
    sharedCollectionPointId: null,
    wasteFractionId: tenant.fractionId,
    arrivedAt: null,
    outcomeAt: at("07:12").toISOString(),
    ...STAMPS,
    ...(proofs === undefined ? {} : { proofs }),
  }
}

/** A driver-recorded proof of the kind on the stop (or on the route alone), as the applier wrote it. */
export function proofPayload(tenant: ConsumerTenant, routeId: string, pickupId: string | null, kind: ProofOfService["kind"], fields: { reason?: PickupReason; note?: string; recordedBy: string } & Partial<Pick<ProofOfService, "id">>): ProofOfService {
  return {
    id: fields.id ?? testId(),
    recordedAt: at("07:12").toISOString(),
    projectId: tenant.projectId,
    routeId,
    pickupId,
    sessionId: testId(),
    kind,
    source: "driver-app",
    occurredAt: at("07:12").toISOString(),
    recordedBy: fields.recordedBy,
    deviceId: "device-mads-1",
    location: null,
    locationAccuracyM: null,
    reason: fields.reason ?? null,
    note: fields.note ?? null,
    weightKg: null,
    objectKey: null,
    outcome: null,
  }
}

/** The `Route` as the wire carries it, for a problem reported on the route alone. */
export function routePayload(tenant: ConsumerTenant, seeded: SeededRoute, status: RouteStatus = "active"): Route {
  return {
    id: seeded.id,
    projectId: tenant.projectId,
    routeSchemeId: tenant.schemeId,
    collectionGroupId: seeded.collectionGroupId,
    serviceDate: FIXTURE_DAY,
    operatingDate: FIXTURE_DAY,
    number: seeded.number,
    label: seeded.label,
    status,
    note: null,
    cancelledByGeneration: false,
    generationRunId: null,
    plannedStartTime: null,
    planned: { vehicleId: tenant.vehicleId, driverId: tenant.driverId, trailerId: null, serviceProviderId: null, depotId: null, unloadingStationId: null },
    actual: { vehicleId: tenant.vehicleId, driverId: tenant.driverId, trailerId: null },
    dispatchedAt: at("05:30").toISOString(),
    startedAt: at("06:00").toISOString(),
    completedAt: null,
    cancelledAt: null,
    progress: { planned: 2, completed: 0, skipped: 0, failed: 0, total: 2, fraction: 0 },
    ...STAMPS,
  }
}

/** A rejected command's receipt, as the applier recorded and emitted it; written to `driver_command` too where `pool` is given, so the row the event describes is there. */
export function receiptPayload(tenant: ConsumerTenant, fields: { commandId?: string; routeId: string | null; pickupId?: string | null; driverId?: string; detail: string; status?: 404 | 409 | 400 }): DriverCommandReceipt {
  const status = fields.status ?? 409
  return {
    id: fields.commandId ?? testId(),
    recordedAt: at("07:12").toISOString(),
    projectId: tenant.projectId,
    routeId: fields.routeId,
    sessionId: null,
    pickupId: fields.routeId === null ? null : (fields.pickupId ?? null),
    driverId: fields.driverId ?? tenant.driverId,
    deviceId: "device-mads-1",
    kind: "complete-pickup",
    occurredAt: at("07:12").toISOString(),
    body: { pickupId: fields.pickupId ?? null },
    outcome: "rejected",
    problem: { type: "about:blank", title: status === 404 ? "Not Found" : status === 400 ? "Bad Request" : "Conflict", status, detail: fields.detail },
  }
}

/** Writes the receipt the event describes, as the applier would have, so a ticket naming it names a row that is there. */
export async function seedReceipt(pool: Database, tenant: ConsumerTenant, receipt: DriverCommandReceipt): Promise<void> {
  await withCompany(pool.db, tenant.companyId, async (tx: Tx) => {
    await tx.insert(driverCommand).values({
      id: receipt.id,
      companyId: tenant.companyId,
      projectId: receipt.projectId,
      routeId: receipt.routeId,
      sessionId: null,
      pickupId: receipt.pickupId,
      driverId: receipt.driverId,
      deviceId: receipt.deviceId,
      kind: receipt.kind,
      occurredAt: new Date(receipt.occurredAt),
      body: receipt.body,
      outcome: "rejected",
      problem: receipt.problem,
    })
  })
}

/** One job's data as the relay publishes it: the outbox row with the tenant beside it. `occurredAt` is the command's instant. */
export function outboxJob(tenant: ConsumerTenant, event: Pick<OutboxJob, "kind" | "aggregateKind" | "aggregateId" | "payload"> & Partial<Pick<OutboxJob, "id" | "occurredAt">>): OutboxJob {
  const occurredAt = event.occurredAt ?? at("07:12").toISOString()
  return {
    id: event.id ?? testId(),
    companyId: tenant.companyId,
    projectId: tenant.projectId,
    kind: event.kind,
    aggregateKind: event.aggregateKind,
    aggregateId: event.aggregateId,
    occurredAt,
    payload: event.payload,
    publishedAt: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  }
}

/**
 * Deletes everything of the company, children first — the ledgers as the
 * owner, since `wms_api` may not delete from them, then the rest as
 * `wms_api` under the fence, in the order the keys demand: tickets and alerts
 * before the outbox and the pickups they name, pickups before routes, routes
 * before the group, the scheme, the drivers and the Registry rows, the
 * project and the company last.
 */
export async function dropConsumerTenant(pool: Database, owner: Database, companyId: string): Promise<void> {
  await owner.db.delete(ticketEvent).where(eq(ticketEvent.companyId, companyId))
  await owner.db.delete(proofOfService).where(eq(proofOfService.companyId, companyId))
  await owner.db.delete(driverCommand).where(eq(driverCommand.companyId, companyId))
  await withCompany(pool.db, companyId, async (tx: Tx) => {
    await tx.delete(alert).where(eq(alert.companyId, companyId))
    await tx.delete(ticket).where(eq(ticket.companyId, companyId))
    await tx.delete(outboxEvent).where(eq(outboxEvent.companyId, companyId))
    await tx.delete(pickup).where(eq(pickup.companyId, companyId))
    await tx.delete(route).where(eq(route.companyId, companyId))
    await tx.delete(collectionGroup).where(eq(collectionGroup.companyId, companyId))
    await tx.delete(routeScheme).where(eq(routeScheme.companyId, companyId))
    await tx.delete(driver).where(eq(driver.companyId, companyId))
    await tx.delete(vehicle).where(eq(vehicle.companyId, companyId))
    await tx.delete(vehicleType).where(eq(vehicleType.companyId, companyId))
    await tx.delete(container).where(eq(container.companyId, companyId))
    await tx.delete(property).where(eq(property.companyId, companyId))
    await tx.delete(containerType).where(eq(containerType.companyId, companyId))
    await tx.delete(wasteFraction).where(eq(wasteFraction.companyId, companyId))
    await tx.delete(project).where(eq(project.companyId, companyId))
    await tx.delete(company).where(eq(company.companyId, companyId))
  })
}
