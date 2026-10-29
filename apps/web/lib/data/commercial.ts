// The Price Engine's customer-money chain as the web keeps it on the Pilot
// (Issue #185, slice 10 of #81, for #148): Products, Price rows and the Price
// Lists they are filed under, Billable Events, Billing Runs, and Invoices
// with their Credit Notes, and the Payments that pay them (#291 C6) — each
// the `commercial.*` module the API grants it under, read and written
// through lib/api/records/pricing.ts, billing.ts and payments.ts.
// This file is what every side of them shares: where each module lives, the
// prefix and the kind a record of it carries, which adapter owns a record
// (the id's prefix first, then the kind a form stamped: adapter.ts, `ofKind`)
// and how a wire token reads to a person.
//
// The price lists are the first kind of `commercial.price-rows`, the module
// the API grants `/price-lists` under; its table lists the rows alone (the
// command surface's `shows`), and Settings › Commercial › Price lists reads
// the lists. In fixture mode the lists are a browser bucket of their own,
// `FIXTURE_PRICE_LISTS_BUCKET`, seeded with the two fixture lists, so the
// fixture Price Rows table is what it was (the Users & roles precedent: one
// source by mode, never both).
import type { InvoicePaymentStatus } from "@waste/domain/finance/payments"
import { BILLABLE_EVENT_KINDS, BLOCK_REASONS, CANCEL_REASONS, CREDIT_REASONS, type BillableEventKind, type BlockReason, type CancelReason, type CreditReason, type PaymentSource } from "@waste/domain/finance/vocabulary"
import { CUSTOMER_KINDS, PRODUCT_KINDS, PRODUCT_UNITS, type CustomerKind, type ProductKind, type ProductUnit } from "@waste/domain/registry/vocabulary"

import { ofKind } from "@/lib/api/records/adapter"

import { FIXTURE_COMPANY_ID, FIXTURE_PROJECT_IDS, type BusinessRecord, type ModuleLocation } from "./business-modules"

export const PRODUCTS_MODULE: ModuleLocation = { workspaceId: "commercial", moduleId: "products" }
export const PRICE_ROWS_MODULE: ModuleLocation = { workspaceId: "commercial", moduleId: "price-rows" }
export const EVENTS_MODULE: ModuleLocation = { workspaceId: "commercial", moduleId: "events" }
export const BILLING_MODULE: ModuleLocation = { workspaceId: "commercial", moduleId: "billing" }
export const INVOICES_MODULE: ModuleLocation = { workspaceId: "commercial", moduleId: "invoices" }
export const PAYMENTS_MODULE: ModuleLocation = { workspaceId: "commercial", moduleId: "payments" }
export const ACCOUNTING_MODULE: ModuleLocation = { workspaceId: "commercial", moduleId: "accounting" }
/** Fixture mode's price lists: a browser bucket of their own, never a module the API answers. */
export const FIXTURE_PRICE_LISTS_BUCKET: ModuleLocation = { workspaceId: "commercial", moduleId: "price-lists" }
/** The routes an event names (slice 6). */
export const ROUTES_MODULE_LOCATION: ModuleLocation = { workspaceId: "route-studio", moduleId: "routes" }

export const PRODUCT_PREFIX = "product"
export const PRICE_LIST_PREFIX = "price-list"
export const PRICE_ROW_PREFIX = "price-row"
export const EVENT_PREFIX = "event"
export const BILLING_RUN_PREFIX = "billing-run"
export const INVOICE_PREFIX = "invoice"
export const CREDIT_NOTE_PREFIX = "credit-note"
export const PAYMENT_PREFIX = "payment"
export const ACCOUNTING_EXPORT_PREFIX = "accounting-export"

/** The prefix of the fields a partial credit note's dialog names a line's quantity under: `line:<uuid>`; the adapter reads the body's lines from them. */
export const CREDIT_LINE_KEY = "line:"

export const PRODUCT_RECORD_KIND = "Product"
export const PRICE_LIST_RECORD_KIND = "Price list"
export const PRICE_ROW_RECORD_KIND = "Price row"
export const EVENT_RECORD_KIND = "Billable event"
export const BILLING_RUN_RECORD_KIND = "Billing run"
export const INVOICE_RECORD_KIND = "Invoice"
export const CREDIT_NOTE_RECORD_KIND = "Credit note"
export const PAYMENT_RECORD_KIND = "Payment"
export const ACCOUNTING_EXPORT_RECORD_KIND = "Accounting export"

