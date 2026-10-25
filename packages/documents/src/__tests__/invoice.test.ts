// An invoice's PDF (#291 slice 5, #292 C5): the model the domain makes of the
// ledger's rows laid out on A4 in the PDF standard fonts. The same model
// renders the same bytes, which a golden sha256 pins — held to pdf-lib's
// exact version, so a bump that moves a byte fails here and the golden moves
// with the pin, on purpose. What the pages say is read back from the file:
// each content stream inflated and its text operators decoded, since
// pdf-lib writes a standard font's text as WinAnsi hex.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { describe, test } from "node:test"
import { inflateSync } from "node:zlib"

import { invoiceDocumentOf, type InvoiceDocumentInput, type InvoiceDocumentLine } from "@waste/domain/finance/invoice-document"
import { paymentReference } from "@waste/domain/finance/payment"

import { renderInvoiceDocument } from "../invoice"

/** The pdf-lib the golden was taken with; package.json pins it exactly. */
const PDF_LIB_VERSION = "1.17.1"

/** The sha256 of `invoice()`'s file under PDF_LIB_VERSION. A layout change moves it on purpose; a pdf-lib bump moves it with the pin. */
const GOLDEN = "bbf15f8584c1c2c4b8546b7424692fd8c3abae9de755a8a61cc2ea513bd72e2f"

const REFERENCE = paymentReference("fik-71", 26007188) ?? assert.fail("fik-71 gives a reference")

const line = (n: number): InvoiceDocumentLine => ({ description: `Tømning 240 L restaffald, uge ${n}`, serviceDate: "2026-09-02", quantity: 1, unitPriceMinor: 25_000, netMinor: 25_000, vatPercent: 25, vatMinor: 6_250 })

const invoice = (lines: InvoiceDocumentLine[] = [line(1), line(2)]): InvoiceDocumentInput => ({
  kind: "invoice",
  label: "INV-26007188",
  language: "da",
  currency: "DKK",
  issuedOn: "2026-10-05",
  dueOn: "2026-10-13",
  periodFrom: "2026-09-01",
  periodTo: "2026-09-30",
  paymentReference: REFERENCE,
  credits: null,
  netMinor: lines.reduce((sum, row) => sum + row.netMinor, 0),
  vatMinor: lines.reduce((sum, row) => sum + row.vatMinor, 0),
  grossMinor: lines.reduce((sum, row) => sum + row.netMinor + row.vatMinor, 0),
  lines,
  parties: {
    seller: { legalName: "Kystbyen Renovation A/S", registrationNumber: "12345678", vatNumber: "DK12345678", postalAddress: "Havnegade 4\n2100 København Ø", bankIban: "DK5000400440116243", bankBic: "DABADKKK", fikCreditorNumber: "85123456" },
    buyer: { name: "Østerbro Housing", registrationNumber: "38112009", billingAddress: "Nørrebrogade 1\n2200 København N" },
  },
})

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** WinAnsi's characters at 0x80–0x9F that Latin-1 reads otherwise, the ones the model writes. */
const WIN_ANSI: Readonly<Record<string, string>> = { "\x80": "€", "\x85": "…", "\x96": "–", "\x97": "—", "\x93": "“", "\x94": "”" }

/** Every page's text, in drawing order: each FlateDecode stream read by its /Length and inflated, each `<hex> Tj` decoded from WinAnsi. */
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

describe("an invoice's PDF", () => {
  test("is the same bytes every time, a PDF of one A4 page with no clock in it", async () => {
    const document = invoiceDocumentOf(invoice())
    const first = await renderInvoiceDocument(document)
    const second = await renderInvoiceDocument(document)
    assert.equal(sha256(first), sha256(second))
    const text = Buffer.from(first).toString("latin1")
    assert.match(text, /^%PDF-1\.7/)
    assert.match(text, /\/MediaBox \[ 0 0 595\.28 841\.89 \]/)
    assert.doesNotMatch(text, /\/ID |\/Producer|\/ModDate/, "no file id, no producer, no modification stamp: nothing the clock or the library adds")
    assert.match(text, /\/CreationDate \(D:20261005000000Z\)/, "the day it was issued")
  })

  test("is pinned by its golden, under the pdf-lib it was taken with", async () => {
    const require = createRequire(import.meta.url)
    const installed = JSON.parse(await readFile(require.resolve("pdf-lib/package.json"), "utf8")) as { version: string }
    assert.equal(installed.version, PDF_LIB_VERSION, "pdf-lib moved: render invoice() again, check the pages by eye, and move GOLDEN with PDF_LIB_VERSION")
    assert.equal(sha256(await renderInvoiceDocument(invoiceDocumentOf(invoice()))), GOLDEN)
  })

  test("says what the model says: the parties, the facts, every line, the totals, how to pay and the FIK line", async () => {
    const [page] = pagesOf(await renderInvoiceDocument(invoiceDocumentOf(invoice())))
    for (const said of ["Faktura", "INV-26007188", "Kystbyen Renovation A/S", "Havnegade 4", "Momsnr. DK12345678", "Østerbro Housing", "Nørrebrogade 1", "Forfaldsdato", "13.10.2026", REFERENCE, "Tømning 240 L restaffald, uge 1", "250,00", "I alt DKK", "625,00", "Betales senest 13.10.2026", "IBAN DK5000400440116243 · BIC DABADKKK", `+71<${REFERENCE}+85123456<`, "INV-26007188 · 1/1"]) {
      assert.ok(page.includes(said), `the page says ${said}`)
    }
  })

  test("runs its lines onto further pages, the header and the columns again on each, the totals and the payment on the last", async () => {
    const lines = Array.from({ length: 60 }, (_, index) => line(index + 1))
    const pages = pagesOf(await renderInvoiceDocument(invoiceDocumentOf(invoice(lines))))
    assert.equal(pages.length, 2)
    for (const [index, page] of pages.entries()) {
      assert.ok(page.includes("INV-26007188"), `page ${index + 1} names the document`)
      assert.ok(page.includes("Beskrivelse"), `page ${index + 1} heads its columns`)
      assert.ok(page.includes(`INV-26007188 · ${index + 1}/2`), `page ${index + 1} counts itself`)
    }
    const drawn = pages.flat().filter((text) => text.startsWith("Tømning"))
    assert.deepEqual(drawn, lines.map((row) => row.description), "every line once, in order")
    assert.ok(!pages[0].includes("I alt DKK") && pages[1].includes("I alt DKK"), "the totals on the last page")
    assert.ok(pages[1].includes(`+71<${REFERENCE}+85123456<`))
  })

  test("cuts a description too long for its column with an ellipsis rather than running it into the next", async () => {
    const long = { ...line(1), description: "Tømning af 660 L container med restaffald fra gården bag Nørrebrogade 1, inklusive ekstra sække ved siden af" }
    const [page] = pagesOf(await renderInvoiceDocument(invoiceDocumentOf(invoice([long]))))
    const drawn = page.find((text) => text.startsWith("Tømning af 660 L"))
    assert.ok(drawn !== undefined && drawn.endsWith("…") && drawn.length < long.description.length, drawn)
  })

  test("loads pdf-lib inside the render, never when the module is imported, so nothing of it is held at boot", async () => {
    const source = await readFile(new URL("../invoice.ts", import.meta.url), "utf8")
    assert.doesNotMatch(source, /^import [^\n]* from "pdf-lib"/m, "no static import of pdf-lib")
    assert.match(source, /await import\("pdf-lib"\)/)
  })
})
