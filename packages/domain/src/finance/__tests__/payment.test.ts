// How an invoice is paid (#291 slice 4, #292 C4): its terms — the customer's
// own, else its project's — date it due, and its payment reference, frozen
// at issue, is the document's number under the project's scheme with the
// modulus-10 check digit FIK cards end in.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BIC_PATTERN, DEFAULT_PAYMENT_TERMS_DAYS, dueOn, FIK_CREDITOR_PATTERN, fikLine, IBAN_PATTERN, modulus10, PAYMENT_REFERENCE_PATTERN, PAYMENT_TERMS_MAX, paymentReference, termsOf, VAT_NUMBER_PATTERN } from "../payment"
import { PAYMENT_REFERENCE_SCHEMES } from "../vocabulary"

describe("an invoice's terms", () => {
  test("are the customer's own where it has them, else the project's; a new project's are thirty days", () => {
    assert.equal(DEFAULT_PAYMENT_TERMS_DAYS, 30)
    assert.equal(PAYMENT_TERMS_MAX, 365)
    assert.equal(termsOf(null, 30), 30)
    assert.equal(termsOf(14, 30), 14, "the customer's override")
    assert.equal(termsOf(0, 30), 0, "due on issue is a term too")
  })

  test("date it due that many days after its issue, on the calendar", () => {
    assert.equal(dueOn("2026-10-31", 30), "2026-11-30")
    assert.equal(dueOn("2026-12-15", 30), "2027-01-14")
    assert.equal(dueOn("2026-10-31", 0), "2026-10-31")
  })
})

describe("a payment reference", () => {
  test("ends in the modulus-10 check digit: the digits weighted 2 and 1 from the right, each product's digits summed", () => {
    // The textbook case: 7992739871 checks with 3.
    assert.equal(modulus10("7992739871"), 3)
    assert.equal(modulus10("0"), 0)
    assert.equal(modulus10("1"), 8)
  })

  test("is the document's number under the scheme: FIK 71 fifteen digits, FIK 75 sixteen, the check digit last; none under none", () => {
    assert.deepEqual([...PAYMENT_REFERENCE_SCHEMES], ["none", "fik-71", "fik-75"])
    const reference71 = paymentReference("fik-71", 26_007_188)
    assert.equal(reference71, "00000026007188" + String(modulus10("00000026007188")))
    assert.equal(reference71?.length, 15)
    const reference75 = paymentReference("fik-75", 26_007_188)
    assert.equal(reference75?.length, 16)
    assert.equal(reference75?.slice(0, 15), "000000026007188")
    assert.equal(paymentReference("none", 26_007_188), null)
    // Every reference checks: the check digit makes the whole weighted sum a multiple of ten.
    for (const reference of [reference71, reference75]) assert.equal(modulus10(reference!.slice(0, -1)), Number(reference!.slice(-1)))
  })

  test("is distinct for distinct document numbers, which the company's one series hands out, whatever project a document is of", () => {
    const references = new Set([1000, 1001, 1002, 10_000, 99_999].map((number) => paymentReference("fik-71", number)))
    assert.equal(references.size, 5)
  })

  test("refuses a number its scheme cannot hold rather than cut it", () => {
    assert.throws(() => paymentReference("fik-71", 10 ** 14), /paymentReference: 100000000000000 has more digits than fik-71's 14/)
    assert.throws(() => paymentReference("fik-71", 12.5), /a whole number/)
  })

  test("prints as the FIK line: the card's type, the reference and the creditor's number", () => {
    const reference = paymentReference("fik-71", 26_007_188)!
    assert.equal(fikLine("fik-71", reference, "85123456"), `+71<${reference}+85123456<`)
    assert.equal(fikLine("fik-75", paymentReference("fik-75", 1001)!, "85123456"), `+75<${paymentReference("fik-75", 1001)}+85123456<`)
    assert.equal(fikLine("none", null, "85123456"), null)
  })
})

describe("the invoice identity's shapes", () => {
  const matches = (pattern: string, value: string) => new RegExp(pattern).test(value)

  test("are anchored patterns Postgres's ~ and JavaScript read alike: a VAT number, an IBAN, a BIC, a FIK creditor number, a payment reference", () => {
    for (const pattern of [VAT_NUMBER_PATTERN, IBAN_PATTERN, BIC_PATTERN, FIK_CREDITOR_PATTERN, PAYMENT_REFERENCE_PATTERN]) assert.ok(pattern.startsWith("^") && pattern.endsWith("$"), pattern)
    assert.ok(matches(VAT_NUMBER_PATTERN, "DK12345678"))
    assert.ok(!matches(VAT_NUMBER_PATTERN, "dk12345678"), "upper case, as a registry prints it")
    assert.ok(!matches(VAT_NUMBER_PATTERN, "12345678"), "its country first")
    assert.ok(matches(IBAN_PATTERN, "DK5000400440116243"))
    assert.ok(!matches(IBAN_PATTERN, "DK50 0040 0440 1162 43"), "without the spaces a person types for reading")
    assert.ok(matches(BIC_PATTERN, "DABADKKK") && matches(BIC_PATTERN, "DABADKKKXXX"))
    assert.ok(!matches(BIC_PATTERN, "DABADK"))
    assert.ok(matches(FIK_CREDITOR_PATTERN, "85123456") && !matches(FIK_CREDITOR_PATTERN, "8512345"))
    assert.ok(matches(PAYMENT_REFERENCE_PATTERN, paymentReference("fik-71", 1000)!) && matches(PAYMENT_REFERENCE_PATTERN, paymentReference("fik-75", 1000)!))
  })
})
