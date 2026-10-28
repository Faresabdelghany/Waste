// Service Providers › Activities on the web (#474): the words an Activity is
// read in, the forms it is opened and corrected through, the commands each
// side is offered, and the bodies they become. The adapter is
// lib/api/records/provider-activities.ts; the rules are
// @waste/domain/service-providers/activities'.
//
// Both sides open an Activity from what they read. A proposal is opened on a
// route of the group it is about — the office and a provider's account both
// read the routes, a provider only those it runs, where a provider reads no
// scheme — and the route names the project, the scheme and the group. A
// follow-up or a note names the award it is about, whose project it takes;
// the office may name a project instead. A provider's account opens for its
// own provider, which the dialog stamps.
import type { ActivityClose, ActivityReject } from "@waste/contracts/service-provider-activities"
import { SERVICE_DAYS, type ServiceDay } from "@waste/domain/planning/vocabulary"
import { closesWith, KIND_WORDS, type ActivityCommand, type ActivitySide } from "@waste/domain/service-providers/activities"
import { SERVICE_PROVIDER_ACTIVITY_KINDS, SERVICE_PROVIDER_ACTIVITY_STATUSES, type ServiceProviderActivityKind, type ServiceProviderActivityStatus } from "@waste/domain/service-providers/vocabulary"

