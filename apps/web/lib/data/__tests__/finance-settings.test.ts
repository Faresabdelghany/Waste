// Settings › Finance & invoicing on the Pilot (#291 C4): what a person types
// into the company's invoice identity and a project's or a customer's terms,
// read as the wire spells it and refused here by the domain's own shapes
// (`@waste/domain/finance/payment`) before the API is asked.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BIC_PATTERN, FIK_CREDITOR_PATTERN, IBAN_PATTERN, VAT_NUMBER_PATTERN } from "@waste/domain/finance/payment"
import { PAYMENT_REFERENCE_SCHEMES } from "@waste/domain/finance/vocabulary"

import {
  COMPANY_IDENTITY_FIELDS,
  identityRefusalOf,
  identityValueOf,
  paymentReferenceSchemeLabel,
  paymentTermsLabel,
  paymentTermsRefusalOf,
} from "../finance-settings"

describe("the company's invoice identity", () => {
  test("a code is read as the wire spells it: spaces gone, upper case, and a blank one is none", () => {
    assert.equal(identityValueOf(" dk 1234 5678 "), "DK12345678")
    assert.equal(identityValueOf("dk50 0040 0440 1162 43"), "DK5000400440116243")
    assert.equal(identityValueOf("   "), null)
    assert.equal(identityValueOf(""), null)
  })

  test("each field is judged by the domain's own pattern, the one the database and the contracts read", () => {
    assert.deepEqual(
      COMPANY_IDENTITY_FIELDS.map((field) => [field.key, field.pattern]),
      [
        ["vatNumber", VAT_NUMBER_PATTERN],
        ["bankIban", IBAN_PATTERN],
        ["bankBic", BIC_PATTERN],
        ["fikCreditorNumber", FIK_CREDITOR_PATTERN],
      ],
    )
    for (const field of COMPANY_IDENTITY_FIELDS) {
      assert.equal(identityRefusalOf(field.key, field.example), null, `${field.label}'s example passes its own pattern`)
      assert.equal(identityRefusalOf(field.key, ""), null, `${field.label} may be left blank`)
    }
  })

  test("a malformed value is refused with the field's name and what it looks like", () => {
    assert.equal(identityRefusalOf("vatNumber", "12345678"), "A VAT number starts with its country's two letters, as DK12345678")
    assert.equal(identityRefusalOf("bankIban", "DK50"), "An IBAN is its country's two letters, two check digits and the account, as DK5000400440116243")
    assert.equal(identityRefusalOf("bankBic", "DABA"), "A BIC is 8 or 11 letters and digits, as DABADKKK")
    assert.equal(identityRefusalOf("fikCreditorNumber", "1234"), "A FIK creditor number is 8 digits, as 85123456")
    assert.equal(identityRefusalOf("bankIban", "dk50 0040 0440 1162 43"), null, "judged as the wire will spell it")
  })
})

describe("payment terms", () => {
  test("terms are a whole number of days from 0 to 365", () => {
    for (const text of ["0", "8", "30", "365", " 14 "]) assert.equal(paymentTermsRefusalOf(text), null, text)
    for (const text of ["", "-1", "366", "4.5", "thirty", "1e2"]) assert.equal(paymentTermsRefusalOf(text), "Payment terms are a whole number of days from 0 to 365", text)
  })

  test("they read as days, and no terms of its own as the project's", () => {
    assert.equal(paymentTermsLabel(30), "30 days")
    assert.equal(paymentTermsLabel(1), "1 day")
    assert.equal(paymentTermsLabel(0), "Due on issue")
    assert.equal(paymentTermsLabel(null), "The project's")
  })
})

describe("the payment reference scheme", () => {
  test("every scheme the vocabulary holds has a label", () => {
    assert.deepEqual(
      PAYMENT_REFERENCE_SCHEMES.map(paymentReferenceSchemeLabel),
      ["None", "FIK 71", "FIK 75"],
    )
  })
})
