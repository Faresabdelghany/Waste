// A CSV file read into an import's rows: RFC 4180's quoting, either line
// ending, a Danish spreadsheet's semicolons, the byte-order mark, spreadsheet
// row numbers, empty records skipped, and the header matched to the kind's
// columns whatever its spelling.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { columnOf, headerIssues, headerKey, IMPORT_COLUMNS } from "../columns"
import { csvField, csvRecords, importRows, importTemplate, separatorOf } from "../csv"
import { IMPORT_KINDS } from "../vocabulary"

describe("csvRecords", () => {
  test("reads quoted fields with separators, line breaks and doubled quotes, numbering records by spreadsheet row", () => {
    const text = 'name,address\r\n"Parkvej 18","Parkvej 18, 2100 København Ø"\r\n"The ""big"" house","line one\nline two"\r\n'
    assert.deepEqual(csvRecords(text), [
      { row: 1, fields: ["name", "address"] },
      { row: 2, fields: ["Parkvej 18", "Parkvej 18, 2100 København Ø"] },
      { row: 3, fields: ['The "big" house', "line one\nline two"] },
    ])
  })

  test("drops the byte-order mark, takes LF and CR alone, and skips empty records while still counting their rows", () => {
    assert.deepEqual(csvRecords("﻿label\nBIN-1\n\n,\rBIN-2"), [
      { row: 1, fields: ["label"] },
      { row: 2, fields: ["BIN-1"] },
      { row: 5, fields: ["BIN-2"] },
    ])
  })

  test("counts a header's separators outside its quoted fields", () => {
    assert.equal(separatorOf('"name, as given";kind;email\n'), ";")
    assert.equal(separatorOf('"name; as given",kind\n'), ",")
  })

  test("reads a Danish spreadsheet's semicolons where the header holds more of them than commas", () => {
    assert.equal(separatorOf("label;container type;notes\n"), ";")
    assert.equal(separatorOf("label,container type\n"), ",")
    assert.deepEqual(csvRecords("label;notes\nBIN-1;Lid, replaced\n")[1], { row: 2, fields: ["BIN-1", "Lid, replaced"] })
  })

  test("is empty for an empty file", () => {
    assert.deepEqual(csvRecords(""), [])
  })
})

describe("the columns", () => {
  test("every kind has columns, each header once, the required ones first among them where a row needs them", () => {
    for (const kind of IMPORT_KINDS) {
      const headers = IMPORT_COLUMNS[kind].map((column) => headerKey(column.header))
      assert.ok(headers.length > 0, kind)
      assert.equal(new Set(headers).size, headers.length, `${kind} names a column twice`)
      assert.ok(IMPORT_COLUMNS[kind].some((column) => column.required), `${kind} requires something`)
    }
  })

  test("a header names its column whatever its case, spacing, hyphens or underscores", () => {
    for (const spelling of ["Registration number", "registration_number", " REGISTRATION-NUMBER ", "registration  number"]) {
      assert.equal(columnOf("customers", spelling)?.header, "registration number", spelling)
    }
    assert.equal(columnOf("customers", "cvr"), undefined)
  })

  test("a header row is told the columns the kind does not know, the required ones it lacks and the ones it names twice", () => {
    assert.deepEqual(headerIssues("containers", ["Label", "colour", "label", ""]), { unknown: ["colour"], missing: ["container type"], repeated: ["label"] })
    assert.deepEqual(headerIssues("customers", ["kind", "name"]), { unknown: [], missing: [], repeated: [] })
  })
})

describe("importRows", () => {
  test("keys each row's non-empty cells by the kind's own headers, trimmed, with the header row's issues beside them", () => {
    const file = importRows("customers", "Kind,Name,Registration_Number,Shoe size\norganisation, Østerbro Housing , 12345678,44\nperson,Anna Andersen,,\n")
    assert.deepEqual(file.rows, [
      { row: 2, values: { kind: "organisation", name: "Østerbro Housing", "registration number": "12345678" } },
      { row: 3, values: { kind: "person", name: "Anna Andersen" } },
    ])
    assert.deepEqual(file.issues, { unknown: ["Shoe size"], missing: [], repeated: [], unclosedQuote: null })
  })

  test("reads a cell an export guarded with an apostrophe without it, and leaves any other apostrophe as typed", () => {
    const file = importRows("customers", "kind,name,phone,email\nperson,'=Anna,'+45 11 11 11 11,o'brien@example.com\n")
    assert.deepEqual(file.rows[0]?.values, { kind: "person", name: "=Anna", phone: "+45 11 11 11 11", email: "o'brien@example.com" })
  })

  test("says the row a quoted field opened on when it never closes, since every row after it ran into it", () => {
    const file = importRows("properties", 'address,name,kind\n"Parkvej 18, 2100,Parkvej 18,residential\nHavnegade 4,Havnegade 4,commercial\n')
    assert.equal(file.issues.unclosedQuote, 2)
    assert.equal(file.rows.length, 1)
    assert.equal(importRows("properties", 'address,name,kind\n"Parkvej 18, 2100",Parkvej 18,residential\n').issues.unclosedQuote, null)
  })

  test("a file with no header row has no rows, and lacks every required column", () => {
    assert.deepEqual(importRows("containers", ""), { rows: [], issues: { unknown: [], missing: ["label", "container type"], repeated: [], unclosedQuote: null } })
  })
})

describe("importTemplate", () => {
  test("is each kind's header row behind the byte-order mark, which the reader reads back as exactly the kind's columns", () => {
    for (const kind of IMPORT_KINDS) {
      for (const separator of [",", ";"] as const) {
        const template = importTemplate(kind, separator)
        assert.ok(template.startsWith("\uFEFF") && template.endsWith("\r\n"))
        const file = importRows(kind, template)
        assert.deepEqual(file.rows, [])
        assert.deepEqual(file.issues, { unknown: [], missing: [], repeated: [], unclosedQuote: null }, `${kind} with ${separator}`)
        assert.deepEqual(csvRecords(template)[0]?.fields, IMPORT_COLUMNS[kind].map((column) => column.header))
      }
    }
  })

  test("quotes a field holding the separator, a quote or a line break, and nothing else", () => {
    assert.equal(csvField("plain", ","), "plain")
    assert.equal(csvField("a,b", ","), '"a,b"')
    assert.equal(csvField("a,b", ";"), "a,b")
    assert.equal(csvField("a;b", ";"), '"a;b"')
    assert.equal(csvField('say "hi"', ","), '"say ""hi"""')
    assert.equal(csvField("two\nlines", ";"), '"two\nlines"')
  })
})
