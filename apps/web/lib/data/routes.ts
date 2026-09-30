/** The submitted value a route record carries the wire's `activePlan` under, as JSON; the routes adapter writes it, the map's legs layer reads it (#173, #179). */
export const ROUTE_ACTIVE_PLAN_KEY = "activePlan"

// The route's and the stop's dialogs on the Pilot (Issue #179, slice 6 of
// #81): what Route Studio › Routes and › Pickups offer once they read the
// API — the dispatcher's commands on a route (assign, reschedule, cancel;
// dispatch and the stop order need no form) and on a stop (remove, correct
// its outcome) — for the command surfaces
// (components/waste/commands/route-surfaces.tsx) to render. Fixture mode
// keeps the registry's route forms and the route details page untouched.
//
// Every field id is a key the command's `toBody` reads (lib/api/records/
// routes.ts, pickups.ts); lib/data/__tests__/route-forms.test.ts holds the two
// together through the adapters. The pickers name rows by web id: the
// vehicle, the trailer and the driver (fleet), the depot and the unloading
// station (the places), and a dialog opens on what the route holds.
import { PICKUP_OUTCOMES, PICKUP_REASONS } from "@waste/domain/execution/vocabulary"

import { DEPOTS_MODULE, DRIVERS_MODULE, VEHICLES_MODULE } from "./allocations"
import type { BusinessRecord } from "./business-modules"
import type { BusinessFormField, BusinessFormSchema, BusinessFormValues } from "./business-form-types"

/** The route's commands that take a dialog. */
export type RouteCommandWithForm = "assign" | "reschedule" | "cancel"
/** The stop's commands, both with a dialog. */
export type PickupCommandWithForm = "remove" | "correct"

/** One command's dialog. */
const commandForm = (key: BusinessFormSchema["key"], recordKind: string, title: string, description: string, submitLabel: string, fields: readonly BusinessFormField[]): BusinessFormSchema => ({
  key,
  mode: "action",
  recordKind,
  title,
  description,
  submitLabel,
  sections: [{ id: "command", title, fields }],
  execution: { kind: "append-event", completionMessage: `${title} recorded.` },
})

const routeForm = (title: string, description: string, submitLabel: string, fields: readonly BusinessFormField[]) => commandForm("route-studio.routes", "Route", title, description, submitLabel, fields)
const pickupForm = (title: string, description: string, submitLabel: string, fields: readonly BusinessFormField[]) => commandForm("route-studio.pickups", "Pickup", title, description, submitLabel, fields)

/** Each route command's dialog, its fields the keys its `toBody` reads. */
export const ROUTE_COMMAND_FORMS: Readonly<Record<RouteCommandWithForm, BusinessFormSchema>> = {
  assign: routeForm("Assign", "The Planned Assignment: what is expected to run the route. Only what you change is sent; a cleared field is cleared.", "Assign", [
    { id: "vehicleId", label: "Vehicle", type: "select", relation: VEHICLES_MODULE },
    { id: "driverId", label: "Driver", type: "select", relation: DRIVERS_MODULE, description: "A route is dispatched to its planned driver." },
    { id: "trailerId", label: "Trailer", type: "select", relation: VEHICLES_MODULE },
    { id: "depotId", label: "Depot", type: "select", relation: DEPOTS_MODULE },
    { id: "unloadingStationId", label: "Unloading station", type: "select", relation: DEPOTS_MODULE },
  ]),
  reschedule: routeForm("Reschedule", "The day the route runs, or its planned start. Its service date, the day its scheme named, never moves.", "Reschedule", [
    { id: "operatingDate", label: "Operating date", type: "date", required: true },
    { id: "plannedStartTime", label: "Planned start", type: "time", description: "On the project's clock; blank clears it." },
  ]),
  cancel: routeForm("Cancel route", "The route will not run. Its open stops are skipped, an active route's session ends, and the reason becomes its deviation.", "Cancel route", [
    { id: "reason", label: "Reason", type: "textarea", required: true },
  ]),
}

const MISSED = { fieldId: "outcome", oneOf: ["skipped", "failed"] } as const
const OUTCOME_LABELS: Readonly<Record<(typeof PICKUP_OUTCOMES)[number], string>> = { completed: "Completed", skipped: "Skipped", failed: "Failed" }
const reasonLabel = (reason: string) => reason.charAt(0).toUpperCase() + reason.slice(1).replace(/-/g, " ")

/** Each stop command's dialog. */
export const PICKUP_COMMAND_FORMS: Readonly<Record<PickupCommandWithForm, BusinessFormSchema>> = {
  remove: pickupForm("Remove stop", "The stop comes off a route that has not started: skipped, removed by the dispatcher, never deleted.", "Remove stop", [
    { id: "reason", label: "Reason", type: "textarea", required: true },
  ]),
  correct: pickupForm("Correct outcome", "The audited correction after the fact: the stop's outcome moves and a correction proof is appended.", "Correct outcome", [
    { id: "outcome", label: "Outcome", type: "select", required: true, options: PICKUP_OUTCOMES.map((value) => ({ value, label: OUTCOME_LABELS[value] })) },
    { id: "reason", label: "Reason", type: "select", options: PICKUP_REASONS.map((value) => ({ value, label: reasonLabel(value) })), visibleWhen: MISSED, requiredWhen: MISSED },
    { id: "note", label: "Why it is corrected", type: "textarea", required: true },
  ]),
}

const valueOf = (record: BusinessRecord, key: string) => {
  const value = record.submittedValues?.[key]
  return typeof value === "string" ? value : ""
}

/** What the route's dialogs open on: its Planned Assignment by web id, the day it runs and its planned start. */
export function routeCommandValues(record: BusinessRecord): BusinessFormValues {
  return {
    vehicleId: valueOf(record, "vehicleId"),
    driverId: valueOf(record, "driverId"),
    trailerId: valueOf(record, "trailerId"),
    depotId: valueOf(record, "depotId"),
    unloadingStationId: valueOf(record, "unloadingStationId"),
    operatingDate: valueOf(record, "operatingDate"),
    plannedStartTime: valueOf(record, "plannedStartTime"),
  }
}