export const isProductRecord = ofKind(PRODUCT_PREFIX, [PRODUCT_RECORD_KIND])
export const isPriceListRecord = ofKind(PRICE_LIST_PREFIX, [PRICE_LIST_RECORD_KIND])
export const isPriceRowRecord = ofKind(PRICE_ROW_PREFIX, [PRICE_ROW_RECORD_KIND])
export const isEventRecord = ofKind(EVENT_PREFIX, [EVENT_RECORD_KIND])
export const isBillingRunRecord = ofKind(BILLING_RUN_PREFIX, [BILLING_RUN_RECORD_KIND])
/** An invoice or a credit note: one resource, `/invoices`, two kinds of document. */
export const isInvoiceDocument = (record: Pick<BusinessRecord, "id" | "recordKind">) =>
  ofKind(INVOICE_PREFIX, [INVOICE_RECORD_KIND])(record) || ofKind(CREDIT_NOTE_PREFIX, [CREDIT_NOTE_RECORD_KIND])(record)
export const isPaymentRecord = ofKind(PAYMENT_PREFIX, [PAYMENT_RECORD_KIND])
export const isAccountingExportRecord = ofKind(ACCOUNTING_EXPORT_PREFIX, [ACCOUNTING_EXPORT_RECORD_KIND])

// ---------------------------------------------------------------------------
// Wire tokens as a person reads them
// ---------------------------------------------------------------------------

/** A Product's kind, as the fixtures' Type spells it. */
export const PRODUCT_KIND_LABELS: Readonly<Record<ProductKind, string>> = {
  "container-collection": "Container collection",
  "recurring-service": "Recurring service",
  "additional-service": "Additional service",
}

/** A Product's unit, as a price is quoted per it: `/pickup`. */
export const UNIT_SUFFIX: Readonly<Record<ProductUnit, string>> = { pickup: "/pickup", month: "/mo", job: "/job", day: "/day", visit: "/visit", tonne: "/t" }

/** A price row's customer-kind condition, as the prototype's Customer type read: a person is a household, an organisation is commercial. */
export const CUSTOMER_KIND_LABELS: Readonly<Record<CustomerKind, string>> = { person: "Person", organisation: "Organisation" }

export const EVENT_KIND_LABELS: Readonly<Record<BillableEventKind, string>> = { pickup: "Pickup", ticket: "Ticket", manual: "Manual", reversal: "Reversal", subscription: "Recurring charge", job: "Work order", hire: "Hire", "pickup-exception": "Pickup exception", visit: "Recycling-centre visit", weight: "Weight charge" }

/** Why an event is blocked, each a sentence saying what to do. */
export const BLOCK_REASON_LABELS: Readonly<Record<BlockReason, string>> = {
  "no-subscription": "No subscription",
  "agreement-draft": "Agreement still a draft",
  "no-price-list": "No price list",
  "no-price-row": "No price row",
  "no-product": "No product",
  "no-vat-rate": "No VAT rate",
  "amount-too-large": "Amount too large",
}

export const CANCEL_REASON_LABELS: Readonly<Record<CancelReason, string>> = { "pickup-corrected": "Pickup corrected", "visit-voided": "Visit voided", "weight-revised": "Weight revised", duplicate: "Duplicate", "not-delivered": "Not delivered", other: "Other" }

export const CREDIT_REASON_LABELS: Readonly<Record<CreditReason, string>> = {
  "service-not-delivered": "Service not delivered",
  "quantity-correction": "Quantity correction",
  "price-correction": "Price correction",
  duplicate: "Duplicate",
  other: "Other",
}

/** What an invoice reads as from its payments (@waste/domain/finance/payments, `invoicePayment`). */
export const PAYMENT_STATUS_LABELS: Readonly<Record<InvoicePaymentStatus, string>> = { open: "Open", "partially-paid": "Partially paid", paid: "Paid", overdue: "Overdue", credited: "Credited" }

/** Where a payment came from. */
export const PAYMENT_SOURCE_LABELS: Readonly<Record<PaymentSource, string>> = { manual: "By hand", "bank-file": "Bank statement" }

