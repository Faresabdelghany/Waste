// A Service Provider's own doors (#291 slice 23b): Lars, NordRen's manager,
// keeps NordRen's fleet whole (`reachesFleet`), raises and comments on the
// tickets about the routes NordRen runs (`ticketReach`), staffs NordRen's
// team under `service-providers.service-provider-workspace` without ever
// making an account above himself, and crews the routes NordRen runs with
// NordRen's own vehicles and drivers through `assign` and `dispatch`. Each
// door refuses what is not NordRen's at its field, finds no row of anyone
// else's, and leaves the office's own doors as they were — their suites
// hold that, and this one checks the office still sees what NordRen wrote.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { Role, User } from "@waste/contracts/access"
import { Driver, Vehicle } from "@waste/contracts/fleet"
import { Page } from "@waste/contracts/pagination"
import { RouteDetail } from "@waste/contracts/routes"
import { Ticket, TicketDetail, TicketEvent } from "@waste/contracts/tickets"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { role, roleGrant, serviceProviderAccess, userAccount } from "@waste/db/schema/access"
import { serviceArea } from "@waste/db/schema/finance"
import { routeScheme } from "@waste/db/schema/route-schemes"
import { withCompany } from "@waste/db/tenant"
import { normaliseGrants, type Grant } from "@waste/domain/access/grants"
import { PROVIDER_ROLE_SCOPE, SYSTEM_ROLES } from "@waste/domain/access/system-roles"
import { and, eq } from "drizzle-orm"

import { createApp } from "../app"
import { notAHeldProject, notOwnFleet, ownFleetKind, ownFleetProvider } from "../auth/provider"
import { notAnAccountOf } from "../routes/references"
import { noPlannedVehicle, notYourCrew, officeSetsIt, plansForItself } from "../routes/routes"
import { fromItsWorkspace, namesARouteItRuns, notARouteItRuns, notTheRoutesProject, OFFICE_ASSIGNS, OFFICE_LINKS_ALERTS, OFFICE_SPEAKS_TO_CUSTOMERS } from "../routes/tickets"
import { notATeamRole, TEAM_SELF_DEACTIVATE, TEAM_SELF_ROLE, teamReachesItsProvider, widerThanYours } from "../routes/users"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, seedRoute, type ExecutionFixtures, type SeededRoute } from "./execution-fixtures"
import { seedFinance, type FinanceFixtures } from "./finance-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Account, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the fixtures' proofs and the tickets' history, which `wms_api` may not delete. */
const owner = ownerUnderTest()

const VehiclePage = Page(Vehicle)
const DriverPage = Page(Driver)
const TicketPage = Page(Ticket)
const EventPage = Page(TicketEvent)
const UserPage = Page(User)
const RolePage = Page(Role)

/** The fixtures' Monday, mid-morning in Copenhagen: NordRen's award over Centrum is in force. */
const MORNING = new Date("2026-10-05T08:00:00Z")
const NORDREN = "NordRen ApS"

const charterOf = (key: string): Grant[] => {
  const found = SYSTEM_ROLES.find((systemRole) => systemRole.key === key)
  if (found === undefined) throw new Error(`no system role ${key}`)
  return normaliseGrants(found.grants)
}

