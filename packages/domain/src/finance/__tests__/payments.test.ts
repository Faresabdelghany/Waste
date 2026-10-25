// Payments and reconciliation (#291 slice 6, #292 C6): what an invoice reads
// as from its payments — open, partially paid, paid, overdue or credited,
// never a column — a bank statement's lines read from our own CSV, each with
// the key that makes a file imported twice add nothing, and a line matched
// to the one invoice its reference or its text names.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { amountMinorOf, bankFileOf, bankLineKey, BANK_FILE_COLUMNS, invoicePayment, matchBankLine, minorDigitsOf, type BankLine, type OpenInvoice } from "../payments"

describe("an invoice's payment reading", () => {
  const reading = (allocatedMinor: number, today: string, { grossMinor = 125_000, creditedMinor = 0 } = {}) =>
    invoicePayment({ grossMinor, creditedMinor, allocatedMinor, dueOn: "2026-10-13", today })

  test("is open until anything is paid, partially paid when some is, and paid when all is", () => {
    assert.deepEqual(reading(0, "2026-10-05"), { status: "open", paidMinor: 0, outstandingMinor: 125_000 })
    assert.deepEqual(reading(50_000, "2026-10-05"), { status: "partially-paid", paidMinor: 50_000, outstandingMinor: 75_000 })
    assert.deepEqual(reading(125_000, "2026-10-05"), { status: "paid", paidMinor: 125_000, outstandingMinor: 0 })
  })

  test("is overdue past its due day while anything is owed, the due day itself still in time", () => {
    assert.equal(reading(0, "2026-10-13").status, "open", "due today is not yet overdue")
    assert.equal(reading(0, "2026-10-14").status, "overdue")
    assert.equal(reading(50_000, "2026-10-14").status, "overdue", "a part paid does not keep it in time")
    assert.equal(reading(125_000, "2026-11-30").status, "paid", "paid in full is never overdue")
  })

  test("owes its gross less its credit notes: credited in full it owes nothing, and money paid before the credit is not owed back here", () => {
    assert.deepEqual(reading(0, "2026-10-20", { creditedMinor: -125_000 }), { status: "credited", paidMinor: 0, outstandingMinor: 0 })
    assert.deepEqual(reading(0, "2026-10-05", { creditedMinor: -25_000 }), { status: "open", paidMinor: 0, outstandingMinor: 100_000 })
    assert.deepEqual(reading(100_000, "2026-10-05", { creditedMinor: -25_000 }), { status: "paid", paidMinor: 100_000, outstandingMinor: 0 })
    assert.deepEqual(reading(125_000, "2026-10-05", { creditedMinor: -125_000 }), { status: "paid", paidMinor: 125_000, outstandingMinor: 0 }, "paid then credited: a credit on the customer's balance, not this invoice's")
  })

  test("an invoice of no net to pay — its reversals outweighing its lines — owes nothing and reads credited", () => {
    assert.deepEqual(reading(0, "2026-10-20", { grossMinor: -5_000 }), { status: "credited", paidMinor: 0, outstandingMinor: 0 })
  })
})

describe("a bank statement's amounts", () => {
  test("are the currency's minor units, a comma or a point the decimal mark, no grouping", () => {
    assert.equal(amountMinorOf("1234,50", "DKK"), 123_450)
    assert.equal(amountMinorOf("1234.5", "DKK"), 123_450)
    assert.equal(amountMinorOf("625", "DKK"), 62_500)
    assert.equal(amountMinorOf("-80,00", "DKK"), -8_000, "an outgoing line reads negative")
    assert.equal(amountMinorOf("1500", "JPY"), 1_500)
    assert.equal(amountMinorOf("1.500", "KWD"), 1_500)
    for (const text of ["1.234,50", "12,345", "1e3", "", "abc", "0,001"]) assert.equal(amountMinorOf(text, "DKK"), null, text)
    assert.equal(minorDigitsOf("DKK"), 2)
    assert.equal(minorDigitsOf("ISK"), 0)
  })
})

