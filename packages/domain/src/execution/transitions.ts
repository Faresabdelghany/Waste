// The two state machines of Execution (Issue #104, ADR-0002 and ADR-0004),
// as pure functions over the vocabulary's tokens with their sentences: what
// a dated Route does under dispatch, start, end and cancel, and what a Pickup
// does under the driver's three outcomes and the dispatcher's correction.
// The API reads a row, asks here, and either writes the next status or
// answers the sentence as its 409; the driver app runs the same functions
// over its local rows, so the device refuses what the server would refuse and
// the two agree by construction (#104 §3, "Up").
//
// A transition answers one of three things. `move` is the next status;
// `stay` is a command already done — dispatching a ready route, cancelling a
// cancelled one — which the API answers 200 without a write, the rule
// `confirm` set for allocations (#101); `refuse` carries the sentence, and
// nothing else, since a route or a pickup is named in every sentence and the
// caller has nothing to add. The sentences are spelled once here and read by
// the office routes, the driver door and the device alike: "Route RC-1042 is
// completed and does not change", "Route RC-1042 is not dispatched; a driver
// starts a ready route", "Pickup 12 is already completed". A route is named
// by its label (`RC-1042`, the contracts' `routeLabel`) and a pickup by its
// position, as a person reads them.
//
// The route machine: `planned → ready` by dispatch, `ready → active` by
// start, `active → completed` by end, and `planned`, `ready` or `active →
// cancelled` by cancel; `completed` and `cancelled` are terminal and do not
// change. The pickup machine: `planned → completed | skipped | failed` by the
// driver's complete, skip and fail, and a first outcome stands — a second
// completion is a refusal Resolution reads (#104 §7.9), never a silent
// overwrite. `openPickupsClose` is the other way a pickup leaves `planned`:
// a route's end or cancellation closes every open pickup as `skipped` with
// the reason saying which. `pickupCorrection` is the dispatcher's audited
// change: a pickup with an outcome may be moved to another, a `planned` one
// has nothing to correct. `nextPickup` is the reading the prototype called
// `Next`: the first `planned` pickup by position.
import { CLOSING_REASONS, type ClosingReason, type PickupStatus, type RouteStatus } from "./vocabulary"

/** What a machine answers: the next status, nothing to do, or a refusal with its sentence. */
export type Transition<Status extends string> = { kind: "move"; to: Status } | { kind: "stay" } | { kind: "refuse"; sentence: string }

/** What moves a route: the dispatcher's dispatch and cancel, the driver's start and end. */
export const ROUTE_COMMANDS = ["dispatch", "start", "end", "cancel"] as const
export type RouteCommand = (typeof ROUTE_COMMANDS)[number]

/** A route in a terminal status, asked to change: "Route RC-1042 is completed and does not change". */
export const doesNotChange = (label: string, status: "completed" | "cancelled"): string => `Route ${label} is ${status} and does not change`
/** A driver starting a route nobody dispatched. */
export const notDispatched = (label: string): string => `Route ${label} is not dispatched; a driver starts a ready route`
/** A start or a dispatch of a route already running. */
export const alreadyActive = (label: string): string => `Route ${label} is already active`
/** A driver's command, or the route's end, on a route that is not running. */
export const notActive = (label: string): string => `Route ${label} is not active`
/** The office capturing an unload on a route that never ran. */
export const hasNotRun = (label: string): string => `Route ${label} has not run`
/** An office command refused because the route is running, with what that means for it: "Route RC-1042 is active; its order is frozen". */
export const activeAnd = (label: string, consequence: string): string => `Route ${label} is active; ${consequence}`

