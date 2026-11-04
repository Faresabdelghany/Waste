// A weighbridge's tickets through the API (O27 of #290): the ingest's
// outcomes in the body's order — matched to the session's route and written
// as its Unload, unmatched with each reason, replayed, refused — its bounds
// (413 before the token, 429 with Retry-After), the fences an integration's
// account is held to, the office's match by hand and dismissal, and the
// possible duplicates a weighbridge's Unload and a driver's tell each other.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Page } from "@waste/contracts/pagination"
import { Unload } from "@waste/contracts/unloads"
import { WeighbridgeIngest, WeighbridgeTicket, type WeighbridgeTicketIn } from "@waste/contracts/weighbridge"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { Allowance } from "../auth/public-door"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, seedExecution, seedRoute, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the unloads this suite appends, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const MODULE = "route-studio.weighbridge"
const TicketPage = Page(WeighbridgeTicket)
const AFTERNOON = new Date("2026-10-05T13:00:00Z")

describe("a weighbridge's tickets", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let olivia: Call
  /** The integration's account: view and create on the weighbridge, Project Access to Copenhagen Central alone. */
  let integration: Call
  let other: Call
  let tight: Call
  let small: Call
  let smallApp: ReturnType<typeof createApp>

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create"] }])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => AFTERNOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    integration = callingAs(app, keys, a.users.viewer, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    tight = callingAs(createApp({ probe: pool, pool, verifier: keys.verifier, now: () => AFTERNOON, weighbridgeAllowance: new Allowance(1, () => AFTERNOON) }), keys, a.users.olivia, a.companyId)
    smallApp = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => AFTERNOON, weighbridgeMaxBodyBytes: 200 })
    small = callingAs(smallApp, keys, a.users.olivia, a.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  let number = 0
  /** A ticket of ARC Amager for the completed route's truck at 12:40 its day, residual, unless the test says otherwise. */
  const ticket = (values: Partial<WeighbridgeTicketIn> = {}): WeighbridgeTicketIn => ({
    stationCode: "ARC-AMAGER",
    ticketNumber: `WB-${++number}`,
    vehicleRegistration: "cn-42-018",
    weighedAt: at(ex.day, "12:40").toISOString(),
    netKg: 8540,
    grossKg: 18_540,
    tareKg: 10_000,
    fractionKey: "residual",
    ...values,
  })
  const ingest = async (tickets: WeighbridgeTicketIn[], call = olivia): Promise<WeighbridgeIngest> => {
    const response = await call("/weighbridge-tickets", { method: "POST", body: { tickets } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return WeighbridgeIngest.parse(await response.json())
  }
  const one = async (id: string): Promise<WeighbridgeTicket> => WeighbridgeTicket.parse(await (await olivia(`/weighbridge-tickets/${id}`)).json())
  const unload = async (id: string): Promise<Unload> => Unload.parse(await (await olivia(`/unloads/${id}`)).json())

  test("matches a ticket to the route its truck's session spans, writes it as that route's Unload from the weighbridge, and answers a replay with the ticket it is", async () => {
    const sent = ticket()
    const [matched] = (await ingest([sent])).outcomes
    assert.equal(matched.outcome, "matched")
    if (matched.outcome !== "matched") return
    const written = await unload(matched.unloadId)
    assert.deepEqual(
      [written.routeId, written.source, written.sessionId, written.recordedBy, written.wasteFractionId, written.unloadingStationId, written.netKg, written.grossKg, written.tareKg, written.weighbridgeTicket, written.occurredAt],
      [ex.routes.completed.id, "integration", null, a.users.olivia.id, ex.fractions.residual.id, fleet.stations.amager.id, 8540, 18_540, 10_000, sent.ticketNumber, sent.weighedAt],
    )
    assert.equal(written.weightReview.status, "captured", "it waits in the desk's queue")
    const kept = await one(matched.ticketId)
    assert.deepEqual([kept.status, kept.routeId, kept.unloadId, kept.projectId, kept.vehicleId, kept.unmatchedReason], ["matched", ex.routes.completed.id, matched.unloadId, ex.routes.completed.projectId, fleet.vehicles.wh24.id, null])
    assert.equal((await (await olivia(`/unloads/${matched.unloadId}/transfer-note`)).status), 200, "and its transfer note is there")

    const [again] = (await ingest([sent])).outcomes
    assert.deepEqual(again, { stationCode: sent.stationCode, ticketNumber: sent.ticketNumber, outcome: "replayed", ticketId: matched.ticketId })
  })

  test("keeps a ticket it cannot match with the first reason, refuses an unknown station or an instant ahead of the clock, and answers in the body's order", async () => {
    const { outcomes } = await ingest([
      ticket({ vehicleRegistration: "ZZ 99 999" }),
      ticket({ weighedAt: at("2026-09-01", "10:00").toISOString() }),
      ticket({ fractionKey: undefined, wasteCode: "200108" }),
      ticket({ fractionKey: "glass" }),
      ticket({ stationCode: "NOWHERE" }),
      ticket({ weighedAt: new Date(AFTERNOON.getTime() + 6 * 60_000).toISOString() }),
    ])
    assert.deepEqual(
      outcomes.map((outcome) => (outcome.outcome === "unmatched" || outcome.outcome === "refused" ? `${outcome.outcome}:${outcome.reason}` : outcome.outcome)),
      ["unmatched:unknown-vehicle", "unmatched:no-route", "unmatched:unknown-fraction", "unmatched:fraction-not-accepted", "refused:unknown-station", "refused:ahead-of-clock"],
    )
    const first = outcomes[0]
    if (first.outcome !== "unmatched") return
    const kept = await one(first.ticketId)
    assert.deepEqual([kept.status, kept.projectId, kept.vehicleId, kept.vehicleRegistration], ["unmatched", null, null, "ZZ 99 999"], "a plate nobody drives has no project")
    const queue = TicketPage.parse(await (await olivia("/weighbridge-tickets?status=unmatched&limit=200")).json())
    assert.equal(queue.items.filter((item) => item.status === "unmatched").length, queue.items.length)
    assert.ok(queue.items.some((item) => item.id === first.ticketId))
  })

  test("is matched by hand to a route that ran and a fraction the station takes, or dismissed with a note, once", async () => {
    const [waiting, other] = (await ingest([ticket({ vehicleRegistration: "ZZ 11 111" }), ticket({ vehicleRegistration: "ZZ 22 222" })])).outcomes
    if (waiting.outcome !== "unmatched" || other.outcome !== "unmatched") return assert.fail("both wait for the office")
    const match = (id: string, body: unknown, call = olivia) => call(`/weighbridge-tickets/${id}/match`, { method: "POST", body })

    const notTaken = await match(waiting.ticketId, { routeId: ex.routes.completed.id, wasteFractionId: ex.fractions.glass.id })
    assert.equal(notTaken.status, 400)
    assert.deepEqual((await readProblem(notTaken)).errors?.map((error) => error.path), ["wasteFractionId"])
    const planned = await seedRoute(pool, a, fleet, ex, { status: "planned" })
    assert.equal((await match(waiting.ticketId, { routeId: planned.id, wasteFractionId: ex.fractions.residual.id })).status, 409, "a route that has not run")
    assert.equal((await match(waiting.ticketId, { routeId: ex.routes.completed.id, wasteFractionId: ex.fractions.residual.id }, integration)).status, 403, "the integration matches nothing by hand")

    const matched = await match(waiting.ticketId, { routeId: ex.routes.completed.id, wasteFractionId: ex.fractions.residual.id })
    assert.equal(matched.status, 200, JSON.stringify(await matched.clone().json()))
    const read = WeighbridgeTicket.parse(await matched.json())
    assert.deepEqual([read.status, read.routeId, read.unmatchedReason, read.projectId], ["matched", ex.routes.completed.id, "unknown-vehicle", ex.routes.completed.projectId], "it keeps what it waited for")
    assert.equal((await unload(read.unloadId ?? assert.fail("an Unload"))).source, "integration")
    const twice = await match(waiting.ticketId, { routeId: ex.routes.completed.id, wasteFractionId: ex.fractions.residual.id })
    assert.equal(twice.status, 409)
    assert.match((await readProblem(twice)).detail ?? "", /is matched already/)

    const dismissed = await olivia(`/weighbridge-tickets/${other.ticketId}/dismiss`, { method: "POST", body: { note: "A visitor's trailer" } })
    assert.equal(dismissed.status, 200)
    assert.deepEqual([WeighbridgeTicket.parse(await dismissed.json()).status], ["dismissed"])
    assert.equal((await olivia(`/weighbridge-tickets/${other.ticketId}/dismiss`, { method: "POST", body: { note: "Again" } })).status, 409)
  })

  test("tells a weighbridge's Unload and the driver's of the same route and fraction each other's possible duplicate, until the desk rejects one", async () => {
    const route = await seedRoute(pool, a, fleet, ex, { status: "active", plannedDriverId: fleet.drivers.mads.id, plannedVehicleId: fleet.vehicles.wh25.id, deviceId: "device-mads-dup" })
    const captured = await olivia(`/routes/${route.id}/unloads`, { method: "POST", body: { unloadingStationId: fleet.stations.amager.id, wasteFractionId: ex.fractions.residual.id, netKg: 7000, occurredAt: at(ex.day, "10:00").toISOString() } })
    assert.equal(captured.status, 201)
    const byHand = Unload.parse(await captured.json())
    const [weighed] = (await ingest([ticket({ vehicleRegistration: "CN 42 019", weighedAt: at(ex.day, "10:05").toISOString(), netKg: 7000, grossKg: undefined, tareKg: undefined })])).outcomes
    if (weighed.outcome !== "matched") return assert.fail(`matched, not ${JSON.stringify(weighed)}`)
    assert.deepEqual((await unload(weighed.unloadId)).possibleDuplicates, [byHand.id])
    assert.deepEqual((await unload(byHand.id)).possibleDuplicates, [weighed.unloadId])
    const rejected = await olivia(`/unloads/${byHand.id}/reject`, { method: "POST", body: { note: "The weighbridge's ticket is the reading" } })
    assert.equal(rejected.status, 201)
    assert.deepEqual((await unload(weighed.unloadId)).possibleDuplicates, [], "settled once one is rejected")
  })

  test("holds the integration's account to its projects and the company to its own tickets", async () => {
    const [harbor] = (await ingest([ticket({ vehicleRegistration: "CN 77 777" })], integration)).outcomes
    assert.equal(harbor.outcome, "unmatched")
    const [harbors] = (await ingest([ticket({ vehicleRegistration: "HB 10 001" })], integration)).outcomes
    assert.ok(harbors.outcome === "unmatched" && harbors.reason === "unknown-vehicle", "a truck of a project the account does not work in is no vehicle it knows")
    if (harbor.outcome !== "unmatched") return
    assert.equal((await other(`/weighbridge-tickets/${harbor.ticketId}`)).status, 404)
    const [theirs] = (await ingest([ticket()], other)).outcomes
    assert.deepEqual([theirs.outcome, theirs.outcome === "refused" ? theirs.reason : null], ["refused", "unknown-station"], "another company's station is none of theirs")
    assert.equal((await other("/weighbridge-tickets", { method: "POST", body: { tickets: [ticket()] } })).status, 200, "the administrator of another company may send, and is fenced to its own")
  })

  test("bounds a batch: five hundred tickets, the body before the token, and a company's batches a minute", async () => {
    const tooMany = await olivia("/weighbridge-tickets", { method: "POST", body: { tickets: Array.from({ length: 501 }, () => ticket()) } })
    assert.equal(tooMany.status, 400)
    const large = await small("/weighbridge-tickets", { method: "POST", body: { tickets: [ticket(), ticket()] } })
    assert.equal(large.status, 413)
    const unsigned = await smallApp.request("/weighbridge-tickets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tickets: [ticket(), ticket()] }) })
    assert.equal(unsigned.status, 413, "before the token is read")
    assert.equal((await tight("/weighbridge-tickets", { method: "POST", body: { tickets: [ticket({ stationCode: "NOWHERE" })] } })).status, 200)
    const limited = await tight("/weighbridge-tickets", { method: "POST", body: { tickets: [ticket({ stationCode: "NOWHERE" })] } })
    assert.equal(limited.status, 429)
    assert.ok(Number(limited.headers.get("retry-after")) > 0)
  })
})
