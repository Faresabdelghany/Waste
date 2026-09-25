// What the Execution suites need of routes, pickups, sessions and proofs
// beyond their own routes (Issue #104, slice 3): the rows generation (#97 B)
// would have written, written directly through `tx` as `wms_api` inside
// `withCompany`, the way tenant.ts seeds its company and scheme-fixtures.ts
// seeds Planning and the fleet — the suites prove the office's commands and
// the driver door, not generation — and dropped with the rest of the company
// by `dropTenant`, the three ledgers as the owner.
//
// `seedExecution` lays the ground once: a route scheme per project (a route
// names its scheme and a collection group of it, and `route_generation_key`
// holds one route per scheme, group and service date — ADR-0002's identity —
// so `seedRoute` gives every route a group of its own on the project's
// scheme, the way a scheme of several groups generates several routes a
// day), two waste fractions, a container type, three Copenhagen properties
// with a bin each
// and one of Harbor's, the company's station accepting residual waste (the
// happy path of `assign`), and a login for Mads Jensen bound to his driver
// profile — the account every driver-recorded proof names as its recorder,
// and the token the driver door's suite calls with. Then the three routes §8
// names, all on one Monday, 2026-10-05, in Copenhagen Central: `ready` for
// Mads on WH-24 with three planned pickups (the route a driver starts and the
// dispatcher cancels), `planned` and unassigned with three (the route the
// dispatcher assigns, dispatches, reorders and removes stops from), and
// `completed` — Mads went out on WH-24, his session ended, one pickup
// completed, one failed for want of a bin, one closed as `skipped ·
// route-ended` when he ended the day — with the proofs that say so (the route
// a correction and an office unload are made on).
//
// `seedRoute` is the same writer for a suite that needs a route in a state
// of its own — active with an open session, cancelled, due on another day, in
// another project, with pickups already decided — since the stamps and the
// actual assignment follow the status (`route_stamps_shape`,
// `route_actual_shape`) and are tedious to spell by hand: a `ready` route is
// dispatched, an `active` one is dispatched and started with an open session
// and the actual assignment copied from the planned one, a `completed` one
// has ended its session, a `cancelled` one is cancelled. A route that went
// out without a planned driver goes out with a driver minted for it alone
// (`Driver <number>`, CE, active), since the database holds one open session
// per driver and a suite seeds several running routes; without a planned
// vehicle it goes out on WH-24, which nothing holds to one session. The
// route's number comes from the company's counter the way generation takes
// it, one `update … returning`, so numbers never collide across a suite's
// routes; and every id of one route is minted on a clock of its own, a
// millisecond apart, so a list ordered by id reads the pickups in position
// order and a suite can assert what a page says.
import { randomUUID } from "node:crypto"

import { routeLabel } from "@waste/contracts/execution"
import type { FlatPoint } from "@waste/contracts/geojson"
import type { Database, Tx } from "@waste/db/client"
import { userAccount } from "@waste/db/schema/access"
import { containerType, wasteFraction } from "@waste/db/schema/catalogue"
import { container } from "@waste/db/schema/containers"
import { property } from "@waste/db/schema/customers"
import { pickup, proofOfService, route, session } from "@waste/db/schema/execution"
import { driver } from "@waste/db/schema/fleet"
import { company } from "@waste/db/schema/organisation"
import { unloadingStationFraction } from "@waste/db/schema/places"
import { collectionGroup, routeScheme } from "@waste/db/schema/route-schemes"
import { withCompany } from "@waste/db/tenant"
import type { ExecutionSource, PickupReason, PickupStatus, ProofKind, RouteStatus } from "@waste/domain/execution/vocabulary"
import { and, eq, sql } from "drizzle-orm"

import type { FleetFixtures } from "./scheme-fixtures"
import { testId, type Account, type Tenant } from "./tenant"

/** The scheme every route of the project names; each route's group is its own, minted with the route. */
export type SchemeFixture = { id: string }

/** A route as a suite names it: its ids, its label, the day it runs, its pickups in position order, and the session it went out on where it did. */
export type SeededRoute = {
  id: string
  number: number
  label: string
  projectId: string
  routeSchemeId: string
  /** The group minted for this route alone, so two routes of one scheme on one day do not meet the generation key. */
  collectionGroupId: string
  operatingDate: string
  /** In position order, 1..n. */
  pickupIds: string[]
  /** The session an active or completed route went out on; null otherwise. */
  sessionId: string | null
}

