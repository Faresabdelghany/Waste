// The Price Engine's forms on the Pilot (Issue #185, slice 10 of #81, for
// #148): what the customer-money chain's modules offer once they read the
// API — a product's form in Settings › Commercial, a price list's in both
// modes, Add price and a row's edit, Explain price's question, the manual
// event and the event's two commands, Run billing's period, a credit note's
// dialog over an invoice's lines, and a payment's registration, its match
// and a customer's statement (#291 C6) — for the command surfaces
// (components/waste/commands/commercial-surfaces.tsx, billing-surfaces.tsx)
// and the Settings pane to render. Fixture mode keeps the registry's forms.
//
// Every field id here is a key the adapters read (lib/api/records/pricing.ts,
// billing.ts): the form's values go onto the record as its typed values, or
// into a command's input, and the adapter makes the contract's body of them.
// lib/data/__tests__/commercial-forms.test.ts holds the two together through
// the adapters themselves, so a renamed field cannot quietly send nothing.
//
// Relations name another module's row by web id: the project (the
// organisation), the container type, the fraction and the frequency (master
// data, filtered by kind in the dialog), the planning area, the customer
// (contacts), the agreement, the product and the price list. A select is
// never emptied once picked, so an optional one offers None (`NO_ONE`), which
// the record reads as blank (`blankNone`).
import { FREE_DAYS_MAX, HIRE_UNIT } from "@waste/domain/finance/hire"
import { PRODUCT_STATUSES } from "@waste/domain/registry/vocabulary"
import type { InvoiceDetail } from "@waste/contracts/invoices"

import { statusLabel } from "@/lib/api/records/adapter"

import { AGREEMENTS_MODULE } from "./agreements"
import type { BusinessFormField, BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import type { BusinessRecord } from "./business-modules"
import {
  ACCOUNTING_EXPORT_RECORD_KIND,
  BILLING_RUN_RECORD_KIND,
  CANCEL_REASON_LABELS,
  CREDIT_LINE_KEY,
  CREDIT_NOTE_RECORD_KIND,
  CREDIT_REASON_OPTIONS,
  CUSTOMER_KIND_OPTIONS,
  EVENT_RECORD_KIND,
  INVOICES_MODULE,
  OFFICE_CANCEL_REASONS,
  PAYMENT_RECORD_KIND,
  PRICE_LIST_RECORD_KIND,
  PRICE_ROW_RECORD_KIND,
  PRICE_ROWS_MODULE,
  PRODUCT_KIND_OPTIONS,
  PRODUCT_RECORD_KIND,
  PRODUCT_UNIT_OPTIONS,
  PRODUCTS_MODULE,
} from "./commercial"
import { mintedRecord, ORGANISATION_MODULE } from "./containers"
import { MASTER_DATA_MODULE } from "./master-data"
import { PLANNING_AREAS_MODULE } from "./planning-areas"
import { CONTACTS_MODULE, NO_ONE } from "./properties"

/** The form's values with every None (`NO_ONE`) read as blank: what a record carries of an optional pick taken back. */
export function blankNone(values: BusinessFormValues): BusinessFormValues {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === NO_ONE ? "" : value]))
}

export const text = (values: BusinessFormValues, key: string) => (typeof values[key] === "string" ? (values[key] as string).trim() : "")

/** A schema's fields read-only but those named: an edit of what the wire keys on. */
export function editableOnly(schema: BusinessFormSchema, editable: readonly string[], overrides: Partial<BusinessFormSchema>): BusinessFormSchema {
  return {
    ...schema,
    ...overrides,
    sections: schema.sections.map((section) => ({ ...section, fields: section.fields.map((field) => (editable.includes(field.id) ? field : { ...field, readOnly: true })) })),
  }
}

