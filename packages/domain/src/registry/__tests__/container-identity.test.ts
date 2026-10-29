import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { identifiedBy, normaliseCode } from "../container-identity"

const bin = { label: "BIN-82014", barcode: "WH82014", rfid: "E20082014", serialNumber: "SEED-26-82014" }

describe("a code read off a bin (O19 of #290)", () => {
  test("names the container by whichever of its four identifiers it spells, the label first", () => {
    assert.equal(identifiedBy(bin, "BIN-82014"), "label")
    assert.equal(identifiedBy(bin, "WH82014"), "barcode")
    assert.equal(identifiedBy(bin, "E20082014"), "rfid")
    assert.equal(identifiedBy(bin, "SEED-26-82014"), "serial-number")
    assert.equal(identifiedBy({ ...bin, barcode: "BIN-82014" }, "BIN-82014"), "label", "a label and a barcode alike: the label is named")
  })

  test("is compared as a person reads it: spaces either side dropped, the case ignored", () => {
    assert.equal(identifiedBy(bin, "  wh82014 "), "barcode")
    assert.equal(normaliseCode(" e200 "), "E200")
  })

  test("names nothing it does not spell, and a blank code names nothing, an identifier the container lacks included", () => {
    assert.equal(identifiedBy(bin, "WH82015"), undefined)
    assert.equal(identifiedBy({ ...bin, rfid: null }, "E20082014"), undefined)
    assert.equal(identifiedBy(bin, "   "), undefined)
    assert.equal(identifiedBy({ ...bin, rfid: "" }, ""), undefined)
  })
})
