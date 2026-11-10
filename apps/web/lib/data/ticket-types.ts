// Ticket Types on the Pilot (#545 of #544): the company's own types of case,
// each inside one kind, where they live — beside the teams, as records of
// `configure.templates` (lib/api/records/ticket-types.ts) — the form a type is
// added with, and what its record carries for the pane that edits it and for
// the ticket's forms: its custom fields and the roles it names per status
// command, each as the wire's list in JSON under a key of its own.
//
// A ticket's form offers the type's fields once the type is picked: each
// field of every type is a field of the form, shown and, where it is required
// to open, required only while its type is the one picked
// (`ticketTypeFormFields`), its id naming the type and the key
// (`typeFieldFormId`). `fieldValuesFromForm` reads the picked type's back into
// the wire's values, a number as a number and yes or no as a boolean, a blank
// left out.
//
// A type's automation (#546 of #544) rides on the record the same way, as
// the wire's list of actions in JSON, each team, person, follow-up type and
// vehicle by its web id: what the pane's Automation tab edits, by trigger,
// offering each trigger the kinds of action it takes (`actionKindsFor`) and
// held to the domain's rules before the request (`actionsIssue`).
import type { TicketTypeAction, TicketTypeField, TicketTypePermission } from "@waste/contracts/ticket-types"
import { ACTION_KIND_WORDS, actionIssue, plannedService, TRIGGER_WORDS } from "@waste/domain/resolution/automation"
import { fieldKeyOf, TICKET_COMMAND_VERBS } from "@waste/domain/resolution/ticket-types"
import { isClosedTicketStatus, TICKET_ACTION_COMMANDS, TICKET_ACTION_KINDS, TICKET_COMMANDS, TICKET_FIELD_INPUTS, TICKET_FIELD_REQUIREMENTS, TICKET_KINDS, TICKET_MESSAGE_RECIPIENTS, TICKET_PRIORITIES, TICKET_RESOLUTIONS, type TicketActionKind, type TicketActionTrigger, type TicketCommand, type TicketFieldInput, type TicketFieldRequirement, type TicketKind, type TicketMessageRecipient } from "@waste/domain/resolution/vocabulary"

import { type Grants, mayOn } from "@/lib/modules/grants"
import { statusLabel } from "@/lib/records/fields"
import type { BusinessFormField, BusinessFormFieldType, BusinessFormOption, BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import type { BusinessRecord, ModuleLocation } from "./business-modules"
import { mintedRecord } from "./containers"
import { TICKET_TEAMS_MODULE } from "./ticket-teams"
import { capitalised } from "@/lib/format/words"

/** The module the types are records of: the teams', the API's grant for both being `configure.templates`. */
export const TICKET_TYPES_MODULE: ModuleLocation = TICKET_TEAMS_MODULE


/** The record's custom fields, as the wire's list in JSON: what the pane edits and the ticket's forms read. */
export const TICKET_TYPE_FIELDS_KEY = "fieldsJson"

/** The record's permissions, as the wire's list in JSON, each role by its web id. */
export const TICKET_TYPE_PERMISSIONS_KEY = "permissionsJson"

/** The record's automation, as the wire's list of actions in JSON, each team, person, follow-up type and vehicle by its web id. */
export const TICKET_TYPE_ACTIONS_KEY = "actionsJson"

/** A type's two statuses as a person reads them. */
export const TICKET_TYPE_STATUS_LABELS = ["Active", "Inactive"] as const

/** The six inputs as a person reads them. */
export const FIELD_INPUT_LABELS: Readonly<Record<TicketFieldInput, string>> = { text: "Text", paragraph: "Paragraph", number: "Number", date: "Date", "yes-no": "Yes or no", choice: "Choice" }

/** When a field must be filled in, as a person reads it. */
export const FIELD_REQUIREMENT_LABELS: Readonly<Record<TicketFieldRequirement, string>> = { optional: "Optional", "to-open": "To open", "to-complete": "To complete" }

/** The commands a type names roles for, in the machine's order, as a column heads them. */
export const COMMAND_HEADINGS: readonly { command: TicketCommand; heading: string }[] = TICKET_COMMANDS.map((command) => ({ command, heading: capitalised(TICKET_COMMAND_VERBS[command]) }))

/** New ticket type: its name, its kind, what it is for, and whether it is its kind's default. Its fields and permissions are set once it exists. */
export const TICKET_TYPE_FORM: BusinessFormSchema = {
  key: "configure.templates",
  mode: "create",
  recordKind: "Ticket type",
  title: "New ticket type",
  description: "A type of case of one kind, with the fields the office fills in and who may move it. Its fields and permissions are set once it exists.",
  submitLabel: "Add type",
  nameField: "name",
  execution: { kind: "create-record", completionMessage: "Ticket type added." },
  sections: [
    {
      id: "type",
      title: "Type",
      fields: [
        { id: "name", label: "Name", type: "text", required: true, placeholder: "Bulky waste collection" },
        { id: "kind", label: "Kind", type: "select", required: true, options: TICKET_KINDS.map((kind) => ({ value: kind, label: statusLabel(kind) })), description: "The built-in category it belongs to: the stop that answers it, how it is charged. Never changed once made." },
        { id: "description", label: "Description", type: "textarea", description: "What the type is for, for the office." },
        { id: "isDefault", label: "Default for its kind", type: "checkbox", defaultValue: false, description: "A ticket opened by its kind alone — by a driver, the worker or a work order — is of the kind's default type." },
      ],
    },
  ],
}

/** A type as the pane adds it: minted under a browser id until the API answers with its own. */
export function createTicketTypeRecord(values: BusinessFormValues, { now }: { now: number }): BusinessRecord {
  const name = typeof values.name === "string" ? values.name.trim() : ""
  return mintedRecord({ id: `configure-ticket-type-${now}`, name, status: "Active", recordKind: "Ticket type", values: { ...values, status: "Active" } })
}

/** A type's fields as its record carries them; none where it carries none or a list the pane cannot read. */
export function typeFieldsOf(record: Pick<BusinessRecord, "submittedValues">): TicketTypeField[] {
  const json = record.submittedValues?.[TICKET_TYPE_FIELDS_KEY]
  if (typeof json !== "string" || json === "") return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as TicketTypeField[]) : []
  } catch {
    return []
  }
}

