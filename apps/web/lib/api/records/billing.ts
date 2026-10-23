// The Price Engine's money on the prototype's records (Issue #185, slice 10
// of #81, for #148): Billable Events (`@waste/contracts/billable-events`,
// routes apps/api/src/routes/billable-events.ts) as `commercial.events`,
// Billing Runs (`billing.ts`, routes billing-runs.ts) as `commercial.billing`,
// and Invoices with their Credit Notes (`invoices.ts`, routes invoices.ts) as
// `commercial.invoices`. The contracts are imported as types only, so no zod
// reaches the bundle; the two sentences a body is refused in by a contract's
// own rule are spelled again here and held equal by the test.
//
// An event names its agreement (customers.agreements), its product (the
// products above it), its route (route-studio.routes) and the ticket it came
// of, by web id on the record; its payer is the agreement's, and its money is
// frozen in its own currency once priced. Its status is a reading the server
// answers on every read and takes on no write, so the adapter lists no
// `statuses`, refuses every patch, and the event moves by its two commands:
// `reprice`, the resolver again over a blocked event (a ticket's event taking
// the product the office picked), and `cancel`, with the office's reason —
// never the consumer's `pickup-corrected`. The manual event is the one create:
// an agreement and a product of its project, a quantity, a service date, and
// the resolver's price or a person's own in the agreement's currency with the
// reason for it.
//
// A billing run is a record of what it did: one create, which runs in the
// request, and nothing changed after. Its body is spelled once
// (`billingRunBody`), for the run and for the preview Run billing asks first
// (`previewBillingRun`), which writes nothing and so goes through the client
// rather than the store; the surface reads the events and the invoices again
// once a run has landed, since a run invoices the one and issues the other.
//
// An invoice is issued and never changed: every edit is refused, and the one
// write is a credit note — a create in this module, a record of kind Credit
// note naming the invoice it corrects, posted under it (`POST /invoices/:id/
// credit-notes`), crediting every line by what remains of it or the named
// lines by quantity, never by amount. The one list read holds both kinds, so
// an invoice is read as credited by the credit notes that name it in that
// same read: Issued, Partially credited, or Credited where they give back the
// whole of it.
//
// Ids, rule (b) of #81's plan: `event-<uuid>`, `billing-run-<uuid>`, and
// `invoice-<uuid>` or `credit-note-<uuid>` by the document's kind; no fixture
// lends its id.
import type { BillableEvent } from "@waste/contracts/billable-events"
import type { BillingRunCreate, BillingRunDetail, BillingRun, BillingRunPreview } from "@waste/contracts/billing"
import type { Invoice, InvoiceDetail } from "@waste/contracts/invoices"
import { CREDIT_REASONS } from "@waste/domain/finance/vocabulary"

import { formatMinor, majorOf, minorOf } from "@/lib/commercial/money"
import { isAgreementRecord } from "@/lib/data/agreements"
import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import {
  BILLING_MODULE,
  BILLING_RUN_PREFIX,
  BILLING_RUN_RECORD_KIND,
  BLOCK_REASON_LABELS,
  CANCEL_REASON_LABELS,
  CREDIT_NOTE_PREFIX,
  CREDIT_NOTE_RECORD_KIND,
  CREDIT_REASON_LABELS,
  EVENT_KIND_LABELS,
  EVENT_PREFIX,
  EVENT_RECORD_KIND,
  EVENTS_MODULE,
  INVOICE_PREFIX,
  INVOICE_RECORD_KIND,
  INVOICES_MODULE,
  isBillingRunRecord,
  isEventRecord,
  isInvoiceDocument,
  isProductRecord,
  OFFICE_CANCEL_REASONS,
  PRODUCT_PREFIX,
} from "@/lib/data/commercial"

import { command, create, get, listAll } from "../client"
import { inheritedPresentation, NOTHING_RESOLVED, said, stampFacts, statusLabel, typed, webIdOf, type Client, type LocalRefusal, type MappingContext, type Resolver, type ResourceAdapter, type ServerModule } from "./adapter"
import { shownOn } from "./clock"
import { referenced, refusal } from "./places"
import { nameVia, referencedServerId } from "./references"

