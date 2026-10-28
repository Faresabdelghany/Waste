// A waste transfer note's PDF (O18 of #290): the model the domain makes of an
// unload's rows laid out on one A4 page in the PDF standard fonts. The same
// model renders the same bytes, which a golden sha256 pins under pdf-lib's
// exact version, as the invoice's does (./invoice.test.ts); what the page
// says is read back from the file, its content stream inflated and its text
// operators decoded from WinAnsi hex.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { describe, test } from "node:test"
import { inflateSync } from "node:zlib"

import { transferNoteOf, type TransferNoteInput } from "@waste/domain/execution/transfer-note"

import { renderTransferNote } from "../transfer-note"

/** The pdf-lib the golden was taken with; package.json pins it exactly. */
const PDF_LIB_VERSION = "1.17.1"

/** The sha256 of `note()`'s file under PDF_LIB_VERSION. A layout change moves it on purpose; a pdf-lib bump moves it with the pin. */
const GOLDEN = "3713f20d45c5a449cc88ec6048d32d2ae70e028964c6b4f3cd374ac36f9de295"

const note = (overrides: Partial<TransferNoteInput> = {}): TransferNoteInput => ({
  language: "da",
  unloadId: "01a0d2a4-a280-7a00-8000-000000000042",
  occurredOn: "2026-10-05",
  occurredAt: "14:32",
  timezone: "Europe/Copenhagen",
  projectName: "Kystbyen Kommune",
  holder: { legalName: "Kystbyen Renovation A/S", registrationNumber: "12345678", postalAddress: "Havnegade 4\n2100 København Ø" },
  carrier: { vehicleRegistration: "AB 12 345", driverName: "Mads Jensen", routeLabel: "RC-1042" },
  station: { name: "ARC Amager", code: "ARC-AMAGER", address: "Vindmøllevej 6\n2300 København S" },
  waste: { fractionName: "Restaffald", wasteCode: "200301", hazardous: false, netKg: 8_000, grossKg: 22_000, tareKg: 14_000 },
  weighbridgeTicket: "WB-2026-3901",
  note: null,
  ...overrides,
})

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** WinAnsi's characters at 0x80–0x9F that Latin-1 reads otherwise, the ones the model writes. */
const WIN_ANSI: Readonly<Record<string, string>> = { "\x80": "€", "\x85": "…", "\x96": "–", "\x97": "—" }

/** Every page's text, in drawing order. */
function pagesOf(bytes: Uint8Array): string[][] {
  const file = Buffer.from(bytes)
  const pages: string[][] = []
  for (const match of file.toString("latin1").matchAll(/\/Filter \/FlateDecode\n\/Length (\d+)\n>>\nstream\n/g)) {
    const from = (match.index ?? 0) + match[0].length
    const content = inflateSync(Uint8Array.from(file.subarray(from, from + Number(match[1])))).toString("latin1")
    const texts = [...content.matchAll(/<([0-9A-Fa-f]*)> Tj/g)].map(([, hex]) => Buffer.from(hex, "hex").toString("latin1").replace(/[\x80-\x9f]/g, (character) => WIN_ANSI[character] ?? character))
    if (texts.length > 0) pages.push(texts)
  }
  return pages
}

describe("a waste transfer note's PDF", () => {
  test("is the same bytes every time, one A4 page with no clock in it, dated the day of the transfer", async () => {
    const document = transferNoteOf(note())
    const first = await renderTransferNote(document)
    assert.equal(sha256(first), sha256(await renderTransferNote(document)))
    const text = Buffer.from(first).toString("latin1")
    assert.match(text, /^%PDF-1\.7/)
    assert.match(text, /\/MediaBox \[ 0 0 595\.28 841\.89 \]/)
    assert.doesNotMatch(text, /\/ID |\/Producer|\/ModDate/)
    assert.match(text, /\/CreationDate \(D:20261005000000Z\)/)
    assert.equal(pagesOf(first).length, 1)
  })

  test("is pinned by its golden, under the pdf-lib it was taken with", async () => {
    const require = createRequire(import.meta.url)
    const installed = JSON.parse(await readFile(require.resolve("pdf-lib/package.json"), "utf8")) as { version: string }
    assert.equal(installed.version, PDF_LIB_VERSION, "pdf-lib moved: render note() again, check the page by eye, and move GOLDEN with PDF_LIB_VERSION")
    assert.equal(sha256(await renderTransferNote(transferNoteOf(note()))), GOLDEN)
  })

  test("says what the model says: the holder, the number, every section's rows, the declaration and the signatures", async () => {
    const [page] = pagesOf(await renderTransferNote(transferNoteOf(note())))
    for (const said of ["Kystbyen Renovation A/S", "Følgeseddel for affald", "01a0d2a4-a280-7a00-8000-000000000042", "Overdrager og transportør", "AB 12 345", "Modtager", "ARC Amager", "Affaldskode (EAK)", "20 03 01", "Nej", "8.000 kg", "WB-2026-3901", "05.10.2026", "14:32 (Europe/Copenhagen)", "Overdragers underskrift", "Modtagers underskrift"]) {
      assert.ok(page.includes(said), `the page says ${said}`)
    }
    assert.ok(!page.includes("FARLIGT AFFALD"), "no banner over waste that is not hazardous")
  })

  test("carries the banner over hazardous waste", async () => {
    const [page] = pagesOf(await renderTransferNote(transferNoteOf(note({ language: "en", waste: { fractionName: "Batteries", wasteCode: "200133*", hazardous: true, netKg: 1_250, grossKg: null, tareKg: null } }))))
    for (const said of ["HAZARDOUS WASTE", "Waste transfer note", "20 01 33*", "Yes", "1,250 kg"]) assert.ok(page.includes(said), `the page says ${said}`)
  })

  test("loads pdf-lib inside the render, never when the module is imported", async () => {
    const source = await readFile(new URL("../transfer-note.ts", import.meta.url), "utf8")
    assert.doesNotMatch(source, /^import [^\n]* from "pdf-lib"/m)
    assert.match(source, /await import\("pdf-lib"\)/)
  })
})
