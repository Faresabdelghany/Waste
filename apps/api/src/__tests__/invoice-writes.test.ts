// The invoice-issuing statements, in order, without a database (Issue #112
// §6): a scripted `tx` records every statement `issueInvoice` runs and
// answers what each would — the counter's next number, the row as inserted,
// the lines as inserted — so the suite can say that the counter comes before
// the row, the row before its lines, and the outbox event last, with the
// detail the read would answer as its payload; the `ticket-writes.test.ts`
// precedent. The statements themselves run against Postgres in
// billing-runs.test.ts and invoices.test.ts.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Tx } from "@waste/db/client"
import { getTableName, type Table } from "drizzle-orm"

import { createIdMinter } from "../ids"
import { invoiceLineShapeIssue, issueInvoice, type InvoiceDraft, type LineDraft } from "../routes/invoice-writes"

const COMPANY = "01a0d3a5-e5e0-7000-8000-000000000000"
const PROJECT = "01a0d3a5-e5e0-7000-8000-000000000001"
const OLIVIA = "01a0d3a5-e5e0-7000-8000-000000000002"
const HOUSING = "01a0d3a5-e5e0-7000-8000-000000000003"
const RUN = "01a0d3a5-e5e0-7000-8000-000000000004"
const EVENT_A = "01a0d3a5-e5e0-7000-8000-000000000005"
const EVENT_B = "01a0d3a5-e5e0-7000-8000-000000000006"
const PRODUCT = "01a0d3a5-e5e0-7000-8000-000000000007"
const STAMP = new Date("2026-10-05T12:00:00Z")
const ISSUED = new Date("2026-10-05T12:00:01Z")

type Statement = { kind: "update" | "insert"; table: string; values?: Record<string, unknown> | Record<string, unknown>[] }

/** A `tx` that records each statement by kind and table, answering the counter and every insert with the rows as inserted. */
const scripted = () => {
  const statements: Statement[] = []
  const tx = {
    update: (table: Table) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          statements.push({ kind: "update", table: getTableName(table), values })
          return { returning: () => Promise.resolve([{ next: 26_007_189 }]) }
        },
      }),
    }),
    insert: (table: Table) => ({
      values: (values: Record<string, unknown> | Record<string, unknown>[]) => {
        statements.push({ kind: "insert", table: getTableName(table), values })
        const rows = (Array.isArray(values) ? values : [values]).map((row) => ({ ...row, recordedAt: STAMP }))
        return Object.assign(Promise.resolve(undefined), { returning: () => Promise.resolve(rows) })
      },
    }),
  } as unknown as Tx
  return { tx, statements }
}

const shape = (statements: readonly Statement[]) => statements.map((statement) => `${statement.kind} ${statement.table}`)

const minter = () => createIdMinter(() => STAMP.getTime())

const draft: InvoiceDraft = {
  projectId: PROJECT,
  kind: "invoice",
  customerId: HOUSING,
  currency: "DKK",
  issuedOn: "2026-10-05",
  dueOn: "2026-11-04",
  periodFrom: "2026-10-01",
  periodTo: "2026-10-31",
  billingRunId: RUN,
  creditsInvoiceId: null,
  creditReason: null,
  creditNote: null,
  issuedBy: OLIVIA,
}

const line = (billableEventId: string, quantity: number, unitPriceMinor: number, sign: 1 | -1 = 1): LineDraft => {
  const netMinor = sign * unitPriceMinor * quantity
  return { billableEventId, creditsLineId: null, description: `Restaffald 240 L · 2026-10-05`, productId: PRODUCT, serviceDate: "2026-10-05", quantity, unitPriceMinor, netMinor, vatPercent: 25, vatMinor: Math.round(netMinor / 4) }
}