/** A type's permissions as its record carries them, each role by its web id. */
export function typePermissionsOf(record: Pick<BusinessRecord, "submittedValues">): TicketTypePermission[] {
  const json = record.submittedValues?.[TICKET_TYPE_PERMISSIONS_KEY]
  if (typeof json !== "string" || json === "") return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as TicketTypePermission[]) : []
  } catch {
    return []
  }
}

/** A type's actions as its record carries them, each reference by its web id. */
export function typeActionsOf(record: Pick<BusinessRecord, "submittedValues">): TicketTypeAction[] {
  const json = record.submittedValues?.[TICKET_TYPE_ACTIONS_KEY]
  if (typeof json !== "string" || json === "") return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as TicketTypeAction[]) : []
  } catch {
    return []
  }
}

/** Each trigger as its section heads it. */
export const TRIGGER_HEADINGS: Readonly<Record<TicketActionTrigger, string>> = Object.fromEntries(Object.entries(TRIGGER_WORDS).map(([trigger, words]) => [trigger, capitalised(words)])) as Record<TicketActionTrigger, string>

/** Each kind of action as a picker offers it. */
export const ACTION_KIND_LABELS: Readonly<Record<TicketActionKind, string>> = Object.fromEntries(TICKET_ACTION_KINDS.map((kind) => [kind, capitalised(ACTION_KIND_WORDS[kind])])) as Record<TicketActionKind, string>

/** Whom a message goes to, as a picker offers it. */
export const RECIPIENT_LABELS: Readonly<Record<TicketMessageRecipient, string>> = {
  "ticket-customer": "The ticket's customer",
  owner: "The property's owner",
  payer: "The property's payer",
  tenant: "The property's tenant",
  administrator: "The property's administrator",
  "service-contact": "The property's service contact",
}

/** The statuses an action moves a ticket to, the priorities and the resolutions, as pickers offer them. */
export const ACTION_COMMAND_OPTIONS: readonly BusinessFormOption[] = TICKET_ACTION_COMMANDS.map((command) => ({ value: command, label: capitalised(TICKET_COMMAND_VERBS[command]) }))
export const PRIORITY_OPTIONS: readonly BusinessFormOption[] = TICKET_PRIORITIES.map((priority) => ({ value: priority, label: statusLabel(priority) }))
export const RESOLUTION_OPTIONS: readonly BusinessFormOption[] = TICKET_RESOLUTIONS.map((resolution) => ({ value: resolution, label: statusLabel(resolution) }))
export const RECIPIENT_OPTIONS: readonly BusinessFormOption[] = TICKET_MESSAGE_RECIPIENTS.map((recipient) => ({ value: recipient, label: RECIPIENT_LABELS[recipient] }))

/**
 * The kinds of action a trigger takes on a type of the kind: on a ticket a
 * completion or a rejection closed, a message or a follow-up alone; a plan in
 * a route only where a stop naming nothing but the ticket's container answers
 * the kind.
 */
export function actionKindsFor(trigger: TicketActionTrigger, kind: TicketKind): TicketActionKind[] {
  const closes = trigger !== "opened" && isClosedTicketStatus(trigger)
  return TICKET_ACTION_KINDS.filter((action) => (closes ? action === "send-message" || action === "open-follow-up" : action !== "plan-in-route" || plannedService(kind) !== undefined))
}

