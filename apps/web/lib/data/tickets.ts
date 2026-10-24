// Tickets on the Pilot (Issue #182, slice 8 of #81, for #147): the forms
// Operate › Tickets offers once it reads the API — the office's New ticket,
// trimmed to what `TicketCreate` carries, the edit of a case's own words, and
// the dialogs of the commands that say something — and the list's
// categories, read off a row for the person looking. Fixture mode keeps the
// registry's ticket form and the fixture details dialog untouched.
//
// Every field id is a key the adapter reads (lib/api/records/tickets.ts):
// the create's `toCreateBody`, a command's `toBody`. The pickers name rows by
// web id — the project, the assignee (Users & roles), and what the ticket is
// about, each from its switched module — and a closed list by the wire's
// token, shown as a person reads it.
import { singleFilterValue, type FilterValueReaders } from "@waste/domain/business-filters"
import { TICKET_KINDS, TICKET_PRIORITIES, TICKET_RESOLUTIONS } from "@waste/domain/resolution/vocabulary"

import { statusLabel, statusToken } from "../api/records/adapter"
import { CONTAINERS_MODULE } from "../api/records/containers"
import { accessModule } from "../api/records/organisation"
import { PICKUPS_MODULE } from "../api/records/pickups"
import { ROUTES_MODULE } from "../api/records/routes"
import { ASSIGNEE_ACCOUNT_KEY, isOpenTicketStatus, OFFICE_TICKET_SOURCES } from "../api/records/tickets"
import { AGREEMENTS_MODULE } from "./agreements"
import { DRIVERS_MODULE } from "./allocations"
import type { BusinessFormField, BusinessFormOption, BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import type { BusinessRecord, ModuleLocation } from "./business-modules"
import { mintedRecord, ORGANISATION_MODULE } from "./containers"
import { CONTACTS_MODULE, NO_ONE, PROPERTIES_MODULE, SHARED_POINTS_MODULE } from "./properties"

/** Configure › Users & roles: the accounts a ticket is assigned to, where the access module is switched. */
export const ACCESS_MODULE: ModuleLocation = { workspaceId: accessModule.workspaceId, moduleId: accessModule.moduleId }

/** A closed list as a select offers it: the wire's token, the words a person reads. The alerts' forms read it too. */
export const tokenOptions = (tokens: readonly string[]): BusinessFormOption[] => tokens.map((value) => ({ value, label: statusLabel(value) }))

const project: BusinessFormField = { id: "projectId", label: "Project", type: "select", required: true, relation: ORGANISATION_MODULE }
const subject: BusinessFormField = { id: "subject", label: "Subject", type: "text", required: true }
const description: BusinessFormField = { id: "description", label: "Description", type: "textarea", required: true, description: "What happened, or what is asked." }
const kind: BusinessFormField = { id: "kind", label: "Kind", type: "select", required: true, options: tokenOptions(TICKET_KINDS) }
const priority: BusinessFormField = { id: "priority", label: "Priority", type: "select", defaultValue: "none", options: tokenOptions(TICKET_PRIORITIES) }
const due: BusinessFormField = { id: "dueAt", label: "Due", type: "datetime", description: "The response target, on the project's clock." }
const assignee = (description?: string): BusinessFormField => ({ id: "assigneeUserAccountId", label: "Assignee", type: "select", relation: ACCESS_MODULE, description })

/** What a ticket may be about, field by field, each from its module: the office's seven links. */
export const TICKET_LINK_FIELDS: readonly BusinessFormField[] = [
  { id: "routeId", label: "Route", type: "select", relation: ROUTES_MODULE },
  { id: "containerId", label: "Container", type: "select", relation: CONTAINERS_MODULE },
  { id: "customerId", label: "Customer", type: "select", relation: CONTACTS_MODULE },
  { id: "propertyId", label: "Property", type: "select", relation: PROPERTIES_MODULE },
  { id: "sharedCollectionPointId", label: "Shared collection point", type: "select", relation: SHARED_POINTS_MODULE },
  { id: "agreementId", label: "Agreement", type: "select", relation: AGREEMENTS_MODULE },
  { id: "driverId", label: "Driver", type: "select", relation: DRIVERS_MODULE },
]

/** New ticket on the Pilot: `TicketCreate`, and nothing the wire has no home for — no team, type, SLA, attachment or create-time message. */
export const TICKET_FORM: BusinessFormSchema = {
  key: "operate.tickets",
  mode: "create",
  recordKind: "Ticket",
  title: "New ticket",
  description: "Open a case for the office to resolve. A comment is written on the case once it exists, never at its creation.",
  submitLabel: "Open ticket",
  nameField: "subject",
  execution: { kind: "create-record", completionMessage: "Ticket opened." },
  sections: [
    { id: "case", title: "Case", fields: [project, subject, description, kind, priority] },
    {
      id: "when",
      title: "Source and timing",
      fields: [
        { id: "source", label: "Opened via", type: "select", defaultValue: "office", options: tokenOptions(OFFICE_TICKET_SOURCES), description: "Where the case reached the office; the Driver App's are the consumer's." },
        { id: "occurredAt", label: "Occurred", type: "datetime", description: "When it happened, on the project's clock; now when blank." },
        due,
        assignee("Who works it; nobody when blank."),
      ],
    },
    { id: "links", title: "What it is about", fields: TICKET_LINK_FIELDS },
  ],
}

/** Edit case: the case's own words; its kind, priority and due change in place in the details. */
export const TICKET_EDIT_FORM: BusinessFormSchema = {
  key: "operate.tickets",
  mode: "action",
  recordKind: "Ticket",
  title: "Edit case",
  description: "The subject and the description. The status moves by the ticket's commands, never here.",
  submitLabel: "Save",
  execution: { kind: "append-event", completionMessage: "Ticket saved." },
  sections: [{ id: "case", title: "Case", fields: [subject, description] }],
}

/** The commands that say something, each a dialog; `start` is sent as it stands. */
export type TicketCommandWithForm = "assign" | "wait" | "hold" | "complete" | "reject" | "reopen"

const commandForm = (title: string, description: string, submitLabel: string, fields: readonly BusinessFormField[]): BusinessFormSchema => ({
  key: "operate.tickets",
  mode: "action",
  recordKind: "Ticket",
  title,
  description,
  submitLabel,
  sections: [{ id: "command", title, fields }],
  execution: { kind: "append-event", completionMessage: `${title} recorded.` },
})

const note = (label: string, required: boolean): BusinessFormField => ({ id: "note", label, type: "textarea", required })
const RECOLLECTED = { fieldId: "resolution", oneOf: ["recollected"] } as const

/** Each command's dialog, its fields the keys its `toBody` reads. */
export const TICKET_COMMAND_FORMS: Readonly<Record<TicketCommandWithForm, BusinessFormSchema>> = {
  assign: commandForm("Assign", "Who works the case: an account working in the ticket's project. None takes it off everyone.", "Assign", [assignee(), note("Note", false)]),
  wait: commandForm("Waiting for the customer", "The case waits on the customer; say for what.", "Set waiting", [note("Waiting for", true)]),
  hold: commandForm("Put on hold", "The case waits on the office; say for what.", "Put on hold", [note("Held for", true)]),
  complete: commandForm("Complete", "What the case ended in. A re-collection rides on a route of the project that has not ended, and may name the stop of it the office added for it — both made in Route Studio, never here.", "Complete", [
    { id: "resolution", label: "Resolution", type: "select", required: true, options: tokenOptions(TICKET_RESOLUTIONS) },
    { id: "recollectionRouteId", label: "Re-collection route", type: "select", relation: ROUTES_MODULE, visibleWhen: RECOLLECTED, requiredWhen: RECOLLECTED, description: "The routes that have not ended." },
    { id: "recollectionPickupId", label: "Re-collection stop", type: "select", relation: PICKUPS_MODULE, visibleWhen: RECOLLECTED, description: "A stop on that route, planned or collected: the one the office added for it. None names the route alone." },
    note("How it was resolved", true),
  ]),
  reject: commandForm("Reject", "The case is not taken; the reason goes into its history.", "Reject", [{ id: "reason", label: "Reason", type: "textarea", required: true }]),
  reopen: commandForm("Reopen", "A closed case opens again; say why.", "Reopen", [note("Why it is reopened", true)]),
}

/** A stop that was missed — skipped or failed — is no re-collection: the API refuses it (#111). */
const MISSED_STOP = new Set(["skipped", "failed"])

/**
 * The stops a completion's re-collection may name (#111): the picked route's
 * that are planned or collected, by the stops module's records, after None —
 * the route alone; only None until a route is picked.
 */
export function recollectionStopOptions(stops: readonly BusinessRecord[], routeWebId: string | undefined): BusinessFormOption[] {
  // A repair or a wash collects nothing (O3 of #290), so it is no re-collection.
  const empties = (stop: BusinessRecord) => (stop.submittedValues?.service ?? "empty") === "empty"
  const ofRoute = routeWebId === undefined || routeWebId === "" ? [] : stops.filter((stop) => stop.submittedValues?.routeId === routeWebId && !MISSED_STOP.has(String(stop.submittedValues?.status ?? "")) && empties(stop))
  return [{ value: NO_ONE, label: "None: the route alone" }, ...ofRoute.map((stop) => ({ value: stop.id, label: stop.status === "Planned" ? stop.name : `${stop.name} · ${stop.status}` }))]
}

/** A ticket the New ticket form made: the generic create path's id and kind, so the adapter owns it until the API's answer replaces it. `extra` rides along unseen — the alert a ticket answers. */
export function createTicketRecord(values: BusinessFormValues, { now, extra = {} }: { now: number; extra?: BusinessFormValues }): BusinessRecord {
  const name = typeof values.subject === "string" ? values.subject.trim() : ""
  return mintedRecord({ id: `operate-ticket-${now}`, name, status: "Open", recordKind: "Ticket", values: { ...values, ...extra } })
}

/** A ticket after an edit in its details: its values over its typed ones, its name the subject. */
export function updateTicketRecord(record: BusinessRecord, values: BusinessFormValues): BusinessRecord {
  const name = typeof values.subject === "string" && values.subject.trim() !== "" ? values.subject.trim() : record.name
  return { ...record, name, submittedValues: { ...record.submittedValues, ...values } }
}

/**
 * "Open" or "Closed": a ticket's status read as the switch the list opens on —
 * the row's own status, so a row the API has not answered yet (one made this
 * session, the fixtures a failed load falls back on) reads as it shows; the
 * fixtures' Created folds into open, as it did on the wire.
 */
export const opennessOf = (record: Pick<BusinessRecord, "status">): "Open" | "Closed" => {
  const token = statusToken(record.status)
  return token === "created" || isOpenTicketStatus(token) ? "Open" : "Closed"
}

/** The value the Assignee category offers for the viewer's own tickets. */
export const MINE = "Mine"

/**
 * The tickets list's categories on the Pilot (#147), read off a row for the
 * person looking: open or closed, the status, the kind, the priority, the
 * assignee — "Mine" among the values where the ticket is `/me`'s account's —
 * and where it came from. Team, SLA and the configured type are no category:
 * the wire has none of them.
 */
export function ticketListReaders(accountId: string | null): FilterValueReaders {
  return {
    openness: (record) => [opennessOf(record)],
    statuses: (record) => [record.status],
    kinds: (record) => singleFilterValue(record.facts.Kind),
    priorities: (record) => singleFilterValue(record.facts.Priority),
    assignees: (record) => [...singleFilterValue(record.facts.Assignee), ...(accountId !== null && record.submittedValues?.[ASSIGNEE_ACCOUNT_KEY] === accountId ? [MINE] : [])],
    sources: (record) => singleFilterValue(record.facts["Opened via"]),
  }
}

/** The list opens on the open tickets. */
export const TICKET_LIST_INITIAL = { openness: ["Open"] }
