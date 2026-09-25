import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Alert, NAMES_A_SUBJECT } from "@waste/contracts/alerts"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { ticketLabel } from "@waste/contracts/resolution"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { company } from "@waste/db/schema/organisation"
import { ticket } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { RECORDED_AFTER_IT_HAPPENED } from "@waste/domain/execution/commands"
import { ALERT_DOES_NOT_CHANGE } from "@waste/domain/resolution/transitions"
import { eq, sql } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { nextMillisecond } from "./clock"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, seedRoute, type ExecutionFixtures, type SeededRoute } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the proofs the Execution fixtures append, which `wms_api` may not delete; this suite writes no ledger row of its own. */
const owner = ownerUnderTest()
const AlertPage = Page(Alert)

const MODULE = "operate.exceptions"

/** The request's clock, pinned: noon on the fixtures' Monday, so a default `detectedAt` and every stamp are known. */
const NOON = new Date("2026-10-05T12:00:00Z")
const noon = NOON.toISOString()
/** So many minutes and seconds after noon, as the wire spells it. */
const afterNoon = (minutes: number, seconds = 0) => new Date(NOON.getTime() + minutes * 60_000 + seconds * 1_000).toISOString()

/** A ticket seeded through `tx` for the link to point at: an alert needs only the row, and the tickets API is proved in its own suite. */
type SeededTicket = { id: string; number: number; label: string }