describe("issueInvoice", () => {
  test("takes the number from the counter, writes the row with its totals, the lines 1..n in the order given, and emits invoice-issued last with the detail as its payload", async () => {
    const { tx, statements } = scripted()
    const lines = [line(EVENT_A, 2, 10_000), line(EVENT_B, 1, 10_000, -1)]
    const detail = await issueInvoice(tx, { companyId: COMPANY, draft, lines, newId: minter(), now: () => ISSUED })
    assert.deepEqual(shape(statements), ["update company", "insert invoice", "insert invoice_line", "insert outbox_event"])

    const [counter, row, written, outbox] = statements
    const counterValues = counter.values as Record<string, unknown>
    assert.ok(counterValues.nextInvoiceNumber !== undefined && typeof counterValues.nextInvoiceNumber !== "number", "the counter steps in the database, as an expression over its own column")
    assert.deepEqual([detail.number, detail.label, detail.kind], [26_007_188, "INV-26007188", "invoice"], "the number taken is the one the counter had, not the one it has now")
    const rowValues = row.values as Record<string, unknown>
    assert.deepEqual([rowValues.companyId, rowValues.projectId, rowValues.customerId, rowValues.billingRunId, rowValues.issuedBy], [COMPANY, PROJECT, HOUSING, RUN, OLIVIA])
    assert.deepEqual([rowValues.netMinor, rowValues.vatMinor, rowValues.grossMinor], [10_000, 2_500, 12_500], "the totals are the lines' sums, a negative line taken off")
    assert.equal(rowValues.id, detail.id)

    const writtenLines = written.values as Record<string, unknown>[]
    assert.deepEqual(writtenLines.map((values) => [values.invoiceId, values.position, values.billableEventId, values.netMinor]), [[detail.id, 1, EVENT_A, 20_000], [detail.id, 2, EVENT_B, -10_000]], "the lines name the row just written, positioned in the order given")
    assert.ok(writtenLines.every((values) => String(values.id) > String(detail.id)), "the lines' ids are minted after the invoice's")
    assert.deepEqual(detail.lines.map((written) => [written.position, written.netMinor, written.vatMinor]), [[1, 20_000, 5_000], [2, -10_000, -2_500]])
    assert.deepEqual(detail.creditNotes, [])

    const outboxValues = outbox.values as Record<string, unknown>
    assert.deepEqual([outboxValues.companyId, outboxValues.projectId, outboxValues.kind, outboxValues.aggregateKind, outboxValues.aggregateId, outboxValues.occurredAt], [COMPANY, PROJECT, "invoice-issued", "invoice", detail.id, ISSUED])
    assert.deepEqual(outboxValues.payload, detail, "the payload is the document as answered, lines included")
  })

  test("throws before any statement on a line that disagrees with its source or its amounts, and on a document with no line", async () => {
    const { tx, statements } = scripted()
    const issue = (lines: LineDraft[]) => issueInvoice(tx, { companyId: COMPANY, draft, lines, newId: minter(), now: () => ISSUED })
    await assert.rejects(issue([]), /a document has at least one line/)
    await assert.rejects(issue([{ ...line(EVENT_A, 1, 10_000), netMinor: 10_001 }]), /invoice line 1: .*invoice_line_amounts_shape/)
    await assert.rejects(issue([line(EVENT_A, 1, 10_000), { ...line(EVENT_B, 1, 10_000), creditsLineId: EVENT_A }]), /invoice line 2: .*invoice_line_source_exactly_one/)
    assert.equal(statements.length, 0, "nothing reached the database")
  })
})

describe("invoiceLineShapeIssue", () => {
  const credit: LineDraft = { billableEventId: null, creditsLineId: EVENT_A, description: "Restaffald 240 L · 2026-10-05", productId: PRODUCT, serviceDate: "2026-10-05", quantity: 1, unitPriceMinor: 10_000, netMinor: -10_000, vatPercent: 25, vatMinor: -2_500 }

  test("lets an event's line, a reversal's negative line and a credit line through, and names the check each disagreement would meet", () => {
    assert.equal(invoiceLineShapeIssue(line(EVENT_A, 3, 12_000)), undefined)
    assert.equal(invoiceLineShapeIssue(line(EVENT_A, 1, 12_000, -1)), undefined)
    assert.equal(invoiceLineShapeIssue(credit), undefined)
    assert.match(invoiceLineShapeIssue({ ...credit, billableEventId: EVENT_B }) ?? "", /invoice_line_source_exactly_one/)
    assert.match(invoiceLineShapeIssue({ ...credit, creditsLineId: null }) ?? "", /invoice_line_source_exactly_one/)
    assert.match(invoiceLineShapeIssue({ ...credit, quantity: 0, netMinor: 0, vatMinor: 0 }) ?? "", /invoice_line_quantity_positive/)
    assert.match(invoiceLineShapeIssue({ ...credit, netMinor: 10_000, vatMinor: 2_500 }) ?? "", /a credit line is never positive/)
    assert.match(invoiceLineShapeIssue({ ...credit, vatMinor: -2_499 }) ?? "", /invoice_line_vat_shape/)
  })
})