/** What a body giving a price of its own without a reason, or a reason without a price, is told (`@waste/contracts/billable-events`, `OVERRIDE_WITH_A_REASON`). */
export const OVERRIDE_WITH_A_REASON = "Give the reason with a price of your own, and neither without the other"
/** What a period whose last day comes before its first is told (`@waste/contracts/billing`, `PERIOD_ORDERED`). */
export const PERIOD_ORDERED = "periodTo is the last day of the period, so it comes on or after periodFrom"
export const QUANTITY_REFUSAL = "A quantity is a whole number, 1 or more"
/** What an edit of an event is told: it moves by its commands. */
export const EVENT_MOVES_BY_COMMAND = "A billable event moves by its commands: reprice a blocked one, cancel one that should not be invoiced"
/** What an edit of a run is told. */
export const RUN_NEVER_CHANGES = "A billing run is a record of what it did: nothing on it changes"
/** What an edit of an invoice or a credit note is told. */
export const DOCUMENT_NEVER_CHANGES = "An issued document never changes: correct an invoice with a credit note"

/** The key of the first typed value an edit moved — the field a refusal names — or `status` for a move of the status alone. */
function firstMoved(before: BusinessRecord, after: BusinessRecord): string {
  const was = before.submittedValues ?? {}
  const is = after.submittedValues ?? {}
  return Object.keys({ ...was, ...is }).find((key) => JSON.stringify(was[key]) !== JSON.stringify(is[key])) ?? "status"
}

/** A form's count: the number for a whole one of 1 or more, NaN for anything else. */
function countOf(value: string | undefined): number {
  const number = Number(value)
  return value !== undefined && Number.isInteger(number) && number > 0 ? number : Number.NaN
}

const amountRefusal = (path: string, currency: string) => refusal(path, `An amount in ${currency}, such as ${majorOf(1850, currency)}`)

/** A loaded record a server id names, its web id and name; the chip where nothing loaded carries it. */
const named = (context: MappingContext, prefix: string, serverId: string | null) => {
  if (serverId === null) return undefined
  const row = referenced(context, prefix, serverId)
  return { id: row.webId, name: row.name ?? row.webId }
}

/** The project's currency and timezone, from the organisation the store loaded. */
function projectOf(context: MappingContext, projectServerId: string) {
  const project = referenced(context, "project", projectServerId)
  const record = context.resolve.byServerId(projectServerId)
  return { webId: project.webId, name: project.name ?? project.webId, currency: record === undefined ? undefined : typed(record, "currency"), timezone: record === undefined ? undefined : typed(record, "timezone") }
}

// ---------------------------------------------------------------------------
// Billable events
// ---------------------------------------------------------------------------

/** Where an event came from, as a person reads it. */
function originOf(event: BillableEvent, context: MappingContext): string {
  switch (event.kind) {
    case "pickup":
      return "Completed pickup"
    case "ticket":
      return "Resolved ticket"
    case "reversal":
      return "Reversal of an invoiced event"
    case "manual":
      return event.createdBy === null ? "Entered by a person" : `Entered by ${nameVia(context, "user", event.createdBy)}`
  }
}

