// The scale house through the API (M16a of #293): the tare register, keyed as
// the match reads a plate and active once per key; a walk-in's ticket weighed
// in and out and split into lines; an account's on the registered tare; one
// of our own vehicles' ticket matched to its route and written as its Unload,
// or kept with why not; the void, and the refusals of each, in the order the
// API judges them; and the fences.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Page } from "@waste/contracts/pagination"
import { ScaleTicket, ScaleTicketAmountDue, VehicleTare } from "@waste/contracts/scale-house"
import { Unload } from "@waste/contracts/unloads"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { agreement } from "@waste/db/schema/agreements"
import { product } from "@waste/db/schema/catalogue"
import { outboxEvent } from "@waste/db/schema/execution"
import { customer } from "@waste/db/schema/customers"
import { unloadingStation, unloadingStationFraction } from "@waste/db/schema/places"
import { withCompany } from "@waste/db/tenant"
import { and, eq } from "drizzle-orm"

import { createApp } from "../app"
import { NOT_A_SITE, NOT_SOLD_AT_THE_WINDOW, NOT_THE_CUSTOMERS_AGREEMENT, OWN_LOAD_IS_ONE_FRACTION, TARE_TAKEN, VOLUME_ONLY_BY_THE_CUBIC_METRE, VOLUME_REQUIRED, linesOffNet, noRegisteredTare, tareNotUnder, writtenAsUnload } from "../routes/scale-house"
import { seedPriceList } from "./finance-fixtures"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, seedExecution, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the lines and the Unloads this suite appends, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const MODULE = "operate.scale-house"
const TicketPage = Page(ScaleTicket)
const TarePage = Page(VehicleTare)
const AFTERNOON = new Date("2026-10-05T13:00:00Z")

