// Money on the Pilot (#185, #148): integer minor units on the wire, converted
// once each way — a form's amount into the currency's minor units on the way
// out, a row's minor units into the form's amount on the way in — and shown
// through Intl.NumberFormat in the row's own currency.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { formatMinor, majorOf, minorDigits, minorOf } from "../money"

describe("money in minor units", () => {
  test("knows how many minor digits a currency has", () => {
    assert.equal(minorDigits("DKK"), 2)
    assert.equal(minorDigits("EUR"), 2)
    assert.equal(minorDigits("JPY"), 0)
    assert.equal(minorDigits("KWD"), 3)
  })

  test("reads a form's amount as the currency's minor units, without floating point", () => {
    assert.equal(minorOf("18.50", "DKK"), 1850)
    assert.equal(minorOf("18.5", "DKK"), 1850)
    assert.equal(minorOf("18", "DKK"), 1800)
    assert.equal(minorOf(" 0.07 ", "DKK"), 7)
    assert.equal(minorOf("1234.56", "DKK"), 123456)
    assert.equal(minorOf("4.35", "DKK"), 435, "a float would make 434.99999")
    assert.equal(minorOf("1500", "JPY"), 1500)
    assert.equal(minorOf("1.234", "KWD"), 1234)
  })

  test("reads a decimal comma as a person in Denmark types it", () => {
    assert.equal(minorOf("18,50", "DKK"), 1850)
  })

  test("refuses what is not an amount in the currency: NaN, for the caller's refusal", () => {
    for (const text of ["", "abc", "18.505", "-3", "1e3", "18.50.1", "1,234.50"]) assert.ok(Number.isNaN(minorOf(text, "DKK")), text)
    assert.ok(Number.isNaN(minorOf("15.5", "JPY")), "a yen has no minor digits")
  })

  test("writes minor units back as the form's amount, every minor digit spelled", () => {
    assert.equal(majorOf(1850, "DKK"), "18.50")
    assert.equal(majorOf(7, "DKK"), "0.07")
    assert.equal(majorOf(0, "DKK"), "0.00")
    assert.equal(majorOf(-2350, "DKK"), "-23.50")
    assert.equal(majorOf(1500, "JPY"), "1500")
    assert.equal(majorOf(1234, "KWD"), "1.234")
  })

  test("formats minor units in the row's currency", () => {
    assert.equal(formatMinor(1850, "DKK"), "DKK 18.50")
    assert.equal(formatMinor(-1850, "DKK"), "-DKK 18.50")
    assert.equal(formatMinor(123456789, "DKK"), "DKK 1,234,567.89")
    assert.equal(formatMinor(1850, "EUR"), "€18.50")
    assert.equal(formatMinor(1500, "JPY"), "¥1,500")
  })

  test("round-trips every amount a form can say", () => {
    for (const minor of [0, 1, 99, 100, 1850, 99999, 123456789]) assert.equal(minorOf(majorOf(minor, "DKK"), "DKK"), minor)
  })
})
