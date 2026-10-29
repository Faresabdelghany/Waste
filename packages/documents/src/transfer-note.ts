// A waste transfer note's PDF (O18 of #290, row 8.6): the model
// @waste/domain/execution/transfer-note makes of an unload's rows, laid out on
// one A4 page in the PDF standard fonts, as the invoice is (./invoice.ts) —
// the holder and the note's name and number at the head, a banner under them
// where the waste is hazardous, then each section's heading over its rows,
// label and value, the declaration, and a line for each party to sign on.
//
// Deterministic for the same reasons as the invoice: nothing here reads a
// clock, the file's one date is the day of the transfer, and pdf-lib is
// created with `updateMetadata: false` and saved without object streams.
// pdf-lib is imported inside the render, never at boot (#134's 256 MiB).
import type { TransferNoteDocument } from "@waste/domain/execution/transfer-note"

/** A4, in points. */
const PAGE: [number, number] = [595.28, 841.89]
const LEFT = 50
const RIGHT = PAGE[0] - 50
const TOP = PAGE[1] - 52
const FOOT = 40
const ROW = 14
const TEXT = 9
/** Where a row's value begins, right of its label. */
const VALUE = 200

type Font = { widthOfTextAtSize(text: string, size: number): number }

/** The text cut to fit a width with an ellipsis, WinAnsi's own `…`. */
function fitted(text: string, width: number, font: Font, size: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text
  let cut = text
  while (cut.length > 0 && font.widthOfTextAtSize(`${cut}…`, size) > width) cut = cut.slice(0, -1)
  return `${cut.trimEnd()}…`
}

/** The text broken into lines no wider than `width`, at its spaces. */
function wrapped(text: string, width: number, font: Font, size: number): string[] {
  const lines: string[] = []
  let line = ""
  for (const word of text.split(" ")) {
    const candidate = line === "" ? word : `${line} ${word}`
    if (line !== "" && font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(line)
      line = word
    } else line = candidate
  }
  if (line !== "") lines.push(line)
  return lines
}

/** The note's PDF, its bytes the same for the same model. */
export async function renderTransferNote(document: TransferNoteDocument): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib")
  const pdf = await PDFDocument.create({ updateMetadata: false })
  pdf.setTitle(`${document.title} ${document.number[1]}`)
  pdf.setCreationDate(new Date(`${document.issuedOn}T00:00:00Z`))
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const ink = rgb(0, 0, 0)
  const grey = rgb(0.45, 0.45, 0.45)
  const hazard = rgb(0.75, 0.1, 0.1)

  const page = pdf.addPage(PAGE)
  const write = (text: string, x: number, y: number, size = TEXT, font = regular, color = ink) => page.drawText(text, { x, y, size, font, color })
  const writeRight = (text: string, right: number, y: number, size = TEXT, font = regular, color = ink) => write(text, right - font.widthOfTextAtSize(text, size), y, size, font, color)
  const rule = (y: number, from = LEFT, to = RIGHT) => page.drawLine({ start: { x: from, y }, end: { x: to, y }, thickness: 0.5, color: grey })

  // The holder and the note's name and number.
  const [name, ...rest] = document.holder
  write(name, LEFT, TOP, 11, bold)
  rest.forEach((text, index) => write(text, LEFT, TOP - 14 - index * 12))
  writeRight(document.title, RIGHT, TOP - 4, 16, bold)
  writeRight(document.number[0], RIGHT, TOP - 20, 8, regular, grey)
  writeRight(document.number[1], RIGHT, TOP - 31, 9)
  let y = TOP - 14 - Math.max(rest.length, 2) * 12 - 16

  if (document.hazardBanner !== null) {
    page.drawRectangle({ x: LEFT, y: y - 6, width: RIGHT - LEFT, height: 20, borderColor: hazard, borderWidth: 1 })
    write(document.hazardBanner, LEFT + 8, y, 11, bold, hazard)
    y -= 30
  }

  for (const section of document.sections) {
    write(section.heading, LEFT, y, 10, bold)
    rule(y - 4)
    y -= ROW + 4
    for (const [label, value] of section.rows) {
      write(fitted(label, VALUE - LEFT - 8, regular, TEXT), LEFT, y, TEXT, regular, grey)
      write(fitted(value, RIGHT - VALUE, regular, TEXT), VALUE, y)
      y -= ROW
    }
    y -= 10
  }

  for (const line of wrapped(document.declaration, RIGHT - LEFT, regular, TEXT)) {
    write(line, LEFT, y)
    y -= 12
  }

  // A line to sign on for each party, side by side, with its caption under it.
  y -= 44
  const half = (RIGHT - LEFT - 30) / 2
  document.signatures.forEach((caption, index) => {
    const from = LEFT + index * (half + 30)
    rule(y, from, from + half)
    write(caption, from, y - 12, 8, regular, grey)
  })

  const foot = `${document.number[0]} ${document.number[1]}`
  write(foot, (PAGE[0] - regular.widthOfTextAtSize(foot, 8)) / 2, FOOT, 8, regular, grey)
  return pdf.save({ useObjectStreams: false })
}