export const billableEventAdapter: ResourceAdapter<BillableEvent> = {
  prefix: EVENT_PREFIX,
  owns: isEventRecord,
  // A reading, answered on every read and taken on no write: every status move is refused, and the event moves by command.
  statuses: undefined,
  list: (client) => listAll<BillableEvent>(client, "/billable-events"),
  read: (client, serverId) => get<BillableEvent>(client, `/billable-events/${serverId}`),
  toRecord: (event, context) => {
    const project = projectOf(context, event.projectId)
    // The agreement's row, from the module loaded before; its payer is the event's customer.
    const agreement = event.agreementId === null ? undefined : context.resolve.byServerId(event.agreementId)
    const agreementId = event.agreementId === null ? undefined : (agreement?.id ?? webIdOf("agreement", event.agreementId))
    const agreementNumber = agreement === undefined ? agreementId : (typed(agreement, "agreementNumber") ?? agreement.name)
    const payerName = agreement?.facts.Payer
    const payerId = agreement === undefined ? undefined : typed(agreement, "payerId")
    const product = named(context, PRODUCT_PREFIX, event.productId)
    const route = named(context, "route", event.links.routeId)
    const ticket = named(context, "ticket", event.links.ticketId)
    const money = (minor: number | null) => (minor === null || event.currency === null ? undefined : formatMinor(minor, event.currency))
    const net = money(event.netMinor)
    const block = event.blockReason === null ? undefined : BLOCK_REASON_LABELS[event.blockReason]
    const timezone = project.timezone
    return {
      id: webIdOf(EVENT_PREFIX, event.id),
      name: `${EVENT_KIND_LABELS[event.kind]} · ${product?.name ?? "no product"}`,
      context: `${payerName ?? agreementNumber ?? "No agreement"} · ${event.serviceDate}`,
      status: statusLabel(event.status),
      ...inheritedPresentation(undefined),
      ...stampFacts(event, context.now),
      value: net ?? block ?? "",
      description: block === undefined ? `A ${EVENT_KIND_LABELS[event.kind].toLowerCase()} event of ${event.serviceDate}.` : `Blocked: ${block}. ${event.status === "blocked" ? "Reprice it once what blocks it is put right, or cancel it." : ""}`.trim(),
      facts: {
        Kind: EVENT_KIND_LABELS[event.kind],
        "Service date": event.serviceDate,
        ...(agreementNumber === undefined ? {} : { Agreement: agreementNumber }),
        ...(payerName === undefined ? {} : { Customer: payerName }),
        ...(product === undefined ? {} : { Product: product.name }),
        Quantity: String(event.quantity),
        ...(money(event.unitPriceMinor) === undefined ? {} : { "Unit price": money(event.unitPriceMinor)! }),
        ...(net === undefined ? {} : { Net: net }),
        ...(event.vatPercent === null || money(event.vatMinor) === undefined ? {} : { VAT: `${event.vatPercent}% · ${money(event.vatMinor)}` }),
        ...(event.currency === null ? {} : { Currency: event.currency }),
        ...(block === undefined ? {} : { "Block reason": block }),
        ...(route === undefined ? {} : { Route: route.name }),
        ...(ticket === undefined ? {} : { Ticket: ticket.name }),
        Origin: originOf(event, context),
        ...(event.overrideReason === null ? {} : { "Override reason": event.overrideReason }),
        ...(event.note === null ? {} : { Note: event.note }),
        ...(event.cancelledAt === null ? {} : { Cancelled: `${shownOn(event.cancelledAt, timezone)}${event.cancelReason === null ? "" : ` · ${CANCEL_REASON_LABELS[event.cancelReason]}`}` }),
        Invoiced: event.invoiceLineId === null ? "Not yet" : "On an invoice line",
      },
      related: [agreement?.name, product?.name, route?.name].filter((part): part is string => part !== undefined),
      allowedTransitions: [],
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: EVENT_RECORD_KIND,
      submittedValues: {
        projectId: project.webId,
        kind: event.kind,
        ...(agreementId === undefined ? {} : { agreementId }),
        ...(payerId === undefined ? {} : { payerId }),
        ...(product === undefined ? {} : { productId: product.id }),
        ...(route === undefined ? {} : { routeId: route.id }),
        ...(ticket === undefined ? {} : { ticketId: ticket.id }),
        ...(event.blockReason === null ? {} : { blockReason: event.blockReason }),
        quantity: String(event.quantity),
        serviceDate: event.serviceDate,
        ...(event.note === null ? {} : { note: event.note }),
      },
    }
  },
  toCreateBody: (record, context) => {
    // The agreement is a switched module's row: the store's resolver alone names it, and it lends the event its project and its currency.
    const agreementWebId = typed(record, "agreementId")
    const agreementId = agreementWebId === undefined ? undefined : context.resolve.serverIdOf(agreementWebId)
    const agreement = agreementId === undefined ? undefined : context.resolve.byServerId(agreementId)
    if (agreementId === undefined || agreement === undefined || !isAgreementRecord(agreement)) return refusal("agreementId", "Pick an agreement the API holds")
    const projectWebId = typed(agreement, "projectId") ?? agreement.projectIds?.[0]
    const projectId = projectWebId === undefined ? undefined : context.resolve.serverIdOf(projectWebId)
    if (projectId === undefined) return refusal("agreementId", "The agreement's project is not one the API holds")
    const productWebId = typed(record, "productId")
    const productId = productWebId === undefined ? undefined : referencedServerId(productWebId, PRODUCT_PREFIX, context, { owns: isProductRecord })
    if (productId === undefined) return refusal("productId", "Pick a product the API holds")
    const quantityText = typed(record, "quantity")
    const quantity = quantityText === undefined ? 1 : countOf(quantityText)
    if (Number.isNaN(quantity)) return refusal("quantity", QUANTITY_REFUSAL)
    const serviceDate = typed(record, "serviceDate")
    if (serviceDate === undefined) return refusal("serviceDate", "Pick the service date")
    const price = typed(record, "unitPrice")
    const overrideReason = typed(record, "overrideReason")
    if ((price === undefined) !== (overrideReason === undefined)) return refusal("overrideReason", OVERRIDE_WITH_A_REASON)
    const currency = typed(agreement, "currency") ?? "DKK"
    const unitPriceMinor = price === undefined ? undefined : minorOf(price, currency)
    if (Number.isNaN(unitPriceMinor)) return amountRefusal("unitPrice", currency)
    const note = typed(record, "note")
    return {
      projectId,
      agreementId,
      productId,
      quantity,
      serviceDate,
      ...(note === undefined ? {} : { note }),
      ...(unitPriceMinor === undefined ? {} : { unitPriceMinor, overrideReason }),
    }
  },
  toPatchBody: (before, after) => refusal(firstMoved(before, after), EVENT_MOVES_BY_COMMAND),
  create: (client, body) => create<BillableEvent>(client, "/billable-events", body).then((created) => created.body),
  // Never reached: every patch is refused above, since the wire has no patch route for an event.
  update: () => Promise.reject(new Error("A billable event has no patch route")),
  commands: {
    reprice: {
      // A ticket's event takes the product the office picked; any other kind is repriced as it stands, the API refusing a product it does not take.
      toBody: (input, _record, context) => {
        const productWebId = said(input, "productId")
        if (productWebId === undefined) return {}
        const productId = referencedServerId(productWebId, PRODUCT_PREFIX, context, { owns: isProductRecord })
        return productId === undefined ? refusal("productId", "Pick a product the API holds") : { productId }
      },
      run: (client, serverId, body) => command<BillableEvent>(client, `/billable-events/${serverId}/reprice`, body),
      refused: (record) => `${record.name} was not repriced`,
    },
    cancel: {
      toBody: (input) => {
        const reason = OFFICE_CANCEL_REASONS.find((candidate) => candidate === said(input, "reason"))
        if (reason === undefined) return refusal("reason", "Pick a reason")
        const note = said(input, "note")
        return { reason, ...(note === undefined ? {} : { note }) }
      },
      run: (client, serverId, body) => command<BillableEvent>(client, `/billable-events/${serverId}/cancel`, body),
      refused: (record) => `${record.name} was not cancelled`,
    },
  },
}