/** No parameter: what a new action starts from before its kind's are filled in. */
const NO_PARAMETERS = { teamId: null, userAccountId: null, priority: null, command: null, resolution: null, messageTemplateName: null, recipient: null, followUpTypeId: null, vehicleId: null, daysAhead: null } as const

/** A new action of a kind on a trigger, with what it needs that has a sensible start — a priority, a status, a recipient, the days ahead — and the rest for a person to pick. */
export function newAction(trigger: TicketActionTrigger, kind: TicketActionKind): TicketTypeAction {
  const start: Partial<TicketTypeAction> =
    kind === "set-priority"
      ? { priority: "high" }
      : kind === "set-status"
        ? { command: trigger === "in-progress" ? "complete" : "start", resolution: trigger === "in-progress" ? "serviced" : null }
        : kind === "send-message"
          ? { recipient: "ticket-customer" }
          : kind === "plan-in-route"
            ? { daysAhead: 1 }
            : {}
  return { trigger, kind, ...NO_PARAMETERS, ...start }
}

/** The first action that breaks the domain's rules, in the pane's words: its trigger, its place among its trigger's and why; undefined where every one keeps them. */
export function actionsIssue(actions: readonly TicketTypeAction[]): string | undefined {
  for (const [index, action] of actions.entries()) {
    const issue = actionIssue(action)
    if (issue === undefined) continue
    const place = actions.slice(0, index + 1).filter((other) => other.trigger === action.trigger).length
    return `${TRIGGER_HEADINGS[action.trigger]}, action ${place}: ${issue.message}.`
  }
  return undefined
}

/** One field as the pane's editor holds it: the choices as the one line a person types, comma-separated. */
export type FieldDraft = { key: string; label: string; helpText: string; input: TicketFieldInput; choices: string; requirement: TicketFieldRequirement; keyTouched: boolean }

export const draftOf = (field: TicketTypeField): FieldDraft => ({ key: field.key, label: field.label, helpText: field.helpText ?? "", input: field.input, choices: field.choices.join(", "), requirement: field.requirement, keyTouched: true })

/** A new field's draft: a line of text, optional, its key following its label until a person types one. */
export const newFieldDraft = (): FieldDraft => ({ key: "", label: "", helpText: "", input: "text", choices: "", requirement: "optional", keyTouched: false })

/** A draft after its label changes: the key follows the label until a person types one of their own. */
export const relabelled = (draft: FieldDraft, label: string): FieldDraft => ({ ...draft, label, key: draft.keyTouched ? draft.key : fieldKeyOf(label) })

/** The wire's field from a draft: the choices split on commas, a choice field's alone, the help text null where blank. */
export function fieldOfDraft(draft: FieldDraft): TicketTypeField {
  const choices = draft.input === "choice" ? draft.choices.split(",").map((choice) => choice.trim()).filter((choice) => choice !== "") : []
  return { key: draft.key.trim(), label: draft.label.trim(), helpText: draft.helpText.trim() === "" ? null : draft.helpText.trim(), input: draft.input, choices, requirement: draft.requirement }
}

/**
 * A type after the pane's edit: its own fields, its fields, its permissions and its automation as the record carries them, which the adapter writes each through its route where it changed.
 * The status rides in the values alone, as a team's does: the record's own status is a lifecycle move, which the store refuses for a type, and the API's answer brings the new one.
 */
export function updatedTicketTypeRecord(
  record: BusinessRecord,
  edit: { name: string; description: string; status: string; isDefault: boolean; fields: readonly TicketTypeField[]; permissions: readonly TicketTypePermission[]; actions?: readonly TicketTypeAction[] },
): BusinessRecord {
  return {
    ...record,
    name: edit.name.trim() === "" ? record.name : edit.name.trim(),
    submittedValues: {
      ...record.submittedValues,
      name: edit.name.trim(),
      description: edit.description,
      status: edit.status,
      isDefault: edit.isDefault,
      [TICKET_TYPE_FIELDS_KEY]: JSON.stringify(edit.fields),
      [TICKET_TYPE_PERMISSIONS_KEY]: JSON.stringify(edit.permissions.filter((entry) => entry.roleIds.length > 0)),
      ...(edit.actions === undefined ? {} : { [TICKET_TYPE_ACTIONS_KEY]: JSON.stringify(edit.actions) }),
    },
  }
}

/** The input a type's field is on a form. */
const FORM_TYPE: Readonly<Record<TicketFieldInput, BusinessFormFieldType>> = { text: "text", paragraph: "textarea", number: "number", date: "date", "yes-no": "checkbox", choice: "select" }

/** The form field id a type's field is under: the type's web id and the key, so two types' keys never meet. */
export const typeFieldFormId = (typeWebId: string, key: string): string => `typeField:${typeWebId}:${key}`

