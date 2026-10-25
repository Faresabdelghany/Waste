// The accounting export (#291 slice 7, #292 C7): each source row one balanced
// voucher on the project's chart — an invoice and a credit note by one rule,
// a payment against the receivable or, naming no customer, the suspense
// account, an allocation of such a payment moving it across — a mapping's
// gap named and no voucher, the lines numbered as an export freezes them, and
// our CSV with its amounts in the currency's digits.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { accountingCsv, ACCOUNTING_CSV_COLUMNS, amountText, exportLinesOf, gapSentence, voucherOf, voucherSum, type AccountingMapping, type Booked, type LedgerAccount, type SourceToBook, type Voucher } from "../accounting"

const account = (number: string, name: string): LedgerAccount => ({ number, name })
const RECEIVABLE = account("5600", "Debitorer")
const BANK = account("5820", "Bank")
const SUSPENSE = account("5850", "Ubehandlede indbetalinger")
const REVENUE = account("1010", "Salg af tømning")
const RENTAL = account("1020", "Containerleje")
const OUTPUT_VAT = account("6800", "Salgsmoms")

const MAPPING: AccountingMapping = {
  receivable: RECEIVABLE,
  bank: BANK,
  suspense: SUSPENSE,
  revenue: REVENUE,
  productRevenue: new Map([["product-hire", RENTAL]]),
  vatCodes: [
    { vatPercent: 25, code: "U25", account: OUTPUT_VAT },
    { vatPercent: 0, code: "U0", account: OUTPUT_VAT },
  ],
}

const invoice = (overrides: Partial<Extract<SourceToBook, { kind: "invoice" | "credit-note" }>> = {}): SourceToBook => ({
  kind: "invoice",
  id: "invoice-1",
  label: "INV-1012",
  bookedOn: "2026-10-31",
  currency: "DKK",
  customerName: "Boligforeningen Kystbyen",
  netMinor: 200_000,
  vatMinor: 50_000,
  grossMinor: 250_000,
  creditsLabel: null,
  lines: [
    { productId: "product-empty", netMinor: 120_000, vatPercent: 25, vatMinor: 30_000 },
    { productId: "product-hire", netMinor: 50_000, vatPercent: 25, vatMinor: 12_500 },
    { productId: null, netMinor: 30_000, vatPercent: 25, vatMinor: 7_500 },
  ],
  ...overrides,
})

const voucher = (booked: Booked): Voucher => {
  assert.ok("voucher" in booked, JSON.stringify(booked))
  return booked.voucher
}
const amounts = (booked: Booked) => voucher(booked).lines.map((line) => [line.account.number, line.vatCode, line.amountMinor])