/** Price Engine › Billable Events. */
export const eventsModule: ServerModule = { workspaceId: EVENTS_MODULE.workspaceId, moduleId: EVENTS_MODULE.moduleId, resources: [billableEventAdapter] }

// ---------------------------------------------------------------------------
// Billing runs
// ---------------------------------------------------------------------------

/**
 * The project and the period a run, or its preview, is asked over: the one
 * body of both requests, from the Run billing form's values, or the field the
 * API would refuse — a period running backwards in the contract's words.
 */
export function billingRunBody(values: BusinessFormValues, resolve: Resolver = NOTHING_RESOLVED): BillingRunCreate | LocalRefusal {
  const record = { submittedValues: values } as BusinessRecord
  const projectWebId = typed(record, "projectId")
  const projectId = projectWebId === undefined ? undefined : resolve.serverIdOf(projectWebId)
  if (projectId === undefined) return refusal("projectId", "Pick a project")
  const periodFrom = typed(record, "periodFrom")
  if (periodFrom === undefined) return refusal("periodFrom", "Pick the first day of the period")
  const periodTo = typed(record, "periodTo")
  if (periodTo === undefined) return refusal("periodTo", "Pick the last day of the period")
  if (periodTo < periodFrom) return refusal("periodTo", PERIOD_ORDERED)
  const note = typed(record, "note")
  return { projectId, periodFrom, periodTo, ...(note === undefined ? {} : { note }) }
}

