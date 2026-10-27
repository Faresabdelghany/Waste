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
//
// Since O5 of #290: Assign names the service provider too; Reschedule asks
// whether a move onto a day the project rests on is meant (the API refuses
// one unasked, in the domain's sentence); Cancel takes one of the office's
// reason codes beside the free reason; and a day's routes, or a selection of
// them, are dispatched together (`dispatchDayRows`).
import { OFFICE_CANCEL_REASON_CODES, PICKUP_OUTCOMES, PICKUP_REASONS } from "@waste/domain/execution/vocabulary"

import { statusLabel } from "../api/records/adapter"
import { CONTAINERS_MODULE } from "../api/records/containers"
import { DRIVER_REASON_LABELS } from "../driver/route-view"
import { DEPOTS_MODULE, DRIVERS_MODULE, VEHICLES_MODULE } from "./allocations"
import type { BusinessRecord } from "./business-modules"
import type { BusinessFormField, BusinessFormOption, BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import { AGREEMENTS_MODULE } from "./agreements"
import { BULKY_BOOKINGS_MODULE } from "./bulky"
import { mintedRecord, ORGANISATION_MODULE, WAREHOUSES_MODULE } from "./containers"
import { MASTER_DATA_MODULE } from "./master-data"
import { OFFICE_STOP_SERVICE_OPTIONS } from "./pickup-services"
import { NO_ONE, PROPERTIES_MODULE, SHARED_POINTS_MODULE } from "./properties"
import { SERVICE_PROVIDERS_MODULE } from "./provider-money"

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
/** A Bulky Booking's collection (O11 of #290): at the booking's place, of its fraction, on a route of its day. */
export const STOP_AT_BULKY_BOOKING = "bulky-booking"
const STOP_AT_OPTIONS = [
  { value: STOP_AT_CONTAINER, label: "A container" },
  { value: STOP_AT_PROPERTY, label: "A property" },
  { value: STOP_AT_POINT, label: "A shared collection point" },
  { value: STOP_AT_BULKY_BOOKING, label: "A bulky booking" },
]
const AT_A_CONTAINER = { fieldId: "stopAt", equals: STOP_AT_CONTAINER } as const
const AT_A_PROPERTY = { fieldId: "stopAt", equals: STOP_AT_PROPERTY } as const
const AT_A_POINT = { fieldId: "stopAt", equals: STOP_AT_POINT } as const
const AT_AN_ADDRESS = { fieldId: "stopAt", oneOf: [STOP_AT_PROPERTY, STOP_AT_POINT] } as const
const AT_A_BOOKING = { fieldId: "stopAt", equals: STOP_AT_BULKY_BOOKING } as const
/** A bulky booking's stop is its booking's collection: no service to pick. */
const NOT_A_BOOKING = { fieldId: "stopAt", notIn: [STOP_AT_BULKY_BOOKING] } as const
/** What a ledger work order books beside its container (O3b of #290): a delivery its subscription, a swap its replacement, a removal and a swap the warehouse. */
const A_DELIVERY = { fieldId: "service", equals: "deliver" } as const
const A_SWAP = { fieldId: "service", equals: "swap" } as const
const BACK_TO_STOCK = { fieldId: "service", oneOf: ["remove", "swap"] } as const
const pickupForm = (title: string, description: string, submitLabel: string, fields: readonly BusinessFormField[]) => commandForm("route-studio.pickups", "Pickup", title, description, submitLabel, fields)

/** The office's cancel reason codes as a select offers them (O5 of #290): "Vehicle breakdown" for `vehicle-breakdown`. */
export const CANCEL_REASON_OPTIONS: readonly BusinessFormOption[] = OFFICE_CANCEL_REASON_CODES.map((value) => ({ value, label: statusLabel(value) }))

/** Each route command's dialog, its fields the keys its `toBody` reads. */
export const ROUTE_COMMAND_FORMS: Readonly<Record<RouteCommandWithForm, BusinessFormSchema>> = {
  assign: routeForm("Assign", "The Planned Assignment: what is expected to run the route. Only what you change is sent; a cleared field is cleared.", "Assign", [
    { id: "vehicleId", label: "Vehicle", type: "select", relation: VEHICLES_MODULE },
    { id: "driverId", label: "Driver", type: "select", relation: DRIVERS_MODULE, description: "A route is dispatched to its planned driver." },
    { id: "trailerId", label: "Trailer", type: "select", relation: VEHICLES_MODULE },
    { id: "serviceProviderId", label: "Service provider", type: "select", relation: SERVICE_PROVIDERS_MODULE, description: "The company that runs the route, where it is not your own." },
    { id: "depotId", label: "Depot", type: "select", relation: DEPOTS_MODULE },
    { id: "unloadingStationId", label: "Unloading station", type: "select", relation: DEPOTS_MODULE },
  ]),
  reschedule: routeForm("Reschedule", "The day the route runs, or its planned start. Its service date, the day its scheme named, never moves.", "Reschedule", [
    { id: "operatingDate", label: "Operating date", type: "date", required: true },
    { id: "plannedStartTime", label: "Planned start", type: "time", description: "On the project's clock; blank clears it." },
    {
      id: "acceptNonWorkingDay",
      label: "Run it on a non-working day",
      type: "checkbox",
      defaultValue: false,
      description: "A holiday on the project's calendar, or a weekend day its scheme does not serve, is taken only when you say so; without it such a move is refused with the day named.",
    },
  ]),
  cancel: routeForm("Cancel route", "The route will not run. Its open stops are skipped, an active route's session ends, and the reason becomes its deviation.", "Cancel route", [
    { id: "reasonCode", label: "Why", type: "select", required: true, options: CANCEL_REASON_OPTIONS },
    { id: "reason", label: "Reason", type: "textarea", required: true, description: "What happened, in your words: it becomes the route's note." },
  ]),
  "add-stop": routeForm(
    "Add stop",
    "A stop the office adds after the route's last one, on a route that has not started. A container is collected where it is placed on the route's service date, and may be one the route stops at already — an extra emptying, or a repair or a wash beside its collection; an address is collected with the fraction you name, and a bulky booking at its place on the day it was booked for. A delivery, a removal or a swap moves the container in its ledger when the driver completes the stop. Generation never moves or skips it.",
    "Add stop",
    [
      { id: "service", label: "Service", type: "select", defaultValue: "empty", options: OFFICE_STOP_SERVICE_OPTIONS, visibleWhen: NOT_A_BOOKING, requiredWhen: NOT_A_BOOKING, description: "Every work order is of a container." },
      { id: "stopAt", label: "Collect", type: "select", required: true, defaultValue: STOP_AT_CONTAINER, options: STOP_AT_OPTIONS },
      { id: "bulkyBookingId", label: "Bulky booking", type: "select", relation: BULKY_BOOKINGS_MODULE, visibleWhen: AT_A_BOOKING, requiredWhen: AT_A_BOOKING, description: "A booked booking of the route's project for the day it runs: its place, fraction, items and note are the stop's." },
      { id: "containerId", label: "Container", type: "select", relation: CONTAINERS_MODULE, visibleWhen: AT_A_CONTAINER, requiredWhen: AT_A_CONTAINER, description: "Its place and fraction are its placement's on the route's service date; a delivery's, its subscription's." },
      { id: "subscriptionId", label: "Subscription", type: "select", relation: AGREEMENTS_MODULE, visibleWhen: A_DELIVERY, requiredWhen: A_DELIVERY, description: "The subscription the container serves under once delivered, at the place it is delivered at." },
      { id: "deliveryFractionId", label: "Waste fraction", type: "select", relation: MASTER_DATA_MODULE, visibleWhen: A_DELIVERY, description: "Blank takes the subscription's product's." },
      { id: "replacementContainerId", label: "Replacement", type: "select", relation: CONTAINERS_MODULE, visibleWhen: A_SWAP, requiredWhen: A_SWAP, description: "The container from stock the driver brings in its place." },
      { id: "warehouseId", label: "Back to warehouse", type: "select", relation: WAREHOUSES_MODULE, visibleWhen: BACK_TO_STOCK, requiredWhen: BACK_TO_STOCK, description: "Where the container taken goes back into stock." },
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
    {
      id: "contaminantCodeId",
      label: "Contaminant code",
      type: "select",
      relation: MASTER_DATA_MODULE,
      description: "The wrong waste the stop is tagged with, with contamination or a collection made all the same. None untags it.",
    },
  ]),
}

/**
 * The codes a stop may be tagged with (M5 of #293), after None: the active
 * master data codes that apply to its fraction — a code for every fraction,
 * or one naming the stop's — and the stop's own code whatever has happened to
 * it since, since a stop keeps the code it was tagged with.
 */
export function contaminantCodeOptions(codes: readonly BusinessRecord[], stop: Pick<BusinessRecord, "submittedValues">): BusinessFormOption[] {
  const fraction = stop.submittedValues?.wasteFractionId
  const own = stop.submittedValues?.contaminantCodeId
  const offered = codes.filter((code) => {
    if (code.id === own) return true
    if (code.submittedValues?.status === "inactive") return false
    const fractions = String(code.submittedValues?.wasteFractionIds ?? "")
    return fractions === "" || fractions.split(",").includes(String(fraction))
  })
  return [{ value: NO_ONE, label: "None" }, ...offered.map((code) => ({ value: code.id, label: code.submittedValues?.status === "inactive" ? `${code.name} · Retired` : code.name }))]
}

/** What the route's dialogs open on: the fields of its assign and reschedule forms as the route holds them — its Planned Assignment by web id, the day it runs and its planned start. A cancel and an added stop open empty. */
export function routeCommandValues(record: BusinessRecord): BusinessFormValues {
  const fieldIds = new Set([ROUTE_COMMAND_FORMS.assign, ROUTE_COMMAND_FORMS.reschedule].flatMap((form) => form.sections.flatMap((section) => section.fields.map((field) => field.id))))
  return Object.fromEntries(Object.entries(record.submittedValues ?? {}).filter(([key, value]) => fieldIds.has(key) && typeof value === "string"))
}

/** Dispatch day's first question (O5 of #290): which project's day. The routes it runs follow, each ticked, in the dialog after it. */
export const DISPATCH_DAY_FORM: BusinessFormSchema = {
  key: "route-studio.routes",
  mode: "action",
  recordKind: "Route",
  title: "Dispatch day",
  description: "The project's planned routes running on the day, dispatched to their drivers together. Pick the day; untick a route to leave it planned.",
  submitLabel: "Show the routes",
  sections: [
    {
      id: "day",
      title: "Day",
      fields: [
        { id: "projectId", label: "Project", type: "select", required: true, relation: ORGANISATION_MODULE },
        { id: "operatingDate", label: "Operating date", type: "date", required: true },
      ],
    },
  ],
  execution: { kind: "append-event", completionMessage: "Routes dispatched." },
}

/**
 * The routes Dispatch day offers (O5 of #290): the project's routes running
 * on the day that are still planned, by their number — a ready one is
 * dispatched already, and an active or ended one past dispatching. The
 * dialog lists them all, ticked, so the office dispatches the day or the
 * selection it leaves ticked.
 */
export function dispatchDayRows(records: readonly BusinessRecord[], projectId: string | undefined, day: string): BusinessRecord[] {
  if (projectId === undefined || projectId === "" || day === "") return []
  return records
    .filter((record) => record.recordKind === "Route" && (record.projectIds ?? []).includes(projectId) && record.submittedValues?.operatingDate === day && record.submittedValues?.status === "planned")
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))
}