/** The values an edit form opens with: the record's typed values for the form's fields. */
export function formValuesOf(schema: BusinessFormSchema, record: BusinessRecord): BusinessFormValues {
  const fieldIds = new Set(schema.sections.flatMap((section) => section.fields.map((field) => field.id)))
  return Object.fromEntries(Object.entries(record.submittedValues ?? {}).filter(([key, value]) => fieldIds.has(key) && (typeof value === "string" || typeof value === "boolean")))
}

/** An edited row: its identity kept, the form's values over its typed ones. */
export function editedRecord(record: BusinessRecord, values: BusinessFormValues, changes: Partial<BusinessRecord> = {}): BusinessRecord {
  return { ...record, ...changes, submittedValues: { ...record.submittedValues, ...blankNone(values) } }
}

const project: BusinessFormField = { id: "projectId", label: "Project", type: "select", required: true, relation: ORGANISATION_MODULE }
const containerType: BusinessFormField = { id: "containerType", label: "Container type", type: "select", relation: MASTER_DATA_MODULE }
const wasteFraction: BusinessFormField = { id: "wasteFraction", label: "Waste fraction", type: "select", relation: MASTER_DATA_MODULE }
const product = (description?: string): BusinessFormField => ({ id: "productId", label: "Product", type: "select", required: true, relation: PRODUCTS_MODULE, description })
const priceList: BusinessFormField = { id: "priceListId", label: "Price list", type: "select", required: true, relation: PRICE_ROWS_MODULE }
const planningArea: BusinessFormField = { id: "planningAreaId", label: "Zone (planning area)", type: "select", relation: PLANNING_AREAS_MODULE }
const customerKind: BusinessFormField = { id: "customerKind", label: "Customer type", type: "select", options: CUSTOMER_KIND_OPTIONS }
const customer = (label: string, description?: string): BusinessFormField => ({ id: "customerId", label, type: "select", relation: CONTACTS_MODULE, description })

// ---------------------------------------------------------------------------
// Products (Settings › Commercial › Products, on the Pilot)
// ---------------------------------------------------------------------------

export const PRODUCT_FORM: BusinessFormSchema = {
  key: "commercial.products",
  mode: "create",
  recordKind: PRODUCT_RECORD_KIND,
  title: "New product",
  description: "A sellable product of a project's catalogue. Its prices are rows of a price list, added in Price Engine with Add price; its invoice fields are what an invoice line says, and an event of a product without a VAT rate is blocked until it has one.",
  submitLabel: "Create product",
  nameField: "productName",
  sections: [
    {
      id: "identity",
      title: "Product",
      fields: [
        project,
        { id: "productName", label: "Product name", type: "text", required: true, placeholder: "Residual waste · 240L bin" },
        { id: "productType", label: "Type", type: "select", required: true, options: PRODUCT_KIND_OPTIONS },
        { id: "status", label: "Status", type: "select", required: true, defaultValue: "draft", options: PRODUCT_STATUSES.map((value) => ({ value, label: statusLabel(value) })), description: "Only an active product can be subscribed to." },
        { id: "priceUnit", label: "Unit", type: "select", required: true, defaultValue: "pickup", options: PRODUCT_UNIT_OPTIONS, description: "A price row is quoted per this unit." },
        // A hire product's free days (M14 of #293): offered only for a product sold by the day, its hire's unit.
        { id: "freeDays", label: "Free days", type: "number", min: 0, max: FREE_DAYS_MAX, unit: "days", visibleWhen: { fieldId: "priceUnit", equals: HIRE_UNIT }, description: "A container's first days on site, charged nothing before its hire is billed by the day; blank is none." },
      ],
    },
    {
      id: "catalogue",
      title: "What it collects",
      description: "A container collection names its container type and fraction; a service usually leaves them blank.",
      fields: [containerType, wasteFraction, { id: "serviceFrequencyId", label: "Service frequency", type: "select", relation: MASTER_DATA_MODULE, description: "The default cadence a placement may override." }],
    },
    {
      id: "invoicing",
      title: "Invoicing",
      fields: [
        { id: "invoiceName", label: "Invoice name", type: "text", placeholder: "Residual waste collection 240L", description: "What an invoice line calls the product; its name when blank." },
        { id: "invoiceCode", label: "Invoice code", type: "text", placeholder: "RES-240", description: "The code a ledger books it under; unique in the project." },
        { id: "vatPercent", label: "VAT rate", type: "number", min: 0, max: 100, unit: "%", description: "A whole percent; 0 is exempt." },
      ],
    },
  ],
  execution: { kind: "create-record", completionMessage: "The product was created." },
}

