// What an invoice document says (#291 slice 5, #292 C5): the model a
// renderer lays out, a pure function of the ledger's rows — the invoice, its
// lines and the parties frozen at its issue — in the project's language. Every
// string is spelled here, without the runtime's Intl, so the same rows give
// the same document on any Node.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  documentAmount,
  documentDate,
  documentLanguageOf,
  invoiceDocumentOf,
  winAnsi,
  type InvoiceDocumentInput,
} from "../invoice-document"
import { fikSchemeOf, paymentReference } from "../payment"
import { CREDIT_REASONS } from "../vocabulary"

const SELLER = {
  legalName: "Kystbyen Renovation A/S",
  registrationNumber: "12345678",
  vatNumber: "DK12345678",
  postalAddress: "Havnegade 4\n2100 København Ø",
  bankIban: "DK5000400440116243",
  bankBic: "DABADKKK",
  fikCreditorNumber: "85123456",
}
/** A FIK scheme's reference, which is never null. */
const referenceOf = (scheme: "fik-71" | "fik-75", number: number): string => paymentReference(scheme, number) ?? assert.fail(`${scheme} gave no reference`)
const REFERENCE = referenceOf("fik-71", 26007188)
const BUYER = { name: "Østerbro Housing", registrationNumber: "38112009", billingAddress: "Nørrebrogade 1\n2200 København N" }

const invoice = (overrides: Partial<InvoiceDocumentInput> = {}): InvoiceDocumentInput => ({
  kind: "invoice",
  label: "INV-26007188",
  language: "da",
  currency: "DKK",
  issuedOn: "2026-10-05",
  dueOn: "2026-10-13",
  periodFrom: "2026-09-01",
  periodTo: "2026-09-30",
  paymentReference: REFERENCE,
  credits: null,
  netMinor: 150_000,
  vatMinor: 37_500,
  grossMinor: 187_500,
  lines: [
    { description: "Tømning 240 L restaffald", serviceDate: "2026-09-02", quantity: 4, unitPriceMinor: 25_000, netMinor: 100_000, vatPercent: 25, vatMinor: 25_000 },
    { description: "Storskrald afhentning", serviceDate: "2026-09-17", quantity: 1, unitPriceMinor: 50_000, netMinor: 50_000, vatPercent: 25, vatMinor: 12_500 },
  ],
  parties: { seller: SELLER, buyer: BUYER },
  ...overrides,
})

describe("the document's spelling", () => {
  test("an amount is the currency's minor units, grouped as the language groups them", () => {
    assert.equal(documentAmount(123_450, "DKK", "da"), "1.234,50")
    assert.equal(documentAmount(123_450, "DKK", "en"), "1,234.50")
    assert.equal(documentAmount(-5_000, "DKK", "da"), "-50,00")
    assert.equal(documentAmount(0, "EUR", "da"), "0,00")
    assert.equal(documentAmount(7, "DKK", "da"), "0,07")
    assert.equal(documentAmount(123_456_789, "DKK", "da"), "1.234.567,89")
    assert.equal(documentAmount(1_500, "JPY", "en"), "1,500", "a yen has no minor digits")
    assert.equal(documentAmount(1_500, "KWD", "en"), "1.500", "a dinar has three")
  })

  test("a date is the language's", () => {
    assert.equal(documentDate("2026-10-13", "da"), "13.10.2026")
    assert.equal(documentDate("2026-10-03", "en"), "3 October 2026")
  })

  test("the language is Danish for a Danish project and English for any other", () => {
    assert.equal(documentLanguageOf("da"), "da")
    assert.equal(documentLanguageOf("da-DK"), "da")
    assert.equal(documentLanguageOf("en-GB"), "en")
    assert.equal(documentLanguageOf("sv"), "en")
  })

  test("text keeps what the standard fonts' WinAnsi encoding holds and marks the rest", () => {
    assert.equal(winAnsi("Ærø Ødegård — “Søndre” € 5 – Š"), "Ærø Ødegård — “Søndre” € 5 – Š")
    assert.equal(winAnsi("Łódź ✓"), "?ód? ?")
    assert.equal(winAnsi("a\tb\r\nc"), "a b c", "a control character is a space")
    assert.equal(winAnsi("é"), "é", "composed first")
  })
})

