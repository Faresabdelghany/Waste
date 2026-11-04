// A vehicle's maintenance on the Pilot (O20 of #290): the reads by vehicle, the
// most due plan and the open order first; the five actions' requests through
// the real client, which the vehicle's adapter offers beside its defects, each
// body one the contracts take; the local refusals in the domain's words; and
// the lines a plan and an order read as.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { MaintenanceOrder, MaintenanceOrderComplete, MaintenanceOrderCreate, MaintenancePlan, MaintenancePlanCreate, NAME_THE_ORDER as CONTRACTS_NAME_THE_ORDER } from "@waste/contracts/maintenance"
import { AN_INTERVAL, KM_NEEDS_A_READING } from "@waste/domain/resources/maintenance"

import type { BusinessRecord } from "../../data/business-modules"
import { orderFormOf } from "../../data/maintenance"
import type { MappingContext } from "../records/adapter"
import { vehicleAdapter } from "../records/fleet"
import {
  ADD_PLAN,
  CANCEL_ORDER,
  COMPLETE_ORDER,
  NAME_THE_ORDER,
  OPEN_ORDER,
  orderLine,
  planLine,
  RETIRE_PLAN,
  VEHICLE_MAINTENANCE_ACTIONS,
  vehicleOrders,
  vehiclePlans,
} from "../records/maintenance"
import { bodyOf, clientOver, json, scripted } from "./scripted-fetch"

const nr12 = { id: "vehicle-01a0d2a4-a280-7042-8000-000000000020", name: "NR-12 · CK 74 305" } as BusinessRecord
const context = {} as MappingContext
const vehicleId = "01a0d2a4-a280-7042-8000-000000000020"
const projectId = "01a0d2a4-a280-7042-8000-000000000001"
const stamps = { createdAt: "2026-10-05T06:20:00.000Z", updatedAt: "2026-10-05T06:20:00.000Z" }

const plan = (id: string, name: string, state: "ok" | "due-soon" | "overdue", over: Partial<MaintenancePlan> = {}): MaintenancePlan =>
  MaintenancePlan.parse({
    id,
    ...stamps,
    projectId,
    vehicleId,
    name,
    intervalDays: 365,
    intervalKm: null,
    intervalHours: null,
    lastDoneOn: "2025-10-12",
    lastDoneKm: null,
    lastDoneHours: null,
    status: "active",
    due: { state, nextDueOn: "2026-10-12", nextDueKm: null, nextDueHours: null, odometerKm: null, engineHours: null },
    ...over,
  })
const order = (id: string, status: "open" | "completed" | "cancelled", over: Partial<MaintenanceOrder> = {}): MaintenanceOrder =>
  MaintenanceOrder.parse({ id, ...stamps, projectId, vehicleId, planId: null, title: "Oil change", status, dueOn: null, note: null, completedOn: null, odometerKm: null, engineHours: null, closingNote: null, closedAt: null, ...over })

describe("the reads", () => {
  test("ask by vehicle: the active plans by how due they are and the retired ones last; the open orders first, each kind newest first", async () => {
    const ok = plan("01a0d2a4-a280-7042-8000-000000000061", "Annual service", "ok")
    const overdue = plan("01a0d2a4-a280-7042-8000-000000000062", "Brake inspection", "overdue")
    const retired = plan("01a0d2a4-a280-7042-8000-000000000063", "Axle check", "overdue", { status: "retired" })
    const soon = plan("01a0d2a4-a280-7042-8000-000000000064", "Tachograph", "due-soon")
    const older = order("01a0d2a4-a280-7042-8000-000000000071", "open")
    const done = order("01a0d2a4-a280-7042-8000-000000000072", "completed", { completedOn: "2026-10-01" })
    const newer = order("01a0d2a4-a280-7042-8000-000000000073", "open")
    const { fetch, calls } = scripted([() => json({ items: [retired, ok, overdue, soon], nextCursor: null }), () => json({ items: [older, done, newer], nextCursor: null })])
    const client = clientOver(fetch)
    assert.deepEqual(
      (await vehiclePlans(client, vehicleId)).map((row) => row.name),
      ["Brake inspection", "Tachograph", "Annual service", "Axle check"],
    )
    assert.equal(calls[0].url, `http://api.test/maintenance-plans?limit=200&vehicleId=${vehicleId}`)
    assert.deepEqual(
      (await vehicleOrders(client, vehicleId)).map((row) => row.id),
      [newer.id, older.id, done.id],
    )
    assert.equal(calls[1].url, `http://api.test/maintenance-orders?limit=200&vehicleId=${vehicleId}`)
  })
})