/** The product's edit: its project held. */
export const productEditForm = (record: BusinessRecord): BusinessFormSchema =>
  editableOnly(PRODUCT_FORM, ["productName", "productType", "status", "priceUnit", "freeDays", "containerType", "wasteFraction", "serviceFrequencyId", "invoiceName", "invoiceCode", "vatPercent"], {
    title: "Edit product",
    description: `Correct ${record.name}. It stays in its project.`,
    submitLabel: "Save changes",
  })

/** The values a product's edit opens with, its status the wire's token. */
export const productFormValues = (record: BusinessRecord): BusinessFormValues => ({ ...formValuesOf(PRODUCT_FORM, record), status: record.status.toLowerCase() })

/** A product the form made, minted for the session: its status the label of the token picked. */
export function createProductRecord(values: BusinessFormValues, now: number): BusinessRecord {
  const said = blankNone(values)
  return mintedRecord({ id: `products-product-${now}`, name: text(said, "productName"), status: statusLabel(text(said, "status") || "draft"), recordKind: PRODUCT_RECORD_KIND, values: said })
}

/** An edited product: its name and status as the form says them. */
export const updateProductRecord = (record: BusinessRecord, values: BusinessFormValues): BusinessRecord =>
  editedRecord(record, values, { name: text(values, "productName") || record.name, status: statusLabel(text(values, "status") || record.status.toLowerCase()) })

// ---------------------------------------------------------------------------
// Price lists (Settings › Commercial › Price lists, both modes)
// ---------------------------------------------------------------------------

export const PRICE_LIST_FORM: BusinessFormSchema = {
  key: "commercial.price-rows",
  mode: "create",
  recordKind: PRICE_LIST_RECORD_KIND,
  title: "New price list",
  description: "An effective-dated set of price rows: a project's tariff, or a named list an agreement is priced under. Its code and currency are set once, since its rows are quoted in them.",
  submitLabel: "Create price list",
  nameField: "name",
  sections: [
    {
      id: "list",
      title: "Price list",
      fields: [
        project,
        { id: "code", label: "Code", type: "text", required: true, placeholder: "PL-CPH-2027", description: "Letters, digits and single hyphens; set once." },
        { id: "name", label: "Name", type: "text", placeholder: "Copenhagen 2027", description: "The code when blank." },
        { id: "currency", label: "Currency", type: "text", placeholder: "DKK", description: "The project's when blank; a default list is always in it." },
        { id: "isDefault", label: "The project's default list", type: "checkbox", description: "What an agreement without a list of its own is priced under: one per project." },
        { id: "notes", label: "Notes", type: "textarea" },
      ],
    },
    {
      id: "period",
      title: "Effective period",
      fields: [
        { id: "validFrom", label: "Valid from", type: "date", required: true },
        { id: "validTo", label: "Valid to", type: "date", description: "The last day in force; open when blank." },
      ],
    },
  ],
  validationRules: [{ type: "date-order", startField: "validFrom", endField: "validTo", message: "The list ends on or after the day it starts", allowSame: true }],
  execution: { kind: "create-record", completionMessage: "The price list was created." },
}

/** The list's edit: its project, code and currency held. */
export const priceListEditForm = (record: BusinessRecord): BusinessFormSchema =>
  editableOnly(PRICE_LIST_FORM, ["name", "isDefault", "notes", "validFrom", "validTo"], { title: "Edit price list", description: `Correct ${record.name}. Its code and currency stay: its rows are quoted in them.`, submitLabel: "Save changes" })