export type ExecutionFixtures = {
  /** The Monday the three routes run on, operating and service date alike. */
  day: string
  schemes: { copenhagen: SchemeFixture; harbor: SchemeFixture; cairo: SchemeFixture }
  fractions: { residual: { id: string }; glass: { id: string } }
  containerTypes: { bin: { id: string } }
  /** Three Copenhagen Central service addresses and one of Harbor Commercial's. */
  properties: { parkvej: { id: string }; havnegade: { id: string }; norrebrogade: { id: string }; harbor: { id: string } }
  /** A bin at each: `BIN-1` at Parkvej, `BIN-2` at Havnegade, `BIN-3` at Nørrebrogade, `HBIN-1` in Harbor. */
  containers: { bin1: { id: string; label: string }; bin2: { id: string; label: string }; bin3: { id: string; label: string }; harborBin: { id: string; label: string } }
  /** Mads Jensen's driver-app login, bound to his driver profile: what every driver-recorded proof names, and what the driver door calls with. */
  logins: { mads: Account }
  routes: {
    /** Ready for Mads on WH-24, three planned pickups. */
    ready: SeededRoute
    /** Planned and unassigned, three planned pickups. */
    planned: SeededRoute
    /** Mads went out on WH-24 and ended the day: one completed, one failed, one skipped as route-ended, with proofs. */
    completed: SeededRoute
  }
}

/** Where every located proof here stands: Copenhagen town hall. */
export const TOWN_HALL: FlatPoint = { type: "Point", coordinates: [12.5683, 55.6761] }

/** An instant on Copenhagen's clock (CEST, +02:00) on a day. */
export const at = (day: string, time: string): Date => new Date(`${day}T${time}:00+02:00`)

/** The Monday the fixtures' routes run on. */
export const FIXTURE_DAY = "2026-10-05"

/** One stop of a route to seed: where, what, and where it stands. */
export type PickupSeed = {
  containerId: string
  propertyId: string
  /** The residual fraction unless said otherwise. */
  wasteFractionId?: string
  status?: PickupStatus
  /** Required by the table for a skipped or failed pickup, and refused otherwise. */
  reason?: PickupReason | null
  note?: string | null
  arrivedAt?: Date | null
  /** Required by the table for any status but planned. */
  outcomeAt?: Date | null
}

/** One proof to seed on a route: on its pickup by index (0-based, in seed order), or on the route alone. */
export type ProofSeed = {
  kind: ProofKind
  pickupIndex?: number | null
  occurredAt: Date
  /** `driver-app` unless said otherwise; a driver's proof names the session, an office proof none. */
  source?: ExecutionSource
  reason?: PickupReason | null
  note?: string | null
  location?: FlatPoint | null
  weightKg?: number | null
  objectKey?: string | null
  outcome?: PickupStatus | null
}

export type RouteSeed = {
  /** Copenhagen Central unless said otherwise. */
  project?: keyof ExecutionFixtures["schemes"]
  /** `planned` unless said otherwise; the stamps, the actual assignment and the session follow it. */
  status?: RouteStatus
  operatingDate?: string
  /** The identity's day; the operating date unless said otherwise. */
  serviceDate?: string
  plannedVehicleId?: string | null
  plannedDriverId?: string | null
  plannedTrailerId?: string | null
  depotId?: string | null
  unloadingStationId?: string | null
  plannedServiceProviderId?: string | null
  plannedStartTime?: string | null
  note?: string | null
  /** The stops in position order; the three Copenhagen bins, planned, unless said otherwise (none for another project). */
  pickups?: PickupSeed[]
  /** Proofs on the route or its pickups; a driver's proof needs the session an active or completed route has. */
  proofs?: ProofSeed[]
  /** The device an active or completed route's session runs on. */
  deviceId?: string
  /** Whether the open session of an active route is paused. */
  paused?: boolean
}

/** The stamps a status carries (`route_stamps_shape`), and whether a session went out (`route_actual_shape`). */
function stampsFor(status: RouteStatus, day: string): { dispatchedAt: Date | null; startedAt: Date | null; completedAt: Date | null; cancelledAt: Date | null } {
  const none = { dispatchedAt: null, startedAt: null, completedAt: null, cancelledAt: null }
  switch (status) {
    case "planned":
      return none
    case "ready":
      return { ...none, dispatchedAt: at(day, "05:30") }
    case "active":
      return { ...none, dispatchedAt: at(day, "05:30"), startedAt: at(day, "06:00") }
    case "completed":
      return { ...none, dispatchedAt: at(day, "05:30"), startedAt: at(day, "06:00"), completedAt: at(day, "13:00") }
    case "cancelled":
      return { ...none, cancelledAt: at(day, "05:00") }
  }
}

