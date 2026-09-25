import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { BillableEvent } from "@waste/contracts/billable-events"
import { BillingRunDetail } from "@waste/contracts/billing"
import { EACH_LINE_ONCE, Invoice, InvoiceDetail } from "@waste/contracts/invoices"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { outboxEvent } from "@waste/db/schema/execution"
import { withCompany } from "@waste/db/tenant"
import { and, asc, eq } from "drizzle-orm"

import { createApp } from "../app"
import { CREDIT_NOTE_NOT_CREDITED, fullyCredited, NOT_A_LINE, onlyRemain, REVERSAL_LINE_NOT_CREDITED } from "../routes/invoices"
import { reversalEvent, seedBilling, type BillingFixtures } from "./billing-fixtures"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the proofs the fixtures append and the documents and lines written here, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const InvoicePage = Page(Invoice)

const MODULE = "commercial.invoices"

/** The request's clock, pinned: noon on the fixtures' Monday. */
const NOON = new Date("2026-10-05T12:00:00Z")

describe("the invoice endpoints", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let ex: ExecutionFixtures
  let fx: BillingFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted the module, with Project Access to Copenhagen Central only. */
  let viewer: Call
  let other: Call
  let ungranted: Call
  let copenhagen: string

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    copenhagen = a.projects.copenhagen.id
    const fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    fx = await seedBilling(pool, a, ex)
    // The bulky pickup gets its rate here, so it prices at 350.00 kr and an invoice has two products to order its lines by.
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.update(product).set({ vatPercent: 25 }).where(and(eq(product.companyId, a.companyId), eq(product.id, fx.products.bulky.id)))
    })
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  const entered = async (body: Record<string, unknown>): Promise<BillableEvent> => {
    const response = await olivia("/billable-events", { method: "POST", body: { projectId: copenhagen, agreementId: fx.agreements.housingDkk.id, productId: fx.products.residual.id, quantity: 1, serviceDate: fx.day, ...body } })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return BillableEvent.parse(await response.json())
  }

  const readEvent = async (id: string): Promise<BillableEvent> => {
    const response = await olivia(`/billable-events/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return BillableEvent.parse(await response.json())
  }

  /** Runs billing over a period as Olivia and answers the one invoice it issued. */
  const invoiced = async (from: string, to: string = from): Promise<InvoiceDetail> => {
    const response = await olivia("/billing-runs", { method: "POST", body: { projectId: copenhagen, periodFrom: from, periodTo: to } })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    const run = BillingRunDetail.parse(await response.json())
    assert.equal(run.invoiceIds.length, 1, `one invoice over ${from}..${to}`)
    return await read(run.invoiceIds[0])
  }

  const read = async (id: string, call: Call = olivia): Promise<InvoiceDetail> => {
    const response = await call(`/invoices/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return InvoiceDetail.parse(await response.json())
  }

  const credit = (id: string, body: Record<string, unknown>, call: Call = olivia) => call(`/invoices/${id}/credit-notes`, { method: "POST", body })

  const credited = async (id: string, body: Record<string, unknown>, call: Call = olivia): Promise<InvoiceDetail> => created(call, `/invoices/${id}/credit-notes`, await credit(id, body, call), InvoiceDetail, "/invoices")

  const eventsAbout = async (aggregateId: string) =>
    withCompany(pool.db, a.companyId, (tx: Tx) =>
      tx
        .select({ kind: outboxEvent.kind, aggregateKind: outboxEvent.aggregateKind, occurredAt: outboxEvent.occurredAt, payload: outboxEvent.payload })
        .from(outboxEvent)
        .where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, aggregateId)))
        .orderBy(asc(outboxEvent.id)),
    )

  describe("the read and the list", () => {
    let residual: BillableEvent
    let bulky: BillableEvent
    let issued: InvoiceDetail

    before(async () => {
      residual = await entered({ quantity: 2 })
      bulky = await entered({ productId: fx.products.bulky.id })
      issued = await invoiced(fx.day)
    })

    test("answers the invoice with its lines by position — ordered by product name — and no credit note yet", async () => {
      assert.deepEqual([issued.kind, issued.label, issued.customerId, issued.currency, issued.netMinor, issued.vatMinor, issued.grossMinor, issued.creditNotes], ["invoice", `INV-${issued.number}`, fx.customers.housing.id, "DKK", 55_000, 13_750, 68_750, []])
      assert.deepEqual(
        issued.lines.map((line) => [line.position, line.billableEventId, line.description, line.quantity, line.unitPriceMinor, line.netMinor, line.vatMinor]),
        [
          [1, bulky.id, `Bulky pickup · ${fx.day}`, 1, 35_000, 35_000, 8_750],
          [2, residual.id, `Restaffald 240 L · ${fx.day}`, 2, 10_000, 20_000, 5_000],
        ],
        "the bulky pickup first by product name, its own name as text since it has no invoice name",
      )
      assert.deepEqual(await read(issued.id, viewer), issued)
      await refused(await other(`/invoices/${issued.id}`), 404)
      await refused(await ungranted(`/invoices/${issued.id}`), 403)
    })

    test("lists the documents of the caller's projects by kind, payer, run and issue day", async () => {
      const page = async (query: string) => {
        const response = await olivia(`/invoices?${query}`)
        assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
        return InvoicePage.parse(await response.json())
      }
      assert.ok((await page("kind=invoice&limit=200")).items.some((item) => item.id === issued.id))
      assert.deepEqual((await page(`billingRunId=${issued.billingRunId}`)).items.map((item) => item.id), [issued.id])
      assert.ok((await page(`customerId=${fx.customers.housing.id}&limit=200`)).items.every((item) => item.customerId === fx.customers.housing.id))
      assert.ok((await page("from=2026-10-05&to=2026-10-05&limit=200")).items.every((item) => item.issuedOn === "2026-10-05"))
      assert.deepEqual((await page("from=2026-10-06&to=2026-10-06")).items, [])
      const foreignPayer = await refused(await olivia(`/invoices?customerId=${testId()}`), 400)
      assert.deepEqual(foreignPayer.errors?.map((error) => error.path), ["customerId"])
      const outside = await refused(await viewer(`/invoices?projectId=${a.projects.harbor.id}`), 400)
      assert.deepEqual(outside.errors?.map((error) => error.path), ["projectId"])
      await refused(await ungranted("/invoices"), 403)
    })
  })

  describe("the credit note", () => {
    let residual: BillableEvent
    let bulky: BillableEvent
    let issued: InvoiceDetail

    before(async () => {
      const day = "2026-10-06"
      residual = await entered({ quantity: 2, serviceDate: day })
      bulky = await entered({ productId: fx.products.bulky.id, serviceDate: day })
      issued = await invoiced(day)
    })

    test("credits a line by a quantity: the next number of the series, the original's text and price copied and negated, due on issue, invoice-issued emitted, and the events still invoiced", async () => {
      const [bulkyLine, residualLine] = issued.lines
      const note = await credited(issued.id, { reason: "quantity-correction", note: "One of the two bins was not emptied", lines: [{ lineId: residualLine.id, quantity: 1 }] })
      assert.deepEqual(
        [note.kind, note.number, note.label, note.projectId, note.customerId, note.currency, note.issuedOn, note.dueOn, note.periodFrom, note.periodTo, note.billingRunId, note.creditsInvoiceId, note.creditReason, note.creditNote, note.issuedBy],
        ["credit-note", issued.number + 1, `CN-${issued.number + 1}`, copenhagen, fx.customers.housing.id, "DKK", "2026-10-05", "2026-10-05", null, null, null, issued.id, "quantity-correction", "One of the two bins was not emptied", a.users.olivia.id],
      )
      assert.deepEqual([note.netMinor, note.vatMinor, note.grossMinor], [-10_000, -2_500, -12_500])
      assert.deepEqual(
        note.lines.map((line) => [line.position, line.billableEventId, line.creditsLineId, line.description, line.productId, line.serviceDate, line.quantity, line.unitPriceMinor, line.netMinor, line.vatPercent, line.vatMinor]),
        [[1, null, residualLine.id, residualLine.description, residualLine.productId, residualLine.serviceDate, 1, 10_000, -10_000, 25, -2_500]],
      )
      assert.deepEqual(note.creditNotes, [])
      const outbox = await eventsAbout(note.id)
      assert.deepEqual(outbox.map((event) => [event.kind, event.aggregateKind, event.occurredAt.toISOString()]), [["invoice-issued", "invoice", NOON.toISOString()]])
      assert.deepEqual(InvoiceDetail.parse(outbox[0].payload), note)

      const corrected = await read(issued.id)
      assert.deepEqual(corrected.creditNotes.map((credit) => credit.id), [note.id], "the invoice now lists the credit note naming it")
      assert.deepEqual(corrected.lines, issued.lines, "the invoice's own lines never change")
      assert.deepEqual([(await readEvent(residual.id)).status, (await readEvent(bulky.id)).status], ["invoiced", "invoiced"], "a credit corrects the document, not the occurrence")
      assert.equal(bulkyLine.quantity, 1)
    })

    test("holds each line to what remains after the credit notes already issued, lists every refusal in one 400, and refuses a line that is not the invoice's or is named twice", async () => {
      const [bulkyLine, residualLine] = issued.lines
      const second = await credited(issued.id, { reason: "service-not-delivered", lines: [{ lineId: residualLine.id, quantity: 1 }] })
      assert.equal(second.netMinor, -10_000, "the second unit of the line, exhausting it")
      assert.equal(second.number, issued.number + 2)

      const exhausted = await refused(await credit(issued.id, { reason: "other", lines: [{ lineId: residualLine.id, quantity: 1 }] }), 400)
      assert.deepEqual(exhausted.errors, [{ path: "lines.0.quantity", message: onlyRemain(0, 2, 2) }])
      assert.equal(exhausted.errors?.[0]?.message, "Only 0 of 2 remain to credit on line 2")

      const both = await refused(await credit(issued.id, { reason: "other", lines: [{ lineId: bulkyLine.id, quantity: 2 }, { lineId: testId(), quantity: 1 }] }), 400)
      assert.deepEqual(both.errors, [
        { path: "lines.0.quantity", message: onlyRemain(1, 1, 1) },
        { path: "lines.1.lineId", message: NOT_A_LINE },
      ])

      const twice = await refused(await credit(issued.id, { reason: "other", lines: [{ lineId: bulkyLine.id, quantity: 1 }, { lineId: bulkyLine.id, quantity: 1 }] }), 400)
      assert.deepEqual(twice.errors, [{ path: "lines", message: EACH_LINE_ONCE }])
    })

    test("credits every line by what remains with \"all\", refuses an invoice with nothing left, and refuses a credit note as the document credited", async () => {
      const [bulkyLine] = issued.lines
      const rest = await credited(issued.id, { reason: "duplicate", lines: "all" })
      assert.deepEqual(rest.lines.map((line) => [line.creditsLineId, line.quantity, line.netMinor]), [[bulkyLine.id, 1, -35_000]], "the residual line is exhausted, so the bulky pickup alone remains")
      assert.deepEqual([rest.netMinor, rest.vatMinor, rest.grossMinor], [-35_000, -8_750, -43_750])

      const nothingLeft = await refused(await credit(issued.id, { reason: "other", lines: "all" }), 409)
      assert.equal(nothingLeft.detail, fullyCredited(issued.label))
      assert.equal(nothingLeft.detail, `Invoice INV-${issued.number} is fully credited`)
      const byLine = await refused(await credit(issued.id, { reason: "other", lines: [{ lineId: bulkyLine.id, quantity: 1 }] }), 409)
      assert.equal(byLine.detail, fullyCredited(issued.label), "the invoice's own state first, before the body's lines")

      const ofACreditNote = await refused(await credit(rest.id, { reason: "other", lines: "all" }), 409)
      assert.equal(ofACreditNote.detail, CREDIT_NOTE_NOT_CREDITED)
      assert.deepEqual((await read(issued.id)).creditNotes.length, 3)
    })

    test("leaves a reversal's line out: it already gives the charge back", async () => {
      const charged = await entered({ agreementId: fx.agreements.anna.id, serviceDate: "2026-10-07" })
      const first = await invoiced("2026-10-07")
      assert.deepEqual(first.lines.map((line) => line.billableEventId), [charged.id])
      const reversal = await reversalEvent(pool, a, await readEvent(charged.id))
      const later = await entered({ agreementId: fx.agreements.anna.id, serviceDate: "2026-10-08", quantity: 2 })
      const second = await invoiced("2026-10-07", "2026-10-08")
      assert.deepEqual(
        second.lines.map((line) => [line.billableEventId, line.serviceDate, line.netMinor]),
        [
          [reversal.id, "2026-10-07", -12_000],
          [later.id, "2026-10-08", 24_000],
        ],
        "the reversal on the payer's next invoice as a negative line, by service date before the later charge",
      )
      assert.equal(second.netMinor, 12_000)

      const named = await refused(await credit(second.id, { reason: "other", lines: [{ lineId: second.lines[0].id, quantity: 1 }] }), 400)
      assert.deepEqual(named.errors, [{ path: "lines.0.lineId", message: REVERSAL_LINE_NOT_CREDITED }])
      const rest = await credited(second.id, { reason: "other", lines: "all" })
      assert.deepEqual(rest.lines.map((line) => [line.creditsLineId, line.quantity, line.netMinor]), [[second.lines[1].id, 2, -24_000]], "\"all\" credits the charge and leaves the reversal's line out")
      assert.equal((await refused(await credit(second.id, { reason: "other", lines: "all" }), 409)).detail, fullyCredited(second.label), "nothing creditable is left: the reversal's line never was")

      const original = await credited(first.id, { reason: "service-not-delivered", lines: "all" })
      assert.equal(original.netMinor, -12_000, "the original's line is still credited by hand where the office decides so")
    })

    test("is the family's 404 across tenants and 403 without the grant, and refuses a member the server owns", async () => {
      await refused(await credit(issued.id, { reason: "other", lines: "all" }, other), 404)
      await refused(await credit(issued.id, { reason: "other", lines: "all" }, ungranted), 403)
      const owned = await refused(await credit(issued.id, { reason: "other", lines: "all", number: 1 }), 400)
      assert.deepEqual(owned.errors?.map((error) => error.path), ["number"])
    })
  })
})
