// An invoice's or a credit note's PDF (#291 slice 5, #292 C5): the model
// @waste/domain/finance/invoice-document makes of the ledger's rows, laid out
// on A4 in the PDF standard fonts — Helvetica, its bold, and Courier for the
// FIK card's code line — which every reader carries, so nothing is embedded
// and every string is the WinAnsi the model already spelled. The seller and
// the document's name head every page; the payer and the facts sit on the
// first; the lines run on as many pages as they need, the columns headed
// again on each; the VAT, the totals and how to pay close the last, on a page
// of their own where the last lines leave no room; and each page counts
// itself at its foot.
//
// Deterministic: nothing here reads a clock. The file's one date is the day
// the document was issued, and pdf-lib is created with `updateMetadata: false`
// and saved without object streams, so it adds no producer, no modification
// stamp and no file id. pdf-lib itself is imported inside the render, never
// at boot: the Pilot runs the API and the worker in one 256 MiB cgroup (#134).
import type { InvoiceDocument } from "@waste/domain/finance/invoice-document"

/** A4, in points. */
const PAGE: [number, number] = [595.28, 841.89]
const LEFT = 50
const RIGHT = PAGE[0] - 50
const TOP = PAGE[1] - 52
/** Where the lines stop, above the foot. */
const BOTTOM = 90
const FOOT = 40
const ROW = 14
const TEXT = 9

/** The columns: where each starts, or where a right-aligned one ends. */
const COLUMNS = {
  description: { x: LEFT, width: 255 },
  date: { x: 310 },
  quantity: { right: 395 },
  unitPrice: { right: 455 },
  vat: { right: 490 },
  amount: { right: RIGHT },
} as const

type Font = { widthOfTextAtSize(text: string, size: number): number }

/** The text cut to fit a width with an ellipsis, WinAnsi's own `…`. */
function fitted(text: string, width: number, font: Font, size: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text
  let cut = text
  while (cut.length > 0 && font.widthOfTextAtSize(`${cut}…`, size) > width) cut = cut.slice(0, -1)
  return `${cut.trimEnd()}…`
}

/**
 * The lines each page carries, as [from, to) of the model's lines: the first
 * page under the payer and the facts, the rest under the header alone, and a
 * last page of no lines where the last page's lines leave the closing block no room.
 */
function paginate(lineCount: number, firstRows: number, nextRows: number, closingRows: number): [number, number][] {
  const pages: [number, number][] = []
  let from = 0
  let capacity = firstRows
  do {
    const to = Math.min(lineCount, from + capacity)
    pages.push([from, to])
    from = to
    capacity = nextRows
  } while (from < lineCount)
  const [lastFrom, lastTo] = pages[pages.length - 1]
  const lastCapacity = pages.length === 1 ? firstRows : nextRows
  if (lastTo - lastFrom + closingRows > lastCapacity) pages.push([lineCount, lineCount])
  return pages
}