import type { LocalRefusal } from "../api/records/adapter"
import type { BusinessFormOption, BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import type { BusinessRecord, ModuleLocation } from "./business-modules"
import { mintedRecord } from "./containers"

/** Where the Activities live: the providers' workspace, the module the API's grant names. */
export const PROVIDER_ACTIVITIES_MODULE: ModuleLocation = { workspaceId: "service-providers", moduleId: "activities" }

export const ACTIVITY_PREFIX = "provider-activity"
export const ACTIVITY_RECORD_KIND = "Service provider activity"

/** What the record carries beside the form's values: the wire's kind and status, which the commands are offered by. */
export const ACTIVITY_KIND_KEY = "kind"
export const ACTIVITY_STATUS_KEY = "status"

/** What a person calls each kind: the domain's words, capitalised. */
export const kindLabel = (kind: string): string => {
  const words = KIND_WORDS[kind as ServiceProviderActivityKind]
  return words === undefined ? kind : words.charAt(0).toUpperCase() + words.slice(1)
}

const DAY_LABELS: Readonly<Record<ServiceDay, string>> = { monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday", thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday" }
export const DAY_OPTIONS: readonly BusinessFormOption[] = SERVICE_DAYS.map((day) => ({ value: day, label: DAY_LABELS[day] }))
/** Days in a sentence, Monday first: "Wednesday", "Monday · Thursday". */
export const daysText = (days: readonly string[]): string => SERVICE_DAYS.filter((day) => days.includes(day)).map((day) => DAY_LABELS[day]).join(" · ")

const kindOf = (record: Pick<BusinessRecord, "submittedValues">): ServiceProviderActivityKind | undefined => SERVICE_PROVIDER_ACTIVITY_KINDS.find((kind) => kind === record.submittedValues?.[ACTIVITY_KIND_KEY])
const statusOf = (record: Pick<BusinessRecord, "submittedValues">): ServiceProviderActivityStatus | undefined => SERVICE_PROVIDER_ACTIVITY_STATUSES.find((status) => status === record.submittedValues?.[ACTIVITY_STATUS_KEY])

/** The kinds a side opens, in the order the form offers them: a provider never raises a follow-up. */
export const kindsOpenedBy = (side: ActivitySide): readonly ServiceProviderActivityKind[] => (side === "provider" ? ["route-day-change", "vehicle-change", "coordination-note"] : SERVICE_PROVIDER_ACTIVITY_KINDS)

/** What the open form picks from, each by web id: the routes a proposal is opened on, the powered vehicles and the drivers a vehicle change names, the awards, and for the office the providers and the projects. */
export type ActivityFormOptions = {
  routes: readonly BusinessFormOption[]
  vehicles: readonly BusinessFormOption[]
  drivers: readonly BusinessFormOption[]
  serviceAreas: readonly BusinessFormOption[]
  providers: readonly BusinessFormOption[]
  projects: readonly BusinessFormOption[]
}

const PROPOSAL = { fieldId: "kind", oneOf: ["route-day-change", "vehicle-change"] }
const ROUTE_DAYS = { fieldId: "kind", oneOf: ["route-day-change"] }
const VEHICLE = { fieldId: "kind", oneOf: ["vehicle-change"] }
const FOLLOW_UP = { fieldId: "kind", oneOf: ["compliance-follow-up"] }
const NOT_PROPOSAL = { fieldId: "kind", oneOf: ["compliance-follow-up", "coordination-note"] }

/**
 * Log activity: the kind, then what it is about. A proposal names a route of
 * the group and the first day, and a route-day change the days it should run
 * on, a vehicle change its truck and optionally its driver; a follow-up its
 * due day; a follow-up or a note the award, or for the office the project.
 * The office names the provider; a provider's account opens for its own.
 */
export function activityOpenForm(side: ActivitySide, options: ActivityFormOptions): BusinessFormSchema {
  const office = side === "office"
  return {
    key: `${PROVIDER_ACTIVITIES_MODULE.workspaceId}.${PROVIDER_ACTIVITIES_MODULE.moduleId}`,
    mode: "create",
    recordKind: ACTIVITY_RECORD_KIND,
    title: "Log activity",
    description: office ? "A proposal a provider made, a compliance follow-up, or a note to keep with the provider." : "Propose a change to a route you run, or leave the office a note. A proposal changes nothing until the office approves it.",
    submitLabel: "Log activity",
    nameField: "subject",
    execution: { kind: "create-record", completionMessage: "Activity logged." },
    sections: [
      {
        id: "activity",
        title: "Activity",
        fields: [
          { id: "kind", label: "Kind", type: "select", required: true, defaultValue: kindsOpenedBy(side)[0], options: kindsOpenedBy(side).map((kind) => ({ value: kind, label: kindLabel(kind) })) },
          ...(office ? [{ id: "serviceProviderId", label: "Service provider", type: "select" as const, required: true, options: options.providers }] : []),
          { id: "subject", label: "Subject", type: "text", required: true },
          { id: "body", label: "Details", type: "textarea" },
        ],
      },
      {
        id: "proposal",
        title: "The change",
        fields: [
          { id: "routeId", label: "Route of the group", type: "select", options: options.routes, visibleWhen: PROPOSAL, requiredWhen: PROPOSAL, description: "A route of the collection group the change is about: its scheme and group are what the proposal changes." },
          { id: "serviceDays", label: "New days", type: "multiselect", options: DAY_OPTIONS, visibleWhen: ROUTE_DAYS, requiredWhen: ROUTE_DAYS },
          { id: "vehicleId", label: "Vehicle", type: "select", options: options.vehicles, visibleWhen: VEHICLE, requiredWhen: VEHICLE, description: office ? "A powered vehicle of the project." : "One of your own trucks." },
          { id: "driverId", label: "Driver", type: "select", options: options.drivers, visibleWhen: VEHICLE, description: "Blank keeps the group's driver." },
          { id: "effectiveFrom", label: "From", type: "date", visibleWhen: PROPOSAL, requiredWhen: PROPOSAL, description: "The first day the change applies." },
        ],
      },
      {
        id: "about",
        title: "What it is about",
        fields: [
          { id: "serviceAreaId", label: "Service area", type: "select", options: options.serviceAreas, visibleWhen: NOT_PROPOSAL, ...(office ? {} : { requiredWhen: NOT_PROPOSAL }) },
          ...(office ? [{ id: "projectId", label: "Project", type: "select" as const, options: options.projects, visibleWhen: NOT_PROPOSAL, description: "Where no service area is named." }] : []),
          { id: "dueOn", label: "Due", type: "date", visibleWhen: FOLLOW_UP, requiredWhen: FOLLOW_UP },
        ],
      },
    ],
  }
}

/** The correction a row's kind takes while it is open: its words, a route-day change's days, a vehicle change's truck and driver, a proposal's day, or a follow-up's due day. */
export function activityCorrectionForm(kind: ServiceProviderActivityKind, options: Pick<ActivityFormOptions, "vehicles" | "drivers"> = { vehicles: [], drivers: [] }): BusinessFormSchema {
  return {
    key: `${PROVIDER_ACTIVITIES_MODULE.workspaceId}.${PROVIDER_ACTIVITIES_MODULE.moduleId}.correct`,
    mode: "create",
    recordKind: ACTIVITY_RECORD_KIND,
    title: "Correct the activity",
    description: "Corrected while it is open; the history keeps what it said before.",
    submitLabel: "Save",
    nameField: "subject",
    execution: { kind: "create-record", completionMessage: "Activity corrected." },
    sections: [
      {
        id: "activity",
        title: kindLabel(kind),
        fields: [
          { id: "subject", label: "Subject", type: "text", required: true },
          { id: "body", label: "Details", type: "textarea" },
          ...(kind === "route-day-change"
            ? [
                { id: "serviceDays", label: "New days", type: "multiselect" as const, required: true, options: DAY_OPTIONS },
                { id: "effectiveFrom", label: "From", type: "date" as const, required: true },
              ]
            : []),
          ...(kind === "vehicle-change"
            ? [
                { id: "vehicleId", label: "Vehicle", type: "select" as const, required: true, options: options.vehicles },
                { id: "driverId", label: "Driver", type: "select" as const, options: options.drivers, description: "Blank keeps the group's driver." },
                { id: "effectiveFrom", label: "From", type: "date" as const, required: true },
              ]
            : []),
          ...(kind === "compliance-follow-up" ? [{ id: "dueOn", label: "Due", type: "date" as const, required: true }] : []),
        ],
      },
    ],
  }
}

/** The values the correction opens on: the row's own. */
export const correctionValuesOf = (record: Pick<BusinessRecord, "submittedValues">): BusinessFormValues => {
  const values = record.submittedValues ?? {}
  return { subject: values.subject ?? "", body: values.body ?? "", serviceDays: values.serviceDays ?? "", effectiveFrom: values.effectiveFrom ?? "", dueOn: values.dueOn ?? "", vehicleId: values.vehicleId ?? "", driverId: values.driverId ?? "" }
}

/** The row a Log activity makes before the API answers it: its values as typed, the provider stamped for a provider's account. */
export function createActivityRecord(values: BusinessFormValues, now: number, stamp: { serviceProviderId?: string } = {}): BusinessRecord {
  const name = typeof values.subject === "string" ? values.subject.trim() : ""
  return mintedRecord({ id: `activities-${ACTIVITY_PREFIX}-${now}`, name, status: values.kind === "route-day-change" || values.kind === "vehicle-change" ? "Pending approval" : "Open", recordKind: ACTIVITY_RECORD_KIND, values: { ...values, ...stamp } })
}

/** One command a row offers: its button's words, what the toast says once the API took it, and whether its dialog asks a reason. */
export type ActivityOffer = { command: ActivityCommand; label: string; done: string; reason: "required" | "optional" }

const OFFERS: Readonly<Record<ActivityCommand, Omit<ActivityOffer, "command">>> = {
  approve: { label: "Approve and apply", done: "Proposal approved; the scheme's next version is written", reason: "optional" },
  reject: { label: "Reject", done: "Proposal rejected", reason: "required" },
  withdraw: { label: "Withdraw", done: "Proposal withdrawn", reason: "optional" },
  complete: { label: "Complete", done: "Activity completed", reason: "optional" },
  cancel: { label: "Cancel", done: "Activity cancelled", reason: "optional" },
}

const COMMAND_ORDER: readonly ActivityCommand[] = ["approve", "reject", "withdraw", "complete", "cancel"]

/** The commands a row offers the side looking at it: those its kind takes, from where it stands, from that side (`closesWith`). */
export function activityCommandsOffered(record: Pick<BusinessRecord, "submittedValues">, side: ActivitySide): ActivityOffer[] {
  const kind = kindOf(record)
  const status = statusOf(record)
  if (kind === undefined || status === undefined) return []
  return COMMAND_ORDER.filter((command) => closesWith({ number: 0, kind, status }, command, side).ok).map((command) => ({ command, ...OFFERS[command] }))
}

/** Whether the row's correction is offered to the side: open, and the side's to open (a follow-up is the office's). */
export function activityCorrectable(record: Pick<BusinessRecord, "submittedValues">, side: ActivitySide): boolean {
  const kind = kindOf(record)
  const status = statusOf(record)
  if (kind === undefined || (status !== "pending-approval" && status !== "open")) return false
  return side === "office" || kind !== "compliance-follow-up"
}

export const REASON_NEEDED = "Say why: the provider reads it"

/** A close's body: its reason where one was given. */
export function closeBodyOf(values: BusinessFormValues): ActivityClose {
  const reason = typeof values.reason === "string" && values.reason.trim() !== "" ? values.reason.trim() : undefined
  return reason === undefined ? {} : { reason }
}

/** A rejection's body: always why. */
export function rejectBodyOf(values: BusinessFormValues): ActivityReject | LocalRefusal {
  const body = closeBodyOf(values)
  return body.reason == null ? { path: "reason", message: REASON_NEEDED } : { reason: body.reason }
}

/** The dialog a command asks its reason in. */
export function reasonForm(offer: ActivityOffer): BusinessFormSchema {
  return {
    key: `${PROVIDER_ACTIVITIES_MODULE.workspaceId}.${PROVIDER_ACTIVITIES_MODULE.moduleId}.${offer.command}`,
    mode: "create",
    recordKind: "Reason",
    title: offer.label,
    description: offer.command === "approve" ? "The scheme's next version is written from the proposal's day, with the change applied to its group. If the scheme's rules refuse it, nothing changes and the proposal stays pending." : "",
    submitLabel: offer.label,
    contextFieldIds: [],
    sections: [{ id: "reason", title: "Reason", fields: [{ id: "reason", label: offer.reason === "required" ? "Why" : "Note", type: "textarea", required: offer.reason === "required" }] }],
    execution: { kind: "create-record", completionMessage: offer.done },
  }
}