describe("a Service Provider's own doors", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let planning: PlanningFixtures
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let finance: FinanceFixtures
  let olivia: Call
  let lars: Call
  /** CityHaul's manager, on the manager's charter: CityHaul holds no award here. */
  let mikkel: Call
  /** A NordRen foreman, on the foreman's charter as a custom role of a provider's scope. */
  let frida: Call
  /** A NordRen account on a provider-scoped role granted `edit` on the tickets. */
  let tove: Call
  let otherLars: Call
  const accounts = {} as Record<"mikkel" | "frida" | "tove", Account>
  const roles = {} as Record<"foreman" | "wide" | "ticketEditor", string>
  /** NordRen's own truck and driver, registered by Lars through the API in `before`. */
  let truck: Vehicle
  let crew: Driver
  /** Routes by what they prove: one NordRen runs to crew; one crewed by the office; one with NordRen's driver and the office's truck; one at the office's depot with its truck; one with NordRen's driver and no truck; one in Harbor, nobody's. */
  let routes: Record<"toCrew" | "officeCrewed" | "mixed" | "atDepot" | "driverOnly" | "harbor", SeededRoute>

  const roleRow = async (tx: Tx, name: string, grants: Grant[]): Promise<string> => {
    const id = testId()
    await tx.insert(role).values({ id, companyId: a.companyId, key: null, name, scope: PROVIDER_ROLE_SCOPE, description: name, system: false })
    const rows = normaliseGrants(grants).flatMap((grant) => grant.actions.map((action) => ({ companyId: a.companyId, roleId: id, moduleKey: grant.moduleKey, action })))
    if (rows.length > 0) await tx.insert(roleGrant).values(rows)
    return id
  }
  const providerAccount = async (tx: Tx, roleId: string, serviceProviderId: string, localPart: string): Promise<Account> => {
    const account: Account = { id: testId(), authUserId: randomUUID(), email: `${localPart}@${a.users.olivia.email.split("@")[1]}`, fullName: localPart }
    await tx.insert(userAccount).values({ id: account.id, companyId: a.companyId, authUserId: account.authUserId, email: account.email, fullName: account.fullName, roleId, serviceProviderId })
    await tx.insert(serviceProviderAccess).values({ companyId: a.companyId, userAccountId: account.id, serviceProviderId })
    return account
  }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    planning = await seedPlanning(pool, a)
    fleet = await seedFleet(pool, a, planning)
    ex = await seedExecution(pool, a, fleet)
    // NordRen holds Centrum from 2026-03-01 to the year's end, in Copenhagen Central; CityHaul holds nothing.
    finance = await seedFinance(pool, a, planning)
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.update(routeScheme).set({ planningAreaId: planning.areas.centrum.id }).where(and(eq(routeScheme.companyId, a.companyId), eq(routeScheme.id, ex.schemes.copenhagen.id)))
      roles.foreman = await roleRow(tx, "Foreman", charterOf("service-provider-foreman"))
      roles.wide = await roleRow(tx, "Provider administrator", [...charterOf("service-provider-manager"), { moduleKey: "configure.access", actions: ["view", "edit"] }])
      roles.ticketEditor = await roleRow(tx, "Provider ticket editor", [{ moduleKey: "operate.tickets", actions: ["view", "create", "edit"] }])
      accounts.mikkel = await providerAccount(tx, a.roles.providerManager.id, a.serviceProviders.cityhaul.id, "mikkel.andersen")
      accounts.frida = await providerAccount(tx, roles.foreman, a.serviceProviders.nordren.id, "frida.foreman")
      accounts.tove = await providerAccount(tx, roles.ticketEditor, a.serviceProviders.nordren.id, "tove.tickets")
    })
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => MORNING })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    mikkel = callingAs(app, keys, accounts.mikkel, a.companyId)
    frida = callingAs(app, keys, accounts.frida, a.companyId)
    tove = callingAs(app, keys, accounts.tove, a.companyId)
    otherLars = callingAs(app, keys, b.users.lars, b.companyId)

    truck = Vehicle.parse(await createdBy(lars, "/vehicles", truckBody()))
    crew = Driver.parse(await createdBy(lars, "/drivers", driverBody()))
    const day = (operatingDate: string, seed: Parameters<typeof seedRoute>[4] = {}) => seedRoute(pool, a, fleet, ex, { operatingDate, ...seed })
    routes = {
      toCrew: await day("2026-10-12"),
      officeCrewed: await day("2026-10-13", { plannedDriverId: fleet.drivers.mads.id, plannedVehicleId: fleet.vehicles.wh24.id }),
      mixed: await day("2026-10-14", { plannedDriverId: crew.id, plannedVehicleId: fleet.vehicles.wh24.id }),
      atDepot: await day("2026-10-15", { depotId: fleet.depots.nordhavn.id, plannedVehicleId: fleet.vehicles.wh24.id }),
      driverOnly: await day("2026-10-16", { plannedDriverId: crew.id }),
      harbor: await day("2026-10-12", { project: "harbor" }),
    }
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const ok = async (response: Response, status = 200): Promise<unknown> => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await response.json()
  }
  async function createdBy(call: Call, path: string, body: unknown): Promise<unknown> {
    return await ok(await call(path, { method: "POST", body }), 201)
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  /** The field errors of a 400, as path and message. */
  const fieldErrors = async (response: Response) => (await refused(response, 400)).errors?.map((error) => [error.path, error.message])
  const post = (call: Call, path: string, body?: unknown) => call(path, { method: "POST", body })
  const patch = (call: Call, path: string, body: unknown) => call(path, { method: "PATCH", body })

  let plate = 0
  /** A NordRen truck in Copenhagen, as a provider's manager registers one. */
  function truckBody(overrides: Record<string, unknown> = {}) {
    plate += 1
    return {
      projectId: a.projects.copenhagen.id,
      registration: `NR ${plate} ${testId().slice(-5)}`,
      kind: "powered-vehicle",
      vehicleTypeId: planning.vehicleTypes.rearLoader.id,
      ownership: "service-provider",
      serviceProviderId: a.serviceProviders.nordren.id,
      requiredLicenceClass: "c",
      compartments: [{ wasteFractionIds: [ex.fractions.residual.id] }],
      ...overrides,
    }
  }
  /** A NordRen driver in Copenhagen holding C until 2030. */
  function driverBody(overrides: Record<string, unknown> = {}) {
    return { projectId: a.projects.copenhagen.id, name: `NordRen driver ${testId().slice(-4)}`, employment: "service-provider", serviceProviderId: a.serviceProviders.nordren.id, licenceClass: "c", licenceExpiry: "2030-12-31", ...overrides }
  }
  const ids = (page: { items: { id: string }[] }) => page.items.map((item) => item.id)

  describe("the fleet", () => {
    test("Lars lists NordRen's own vehicles and drivers and none of the office's, and the office sees NordRen's too", async () => {
      const vehicles = ids(VehiclePage.parse(await ok(await lars("/vehicles?limit=200"))))
      assert.ok(vehicles.includes(truck.id))
      assert.equal(vehicles.includes(fleet.vehicles.wh24.id), false)
      const drivers = ids(DriverPage.parse(await ok(await lars("/drivers?limit=200"))))
      assert.ok(drivers.includes(crew.id))
      assert.equal(drivers.includes(fleet.drivers.mads.id), false)
      assert.ok(ids(VehiclePage.parse(await ok(await olivia("/vehicles?limit=200")))).includes(truck.id), "the office reads every vehicle of its projects")
      assert.deepEqual({ ownership: truck.ownership, provider: truck.serviceProviderId }, { ownership: "service-provider", provider: a.serviceProviders.nordren.id })
      // Narrowed to a project NordRen holds an award in; another is refused.
      assert.ok(ids(VehiclePage.parse(await ok(await lars(`/vehicles?projectId=${a.projects.copenhagen.id}`)))).includes(truck.id))
      assert.deepEqual(await fieldErrors(await lars(`/vehicles?projectId=${a.projects.harbor.id}`)), [["projectId", notAHeldProject(NORDREN)]])
    })

    test("a create is in a project NordRen holds an award in, owned by NordRen alone: anything else is refused at its field", async () => {
      assert.deepEqual(await fieldErrors(await post(lars, "/vehicles", truckBody({ projectId: a.projects.harbor.id }))), [["projectId", notAHeldProject(NORDREN)]])
      assert.deepEqual(await fieldErrors(await post(lars, "/vehicles", truckBody({ ownership: "company", serviceProviderId: null }))), [
        ["ownership", ownFleetKind(NORDREN, "vehicle")],
        ["serviceProviderId", ownFleetProvider(NORDREN, "vehicle")],
      ])
      assert.deepEqual(await fieldErrors(await post(lars, "/vehicles", truckBody({ serviceProviderId: a.serviceProviders.cityhaul.id }))), [["serviceProviderId", ownFleetProvider(NORDREN, "vehicle")]])
      assert.deepEqual(await fieldErrors(await post(lars, "/drivers", driverBody({ employment: "employee", serviceProviderId: null }))), [
        ["employment", ownFleetKind(NORDREN, "driver")],
        ["serviceProviderId", ownFleetProvider(NORDREN, "driver")],
      ])
      // A login is an account of NordRen's own team, never the office's.
      assert.deepEqual(await fieldErrors(await post(lars, "/drivers", driverBody({ userAccountId: a.users.olivia.id }))), [["userAccountId", notAnAccountOf(NORDREN)]])
      const bound = Driver.parse(await createdBy(lars, "/drivers", driverBody({ userAccountId: accounts.frida.id })))
      assert.equal(bound.userAccountId, accounts.frida.id)
      // CityHaul holds no award at all.
      assert.deepEqual(await fieldErrors(await post(mikkel, "/vehicles", truckBody({ serviceProviderId: a.serviceProviders.cityhaul.id }))), [["projectId", notAHeldProject("CityHaul A/S")]])
    })

    test("an award is in force when its area is too, as servesRoute judges it: an area ended before today holds no project, whatever its assignment says", async () => {
      const setAreaEnd = (validTo: string) =>
        withCompany(pool.db, a.companyId, async (tx: Tx) => {
          await tx.update(serviceArea).set({ validTo }).where(and(eq(serviceArea.companyId, a.companyId), eq(serviceArea.id, finance.nordren.id)))
        })
      await setAreaEnd("2026-10-01")
      try {
        assert.deepEqual(await fieldErrors(await post(lars, "/vehicles", truckBody())), [["projectId", notAHeldProject(NORDREN)]])
      } finally {
        await setAreaEnd("2027-01-01")
      }
      Vehicle.parse(await createdBy(lars, "/vehicles", truckBody()))
    })

    test("a patch is of NordRen's own rows and keeps them NordRen's; the office's are the family's 404", async () => {
      const noted = Vehicle.parse(await ok(await patch(lars, `/vehicles/${truck.id}`, { notes: "Serviced Friday" })))
      assert.equal(noted.notes, "Serviced Friday")
      assert.deepEqual(await fieldErrors(await patch(lars, `/vehicles/${truck.id}`, { ownership: "company", serviceProviderId: null })), [
        ["ownership", ownFleetKind(NORDREN, "vehicle")],
        ["serviceProviderId", ownFleetProvider(NORDREN, "vehicle")],
      ])
      assert.ok(Array.isArray(Vehicle.parse(await ok(await lars(`/vehicles/${truck.id}/compartments`, { method: "PUT", body: { compartments: [{ wasteFractionIds: [ex.fractions.residual.id] }] } }))).compartments))
      await refused(await lars(`/vehicles/${fleet.vehicles.wh24.id}`), 404)
      await refused(await patch(lars, `/vehicles/${fleet.vehicles.wh24.id}`, { notes: "Ours now" }), 404)
      await refused(await lars(`/vehicles/${fleet.vehicles.wh24.id}/compartments`, { method: "PUT", body: { compartments: [{ wasteFractionIds: [ex.fractions.residual.id] }] } }), 404)
      await refused(await patch(lars, `/drivers/${fleet.drivers.mads.id}`, { notes: "Ours now" }), 404)
      assert.equal(Driver.parse(await ok(await patch(lars, `/drivers/${crew.id}`, { licenceNumber: "DK-NR-1" }))).licenceNumber, "DK-NR-1")
      assert.deepEqual(await fieldErrors(await patch(lars, `/drivers/${crew.id}`, { userAccountId: a.users.olivia.id })), [["userAccountId", notAnAccountOf(NORDREN)]])
    })

    test("CityHaul's manager and another company's Lars reach none of NordRen's fleet", async () => {
      for (const call of [mikkel, otherLars]) {
        assert.equal(ids(VehiclePage.parse(await ok(await call("/vehicles?limit=200")))).includes(truck.id), false)
        await refused(await call(`/vehicles/${truck.id}`), 404)
        await refused(await call(`/drivers/${crew.id}`), 404)
      }
    })
  })

  describe("crewing the routes NordRen runs", () => {
    test("Lars assigns NordRen's own truck and driver to a planned route NordRen runs, which holds it, and dispatches it to them", async () => {
      const assigned = RouteDetail.parse(await ok(await post(lars, `/routes/${routes.toCrew.id}/assign`, { vehicleId: truck.id, driverId: crew.id })))
      assert.deepEqual({ vehicle: assigned.planned.vehicleId, driver: assigned.planned.driverId }, { vehicle: truck.id, driver: crew.id })
      assert.notEqual(assigned.heldAt, null, "the office's hold, from the provider's hand")
      const dispatched = RouteDetail.parse(await ok(await post(lars, `/routes/${routes.toCrew.id}/dispatch`)))
      assert.equal(dispatched.status, "ready")
      assert.equal(RouteDetail.parse(await ok(await olivia(`/routes/${routes.toCrew.id}`))).status, "ready", "and the office reads it dispatched")
    })

    test("the office's fleet, the depot and the station are refused at their fields when the body would change the route to them; a route NordRen does not run is not there", async () => {
      // NordRen's driver and no truck, depot or station: every one of these would change the route.
      const route = routes.driverOnly.id
      assert.deepEqual(await fieldErrors(await post(lars, `/routes/${route}/assign`, { vehicleId: fleet.vehicles.wh24.id })), [["vehicleId", notOwnFleet("vehicle", NORDREN)]])
      assert.deepEqual(await fieldErrors(await post(lars, `/routes/${route}/assign`, { driverId: fleet.drivers.mads.id })), [["driverId", notOwnFleet("driver", NORDREN)]])
      assert.deepEqual(await fieldErrors(await post(lars, `/routes/${route}/assign`, { trailerId: fleet.vehicles.trailer.id })), [["trailerId", notOwnFleet("trailer", NORDREN)]])
      assert.deepEqual(await fieldErrors(await post(lars, `/routes/${route}/assign`, { depotId: fleet.depots.nordhavn.id, unloadingStationId: fleet.stations.amager.id })), [
        ["depotId", officeSetsIt("depot", NORDREN)],
        ["unloadingStationId", officeSetsIt("unloading station", NORDREN)],
      ])
      // The route's planned provider it names as itself, and no other.
      assert.deepEqual(await fieldErrors(await post(lars, `/routes/${route}/assign`, { serviceProviderId: a.serviceProviders.cityhaul.id })), [["serviceProviderId", plansForItself(NORDREN)]])
      assert.equal(RouteDetail.parse(await ok(await post(lars, `/routes/${route}/assign`, { serviceProviderId: a.serviceProviders.nordren.id }))).planned.serviceProviderId, a.serviceProviders.nordren.id)
      assert.deepEqual(await fieldErrors(await post(lars, `/routes/${route}/assign`, { serviceProviderId: null })), [["serviceProviderId", plansForItself(NORDREN)]])
      await refused(await post(lars, `/routes/${routes.harbor.id}/assign`, { vehicleId: truck.id }), 404)
      await refused(await post(lars, `/routes/${routes.harbor.id}/dispatch`), 404)
      // Under the foreman's charter, which has the routes' `view` alone, the grant refuses first.
      assert.match((await refused(await post(frida, `/routes/${route}/assign`, { vehicleId: truck.id }), 403)).detail ?? "", /edit on route-studio\.routes/)
    })

    test("a field restated as the route stands changes nothing and is not refused: the office's depot and truck may ride along while NordRen's driver comes on", async () => {
      const route = routes.atDepot.id
      const assigned = RouteDetail.parse(await ok(await post(lars, `/routes/${route}/assign`, { depotId: fleet.depots.nordhavn.id, vehicleId: fleet.vehicles.wh24.id, driverId: crew.id })))
      assert.deepEqual({ depot: assigned.planned.depotId, vehicle: assigned.planned.vehicleId, driver: assigned.planned.driverId }, { depot: fleet.depots.nordhavn.id, vehicle: fleet.vehicles.wh24.id, driver: crew.id })
      // NordRen's own truck replaces the office's, the depot restated still.
      assert.equal(RouteDetail.parse(await ok(await post(lars, `/routes/${route}/assign`, { depotId: fleet.depots.nordhavn.id, vehicleId: truck.id }))).planned.vehicleId, truck.id)
    })

    test("a dispatch goes to NordRen's own crew alone: a route crewed by the office's driver, by NordRen's driver on the office's truck, or with no truck, is refused", async () => {
      const officeCrewed = routes.officeCrewed
      assert.equal((await refused(await post(lars, `/routes/${officeCrewed.id}/dispatch`), 409)).detail, notYourCrew(officeCrewed.label, "driver", NORDREN))
      assert.equal((await refused(await post(lars, `/routes/${routes.mixed.id}/dispatch`), 409)).detail, notYourCrew(routes.mixed.label, "vehicle", NORDREN))
      assert.equal((await refused(await post(lars, `/routes/${routes.driverOnly.id}/dispatch`), 409)).detail, noPlannedVehicle(routes.driverOnly.label, NORDREN))
      assert.equal(RouteDetail.parse(await ok(await olivia(`/routes/${officeCrewed.id}`))).status, "planned", "nothing moved")
      // The office dispatches it as it always did.
      assert.equal(RouteDetail.parse(await ok(await post(olivia, `/routes/${officeCrewed.id}/dispatch`))).status, "ready")
    })
  })

  describe("the tickets", () => {
    let aboutReady: Ticket
    let aboutHarbor: Ticket
    let aboutNothing: Ticket
    const ticketBody = (overrides: Record<string, unknown> = {}) => ({ projectId: a.projects.copenhagen.id, subject: "Bin blocked by a van", description: "The driver could not reach the bin at Parkvej", kind: "complaint", links: { routeId: ex.routes.ready.id }, ...overrides })

    before(async () => {
      aboutReady = Ticket.parse(await createdBy(olivia, "/tickets", ticketBody()))
      aboutHarbor = Ticket.parse(await createdBy(olivia, "/tickets", ticketBody({ projectId: a.projects.harbor.id, links: { routeId: routes.harbor.id } })))
      aboutNothing = Ticket.parse(await createdBy(olivia, "/tickets", ticketBody({ links: undefined })))
    })

    test("Lars raises a ticket about a route NordRen runs: its source is the provider's, and the office reads it", async () => {
      const raised = Ticket.parse(await createdBy(lars, "/tickets", ticketBody()))
      assert.deepEqual({ source: raised.source, route: raised.links.routeId, project: raised.projectId }, { source: "service-provider", route: ex.routes.ready.id, project: a.projects.copenhagen.id })
      assert.equal(TicketDetail.parse(await ok(await olivia(`/tickets/${raised.id}`))).source, "service-provider")
      // The office cannot claim the provider's source.
      assert.deepEqual((await refused(await post(olivia, "/tickets", ticketBody({ source: "service-provider" })), 400)).errors?.map((error) => error.path), ["source"])
    })

    test("a ticket names a route NordRen runs, in its project, from the workspace, with no assignee and no alert: each else refused at its field", async () => {
      assert.deepEqual(await fieldErrors(await post(lars, "/tickets", ticketBody({ links: undefined }))), [["links.routeId", namesARouteItRuns(NORDREN)]])
      assert.deepEqual(await fieldErrors(await post(lars, "/tickets", ticketBody({ projectId: a.projects.harbor.id, links: { routeId: routes.harbor.id } }))), [["links.routeId", notARouteItRuns(NORDREN)]])
      assert.deepEqual(
        await fieldErrors(await post(lars, "/tickets", ticketBody({ projectId: a.projects.harbor.id, source: "phone", assigneeUserAccountId: a.users.olivia.id, alertId: testId() }))),
        [
          ["projectId", notTheRoutesProject(ex.routes.ready.label)],
          ["source", fromItsWorkspace(NORDREN)],
          ["assigneeUserAccountId", OFFICE_ASSIGNS],
          ["alertId", OFFICE_LINKS_ALERTS],
        ],
      )
    })

    test("Lars reads the tickets about the routes NordRen runs, theirs or the office's, and no other", async () => {
      const listed = ids(TicketPage.parse(await ok(await lars("/tickets?limit=200"))))
      assert.ok(listed.includes(aboutReady.id))
      assert.equal(listed.includes(aboutHarbor.id), false)
      assert.equal(listed.includes(aboutNothing.id), false)
      assert.equal(TicketDetail.parse(await ok(await lars(`/tickets/${aboutReady.id}`))).id, aboutReady.id)
      assert.equal(EventPage.parse(await ok(await lars(`/tickets/${aboutReady.id}/events`))).items.length, 0, "the office's own rows are not his to read")
      for (const theirs of [aboutHarbor, aboutNothing]) {
        await refused(await lars(`/tickets/${theirs.id}`), 404)
        await refused(await lars(`/tickets/${theirs.id}/events`), 404)
      }
      assert.deepEqual((await refused(await lars(`/tickets?projectId=${a.projects.copenhagen.id}`), 400)).errors?.map((error) => error.path), ["projectId"])
      for (const call of [mikkel, otherLars]) assert.equal(ids(TicketPage.parse(await ok(await call("/tickets?limit=200")))).includes(aboutReady.id), false)
    })

    test("Lars reads and writes the ticket's provider thread alone: never the office's internal notes, the customer's thread or the alerts", async () => {
      TicketEvent.parse(await createdBy(olivia, `/tickets/${aboutReady.id}/comments`, { body: "NordRen keeps missing this street", visibility: "internal" }))
      TicketEvent.parse(await createdBy(olivia, `/tickets/${aboutReady.id}/comments`, { body: "We will send someone", visibility: "customer" }))
      const toNordRen = TicketEvent.parse(await createdBy(olivia, `/tickets/${aboutReady.id}/comments`, { body: "Can you go back Thursday?", visibility: "service-provider" }))
      const reply = TicketEvent.parse(await createdBy(lars, `/tickets/${aboutReady.id}/comments`, { body: "Van gone, we can go back Thursday" }))
      assert.deepEqual({ kind: reply.kind, visibility: reply.visibility }, { kind: "comment", visibility: "service-provider" }, "the default is the provider's thread")
      assert.equal(TicketEvent.parse(await createdBy(lars, `/tickets/${aboutReady.id}/comments`, { body: "And Friday", visibility: "internal" })).visibility, "service-provider")
      assert.deepEqual(await fieldErrors(await post(lars, `/tickets/${aboutReady.id}/comments`, { body: "Sorry about that", visibility: "customer" })), [["visibility", OFFICE_SPEAKS_TO_CUSTOMERS]])
      const his = TicketDetail.parse(await ok(await lars(`/tickets/${aboutReady.id}`)))
      assert.ok(his.events.length >= 3 && his.events.every((event) => event.kind === "comment" && event.visibility === "service-provider"), JSON.stringify(his.events.map((event) => [event.kind, event.visibility])))
      assert.ok(his.events.some((event) => event.id === toNordRen.id) && his.events.some((event) => event.id === reply.id))
      assert.deepEqual(his.alerts, [])
      assert.deepEqual(EventPage.parse(await ok(await lars(`/tickets/${aboutReady.id}/events?visibility=internal`))).items, [])
      assert.ok(EventPage.parse(await ok(await lars(`/tickets/${aboutReady.id}/events`))).items.every((event) => event.visibility === "service-provider"))
      // The office reads every row, the provider's thread among them.
      const office = TicketDetail.parse(await ok(await olivia(`/tickets/${aboutReady.id}`)))
      assert.ok(office.events.some((event) => event.visibility === "internal") && office.events.some((event) => event.id === reply.id))
    })

    test("Lars moves no ticket, on a role granted `edit` neither", async () => {
      await refused(await post(lars, `/tickets/${aboutHarbor.id}/comments`, { body: "Not ours" }), 404)
      assert.match((await refused(await post(lars, `/tickets/${aboutReady.id}/start`, {}), 403)).detail ?? "", /edit on operate\.tickets/)
      await refused(await post(tove, `/tickets/${aboutReady.id}/start`, {}), 404)
      await refused(await patch(tove, `/tickets/${aboutReady.id}`, { subject: "Ours now" }), 404)
      assert.equal(TicketDetail.parse(await ok(await olivia(`/tickets/${aboutReady.id}`))).status, "open", "nothing moved")
    })
  })

  describe("the team", () => {
    const team = async (call: Call) => UserPage.parse(await ok(await call("/users?limit=200"))).items
    const inviteBody = (overrides: Record<string, unknown> = {}) => ({ email: `crew.${testId().slice(-6)}@nordren.example`, fullName: "New Crew", roleId: roles.foreman, serviceProviderId: a.serviceProviders.nordren.id, ...overrides })

    test("Lars lists and reads NordRen's own accounts and no one else's", async () => {
      const listed = await team(lars)
      assert.ok(listed.every((user) => user.serviceProviderId === a.serviceProviders.nordren.id), "NordRen's alone")
      assert.ok([a.users.lars.id, accounts.frida.id, accounts.tove.id].every((id) => listed.some((user) => user.id === id)))
      await refused(await lars(`/users/${a.users.olivia.id}`), 404)
      await refused(await lars(`/users/${accounts.mikkel.id}`), 404)
      assert.equal(User.parse(await ok(await lars(`/users/${accounts.frida.id}`))).id, accounts.frida.id)
      // The foreman reads the team under the same module's `view`, and invites no one.
      assert.ok((await team(frida)).some((user) => user.id === a.users.lars.id))
      assert.match((await refused(await post(frida, "/users", inviteBody()), 403)).detail ?? "", /create on service-providers\.service-provider-workspace/)
      assert.equal((await team(mikkel)).some((user) => user.serviceProviderId === a.serviceProviders.nordren.id), false)
    })

    test("Lars invites into NordRen's team on a provider's role no wider than his own; the office sees the account", async () => {
      const invited = User.parse(await createdBy(lars, "/users", inviteBody()))
      assert.deepEqual({ status: invited.status, provider: invited.serviceProviderId, role: invited.roleId }, { status: "invited", provider: a.serviceProviders.nordren.id, role: roles.foreman })
      assert.equal(User.parse(await ok(await olivia(`/users/${invited.id}`))).serviceProviderId, a.serviceProviders.nordren.id)
    })

    test("an office role, a role wider than his own, or any access but NordRen's is refused at its field", async () => {
      assert.deepEqual(await fieldErrors(await post(lars, "/users", inviteBody({ roleId: a.roles.administrator.id }))), [["roleId", notATeamRole("Company Administrator")]])
      assert.deepEqual(await fieldErrors(await post(lars, "/users", inviteBody({ roleId: roles.wide }))), [["roleId", widerThanYours("Provider administrator", "view", "configure.access")]])
      assert.deepEqual(await fieldErrors(await post(lars, "/users", inviteBody({ serviceProviderId: a.serviceProviders.cityhaul.id }))), [["serviceProviderId", teamReachesItsProvider(NORDREN)]])
      assert.deepEqual(await fieldErrors(await post(lars, "/users", inviteBody({ serviceProviderId: undefined, allProjects: true }))), [["allProjects", teamReachesItsProvider(NORDREN)]])
      assert.deepEqual(await fieldErrors(await post(lars, "/users", inviteBody({ serviceProviderId: undefined, projectIds: [a.projects.copenhagen.id] }))), [["projectIds", teamReachesItsProvider(NORDREN)]])
    })

    test("Lars changes, switches off and on again NordRen's accounts, never his own role or his own account, and none of the office's", async () => {
      const invited = User.parse(await createdBy(lars, "/users", inviteBody()))
      assert.equal(User.parse(await ok(await patch(lars, `/users/${invited.id}`, { fullName: "Crew Lead" }))).fullName, "Crew Lead")
      assert.deepEqual(await fieldErrors(await patch(lars, `/users/${invited.id}`, { roleId: roles.wide })), [["roleId", widerThanYours("Provider administrator", "view", "configure.access")]])
      assert.equal(User.parse(await ok(await post(lars, `/users/${invited.id}/deactivate`))).status, "deactivated")
      assert.equal(User.parse(await ok(await post(lars, `/users/${invited.id}/reactivate`))).status, "invited")
      assert.equal((await refused(await patch(lars, `/users/${a.users.lars.id}`, { roleId: roles.foreman }), 409)).detail, TEAM_SELF_ROLE)
      assert.equal((await refused(await post(lars, `/users/${a.users.lars.id}/deactivate`), 409)).detail, TEAM_SELF_DEACTIVATE)
      assert.equal(User.parse(await ok(await patch(lars, `/users/${a.users.lars.id}`, { fullName: "Lars M." }))).fullName, "Lars M.", "his own name is his")
      await refused(await patch(lars, `/users/${a.users.olivia.id}`, { fullName: "Olivia" }), 404)
      await refused(await post(lars, `/users/${a.users.olivia.id}/deactivate`), 404)
      assert.match((await refused(await post(lars, `/users/${invited.id}/make-primary-administrator`), 403)).detail ?? "", /edit on configure\.access/)
    })

    test("Lars reads the roles of a provider's team alone, the ones his team door may give", async () => {
      const listed = RolePage.parse(await ok(await lars("/roles?limit=200"))).items
      assert.ok(listed.length > 0)
      assert.ok(listed.every((given) => given.scope === PROVIDER_ROLE_SCOPE))
      assert.ok(listed.some((given) => given.id === roles.foreman))
      await refused(await lars(`/roles/${a.roles.administrator.id}`), 404)
      assert.equal(Role.parse(await ok(await lars(`/roles/${roles.foreman}`))).id, roles.foreman)
      // The office reads them all, as before.
      assert.ok(RolePage.parse(await ok(await olivia("/roles?limit=200"))).items.some((given) => given.id === a.roles.administrator.id))
    })
  })
})