/** `POST /billing-runs/preview`: what a run over the period would do — the counts, the totals per currency, the payers it would exclude — writing nothing. */
export function previewBillingRun(client: Client, body: BillingRunCreate): Promise<BillingRunPreview> {
  return command<BillingRunPreview>(client, "/billing-runs/preview", body)
}

/** `GET /billing-runs/:id`: the run with its exclusions and the invoices it issued. */
export function billingRunDetail(client: Client, serverId: string): Promise<BillingRunDetail> {
  return get<BillingRunDetail>(client, `/billing-runs/${serverId}`)
}

export const billingRunAdapter: ResourceAdapter<BillingRun> = {
  prefix: BILLING_RUN_PREFIX,
  owns: isBillingRunRecord,
  statuses: undefined,
  list: (client) => listAll<BillingRun>(client, "/billing-runs"),
  read: billingRunDetail,
  toRecord: (run, context) => {
    const project = projectOf(context, run.projectId)
    const period = `${run.periodFrom} – ${run.periodTo}`
    // The totals as completed, over every currency the run touched; the project's is the Pilot's one currency, and the run's details read the invoices for a figure per currency.
    const money = (minor: number) => (project.currency === undefined ? majorOf(minor, "DKK") : formatMinor(minor, project.currency))
    return {
      id: webIdOf(BILLING_RUN_PREFIX, run.id),
      name: `Billing run ${period}`,
      context: `${project.name} · ${run.eventCount} event${run.eventCount === 1 ? "" : "s"}`,
      status: statusLabel(run.status),
      ...inheritedPresentation(undefined),
      ...stampFacts(run, context.now),
      value: `${run.invoiceCount} invoice${run.invoiceCount === 1 ? "" : "s"}`,
      description: `The ready events of ${project.name} with service dates ${period}, bundled per payer.`,
      facts: {
        Project: project.name,
        Period: period,
        Events: String(run.eventCount),
        Invoices: String(run.invoiceCount),
        "Excluded customers": String(run.excludedCustomerCount),
        Net: money(run.netMinor),
        VAT: money(run.vatMinor),
        "Requested by": run.requestedBy === null ? "The monthly schedule" : nameVia(context, "user", run.requestedBy),
        ...(run.completedAt === null ? {} : { Completed: shownOn(run.completedAt, project.timezone) }),
        ...(run.note === null ? {} : { Note: run.note }),
      },
      allowedTransitions: [],
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: BILLING_RUN_RECORD_KIND,
      submittedValues: { projectId: project.webId, periodFrom: run.periodFrom, periodTo: run.periodTo, ...(run.note === null ? {} : { note: run.note }) },
    }
  },
  toCreateBody: (record, context) => billingRunBody(record.submittedValues ?? {}, context.resolve),
  toPatchBody: (before, after) => refusal(firstMoved(before, after), RUN_NEVER_CHANGES),
  create: (client, body) => create<BillingRunDetail>(client, "/billing-runs", body).then((created) => created.body),
  update: () => Promise.reject(new Error("A billing run has no patch route")),
}

/** Price Engine › Billing Runs. */
export const billingModule: ServerModule = { workspaceId: BILLING_MODULE.workspaceId, moduleId: BILLING_MODULE.moduleId, resources: [billingRunAdapter] }

// ---------------------------------------------------------------------------
// Invoices and credit notes
// ---------------------------------------------------------------------------