describe("the scale house", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let olivia: Call
  let viewer: Call
  let other: Call
  const site = testId()
  const anna = testId()
  const bo = testId()
  const annasAgreement = testId()
  let project: string

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    project = a.projects.copenhagen.id
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(unloadingStation).values({
        id: site,
        companyId: a.companyId,
        code: `SH-${site.slice(-6)}`,
        name: `Nordhavn genbrugsplads ${site.slice(-6)}`,
        address: "Sundkrogsgade 30, 2100 København Ø",
        location: { type: "Point", coordinates: [12.5936, 55.7108] },
        ownership: "company",
        weighbridge: true,
        status: "active",
      })
      await tx.insert(unloadingStationFraction).values({ id: testId(), companyId: a.companyId, unloadingStationId: site, wasteFractionId: ex.fractions.residual.id })
      await tx.insert(customer).values([
        { id: anna, companyId: a.companyId, kind: "organisation", name: "Anna Byg ApS", registrationNumber: String(10_000_000 + Math.floor(Math.random() * 89_999_999)), status: "active" },
        { id: bo, companyId: a.companyId, kind: "person", name: "Bo Hansen", status: "active" },
      ])
      await tx.insert(agreement).values({ id: annasAgreement, companyId: a.companyId, projectId: project, validFrom: "2026-01-01", number: `AGR-${site.slice(-4)}`, customerId: anna, payerCustomerId: anna, status: "active", billingCadence: "monthly", currency: "DKK" })
    })
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view"] }])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => AFTERNOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const weighIn = async (body: Record<string, unknown>, call = olivia): Promise<ScaleTicket> => {
    const response = await call("/scale-tickets", { method: "POST", body: { projectId: project, unloadingStationId: site, ...body } })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return ScaleTicket.parse(await response.json())
  }
  const complete = (id: string, body: Record<string, unknown>) => olivia(`/scale-tickets/${id}/complete`, { method: "POST", body })
  const completed = async (id: string, body: Record<string, unknown>): Promise<ScaleTicket> => {
    const response = await complete(id, body)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return ScaleTicket.parse(await response.json())
  }
  const fieldErrors = async (response: Response) => {
    assert.equal(response.status, 400)
    return (await readProblem(response)).errors?.map((error) => [error.path, error.message])
  }
  /** The first pass, 12:20 on the fixtures' day. */
  const IN = (): string => at(ex.day, "12:20").toISOString()

  test("registers a tare by its keys, once while active, found however the plate is typed, and re-weighed or retired", async () => {
    const response = await olivia("/vehicle-tares", { method: "POST", body: { projectId: project, plate: "ab 12-345", containerRef: "sk 7", tareKg: 7_100, weighedOn: "2026-10-01", customerId: anna } })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    const tare = VehicleTare.parse(await response.json())
    assert.deepEqual([tare.plate, tare.trailerPlate, tare.containerRef, tare.status], ["AB12345", null, "SK7", "active"])

    const twice = await olivia("/vehicle-tares", { method: "POST", body: { projectId: project, plate: "AB12345", containerRef: "SK-7", tareKg: 7_000, weighedOn: "2026-10-02" } })
    assert.equal(twice.status, 409)
    assert.equal((await readProblem(twice)).detail, TARE_TAKEN)
    const otherKey = await olivia("/vehicle-tares", { method: "POST", body: { projectId: project, plate: "AB12345", tareKg: 6_000, weighedOn: "2026-10-02" } })
    assert.equal(otherKey.status, 201, "without the container it is another tare")
    assert.ok((await fieldErrors(await olivia("/vehicle-tares", { method: "POST", body: { projectId: project, plate: " - ", tareKg: 6_000, weighedOn: "2026-10-02" } })))?.some(([path]) => path === "plate"))

    const found = TarePage.parse(await (await olivia(`/vehicle-tares?plate=${encodeURIComponent("ab-12 345")}&status=active`)).json())
    assert.deepEqual(found.items.map((item) => item.containerRef).sort(), [null, "SK7"].sort())

    const reweighed = await olivia(`/vehicle-tares/${tare.id}`, { method: "PATCH", body: { tareKg: 7_150, weighedOn: "2026-10-04" } })
    assert.equal(VehicleTare.parse(await reweighed.json()).tareKg, 7_150)
    const retired = VehicleTare.parse(await (await olivia(`/vehicle-tares/${tare.id}`, { method: "PATCH", body: { status: "retired" } })).json())
    assert.equal(retired.status, "retired")
    const again = await olivia("/vehicle-tares", { method: "POST", body: { projectId: project, plate: "AB12345", containerRef: "SK7", tareKg: 7_200, weighedOn: "2026-10-05" } })
    assert.equal(again.status, 201, "a retired tare leaves its key free")
    const back = await olivia(`/vehicle-tares/${tare.id}`, { method: "PATCH", body: { status: "active" } })
    assert.equal(back.status, 409, "and is not taken back over the new one")
  })

  test("weighs a walk-in in and out, splits the load into lines by fraction and origin, and voids it with its reason", async () => {
    const ticket = await weighIn({ vehiclePlate: "XY 55 001", party: "cash", visitorName: "Lars", grossKg: 3_400, weighedInAt: IN() })
    assert.deepEqual([ticket.status, ticket.party, ticket.vehicleId, ticket.netKg, ticket.lines], ["open", "cash", null, null, []])
    assert.ok(ticket.number >= 1000)
    const after = await weighIn({ vehiclePlate: "XY 55 002", party: "cash", grossKg: 1_000, weighedInAt: IN() })
    assert.equal(after.number, ticket.number + 1, "numbered in the company's series")

    const lines = [
      { wasteFractionId: ex.fractions.residual.id, originMunicipality: "0101", netKg: 500 },
      { wasteFractionId: ex.fractions.residual.id, originMunicipality: "0147", netKg: 400 },
    ]
    assert.deepEqual(await fieldErrors(await complete(ticket.id, { tare: { source: "weighed", tareKg: 3_400 }, lines })), [["tare.tareKg", tareNotUnder(3_400)]])
    assert.deepEqual(await fieldErrors(await complete(ticket.id, { tare: { source: "weighed", tareKg: 2_400 }, lines })), [["lines", linesOffNet(900, 1_000)]])
    const notTaken = await fieldErrors(await complete(ticket.id, { tare: { source: "weighed", tareKg: 2_500 }, lines: [{ wasteFractionId: ex.fractions.glass.id, netKg: 900 }] }))
    assert.equal(notTaken?.[0]?.[0], "lines.0.wasteFractionId")
    assert.equal((await complete(ticket.id, { tare: { source: "weighed", tareKg: 2_500 }, weighedOutAt: at(ex.day, "12:00").toISOString(), lines })).status, 400, "the second pass comes after the first")

    const done = await completed(ticket.id, { tare: { source: "weighed", tareKg: 2_500 }, weighedOutAt: at(ex.day, "12:30").toISOString(), lines })
    assert.deepEqual([done.status, done.tareKg, done.tareSource, done.netKg, done.weighedOutAt, done.unloadId], ["completed", 2_500, "weighed", 900, at(ex.day, "12:30").toISOString(), null])
    assert.deepEqual(
      done.lines.map((line) => [line.position, line.originMunicipality, line.netKg]),
      [
        [1, "0101", 500],
        [2, "0147", 400],
      ],
    )
    assert.deepEqual(ScaleTicket.parse(await (await olivia(`/scale-tickets/${ticket.id}`)).json()).lines, done.lines)
    assert.equal((await complete(ticket.id, { tare: { source: "weighed", tareKg: 2_500 }, lines })).status, 409, "once")

    const page = TicketPage.parse(await (await olivia(`/scale-tickets?unloadingStationId=${site}&status=completed&party=cash&limit=200`)).json())
    assert.ok(page.items.some((item) => item.id === ticket.id && item.lines.length === 2))

    assert.deepEqual(await fieldErrors(await olivia(`/scale-tickets/${ticket.id}/void`, { method: "POST", body: { reason: "other" } })), [["note", "Say why in the note where the reason is another"]])
    const voided = ScaleTicket.parse(await (await olivia(`/scale-tickets/${ticket.id}/void`, { method: "POST", body: { reason: "entered-in-error" } })).json())
    assert.deepEqual([voided.status, voided.voidReason, voided.voidedAt, voided.lines.length], ["voided", "entered-in-error", AFTERNOON.toISOString(), 2])
    assert.equal((await olivia(`/scale-tickets/${ticket.id}/void`, { method: "POST", body: { reason: "duplicate" } })).status, 409)

    const left = ScaleTicket.parse(await (await olivia(`/scale-tickets/${after.id}/void`, { method: "POST", body: { reason: "visitor-left" } })).json())
    assert.deepEqual([left.status, left.tareKg], ["voided", null], "an open ticket is voided too")
  })

  test("weighs an account's vehicle in under its agreement, out on its registered tare, and refuses what is not the window's", async () => {
    assert.deepEqual(await fieldErrors(await olivia("/scale-tickets", { method: "POST", body: { projectId: project, unloadingStationId: fleet.stations.amager.id, vehiclePlate: "CD 1", party: "cash", grossKg: 1_000 } })), [["unloadingStationId", NOT_A_SITE]])
    assert.deepEqual(await fieldErrors(await olivia("/scale-tickets", { method: "POST", body: { projectId: project, unloadingStationId: site, vehiclePlate: "CD 1", party: "account", customerId: bo, agreementId: annasAgreement, grossKg: 1_000 } })), [["agreementId", NOT_THE_CUSTOMERS_AGREEMENT]])
    assert.equal((await olivia("/scale-tickets", { method: "POST", body: { projectId: project, unloadingStationId: site, vehiclePlate: "CD 1", party: "account", customerId: anna, grossKg: 1_000 } })).status, 400)
    assert.equal((await olivia("/scale-tickets", { method: "POST", body: { projectId: project, unloadingStationId: site, vehiclePlate: "CD 1", party: "cash", grossKg: 1_000, weighedInAt: new Date(AFTERNOON.getTime() + 6 * 60_000).toISOString() } })).status, 400, "not ahead of the clock")

    const ticket = await weighIn({ vehiclePlate: "cd-77 001", trailerPlate: "tr 9", party: "account", customerId: anna, agreementId: annasAgreement, grossKg: 18_000, weighedInAt: IN() })
    const missing = await complete(ticket.id, { tare: { source: "registered" }, lines: [{ wasteFractionId: ex.fractions.residual.id, netKg: 1 }] })
    assert.equal(missing.status, 409)
    assert.equal((await readProblem(missing)).detail, noRegisteredTare("cd-77 001"))

    const tare = VehicleTare.parse(await (await olivia("/vehicle-tares", { method: "POST", body: { projectId: project, plate: "CD77001", trailerPlate: "TR9", tareKg: 11_000, weighedOn: "2026-10-01" } })).json())
    const done = await completed(ticket.id, { tare: { source: "registered" }, lines: [{ wasteFractionId: ex.fractions.residual.id, netKg: 7_000 }] })
    assert.deepEqual([done.tareKg, done.tareSource, done.vehicleTareId, done.netKg, done.weighedOutAt, done.customerId, done.agreementId], [11_000, "registered", tare.id, 7_000, AFTERNOON.toISOString(), anna, annasAgreement])
  })

  test("matches one of our own vehicles' ticket to the route it ran and writes it as that route's Unload, which keeps the ticket standing", async () => {
    const ticket = await weighIn({ vehiclePlate: "cn 42-018", party: "cash", grossKg: 18_540, weighedInAt: at(ex.day, "12:30").toISOString() })
    assert.equal(ticket.vehicleId, fleet.vehicles.wh24.id, "the plate is the project's truck")
    const twoLines = [
      { wasteFractionId: ex.fractions.residual.id, originMunicipality: "0101", netKg: 4_000 },
      { wasteFractionId: ex.fractions.residual.id, originMunicipality: "0147", netKg: 4_540 },
    ]
    assert.deepEqual(await fieldErrors(await complete(ticket.id, { tare: { source: "weighed", tareKg: 10_000 }, lines: twoLines })), [["lines", OWN_LOAD_IS_ONE_FRACTION]])

    const done = await completed(ticket.id, { tare: { source: "weighed", tareKg: 10_000 }, weighedOutAt: at(ex.day, "12:40").toISOString(), lines: [{ wasteFractionId: ex.fractions.residual.id, netKg: 8_540 }] })
    assert.deepEqual([done.routeId, done.unmatchedReason], [ex.routes.completed.id, null])
    assert.ok(done.unloadId)
    const written = Unload.parse(await (await olivia(`/unloads/${done.unloadId}`)).json())
    assert.deepEqual(
      [written.routeId, written.source, written.unloadingStationId, written.wasteFractionId, written.netKg, written.grossKg, written.tareKg, written.weighbridgeTicket],
      [ex.routes.completed.id, "integration", site, ex.fractions.residual.id, 8_540, 18_540, 10_000, `ST-${ticket.number}`],
    )

    const stands = await olivia(`/scale-tickets/${ticket.id}/void`, { method: "POST", body: { reason: "duplicate" } })
    assert.equal(stands.status, 409)
    assert.equal((await readProblem(stands)).detail, writtenAsUnload(ticket.number, ex.routes.completed.number))
  })

  test("keeps one of our own vehicles' ticket that found no route with why", async () => {
    const ticket = await weighIn({ vehiclePlate: "CN 42 018", party: "cash", grossKg: 12_000, weighedInAt: at("2026-09-01", "10:00").toISOString() })
    const done = await completed(ticket.id, { tare: { source: "weighed", tareKg: 10_000 }, weighedOutAt: at("2026-09-01", "10:10").toISOString(), lines: [{ wasteFractionId: ex.fractions.residual.id, netKg: 2_000 }] })
    assert.deepEqual([done.status, done.routeId, done.unloadId, done.unmatchedReason], ["completed", null, null, "no-route"])
  })

  test("corrects only an open ticket's visitor and note, and holds the fences", async () => {
    const ticket = await weighIn({ vehiclePlate: "EF 1", party: "cash", grossKg: 900, weighedInAt: IN() })
    const patched = ScaleTicket.parse(await (await olivia(`/scale-tickets/${ticket.id}`, { method: "PATCH", body: { visitorName: "Mette", note: "Garden waste" } })).json())
    assert.deepEqual([patched.visitorName, patched.note], ["Mette", "Garden waste"])

    assert.equal((await other(`/scale-tickets/${ticket.id}`)).status, 404, "another company's ticket is no ticket")
    assert.equal((await other(`/scale-tickets/${ticket.id}/void`, { method: "POST", body: { reason: "duplicate" } })).status, 404)
    assert.equal((await viewer(`/scale-tickets/${ticket.id}`)).status, 200, "the view grant reads")
    assert.equal((await viewer("/scale-tickets", { method: "POST", body: { projectId: project, unloadingStationId: site, vehiclePlate: "EF 2", party: "cash", grossKg: 900 } })).status, 403, "and weighs nothing in")
    assert.equal((await viewer(`/scale-tickets/${ticket.id}/void`, { method: "POST", body: { reason: "duplicate" } })).status, 403)
    assert.equal((await viewer("/vehicle-tares", { method: "POST", body: { projectId: project, plate: "EF2", tareKg: 1, weighedOn: "2026-10-01" } })).status, 403)
  })

  // The window's prices (M16b of #293): products sold by the tonne and by the cubic metre, the project's default list with a tier.
  const byTheTonne = testId()
  const byTheCubicMetre = testId()
  const byThePickup = testId()
  before(async () => {
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(product).values([
        { id: byTheTonne, companyId: a.companyId, projectId: project, name: `Residual at the window ${byTheTonne.slice(-4)}`, kind: "additional-service", status: "active", unit: "tonne", vatPercent: 25 },
        { id: byTheCubicMetre, companyId: a.companyId, projectId: project, name: `Bulky at the window ${byTheCubicMetre.slice(-4)}`, kind: "additional-service", status: "active", unit: "m3", vatPercent: 25 },
        { id: byThePickup, companyId: a.companyId, projectId: project, name: `A pickup ${byThePickup.slice(-4)}`, kind: "container-collection", status: "active", unit: "pickup", vatPercent: 25 },
      ])
    })
    await seedPriceList(pool, a, {
      code: `WINDOW-${byTheTonne.slice(-6)}`,
      isDefault: true,
      rows: [
        { productId: byTheTonne, unitPriceMinor: 60_000 },
        { productId: byTheTonne, unitPriceMinor: 50_000, fromQuantity: 2 },
        { productId: byTheCubicMetre, unitPriceMinor: 20_000 },
      ],
    })
  })

  const amountDue = async (id: string): Promise<ScaleTicketAmountDue> => {
    const response = await olivia(`/scale-tickets/${id}/amount-due`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return ScaleTicketAmountDue.parse(await response.json())
  }
  const newsOf = (id: string) =>
    ownerPool.db.select({ kind: outboxEvent.kind }).from(outboxEvent).where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, id)))

  test("an account's line sold by the tonne is news for Finance, and comes to the tier its weight meets at the window (M16b of #293)", async () => {
    const ticket = await weighIn({ vehiclePlate: "GH 1", party: "account", customerId: anna, agreementId: annasAgreement, grossKg: 4_500, weighedInAt: IN() })
    assert.equal((await olivia(`/scale-tickets/${ticket.id}/amount-due`)).status, 409, "an open ticket comes to nothing yet")
    const done = await completed(ticket.id, { tare: { source: "weighed", tareKg: 2_000 }, lines: [{ wasteFractionId: ex.fractions.residual.id, netKg: 2_500, productId: byTheTonne }] })
    assert.deepEqual(done.lines.map((line) => [line.productId, line.volumeLitres]), [[byTheTonne, null]])
    assert.deepEqual((await newsOf(ticket.id)).map((row) => row.kind), ["scale-ticket-completed"])
    const due = await amountDue(ticket.id)
    assert.deepEqual([due.currency, due.lines[0]?.quantity, due.lines[0]?.unitPriceMinor, due.netMinor, due.vatMinor, due.totalMinor, due.complete], ["DKK", 2.5, 125_000, 125_000, 31_250, 156_250, true], "2.5 tonnes meet the tier from 2 at 500.00 a tonne")

    await olivia(`/scale-tickets/${ticket.id}/void`, { method: "POST", body: { reason: "entered-in-error" } })
    assert.deepEqual((await newsOf(ticket.id)).map((row) => row.kind).sort(), ["scale-ticket-completed", "scale-ticket-voided"])
  })

  test("a walk-in's load sold by the cubic metre declares its volume, and comes to the rate times it under the project's default list", async () => {
    const ticket = await weighIn({ vehiclePlate: "GH 2", party: "cash", grossKg: 1_400, weighedInAt: IN() })
    const line = { wasteFractionId: ex.fractions.residual.id, netKg: 400 }
    const tare = { source: "weighed", tareKg: 1_000 }
    assert.deepEqual(await fieldErrors(await complete(ticket.id, { tare, lines: [{ ...line, productId: byTheCubicMetre }] })), [["lines.0.volumeLitres", VOLUME_REQUIRED]])
    assert.deepEqual(await fieldErrors(await complete(ticket.id, { tare, lines: [{ ...line, productId: byTheTonne, volumeLitres: 1_500 }] })), [["lines.0.volumeLitres", VOLUME_ONLY_BY_THE_CUBIC_METRE]])
    assert.deepEqual(await fieldErrors(await complete(ticket.id, { tare, lines: [{ ...line, volumeLitres: 1_500 }] })), [["lines.0.volumeLitres", VOLUME_ONLY_BY_THE_CUBIC_METRE]])
    assert.deepEqual(await fieldErrors(await complete(ticket.id, { tare, lines: [{ ...line, productId: byThePickup }] })), [["lines.0.productId", NOT_SOLD_AT_THE_WINDOW]])
    await completed(ticket.id, { tare, lines: [{ ...line, productId: byTheCubicMetre, volumeLitres: 1_500 }] })
    const due = await amountDue(ticket.id)
    assert.deepEqual([due.lines[0]?.quantity, due.netMinor, due.totalMinor, due.complete], [1.5, 30_000, 37_500, true])
  })

  test("a line that names no product comes to nothing it can say, and says why", async () => {
    const ticket = await weighIn({ vehiclePlate: "GH 3", party: "cash", grossKg: 1_400, weighedInAt: IN() })
    await completed(ticket.id, { tare: { source: "weighed", tareKg: 1_000 }, lines: [{ wasteFractionId: ex.fractions.residual.id, netKg: 400 }] })
    const due = await amountDue(ticket.id)
    assert.deepEqual([due.lines[0]?.blockReason, due.totalMinor, due.complete], ["no-product", 0, false])
  })
})