/** A list's status as a reading of its period on a day, the same reading the adapter makes. */
export function priceListStatusOn(values: BusinessFormValues, day: string): "Scheduled" | "Active" | "Expired" {
  const from = text(values, "validFrom")
  const to = text(values, "validTo")
  if (from !== "" && from > day) return "Scheduled"
  if (to !== "" && to < day) return "Expired"
  return "Active"
}

/** A list the form made: in the browser's bucket in fixture mode, the adapter's to write on the Pilot. */
export function createPriceListRecord(values: BusinessFormValues, { now, day }: { now: number; day: string }): BusinessRecord {
  const said = blankNone(values)
  const name = text(said, "name") || text(said, "code")
  return {
    ...mintedRecord({ id: `price-rows-price-list-${now}`, name, status: priceListStatusOn(said, day), recordKind: PRICE_LIST_RECORD_KIND, facts: { Kind: PRICE_LIST_RECORD_KIND, Code: text(said, "code"), Currency: text(said, "currency") }, values: { ...said, name } }),
    context: `${text(said, "code")}${text(said, "currency") === "" ? "" : ` · ${text(said, "currency")}`}`,
    value: `From ${text(said, "validFrom")}`,
  }
}

/** An edited list: its name and its status as the form leaves them. */
export const updatePriceListRecord = (record: BusinessRecord, values: BusinessFormValues, day: string): BusinessRecord => {
  const edited = editedRecord(record, values)
  return { ...edited, name: text(values, "name") || record.name, status: priceListStatusOn(edited.submittedValues ?? {}, day) }
}

// ---------------------------------------------------------------------------
// Price rows: Add price, a row's edit, Explain price
// ---------------------------------------------------------------------------

export const PRICE_ROW_FORM: BusinessFormSchema = {
  key: "commercial.price-rows",
  mode: "create",
  recordKind: PRICE_ROW_RECORD_KIND,
  title: "Add price",
  description: "One price of a product under a condition set, in a list's currency. Leave every condition blank for the product's default price, the one everyone pays; a customer makes it a negotiated deal, which always wins for them.",
  submitLabel: "Add price",
  sections: [
    {
      id: "price",
      title: "Product and amount",
      fields: [priceList, product(), { id: "amount", label: "Amount", type: "number", required: true, min: 0, description: "Per the product's unit, in the list's currency: 18.50." }, { id: "note", label: "Note", type: "textarea" }],
    },
    {
      id: "conditions",
      title: "Conditions",
      description: "Each condition narrows who pays this amount; they and the start are the row's key, so an edit moves the amount, the note and the end alone.",
      fields: [planningArea, customerKind, containerType, wasteFraction, customer("Negotiated customer", "A deal for this customer alone, which always wins for them.")],
    },
    {
      id: "period",
      title: "Effective period",
      fields: [
        { id: "validFrom", label: "Effective from", type: "date", required: true },
        { id: "validTo", label: "Effective to", type: "date", description: "The last day in force; open when blank. A scheduled change is a second row from the day it starts." },
      ],
    },
  ],
  validationRules: [{ type: "date-order", startField: "validFrom", endField: "validTo", message: "The row ends on or after the day it starts", allowSame: true }],
  execution: { kind: "create-record", completionMessage: "The price was added." },
}

/** A row's edit: its price, its note and its end; its list, product, conditions and start held. */
export const priceRowEditForm = (record: BusinessRecord): BusinessFormSchema =>
  editableOnly(PRICE_ROW_FORM, ["amount", "note", "validTo"], { title: "Edit price", description: `Change ${record.context}'s price for ${record.name}, its note or its end. A different condition or start is another row: end this one and add it.`, submitLabel: "Save changes" })

/** A row Add price made, minted for the session. */
export function createPriceRowRecord(values: BusinessFormValues, now: number): BusinessRecord {
  return mintedRecord({ id: `price-rows-price-row-${now}`, name: "New price", status: "Active", recordKind: PRICE_ROW_RECORD_KIND, values: blankNone(values) })
}

