// The CSV the web writes (#292): RFC 4180's quoting, a formula's first
// character defused, numbers as numbers, UTF-8 said up front, and a file
// name a download can carry.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CSV_BOM, csvField, csvFileName, csvOf } from "../csv"

describe("csvField", () => {
  test("leaves plain text alone, and quotes a comma, a quote, a line break and an edge space, doubling the quote", () => {
    assert.equal(csvField("Parkvej 18"), "Parkvej 18")
    assert.equal(csvField("Parkvej 18, 2100 København Ø"), '"Parkvej 18, 2100 København Ø"')
    assert.equal(csvField('The "big" bin'), '"The ""big"" bin"')
    assert.equal(csvField("two\nlines"), '"two\nlines"')
    assert.equal(csvField(" padded"), '" padded"')
  })

  test("defuses a cell a spreadsheet would run as a formula, and writes a number, even a negative one, as a number", () => {
    assert.equal(csvField("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"")
    assert.equal(csvField("+45 12 34"), "'+45 12 34")
    assert.equal(csvField("-12"), "'-12", "text that looks negative is still text")
    assert.equal(csvField("@SUM(A1)"), "'@SUM(A1)")
    assert.equal(csvField(-12_000), "-12000")
    assert.equal(csvField(0.5), "0.5")
    assert.equal(csvField(Number.NaN), "")
  })

  test("writes nothing for a missing cell", () => {
    assert.equal(csvField(null), "")
    assert.equal(csvField(undefined), "")
    assert.equal(csvField(""), "")
  })
})

describe("csvOf", () => {
  test("is the byte-order mark, the header and the rows, CRLF after each record", () => {
    assert.equal(csvOf(["Name", "Net kg"], [["Residual waste", 14_800], ["Glass, clear", 0]]), `${CSV_BOM}Name,Net kg\r\nResidual waste,14800\r\n"Glass, clear",0\r\n`)
    assert.equal(csvOf(["Name"], []), `${CSV_BOM}Name\r\n`, "a header alone is a file with no rows")
  })
})

describe("csvFileName", () => {
  test("is the parts as lowercase words joined by hyphens, Danish letters folded, .csv on the end", () => {
    assert.equal(csvFileName("Route Studio", "Routes", "2026-10-24"), "route-studio-routes-2026-10-24.csv")
    assert.equal(csvFileName("Tonnage", "Østerbro · Ærø"), "tonnage-osterbro-aero.csv")
    assert.equal(csvFileName("—"), "export.csv")
  })
})