/** The document's PDF, its bytes the same for the same model. */
export async function renderInvoiceDocument(document: InvoiceDocument): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib")
  const pdf = await PDFDocument.create({ updateMetadata: false })
  pdf.setTitle(`${document.title} ${document.label}`)
  pdf.setCreationDate(new Date(`${document.issuedOn}T00:00:00Z`))
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const mono = await pdf.embedFont(StandardFonts.Courier)
  const ink = rgb(0, 0, 0)
  const grey = rgb(0.45, 0.45, 0.45)

  type Page = ReturnType<typeof pdf.addPage>
  const write = (page: Page, text: string, x: number, y: number, size = TEXT, font = regular, color = ink) => page.drawText(text, { x, y, size, font, color })
  const writeRight = (page: Page, text: string, right: number, y: number, size = TEXT, font = regular, color = ink) => write(page, text, right - font.widthOfTextAtSize(text, size), y, size, font, color)
  const rule = (page: Page, y: number) => page.drawLine({ start: { x: LEFT, y }, end: { x: RIGHT, y }, thickness: 0.5, color: grey })

  /** Where the header ends: the seller's name and at least two lines under it, or as many as it has. */
  const headerBottom = TOP - 14 - Math.max(document.seller.length - 1, 2) * 12 - 20

  /** The seller and the document's name, on every page; answers where the page's own content may begin. */
  const header = (page: Page): number => {
    const [name, ...rest] = document.seller
    write(page, name, LEFT, TOP, 11, bold)
    rest.forEach((text, index) => write(page, text, LEFT, TOP - 14 - index * 12))
    writeRight(page, document.title, RIGHT, TOP - 4, 18, bold)
    writeRight(page, document.label, RIGHT, TOP - 20, 10)
    return headerBottom
  }

  /** The payer and the facts, on the first page; answers where the lines begin. */
  const parties = (page: Page, top: number): number => {
    document.buyer.forEach((text, index) => write(page, text, LEFT, top - index * 12, TEXT, index === 0 ? bold : regular))
    document.facts.forEach(([label, value], index) => {
      write(page, label, 340, top - index * 12, TEXT, regular, grey)
      writeRight(page, value, RIGHT, top - index * 12)
    })
    return top - Math.max(document.buyer.length, document.facts.length) * 12 - 18
  }

  /** The columns' heads and the rule under them; answers where the first line sits. */
  const columns = (page: Page, top: number): number => {
    const [description, date, quantity, unitPrice, vat, amount] = document.columns
    write(page, description, COLUMNS.description.x, top, TEXT, bold)
    write(page, date, COLUMNS.date.x, top, TEXT, bold)
    writeRight(page, quantity, COLUMNS.quantity.right, top, TEXT, bold)
    writeRight(page, unitPrice, COLUMNS.unitPrice.right, top, TEXT, bold)
    writeRight(page, vat, COLUMNS.vat.right, top, TEXT, bold)
    writeRight(page, amount, COLUMNS.amount.right, top, TEXT, bold)
    rule(page, top - 5)
    return top - ROW - 4
  }

  /** The VAT per rate, the totals, how to pay and the FIK line, from `top` down. */
  const closing = (page: Page, top: number) => {
    let y = top - 6
    rule(page, y + 10)
    for (const [label, value] of document.vat) {
      writeRight(page, label, COLUMNS.vat.right, y, TEXT, regular, grey)
      writeRight(page, value, RIGHT, y)
      y -= ROW
    }
    document.totals.forEach(([label, value], index) => {
      const last = index === document.totals.length - 1
      writeRight(page, label, COLUMNS.vat.right, y, last ? 10 : TEXT, last ? bold : regular)
      writeRight(page, value, RIGHT, y, last ? 10 : TEXT, last ? bold : regular)
      y -= ROW
    })
    y -= 10
    for (const text of document.payment) {
      write(page, text, LEFT, y)
      y -= 12
    }
    if (document.fikLine !== null) write(page, document.fikLine, LEFT, y - 14, 11, mono)
  }

  // Where the lines fall, measured before any page is drawn, so every page can count the pages.
  const firstLinesTop = headerBottom - Math.max(document.buyer.length, document.facts.length) * 12 - 18 - ROW - 4
  const nextLinesTop = headerBottom - ROW - 4
  const rowsBetween = (top: number) => Math.floor((top - BOTTOM) / ROW) + 1
  const closingRows = document.vat.length + document.totals.length + Math.ceil((16 + document.payment.length * 12 + (document.fikLine === null ? 0 : 28)) / ROW)
  const pages = paginate(document.lines.length, rowsBetween(firstLinesTop), rowsBetween(nextLinesTop), closingRows)

  for (const [index, [from, to]] of pages.entries()) {
    const page = pdf.addPage(PAGE)
    const top = header(page)
    let y = columns(page, index === 0 ? parties(page, top) : top)
    for (const row of document.lines.slice(from, to)) {
      const [description, date, quantity, unitPrice, vat, amount] = row
      write(page, fitted(description, COLUMNS.description.width, regular, TEXT), COLUMNS.description.x, y)
      write(page, date, COLUMNS.date.x, y)
      writeRight(page, quantity, COLUMNS.quantity.right, y)
      writeRight(page, unitPrice, COLUMNS.unitPrice.right, y)
      writeRight(page, vat, COLUMNS.vat.right, y)
      writeRight(page, amount, COLUMNS.amount.right, y)
      y -= ROW
    }
    if (index === pages.length - 1) closing(page, y)
    const foot = `${document.label} · ${index + 1}/${pages.length}`
    write(page, foot, (PAGE[0] - regular.widthOfTextAtSize(foot, 8)) / 2, FOOT, 8, regular, grey)
  }
  return pdf.save({ useObjectStreams: false })
}