describe("the alert endpoints", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company, seeded once and read from never again but to prove it is invisible. */
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let theirFleet: FleetFixtures
  let theirs: ExecutionFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, create and edit, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager, whose charter grants `operate` view: a role that reaches no project of the company. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call
  /** A route of Harbor Commercial, which the viewer does not work in. */
  let harbors: SeededRoute
  /** The other company's alert, and one of Harbor Commercial's. */
  let theirAlert: Alert
  let harborAlert: Alert

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    theirFleet = await seedFleet(pool, b, await seedPlanning(pool, b))
    theirs = await seedExecution(pool, b, theirFleet)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
    harbors = await seedRoute(pool, a, fleet, ex, { project: "harbor", plannedDriverId: fleet.drivers.henrik.id, plannedVehicleId: fleet.vehicles.harborTruck.id })
    theirAlert = await raise({ projectId: b.projects.copenhagen.id, routeId: theirs.routes.ready.id }, other)
    harborAlert = await raise({ projectId: a.projects.harbor.id, routeId: null, vehicleId: fleet.vehicles.harborTruck.id })
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  /** A body about a route of Copenhagen Central, with whatever else the test says. */
  const body = (values: Record<string, unknown> = {}) => ({
    projectId: a.projects.copenhagen.id,
    title: "Truck late leaving the depot",
    details: "WH-24 had not left Nordhavn by 07:30.",
    kind: "route-exception",
    severity: "medium",
    routeId: ex.routes.ready.id,
    ...values,
  })
  const post = (values: unknown, call = olivia) => call("/alerts", { method: "POST", body: values })
  /** Raises an alert and asserts the create's three promises (Issue #74): 201, the body, and a `Location` that resolves. */
  async function raise(values: Record<string, unknown>, call = olivia): Promise<Alert> {
    const response = await post(body(values), call)
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    const created = Alert.parse(await response.json())
    const location = response.headers.get("location") ?? ""
    assert.equal(location, `/alerts/${created.id}`, "Location of POST /alerts")
    const read = await call(location)
    assert.equal(read.status, 200, `GET ${location}: ${JSON.stringify(await read.clone().json())}`)
    assert.deepEqual(Alert.parse(await read.json()), created, `GET ${location} is the row that was made`)
    return created
  }
  const one = async (id: string, call = olivia): Promise<Alert> => {
    const response = await call(`/alerts/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Alert.parse(await response.json())
  }
  const page = async (call: Call, query = "?limit=200") => AlertPage.parse(await (await call(`/alerts${query}`)).json())
  const command = (id: string, action: "acknowledge" | "resolve" | "link-ticket", values: unknown = {}, call = olivia) =>
    call(`/alerts/${id}/${action}`, { method: "POST", body: values })
  const commanded = async (id: string, action: "acknowledge" | "resolve" | "link-ticket", values: unknown = {}, call = olivia): Promise<Alert> => {
    const response = await command(id, action, values, call)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Alert.parse(await response.json())
  }
  /** A ticket of a project, written through `tx` as `wms_api` with its number from the company's counter, the way `POST /tickets` will take it. */
  async function ticketIn(tenant: Tenant, projectId: string, createdBy: string): Promise<SeededTicket> {
    const id = testId()
    let number = 0
    await withCompany(pool.db, tenant.companyId, async (tx: Tx) => {
      const [counter] = await tx
        .update(company)
        .set({ nextTicketNumber: sql`${company.nextTicketNumber} + 1` })
        .where(eq(company.id, tenant.companyId))
        .returning({ next: company.nextTicketNumber })
      if (counter === undefined) throw new Error(`no company ${tenant.companyId} to number a ticket in`)
      number = counter.next - 1
      await tx.insert(ticket).values({
        id,
        companyId: tenant.companyId,
        projectId,
        number,
        kind: "other",
        source: "office",
        subject: `Ticket ${number}`,
        description: "Seeded through tx: an alert needs only the row.",
        occurredAt: NOON,
        createdBy,
      })
    })
    return { id, number, label: ticketLabel(number) }
  }

  describe("POST /alerts", () => {
    test("raises an alert about a route with the server's part written — manual, new, the caller, the clock — reads it back, and takes every subject and a ticket", async () => {
      const created = await raise({})
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.deepEqual(
        [created.projectId, created.kind, created.severity, created.source, created.status, created.title, created.details],
        [a.projects.copenhagen.id, "route-exception", "medium", "manual", "new", "Truck late leaving the depot", "WH-24 had not left Nordhavn by 07:30."],
      )
      assert.equal(created.detectedAt, noon, "the request's clock when the body says nothing")
      assert.deepEqual([created.routeId, created.vehicleId, created.driverId, created.containerId, created.ticketId], [ex.routes.ready.id, null, null, null, null])
      assert.equal(created.raisedBy, a.users.olivia.id)
      assert.deepEqual([created.acknowledgedAt, created.acknowledgedBy, created.resolvedAt, created.resolvedBy, created.resolutionNote], [null, null, null, null, null], "new carries no stamp")
      assert.deepEqual(await one(created.id), created)

      const seen = await raise({ detectedAt: "2026-10-01T06:15:00+02:00", kind: "resource", severity: "high", routeId: null, vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id, containerId: ex.containers.bin1.id })
      assert.equal(seen.detectedAt, "2026-10-01T04:15:00.000Z", "the body's instant, answered in UTC; days behind the clock is fine, since the office records what it saw yesterday")
      assert.deepEqual([seen.routeId, seen.vehicleId, seen.driverId, seen.containerId], [null, fleet.vehicles.wh24.id, fleet.drivers.mads.id, ex.containers.bin1.id], "a null subject is no subject, and three named are three")

      const trailer = await raise({ routeId: null, vehicleId: fleet.vehicles.trailer.id })
      assert.equal(trailer.vehicleId, fleet.vehicles.trailer.id, "a vehicle of any kind: a trailer left in the road is a condition too")

      const about = await ticketIn(a, a.projects.copenhagen.id, a.users.olivia.id)
      const linked = await raise({ ticketId: about.id })
      assert.equal(linked.ticketId, about.id, "a ticket named on the create links the alert from the start")
      assert.equal(linked.status, "new", "and linked is no status")
    })

    test("refuses an alert about nothing at `routeId`, in the contracts' words", async () => {
      const nothing = await refused(await post(body({ routeId: undefined })), 400)
      assert.deepEqual(nothing.errors, [{ path: "routeId", message: NAMES_A_SUBJECT }])
      const nulls = await refused(await post(body({ routeId: null, vehicleId: null, driverId: null, containerId: null })), 400)
      assert.deepEqual(nulls.errors, [{ path: "routeId", message: NAMES_A_SUBJECT }], "four nulls name nothing")
    })

    test("holds every link to the project, the ticket included, and the project to the caller's, each a 400 at its field, and gates none of them on its status", async () => {
      const route = await refused(await post(body({ routeId: theirs.routes.ready.id })), 400)
      assert.deepEqual(route.errors, [{ path: "routeId", message: "Not a route of this project" }], "another company's route")
      const harborRoute = await refused(await post(body({ routeId: harbors.id })), 400)
      assert.deepEqual(harborRoute.errors, [{ path: "routeId", message: "Not a route of this project" }], "another project's route, of the caller's own company")
      const vehicle = await refused(await post(body({ vehicleId: fleet.vehicles.harborTruck.id })), 400)
      assert.deepEqual(vehicle.errors, [{ path: "vehicleId", message: "Not a vehicle of this project" }], "no kind demanded: the sentence names a vehicle")
      const theirTruck = await refused(await post(body({ vehicleId: theirFleet.vehicles.wh24.id })), 400)
      assert.deepEqual(theirTruck.errors, [{ path: "vehicleId", message: "Not a vehicle of this project" }])
      const driver = await refused(await post(body({ driverId: fleet.drivers.henrik.id })), 400)
      assert.deepEqual(driver.errors, [{ path: "driverId", message: "Not a driver of this project" }])
      const container = await refused(await post(body({ containerId: ex.containers.harborBin.id })), 400)
      assert.deepEqual(container.errors, [{ path: "containerId", message: "Not a container of this project" }])
      const harborTicket = await ticketIn(a, a.projects.harbor.id, a.users.olivia.id)
      const ticketElsewhere = await refused(await post(body({ ticketId: harborTicket.id })), 400)
      assert.deepEqual(ticketElsewhere.errors, [{ path: "ticketId", message: "Not a ticket of this project" }], "a ticket of another project of the caller's company")
      const theirTicket = await ticketIn(b, b.projects.copenhagen.id, b.users.olivia.id)
      const ticketTheirs = await refused(await post(body({ ticketId: theirTicket.id })), 400)
      assert.deepEqual(ticketTheirs.errors, [{ path: "ticketId", message: "Not a ticket of this project" }], "another company's")
      const nobody = await refused(await post(body({ ticketId: testId() })), 400)
      assert.deepEqual(nobody.errors, [{ path: "ticketId", message: "Not a ticket of this project" }])
      const routeFirst = await refused(await post(body({ routeId: harbors.id, ticketId: testId() })), 400)
      assert.deepEqual(routeFirst.errors, [{ path: "routeId", message: "Not a route of this project" }], "the links are held in body order, one 400 at a time")
      const project = await refused(await post(body({ projectId: b.projects.copenhagen.id })), 400)
      assert.deepEqual(project.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      const harbor = await refused(await post(body({ projectId: a.projects.harbor.id, routeId: harbors.id }), viewer), 400)
      assert.deepEqual(harbor.errors, [{ path: "projectId", message: "Not a project this account works in" }], "the viewer works in Copenhagen only")
      const owned = await refused(await post(body({ source: "telemetry" })), 400)
      assert.deepEqual(owned.errors?.map((error) => error.path), ["source"], "the server owns the source, and a strict body says so by name")
      assert.deepEqual((await refused(await post(body({ status: "acknowledged" })), 400)).errors?.map((error) => error.path), ["status"])

      // No status gate on a subject (#109 §3): a retired truck, an inactive driver and a route that has ended are what an alert is about.
      const retired = await raise({ routeId: null, vehicleId: fleet.vehicles.retired.id })
      assert.equal(retired.vehicleId, fleet.vehicles.retired.id)
      const inactive = await raise({ routeId: null, driverId: fleet.drivers.karen.id })
      assert.equal(inactive.driverId, fleet.drivers.karen.id)
      const ended = await raise({ routeId: ex.routes.completed.id })
      assert.equal(ended.routeId, ex.routes.completed.id)
    })

    test("holds `detectedAt` to at most five minutes ahead of the request's clock, with no lower bound, and writes nothing when it refuses", async () => {
      const before = (await page(olivia, `?limit=200&containerId=${ex.containers.bin3.id}`)).items.length
      const ahead = await refused(await post(body({ containerId: ex.containers.bin3.id, detectedAt: afterNoon(5, 1) })), 400)
      assert.deepEqual(ahead.errors, [{ path: "detectedAt", message: RECORDED_AFTER_IT_HAPPENED }], "a second past the skew")
      const farAhead = await refused(await post(body({ containerId: ex.containers.bin3.id, detectedAt: "2027-01-01T00:00:00Z" })), 400)
      assert.deepEqual(farAhead.errors, [{ path: "detectedAt", message: RECORDED_AFTER_IT_HAPPENED }])
      assert.equal((await page(olivia, `?limit=200&containerId=${ex.containers.bin3.id}`)).items.length, before, "nothing written")
      const atTheSkew = await raise({ containerId: ex.containers.bin3.id, detectedAt: afterNoon(5) })
      assert.equal(atTheSkew.detectedAt, afterNoon(5), "exactly the skew passes: the bound is inclusive")
      const within = await raise({ containerId: ex.containers.bin3.id, detectedAt: afterNoon(4) })
      assert.equal(within.detectedAt, afterNoon(4))
      const longAgo = await raise({ containerId: ex.containers.bin3.id, detectedAt: "2020-01-01T00:00:00Z" })
      assert.equal(longAgo.detectedAt, "2020-01-01T00:00:00.000Z", "no lower bound")
      const clockFirst = await refused(await post(body({ routeId: harbors.id, detectedAt: afterNoon(6) })), 400)
      assert.deepEqual(clockFirst.errors, [{ path: "detectedAt", message: RECORDED_AFTER_IT_HAPPENED }], "the clock is judged before the links: it costs no statement")
    })

    test("answers 403 for a role that may not create, and 401 without a token", async () => {
      assert.match((await refused(await post(body(), ungranted), 403)).detail ?? "", /create on operate\.exceptions/)
      assert.match((await refused(await post(body(), lars), 403)).detail ?? "", /create on operate\.exceptions/, "the provider manager's charter grants operate view, not create")
      assert.equal((await app.request("/alerts", { method: "POST", body: JSON.stringify(body()), headers: { "content-type": "application/json" } })).status, 401)
    })
  })

  describe("GET /alerts", () => {
    test("lists the caller's projects' alerts in id order, filters them by every field of the board, pages them, and shows nothing to a provider's manager or across companies", async () => {
      // Subjects of this test's own, so its counts meet no other test's alerts.
      const bin = ex.containers.bin2.id
      const first = await raise({ routeId: null, containerId: bin, kind: "asset", severity: "low" })
      const second = await raise({ routeId: ex.routes.planned.id, containerId: bin, kind: "service-risk", severity: "critical" })
      const third = await raise({ routeId: null, vehicleId: fleet.vehicles.wh25.id, driverId: fleet.drivers.jonas.id, containerId: bin, kind: "asset", severity: "low" })
      await commanded(second.id, "acknowledge")
      await commanded(third.id, "resolve", { note: "Tyre changed" })
      const about = await ticketIn(a, a.projects.copenhagen.id, a.users.olivia.id)
      await commanded(first.id, "link-ticket", { ticketId: about.id })
      const ids = async (query: string, call = olivia) => (await page(call, `?limit=200&containerId=${bin}${query}`)).items.map((row) => row.id)

      assert.deepEqual(await ids(""), [first.id, second.id, third.id], "in id order, the order they were made in")
      assert.deepEqual(await ids("&status=new"), [first.id], "linking moved no status")
      assert.deepEqual(await ids("&status=acknowledged"), [second.id])
      assert.deepEqual(await ids("&status=resolved"), [third.id])
      assert.deepEqual(await ids("&severity=low"), [first.id, third.id])
      assert.deepEqual(await ids("&severity=critical"), [second.id])
      assert.deepEqual(await ids("&kind=asset"), [first.id, third.id])
      assert.deepEqual(await ids(`&routeId=${ex.routes.planned.id}`), [second.id])
      assert.deepEqual(await ids(`&vehicleId=${fleet.vehicles.wh25.id}`), [third.id])
      assert.deepEqual(await ids(`&driverId=${fleet.drivers.jonas.id}`), [third.id])
      assert.deepEqual(await ids(`&ticketId=${about.id}`), [first.id])
      assert.deepEqual(await ids(`&projectId=${a.projects.copenhagen.id}`), [first.id, second.id, third.id])
      assert.deepEqual(await ids(`&projectId=${a.projects.harbor.id}`), [])
      assert.deepEqual(await ids(""), await ids("", viewer), "the viewer works in Copenhagen and reads its alerts")

      const page1 = await page(olivia, `?limit=2&containerId=${bin}`)
      assert.deepEqual(page1.items.map((row) => row.id), [first.id, second.id])
      assert.ok(page1.nextCursor !== null)
      const page2 = await page(olivia, `?limit=2&containerId=${bin}&cursor=${page1.nextCursor}`)
      assert.deepEqual([page2.items.map((row) => row.id), page2.nextCursor], [[third.id], null])

      const everything = await page(olivia)
      assert.ok(everything.items.some((row) => row.id === harborAlert.id), "Olivia works in every project")
      assert.ok(!everything.items.some((row) => row.id === theirAlert.id), "and sees no other company's")
      const copenhagenOnly = await page(viewer)
      assert.ok(copenhagenOnly.items.some((row) => row.id === first.id))
      assert.ok(!copenhagenOnly.items.some((row) => row.id === harborAlert.id), "the viewer works in Copenhagen only")
      assert.deepEqual(await page(lars), { items: [], nextCursor: null }, "a provider's manager works in no project and reads an empty page, whatever the charter grants")
    })

    test("refuses a project out of reach, a cursor it did not write, and a role without view", async () => {
      const project = await refused(await viewer(`/alerts?projectId=${a.projects.harbor.id}`), 400)
      assert.deepEqual(project.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      assert.deepEqual((await refused(await olivia("/alerts?cursor=nope"), 400)).errors?.map((error) => error.path), ["cursor"])
      assert.deepEqual((await refused(await olivia("/alerts?status=linked"), 400)).errors?.map((error) => error.path), ["status"], "linked is a reading of ticketId and no status")
      assert.match((await refused(await ungranted("/alerts"), 403)).detail ?? "", /view on operate\.exceptions/)
    })
  })

  describe("GET /alerts/:id", () => {
    test("answers 404 for another company's, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      await refused(await olivia(`/alerts/${theirAlert.id}`), 404)
      assert.equal((await one(theirAlert.id, other)).id, theirAlert.id, "still there for its own company")
      await refused(await viewer(`/alerts/${harborAlert.id}`), 404)
      assert.equal((await one(harborAlert.id)).id, harborAlert.id)
      await refused(await lars(`/alerts/${harborAlert.id}`), 404)
      const missing = await refused(await olivia(`/alerts/${testId()}`), 404)
      assert.match(missing.detail ?? "", /^No alert [0-9a-f-]+ in the projects this account works in$/)
      assert.deepEqual((await refused(await olivia("/alerts/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
      assert.equal((await app.request(`/alerts/${testId()}`)).status, 401)
      assert.match((await refused(await ungranted(`/alerts/${harborAlert.id}`), 403)).detail ?? "", /view on operate\.exceptions/)
    })
  })

  describe("POST /alerts/:id/acknowledge", () => {
    test("moves new to acknowledged with the caller and the clock, and a second acknowledge answers 200 without a write", async () => {
      const created = await raise({})
      await nextMillisecond()
      const acknowledged = await commanded(created.id, "acknowledge")
      assert.deepEqual([acknowledged.status, acknowledged.acknowledgedAt, acknowledged.acknowledgedBy], ["acknowledged", noon, a.users.olivia.id])
      assert.deepEqual([acknowledged.resolvedAt, acknowledged.resolvedBy, acknowledged.resolutionNote], [null, null, null])
      assert.ok(acknowledged.updatedAt > created.updatedAt)
      assert.deepEqual(await one(created.id), acknowledged)
      await nextMillisecond()
      const again = await commanded(created.id, "acknowledge")
      assert.deepEqual(again, acknowledged, "idempotent: the same row, the same stamp")
      const byViewer = await raise({}, viewer)
      const theirs = await commanded(byViewer.id, "acknowledge", {}, viewer)
      assert.equal(theirs.acknowledgedBy, a.users.viewer.id, "the caller, whoever raised it")
      const member = await refused(await command(created.id, "acknowledge", { note: "Seen" }), 400)
      assert.ok(member.errors?.some((error) => /note/.test(error.message)), "the acknowledge's body is empty; a member is refused")
    })

    test("refuses a resolved alert with the domain's sentence, and writes nothing", async () => {
      const created = await raise({})
      const resolved = await commanded(created.id, "resolve", { note: "Left the depot at 07:35" })
      const refusal = await refused(await command(created.id, "acknowledge"), 409)
      assert.equal(refusal.detail, ALERT_DOES_NOT_CHANGE)
      assert.deepEqual(await one(created.id), resolved, "as it stood: no stamp moved, the shape never reached")
    })
  })

  describe("POST /alerts/:id/resolve", () => {
    test("moves acknowledged to resolved with the caller, the clock and the note; resolves a new alert without acknowledging it; and a second resolve answers 200 without a write", async () => {
      const created = await raise({})
      const acknowledged = await commanded(created.id, "acknowledge")
      await nextMillisecond()
      const resolved = await commanded(created.id, "resolve", { note: "Truck left at 07:35; the driver had been held at the gate" })
      assert.deepEqual(
        [resolved.status, resolved.acknowledgedAt, resolved.acknowledgedBy, resolved.resolvedAt, resolved.resolvedBy, resolved.resolutionNote],
        ["resolved", acknowledged.acknowledgedAt, a.users.olivia.id, noon, a.users.olivia.id, "Truck left at 07:35; the driver had been held at the gate"],
        "the acknowledgement stands, the resolution is stamped",
      )
      assert.ok(resolved.updatedAt > acknowledged.updatedAt)
      await nextMillisecond()
      const again = await commanded(created.id, "resolve", { note: "Once more" })
      assert.deepEqual(again, resolved, "idempotent: the same row, the first note")

      const straight = await raise({})
      const withoutAcknowledging = await commanded(straight.id, "resolve")
      assert.deepEqual(
        [withoutAcknowledging.status, withoutAcknowledging.acknowledgedAt, withoutAcknowledging.acknowledgedBy, withoutAcknowledging.resolvedAt, withoutAcknowledging.resolvedBy, withoutAcknowledging.resolutionNote],
        ["resolved", null, null, noon, a.users.olivia.id, null],
        "a resolved alert may never have been acknowledged, and a note is optional",
      )
      assert.deepEqual([...new Set((await refused(await command(straight.id, "resolve", { note: "" }), 400)).errors?.map((error) => error.path))], ["note"], "a blank note is no note: every issue is at the note")
      assert.deepEqual((await refused(await command(straight.id, "resolve", { reason: "x" }), 400)).errors?.map((error) => error.path), ["reason"], "a member the command does not take, told at the member")
    })
  })

  describe("POST /alerts/:id/link-ticket", () => {
    test("links the alert to a ticket of its project once: the same ticket again writes nothing, another is refused naming the one it names", async () => {
      const created = await raise({})
      const first = await ticketIn(a, a.projects.copenhagen.id, a.users.olivia.id)
      const second = await ticketIn(a, a.projects.copenhagen.id, a.users.olivia.id)
      await nextMillisecond()
      const linked = await commanded(created.id, "link-ticket", { ticketId: first.id })
      assert.deepEqual([linked.ticketId, linked.status], [first.id, "new"], "linked to ticket is the column, not a status")
      assert.ok(linked.updatedAt > created.updatedAt)
      assert.deepEqual(await one(created.id), linked)
      await nextMillisecond()
      const again = await commanded(created.id, "link-ticket", { ticketId: first.id })
      assert.deepEqual(again, linked, "the same ticket: nothing to do, nothing written")
      const another = await refused(await command(created.id, "link-ticket", { ticketId: second.id }), 409)
      assert.equal(another.detail, `This alert is linked to ticket ${first.label}; an alert links to one ticket`)
      assert.match(another.detail ?? "", /^This alert is linked to ticket T-\d+; an alert links to one ticket$/, "the ticket is named by its label")
      assert.deepEqual(await one(created.id), linked, "still the first")

      const acknowledged = await commanded(created.id, "acknowledge")
      assert.equal(acknowledged.ticketId, first.id, "the link survives the machine")
      const fromTheStart = await raise({ ticketId: first.id })
      const rethought = await refused(await command(fromTheStart.id, "link-ticket", { ticketId: second.id }), 409)
      assert.equal(rethought.detail, `This alert is linked to ticket ${first.label}; an alert links to one ticket`, "a ticket named on the create is the one link too")
    })

    test("holds the ticket to the alert's project (400) before the alert's own 409s, and refuses a resolved alert whatever the ticket", async () => {
      const created = await raise({})
      const harborTicket = await ticketIn(a, a.projects.harbor.id, a.users.olivia.id)
      const elsewhere = await refused(await command(created.id, "link-ticket", { ticketId: harborTicket.id }), 400)
      assert.deepEqual(elsewhere.errors, [{ path: "ticketId", message: "Not a ticket of this project" }])
      const theirTicket = await ticketIn(b, b.projects.copenhagen.id, b.users.olivia.id)
      const theirs = await refused(await command(created.id, "link-ticket", { ticketId: theirTicket.id }), 400)
      assert.deepEqual(theirs.errors, [{ path: "ticketId", message: "Not a ticket of this project" }])
      assert.deepEqual((await refused(await command(created.id, "link-ticket", {}), 400)).errors?.map((error) => error.path), ["ticketId"])
      assert.equal((await one(created.id)).ticketId, null, "nothing written")

      const resolved = await commanded(created.id, "resolve")
      const about = await ticketIn(a, a.projects.copenhagen.id, a.users.olivia.id)
      const refusal = await refused(await command(created.id, "link-ticket", { ticketId: about.id }), 409)
      assert.equal(refusal.detail, ALERT_DOES_NOT_CHANGE, "a resolved alert does not change through any door")
      const badTicketFirst = await refused(await command(created.id, "link-ticket", { ticketId: harborTicket.id }), 400)
      assert.deepEqual(badTicketFirst.errors, [{ path: "ticketId", message: "Not a ticket of this project" }], "the body's 400 before the alert's 409")
      assert.deepEqual(await one(created.id), resolved, "as it stood")
    })

    test("every command answers 404 outside the caller's scope and 403 for a role without edit, and writes nothing", async () => {
      const about = await ticketIn(a, a.projects.harbor.id, a.users.olivia.id)
      for (const [action, values] of [
        ["acknowledge", {}],
        ["resolve", { note: "Mine" }],
        ["link-ticket", { ticketId: about.id }],
      ] as const) {
        await refused(await command(theirAlert.id, action, values), 404)
        await refused(await command(harborAlert.id, action, values, viewer), 404)
        await refused(await command(testId(), action, values), 404)
        assert.match((await refused(await command(harborAlert.id, action, values, ungranted), 403)).detail ?? "", /edit on operate\.exceptions/, action)
        assert.match((await refused(await command(harborAlert.id, action, values, lars), 403)).detail ?? "", /edit on operate\.exceptions/, `${action}: the provider manager's charter grants operate view, not edit, and the grant is asked before the row`)
      }
      const untouched = await one(harborAlert.id)
      assert.deepEqual([untouched.status, untouched.ticketId, untouched.updatedAt], ["new", null, harborAlert.updatedAt], "untouched")
      assert.equal((await one(theirAlert.id, other)).status, "new")
    })
  })
})
