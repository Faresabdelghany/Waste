import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CREDIT_LINES_MAX, CreditNoteCreate, EACH_LINE_ONCE, GROSS_IS_NET_PLUS_VAT, Invoice, InvoiceDetail, InvoiceLine, InvoiceListQuery, LABEL_IS_THE_NUMBER, labelMatches, ONE_SOURCE, oneSource, totalsAgree } from "../invoices"
import { DAY_WINDOW_ORDERED } from "../queries"
import { refusal, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const WHEN = "2026-11-01T06:00:12.000Z"

const invoice = {
  id: ID,
  recordedAt: WHEN,
  projectId: OTHER,
  number: 26007188,
  label: "INV-26007188",
  kind: "invoice",
  customerId: THIRD,
  currency: "DKK",
  issuedOn: "2026-11-01",
  dueOn: "2026-12-01",
  periodFrom: "2026-10-01",
  periodTo: "2026-10-31",
  billingRunId: OTHER,
  creditsInvoiceId: null,
  creditReason: null,
  creditNote: null,
  netMinor: 12_345,
  vatMinor: 3_086,
  grossMinor: 15_431,
  issuedBy: THIRD,
}

const creditNote = {
  ...invoice,
  id: OTHER,
  number: 26007189,
  label: "CN-26007189",
  kind: "credit-note",
  issuedOn: "2026-11-15",
  dueOn: "2026-11-15",
  periodFrom: null,
  periodTo: null,
  billingRunId: null,
  creditsInvoiceId: ID,
  creditReason: "service-not-delivered",
  creditNote: "The bin was not emptied on the 5th",
  netMinor: -12_345,
  vatMinor: -3_086,
  grossMinor: -15_431,
}

const line = {
  id: THIRD,
  recordedAt: WHEN,
  invoiceId: ID,
  position: 1,
  billableEventId: OTHER,
  creditsLineId: null,
  description: "Restaffald 240 L · 2026-10-05",
  productId: THIRD,
  serviceDate: "2026-10-05",
  quantity: 1,
  unitPriceMinor: 12_345,
  netMinor: 12_345,
  vatPercent: 25,
  vatMinor: 3_086,
}

const creditLine = { ...line, id: ID, invoiceId: OTHER, billableEventId: null, creditsLineId: THIRD, netMinor: -12_345, vatMinor: -3_086 }

describe("Invoice", () => {
  test("is a ledger row — an id and recordedAt, never updatedAt — carrying what an external ledger books: the number under its label, the payer, the currency, the days, the period, its run, and the totals as issued", () => {
    assert.deepEqual(Invoice.parse(invoice), invoice)
    assert.equal("updatedAt" in Invoice.shape, false)
    const workers = { ...invoice, issuedBy: null }
    assert.deepEqual(Invoice.parse(workers), workers)
  })

  test("a credit note is an invoice of its kind, under the other prefix, naming the invoice it credits and why, its totals zero or negative and its period none", () => {
    assert.deepEqual(Invoice.parse(creditNote), creditNote)
    const zero = { ...creditNote, netMinor: 0, vatMinor: 0, grossMinor: 0, creditNote: null }
    assert.deepEqual(Invoice.parse(zero), zero)
  })

  test("holds the label to the number under the kind's prefix, and the gross to the net and the VAT", () => {
    assert.deepEqual(refusal(Invoice.safeParse({ ...invoice, label: "INV-26007189" })), [{ path: "label", message: LABEL_IS_THE_NUMBER }])
    assert.deepEqual(refusal(Invoice.safeParse({ ...invoice, label: "CN-26007188" })), [{ path: "label", message: LABEL_IS_THE_NUMBER }], "an invoice under a credit note's prefix")
    assert.deepEqual(refusal(Invoice.safeParse({ ...creditNote, label: "INV-26007189" })), [{ path: "label", message: LABEL_IS_THE_NUMBER }], "a credit note under an invoice's")
    assert.deepEqual(refusal(Invoice.safeParse({ ...invoice, grossMinor: 15_430 })), [{ path: "grossMinor", message: GROSS_IS_NET_PLUS_VAT }])
    assert.equal(labelMatches({ kind: "invoice", number: 7, label: "INV-7" }), true)
    assert.equal(labelMatches({ kind: "credit-note", number: 7, label: "CN-7" }), true)
    assert.equal(labelMatches({ kind: "credit-note", number: 7, label: "INV-7" }), false)
    assert.equal(totalsAgree({ netMinor: -100, vatMinor: -25, grossMinor: -125 }), true)
    assert.equal(totalsAgree({ netMinor: 100, vatMinor: 25, grossMinor: 124 }), false)
    // The label moves with the number, so the number's own rule is the one issue.
    assert.deepEqual(refusal(Invoice.safeParse({ ...invoice, number: 0, label: "INV-0" })).map((issue) => issue.path), ["number"])
    for (const [field, value] of [
      ["kind", "receipt"],
      ["creditReason", "goodwill"],
      ["currency", "kr"],
      ["issuedOn", WHEN],
      ["netMinor", "12345"],
    ] as const) {
      assert.deepEqual(refusal(Invoice.safeParse({ ...invoice, [field]: value })).map((issue) => issue.path), [field], field)
    }
  })
})

describe("InvoiceLine and InvoiceDetail", () => {
  test("a line charges for one event or credits one line, with the frozen description, the quantity and the amounts in minor units", () => {
    assert.deepEqual(InvoiceLine.parse(line), line)
    assert.deepEqual(InvoiceLine.parse(creditLine), creditLine)
    const reversal = { ...line, id: OTHER, position: 2, netMinor: -12_345, vatMinor: -3_086 }
    assert.deepEqual(InvoiceLine.parse(reversal), reversal, "a reversal's line is an event's and negative")
    assert.equal("updatedAt" in InvoiceLine.shape, false)
  })

  test("holds a line to one source, the position and the quantity above zero, and the unit price to zero or more", () => {
    assert.deepEqual(refusal(InvoiceLine.safeParse({ ...line, creditsLineId: THIRD })), [{ path: "billableEventId", message: ONE_SOURCE }], "an event and a line")
    assert.deepEqual(refusal(InvoiceLine.safeParse({ ...line, billableEventId: null })), [{ path: "billableEventId", message: ONE_SOURCE }], "neither")
    assert.equal(oneSource({ billableEventId: OTHER, creditsLineId: null }), true)
    assert.equal(oneSource({ billableEventId: null, creditsLineId: THIRD }), true)
    assert.equal(oneSource({ billableEventId: OTHER, creditsLineId: THIRD }), false)
    assert.equal(oneSource({ billableEventId: null, creditsLineId: null }), false)
    for (const [field, value] of [
      ["position", 0],
      ["quantity", 0],
      ["unitPriceMinor", -1],
      ["description", "  "],
      ["vatPercent", 25.5],
    ] as const) {
      assert.deepEqual(refusal(InvoiceLine.safeParse({ ...line, [field]: value })).map((issue) => issue.path), [field], field)
    }
  })

  test("the detail is the invoice with its lines by position and the credit notes naming it", () => {
    const detail = { ...invoice, lines: [line, { ...line, id: OTHER, position: 2 }], creditNotes: [creditNote] }
    assert.deepEqual(InvoiceDetail.parse(detail), detail)
    const bare = { ...creditNote, lines: [creditLine], creditNotes: [] }
    assert.deepEqual(InvoiceDetail.parse(bare), bare)
    assert.deepEqual(refusal(InvoiceDetail.safeParse({ ...detail, label: "INV-1" })), [{ path: "label", message: LABEL_IS_THE_NUMBER }])
    assert.deepEqual(refusal(InvoiceDetail.safeParse({ ...detail, grossMinor: 0 })), [{ path: "grossMinor", message: GROSS_IS_NET_PLUS_VAT }])
  })
})

describe("CreditNoteCreate", () => {
  test("credits every line by what remains of it, or the named lines by the named quantities, with the reason and a note", () => {
    assert.deepEqual(CreditNoteCreate.parse({ reason: "service-not-delivered", lines: "all" }), { reason: "service-not-delivered", lines: "all" })
    const partial = { reason: "quantity-correction", note: "Two of five were not delivered", lines: [{ lineId: THIRD, quantity: 2 }] }
    assert.deepEqual(CreditNoteCreate.parse(partial), partial)
  })

  test("needs the reason and the lines, at least one, each once, at most five hundred, each with a quantity above zero, and refuses what the server owns by name", () => {
    assert.deepEqual(refusal(CreditNoteCreate.safeParse({ lines: "all" })).map((issue) => issue.path), ["reason"])
    assert.deepEqual(refusal(CreditNoteCreate.safeParse({ reason: "other" })).map((issue) => issue.path), ["lines"])
    assert.deepEqual(refusal(CreditNoteCreate.safeParse({ reason: "other", lines: [] })).map((issue) => issue.path), ["lines"])
    assert.deepEqual(refusal(CreditNoteCreate.safeParse({ reason: "other", lines: [{ lineId: THIRD, quantity: 1 }, { lineId: THIRD, quantity: 2 }] })), [{ path: "lines", message: EACH_LINE_ONCE }])
    assert.equal(CREDIT_LINES_MAX, 500)
    const many = Array.from({ length: CREDIT_LINES_MAX + 1 }, (_, i) => ({ lineId: `01a0d3a5-e5e0-7000-8000-${String(i).padStart(12, "0")}`, quantity: 1 }))
    assert.deepEqual(refusal(CreditNoteCreate.safeParse({ reason: "other", lines: many })).map((issue) => issue.path), ["lines"])
    assert.equal(CreditNoteCreate.safeParse({ reason: "other", lines: many.slice(0, CREDIT_LINES_MAX) }).success, true)
    assert.deepEqual(refusal(CreditNoteCreate.safeParse({ reason: "other", lines: [{ lineId: THIRD, quantity: 0 }] })).map((issue) => issue.path), ["lines.0.quantity"])
    assert.deepEqual(refusal(CreditNoteCreate.safeParse({ reason: "other", lines: [{ lineId: THIRD, quantity: 1, amountMinor: 100 }] })).map((issue) => issue.path), ["lines.0"], "a credit is by quantity, never by amount")
    assert.deepEqual(refusal(CreditNoteCreate.safeParse({ reason: "other", lines: "some" })).map((issue) => issue.path), ["lines"])
    refusesWhatTheServerOwns(CreditNoteCreate, { reason: "other", lines: "all" })
    for (const [key, value] of [
      ["number", 26007189],
      ["label", "CN-26007189"],
      ["netMinor", -1],
      ["issuedBy", THIRD],
      ["issuedOn", "2026-11-15"],
      ["creditsInvoiceId", ID],
      ["kind", "credit-note"],
    ] as const) {
      assert.match(refusal(CreditNoteCreate.safeParse({ reason: "other", lines: "all", [key]: value }))[0].message, new RegExp(key), key)
    }
  })
})

describe("InvoiceListQuery", () => {
  test("pages by project, kind, payer, run, the invoice credited, and a window over issuedOn", () => {
    assert.deepEqual(InvoiceListQuery.parse({}), { limit: 50 })
    const whole = { projectId: OTHER, kind: "credit-note", customerId: THIRD, billingRunId: ID, creditsInvoiceId: OTHER, from: "2026-11-01", to: "2026-11-30" }
    assert.deepEqual(InvoiceListQuery.parse(whole), { limit: 50, ...whole })
    assert.deepEqual(refusal(InvoiceListQuery.safeParse({ from: "2026-11-30", to: "2026-11-01" })), [{ path: "to", message: DAY_WINDOW_ORDERED }])
    assert.deepEqual(refusal(InvoiceListQuery.safeParse({ kind: "receipt" })).map((issue) => issue.path), ["kind"])
  })
})