describe("an invoice's document", () => {
  test("names itself, its parties and its dates in Danish for a Danish project", () => {
    const document = invoiceDocumentOf(invoice())
    assert.equal(document.title, "Faktura")
    assert.equal(document.label, "INV-26007188")
    assert.equal(document.issuedOn, "2026-10-05", "the day it was issued, as the calendar writes it: the file's own date")
    assert.deepEqual(document.seller, ["Kystbyen Renovation A/S", "Havnegade 4", "2100 København Ø", "CVR 12345678", "Momsnr. DK12345678"])
    assert.deepEqual(document.buyer, ["Østerbro Housing", "Nørrebrogade 1", "2200 København N", "CVR 38112009"])
    assert.deepEqual(document.facts, [
      ["Fakturanr.", "INV-26007188"],
      ["Fakturadato", "05.10.2026"],
      ["Periode", "01.09.2026 – 30.09.2026"],
      ["Forfaldsdato", "13.10.2026"],
      ["Betalingsreference", REFERENCE],
    ])
  })

  test("its lines are the frozen lines, each amount in the invoice's currency", () => {
    const document = invoiceDocumentOf(invoice())
    assert.deepEqual(document.columns, ["Beskrivelse", "Dato", "Antal", "Stykpris", "Moms", "Beløb"])
    assert.deepEqual(document.lines, [
      ["Tømning 240 L restaffald", "02.09.2026", "4", "250,00", "25 %", "1.000,00"],
      ["Storskrald afhentning", "17.09.2026", "1", "500,00", "25 %", "500,00"],
    ])
  })

  test("its VAT is summed per rate and its totals are the row's", () => {
    const document = invoiceDocumentOf(
      invoice({
        netMinor: 160_000,
        vatMinor: 37_500,
        grossMinor: 197_500,
        lines: [...invoice().lines, { description: "Gebyr", serviceDate: null, quantity: 1, unitPriceMinor: 10_000, netMinor: 10_000, vatPercent: 0, vatMinor: 0 }],
      }),
    )
    assert.deepEqual(document.vat, [
      ["Moms 0 % af 100,00", "0,00"],
      ["Moms 25 % af 1.500,00", "375,00"],
    ])
    assert.deepEqual(document.totals, [
      ["Subtotal", "1.600,00"],
      ["Moms", "375,00"],
      ["I alt DKK", "1.975,00"],
    ])
    assert.equal(document.lines[2][1], "", "a line with no service date shows none")
  })

  test("is paid by its FIK card where it carries a reference and the seller a creditor number, and by bank transfer besides", () => {
    const document = invoiceDocumentOf(invoice())
    assert.equal(fikSchemeOf(REFERENCE), "fik-71")
    assert.equal(fikSchemeOf(referenceOf("fik-75", 26007188)), "fik-75")
    assert.equal(fikSchemeOf("123"), null)
    assert.equal(document.fikLine, `+71<${REFERENCE}+85123456<`)
    assert.deepEqual(document.payment, ["Betales senest 13.10.2026", "IBAN DK5000400440116243 · BIC DABADKKK"])

    const plain = invoiceDocumentOf(invoice({ paymentReference: null, parties: { seller: { ...SELLER, bankBic: null, fikCreditorNumber: null }, buyer: BUYER } }))
    assert.equal(plain.fikLine, null)
    assert.deepEqual(plain.payment, ["Betales senest 13.10.2026", "IBAN DK5000400440116243"])
    assert.deepEqual(plain.facts.map(([label]) => label), ["Fakturanr.", "Fakturadato", "Periode", "Forfaldsdato"], "no reference, no fact")
  })

  test("a credit note names the invoice it credits and why, and asks for no payment", () => {
    const document = invoiceDocumentOf(
      invoice({
        kind: "credit-note",
        label: "CN-26007189",
        dueOn: "2026-10-05",
        periodFrom: null,
        periodTo: null,
        paymentReference: null,
        credits: { label: "INV-26007188", reason: "price-correction", note: "Wrong container size" },
        netMinor: -50_000,
        vatMinor: -12_500,
        grossMinor: -62_500,
        lines: [{ description: "Storskrald afhentning", serviceDate: "2026-09-17", quantity: 1, unitPriceMinor: -50_000, netMinor: -50_000, vatPercent: 25, vatMinor: -12_500 }],
      }),
    )
    assert.equal(document.title, "Kreditnota")
    assert.deepEqual(document.facts, [
      ["Kreditnotanr.", "CN-26007189"],
      ["Dato", "05.10.2026"],
      ["Krediterer", "INV-26007188"],
      ["Årsag", "Rettelse af pris"],
      ["Bemærkning", "Wrong container size"],
    ])
    assert.deepEqual(document.payment, [])
    assert.equal(document.fikLine, null)
    assert.deepEqual(document.totals.at(-1), ["I alt DKK", "-625,00"])
  })

  test("a credit note's reason is the vocabulary's in the document's language, every reason labelled, and a note only where the office wrote one", () => {
    const credit = (reason: InvoiceDocumentInput["credits"], language: "da" | "en" = "da") =>
      invoiceDocumentOf(invoice({ kind: "credit-note", label: "CN-1", language, dueOn: "2026-10-05", periodFrom: null, periodTo: null, paymentReference: null, credits: reason, netMinor: -50_000, vatMinor: -12_500, grossMinor: -62_500, lines: [{ description: "X", serviceDate: null, quantity: 1, unitPriceMinor: 50_000, netMinor: -50_000, vatPercent: 25, vatMinor: -12_500 }] })).facts
    for (const reason of CREDIT_REASONS) {
      for (const language of ["da", "en"] as const) {
        const [, label] = credit({ label: "INV-1", reason, note: null }, language).find(([fact]) => fact === (language === "da" ? "Årsag" : "Reason")) ?? []
        assert.ok(label !== undefined && label !== reason, `${reason} in ${language} is labelled`)
      }
    }
    assert.deepEqual(credit({ label: "INV-1", reason: "duplicate", note: null }, "en").slice(2), [["Credits", "INV-1"], ["Reason", "Duplicate"]])
  })

  test("is in English for any other project", () => {
    const document = invoiceDocumentOf(invoice({ language: "en" }))
    assert.equal(document.title, "Invoice")
    assert.deepEqual(document.facts[0], ["Invoice no.", "INV-26007188"])
    assert.deepEqual(document.columns, ["Description", "Date", "Qty", "Unit price", "VAT", "Amount"])
    assert.deepEqual(document.totals.at(-1), ["Total DKK", "1,875.00"])
    assert.equal(document.seller.at(-1), "VAT no. DK12345678")
    assert.equal(document.payment[0], "Due by 13 October 2026")
  })

  test("a seller with no identity yet prints what it has, and every string is WinAnsi", () => {
    const document = invoiceDocumentOf(invoice({ paymentReference: null, parties: { seller: { ...SELLER, vatNumber: null, postalAddress: null, bankIban: null, bankBic: null, fikCreditorNumber: null }, buyer: { name: "Łukasz Nowak", registrationNumber: null, billingAddress: null } } }))
    assert.deepEqual(document.seller, ["Kystbyen Renovation A/S", "CVR 12345678"])
    assert.deepEqual(document.buyer, ["?ukasz Nowak"])
    assert.deepEqual(document.payment, ["Betales senest 13.10.2026"])
  })

  test("refuses rows whose lines do not add up to their totals: the ledger's sums are the document's", () => {
    assert.throws(() => invoiceDocumentOf(invoice({ vatMinor: 37_501, grossMinor: 187_501 })), /lines' VAT 37500 is not the invoice's 37501/)
    assert.throws(() => invoiceDocumentOf(invoice({ netMinor: 150_001, grossMinor: 187_501 })), /lines' net 150000 is not the invoice's 150001/)
  })
})