export const EXPLAIN_PRICE_FORM: BusinessFormSchema = {
  key: "commercial.price-rows",
  mode: "action",
  recordKind: "Price question",
  title: "Explain price",
  description: "Which row of a list prices a product on a day, and why every other row lost: give the conditions a pickup would carry. A condition left blank is not asked.",
  submitLabel: "Explain",
  sections: [
    { id: "question", title: "The question", fields: [priceList, product(), { id: "on", label: "On", type: "date", required: true, description: "The service date, or the day you ask about." }] },
    { id: "conditions", title: "Conditions", fields: [planningArea, customerKind, containerType, wasteFraction, customer("Customer", "A negotiated row is eligible for its customer alone.")] },
  ],
  execution: { kind: "preview", completionMessage: "The rows were judged." },
}

// ---------------------------------------------------------------------------
// Billable events
// ---------------------------------------------------------------------------

export const EVENT_FORM: BusinessFormSchema = {
  key: "commercial.events",
  mode: "create",
  recordKind: EVENT_RECORD_KIND,
  title: "Add manual event",
  description: "A billable occurrence the office enters: priced by the agreement's list on the service date, or at a price of your own with the reason for it.",
  submitLabel: "Add manual event",
  sections: [
    {
      id: "event",
      title: "What was delivered",
      fields: [
        { id: "agreementId", label: "Agreement", type: "select", required: true, relation: AGREEMENTS_MODULE, description: "Its payer is invoiced, in its currency." },
        product("An active product of the agreement's project."),
        { id: "quantity", label: "Quantity", type: "number", required: true, min: 1, defaultValue: "1", description: "In the product's unit." },
        { id: "serviceDate", label: "Service date", type: "date", required: true },
        { id: "note", label: "Note", type: "textarea" },
      ],
    },
    {
      id: "override",
      title: "A price of your own",
      description: "Leave both blank for the list's price; give both or neither.",
      fields: [
        { id: "unitPrice", label: "Unit price", type: "number", min: 0, description: "In the agreement's currency: 300.00." },
        { id: "overrideReason", label: "Why this price", type: "text", requiredWhen: { fieldId: "unitPrice", hasValue: true } },
      ],
    },
  ],
  execution: { kind: "create-record", completionMessage: "The event was added." },
}

/** A manual event the form made, minted for the session. */
export function createEventRecord(values: BusinessFormValues, now: number): BusinessRecord {
  return mintedRecord({ id: `events-billable-event-${now}`, name: "Manual event", status: "Ready", recordKind: EVENT_RECORD_KIND, values: blankNone(values) })
}

/** The commands of an event the dialogs offer, in order. */
export const EVENT_COMMANDS = ["reprice", "cancel", "hold", "release"] as const
export type EventCommand = (typeof EVENT_COMMANDS)[number]