/**
 * A document as the module reads it: a ledger row, stamped with its
 * `recordedAt` as both of a resource's stamps (containers.ts' `ledgerRow`),
 * and an invoice carrying what the credit notes naming it give back, read off
 * the same list (or its detail's credit notes).
 */
export type InvoiceResource = (Invoice | InvoiceDetail) & { createdAt: string; updatedAt: string; creditedGrossMinor?: number; creditNoteCount?: number }

/** A document with a resource's stamps: issued once, so created and updated when it was recorded. */
const stamped = <Document extends Invoice | InvoiceDetail>(document: Document): Document & { createdAt: string; updatedAt: string } => ({ ...document, createdAt: document.recordedAt, updatedAt: document.recordedAt })

/** What a credit note's create carries: the invoice it is posted under, and the body the contract accepts. */
type CreditNoteWrite = { invoiceId: string; body: unknown }

/** Where an invoice stands against the credit notes naming it: none, some of it, or all of it given back. */
function creditStandingOf(document: InvoiceResource): { status: "Issued" | "Partially credited" | "Credited"; count: number } {
  const notes = "creditNotes" in document ? document.creditNotes : undefined
  const credited = notes === undefined ? (document.creditedGrossMinor ?? 0) : notes.reduce((sum, note) => sum + note.grossMinor, 0)
  const count = notes === undefined ? (document.creditNoteCount ?? 0) : notes.length
  if (count === 0) return { status: "Issued", count }
  return { status: document.grossMinor + credited <= 0 ? "Credited" : "Partially credited", count }
}

/** `GET /invoices/:id`: the document with its lines by position and the credit notes naming it. */
export function invoiceDetail(client: Client, serverId: string): Promise<InvoiceDetail> {
  return get<InvoiceDetail>(client, `/invoices/${serverId}`)
}

/** The prefix of the line keys a partial credit's form names a quantity under: `line:<uuid>`. */
export const CREDIT_LINE_KEY = "line:"