describe("a bank statement file", () => {
  const header = BANK_FILE_COLUMNS.join(";")

  test("is our own CSV: booked_on, amount, currency, reference and text, its incoming lines read and its outgoing ones skipped", () => {
    const file = bankFileOf([header, "2026-10-12;625,00;DKK;000000260071881;Østerbro Housing", "2026-10-12;-80,00;DKK;;Bank fee", "2026-10-13;1000;DKK;;Betaling INV-26007189"].join("\n"))
    assert.deepEqual(file.refusals, [])
    assert.deepEqual(file.skipped, [{ row: 3, reason: "outgoing" }])
    assert.deepEqual(
      file.lines.map(({ row, bookedOn, amountMinor, currency, reference, text }) => ({ row, bookedOn, amountMinor, currency, reference, text })),
      [
        { row: 2, bookedOn: "2026-10-12", amountMinor: 62_500, currency: "DKK", reference: "000000260071881", text: "Østerbro Housing" },
        { row: 4, bookedOn: "2026-10-13", amountMinor: 100_000, currency: "DKK", reference: "", text: "Betaling INV-26007189" },
      ],
    )
  })

  test("refuses a file whose header is not ours, and a line it cannot read, by its row", () => {
    assert.deepEqual(bankFileOf("date,amount\n2026-10-12,625").refusals, [{ row: 1, message: `The header is ${BANK_FILE_COLUMNS.join(", ")}` }])
    const file = bankFileOf([header, "12-10-2026;625;DKK;;x", "2026-10-12;1.234,50;DKK;;x", "2026-10-12;625;dkk;;x"].join("\n"))
    assert.deepEqual(file.refusals, [
      { row: 2, message: "booked_on is a day, as 2026-10-12" },
      { row: 3, message: "amount is a number with a comma or a point before the decimals, as 1234,50" },
      { row: 4, message: "currency is three capital letters, as DKK" },
    ])
    assert.deepEqual(file.lines, [])
  })

  test("gives each line a key of its own, the same for the same line in a file read again, and a second identical line in one file a key of its own", () => {
    const text = [header, "2026-10-12;625,00;DKK;;Rent", "2026-10-12;625,00;DKK;;Rent"].join("\n")
    const [first, second] = bankFileOf(text).lines
    assert.notEqual(first.key, second.key, "two transfers of the same amount on the same day are two payments")
    assert.deepEqual([first.occurrence, second.occurrence], [0, 1], "each line says how many identical ones came before it, for the key a batch recomputes")
    assert.deepEqual(bankFileOf(text).lines.map((line) => line.key), [first.key, second.key], "the same file read again keys its lines alike")
    const rent = { bookedOn: "2026-10-12", amountMinor: 62_500, currency: "DKK", reference: "", text: "Rent" }
    assert.deepEqual([bankLineKey(rent, 0), bankLineKey(rent, 1)], [first.key, second.key], "the first is the zeroth of its kind, the second the first after it")
    assert.ok(bankLineKey({ bookedOn: "2026-10-12", amountMinor: 62_500, currency: "DKK", reference: "", text: "x".repeat(5_000) }, 1).length <= 400, "a key short enough to index")
  })
})

describe("matching a bank line to an invoice", () => {
  const open = (overrides: Partial<OpenInvoice> = {}): OpenInvoice => ({ id: "i1", label: "INV-26007188", paymentReference: "000000260071881", currency: "DKK", outstandingMinor: 62_500, ...overrides })
  const line = (overrides: Partial<BankLine> = {}): Pick<BankLine, "amountMinor" | "currency" | "reference" | "text"> => ({ amountMinor: 62_500, currency: "DKK", reference: "", text: "", ...overrides })

  test("by the invoice's FIK reference, as the bank gives it or inside the card's printed line", () => {
    assert.deepEqual(matchBankLine(line({ reference: "000000260071881" }), [open()]), { invoiceId: "i1", amountMinor: 62_500, by: "reference" })
    assert.deepEqual(matchBankLine(line({ reference: "+71<000000260071881+85123456<" }), [open()]), { invoiceId: "i1", amountMinor: 62_500, by: "reference" })
  })

  test("by the one open invoice its text names, when the reference names none", () => {
    assert.deepEqual(matchBankLine(line({ text: "Betaling for INV-26007188, tak" }), [open({ paymentReference: null })]), { invoiceId: "i1", amountMinor: 62_500, by: "label" })
    assert.equal(matchBankLine(line({ text: "INV-26007188 og INV-26007190" }), [open(), open({ id: "i2", label: "INV-26007190", paymentReference: null })]), null, "two invoices named: the office decides")
  })

  test("allocates what the invoice owes at most, the rest left on the customer's balance, and nothing to an invoice owing nothing or in another currency", () => {
    assert.deepEqual(matchBankLine(line({ reference: "000000260071881", amountMinor: 100_000 }), [open()]), { invoiceId: "i1", amountMinor: 62_500, by: "reference" })
    assert.deepEqual(matchBankLine(line({ reference: "000000260071881", amountMinor: 20_000 }), [open()]), { invoiceId: "i1", amountMinor: 20_000, by: "reference" })
    assert.equal(matchBankLine(line({ reference: "000000260071881" }), [open({ outstandingMinor: 0 })]), null)
    assert.equal(matchBankLine(line({ reference: "000000260071881", currency: "EUR" }), [open()]), null)
    assert.equal(matchBankLine(line({ reference: "999999999999999" }), [open()]), null, "a reference of no invoice")
  })
})