describe("a document's voucher", () => {
  test("debits the receivable the gross, credits revenue per account and rate — a product's own account, else the project's — and the VAT per rate, and balances", () => {
    const booked = voucherOf(invoice(), MAPPING)
    assert.deepEqual(amounts(booked), [
      ["5600", null, 250_000],
      ["1010", "U25", -150_000],
      ["1020", "U25", -50_000],
      ["6800", "U25", -50_000],
    ])
    assert.equal(voucherSum(voucher(booked).lines), 0)
    assert.deepEqual([voucher(booked).source, voucher(booked).document, voucher(booked).bookedOn], [{ kind: "invoice", id: "invoice-1" }, "INV-1012", "2026-10-31"])
    assert.equal(voucher(booked).lines[0].text, "INV-1012 Boligforeningen Kystbyen")
    assert.equal(voucher(booked).lines[3].text, "INV-1012 Boligforeningen Kystbyen VAT 25 %")
  })

  test("books a credit note by the same rule, its negative totals turning every sign, and names the invoice it credits", () => {
    const booked = voucherOf(invoice({ kind: "credit-note", id: "credit-1", label: "CN-1013", netMinor: -50_000, vatMinor: -12_500, grossMinor: -62_500, creditsLabel: "INV-1012", lines: [{ productId: "product-hire", netMinor: -50_000, vatPercent: 25, vatMinor: -12_500 }] }), MAPPING)
    assert.deepEqual(amounts(booked), [
      ["5600", null, -62_500],
      ["1020", "U25", 50_000],
      ["6800", "U25", 12_500],
    ])
    assert.equal(voucher(booked).lines[0].text, "CN-1013 Boligforeningen Kystbyen (credits INV-1012)")
  })

  test("names a zero rate's code on its revenue and books no VAT line of nothing", () => {
    const booked = voucherOf(invoice({ netMinor: 10_000, vatMinor: 0, grossMinor: 10_000, lines: [{ productId: null, netMinor: 10_000, vatPercent: 0, vatMinor: 0 }] }), MAPPING)
    assert.deepEqual(amounts(booked), [
      ["5600", null, 10_000],
      ["1010", "U0", -10_000],
    ])
  })

  test("is a gap, named, where the mapping lacks the receivable, a revenue account, or a rate's code", () => {
    assert.deepEqual(voucherOf(invoice(), { ...MAPPING, receivable: null }), { gap: { account: "receivable" } })
    assert.deepEqual(voucherOf(invoice(), { ...MAPPING, revenue: null }), { gap: { account: "revenue" } }, "the unmapped product and the line of no product fall to a default there is not")
    assert.ok("voucher" in voucherOf(invoice({ netMinor: 50_000, vatMinor: 12_500, grossMinor: 62_500, lines: [{ productId: "product-hire", netMinor: 50_000, vatPercent: 25, vatMinor: 12_500 }] }), { ...MAPPING, revenue: null }), "a product's own account needs no default")
    assert.deepEqual(voucherOf(invoice(), { ...MAPPING, vatCodes: [] }), { gap: { vatPercent: 25 } })
    assert.equal(gapSentence({ vatPercent: 25 }), "No VAT code is set up for 25 % VAT")
    assert.equal(gapSentence({ account: "suspense" }), "No unmatched payments account is set up")
  })

  test("refuses a document whose totals are not its lines', which no issued document is", () => {
    assert.throws(() => voucherOf(invoice({ grossMinor: 250_001 }), MAPPING), /INV-1012's totals are not its lines'/)
    assert.throws(() => voucherOf(invoice({ netMinor: 199_999, grossMinor: 249_999 }), MAPPING), /totals are not its lines'/)
  })
})

describe("a payment's voucher and an allocation's", () => {
  const payment = (customerName: string | null): SourceToBook => ({ kind: "payment", id: "payment-1", reference: "+71<000000001012345+", bookedOn: "2026-11-04", currency: "DKK", amountMinor: 250_000, customerName })

  test("debits the bank and credits the receivable for a customer's payment, the suspense account for one that names none", () => {
    assert.deepEqual(amounts(voucherOf(payment("Boligforeningen Kystbyen"), MAPPING)), [
      ["5820", null, 250_000],
      ["5600", null, -250_000],
    ])
    const unmatched = voucherOf(payment(null), MAPPING)
    assert.deepEqual(amounts(unmatched), [
      ["5820", null, 250_000],
      ["5850", null, -250_000],
    ])
    assert.equal(voucher(unmatched).lines[0].text, "Payment +71<000000001012345+ unmatched")
    assert.equal(voucher(unmatched).document, "+71<000000001012345+")
  })

  test("moves an unmatched payment's amount from suspense to the receivable once it is allocated, and back when the allocation is undone", () => {
    const allocation = (amountMinor: number): SourceToBook => ({ kind: "allocation", id: "allocation-1", invoiceLabel: "INV-1012", bookedOn: "2026-11-06", currency: "DKK", amountMinor, customerName: "Boligforeningen Kystbyen" })
    assert.deepEqual(amounts(voucherOf(allocation(250_000), MAPPING)), [
      ["5850", null, 250_000],
      ["5600", null, -250_000],
    ])
    const undone = voucherOf(allocation(-250_000), MAPPING)
    assert.deepEqual(amounts(undone), [
      ["5850", null, -250_000],
      ["5600", null, 250_000],
    ])
    assert.equal(voucher(undone).lines[0].text, "Match undone INV-1012 Boligforeningen Kystbyen")
  })

  test("is a gap without the bank, the suspense account or the receivable it needs", () => {
    assert.deepEqual(voucherOf(payment("Boligforeningen Kystbyen"), { ...MAPPING, bank: null }), { gap: { account: "bank" } })
    assert.deepEqual(voucherOf(payment(null), { ...MAPPING, suspense: null }), { gap: { account: "suspense" } })
    assert.ok("voucher" in voucherOf(payment("Boligforeningen Kystbyen"), { ...MAPPING, suspense: null }), "a customer's payment needs no suspense account")
    assert.deepEqual(voucherOf(payment("Boligforeningen Kystbyen"), { ...MAPPING, receivable: null }), { gap: { account: "receivable" } })
  })
})

describe("the export's lines and its CSV", () => {
  const vouchers = [voucher(voucherOf(invoice(), MAPPING)), voucher(voucherOf({ kind: "payment", id: "payment-1", reference: null, bookedOn: "2026-11-04", currency: "DKK", amountMinor: 5, customerName: 'A; "quoted" name' }, MAPPING))]

  test("numbers the vouchers from the first number in their order, each line carrying its voucher's day, document, customer and source", () => {
    const lines = exportLinesOf(vouchers, 41)
    assert.deepEqual(
      lines.map((line) => [line.voucher, line.accountNumber, line.amountMinor, line.sourceKind]),
      [
        [41, "5600", 250_000, "invoice"],
        [41, "1010", -150_000, "invoice"],
        [41, "1020", -50_000, "invoice"],
        [41, "6800", -50_000, "invoice"],
        [42, "5820", 5, "payment"],
        [42, "5600", -5, "payment"],
      ],
    )
    assert.deepEqual([lines[4].bookedOn, lines[4].document, lines[4].customerName, lines[4].sourceId, lines[1].accountName], ["2026-11-04", null, 'A; "quoted" name', "payment-1", "Salg af tømning"])
  })

  test("spells an amount in its currency's digits with a decimal comma and no grouping", () => {
    assert.equal(amountText(250_000, "DKK"), "2500,00")
    assert.equal(amountText(-150_050, "DKK"), "-1500,50")
    assert.equal(amountText(5, "DKK"), "0,05")
    assert.equal(amountText(-5, "DKK"), "-0,05")
    assert.equal(amountText(0, "DKK"), "0,00")
    assert.equal(amountText(1200, "JPY"), "1200")
    assert.equal(amountText(1234, "KWD"), "1,234")
  })

  test("is a byte-order mark, the header, one semicolon-separated row per line with CRLF ends, and a field quoted where it holds a semicolon or a quote", () => {
    const csv = accountingCsv(exportLinesOf(vouchers, 41))
    assert.ok(csv.startsWith("﻿"))
    const rows = csv.slice(1).split("\r\n")
    assert.equal(rows.at(-1), "", "the last row ends too")
    assert.equal(rows[0], ACCOUNTING_CSV_COLUMNS.join(";"))
    assert.equal(rows[0], "voucher;date;account;account_name;text;amount;vat_code;currency;customer;document;source;source_id")
    assert.equal(rows[1], "41;2026-10-31;5600;Debitorer;INV-1012 Boligforeningen Kystbyen;2500,00;;DKK;Boligforeningen Kystbyen;INV-1012;invoice;invoice-1")
    assert.equal(rows[4], "41;2026-10-31;6800;Salgsmoms;INV-1012 Boligforeningen Kystbyen VAT 25 %;-500,00;U25;DKK;Boligforeningen Kystbyen;INV-1012;invoice;invoice-1")
    assert.equal(rows[5], `42;2026-11-04;5820;Bank;"Payment A; ""quoted"" name";0,05;;DKK;"A; ""quoted"" name";;payment;payment-1`)
    assert.equal(rows.length, 1 + 6 + 1)
  })
})