export const invoiceAdapter: ResourceAdapter<InvoiceResource> = {
  prefix: INVOICE_PREFIX,
  owns: isInvoiceDocument,
  statuses: undefined,
  // Both kinds in one read: an invoice is read as credited by the credit notes naming it there.
  list: async (client) => {
    const documents = await listAll<Invoice>(client, "/invoices")
    const credits = new Map<string, { gross: number; count: number }>()
    for (const document of documents) {
      if (document.creditsInvoiceId === null) continue
      const credit = credits.get(document.creditsInvoiceId) ?? { gross: 0, count: 0 }
      credits.set(document.creditsInvoiceId, { gross: credit.gross + document.grossMinor, count: credit.count + 1 })
    }
    return documents.map((document) => (document.kind === "invoice" ? { ...stamped(document), creditedGrossMinor: credits.get(document.id)?.gross ?? 0, creditNoteCount: credits.get(document.id)?.count ?? 0 } : stamped(document)))
  },
  read: (client, serverId) => invoiceDetail(client, serverId).then(stamped),
  toRecord: (document, context) => {
    const project = projectOf(context, document.projectId)
    const customer = named(context, "customer", document.customerId)!
    const run = named(context, BILLING_RUN_PREFIX, document.billingRunId)
    const credits = named(context, INVOICE_PREFIX, document.creditsInvoiceId)
    const isInvoice = document.kind === "invoice"
    const standing = creditStandingOf(document)
    const money = (minor: number) => formatMinor(minor, document.currency)
    const period = document.periodFrom === null || document.periodTo === null ? undefined : `${document.periodFrom} – ${document.periodTo}`
    return {
      id: webIdOf(isInvoice ? INVOICE_PREFIX : CREDIT_NOTE_PREFIX, document.id),
      name: document.label,
      context: `${customer.name} · ${isInvoice ? (period ?? document.issuedOn) : `credits ${credits?.name ?? "an invoice"}`}`,
      status: isInvoice ? standing.status : "Credit note",
      ...inheritedPresentation(undefined),
      ...stampFacts(document, context.now),
      value: money(document.grossMinor),
      description: isInvoice ? `Issued to ${customer.name} on ${document.issuedOn}, due ${document.dueOn}.` : `Credits ${credits?.name ?? "an invoice"} of ${customer.name}.`,
      facts: {
        Kind: isInvoice ? INVOICE_RECORD_KIND : CREDIT_NOTE_RECORD_KIND,
        Customer: customer.name,
        Currency: document.currency,
        Issued: document.issuedOn,
        Due: document.dueOn,
        ...(period === undefined ? {} : { Period: period }),
        ...(run === undefined ? {} : { "Billing run": run.name }),
        ...(credits === undefined ? {} : { Credits: credits.name }),
        ...(document.creditReason === null ? {} : { "Credit reason": CREDIT_REASON_LABELS[document.creditReason] }),
        ...(document.creditNote === null ? {} : { Note: document.creditNote }),
        Net: money(document.netMinor),
        VAT: money(document.vatMinor),
        Gross: money(document.grossMinor),
        ...(isInvoice ? { "Credit notes": String(standing.count) } : {}),
        ...(document.issuedBy === null ? {} : { "Issued by": nameVia(context, "user", document.issuedBy) }),
      },
      related: [customer.name, ...(run === undefined ? [] : [run.name]), ...(credits === undefined ? [] : [credits.name])],
      allowedTransitions: [],
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: isInvoice ? INVOICE_RECORD_KIND : CREDIT_NOTE_RECORD_KIND,
      submittedValues: {
        kind: document.kind,
        customerId: customer.id,
        currency: document.currency,
        issuedOn: document.issuedOn,
        ...(run === undefined ? {} : { billingRunId: run.id }),
        ...(credits === undefined ? {} : { creditsInvoiceId: credits.id }),
      },
    }
  },
  // The one write: a credit note, posted under the invoice it corrects.
  toCreateBody: (record, context) => {
    const invoiceWebId = typed(record, "creditsInvoiceId")
    const invoiceId = invoiceWebId === undefined ? undefined : context.resolve.serverIdOf(invoiceWebId)
    const invoice = invoiceId === undefined ? undefined : context.resolve.byServerId(invoiceId)
    if (invoiceId === undefined || invoice === undefined || !isInvoiceDocument(invoice) || typed(invoice, "kind") !== "invoice") {
      return refusal("creditsInvoiceId", "Pick an invoice the API holds: a credit note is not credited")
    }
    const reason = CREDIT_REASONS.find((candidate) => candidate === typed(record, "reason"))
    if (reason === undefined) return refusal("reason", "Pick a reason")
    const note = typed(record, "note")
    let lines: "all" | { lineId: string; quantity: number }[] = "all"
    if (typed(record, "scope") === "lines") {
      const credited: { lineId: string; quantity: number }[] = []
      for (const key of Object.keys(record.submittedValues ?? {})) {
        if (!key.startsWith(CREDIT_LINE_KEY)) continue
        const text = typed(record, key)
        if (text === undefined) continue
        const quantity = countOf(text)
        if (Number.isNaN(quantity)) return refusal(key, QUANTITY_REFUSAL)
        credited.push({ lineId: key.slice(CREDIT_LINE_KEY.length), quantity })
      }
      if (credited.length === 0) return refusal("lines", "Name a line and the quantity to credit, or credit every line")
      lines = credited
    }
    const write: CreditNoteWrite = { invoiceId, body: { reason, ...(note === undefined ? {} : { note }), lines } }
    return write
  },
  toPatchBody: (before, after) => refusal(firstMoved(before, after), DOCUMENT_NEVER_CHANGES),
  create: (client, body) => {
    const write = body as CreditNoteWrite
    return create<InvoiceDetail>(client, `/invoices/${write.invoiceId}/credit-notes`, write.body).then((created) => stamped(created.body))
  },
  update: () => Promise.reject(new Error("An issued document has no patch route")),
}

/** Price Engine › Invoices and Credit Notes: one resource, two kinds of document. */
export const invoicesModule: ServerModule = { workspaceId: INVOICES_MODULE.workspaceId, moduleId: INVOICES_MODULE.moduleId, resources: [invoiceAdapter] }