export const EVENT_COMMAND_FORMS: Readonly<Record<EventCommand, BusinessFormSchema>> = {
  reprice: {
    key: "commercial.events",
    mode: "action",
    recordKind: EVENT_RECORD_KIND,
    title: "Reprice",
    description: "Price a blocked event again, once what blocked it is put right: a price row added, a VAT rate set, an agreement signed. A ticket's event takes the product you pick here; any other kind is repriced as it stands.",
    submitLabel: "Reprice",
    sections: [{ id: "command", title: "Reprice", fields: [{ ...product("Only for a ticket's event, which came without one."), required: false }] }],
    execution: { kind: "append-event", completionMessage: "The event was priced again." },
  },
  cancel: {
    key: "commercial.events",
    mode: "action",
    recordKind: EVENT_RECORD_KIND,
    title: "Cancel event",
    description: "A ready or blocked event that should never be invoiced. It stays in the list, cancelled, with your reason.",
    submitLabel: "Cancel event",
    sections: [
      {
        id: "command",
        title: "Cancel event",
        fields: [
          { id: "reason", label: "Reason", type: "select", required: true, options: OFFICE_CANCEL_REASONS.map((value) => ({ value, label: CANCEL_REASON_LABELS[value] })) },
          { id: "note", label: "Note", type: "textarea" },
        ],
      },
    ],
    execution: { kind: "append-event", completionMessage: "The event was cancelled." },
  },
  hold: {
    key: "commercial.events",
    mode: "action",
    recordKind: EVENT_RECORD_KIND,
    title: "Hold for review",
    description: "Keep a ready event off the next invoice while you check it (M14 of #293): a run passes over it until you release it.",
    submitLabel: "Hold for review",
    sections: [{ id: "command", title: "Hold for review", fields: [{ id: "reason", label: "Why it is held", type: "textarea", required: true, placeholder: "Waiting for the driver's photo of the skip" }] }],
    execution: { kind: "append-event", completionMessage: "The event is held for review." },
  },
  release: {
    key: "commercial.events",
    mode: "action",
    recordKind: EVENT_RECORD_KIND,
    title: "Release to billing",
    description: "The event is ready again, for the next run whose period it falls in.",
    submitLabel: "Release to billing",
    sections: [{ id: "command", title: "Release to billing", fields: [] }],
    execution: { kind: "append-event", completionMessage: "The event is ready again." },
  },
}

// ---------------------------------------------------------------------------
// Billing runs
// ---------------------------------------------------------------------------

export const RUN_BILLING_FORM: BusinessFormSchema = {
  key: "commercial.billing",
  mode: "action",
  recordKind: BILLING_RUN_RECORD_KIND,
  title: "Run billing",
  description: "Invoice a project's ready events with service dates in a period, one invoice per payer and currency. You see what it would do first; nothing is written until you run it. The monthly schedule stays the backstop.",
  submitLabel: "Preview",
  sections: [
    {
      id: "run",
      title: "Run billing",
      fields: [
        project,
        { id: "periodFrom", label: "First day", type: "date", required: true },
        { id: "periodTo", label: "Last day", type: "date", required: true },
        { id: "note", label: "Note", type: "textarea" },
      ],
    },
  ],
  validationRules: [{ type: "date-order", startField: "periodFrom", endField: "periodTo", message: "The last day comes on or after the first", allowSame: true }],
  execution: { kind: "preview", completionMessage: "The run was previewed." },
}

/** A run Run billing asked for, minted for the session: the API runs it in the request and answers it completed. */
export function createBillingRunRecord(values: BusinessFormValues, now: number): BusinessRecord {
  return mintedRecord({ id: `billing-billing-run-${now}`, name: `Billing run ${text(values, "periodFrom")} – ${text(values, "periodTo")}`, status: "Requested", recordKind: BILLING_RUN_RECORD_KIND, values: blankNone(values) })
}

// ---------------------------------------------------------------------------
// Accounting exports
// ---------------------------------------------------------------------------

/** Export period (#291 C7): the project and the booking period, previewed before anything is written, as Run billing is. */
export const EXPORT_PERIOD_FORM: BusinessFormSchema = {
  key: "commercial.accounting",
  mode: "action",
  recordKind: ACCOUNTING_EXPORT_RECORD_KIND,
  title: "Export period",
  description: "Book a period's invoices, credit notes and payments to the project's chart of accounts, as a file for the office's bookkeeping. Each row is booked once, ever: a period exported again books only what arrived since, on its own day. You see what it would book first.",
  submitLabel: "Preview",
  sections: [
    {
      id: "export",
      title: "Export period",
      fields: [
        project,
        { id: "periodFrom", label: "First day", type: "date", required: true },
        { id: "periodTo", label: "Last day", type: "date", required: true, description: "Today at the latest: an export is of a closed period." },
        { id: "note", label: "Note", type: "textarea" },
      ],
    },
  ],
  validationRules: [{ type: "date-order", startField: "periodFrom", endField: "periodTo", message: "The last day comes on or after the first", allowSame: true }],
  execution: { kind: "preview", completionMessage: "The export was previewed." },
}