describe("the actions", () => {
  const action = (name: string) => VEHICLE_MAINTENANCE_ACTIONS[name]

  test("are the vehicle's, beside its defects", () => {
    for (const name of [ADD_PLAN, RETIRE_PLAN, OPEN_ORDER, COMPLETE_ORDER, CANCEL_ORDER]) assert.ok(vehicleAdapter.actions?.[name] !== undefined, name)
  })

  test("a plan's create posts the intervals and the baseline given, under the vehicle, and is refused locally in the domain's words", async () => {
    const body = action(ADD_PLAN).toBody?.({ name: " Brake inspection ", intervalDays: "", intervalKm: "20000", intervalHours: " ", lastDoneOn: "2026-06-01", lastDoneKm: "170000", lastDoneHours: "" }, nr12, context)
    const { fetch, calls } = scripted([() => json(plan("01a0d2a4-a280-7042-8000-000000000065", "Brake inspection", "ok"), 201, { location: "/maintenance-plans/01a0d2a4-a280-7042-8000-000000000065" })])
    await action(ADD_PLAN).run(clientOver(fetch), vehicleId, body)
    assert.equal(calls[0].url, "http://api.test/maintenance-plans")
    assert.deepEqual(bodyOf(calls[0]), { name: "Brake inspection", lastDoneOn: "2026-06-01", intervalKm: 20_000, lastDoneKm: 170_000, vehicleId })
    assert.ok(MaintenancePlanCreate.safeParse(bodyOf(calls[0])).success)
    assert.deepEqual(action(ADD_PLAN).toBody?.({ name: "Nothing", lastDoneOn: "2026-06-01" }, nr12, context), { path: "intervalDays", message: AN_INTERVAL })
    assert.deepEqual(action(ADD_PLAN).toBody?.({ name: "Tyres", intervalKm: "40000", lastDoneOn: "2026-06-01" }, nr12, context), { path: "lastDoneKm", message: KM_NEEDS_A_READING })
    assert.deepEqual(action(ADD_PLAN).toBody?.({ name: "Tyres", intervalKm: "4.5", lastDoneOn: "2026-06-01" }, nr12, context), { path: "intervalKm", message: "Give a whole number above zero" })
    assert.equal(action(ADD_PLAN).refused(nr12), "The maintenance plan of NR-12 · CK 74 305 was not added")
  })

  test("retiring patches the plan's status alone", async () => {
    const target = plan("01a0d2a4-a280-7042-8000-000000000066", "Annual service", "ok")
    const { fetch, calls } = scripted([() => json({ ...target, status: "retired" })])
    await action(RETIRE_PLAN).run(clientOver(fetch), vehicleId, action(RETIRE_PLAN).toBody?.({ planId: target.id }, nr12, context))
    assert.equal(calls[0].url, `http://api.test/maintenance-plans/${target.id}`)
    assert.equal(calls[0].init.method, "PATCH")
    assert.deepEqual(bodyOf(calls[0]), { status: "retired" })
  })

  test("an order opens of a plan or with a title, under the vehicle; one with neither is told so in the contracts' words", async () => {
    assert.equal(NAME_THE_ORDER, CONTRACTS_NAME_THE_ORDER)
    const planId = "01a0d2a4-a280-7042-8000-000000000067"
    const body = action(OPEN_ORDER).toBody?.({ planId, title: "", dueOn: "2026-10-07", note: "" }, nr12, context)
    const { fetch, calls } = scripted([() => json(order("01a0d2a4-a280-7042-8000-000000000074", "open", { planId }), 201, { location: "/maintenance-orders/01a0d2a4-a280-7042-8000-000000000074" })])
    await action(OPEN_ORDER).run(clientOver(fetch), vehicleId, body)
    assert.deepEqual(bodyOf(calls[0]), { planId, dueOn: "2026-10-07", vehicleId })
    assert.ok(MaintenanceOrderCreate.safeParse(bodyOf(calls[0])).success)
    assert.deepEqual(action(OPEN_ORDER).toBody?.({ planId: "", title: " " }, nr12, context), { path: "title", message: NAME_THE_ORDER })
  })

  test("complete and cancel post to the order, with the readings and the note given", async () => {
    const orderId = "01a0d2a4-a280-7042-8000-000000000075"
    const { fetch, calls } = scripted([() => json(order(orderId, "completed", { completedOn: "2026-10-05" })), () => json(order(orderId, "cancelled"))])
    const client = clientOver(fetch)
    await action(COMPLETE_ORDER).run(client, vehicleId, action(COMPLETE_ORDER).toBody?.({ orderId, completedOn: "2026-10-05", odometerKm: "93000", engineHours: "", note: "Oil and filter" }, nr12, context))
    assert.equal(calls[0].url, `http://api.test/maintenance-orders/${orderId}/complete`)
    assert.deepEqual(bodyOf(calls[0]), { completedOn: "2026-10-05", odometerKm: 93_000, note: "Oil and filter" })
    assert.ok(MaintenanceOrderComplete.safeParse(bodyOf(calls[0])).success)
    await action(CANCEL_ORDER).run(client, vehicleId, action(CANCEL_ORDER).toBody?.({ orderId, note: "" }, nr12, context))
    assert.equal(calls[1].url, `http://api.test/maintenance-orders/${orderId}/cancel`)
    assert.deepEqual(bodyOf(calls[1]), {})
    assert.deepEqual(action(COMPLETE_ORDER).toBody?.({ orderId, completedOn: "" }, nr12, context), { path: "completedOn", message: "Give the day the service was done" })
  })
})

