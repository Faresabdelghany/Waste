// Absences and unavailability through the API (O6 of #290): a driver's
// absences and a vehicle's unavailability recorded, read, moved and removed
// under the fleet's grants, one period of each covering a day; and the
// commands that name a driver or a vehicle afresh refusing one who is away —
// an ad-hoc route, an assign and a reschedule on the operating date, a
// dispatch whose planned crew is away that day, an allocation over its
// window's days, and a collection group's crew on its first run day from the
// day it is judged — while recording a period over work already planned is
// never refused.
//
// The vehicles the refusals name are this file's own, so the sentences carry
// the seed's names: NR-12 (CK 74 305), a powered vehicle, and a trailer known
// by its registration alone, TR 12 012.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { AuditEvent } from "@waste/contracts/audit"
import { DriverAbsence, VehicleUnavailability } from "@waste/contracts/availability"
import { VehicleAllocation } from "@waste/contracts/allocations"
import { Page } from "@waste/contracts/pagination"
import { CollectionGroup, RouteScheme } from "@waste/contracts/route-schemes"
import { RouteDetail, RouteDispatchResults } from "@waste/contracts/routes"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { vehicle } from "@waste/db/schema/fleet"
import { withCompany } from "@waste/db/tenant"

import { createApp } from "../app"
import { NOT_A_DRIVER_HERE, NOT_A_VEHICLE_HERE } from "../routes/availability"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, seedRoute, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the allocation events and the proofs the fixtures append, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const AbsencePage = Page(DriverAbsence)
const UnavailabilityPage = Page(VehicleUnavailability)
const AuditPage = Page(AuditEvent)

/** The request's clock, pinned: noon on Monday 5 October 2026, so a group's crew is judged on that day on Copenhagen's clock. */
const NOW = new Date("2026-10-05T12:00:00Z")
/** An instant on Copenhagen's clock in October 2026 (CEST, +02:00). */
const at = (day: string, time: string) => `${day}T${time}:00+02:00`

