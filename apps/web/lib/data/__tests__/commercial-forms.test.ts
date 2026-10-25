// The Price Engine's Pilot forms held to their adapters (#185): every field a
// form offers is a key its adapter reads, so a form filled in becomes the
// body the contract accepts, and a renamed field cannot quietly send nothing.
// The bodies are parsed by the contracts' own zod schemas.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Agreement } from "@waste/contracts/agreements"
import { BillableEventCancel, BillableEventCreate, BillableEventReprice } from "@waste/contracts/billable-events"
import { BillingRunCreate } from "@waste/contracts/billing"
import { ProductCreate, ProductPatch, type ContainerType, type Product, type WasteFraction } from "@waste/contracts/catalogue"
import type { Customer } from "@waste/contracts/customers"
import { CreditNoteCreate, type Invoice, type InvoiceDetail } from "@waste/contracts/invoices"
import type { Project } from "@waste/contracts/organisation"
import { PriceListCreate, PriceListPatch, PriceListRowCreate, PriceListRowPatch, PriceResolveQuery, type PriceList } from "@waste/contracts/price-lists"

import { isLocalRefusal, NOTHING_RESOLVED, type CommandInput, type MappingContext } from "../../api/records/adapter"
import { agreementAdapter } from "../../api/records/agreements"
import { billableEventAdapter, billingRunAdapter, billingRunBody, invoiceAdapter } from "../../api/records/billing"
import { containerTypeAdapter, wasteFractionAdapter } from "../../api/records/master-data"
import { projectAdapter } from "../../api/records/organisation"
import { explainQuery, priceListAdapter, priceRowAdapter, productAdapter } from "../../api/records/pricing"
import { customerAdapter } from "../../api/records/registry"
import { loaded, resolverOver, type ServerRecordsState } from "../../api/records/server-records"
import type { BusinessFormSchema, BusinessFormValues } from "../business-form-types"
import { FIXTURE_COMPANY_ID, type BusinessRecord } from "../business-modules"
import {
  blankNone,
  createBillingRunRecord,
  createCreditNoteRecord,
  createEventRecord,
  createPriceListRecord,
  createPriceRowRecord,
  createProductRecord,
  creditLineField,
  creditNoteForm,
  EVENT_COMMAND_FORMS,
  EVENT_FORM,
  EXPLAIN_PRICE_FORM,
  PRICE_LIST_FORM,
  PRICE_ROW_FORM,
  priceListEditForm,
  priceRowEditForm,
  PRODUCT_FORM,
  productEditForm,
  productFormValues,
  remainingByLine,
  RUN_BILLING_FORM,
  updatePriceListRecord,
  updateProductRecord,
} from "../commercial-forms"
import { NO_ONE } from "../properties"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false }
const residual: WasteFraction = { id: "01a0d2a4-a280-7005-8000-000000000001", ...STAMPS, key: "residual", name: "Residual", wasteCode: null, treatment: null }
const bin240: ContainerType = { id: "01a0d2a4-a280-7006-8000-000000000002", ...STAMPS, name: "Two-wheel bin · 240 L", volumeLitres: 240 }
const osterbro: Customer = { id: "01a0d2a4-a280-700b-8000-000000000002", ...STAMPS, kind: "organisation", name: "Østerbro Housing", registrationNumber: "38112009", email: null, phone: null, billingAddress: null, serviceMessagesAllowed: true, paymentTermsDays: null, status: "active" }
const agreement: Agreement = { id: "01a0d2a4-a280-7012-8000-000000000001", ...STAMPS, projectId: copenhagen.id, number: "AGR-2408", customerId: osterbro.id, payerCustomerId: osterbro.id, status: "active", billingCadence: "monthly", currency: "DKK", notes: null, priceListId: null, validFrom: "2026-01-01", validTo: null }
const product: Product = { id: "01a0d2a4-a280-700a-8000-000000000001", ...STAMPS, projectId: copenhagen.id, name: "Residual waste · 240L bin", kind: "container-collection", status: "active", unit: "pickup", containerTypeId: bin240.id, wasteFractionId: residual.id, serviceFrequencyId: null, invoiceName: null, invoiceCode: null, vatPercent: 25, freeDays: null }
const list: PriceList = { id: "01a0d2a4-a280-7028-8000-000000000001", ...STAMPS, projectId: copenhagen.id, code: "PL-Copenhagen-2026", name: "PL-Copenhagen-2026", currency: "DKK", isDefault: true, notes: null, validFrom: "2026-01-01", validTo: null }
const AREA = "01a0d2a4-a280-7015-8000-000000000001"
const invoice: Invoice = { id: "01a0d2a4-a280-7080-8000-000000000001", recordedAt: STAMPS.createdAt, projectId: copenhagen.id, number: 26007188, label: "INV-26007188", kind: "invoice", customerId: osterbro.id, currency: "DKK", issuedOn: "2026-09-30", dueOn: "2026-10-30", periodFrom: "2026-09-01", periodTo: "2026-09-30", billingRunId: null, creditsInvoiceId: null, creditReason: null, creditNote: null, netMinor: 60000, vatMinor: 15000, grossMinor: 75000, issuedBy: null, paymentReference: null, paidMinor: 0, outstandingMinor: 75000, paymentStatus: "open" }

