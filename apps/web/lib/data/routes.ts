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
//
// Since #111 the office makes routes and stops of its own: New route is the
// module's create — an ad-hoc route on a project's day with what is known of
// its crew and its ends — and Add stop a route's command, a container or an
// address of the route's project with the fraction collected there.
import { PICKUP_OUTCOMES, PICKUP_REASONS } from "@waste/domain/execution/vocabulary"

import { statusLabel } from "../api/records/adapter"
import { CONTAINERS_MODULE } from "../api/records/containers"
import { DRIVER_REASON_LABELS } from "../driver/route-view"
import { DEPOTS_MODULE, DRIVERS_MODULE, VEHICLES_MODULE } from "./allocations"
import type { BusinessRecord } from "./business-modules"
import type { BusinessFormField, BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import { mintedRecord, ORGANISATION_MODULE } from "./containers"
import { MASTER_DATA_MODULE } from "./master-data"
import { PROPERTIES_MODULE, SHARED_POINTS_MODULE } from "./properties"

/** The route's commands that take a dialog. */
export type RouteCommandWithForm = "assign" | "reschedule" | "cancel" | "add-stop"
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

/** What an added stop collects at (#111): a container, or an address — a property or a shared collection point — with its fraction. */
export const STOP_AT_CONTAINER = "container"
export const STOP_AT_PROPERTY = "property"
export const STOP_AT_POINT = "shared-point"
const STOP_AT_OPTIONS = [
  { value: STOP_AT_CONTAINER, label: "A container" },
  { value: STOP_AT_PROPERTY, label: "A property" },
  { value: STOP_AT_POINT, label: "A shared collection point" },
]
const AT_A_CONTAINER = { fieldId: "stopAt", equals: STOP_AT_CONTAINER } as const
const AT_A_PROPERTY = { fieldId: "stopAt", equals: STOP_AT_PROPERTY } as const
const AT_A_POINT = { fieldId: "stopAt", equals: STOP_AT_POINT } as const
const AT_AN_ADDRESS = { fieldId: "stopAt", oneOf: [STOP_AT_PROPERTY, STOP_AT_POINT] } as const
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
  "add-stop": routeForm(
    "Add stop",
    "A stop the office adds after the route's last one, on a route that has not started. A container is collected where it is placed on the route's service date; an address is collected with the fraction you name. Generation never moves or skips it.",
    "Add stop",
    [
      { id: "stopAt", label: "Collect", type: "select", required: true, defaultValue: STOP_AT_CONTAINER, options: STOP_AT_OPTIONS },
      { id: "containerId", label: "Container", type: "select", relation: CONTAINERS_MODULE, visibleWhen: AT_A_CONTAINER, requiredWhen: AT_A_CONTAINER, description: "Its place and fraction are its placement's on the route's service date." },
      { id: "propertyId", label: "Property", type: "select", relation: PROPERTIES_MODULE, visibleWhen: AT_A_PROPERTY, requiredWhen: AT_A_PROPERTY },
      { id: "sharedCollectionPointId", label: "Shared collection point", type: "select", relation: SHARED_POINTS_MODULE, visibleWhen: AT_A_POINT, requiredWhen: AT_A_POINT },
      { id: "wasteFractionId", label: "Waste fraction", type: "select", relation: MASTER_DATA_MODULE, visibleWhen: AT_AN_ADDRESS, requiredWhen: AT_AN_ADDRESS },
      { id: "note", label: "Note for the driver", type: "textarea" },
    ],
  ),
}

/** What New route makes (#111): an ad-hoc route, the office's own, on one of the caller's projects. Every field id is a key the routes adapter's `toCreateBody` reads. */
export const ROUTE_CREATE_FORM: BusinessFormSchema = {
  key: "route-studio.routes",
  mode: "create",
  recordKind: "Route",
  title: "New route",
  description: "An ad-hoc route the office makes, with no route scheme: it runs on the day you pick, is planned until it is dispatched, and its stops are the ones you add. No generation run changes it.",
  submitLabel: "Create route",
  contextFieldIds: ["projectId", "operatingDate"],
  sections: [
    {
      id: "route",
      title: "Route",
      fields: [
        { id: "projectId", label: "Project", type: "select", required: true, relation: ORGANISATION_MODULE },
        { id: "operatingDate", label: "Operating date", type: "date", required: true, description: "The day it runs, and its service date." },
        { id: "depotId", label: "Depot", type: "select", relation: DEPOTS_MODULE },
        { id: "unloadingStationId", label: "Unloading station", type: "select", relation: DEPOTS_MODULE },
        { id: "vehicleId", label: "Vehicle", type: "select", relation: VEHICLES_MODULE },
        { id: "driverId", label: "Driver", type: "select", relation: DRIVERS_MODULE, description: "A route is dispatched to its planned driver." },
        { id: "note", label: "Note", type: "textarea" },
      ],
    },
  ],
  execution: { kind: "create-record", completionMessage: "The route was created." },
}

/**
 * A route New route has just made, before the API has answered: the generic
 * create path's id and the form's kind, which the routes adapter owns it by.
 * The id is the module's and the kind's, never the workspace's: a
 * `route-studio-…` id would read as a route's `route-<uuid>` handle.
 */
export function createRouteRecord(values: BusinessFormValues, { now }: { now: number }): BusinessRecord {
  const day = typeof values.operatingDate === "string" ? values.operatingDate : ""
  return mintedRecord({ id: `routes-route-${now}`, name: day === "" ? "New route" : `Route on ${day}`, status: "Planned", recordKind: "Route", values })
}

const MISSED = { fieldId: "outcome", oneOf: ["skipped", "failed"] } as const
/** A stop's reason in the Driver App's words ("Over capacity" for `capacity`, lib/driver/route-view.ts); the system's four as any token is spelled. */
export const pickupReasonLabel = (reason: string) => (DRIVER_REASON_LABELS as Readonly<Record<string, string>>)[reason] ?? statusLabel(reason)

/** Each stop command's dialog. */
export const PICKUP_COMMAND_FORMS: Readonly<Record<PickupCommandWithForm, BusinessFormSchema>> = {
  remove: pickupForm("Remove stop", "The stop comes off a route that has not started: skipped, removed by the dispatcher, never deleted.", "Remove stop", [
    { id: "reason", label: "Reason", type: "textarea", required: true },
  ]),
  correct: pickupForm("Correct outcome", "The audited correction after the fact: the stop's outcome moves and a correction proof is appended.", "Correct outcome", [
    { id: "outcome", label: "Outcome", type: "select", required: true, options: PICKUP_OUTCOMES.map((value) => ({ value, label: statusLabel(value) })) },
    { id: "reason", label: "Reason", type: "select", options: PICKUP_REASONS.map((value) => ({ value, label: pickupReasonLabel(value) })), visibleWhen: MISSED, requiredWhen: MISSED },
    { id: "note", label: "Why it is corrected", type: "textarea", required: true },
  ]),
}

/** What the route's dialogs open on: the fields of its assign and reschedule forms as the route holds them — its Planned Assignment by web id, the day it runs and its planned start. A cancel and an added stop open empty. */
export function routeCommandValues(record: BusinessRecord): BusinessFormValues {
  const fieldIds = new Set([ROUTE_COMMAND_FORMS.assign, ROUTE_COMMAND_FORMS.reschedule].flatMap((form) => form.sections.flatMap((section) => section.fields.map((field) => field.id))))
  return Object.fromEntries(Object.entries(record.submittedValues ?? {}).filter(([key, value]) => fieldIds.has(key) && typeof value === "string"))
}
