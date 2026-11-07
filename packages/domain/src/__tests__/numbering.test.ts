import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { invoiceLabel, numberLabel, numberOf, routeLabel, scaleTicketLabel, ticketLabel } from "../numbering"

describe("a numbered document's label", () => {
  test("is the number under its series' prefix", () => {
    assert.equal(routeLabel(1042), "RC-1042")
    assert.equal(routeLabel(7), "RC-7")
    assert.equal(ticketLabel(8831), "T-8831")
    assert.equal(scaleTicketLabel(12), "ST-12")
  })

  test("an invoice and a credit note share one series, the prefix telling the kinds apart", () => {
    assert.equal(invoiceLabel("invoice", 26007188), "INV-26007188")
    assert.equal(invoiceLabel("credit-note", 26007189), "CN-26007189")
    assert.equal(invoiceLabel("invoice", 7), "INV-7")
  })

  test("is read back by the same table: the number under the document's prefix, or null", () => {
    assert.equal(numberOf("invoice", "INV-26007188"), 26007188)
    assert.equal(numberOf("invoice", numberLabel("invoice", 7)), 7)
    assert.equal(numberOf("invoice", "CN-26007189"), null, "a credit note's")
    assert.equal(numberOf("invoice", "INV-"), null)
    assert.equal(numberOf("invoice", "INV-12a"), null)
    assert.equal(numberOf("ticket", "T-0042"), 42)
  })
})
