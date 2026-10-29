// A transfer station's haul-out (M17 of #293, row 28.3) through the API: a
// station made a transfer station; its stock read from our Unloads by their
// weight review, less the loads sent on, plus the counts' adjustments; a load
// sent on from it to a plant that takes the fraction, received against the
// plant's ticket, then reconciled or disputed, or cancelled before it is
// received; and the fences: a station that is not a transfer station sends
// nothing and takes no adjustment, another company's loads are absent, and a
// role without the weights grant reads none.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { LOAD_NOT_RECEIVED, LOAD_RECEIVED_NOT_CANCELLED, loadDoesNotChange, notATransferStation } from "@waste/domain/execution/haul-out"
import { MaterialAdjustment, MaterialStock, OutboundLoad } from "@waste/contracts/haul-out"
import { Page } from "@waste/contracts/pagination"
import { UnloadingStation } from "@waste/contracts/places"
import { Unload } from "@waste/contracts/unloads"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { RECEIVED_BEFORE_IT_LEFT } from "../routes/outbound-loads"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, seedExecution, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the unloads and adjustments this suite appends, which `wms_api` may not delete. */
const owner = ownerUnderTest()

const AFTERNOON = new Date("2026-10-05T15:00:00Z")

describe("a transfer station's haul-out", { skip: database.skip || owner.skip }, () => {
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
  /** The external incineration plant the transfer station sends residual waste on to. */
  let plant: UnloadingStation

  const LoadPage = Page(OutboundLoad)
  const AdjustmentPage = Page(MaterialAdjustment)
  const unique = (name: string) => `${name}-${testId().slice(-8)}`

  const read = async <T>(call: Call, path: string, schema: { parse: (value: unknown) => T }): Promise<T> => {
    const response = await call(path)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const answered = async <T>(response: Response, schema: { parse: (value: unknown) => T }, status = 200): Promise<T> => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const refused = async (response: Response, status: number): Promise<string> => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return (await readProblem(response)).detail ?? ""
  }

  /** A station of the company of the test's own, so no test's stock meets another's. */
  const station = async (values: Record<string, unknown> = {}): Promise<UnloadingStation> => {
    const code = unique("ST")
    const body = { code, name: code, address: "Havnevej 2", location: { type: "Point", coordinates: [12.6, 55.7] }, ownership: "company", wasteFractionIds: [ex.fractions.residual.id], ...values }
    return await created(olivia, "/unloading-stations", await olivia("/unloading-stations", { method: "POST", body }), UnloadingStation)
  }
  const tip = async (stationId: string, netKg: number, values: Record<string, unknown> = {}): Promise<Unload> => {
    const body = { unloadingStationId: stationId, wasteFractionId: ex.fractions.residual.id, netKg, occurredAt: at(ex.day, "12:40").toISOString(), ...values }
    return await created(olivia, `/routes/${ex.routes.completed.id}/unloads`, await olivia(`/routes/${ex.routes.completed.id}/unloads`, { method: "POST", body }), Unload, "/unloads")
  }
  const loadFrom = (fromStationId: string, values: Record<string, unknown> = {}) => ({
    projectId: a.projects.copenhagen.id,
    fromStationId,
    toStationId: plant.id,
    wasteFractionId: ex.fractions.residual.id,
    vehicleRegistration: "AB 12 345",
    departedAt: at(ex.day, "14:00").toISOString(),
    netKg: 20_000,
    ...values,
  })
  const send = async (fromStationId: string, values: Record<string, unknown> = {}): Promise<OutboundLoad> =>
    created(olivia, "/outbound-loads", await olivia("/outbound-loads", { method: "POST", body: loadFrom(fromStationId, values) }), OutboundLoad)
  const act = (id: string, name: string, body: Record<string, unknown> = {}) => olivia(`/outbound-loads/${id}/${name}`, { method: "POST", body })
  const receipt = (netKg: number, values: Record<string, unknown> = {}) => ({ receivingTicket: "ARC-88123", receivedNetKg: netKg, receivedAt: at(ex.day, "14:45").toISOString(), ...values })
  const stockOf = async (stationId: string) => (await read(olivia, `/unloading-stations/${stationId}/stock?projectId=${a.projects.copenhagen.id}`, MaterialStock)).rows

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => AFTERNOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    plant = await station({ ownership: "external" })
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  describe("a transfer station", () => {
    test("is a station the office says is one, off when it does not", async () => {
      assert.equal(plant.transfer, false)
      const made = await station({ transfer: true })
      assert.equal(made.transfer, true)
      const patched = await answered(await olivia(`/unloading-stations/${plant.id}`, { method: "PATCH", body: { notes: "The plant" } }), UnloadingStation)
      assert.equal(patched.transfer, false)
    })

    test("holds what our Unloads tipped by their weight review, less what it sent on, plus the counts' adjustments", async () => {
      const transfer = await station({ transfer: true })
      const captured = await tip(transfer.id, 12_000)
      const approved = await tip(transfer.id, 9_000)
      assert.equal((await olivia(`/unloads/${approved.id}/approve`, { method: "POST", body: {} })).status, 201)
      const rejected = await tip(transfer.id, 4_000)
      assert.equal((await olivia(`/unloads/${rejected.id}/reject`, { method: "POST", body: { note: "The ticket is another truck's" } })).status, 201)
      const wrong = await tip(transfer.id, 7_000)
      assert.equal((await olivia(`/unloads/${wrong.id}/correct`, { method: "POST", body: { netKg: 6_500, note: "Read off the ticket again" } })).status, 201)
      await tip(transfer.id, 3_000, { refusal: { reason: "contamination" } })
      assert.ok(captured.id)
      assert.deepEqual(await stockOf(transfer.id), [
        { projectId: a.projects.copenhagen.id, wasteFractionId: ex.fractions.residual.id, inKg: 12_000 + 9_000 + 6_500, rejectedKg: 4_000, outKg: 0, adjustedKg: 0, onHandKg: 27_500 },
      ])
      await send(transfer.id, { netKg: 20_000 })
      const cancelled = await send(transfer.id, { netKg: 5_000 })
      await answered(await act(cancelled.id, "cancel", { note: "Left on the wrong ticket" }), OutboundLoad)
      const adjustment = await answered(
        await olivia(`/unloading-stations/${transfer.id}/adjustments`, { method: "POST", body: { projectId: a.projects.copenhagen.id, wasteFractionId: ex.fractions.residual.id, deltaKg: -1_500, note: "Counted after the haul" } }),
        MaterialAdjustment,
        201,
      )
      assert.equal(adjustment.recordedBy, a.users.olivia.id)
      assert.deepEqual(await stockOf(transfer.id), [
        { projectId: a.projects.copenhagen.id, wasteFractionId: ex.fractions.residual.id, inKg: 27_500, rejectedKg: 4_000, outKg: 20_000, adjustedKg: -1_500, onHandKg: 6_000 },
      ])
      assert.deepEqual((await read(olivia, `/unloading-stations/${transfer.id}/adjustments`, AdjustmentPage)).items.map((item) => item.id), [adjustment.id])
    })

    test("takes an adjustment only when it is a transfer station, and never by zero", async () => {
      const body = { projectId: a.projects.copenhagen.id, wasteFractionId: ex.fractions.residual.id, deltaKg: 500, note: "Counted" }
      assert.equal(await refused(await olivia(`/unloading-stations/${plant.id}/adjustments`, { method: "POST", body }), 409), notATransferStation(plant.name))
      const transfer = await station({ transfer: true })
      assert.equal((await olivia(`/unloading-stations/${transfer.id}/adjustments`, { method: "POST", body: { ...body, deltaKg: 0 } })).status, 400)
    })
  })

  describe("an outbound load", () => {
    test("leaves a transfer station for a plant that takes the fraction, our vehicle's plate read off it", async () => {
      const transfer = await station({ transfer: true })
      const { vehicleRegistration: _plate, ...withoutPlate } = loadFrom(transfer.id)
      const load = await answered(await olivia("/outbound-loads", { method: "POST", body: { ...withoutPlate, vehicleId: fleet.vehicles.wh24.id, haulCostMinor: 185_000 } }), OutboundLoad, 201)
      assert.deepEqual([load.status, load.vehicleRegistration, load.receipt, load.haulCostMinor], ["departed", "CN 42 018", null, 185_000])
      assert.equal(await refused(await olivia("/outbound-loads", { method: "POST", body: loadFrom(plant.id, { toStationId: transfer.id }) }), 409), notATransferStation(plant.name))
      const elsewhere = await station({ ownership: "external", wasteFractionIds: [ex.fractions.glass.id] })
      assert.match(await refused(await olivia("/outbound-loads", { method: "POST", body: loadFrom(transfer.id, { toStationId: elsewhere.id }) }), 409), /does not take/)
      const tomorrow = new Date(AFTERNOON.getTime() + 86_400_000).toISOString()
      assert.deepEqual((await readProblem(await olivia("/outbound-loads", { method: "POST", body: loadFrom(transfer.id, { departedAt: tomorrow }) }))).errors?.map((error) => error.path), ["departedAt"])
      const page = await read(olivia, `/outbound-loads?fromStationId=${transfer.id}`, LoadPage)
      assert.deepEqual(page.items.map((item) => item.id), [load.id])
    })

    test("is received against the plant's ticket, then reconciled, or disputed and settled", async () => {
      const transfer = await station({ transfer: true })
      const load = await send(transfer.id)
      assert.equal(await refused(await act(load.id, "reconcile"), 409), LOAD_NOT_RECEIVED)
      assert.deepEqual((await readProblem(await act(load.id, "receive", receipt(19_200, { receivedAt: at(ex.day, "13:00").toISOString() })))).errors, [{ path: "receivedAt", message: RECEIVED_BEFORE_IT_LEFT }])
      const received = await answered(await act(load.id, "receive", receipt(19_200)), OutboundLoad)
      assert.equal(received.status, "received")
      assert.deepEqual(received.receipt, { ticket: "ARC-88123", netKg: 19_200, receivedAt: at(ex.day, "14:45").toISOString(), differenceKg: -800, deviationPercent: -4, withinTolerance: true })
      assert.equal(await refused(await act(load.id, "cancel", { note: "Too late" }), 409), LOAD_RECEIVED_NOT_CANCELLED)
      assert.equal((await act(load.id, "dispute")).status, 400, "a dispute says why")
      const disputed = await answered(await act(load.id, "dispute", { note: "The plant weighed 800 kg less" }), OutboundLoad)
      assert.deepEqual([disputed.status, disputed.note], ["disputed", "The plant weighed 800 kg less"])
      const corrected = await answered(await act(load.id, "receive", receipt(22_000, { receivingTicket: "ARC-88124" })), OutboundLoad)
      assert.deepEqual([corrected.status, corrected.receipt?.ticket, corrected.receipt?.withinTolerance], ["received", "ARC-88124", false], "beyond the project's 5 %")
      const reconciled = await answered(await act(load.id, "reconcile", { note: "Settled with the plant" }), OutboundLoad)
      assert.equal(reconciled.status, "reconciled")
      assert.equal((await act(load.id, "reconcile")).status, 200, "already reconciled")
      assert.equal(await refused(await act(load.id, "dispute", { note: "Again" }), 409), loadDoesNotChange("reconciled"))
      const costed = await answered(await olivia(`/outbound-loads/${load.id}`, { method: "PATCH", body: { disposalCostMinor: 920_000 } }), OutboundLoad)
      assert.equal(costed.disposalCostMinor, 920_000)
    })

    test("is cancelled before it is received, saying why, and then does not change", async () => {
      const transfer = await station({ transfer: true })
      const load = await send(transfer.id)
      const cancelled = await answered(await act(load.id, "cancel", { note: "Never left" }), OutboundLoad)
      assert.deepEqual([cancelled.status, cancelled.note], ["cancelled", "Never left"])
      assert.equal(await refused(await act(load.id, "receive", receipt(20_000)), 409), loadDoesNotChange("cancelled"))
      assert.equal((await olivia(`/outbound-loads/${load.id}`, { method: "PATCH", body: { haulCostMinor: 1 } })).status, 409)
    })

    test("is absent to another company, and the role without the weights grant reads none", async () => {
      const transfer = await station({ transfer: true })
      const load = await send(transfer.id)
      assert.equal((await other(`/outbound-loads/${load.id}`)).status, 404)
      assert.equal((await other(`/unloading-stations/${transfer.id}/stock`)).status, 404)
      assert.equal((await viewer("/outbound-loads")).status, 403)
      assert.equal((await viewer(`/unloading-stations/${transfer.id}/stock`)).status, 403)
    })
  })
})
