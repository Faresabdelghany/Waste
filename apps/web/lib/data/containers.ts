// The container's forms on the Pilot (Issue #181, slice 5b of #81): what the
// Containers module offers once it reads the API — the create and edit form
// of the identity the wire carries, and one dialog per command of the
// container's lifecycle — for the command surfaces
// (components/waste/commands/container-surfaces.tsx) to render. Fixture mode
// keeps the registry's Add container form and its asset sheet untouched.
//
// Every field id here is a key the adapter reads (lib/api/records/
// containers.ts): the form's values go onto the record as its typed values,
// or into a command's input, and `toBody` makes the contract's body of them.
// lib/data/__tests__/container-forms.test.ts holds the two together through
// the adapter itself, so a renamed field cannot quietly send nothing.
//
// Relations name another module's row by web id: the project
// (configure.organization), the container type, the fraction and the
// frequency (master data, filtered by kind in the dialog), the warehouse
// (resources.warehouses, slice 5a), and the subscription (customers.
// agreements, slice 9a), offered with the place it is delivered at (#184),
// since that is where the container will serve; the API's 409 says when the
// place is not served (#79).
import { STOCK_PLACES, ADJUSTMENT_TARGETS } from "@waste/domain/resources/vocabulary"
import { CONTAINER_OWNERSHIPS } from "@waste/domain/registry/vocabulary"