/** The export the store creates once its preview is confirmed. */
export function createAccountingExportRecord(values: BusinessFormValues, now: number): BusinessRecord {
  return mintedRecord({ id: `commercial-accounting-export-${now}`, name: `Export ${text(values, "periodFrom")} – ${text(values, "periodTo")}`, status: "Requested", recordKind: ACCOUNTING_EXPORT_RECORD_KIND, values: blankNone(values) })
}

// ---------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------

/** The field a line's credited quantity is typed under. */
export const creditLineField = (lineId: string) => `${CREDIT_LINE_KEY}${lineId}`

/** What remains to credit of each line of an invoice: its quantity less what its credit notes credited, none of a reversal's line. */
export function remainingByLine(detail: Pick<InvoiceDetail, "lines">, creditNotes: readonly Pick<InvoiceDetail, "lines">[]): Map<string, number> {
  const credited = new Map<string, number>()
  for (const note of creditNotes) for (const line of note.lines) if (line.creditsLineId !== null) credited.set(line.creditsLineId, (credited.get(line.creditsLineId) ?? 0) + line.quantity)
  return new Map(detail.lines.map((line) => [line.id, line.netMinor < 0 ? 0 : Math.max(0, line.quantity - (credited.get(line.id) ?? 0))]))
}

/** The credit note's dialog over one invoice: the reason, a note, and every line or the named lines by quantity, each held to what remains of it. */
export function creditNoteForm(invoice: Pick<BusinessRecord, "name">, detail: Pick<InvoiceDetail, "lines">, remaining: ReadonlyMap<string, number>): BusinessFormSchema {
  const lines: BusinessFormField[] = detail.lines
    .filter((line) => (remaining.get(line.id) ?? 0) > 0)
    .map((line) => ({
      id: creditLineField(line.id),
      label: `Line ${line.position} · ${line.description}`,
      type: "number" as const,
      min: 1,
      max: remaining.get(line.id),
      description: `${remaining.get(line.id)} of ${line.quantity} left to credit. Blank credits none of it.`,
      visibleWhen: { fieldId: "scope", equals: "lines" },
    }))
  return {
    key: "commercial.invoices",
    mode: "action",
    recordKind: CREDIT_NOTE_RECORD_KIND,
    title: "New credit note",
    description: `Correct ${invoice.name} by quantity: every line by what remains of it, or the lines you name. The events behind the lines stay invoiced; what should have been charged instead is a new event.`,
    submitLabel: "Issue credit note",
    sections: [
      {
        id: "credit",
        title: "Credit note",
        fields: [
          { id: "reason", label: "Reason", type: "select", required: true, options: CREDIT_REASON_OPTIONS },
          { id: "note", label: "Note", type: "textarea" },
          {
            id: "scope",
            label: "What it credits",
            type: "select",
            required: true,
            defaultValue: "all",
            options: [
              { value: "all", label: "Every line, by what remains of it" },
              { value: "lines", label: "The lines I name" },
            ],
          },
        ],
      },
      ...(lines.length === 0 ? [] : [{ id: "lines", title: "Lines", fields: lines }]),
    ],
    execution: { kind: "create-record", completionMessage: "The credit note was issued." },
  }
}

/** A credit note the dialog made against an invoice, minted for the session. */
export function createCreditNoteRecord(invoice: BusinessRecord, values: BusinessFormValues, now: number): BusinessRecord {
  return {
    ...mintedRecord({ id: `invoices-credit-note-${now}`, name: `Credit note for ${invoice.name}`, status: "Credit note", recordKind: CREDIT_NOTE_RECORD_KIND, values: { ...blankNone(values), creditsInvoiceId: invoice.id } }),
    projectIds: invoice.projectIds,
  }
}

// ---------------------------------------------------------------------------
// Payments (#291 C6)
// ---------------------------------------------------------------------------

const invoicePaid = (description: string): BusinessFormField => ({ id: "invoiceId", label: "Invoice", type: "select", relation: INVOICES_MODULE, description })