/** A payment as its row reads: nothing of it allocated, some, or all of it. */
export function paymentRecordStatus(payment: { allocatedMinor: number; unallocatedMinor: number }): "Unmatched" | "Partially allocated" | "Allocated" {
  if (payment.allocatedMinor === 0) return "Unmatched"
  return payment.unallocatedMinor === 0 ? "Allocated" : "Partially allocated"
}

/** The options a select offers over a vocabulary, in its order. */
export const optionsOf = <Token extends string>(tokens: readonly Token[], labels: Readonly<Record<Token, string>>) => tokens.map((value) => ({ value, label: labels[value] }))

export const PRODUCT_KIND_OPTIONS = optionsOf(PRODUCT_KINDS, PRODUCT_KIND_LABELS)
export const PRODUCT_UNIT_OPTIONS = PRODUCT_UNITS.map((value) => ({ value, label: `Per ${value}` }))
export const CUSTOMER_KIND_OPTIONS = optionsOf(CUSTOMER_KINDS, CUSTOMER_KIND_LABELS)
/** The consumer's reasons, never a person's to give: a corrected pickup, a voided visit (M4 of #293), a weight no longer approved (O28 of #290). */
const CONSUMER_CANCEL_REASONS = ["pickup-corrected", "visit-voided", "weight-revised"] as const satisfies readonly CancelReason[]
/** The office's three. */
export const OFFICE_CANCEL_REASONS = CANCEL_REASONS.filter((reason): reason is Exclude<CancelReason, (typeof CONSUMER_CANCEL_REASONS)[number]> => !(CONSUMER_CANCEL_REASONS as readonly CancelReason[]).includes(reason))
export const CREDIT_REASON_OPTIONS = optionsOf(CREDIT_REASONS, CREDIT_REASON_LABELS)
export { BILLABLE_EVENT_KINDS, BLOCK_REASONS }

// ---------------------------------------------------------------------------
// Fixture mode's price lists
// ---------------------------------------------------------------------------

/**
 * A price list as both modes' Settings pane keeps it: the wire's fields as
 * typed values, its end the last day in force. In fixture mode the two lists
 * the prototype's registry held, under the codes its rows are tagged with.
 */
function fixturePriceList(id: string, projectId: string, name: string, { notes, validFrom, isDefault }: { notes: string; validFrom: string; isDefault: boolean }): BusinessRecord {
  return {
    id,
    name,
    context: `${name} · DKK`,
    status: "Active",
    owner: "Mette Holm",
    value: `From ${validFrom}`,
    updated: validFrom,
    description: notes,
    facts: { Kind: PRICE_LIST_RECORD_KIND, Code: name, Currency: "DKK", Default: isDefault ? "Yes" : "No", "Valid from": validFrom },
    related: [],
    source: "Price Engine",
    freshness: "Live",
    companyId: FIXTURE_COMPANY_ID,
    projectIds: [projectId],
    recordKind: PRICE_LIST_RECORD_KIND,
    submittedValues: { projectId, code: name, name, currency: "DKK", isDefault, notes, validFrom },
  }
}

/** The four lists the prototype's registry held — every tag its fixture rows carry, the two negotiated deals' among them — so a fixture row's list is one of them. */
export const FIXTURE_PRICE_LISTS: readonly BusinessRecord[] = [
  fixturePriceList("price-list-copenhagen-2026", FIXTURE_PROJECT_IDS.copenhagen, "PL-Copenhagen-2026", { notes: "Annual tariff for Copenhagen municipal collection.", validFrom: "2026-01-01", isDefault: true }),
  fixturePriceList("price-list-harbor-2026", FIXTURE_PROJECT_IDS.harbor, "PL-Harbor-2026", { notes: "Annual tariff for the Harbor service area.", validFrom: "2026-01-01", isDefault: true }),
  fixturePriceList("price-list-negotiated-osterbro", FIXTURE_PROJECT_IDS.copenhagen, "Negotiated · Østerbro Housing", { notes: "Negotiated deal for Østerbro Housing Association.", validFrom: "2026-02-03", isDefault: false }),
  fixturePriceList("price-list-negotiated-norrebro", FIXTURE_PROJECT_IDS.copenhagen, "Negotiated · Nørrebro CoWork", { notes: "Negotiated deal for Nørrebro CoWork ApS.", validFrom: "2026-04-08", isDefault: false }),
]