describe("driver absences and vehicle unavailability", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let planning: PlanningFixtures
  let fleet: FleetFixtures
  let theirFleet: FleetFixtures
  let ex: ExecutionFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted the fleet's four actions on drivers and vehicles, with Project Access to Copenhagen Central only. */
  let viewer: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call
  /** NR-12, a powered vehicle of Copenhagen Central. */
  const nr12 = { id: testId(), label: "NR-12" }
  /** A trailer of Copenhagen Central with no callsign: its registration is its label. */
  const trailer = { id: testId(), label: "TR 12 012" }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    planning = await seedPlanning(pool, a)
    fleet = await seedFleet(pool, a, planning)
    ex = await seedExecution(pool, a, fleet)
    theirFleet = await seedFleet(pool, b, await seedPlanning(pool, b))
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      const scoped = { companyId: a.companyId, projectId: a.projects.copenhagen.id, vehicleTypeId: planning.vehicleTypes.rearLoader.id, ownership: "company", status: "active" }
      await tx.insert(vehicle).values([
        { id: nr12.id, ...scoped, registration: "CK 74 305", callsign: nr12.label, kind: "powered-vehicle", requiredLicenceClass: "c" },
        { id: trailer.id, ...scoped, registration: trailer.label, callsign: null, kind: "trailer", requiredLicenceClass: "b" },
      ])
    })
    await grantRole(pool, a.companyId, a.roles.viewer.id, [
      { moduleKey: "fleet.drivers", actions: ["view", "create", "edit", "delete"] },
      { moduleKey: "fleet.vehicles", actions: ["view", "create", "edit", "delete"] },
    ])
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }
  const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body: values }), schema)
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const absent = (values: Record<string, unknown>, call = olivia) => create(call, "/driver-absences", values, DriverAbsence)
  const unavailable = (values: Record<string, unknown>, call = olivia) => create(call, "/vehicle-unavailability", values, VehicleUnavailability)
  const absences = async (query: string, call = olivia) => {
    const response = await call(`/driver-absences${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return AbsencePage.parse(await response.json()).items
  }
  const periods = async (query: string, call = olivia) => {
    const response = await call(`/vehicle-unavailability${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return UnavailabilityPage.parse(await response.json()).items
  }
  const patched = async <T>(path: string, values: unknown, schema: Schema<T>, call = olivia): Promise<T> => {
    const response = await call(path, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const paths = (problem: { errors?: { path: string }[] }) => problem.errors?.map((error) => error.path)

  describe("a driver's absences", () => {
    test("records, reads, lists, moves and removes an absence; one absence covers a day, refused naming the one there; the history reads it under the driver's", async () => {
      const jonas = fleet.drivers.jonas
      const holiday = await absent({ driverId: jonas.id, validFrom: "2026-11-02", validTo: "2026-11-07", reason: "holiday", note: "Autumn break" })
      assert.deepEqual(
        [holiday.projectId, holiday.driverId, holiday.validFrom, holiday.validTo, holiday.reason, holiday.note],
        [a.projects.copenhagen.id, jonas.id, "2026-11-02", "2026-11-07", "holiday", "Autumn break"],
        "the absence lives in the driver's project",
      )
      const training = await absent({ driverId: jonas.id, validFrom: "2026-11-16", validTo: "2026-11-21", reason: "training" })
      assert.equal(training.note, null)

      // A third over a day of the first is refused, naming the first by its last day in.
      const overlap = await refused(await olivia("/driver-absences", { method: "POST", body: { driverId: jonas.id, validFrom: "2026-11-06", reason: "sick" } }), 409)
      assert.equal(overlap.detail, "Jonas Lind is already absent Mon 2 Nov – Fri 6 Nov (holiday); one absence covers a day")
      // The first day back is free: the period is half-open.
      const back = await absent({ driverId: jonas.id, validFrom: "2026-11-07", validTo: "2026-11-08", reason: "leave" })

      // The list by driver, and by the days a period touches, both bounds in.
      assert.deepEqual((await absences(`?driverId=${jonas.id}`)).map((row) => row.id), [holiday.id, training.id, back.id])
      assert.deepEqual((await absences(`?driverId=${jonas.id}&from=2026-11-06&to=2026-11-06`)).map((row) => row.id), [holiday.id])
      assert.deepEqual((await absences(`?driverId=${jonas.id}&from=2026-11-09&to=2026-11-15`)).map((row) => row.id), [])
      assert.deepEqual((await absences(`?driverId=${jonas.id}&from=2026-11-20&to=2026-11-30`)).map((row) => row.id), [training.id])
      assert.deepEqual(paths(await refused(await olivia(`/driver-absences?from=2026-11-10&to=2026-11-09`), 400)), ["to"])

      // A patch moves the period, the reason or the note, judged as it leaves the row; one onto another's day is refused naming it.
      const moved = await patched(`/driver-absences/${training.id}`, { validTo: null, reason: "leave", note: "Parental leave" }, DriverAbsence)
      assert.deepEqual([moved.validFrom, moved.validTo, moved.reason, moved.note], ["2026-11-16", null, "leave", "Parental leave"])
      const onto = await refused(await olivia(`/driver-absences/${moved.id}`, { method: "PATCH", body: { validFrom: "2026-11-05" } }), 409)
      assert.equal(onto.detail, "Jonas Lind is already absent Mon 2 Nov – Fri 6 Nov (holiday); one absence covers a day")
      const backwards = await refused(await olivia(`/driver-absences/${holiday.id}`, { method: "PATCH", body: { validFrom: "2026-11-07" } }), 400)
      assert.deepEqual(paths(backwards), ["validTo"])
      assert.equal((await refused(await olivia(`/driver-absences/${holiday.id}`, { method: "PATCH", body: {} }), 400)).status, 400)
      assert.equal((await refused(await olivia(`/driver-absences/${holiday.id}`, { method: "PATCH", body: { driverId: fleet.drivers.mads.id } }), 400)).status, 400, "never whose it is")

      // The removal: 204 with no body, then it is not there.
      const removed = await olivia(`/driver-absences/${back.id}`, { method: "DELETE" })
      assert.equal(removed.status, 204)
      assert.equal(await removed.text(), "")
      await refused(await olivia(`/driver-absences/${back.id}`), 404)
      await refused(await olivia(`/driver-absences/${back.id}`, { method: "DELETE" }), 404)

      // The driver's history reads its absences, the removed one's delete among them.
      const history = AuditPage.parse(await (await olivia(`/audit-events?table=driver&rowId=${jonas.id}`)).json()).items.filter((event) => event.table === "driver_absence")
      assert.ok(history.some((event) => event.rowId === back.id && event.action === "delete" && event.parentId === jonas.id), "the delete, under the driver")
      assert.ok(history.some((event) => event.rowId === training.id && event.action === "update"), "the move")
    })

    test("refuses a body the contracts refuse, a driver of no project the caller works in, and fences every read and write by company and project", async () => {
      const mads = fleet.drivers.mads
      assert.deepEqual(paths(await refused(await olivia("/driver-absences", { method: "POST", body: { driverId: mads.id, validFrom: "2026-12-01", validTo: "2026-12-01", reason: "sick" } }), 400)), ["validTo"])
      assert.deepEqual(paths(await refused(await olivia("/driver-absences", { method: "POST", body: { driverId: mads.id, validFrom: "2026-12-01", reason: "vacation" } }), 400)), ["reason"])
      assert.equal((await refused(await olivia("/driver-absences", { method: "POST", body: { driverId: mads.id, validFrom: "2026-12-01", reason: "sick", projectId: a.projects.copenhagen.id } }), 400)).status, 400, "the project is the driver's")
      // Another company's driver, and a driver of a project the viewer does not work in: a 400 at the field.
      assert.deepEqual((await refused(await olivia("/driver-absences", { method: "POST", body: { driverId: theirFleet.drivers.mads.id, validFrom: "2026-12-01", reason: "sick" } }), 400)).errors, [{ path: "driverId", message: NOT_A_DRIVER_HERE }])
      assert.deepEqual((await refused(await viewer("/driver-absences", { method: "POST", body: { driverId: fleet.drivers.henrik.id, validFrom: "2026-12-01", reason: "sick" } }), 400)).errors, [{ path: "driverId", message: NOT_A_DRIVER_HERE }])

      // Henrik's absence, in Harbor Commercial: the viewer neither reads, lists, moves nor removes it; the other company sees none of this one's.
      const henriks = await absent({ driverId: fleet.drivers.henrik.id, validFrom: "2026-12-01", reason: "sick" })
      const viewers = await absent({ driverId: mads.id, validFrom: "2026-12-07", validTo: "2026-12-08", reason: "training" }, viewer)
      await refused(await viewer(`/driver-absences/${henriks.id}`), 404)
      await refused(await viewer(`/driver-absences/${henriks.id}`, { method: "PATCH", body: { note: "x" } }), 404)
      await refused(await viewer(`/driver-absences/${henriks.id}`, { method: "DELETE" }), 404)
      assert.ok(!(await absences("", viewer)).some((row) => row.id === henriks.id))
      assert.ok((await absences("", viewer)).some((row) => row.id === viewers.id))
      assert.deepEqual(paths(await refused(await viewer(`/driver-absences?projectId=${a.projects.harbor.id}`), 400)), ["projectId"])
      await refused(await other(`/driver-absences/${viewers.id}`), 404)
      assert.deepEqual(await absences("", other), [])
      assert.match((await refused(await ungranted("/driver-absences"), 403)).detail ?? "", /view on fleet\.drivers/)
      await refused(await olivia(`/driver-absences/${testId()}`), 404)
    })
  })

  describe("a vehicle's unavailability", () => {
    test("records a powered vehicle's and a trailer's periods, refuses a second over a day naming the first, moves and removes one, and fences them", async () => {
      const service = await unavailable({ vehicleId: nr12.id, validFrom: "2026-11-09", validTo: "2026-11-11", reason: "maintenance" })
      assert.deepEqual([service.projectId, service.vehicleId, service.validTo, service.reason], [a.projects.copenhagen.id, nr12.id, "2026-11-11", "maintenance"])
      const again = await refused(await olivia("/vehicle-unavailability", { method: "POST", body: { vehicleId: nr12.id, validFrom: "2026-11-10", reason: "breakdown" } }), 409)
      assert.equal(again.detail, "NR-12 is already unavailable Mon 9 Nov – Tue 10 Nov (maintenance); one period covers a day")
      const towed = await unavailable({ vehicleId: trailer.id, validFrom: "2026-11-30", validTo: "2026-12-01", reason: "inspection" })
      const twice = await refused(await olivia("/vehicle-unavailability", { method: "POST", body: { vehicleId: trailer.id, validFrom: "2026-11-30", reason: "repair" } }), 409)
      assert.equal(twice.detail, "TR 12 012 is already unavailable on Mon 30 Nov (inspection); one period covers a day", "a trailer is labelled by its registration")

      assert.deepEqual((await periods(`?vehicleId=${nr12.id}&from=2026-11-01&to=2026-11-30`)).map((row) => row.id), [service.id])
      const moved = await patched(`/vehicle-unavailability/${service.id}`, { validTo: "2026-11-13", reason: "repair" }, VehicleUnavailability)
      assert.deepEqual([moved.validTo, moved.reason], ["2026-11-13", "repair"])
      assert.deepEqual(paths(await refused(await olivia("/vehicle-unavailability", { method: "POST", body: { vehicleId: nr12.id, validFrom: "2026-12-01", reason: "rust" } }), 400)), ["reason"])
      assert.deepEqual((await refused(await olivia("/vehicle-unavailability", { method: "POST", body: { vehicleId: theirFleet.vehicles.wh24.id, validFrom: "2026-12-01", reason: "repair" } }), 400)).errors, [{ path: "vehicleId", message: NOT_A_VEHICLE_HERE }])
      assert.deepEqual((await refused(await viewer("/vehicle-unavailability", { method: "POST", body: { vehicleId: fleet.vehicles.harborTruck.id, validFrom: "2026-12-01", reason: "repair" } }), 400)).errors, [{ path: "vehicleId", message: NOT_A_VEHICLE_HERE }])

      const removed = await olivia(`/vehicle-unavailability/${towed.id}`, { method: "DELETE" })
      assert.equal(removed.status, 204)
      await refused(await olivia(`/vehicle-unavailability/${towed.id}`), 404)
      await refused(await other(`/vehicle-unavailability/${moved.id}`), 404)
      assert.match((await refused(await ungranted("/vehicle-unavailability"), 403)).detail ?? "", /view on fleet\.vehicles/)
    })
  })

  describe("the commands that name a driver or a vehicle afresh", () => {
    // Mads is off sick on the Monday the clock stands on and on holiday Mon 12 – Wed 14 Oct; NR-12 is in for inspection on the Monday and maintenance on Thu 15 Oct; the trailer is in for repair from Fri 16 Oct.
    before(async () => {
      const mads = fleet.drivers.mads.id
      await absent({ driverId: mads, validFrom: "2026-10-05", validTo: "2026-10-06", reason: "sick" })
      await absent({ driverId: mads, validFrom: "2026-10-12", validTo: "2026-10-15", reason: "holiday" })
      await unavailable({ vehicleId: nr12.id, validFrom: "2026-10-05", validTo: "2026-10-06", reason: "inspection" })
      await unavailable({ vehicleId: nr12.id, validFrom: "2026-10-15", validTo: "2026-10-16", reason: "maintenance" })
      await unavailable({ vehicleId: trailer.id, validFrom: "2026-10-16", reason: "repair" })
    })
    const command = (id: string, action: string, values?: unknown) => olivia(`/routes/${id}/${action}`, { method: "POST", body: values })
    const commanded = async (id: string, action: string, values?: unknown): Promise<RouteDetail> => {
      const response = await command(id, action, values)
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
      return RouteDetail.parse(await response.json())
    }
    const fresh = (seed: Parameters<typeof seedRoute>[4] = {}) => seedRoute(pool, a, fleet, ex, seed)

    test("an ad-hoc route, an assign and a reschedule refuse a crew away on the operating date, naming the period; the day back is free", async () => {
      const mads = fleet.drivers.mads.id
      // The fixture Monday's routes share its crew without times; the same-day rule (O7 of #290) is crew-day.test.ts's, so the crew commands here say `acceptSameDay`.
      const adHoc = (values: Record<string, unknown>) => olivia("/routes", { method: "POST", body: { projectId: a.projects.copenhagen.id, acceptSameDay: true, ...values } })
      assert.equal((await refused(await adHoc({ operatingDate: "2026-10-13", driverId: mads }), 409)).detail, "Mads Jensen is absent Mon 12 Oct – Wed 14 Oct (holiday); a route needs a driver who is there")
      assert.equal((await refused(await adHoc({ operatingDate: "2026-10-15", vehicleId: nr12.id }), 409)).detail, "NR-12 is unavailable on Thu 15 Oct (maintenance); a route needs a vehicle that is there")
      assert.equal((await adHoc({ operatingDate: "2026-10-15", driverId: mads })).status, 201, "Thursday is his first day back")

      const tuesday = await fresh({ operatingDate: "2026-10-13" })
      assert.equal((await refused(await command(tuesday.id, "assign", { driverId: mads }), 409)).detail, "Mads Jensen is absent Mon 12 Oct – Wed 14 Oct (holiday); a route needs a driver who is there")
      assert.equal((await commanded(tuesday.id, "assign", { driverId: fleet.drivers.jonas.id })).planned.driverId, fleet.drivers.jonas.id)
      const friday = await fresh({ operatingDate: "2026-10-16" })
      assert.equal((await refused(await command(friday.id, "assign", { trailerId: trailer.id }), 409)).detail, "TR 12 012 is unavailable from Fri 16 Oct (repair); a route needs a trailer that is there")

      // A route Mads is planned on the Friday before moves onto his holiday: refused; onto the Thursday he is back, taken.
      const before = await fresh({ operatingDate: "2026-10-09", plannedDriverId: mads })
      assert.equal((await refused(await command(before.id, "reschedule", { operatingDate: "2026-10-12" }), 409)).detail, "Mads Jensen is absent Mon 12 Oct – Wed 14 Oct (holiday); a route needs a driver who is there")
      assert.equal((await commanded(before.id, "reschedule", { operatingDate: "2026-10-15", acceptSameDay: true })).operatingDate, "2026-10-15")
      assert.equal((await commanded(before.id, "reschedule", { plannedStartTime: "06:00", acceptSameDay: true })).plannedStartTime, "06:00", "the start alone asks nothing of the day")
    })

    test("a dispatch whose planned driver is absent, or whose planned vehicle or trailer is out of use, on the operating date is refused, the period recorded after the assign without a refusal of its own", async () => {
      const wednesday = await fresh({ operatingDate: "2026-10-21", plannedDriverId: fleet.drivers.freja.id })
      // Freja falls ill after she was assigned: recording it is never refused for the work planned on its day.
      await absent({ driverId: fleet.drivers.freja.id, validFrom: "2026-10-21", validTo: "2026-10-22", reason: "sick" })
      const refusal = await refused(await command(wednesday.id, "dispatch"), 409)
      assert.equal(refusal.detail, "Freja Holm is absent on Wed 21 Oct (sick); dispatch the route to a driver who is there")
      assert.equal((await commanded(wednesday.id, "assign", { driverId: fleet.drivers.jonas.id })).planned.driverId, fleet.drivers.jonas.id)
      assert.equal((await commanded(wednesday.id, "dispatch")).status, "ready", "to a driver who is there")

      // NR-12 in the workshop on the Thursday, the trailer in for repair from the Friday: the route goes out with a crew that is there.
      const thursday = await fresh({ operatingDate: "2026-10-15", plannedDriverId: fleet.drivers.jonas.id, plannedVehicleId: nr12.id })
      assert.equal((await refused(await command(thursday.id, "dispatch"), 409)).detail, "NR-12 is unavailable on Thu 15 Oct (maintenance); dispatch the route with a vehicle that is there")
      const friday = await fresh({ operatingDate: "2026-10-16", plannedDriverId: fleet.drivers.jonas.id, plannedTrailerId: trailer.id })
      assert.equal((await refused(await command(friday.id, "dispatch"), 409)).detail, "TR 12 012 is unavailable from Fri 16 Oct (repair); dispatch the route with a trailer that is there")

      // The bulk dispatch judges each route as its own dispatch does: the two away refused in the same words, the one whose crew is there dispatched.
      const thereOnTheDay = await fresh({ operatingDate: "2026-10-22", plannedDriverId: fleet.drivers.jonas.id, plannedVehicleId: nr12.id })
      const bulk = await olivia("/routes/dispatch", { method: "POST", body: { routeIds: [thursday.id, thereOnTheDay.id, friday.id] } })
      assert.equal(bulk.status, 200, JSON.stringify(await bulk.clone().json()))
      const { results } = RouteDispatchResults.parse(await bulk.json())
      assert.deepEqual(
        results.map((result) => (result.outcome === "refused" ? [result.routeId, result.status, result.detail] : [result.routeId, result.outcome])),
        [
          [thursday.id, 409, "NR-12 is unavailable on Thu 15 Oct (maintenance); dispatch the route with a vehicle that is there"],
          [thereOnTheDay.id, "dispatched"],
          [friday.id, 409, "TR 12 012 is unavailable from Fri 16 Oct (repair); dispatch the route with a trailer that is there"],
        ],
      )
    })

    test("an allocation refuses a crew away on a day of its window, on the project's days; the change judges what it names afresh and the whole crew when the window moves", async () => {
      const allocate = (values: Record<string, unknown>) =>
        olivia("/vehicle-allocations", { method: "POST", body: { projectId: a.projects.copenhagen.id, plannedFrom: at("2026-10-14", "06:00"), plannedTo: at("2026-10-14", "14:00"), ...values } })
      assert.equal((await refused(await allocate({ vehicleId: nr12.id, plannedFrom: at("2026-10-15", "06:00"), plannedTo: at("2026-10-15", "14:00") }), 409)).detail, "NR-12 is unavailable on Thu 15 Oct (maintenance); a vehicle allocation needs a vehicle that is there")
      assert.equal((await refused(await allocate({ vehicleId: nr12.id, driverId: fleet.drivers.mads.id }), 409)).detail, "Mads Jensen is absent Mon 12 Oct – Wed 14 Oct (holiday); a vehicle allocation needs a driver who is there")
      // A window ending at midnight touches no day after it: Wednesday night into Thursday's first instant is Wednesday alone.
      const wednesday = await create(olivia, "/vehicle-allocations", { projectId: a.projects.copenhagen.id, vehicleId: nr12.id, plannedFrom: at("2026-10-14", "18:00"), plannedTo: at("2026-10-15", "00:00") }, VehicleAllocation)
      // The window moved onto Thursday, NR-12's day in the workshop: the vehicle the allocation keeps is judged again.
      const change = (values: Record<string, unknown>) => olivia(`/vehicle-allocations/${wednesday.id}/change`, { method: "POST", body: { reason: "Moved", ...values } })
      assert.equal((await refused(await change({ plannedFrom: at("2026-10-15", "06:00"), plannedTo: at("2026-10-15", "14:00") }), 409)).detail, "NR-12 is unavailable on Thu 15 Oct (maintenance); a vehicle allocation needs a vehicle that is there")
      assert.equal((await refused(await change({ driverId: fleet.drivers.mads.id }), 409)).detail, "Mads Jensen is absent Mon 12 Oct – Wed 14 Oct (holiday); a vehicle allocation needs a driver who is there")
      assert.equal((await change({ note: "Evening run" })).status, 200, "a note asks nothing")
    })

    test("a collection group's crew is judged on its first run day from the day the scheme starts or today: a scheme, a group added, a group's patch and a scheme's edit refuse the crew away then; a day the group does not run, or a later one, refuses nothing", async () => {
      const mads = fleet.drivers.mads.id
      const residual = { wasteFractionIds: [ex.fractions.residual.id], containerTypeIds: [], vehicleTypeId: null }
      const group = (name: string, values: Record<string, unknown> = {}) => ({ name, days: ["monday"], stopSource: "rule", rule: residual, ...values })
      const scheme = (name: string, validFrom: string, groups: unknown[], serviceDays = ["monday"]) =>
        olivia("/route-schemes", {
          method: "POST",
          body: { projectId: a.projects.copenhagen.id, name, planningAreaId: planning.areas.centrum.id, serviceType: "container-collection", frequency: "weekly", serviceDays, validFrom, collectionGroups: groups },
        })
      assert.equal((await refused(await scheme("Residual O6", "2026-01-01", [group("Residual", { driverId: mads })]), 409)).detail, "Mads Jensen is absent on Mon 5 Oct (sick); a collection group needs a driver who is there")
      assert.equal((await refused(await scheme("Residual O6", "2026-10-12", [group("Residual", { driverId: mads })]), 409)).detail, "Mads Jensen is absent Mon 12 Oct – Wed 14 Oct (holiday); a collection group needs a driver who is there", "judged on the scheme's first day")
      // Starting on the 19th, after both: a group recurs, and generation leaves off whoever is away on a later day.
      assert.equal((await scheme("Residual O6 later", "2026-10-19", [group("Residual", { driverId: mads })])).status, 201)
      // A Tuesday group judged on the Monday he is off sick: its first run is Tuesday the 6th, when he is there.
      assert.equal((await scheme("Residual O6 Tuesdays", "2026-01-01", [group("Tuesdays", { days: ["tuesday"], driverId: mads })], ["monday", "tuesday"])).status, 201)

      const plain = await created(olivia, "/route-schemes", await scheme("Residual O6", "2026-01-01", [group("Residual")]), RouteScheme)
      const added = await olivia(`/route-schemes/${plain.id}/collection-groups`, { method: "POST", body: group("Second", { vehicleId: nr12.id }) })
      assert.equal((await refused(added, 409)).detail, "NR-12 is unavailable on Mon 5 Oct (inspection); a collection group needs a vehicle that is there")
      const [first] = plain.collectionGroups
      assert.equal((await refused(await olivia(`/collection-groups/${first.id}`, { method: "PATCH", body: { driverId: mads } }), 409)).detail, "Mads Jensen is absent on Mon 5 Oct (sick); a collection group needs a driver who is there")
      assert.equal((await patched(`/collection-groups/${first.id}`, { name: "Residual, renamed" }, CollectionGroup)).name, "Residual, renamed", "a rename names nobody")
      const entry = { id: first.id, name: first.name, days: first.days, stopSource: first.stopSource, rule: first.rule, containerIds: first.containerIds, vehicleId: nr12.id }
      assert.equal((await refused(await olivia(`/route-schemes/${plain.id}`, { method: "PATCH", body: { collectionGroups: [entry] } }), 409)).detail, "NR-12 is unavailable on Mon 5 Oct (inspection); a collection group needs a vehicle that is there")
    })
  })
})