/** The one place the route machine is spelled: status by status, what each command does. */
export function routeTransition(status: RouteStatus, command: RouteCommand, label: string): Transition<RouteStatus> {
  switch (status) {
    case "planned":
      switch (command) {
        case "dispatch":
          return { kind: "move", to: "ready" }
        case "start":
          return { kind: "refuse", sentence: notDispatched(label) }
        case "end":
          return { kind: "refuse", sentence: notActive(label) }
        case "cancel":
          return { kind: "move", to: "cancelled" }
      }
    case "ready":
      switch (command) {
        case "dispatch":
          return { kind: "stay" }
        case "start":
          return { kind: "move", to: "active" }
        case "end":
          return { kind: "refuse", sentence: notActive(label) }
        case "cancel":
          return { kind: "move", to: "cancelled" }
      }
    case "active":
      switch (command) {
        case "dispatch":
        case "start":
          return { kind: "refuse", sentence: alreadyActive(label) }
        case "end":
          return { kind: "move", to: "completed" }
        case "cancel":
          return { kind: "move", to: "cancelled" }
      }
    case "completed":
      return { kind: "refuse", sentence: doesNotChange(label, "completed") }
    case "cancelled":
      return command === "cancel" ? { kind: "stay" } : { kind: "refuse", sentence: doesNotChange(label, "cancelled") }
  }
}

/** The driver's three ways of deciding a stop. */
export const PICKUP_COMMANDS = ["complete", "skip", "fail"] as const
export type PickupCommand = (typeof PICKUP_COMMANDS)[number]

/** A pickup's status once it has left `planned`. */
export type PickupOutcome = Exclude<PickupStatus, "planned">

/** The status each driver command moves a planned pickup to. */
export const PICKUP_OUTCOME_OF: Readonly<Record<PickupCommand, PickupOutcome>> = { complete: "completed", skip: "skipped", fail: "failed" }

/** A second outcome for a pickup that has one: the first stands. */
export const alreadyDecided = (position: number, status: PickupOutcome): string => `Pickup ${position} is already ${status}`
/** A correction of a pickup nobody has decided yet. */
export const nothingToCorrect = (position: number): string => `Pickup ${position} has no outcome to correct`

/** The pickup machine under the driver's commands: a planned pickup takes the outcome, any other keeps the one it has. */
export function pickupTransition(status: PickupStatus, command: PickupCommand, position: number): Transition<PickupStatus> {
  if (status === "planned") return { kind: "move", to: PICKUP_OUTCOME_OF[command] }
  return { kind: "refuse", sentence: alreadyDecided(position, status) }
}

/** The dispatcher's audited correction: a decided pickup moves to the outcome given, the same one included, since a correction may change the reason alone; a planned one has nothing to correct. */
export function pickupCorrection(status: PickupStatus, outcome: PickupOutcome, position: number): Transition<PickupStatus> {
  if (status === "planned") return { kind: "refuse", sentence: nothingToCorrect(position) }
  return { kind: "move", to: outcome }
}

/** What a route's end or cancellation does to its open pickups: skipped, with the reason saying which. */
export type PickupClosing = { status: "skipped"; reason: ClosingReason }

/** The reason a route's end or cancellation writes on the pickups it closes. */
export const closingReasonOf = (command: "end" | "cancel"): ClosingReason => (command === "end" ? CLOSING_REASONS[0] : CLOSING_REASONS[1])

/**
 * The rule that a route's end or cancellation closes its `planned` pickups
 * as `skipped` with that reason: the pickups it closes — the planned ones, in
 * the order given — and the one outcome they all take. A pickup with an
 * outcome already is left as it is.
 */
export function openPickupsClose<Pickup extends { status: PickupStatus }>(pickups: readonly Pickup[], reason: ClosingReason): { pickups: Pickup[]; outcome: PickupClosing } {
  return { pickups: pickups.filter((pickup) => pickup.status === "planned"), outcome: { status: "skipped", reason } }
}

/** The reading the prototype called `Next`: the first planned pickup by position, or undefined when every stop is decided. */
export function nextPickup<Pickup extends { status: PickupStatus; position: number }>(pickups: readonly Pickup[]): Pickup | undefined {
  let next: Pickup | undefined
  for (const pickup of pickups) {
    if (pickup.status !== "planned") continue
    if (next === undefined || pickup.position < next.position) next = pickup
  }
  return next
}