/** The next route number of the company, the way generation takes it: one `update … returning` under the company's row lock. */
async function nextRouteNumber(tx: Tx, companyId: string): Promise<number> {
  const [row] = await tx
    .update(company)
    .set({ nextRouteNumber: sql`${company.nextRouteNumber} + 1` })
    .where(eq(company.id, companyId))
    .returning({ next: company.nextRouteNumber })
  if (row === undefined) throw new Error(`no company ${companyId} to number a route in`)
  return row.next - 1
}

/** The default stops of a Copenhagen route: the three bins at their addresses, planned. */
const defaultPickups = (fixtures: Pick<ExecutionFixtures, "containers" | "properties">): PickupSeed[] => [
  { containerId: fixtures.containers.bin1.id, propertyId: fixtures.properties.parkvej.id },
  { containerId: fixtures.containers.bin2.id, propertyId: fixtures.properties.havnegade.id },
  { containerId: fixtures.containers.bin3.id, propertyId: fixtures.properties.norrebrogade.id },
]

/**
 * One route in the state asked for, with its pickups, its session where the
 * status says one went out, and its proofs, written through `tx` as
 * `wms_api`. The actual assignment of an active or completed route is the
 * planned one where given, else a driver minted for the route on WH-24, and
 * its session is theirs.
 */
export async function seedRoute(pool: Database, tenant: Tenant, fleet: FleetFixtures, fixtures: Pick<ExecutionFixtures, "schemes" | "fractions" | "containers" | "properties" | "logins">, seed: RouteSeed = {}): Promise<SeededRoute> {
  const { companyId } = tenant
  const projectKey = seed.project ?? "copenhagen"
  const projectId = tenant.projects[projectKey].id
  const scheme = fixtures.schemes[projectKey]
  const status = seed.status ?? "planned"
  const operatingDate = seed.operatingDate ?? FIXTURE_DAY
  const serviceDate = seed.serviceDate ?? operatingDate
  const stamps = stampsFor(status, operatingDate)
  const wentOut = stamps.startedAt !== null
  // One clock for the route's ids, a millisecond apart, so their order is the order given.
  const minted = Date.now()
  const routeId = testId(minted)
  const collectionGroupId = testId(minted)
  /** A driver of the route's own, minted below, where a route went out without a planned one. */
  const mintedDriverId = wentOut && seed.plannedDriverId == null ? testId(minted + 1) : null
  const actualDriverId = wentOut ? (seed.plannedDriverId ?? mintedDriverId) : null
  const actualVehicleId = wentOut ? (seed.plannedVehicleId ?? fleet.vehicles.wh24.id) : null
  const actualTrailerId = wentOut ? (seed.plannedTrailerId ?? null) : null
  const pickups = seed.pickups ?? (projectKey === "copenhagen" ? defaultPickups(fixtures) : [])
  const pickupIds = pickups.map((_, index) => testId(minted + 2 + index))
  const sessionId = wentOut ? testId(minted + 2 + pickups.length) : null
  let number = 0

  await withCompany(pool.db, companyId, async (tx: Tx) => {
    number = await nextRouteNumber(tx, companyId)
    // The route's own group on the project's scheme, named and positioned by the route's number so two never collide inside the scheme.
    await tx.insert(collectionGroup).values({ id: collectionGroupId, companyId, projectId, routeSchemeId: scheme.id, name: `Group ${number}`, position: number, days: ["monday"], stopSource: "rule" })
    if (mintedDriverId !== null) {
      await tx.insert(driver).values({ id: mintedDriverId, companyId, projectId, name: `Driver ${number}`, employment: "employee", licenceClass: "ce", licenceExpiry: "2030-12-31", status: "active" })
    }
    await tx.insert(route).values({
      id: routeId,
      companyId,
      projectId,
      routeSchemeId: scheme.id,
      collectionGroupId,
      serviceDate,
      operatingDate,
      status,
      note: seed.note ?? null,
      number,
      plannedStartTime: seed.plannedStartTime ?? null,
      plannedVehicleId: seed.plannedVehicleId ?? null,
      plannedDriverId: seed.plannedDriverId ?? null,
      plannedTrailerId: seed.plannedTrailerId ?? null,
      depotId: seed.depotId ?? null,
      plannedServiceProviderId: seed.plannedServiceProviderId ?? null,
      unloadingStationId: seed.unloadingStationId ?? null,
      actualVehicleId,
      actualDriverId,
      actualTrailerId,
      ...stamps,
    })
    if (pickups.length > 0) {
      await tx.insert(pickup).values(
        pickups.map((stop, index) => ({
          id: pickupIds[index],
          companyId,
          projectId,
          routeId,
          containerId: stop.containerId,
          position: index + 1,
          status: stop.status ?? "planned",
          note: stop.note ?? null,
          propertyId: stop.propertyId,
          sharedCollectionPointId: null,
          wasteFractionId: stop.wasteFractionId ?? fixtures.fractions.residual.id,
          arrivedAt: stop.arrivedAt ?? null,
          outcomeAt: stop.outcomeAt ?? null,
          reason: stop.reason ?? null,
        })),
      )
    }
    if (sessionId !== null && actualDriverId !== null && actualVehicleId !== null && stamps.startedAt !== null) {
      await tx.insert(session).values({
        id: sessionId,
        companyId,
        projectId,
        routeId,
        driverId: actualDriverId,
        vehicleId: actualVehicleId,
        trailerId: actualTrailerId,
        deviceId: seed.deviceId ?? "device-mads-1",
        appVersion: "1.0.0",
        startedAt: stamps.startedAt,
        endedAt: stamps.completedAt,
        pausedAt: seed.paused === true && stamps.completedAt === null ? at(operatingDate, "09:00") : null,
        lastSeenAt: stamps.completedAt ?? at(operatingDate, "09:30"),
      })
    }
    if (seed.proofs !== undefined && seed.proofs.length > 0) {
      await tx.insert(proofOfService).values(
        seed.proofs.map((proof, index) => {
          const source = proof.source ?? "driver-app"
          return {
            id: testId(minted + 3 + pickups.length + index),
            companyId,
            projectId,
            routeId,
            pickupId: proof.pickupIndex == null ? null : pickupIds[proof.pickupIndex],
            sessionId: source === "driver-app" ? sessionId : null,
            kind: proof.kind,
            source,
            occurredAt: proof.occurredAt,
            recordedBy: source === "driver-app" ? fixtures.logins.mads.id : tenant.users.olivia.id,
            deviceId: source === "driver-app" ? (seed.deviceId ?? "device-mads-1") : null,
            location: proof.location ?? null,
            reason: proof.reason ?? null,
            note: proof.note ?? null,
            weightKg: proof.weightKg ?? null,
            objectKey: proof.objectKey ?? null,
            outcome: proof.outcome ?? null,
          }
        }),
      )
    }
  })

  return { id: routeId, number, label: routeLabel(number), projectId, routeSchemeId: scheme.id, collectionGroupId, operatingDate, pickupIds, sessionId }
}