import { AGREEMENTS_MODULE } from "./agreements"
import { FIXTURE_COMPANY_ID, type BusinessRecord, type ModuleLocation } from "./business-modules"
import type { BusinessFormField, BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import { MASTER_DATA_MODULE } from "./master-data"

/** Where the projects a form names live. */
export const ORGANISATION_MODULE: ModuleLocation = { workspaceId: "configure", moduleId: "organization" }
/** Where the warehouses a command names live (slice 5a). */
export const WAREHOUSES_MODULE: ModuleLocation = { workspaceId: "resources", moduleId: "warehouses" }

/** The container's commands as the dialogs offer them, in the ledger's order: into stock, into service, back, between places, out, and the correction door. */
export const CONTAINER_COMMANDS_OFFERED = ["receive", "issue", "return", "transfer", "decommission", "adjust"] as const
export type OfferedContainerCommand = (typeof CONTAINER_COMMANDS_OFFERED)[number]

/** How a form and a fact spell an ownership, as the fixtures do. */
export const OWNERSHIP_LABELS: Readonly<Record<(typeof CONTAINER_OWNERSHIPS)[number], string>> = { company: "Company owned", customer: "Customer owned", unrecorded: "Unrecorded" }
const PLACE_LABELS: Readonly<Record<(typeof ADJUSTMENT_TARGETS)[number], string>> = { warehouse: "Warehouse", maintenance: "Maintenance at the warehouse", scrap: "Scrap" }

const IDENTITY_FIELDS: readonly BusinessFormField[] = [
  { id: "projectId", label: "Operating project", type: "select", required: true, relation: ORGANISATION_MODULE },
  { id: "containerId", label: "Container ID", type: "text", required: true, placeholder: "BIN-82014", description: "What a person reads off the bin; unique across the company." },
  { id: "barcode", label: "Barcode", type: "text" },
  { id: "rfid", label: "RFID", type: "text" },
  { id: "serialNumber", label: "Serial number", type: "text" },
  { id: "containerType", label: "Container type", type: "select", required: true, relation: MASTER_DATA_MODULE },
  { id: "ownership", label: "Ownership", type: "select", required: true, defaultValue: "company", options: CONTAINER_OWNERSHIPS.map((value) => ({ value, label: OWNERSHIP_LABELS[value] })) },
  { id: "description", label: "Notes", type: "textarea" },
]

/** The create form: the identity the wire carries. Where it serves and where it stands are the commands'. */
export const CONTAINER_FORM: BusinessFormSchema = {
  key: "resources.containers",
  mode: "create",
  recordKind: "Container",
  title: "Add container",
  description: "Register one physical container in a project. It enters stock by Receive and service by Issue into service.",
  submitLabel: "Add container",
  nameField: "containerId",
  contextFieldIds: ["containerType", "projectId"],
  sections: [{ id: "identity", title: "Identity", fields: IDENTITY_FIELDS }],
  execution: { kind: "create-record", completionMessage: "The container was registered." },
}

/** The edit form: the identity, its project held, and — for a container with a placement — the placement's fraction, cadence and a ledger-set end. */
export function containerEditForm(record: BusinessRecord): BusinessFormSchema {
  const values = record.submittedValues ?? {}
  const placed = typeof values.placementId === "string" && values.placementId !== ""
  const ended = typeof values.placementTo === "string" && values.placementTo !== ""
  const placement: BusinessFormField[] = placed
    ? [
        { id: "wasteFraction", label: "Waste fraction", type: "select", required: true, relation: MASTER_DATA_MODULE },
        { id: "serviceFrequencyId", label: "Service frequency", type: "select", relation: MASTER_DATA_MODULE, description: "Blank serves at the product's cadence." },
        ...(ended ? [{ id: "placementTo", label: "Last day in service", type: "date" as const, required: true, description: "Corrects the end the return or decommission set." }] : []),
      ]
    : []
  return {
    ...CONTAINER_FORM,
    title: "Edit container",
    description: `Correct ${record.name}. Its project does not move, and where it stands moves by its commands.`,
    submitLabel: "Save changes",
    sections: [
      { id: "identity", title: "Identity", fields: IDENTITY_FIELDS.map((field) => (field.id === "projectId" ? { ...field, readOnly: true } : field)) },
      ...(placement.length === 0 ? [] : [{ id: "placement", title: "Where it serves", description: "The placement it serves at.", fields: placement }]),
    ],
  }
}

/** The values the edit form opens with: the record's typed values for its fields. */
export function containerFormValues(record: BusinessRecord): BusinessFormValues {
  const fieldIds = new Set(containerEditForm(record).sections.flatMap((section) => section.fields.map((field) => field.id)))
  return Object.fromEntries(Object.entries(record.submittedValues ?? {}).filter(([key, value]) => fieldIds.has(key) && typeof value === "string"))
}

/** A container the create form made: the generic create path's id and kind, so the adapter owns it until the API's answer replaces it. */
export function createContainerRecord(values: BusinessFormValues, { now }: { now: number }): BusinessRecord {
  const label = typeof values.containerId === "string" ? values.containerId.trim() : ""
  return mintedRecord({ id: `resources-container-${now}`, name: label, status: "No stock record", recordKind: "Container", facts: { "Container ID": label }, values })
}

/**
 * A row a Pilot form has just made, before the API has answered: the
 * generic create path's id shape and the form's `recordKind`, which the
 * adapter owns it by (adapter.ts, `ofKind`), its values as its typed ones and
 * its project from them. The API's answer replaces everything but the id.
 */
export function mintedRecord({ id, name, status, recordKind, facts = {}, values }: { id: string; name: string; status: string; recordKind: string; facts?: Record<string, string>; values: BusinessFormValues }): BusinessRecord {
  const projectId = typeof values.projectId === "string" ? values.projectId : ""
  return {
    id,
    name,
    context: "",
    status,
    owner: "",
    value: "",
    updated: "Now",
    description: "",
    facts,
    related: [],
    source: "Waste API",
    freshness: "Now",
    companyId: FIXTURE_COMPANY_ID,
    projectIds: projectId === "" ? [] : [projectId],
    recordKind,
    submittedValues: values,
  }
}

/** An edited container: its identity kept, the form's values over its typed ones. */
export function updateContainerRecord(record: BusinessRecord, values: BusinessFormValues): BusinessRecord {
  const label = typeof values.containerId === "string" && values.containerId.trim() !== "" ? values.containerId.trim() : record.name
  return { ...record, name: label, submittedValues: { ...record.submittedValues, ...values } }
}

// ---------------------------------------------------------------------------
// The command dialogs
// ---------------------------------------------------------------------------

const warehouse = (description?: string): BusinessFormField => ({ id: "warehouseId", label: "Warehouse", type: "select", required: true, relation: WAREHOUSES_MODULE, description })
const occurredAt: BusinessFormField = { id: "occurredAt", label: "When it happened", type: "datetime", description: "Now when blank." }
const reference: BusinessFormField = { id: "reference", label: "Reference", type: "text", placeholder: "A delivery note or a ticket" }
const reason = (required: boolean): BusinessFormField => ({ id: "reason", label: "Reason", type: "textarea", required })
const stockPlace: BusinessFormField = { id: "toKind", label: "Arrives in", type: "select", defaultValue: "warehouse", options: STOCK_PLACES.map((value) => ({ value, label: PLACE_LABELS[value] })) }
const lastDay = (required: boolean, description: string): BusinessFormField => ({ id: "lastDay", label: "Last day in service", type: "date", required, description })

/** One command's dialog. */
const commandForm = (title: string, description: string, submitLabel: string, fields: readonly BusinessFormField[]): BusinessFormSchema => ({
  key: "resources.containers",
  mode: "action",
  recordKind: "Stock movement",
  title,
  description,
  submitLabel,
  sections: [{ id: "command", title, fields }],
  execution: { kind: "append-event", completionMessage: `${title} recorded.` },
})

/** Each command's dialog, its fields the keys its `toBody` reads. */
export const CONTAINER_COMMAND_FORMS: Readonly<Record<OfferedContainerCommand, BusinessFormSchema>> = {
  receive: commandForm("Receive", "The container arrives from a supplier into a warehouse: its first stock record.", "Receive", [warehouse(), occurredAt, reference]),
  issue: commandForm("Issue into service", "The container enters service at a subscription's place from the stock it stands in: the placement and the issue movement together.", "Issue into service", [
    { id: "subscriptionId", label: "Subscription", type: "select", required: true, relation: AGREEMENTS_MODULE, description: "The subscription it serves, at the place the subscription is delivered at." },
    { id: "wasteFractionId", label: "Waste fraction", type: "select", required: true, relation: MASTER_DATA_MODULE },
    { id: "serviceFrequencyId", label: "Service frequency", type: "select", relation: MASTER_DATA_MODULE, description: "Blank serves at the product's cadence." },
    { id: "validFrom", label: "First day in service", type: "date", required: true },
    occurredAt,
    reference,
  ]),
  return: commandForm("Return", "Out of service into stock: the placement ends and the return is recorded together.", "Return", [warehouse(), stockPlace, lastDay(true, "The placement ends after this day."), occurredAt, reason(false), reference]),
  transfer: commandForm("Transfer", "From one place in stock to another, recorded on arrival.", "Transfer", [warehouse("Where it arrives."), stockPlace, occurredAt, reason(false), reference]),
  decommission: commandForm("Decommission", "To scrap, from stock or from service. A retired container does not come back.", "Decommission", [reason(true), lastDay(false, "For a container in service: its placement ends after this day."), occurredAt, reference]),
  adjust: commandForm("Adjust", "The correction door: where the ledger should have the container, never into or out of service.", "Adjust", [
    { id: "toKind", label: "The ledger should have it in", type: "select", required: true, options: ADJUSTMENT_TARGETS.map((value) => ({ value, label: PLACE_LABELS[value] })) },
    { ...warehouse(), required: false, visibleWhen: { fieldId: "toKind", notIn: ["scrap"] }, requiredWhen: { fieldId: "toKind", notIn: ["scrap"] } },
    reason(true),
    { id: "correctsMovementId", label: "Corrects movement", type: "text", description: "The id of the movement this corrects, from the container's ledger." },
    occurredAt,
  ]),
}