describe("the lines and the open form", () => {
  test("a plan reads its intervals and its next limits; an order its title, when, the readings and what was done", () => {
    assert.equal(planLine({ name: "Brake inspection", intervalDays: null, intervalKm: 20_000, intervalHours: 1_000, due: { state: "due-soon", nextDueOn: null, nextDueKm: 190_000, nextDueHours: 6_500, odometerKm: 189_200, engineHours: 6_120 } }), "Brake inspection · every 20,000 km · 1,000 h · next 190,000 km · 6,500 h")
    assert.equal(orderLine({ title: "Oil change", status: "open", dueOn: "2026-10-07", completedOn: null, odometerKm: null, engineHours: null, closingNote: null }), "Oil change · due 2026-10-07")
    assert.equal(orderLine({ title: "Oil change", status: "completed", dueOn: null, completedOn: "2026-10-05", odometerKm: 93_000, engineHours: null, closingNote: "Oil and filter" }), "Oil change · completed 2026-10-05 · 93,000 km · Oil and filter")
    assert.equal(orderLine({ title: "Tail light", status: "cancelled", dueOn: null, completedOn: null, odometerKm: null, engineHours: null, closingNote: "Done under warranty" }), "Tail light · cancelled · Done under warranty")
  })

  test("the open form offers the active plans alone", () => {
    const form = orderFormOf([
      { id: "a", name: "Annual service", status: "active" },
      { id: "b", name: "Axle check", status: "retired" },
    ])
    const planField = form.sections[0].fields.find((field) => field.id === "planId")
    assert.deepEqual(planField?.options, [{ value: "a", label: "Annual service" }])
  })
})
