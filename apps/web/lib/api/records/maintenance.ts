// A vehicle's maintenance on the Pilot (O20 of #290): its maintenance plans,
// each with where it stands, and the Maintenance Orders that do them, read
// and worked from the vehicle's details in Fleet. Like its defects
// (pre-trip.ts), they are not rows of the store — nothing lists them but their
// vehicle — so they are read through the client beside the row
// (`useRowHistory`), and written as the row's actions, which answer the plan
// or the order, never the row. The wire shapes are the contracts'
// (`@waste/contracts/maintenance`), imported as types.
//
// A plan is retired, never deleted. Completing an order of a plan is the
// service done, which moves the plan's last service on the API; the worker's
// `maintenance-due` rule clears its alert on its next tick.
import type { MaintenanceDueState, MaintenanceOrder, MaintenancePlan } from "@waste/contracts/maintenance"
import { nextDueLine, planIssue } from "@waste/domain/resources/maintenance"
import { isIsoDate } from "@waste/domain/route-schemes/recurrence"

import { command, create, listAll, patch } from "../client"
import { said, type Client, type CommandInput, type LocalRefusal, type RecordAction } from "./adapter"
import { refusal } from "./places"
import type { ActionOutcome, SendAction } from "./server-records"

/** The module whose rows the plans and orders belong to; spelled here, since fleet.ts imports this module. */
const VEHICLES = { workspaceId: "fleet", moduleId: "vehicles" } as const

export const ADD_PLAN = "add-maintenance-plan"
export const RETIRE_PLAN = "retire-maintenance-plan"
export const OPEN_ORDER = "open-maintenance-order"
export const COMPLETE_ORDER = "complete-maintenance-order"
export const CANCEL_ORDER = "cancel-maintenance-order"

/** The worst first: overdue, due soon, then the rest, each by name; retired plans last. */
const DUE_ORDER: Readonly<Record<MaintenanceDueState, number>> = { overdue: 0, "due-soon": 1, ok: 2 }

/** A vehicle's plans, the active ones by how due they are, then the retired ones. */
export function vehiclePlans(client: Client, serverId: string): Promise<MaintenancePlan[]> {
  return listAll<MaintenancePlan>(client, "/maintenance-plans", { vehicleId: serverId }).then(plansInOrder)
}

export const plansInOrder = (plans: MaintenancePlan[]): MaintenancePlan[] =>
  [...plans].sort((a, b) => (a.status === b.status ? DUE_ORDER[a.due.state] - DUE_ORDER[b.due.state] || a.name.localeCompare(b.name) : a.status === "active" ? -1 : 1))

/** A vehicle's orders, the open ones first, and within each the newest first. */
export function vehicleOrders(client: Client, serverId: string): Promise<MaintenanceOrder[]> {
  return listAll<MaintenanceOrder>(client, "/maintenance-orders", { vehicleId: serverId }).then(ordersInOrder)
}

export const ordersInOrder = (orders: MaintenanceOrder[]): MaintenanceOrder[] => [...orders].sort((a, b) => (a.status === "open") === (b.status === "open") ? b.id.localeCompare(a.id) : a.status === "open" ? -1 : 1)

/** A whole reading or interval as typed, undefined when blank, or a refusal at the field. */
function whole(input: CommandInput, key: string, positive: boolean): number | undefined | LocalRefusal {
  const typed = said(input, key)
  if (typed === undefined) return undefined
  const value = Number(typed)
  return Number.isInteger(value) && value >= (positive ? 1 : 0) ? value : refusal(key, positive ? "Give a whole number above zero" : "Give a whole number, zero or more")
}

const isRefusal = (value: unknown): value is LocalRefusal => typeof value === "object" && value !== null

/** What the add form hands the action, as typed. */
export type PlanInput = { name: string; intervalDays: string; intervalKm: string; intervalHours: string; lastDoneOn: string; lastDoneKm: string; lastDoneHours: string }