const bare = (fixtures: readonly BusinessRecord[] = []): MappingContext => ({ fixtures, resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const moduleOf = (records: BusinessRecord[], ids: string[]) => loaded({ records, serverIds: new Map(records.map((record, index) => [record.id, ids[index]])) }, 1)
const projectRecord = projectAdapter.toRecord(copenhagen, bare())
const customerRecord = customerAdapter.toRecord(osterbro, bare())
const master = [wasteFractionAdapter.toRecord(residual, bare()), containerTypeAdapter.toRecord(bin240, bare())]
const areaRecord: BusinessRecord = { ...projectRecord, id: `area-${AREA}`, name: "Østerbro", recordKind: "Planning area" }
const base: ServerRecordsState = new Map([
  ["configure.organization", moduleOf([projectRecord], [copenhagen.id])],
  ["configure.master", moduleOf(master, [residual.id, bin240.id])],
  ["customers.contacts", moduleOf([customerRecord], [osterbro.id])],
  ["configure.areas", moduleOf([areaRecord], [AREA])],
])
const at = (state: ServerRecordsState): MappingContext => ({ ...bare(), resolve: resolverOver(state) })
const agreementRecord = agreementAdapter.toRecord(agreement, at(base))
const productRecord = productAdapter.toRecord(product, at(base))
const withCatalogue = new Map([...base, ["customers.agreements", moduleOf([agreementRecord], [agreement.id])], ["commercial.products", moduleOf([productRecord], [product.id])]])
const listRecord = priceListAdapter.toRecord(list, at(withCatalogue))
const invoiceRecord = invoiceAdapter.toRecord({ ...invoice, createdAt: invoice.recordedAt, updatedAt: invoice.recordedAt, creditedGrossMinor: 0, creditNoteCount: 0 }, at(withCatalogue))
const state: ServerRecordsState = new Map([...withCatalogue, ["commercial.price-rows", moduleOf([listRecord], [list.id])], ["commercial.invoices", moduleOf([invoiceRecord], [invoice.id])]])
const context = at(state)

/** Every field id a form offers. */
const fieldsOf = (schema: BusinessFormSchema) => schema.sections.flatMap((section) => section.fields.map((field) => field.id))

/** Asserts a form offers exactly these fields: what the adapter reads, nothing it does not. */
const offersExactly = (schema: BusinessFormSchema, ids: readonly string[]) => assert.deepEqual([...fieldsOf(schema)].sort(), [...ids].sort(), schema.title)

const body = (made: unknown) => {
  if (isLocalRefusal(made)) throw new Error(`refused at ${made.path}: ${made.message}`)
  return made as { [key: string]: unknown }
}

describe("the Price Engine's Pilot forms", () => {
  test("a product filled in is the create the contract accepts; None reads as blank", () => {
    const values: BusinessFormValues = { projectId: projectRecord.id, productName: "Garden waste", productType: "container-collection", status: "active", priceUnit: "pickup", freeDays: "", containerType: master[1].id, wasteFraction: master[0].id, serviceFrequencyId: NO_ONE, invoiceName: "Garden waste collection", invoiceCode: "GRD-140", vatPercent: "25" }
    offersExactly(PRODUCT_FORM, Object.keys(values))
    assert.deepEqual(PRODUCT_FORM.sections.flatMap((section) => section.fields).find((field) => field.id === "freeDays")?.visibleWhen, { fieldId: "priceUnit", equals: "day" }, "free days are a hire product's, sold by the day (M14 of #293)")
    const record = createProductRecord(values, 1)
    assert.equal(record.status, "Active")
    assert.equal(record.submittedValues?.serviceFrequencyId, "")
    const made = body(productAdapter.toCreateBody!(record, context))
    assert.ok(ProductCreate.safeParse(made).success)
    assert.equal(made.containerTypeId, bin240.id)
    assert.equal(made.serviceFrequencyId, undefined)
  })

  test("a product's edit holds its project and moves what the wire patches, its status by token", () => {
    assert.ok(productEditForm(productRecord).sections.flatMap((section) => section.fields).find((field) => field.id === "projectId")?.readOnly)
    const opened = productFormValues(productRecord)
    assert.equal(opened.status, "active")
    const edited = updateProductRecord(productRecord, { ...opened, status: "inactive", invoiceCode: "RES-240", containerType: NO_ONE })
    assert.equal(edited.status, "Inactive")
    const patch = productAdapter.toPatchBody(productRecord, edited, context)
    assert.deepEqual(patch, { status: "inactive", containerTypeId: null, invoiceCode: "RES-240" })
    assert.ok(ProductPatch.safeParse(patch).success)
  })

  test("a price list filled in is the create the contract accepts, and its edit moves only what the wire patches", () => {
    const values: BusinessFormValues = { projectId: projectRecord.id, code: "PL-CPH-2027", name: "Copenhagen 2027", currency: "DKK", isDefault: false, notes: "Next year", validFrom: "2027-01-01", validTo: "2027-12-31" }
    offersExactly(PRICE_LIST_FORM, Object.keys(values))
    const record = createPriceListRecord(values, { now: 1, day: "2026-09-30" })
    assert.equal(record.status, "Scheduled")
    assert.ok(PriceListCreate.safeParse(body(priceListAdapter.toCreateBody!(record, context))).success)
    const edit = priceListEditForm(listRecord)
    for (const held of ["projectId", "code", "currency"]) assert.ok(edit.sections.flatMap((section) => section.fields).find((field) => field.id === held)?.readOnly, held)
    const edited = updatePriceListRecord(listRecord, { name: "Copenhagen 2026", validTo: "2026-12-31" }, "2026-09-30")
    const patch = priceListAdapter.toPatchBody(listRecord, edited, context)
    assert.deepEqual(patch, { name: "Copenhagen 2026", validTo: "2027-01-01" })
    assert.ok(PriceListPatch.safeParse(patch).success)
  })

  test("Add price filled in is the row the contract accepts under its list, and a row's edit offers its price, note and end alone", () => {
    const values: BusinessFormValues = { priceListId: listRecord.id, productId: productRecord.id, amount: "16.50", note: "Negotiated", planningAreaId: areaRecord.id, customerKind: "organisation", containerType: master[1].id, wasteFraction: master[0].id, customerId: customerRecord.id, validFrom: "2026-10-01", validTo: "" }
    offersExactly(PRICE_ROW_FORM, Object.keys(values))
    const write = body(priceRowAdapter.toCreateBody!(createPriceRowRecord(values, 1), context))
    assert.equal(write.priceListId, list.id)
    assert.ok(PriceListRowCreate.safeParse(write.body).success)
    const editable = priceRowEditForm(createPriceRowRecord(values, 1)).sections.flatMap((section) => section.fields).filter((field) => !field.readOnly).map((field) => field.id)
    assert.deepEqual(editable.sort(), ["amount", "note", "validTo"])
    assert.ok(PriceListRowPatch.safeParse({ unitPriceMinor: 1725 }).success)
  })

  test("Explain price's question is the resolve read's query", () => {
    const values: BusinessFormValues = { priceListId: listRecord.id, productId: productRecord.id, on: "2026-10-01", planningAreaId: NO_ONE, customerKind: "organisation", containerType: "", wasteFraction: "", customerId: customerRecord.id }
    offersExactly(EXPLAIN_PRICE_FORM, Object.keys(values))
    const asked = explainQuery(blankNone(values), resolverOver(state))
    if (isLocalRefusal(asked)) throw new Error(asked.message)
    assert.ok(PriceResolveQuery.safeParse(asked.query).success)
    assert.deepEqual(asked.query, { productId: product.id, on: "2026-10-01", customerKind: "organisation", customerId: osterbro.id })
  })

  test("the manual event filled in is the create the contract accepts, and each command's dialog its body", () => {
    const values: BusinessFormValues = { agreementId: agreementRecord.id, productId: productRecord.id, quantity: "2", serviceDate: "2026-09-29", note: "Extra", unitPrice: "300", overrideReason: "Agreed" }
    offersExactly(EVENT_FORM, Object.keys(values))
    assert.ok(BillableEventCreate.safeParse(body(billableEventAdapter.toCreateBody!(createEventRecord(values, 1), context))).success)
    const commands = billableEventAdapter.commands!
    const event = createEventRecord(values, 1)
    offersExactly(EVENT_COMMAND_FORMS.reprice, ["productId"])
    assert.ok(BillableEventReprice.safeParse(body(commands.reprice.toBody!({ productId: productRecord.id } satisfies CommandInput, event, context))).success)
    assert.deepEqual(commands.reprice.toBody!(blankNone({ productId: NO_ONE }), event, context), {})
    offersExactly(EVENT_COMMAND_FORMS.cancel, ["reason", "note"])
    for (const option of EVENT_COMMAND_FORMS.cancel.sections[0].fields[0].options ?? []) {
      assert.ok(BillableEventCancel.safeParse(body(commands.cancel.toBody!({ reason: option.value, note: "Twice" }, event, context))).success, option.value)
    }
  })

  test("Run billing's period is the run's body, the record it mints the store's create of it", () => {
    const values: BusinessFormValues = { projectId: projectRecord.id, periodFrom: "2026-09-01", periodTo: "2026-09-30", note: "September" }
    offersExactly(RUN_BILLING_FORM, Object.keys(values))
    assert.ok(BillingRunCreate.safeParse(body(billingRunBody(values, resolverOver(state)))).success)
    assert.deepEqual(billingRunAdapter.toCreateBody!(createBillingRunRecord(values, 1), context), billingRunBody(values, resolverOver(state)))
  })

  test("a credit note's dialog offers each line by what remains of it, and its values are the create the contract accepts", () => {
    const line = { id: "01a0d2a4-a280-7081-8000-000000000001", position: 1, description: "Bulky waste pickup 2026-09-29", quantity: 3, netMinor: 90000, creditsLineId: null }
    const reversal = { ...line, id: "01a0d2a4-a280-7081-8000-000000000002", position: 2, description: "Reversal", quantity: 1, netMinor: -18000 }
    const detail = { lines: [line, reversal] } as unknown as Pick<InvoiceDetail, "lines">
    const earlier = { lines: [{ ...line, id: "01a0d2a4-a280-7081-8000-000000000009", creditsLineId: line.id, quantity: 1 }] } as unknown as Pick<InvoiceDetail, "lines">
    const remaining = remainingByLine(detail, [earlier])
    assert.deepEqual([...remaining], [[line.id, 2], [reversal.id, 0]])
    const form = creditNoteForm(invoiceRecord, detail, remaining)
    offersExactly(form, ["reason", "note", "scope", creditLineField(line.id)])
    assert.equal(form.sections[1].fields[0].max, 2)
    const all = body(invoiceAdapter.toCreateBody!(createCreditNoteRecord(invoiceRecord, { reason: "duplicate", note: "", scope: "all" }, 1), context))
    assert.ok(CreditNoteCreate.safeParse(all.body).success)
    const partial = body(invoiceAdapter.toCreateBody!(createCreditNoteRecord(invoiceRecord, { reason: "quantity-correction", note: "One", scope: "lines", [creditLineField(line.id)]: "1" }, 1), context))
    assert.deepEqual(partial.body, { reason: "quantity-correction", note: "One", lines: [{ lineId: line.id, quantity: 1 }] })
    assert.ok(CreditNoteCreate.safeParse(partial.body).success)
  })
})