/** One of a type's fields as a form field: its input, its help text, a choice's options and yes or no starting at no. */
function formFieldOf(type: BusinessRecord, field: TicketTypeField): BusinessFormField {
  const options: BusinessFormOption[] | undefined = field.input === "choice" ? field.choices.map((choice) => ({ value: choice, label: choice })) : undefined
  return {
    id: typeFieldFormId(type.id, field.key),
    label: field.label,
    type: FORM_TYPE[field.input],
    ...(field.helpText === null ? {} : { description: field.helpText }),
    ...(options === undefined ? {} : { options }),
    ...(field.input === "yes-no" ? { defaultValue: false } : {}),
  }
}

/** The form fields every type's fields are, each shown — and, where its type requires it to open, required — only while its type is the one picked under `ticketTypeId`. Yes or no is never required: no is an answer. */
export function ticketTypeFormFields(types: readonly BusinessRecord[]): BusinessFormField[] {
  return types.flatMap((type) =>
    typeFieldsOf(type).map((field): BusinessFormField => {
      const picked = { fieldId: "ticketTypeId", equals: type.id }
      return { ...formFieldOf(type, field), visibleWhen: picked, ...(field.requirement === "to-open" && field.input !== "yes-no" ? { requiredWhen: picked } : {}) }
    }),
  )
}

/** The picked type's values from a form, as the wire takes them: a number as a number, yes or no as a boolean, a blank left out. */
export function fieldValuesFromForm(type: BusinessRecord, values: BusinessFormValues): Record<string, string | number | boolean> {
  const read: Record<string, string | number | boolean> = {}
  for (const field of typeFieldsOf(type)) {
    const value = values[typeFieldFormId(type.id, field.key)]
    if (field.input === "yes-no") {
      if (typeof value === "boolean") read[field.key] = value
      continue
    }
    if (typeof value !== "string" || value.trim() === "") continue
    read[field.key] = field.input === "number" ? Number(value) : field.input === "paragraph" ? value : value.trim()
  }
  return read
}

/** Edit fields in a ticket's details: its type's fields, each optional, since what a field needs is asked at opening and at completion. */
export function editFieldsForm(type: BusinessRecord): BusinessFormSchema {
  const fields = typeFieldsOf(type).map((field) => formFieldOf(type, field))
  return {
    key: "operate.tickets",
    mode: "action",
    recordKind: "Ticket",
    title: "Edit fields",
    description: `The facts a ticket of type ${type.name} records. A blank field is cleared.`,
    submitLabel: "Save fields",
    execution: { kind: "append-event", completionMessage: "Fields saved." },
    sections: [{ id: "fields", title: type.name, fields }],
  }
}

/** A ticket's values after its fields' edit: each of the type's fields as the form left it, a blank one cleared, and a value of a field no longer on the type kept as it is. */
export function fieldValuesAfterEdit(type: BusinessRecord, held: Readonly<Record<string, unknown>>, values: BusinessFormValues): Record<string, unknown> {
  const next: Record<string, unknown> = { ...held }
  for (const field of typeFieldsOf(type)) delete next[field.key]
  return { ...next, ...fieldValuesFromForm(type, values) }
}

/** A ticket's values as a form's initial values for its type's fields, every value as the form holds it. */
export function formValuesOfFields(typeWebId: string, fieldValues: Readonly<Record<string, unknown>>): BusinessFormValues {
  const values: BusinessFormValues = {}
  for (const [key, value] of Object.entries(fieldValues)) values[typeFieldFormId(typeWebId, key)] = typeof value === "boolean" ? value : String(value)
  return values
}

/** A value as a ticket's details show it: yes or no in words, the rest as written. */
export const shownFieldValue = (value: unknown): string => (value === true ? "Yes" : value === false ? "No" : value === undefined || value === null || value === "" ? "—" : String(value))

/** The inputs and requirements a field editor offers, in the vocabulary's order. */
export const FIELD_INPUT_OPTIONS: readonly BusinessFormOption[] = TICKET_FIELD_INPUTS.map((input) => ({ value: input, label: FIELD_INPUT_LABELS[input] }))
export const FIELD_REQUIREMENT_OPTIONS: readonly BusinessFormOption[] = TICKET_FIELD_REQUIREMENTS.map((requirement) => ({ value: requirement, label: FIELD_REQUIREMENT_LABELS[requirement] }))

/** What the person's role lets them do with the types: read them under `view` on the templates' module, change them under `edit`, add one under `create`. */
export const ticketTypesAccessOf = (grants: Grants | null): { view: boolean; edit: boolean; create: boolean } => ({
  view: mayOn(grants, "configure.templates", "view"),
  edit: mayOn(grants, "configure.templates", "edit"),
  create: mayOn(grants, "configure.templates", "create"),
})