/** The ground and the three routes; `seedFleet` must have run, since the routes name its vehicles, drivers, depot and station. */
export async function seedExecution(pool: Database, tenant: Tenant, fleet: FleetFixtures): Promise<ExecutionFixtures> {
  const { companyId } = tenant
  const domain = tenant.users.olivia.email.split("@")[1]
  const ground = {
    schemes: {
      copenhagen: { id: testId() },
      harbor: { id: testId() },
      cairo: { id: testId() },
    },
    fractions: { residual: { id: testId() }, glass: { id: testId() } },
    containerTypes: { bin: { id: testId() } },
    properties: { parkvej: { id: testId() }, havnegade: { id: testId() }, norrebrogade: { id: testId() }, harbor: { id: testId() } },
    containers: {
      bin1: { id: testId(), label: "BIN-1" },
      bin2: { id: testId(), label: "BIN-2" },
      bin3: { id: testId(), label: "BIN-3" },
      harborBin: { id: testId(), label: "HBIN-1" },
    },
    logins: { mads: { id: testId(), authUserId: randomUUID(), email: `mads.jensen@${domain}`, fullName: "Mads Jensen" } satisfies Account },
  }
  const copenhagen = tenant.projects.copenhagen.id
  const harbor = tenant.projects.harbor.id
  const cairo = tenant.projects.cairo.id

  await withCompany(pool.db, companyId, async (tx: Tx) => {
    const schemeRow = (projectId: string, fixture: SchemeFixture, name: string) => ({
      id: fixture.id,
      companyId,
      projectId,
      name,
      serviceType: "container-collection",
      frequency: "weekly",
      serviceDays: ["monday"],
      validFrom: "2026-01-01",
      status: "validated",
      depotId: projectId === copenhagen ? fleet.depots.nordhavn.id : projectId === harbor ? fleet.depots.harbor.id : null,
      unloadingStationId: fleet.stations.amager.id,
    })
    await tx.insert(routeScheme).values([
      schemeRow(copenhagen, ground.schemes.copenhagen, "Centrum Mondays"),
      schemeRow(harbor, ground.schemes.harbor, "Havnen Mondays"),
      schemeRow(cairo, ground.schemes.cairo, "Maadi Mondays"),
    ])
    await tx.insert(wasteFraction).values([
      { id: ground.fractions.residual.id, companyId, key: "residual", name: "Residual waste" },
      { id: ground.fractions.glass.id, companyId, key: "glass", name: "Glass" },
    ])
    // The company's station takes residual waste: what `assign`'s happy path names.
    await tx.insert(unloadingStationFraction).values({ id: testId(), companyId, unloadingStationId: fleet.stations.amager.id, wasteFractionId: ground.fractions.residual.id })
    await tx.insert(containerType).values({ id: ground.containerTypes.bin.id, companyId, name: "240 L bin", volumeLitres: 240 })
    const home = (id: string, projectId: string, name: string, address: string) => ({ id, companyId, projectId, name, address, kind: "residential", location: TOWN_HALL, status: "active" })
    await tx.insert(property).values([
      home(ground.properties.parkvej.id, copenhagen, "Parkvej 18", "Parkvej 18, 2100 København Ø"),
      home(ground.properties.havnegade.id, copenhagen, "Havnegade 3", "Havnegade 3, 1058 København K"),
      home(ground.properties.norrebrogade.id, copenhagen, "Nørrebrogade 40", "Nørrebrogade 40, 2200 København N"),
      home(ground.properties.harbor.id, harbor, "Amerika Plads 1", "Amerika Plads 1, 2100 København Ø"),
    ])
    const bin = (row: { id: string; label: string }, projectId: string) => ({ id: row.id, companyId, projectId, label: row.label, containerTypeId: ground.containerTypes.bin.id, ownership: "company" })
    await tx.insert(container).values([bin(ground.containers.bin1, copenhagen), bin(ground.containers.bin2, copenhagen), bin(ground.containers.bin3, copenhagen), bin(ground.containers.harborBin, harbor)])
    // Mads's login: an account on the custom role with no project of its own — the driver's scope is the assignment, not Project Access (#104 §3) — bound to his driver profile.
    const { mads } = ground.logins
    await tx.insert(userAccount).values({ id: mads.id, companyId, authUserId: mads.authUserId, email: mads.email, fullName: mads.fullName, roleId: tenant.roles.viewer.id })
    await tx
      .update(driver)
      .set({ userAccountId: mads.id })
      .where(and(eq(driver.companyId, companyId), eq(driver.id, fleet.drivers.mads.id)))
  })

  const day = FIXTURE_DAY
  const ready = await seedRoute(pool, tenant, fleet, ground, {
    status: "ready",
    plannedDriverId: fleet.drivers.mads.id,
    plannedVehicleId: fleet.vehicles.wh24.id,
    depotId: fleet.depots.nordhavn.id,
    unloadingStationId: fleet.stations.amager.id,
    plannedStartTime: "06:00",
  })
  const planned = await seedRoute(pool, tenant, fleet, ground, { depotId: fleet.depots.nordhavn.id, unloadingStationId: fleet.stations.amager.id })
  const completed = await seedRoute(pool, tenant, fleet, ground, {
    status: "completed",
    plannedDriverId: fleet.drivers.mads.id,
    plannedVehicleId: fleet.vehicles.wh24.id,
    depotId: fleet.depots.nordhavn.id,
    unloadingStationId: fleet.stations.amager.id,
    plannedStartTime: "06:00",
    pickups: [
      { containerId: ground.containers.bin1.id, propertyId: ground.properties.parkvej.id, status: "completed", arrivedAt: at(day, "06:40"), outcomeAt: at(day, "06:45") },
      { containerId: ground.containers.bin2.id, propertyId: ground.properties.havnegade.id, status: "failed", reason: "not-presented", arrivedAt: at(day, "07:10"), outcomeAt: at(day, "07:12") },
      { containerId: ground.containers.bin3.id, propertyId: ground.properties.norrebrogade.id, status: "skipped", reason: "route-ended", outcomeAt: at(day, "13:00") },
    ],
    proofs: [
      { kind: "arrival", pickupIndex: 0, occurredAt: at(day, "06:40"), location: TOWN_HALL },
      { kind: "completion", pickupIndex: 0, occurredAt: at(day, "06:45"), location: TOWN_HALL },
      { kind: "arrival", pickupIndex: 1, occurredAt: at(day, "07:10"), location: TOWN_HALL },
      { kind: "failure", pickupIndex: 1, occurredAt: at(day, "07:12"), reason: "not-presented", note: "No bin at the kerb", location: TOWN_HALL },
    ],
  })

  return { day, ...ground, routes: { ready, planned, completed } }
}