/** The body of a plan's create, held to the domain's rule in its words, or a refusal naming the field. */
export function planBody(input: CommandInput): Record<string, string | number> | LocalRefusal {
  const name = said(input, "name")
  if (name === undefined) return refusal("name", "Say what the service is")
  const lastDoneOn = said(input, "lastDoneOn")
  if (lastDoneOn === undefined || !isIsoDate(lastDoneOn)) return refusal("lastDoneOn", "Give the day the service was last done")
  const numbers: Record<string, number | null> = {}
  for (const [key, positive] of [["intervalDays", true], ["intervalKm", true], ["intervalHours", true], ["lastDoneKm", false], ["lastDoneHours", false]] as const) {
    const value = whole(input, key, positive)
    if (isRefusal(value)) return value
    numbers[key] = value ?? null
  }
  const issue = planIssue({ intervalDays: numbers.intervalDays, intervalKm: numbers.intervalKm, intervalHours: numbers.intervalHours, lastDoneKm: numbers.lastDoneKm, lastDoneHours: numbers.lastDoneHours })
  if (issue !== undefined) return refusal(issue.path, issue.message)
  const given = Object.fromEntries(Object.entries(numbers).filter((entry): entry is [string, number] => entry[1] !== null))
  return { name, lastDoneOn, ...given }
}

/** What the open form hands the action: the plan's server id or none, a title, the day it is planned for, and a note. */
export type OrderInput = { planId: string; title: string; dueOn: string; note: string }

/** What an order of no plan without a title is told; the contracts' `NAME_THE_ORDER`, spelled again, since the web imports them as types. */
export const NAME_THE_ORDER = "Say what the order is for, or name the plan it serves"

export function orderBody(input: CommandInput): Record<string, string> | LocalRefusal {
  const planId = said(input, "planId")
  const title = said(input, "title")
  if (planId === undefined && title === undefined) return refusal("title", NAME_THE_ORDER)
  const dueOn = said(input, "dueOn")
  if (dueOn !== undefined && !isIsoDate(dueOn)) return refusal("dueOn", "Give the day it is planned for as a date")
  const note = said(input, "note")
  return { ...(planId === undefined ? {} : { planId }), ...(title === undefined ? {} : { title }), ...(dueOn === undefined ? {} : { dueOn }), ...(note === undefined ? {} : { note }) }
}

/** What the complete form hands the action: the order, the day, the readings then and what was done. */
export type CompleteInput = { orderId: string; completedOn: string; odometerKm: string; engineHours: string; note: string }

export function completeBody(input: CommandInput): { orderId: string; body: Record<string, string | number> } | LocalRefusal {
  const orderId = said(input, "orderId")
  if (orderId === undefined) return refusal("orderId", "Name the order to complete")
  const completedOn = said(input, "completedOn")
  if (completedOn === undefined || !isIsoDate(completedOn)) return refusal("completedOn", "Give the day the service was done")
  const odometerKm = whole(input, "odometerKm", false)
  if (isRefusal(odometerKm)) return odometerKm
  const engineHours = whole(input, "engineHours", false)
  if (isRefusal(engineHours)) return engineHours
  const note = said(input, "note")
  return { orderId, body: { completedOn, ...(odometerKm === undefined ? {} : { odometerKm }), ...(engineHours === undefined ? {} : { engineHours }), ...(note === undefined ? {} : { note }) } }
}

function cancelBody(input: CommandInput): { orderId: string; body: { note?: string } } | LocalRefusal {
  const orderId = said(input, "orderId")
  if (orderId === undefined) return refusal("orderId", "Name the order to cancel")
  const note = said(input, "note")
  return { orderId, body: note === undefined ? {} : { note } }
}

function retireBody(input: CommandInput): { planId: string } | LocalRefusal {
  const planId = said(input, "planId")
  return planId === undefined ? refusal("planId", "Name the plan to retire") : { planId }
}

type Addressed = { orderId: string; body: object }

/** A vehicle's five maintenance actions: add a plan and retire one, which answer the plan; open, complete and cancel an order, which answer the order. */
export const VEHICLE_MAINTENANCE_ACTIONS: Readonly<Record<string, RecordAction<unknown>>> = {
  [ADD_PLAN]: {
    toBody: planBody,
    run: (client, serverId, body) => create<MaintenancePlan>(client, "/maintenance-plans", { ...(body as object), vehicleId: serverId }).then((created) => created.body),
    refused: (record) => `The maintenance plan of ${record.name} was not added`,
  },
  [RETIRE_PLAN]: {
    toBody: retireBody,
    run: (client, _serverId, body) => patch<MaintenancePlan>(client, `/maintenance-plans/${(body as { planId: string }).planId}`, { status: "retired" }),
    refused: (record) => `The maintenance plan of ${record.name} was not retired`,
  },
  [OPEN_ORDER]: {
    toBody: orderBody,
    run: (client, serverId, body) => create<MaintenanceOrder>(client, "/maintenance-orders", { ...(body as object), vehicleId: serverId }).then((created) => created.body),
    refused: (record) => `The maintenance order of ${record.name} was not opened`,
  },
  [COMPLETE_ORDER]: {
    toBody: completeBody,
    run: (client, _serverId, body) => command<MaintenanceOrder>(client, `/maintenance-orders/${(body as Addressed).orderId}/complete`, (body as Addressed).body),
    refused: (record) => `The maintenance order of ${record.name} was not completed`,
  },
  [CANCEL_ORDER]: {
    toBody: cancelBody,
    run: (client, _serverId, body) => command<MaintenanceOrder>(client, `/maintenance-orders/${(body as Addressed).orderId}/cancel`, (body as Addressed).body),
    refused: (record) => `The maintenance order of ${record.name} was not cancelled`,
  },
}

