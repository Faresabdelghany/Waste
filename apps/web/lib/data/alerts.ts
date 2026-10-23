// Alerts on the Pilot (Issue #182, slice 8 of #81, for #147): the forms
// Operate › Exceptions & Alerts offers once it reads the API — raise an
// alert by hand, trimmed to what `AlertCreate` carries; resolve with a note;
// link to a ticket — the New ticket form an alert's Open ticket hands over
// with its links prefilled, and the queue's categories. Fixture mode keeps
// the registry's alert form untouched.
//
// Every field id is a key the adapter reads (lib/api/records/alerts.ts).
import { singleFilterValue, type FilterValueReaders } from "@waste/domain/business-filters"
import { ALERT_KINDS, ALERT_SEVERITIES, type TicketPriority } from "@waste/domain/resolution/vocabulary"

import { statusLabel } from "../api/records/adapter"
import { CONTAINERS_MODULE } from "../api/records/containers"
import { ROUTES_MODULE } from "../api/records/routes"
import { TICKETS_MODULE } from "../api/records/tickets"
import { DRIVERS_MODULE, VEHICLES_MODULE } from "./allocations"
import type { BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import type { BusinessRecord } from "./business-modules"
import { mintedRecord, ORGANISATION_MODULE } from "./containers"

const optionsOf = (tokens: readonly string[]) => tokens.map((value) => ({ value, label: statusLabel(value) }))

/** Raise alert on the Pilot: `AlertCreate` — what was seen, how severe, and what it is about, one of the four at least. */
export const ALERT_FORM: BusinessFormSchema = {
  key: "operate.exceptions",
  mode: "create",
  recordKind: "Alert",
  title: "Raise alert",
  description: "A condition that needs attention. It is acknowledged, resolved, and may be handed to a ticket.",
  submitLabel: "Raise alert",
  nameField: "title",
  execution: { kind: "create-record", completionMessage: "Alert raised." },
  sections: [
    {
      id: "alert",
      title: "Alert",
      fields: [
        { id: "projectId", label: "Project", type: "select", required: true, relation: ORGANISATION_MODULE },
        { id: "title", label: "Title", type: "text", required: true },
        { id: "details", label: "Details", type: "textarea", required: true, description: "What was seen." },
        { id: "kind", label: "Kind", type: "select", required: true, options: optionsOf(ALERT_KINDS) },
        { id: "severity", label: "Severity", type: "select", required: true, options: optionsOf(ALERT_SEVERITIES) },
        { id: "detectedAt", label: "Detected", type: "datetime", description: "When it was seen, on the project's clock; now when blank." },
      ],
    },
    {
      id: "subject",
      title: "What it is about",
      description: "At least one of the four.",
      fields: [
        { id: "routeId", label: "Route", type: "select", relation: ROUTES_MODULE },
        { id: "vehicleId", label: "Vehicle", type: "select", relation: VEHICLES_MODULE },
        { id: "driverId", label: "Driver", type: "select", relation: DRIVERS_MODULE },
        { id: "containerId", label: "Container", type: "select", relation: CONTAINERS_MODULE },
      ],
    },
  ],
}

/** The alert's commands that say something. */
export type AlertCommandWithForm = "resolve" | "link-ticket"

/** Each command's dialog; acknowledge says nothing and is sent as it stands. */
export const ALERT_COMMAND_FORMS: Readonly<Record<AlertCommandWithForm, BusinessFormSchema>> = {
  resolve: {
    key: "operate.exceptions",
    mode: "action",
    recordKind: "Alert",
    title: "Resolve",
    description: "The condition is over. A resolved alert changes no more.",
    submitLabel: "Resolve",
    sections: [{ id: "command", title: "Resolve", fields: [{ id: "note", label: "Resolution note", type: "textarea" }] }],
    execution: { kind: "append-event", completionMessage: "Alert resolved." },
  },
  "link-ticket": {
    key: "operate.exceptions",
    mode: "action",
    recordKind: "Alert",
    title: "Link to a ticket",
    description: "The ticket of the alert's project that resolves it. An alert links to one ticket.",
    submitLabel: "Link ticket",
    sections: [{ id: "command", title: "Link to a ticket", fields: [{ id: "ticketId", label: "Ticket", type: "select", required: true, relation: TICKETS_MODULE }] }],
    execution: { kind: "append-event", completionMessage: "Alert linked." },
  },
}

/** An alert the Raise alert form made: the generic create path's id and kind, so the adapter owns it until the API's answer replaces it. */
export function createAlertRecord(values: BusinessFormValues, { now }: { now: number }): BusinessRecord {
  const name = typeof values.title === "string" ? values.title.trim() : ""
  return mintedRecord({ id: `operate-alert-${now}`, name, status: "New", recordKind: "Alert", values })
}

/** An alert's severity as the ticket it hands over is prioritised: the same four words. */
const PRIORITY_OF_SEVERITY: Readonly<Record<string, TicketPriority>> = { critical: "critical", high: "high", medium: "medium", low: "low" }

/**
 * What an alert's Open ticket opens the New ticket form on: its project, its
 * title and details as the case's words, its severity as the priority, and
 * what it is about as the ticket's links — a ticket has no vehicle link, so
 * an alert about a vehicle reaches its ticket through the alert itself,
 * which the ticket answers (`alertId`, sent beside the form's values).
 */
export function ticketValuesOfAlert(alert: BusinessRecord): BusinessFormValues {
  const value = (key: string) => (typeof alert.submittedValues?.[key] === "string" ? (alert.submittedValues[key] as string) : "")
  return {
    projectId: value("projectId") || (alert.projectIds?.[0] ?? ""),
    subject: alert.name,
    description: alert.description,
    kind: "other",
    priority: PRIORITY_OF_SEVERITY[value("severity")] ?? "none",
    source: "office",
    routeId: value("routeId"),
    containerId: value("containerId"),
    driverId: value("driverId"),
  }
}

/** The queue's categories on the Pilot (#147): the status, the severity and the kind. */
export function alertListReaders(): FilterValueReaders {
  return {
    statuses: (record) => [record.status],
    severities: (record) => singleFilterValue(record.facts.Severity),
    kinds: (record) => singleFilterValue(record.facts.Kind),
  }
}

/** The queue opens on what still needs attention: new and acknowledged. */
export const ALERT_LIST_INITIAL = { statuses: ["New", "Acknowledged"] }
