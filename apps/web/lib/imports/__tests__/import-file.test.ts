import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PROJECT_IMPORT_KINDS } from "@waste/contracts/imports"
import { IMPORT_BATCH_MAX, IMPORT_KINDS, IMPORT_ROWS_MAX } from "@waste/domain/imports/vocabulary"

import {
  batchesOf,
  countsOf,
  IMPORT_KIND_OPTIONS,
  importableKinds,
  importReason,
  mayImport,
  mayView,
  readImportFile,
  templateSeparatorFor,
  textOf,
} from "../import-file"

const grants = (...entries: [string, ...string[]][]) => entries.map(([moduleKey, ...actions]) => ({ moduleKey, actions }))

describe("the kinds a role imports", () => {
  test("every kind is offered once, each writing the module the API asks its grants on", () => {
    assert.deepEqual(IMPORT_KIND_OPTIONS.map((option) => option.kind), [...IMPORT_KINDS])
    assert.deepEqual(
      IMPORT_KIND_OPTIONS.map((option) => [option.kind, option.moduleKey, option.projectScoped]),
      [
        ["customers", "customers.contacts", false],
        ["properties", "customers.properties", true],
        ["containers", "resources.containers", true],
        ["agreements", "customers.agreements", true],
        ["waste-fractions", "configure.master", false],
        ["container-types", "configure.master", false],
        ["vehicle-types", "configure.master", false],
      ],
    )
    // The web's project rule is the contracts': a project's kinds and no other.
    assert.deepEqual(IMPORT_KIND_OPTIONS.filter((option) => option.projectScoped).map((option) => option.kind), [...PROJECT_IMPORT_KINDS])
  })

  test("needs the import's create and, per kind, its module's create or edit", () => {
    assert.deepEqual(importableKinds(grants(["customers.contacts", "view", "create"])), [], "no import grant, no kind")
    const role = grants(["improve.imports", "view", "create"], ["customers.contacts", "view", "edit"], ["resources.containers", "view"], ["customers.agreements", "view", "create"])
    assert.deepEqual(importableKinds(role).map((option) => option.kind), ["customers", "agreements"])
    assert.deepEqual(importableKinds([...role, ...grants(["configure.master", "view", "edit"])]).map((option) => option.kind), ["customers", "agreements", "waste-fractions", "container-types", "vehicle-types"], "the master data's edit opens the catalogue")
    assert.equal(mayImport(role), true)
    assert.equal(mayView(grants(["improve.imports", "view"])), true)
    assert.equal(mayImport(grants(["improve.imports", "view"])), false)
    assert.equal(mayView(undefined), false)
  })
})

describe("a file's bytes", () => {
  test("read as UTF-8, and as the Windows code page a spreadsheet saves plain CSV in where they are not", () => {
    assert.equal(textOf(new TextEncoder().encode("name\nØsterbro\n")), "name\nØsterbro\n")
    // "Østerbro" in Windows-1252: Ø is the single byte 0xD8, which UTF-8 refuses.
    assert.equal(textOf(Uint8Array.from([0x6e, 0x0a, 0xd8, 0x73, 0x74, 0x65, 0x72, 0x62, 0x72, 0x6f])), "n\nØsterbro")
  })
})

describe("readImportFile", () => {
  test("stops a file lacking a required column, naming a column twice, holding no rows or an unclosed quote, and notes the columns it will not read", () => {
    assert.deepEqual(readImportFile("containers", "label,colour\nBIN-1,red\n").blocking, ["The file has no container type column; every row needs it."])
    assert.deepEqual(readImportFile("containers", "label,colour\nBIN-1,red\n").ignored, ["colour"])
    assert.deepEqual(readImportFile("customers", "kind\n").blocking, ["The file has no name column; every row needs it.", "The file has no rows below its header."])
    assert.deepEqual(readImportFile("customers", "kind,name,Name\nperson,A,B\n").blocking, ["The file names name twice; give each column once."])
    assert.deepEqual(readImportFile("properties", 'address,name,kind\n"Parkvej 18,Parkvej 18,residential\n').blocking[0], "Row 2 opens a quoted cell that never closes, so every row after it ran into it; close the quote and choose the file again.")
    const fine = readImportFile("customers", "kind,name,email\nperson,Anna,anna@example.com\n")
    assert.deepEqual(fine.blocking, [])
    assert.deepEqual(fine.file.rows, [{ row: 2, values: { kind: "person", name: "Anna", email: "anna@example.com" } }])
  })

  test("stops a file of more rows than an import takes", () => {
    const text = `kind,name\n${"person,A\n".repeat(IMPORT_ROWS_MAX + 1)}`
    assert.match(readImportFile("customers", text).blocking.join(" "), new RegExp(`at most ${IMPORT_ROWS_MAX}`))
  })
})

describe("the commit", () => {
  test("sends a file in batches of at most what one request takes, in order", () => {
    const rows = Array.from({ length: IMPORT_BATCH_MAX * 2 + 3 }, (_, index) => index)
    const batches = batchesOf(rows)
    assert.deepEqual(batches.map((batch) => batch.length), [IMPORT_BATCH_MAX, IMPORT_BATCH_MAX, 3])
    assert.deepEqual(batches.flat(), rows)
    assert.deepEqual(batchesOf([]), [])
  })

  test("records its writes under the office's reason, else the file's name, at most what the audit log keeps", () => {
    assert.equal(importReason("kunder æøå.csv"), "CSV import kunder æøå.csv")
    assert.equal(importReason("kunder.csv", "  Moving from the old register "), "Moving from the old register")
    assert.equal(importReason("kunder.csv", "   "), "CSV import kunder.csv", "a blank reason is none")
    assert.equal(importReason("x".repeat(3000)).length, 2000)
  })

  test("counts the rows each way", () => {
    const result = (outcome: "created" | "updated" | "unchanged" | "refused") => ({ row: 2, outcome, key: null, resourceId: null, detail: null })
    assert.deepEqual(countsOf([result("created"), result("refused"), result("created")]), { created: 2, updated: 0, unchanged: 0, refused: 1 })
  })
})

describe("the template", () => {
  test("is asked for with semicolons where the locale writes a decimal comma", () => {
    assert.equal(templateSeparatorFor("da-DK"), "semicolon")
    assert.equal(templateSeparatorFor("de-DE"), "semicolon")
    assert.equal(templateSeparatorFor("en-GB"), "comma")
  })
})