/** Register payment: money as it arrived, paid at the counter or read off the bank's site. */
export const PAYMENT_FORM: BusinessFormSchema = {
  key: "commercial.payments",
  mode: "create",
  recordKind: PAYMENT_RECORD_KIND,
  title: "Register payment",
  description: "Record money as it arrived. The invoice it pays is paid what it owes at most; the rest stays a credit on the payer's balance. A payment is never edited: undo a wrong match by its reversal.",
  submitLabel: "Register payment",
  sections: [
    {
      id: "payment",
      title: "Payment",
      fields: [
        project,
        invoicePaid("Optional: an invoice of the project. Without one, the payment waits unmatched."),
        customer("Payer", "Optional: the invoice's payer where an invoice is named."),
        { id: "amount", label: "Amount", type: "number", required: true, min: 0, description: "In the invoice's currency, else the project's." },
        { id: "paidOn", label: "Paid on", type: "date", required: true },
        { id: "reference", label: "Payer's reference", type: "text", placeholder: "+71<000000260071881+85123456<" },
        { id: "note", label: "Note", type: "textarea" },
      ],
    },
  ],
  execution: { kind: "create-record", completionMessage: "The payment was registered." },
}

/** A payment the dialog registered, minted for the session. */
export function createPaymentRecord(values: BusinessFormValues, now: number): BusinessRecord {
  return mintedRecord({ id: `payments-payment-${now}`, name: "Payment", status: "Unmatched", recordKind: PAYMENT_RECORD_KIND, values: blankNone(values) })
}

/** Match: what remains of a payment, or part of it, applied to one invoice of its project. */
export function allocateForm(payment: BusinessRecord): BusinessFormSchema {
  const remaining = payment.facts.Unallocated ?? ""
  return {
    key: "commercial.payments",
    mode: "action",
    recordKind: PAYMENT_RECORD_KIND,
    title: "Match to invoice",
    description: `Apply ${remaining === "" ? "the payment" : `up to ${remaining}`} to an invoice of the payment's project, at most what it owes.`,
    submitLabel: "Match",
    sections: [
      {
        id: "allocation",
        title: "Match",
        fields: [
          { ...invoicePaid("An invoice of the payment's project, in its currency."), required: true },
          { id: "amount", label: "Amount", type: "number", min: 0, description: "Blank applies all that remains." },
        ],
      },
    ],
    execution: { kind: "append-event", completionMessage: "The payment was matched." },
  }
}

/** Import bank statement's first question: the project the lines that match nothing land in. */
export const BANK_IMPORT_FORM: BusinessFormSchema = {
  key: "commercial.payments",
  mode: "action",
  recordKind: PAYMENT_RECORD_KIND,
  title: "Import bank statement",
  description: "A line that pays an invoice lands in that invoice's project; a line that matches nothing waits unmatched in the project you pick here.",
  submitLabel: "Choose the file",
  sections: [{ id: "import", title: "Import bank statement", fields: [project] }],
  execution: { kind: "preview", completionMessage: "The statement was read." },
}

/** A customer's statement: one currency over a window of days. */
export const STATEMENT_FORM: BusinessFormSchema = {
  key: "customers.contacts",
  mode: "action",
  recordKind: "Statement",
  title: "Statement",
  description: "The customer's invoices, credit notes and payments over the days you pick, from the balance before them to the balance after.",
  submitLabel: "Show statement",
  sections: [
    {
      id: "window",
      title: "Statement",
      fields: [
        { id: "currency", label: "Currency", type: "text", required: true, defaultValue: "DKK" },
        { id: "from", label: "First day", type: "date", required: true },
        { id: "to", label: "Last day", type: "date", required: true },
      ],
    },
  ],
  validationRules: [{ type: "date-order", startField: "from", endField: "to", message: "The last day comes on or after the first", allowSame: true }],
  execution: { kind: "preview", completionMessage: "The statement was read." },
}