const send = <T>(sendAction: SendAction, recordId: string, name: string, input: CommandInput) => sendAction(VEHICLES.workspaceId, VEHICLES.moduleId, recordId, name, input) as Promise<ActionOutcome<T>>

/** Adds a plan to a vehicle through the store's `sendAction`; the vehicle's row stays as it is. */
export const addMaintenancePlan = (sendAction: SendAction, recordId: string, input: PlanInput) => send<MaintenancePlan>(sendAction, recordId, ADD_PLAN, input)
/** Retires one of a vehicle's plans, by its server id. */
export const retireMaintenancePlan = (sendAction: SendAction, recordId: string, planId: string) => send<MaintenancePlan>(sendAction, recordId, RETIRE_PLAN, { planId })
/** Opens an order on a vehicle. */
export const openMaintenanceOrder = (sendAction: SendAction, recordId: string, input: OrderInput) => send<MaintenanceOrder>(sendAction, recordId, OPEN_ORDER, input)
/** Completes one of a vehicle's open orders. */
export const completeMaintenanceOrder = (sendAction: SendAction, recordId: string, input: CompleteInput) => send<MaintenanceOrder>(sendAction, recordId, COMPLETE_ORDER, input)
/** Cancels one of a vehicle's open orders, with why where the office says. */
export const cancelMaintenanceOrder = (sendAction: SendAction, recordId: string, orderId: string, note: string) => send<MaintenanceOrder>(sendAction, recordId, CANCEL_ORDER, { orderId, note })

/** How a plan's state reads. */
export const DUE_LABELS: Readonly<Record<MaintenanceDueState, string>> = { ok: "On track", "due-soon": "Due soon", overdue: "Overdue" }

const grouped = (value: number) => value.toLocaleString("en-GB")

/** A plan's intervals as they read: "every 365 days · 20,000 km". */
export function intervalsLine(plan: Pick<MaintenancePlan, "intervalDays" | "intervalKm" | "intervalHours">): string {
  const parts = [plan.intervalDays === null ? null : `${grouped(plan.intervalDays)} days`, plan.intervalKm === null ? null : `${grouped(plan.intervalKm)} km`, plan.intervalHours === null ? null : `${grouped(plan.intervalHours)} h`]
  return `every ${parts.filter((part) => part !== null).join(" · ")}`
}

/** A plan as its line reads: "Brake inspection · every 20,000 km · next 190,000 km". */
export function planLine(plan: Pick<MaintenancePlan, "name" | "intervalDays" | "intervalKm" | "intervalHours" | "due">): string {
  return `${plan.name} · ${intervalsLine(plan)} · next ${nextDueLine(plan.due)}`
}

const ORDER_STATUS_WORDS: Readonly<Record<MaintenanceOrder["status"], string>> = { open: "Open", completed: "Completed", cancelled: "Cancelled" }

/** An order as its line reads: "Oil change · due 2026-10-07", "Oil change · completed 2026-10-05 · 93,000 km · Oil and filter". */
export function orderLine(order: Pick<MaintenanceOrder, "title" | "status" | "dueOn" | "completedOn" | "odometerKm" | "engineHours" | "closingNote">): string {
  const when = order.status === "open" ? (order.dueOn === null ? null : `due ${order.dueOn}`) : order.status === "completed" ? `completed ${order.completedOn}` : ORDER_STATUS_WORDS.cancelled.toLowerCase()
  return [order.title, when, order.odometerKm === null ? null : `${grouped(order.odometerKm)} km`, order.engineHours === null ? null : `${grouped(order.engineHours)} h`, order.closingNote].filter((part) => part !== null && part !== "").join(" · ")
}
