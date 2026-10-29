// What a waste transfer note says (O18 of #290, row 8.6): the document that
// goes with a load from the company that collected it to the station that
// took it, one per Unload. The model a renderer lays out, a pure function of
// the unload's rows — the unload itself, its fraction with the waste code and
// the hazardous flag, the station, the company that holds and carries the
// waste, and the vehicle and driver it came on — in its project's language,
// Danish for a Danish project and English for any other, every string
// WinAnsi, the PDF standard fonts' encoding, spelled through the invoice
// document's helpers so the two documents write a day, a number and a
// character alike.
//
// The note's number is the unload's id: the ledger row is never rewritten,
// so the note it makes stands as long as the row does, and a weight review's
// correction is a new row with a note of its own.
import { documentDate, winAnsi, type DocumentLanguage } from "../finance/invoice-document"
import { wasteCodePrinted } from "../registry/waste-code"

/** The rows a note is made of, the instant already on the project's clock. */
export type TransferNoteInput = {
  language: DocumentLanguage
  /** The unload's id, the note's number. */
  unloadId: string
  /** The day and the time the truck tipped, on the project's clock: `2026-10-05`, `14:32`. */
  occurredOn: string
  occurredAt: string
  timezone: string
  projectName: string
  /** The company: it holds the waste it collected and carries it, so it is the transferor and the carrier both. */
  holder: { legalName: string; registrationNumber: string; /** Lines separated by newlines. */ postalAddress: string | null }
  carrier: { vehicleRegistration: string | null; driverName: string | null; routeLabel: string }
  station: { name: string; code: string; address: string }
  waste: { fractionName: string; wasteCode: string | null; hazardous: boolean; netKg: number; grossKg: number | null; tareKg: number | null }
  weighbridgeTicket: string | null
  note: string | null
}

/** One block of the note: its heading and its rows, label and value. */
export type TransferNoteSection = { heading: string; rows: [string, string][] }

/** The note, every string spelled and WinAnsi: a renderer places it and adds nothing. */
export type TransferNoteDocument = {
  title: string
  /** The number's label and the number, at the head of every page. */
  number: [string, string]
  /** The day of the transfer, ISO: the date its file carries. */
  issuedOn: string
  /** Printed under the title where the waste is hazardous; null where it is not. */
  hazardBanner: string | null
  holder: string[]
  sections: TransferNoteSection[]
  declaration: string
  /** The two signatures' captions: the transferor's, the transferee's. */
  signatures: [string, string]
}

const LABELS = {
  da: {
    title: "Følgeseddel for affald",
    number: "Følgeseddel nr.",
    hazardBanner: "FARLIGT AFFALD",
    transferor: "Overdrager og transportør",
    transferee: "Modtager",
    waste: "Affald",
    transfer: "Overdragelse",
    name: "Navn",
    address: "Adresse",
    registration: "CVR",
    vehicle: "Køretøj",
    driver: "Chauffør",
    route: "Rute",
    station: "Anlæg",
    code: "Kode",
    description: "Beskrivelse",
    wasteCode: "Affaldskode (EAK)",
    hazardous: "Farligt affald",
    yes: "Ja",
    no: "Nej",
    net: "Nettovægt",
    gross: "Bruttovægt",
    tare: "Taravægt",
    ticket: "Vejeseddel",
    date: "Dato",
    time: "Tidspunkt",
    project: "Projekt",
    remark: "Bemærkning",
    none: "Ikke angivet",
    declaration: "Affaldet beskrevet ovenfor er overdraget fra overdrageren til modtageren på den angivne dato og det angivne tidspunkt.",
    signatures: ["Overdragers underskrift", "Modtagers underskrift"] as [string, string],
  },
  en: {
    title: "Waste transfer note",
    number: "Transfer note no.",
    hazardBanner: "HAZARDOUS WASTE",
    transferor: "Transferor and carrier",
    transferee: "Transferee",
    waste: "Waste",
    transfer: "Transfer",
    name: "Name",
    address: "Address",
    registration: "Reg. no.",
    vehicle: "Vehicle",
    driver: "Driver",
    route: "Route",
    station: "Facility",
    code: "Code",
    description: "Description",
    wasteCode: "Waste code (EWC)",
    hazardous: "Hazardous waste",
    yes: "Yes",
    no: "No",
    net: "Net weight",
    gross: "Gross weight",
    tare: "Tare weight",
    ticket: "Weighbridge ticket",
    date: "Date",
    time: "Time",
    project: "Project",
    remark: "Note",
    none: "Not recorded",
    declaration: "The waste described above was transferred from the transferor to the transferee on the date and at the time stated.",
    signatures: ["Transferor's signature", "Transferee's signature"] as [string, string],
  },
} as const

/** Whole kilograms as the language groups them: `8.000 kg` in Danish, `8,000 kg` in English. */
export function documentKilograms(kg: number, language: DocumentLanguage): string {
  if (!Number.isSafeInteger(kg)) throw new Error(`documentKilograms: ${kg} is not a whole number of kilograms`)
  const group = language === "da" ? "." : ","
  return `${String(kg).replace(/\B(?=(\d{3})+(?!\d))/g, group)} kg`
}

/** A newline-separated address as one line, its parts joined by commas. */
const oneLine = (address: string): string =>
  address
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(", ")

/** The model of an unload's transfer note. */
export function transferNoteOf(input: TransferNoteInput): TransferNoteDocument {
  const label = LABELS[input.language]
  const kg = (value: number) => documentKilograms(value, input.language)
  const { holder, carrier, station, waste } = input

  const sections: TransferNoteSection[] = [
    {
      heading: label.transferor,
      rows: [
        [label.name, holder.legalName],
        ...(holder.postalAddress === null || oneLine(holder.postalAddress) === "" ? [] : [[label.address, oneLine(holder.postalAddress)] as [string, string]]),
        [label.registration, holder.registrationNumber],
        [label.vehicle, carrier.vehicleRegistration ?? label.none],
        [label.driver, carrier.driverName ?? label.none],
        [label.route, carrier.routeLabel],
      ],
    },
    {
      heading: label.transferee,
      rows: [
        [label.station, station.name],
        [label.code, station.code],
        [label.address, oneLine(station.address)],
      ],
    },
    {
      heading: label.waste,
      rows: [
        [label.description, waste.fractionName],
        [label.wasteCode, waste.wasteCode === null ? label.none : wasteCodePrinted(waste.wasteCode)],
        [label.hazardous, waste.hazardous ? label.yes : label.no],
        [label.net, kg(waste.netKg)],
        ...(waste.grossKg === null || waste.tareKg === null
          ? []
          : [
              [label.gross, kg(waste.grossKg)] as [string, string],
              [label.tare, kg(waste.tareKg)] as [string, string],
            ]),
        ...(input.weighbridgeTicket === null ? [] : [[label.ticket, input.weighbridgeTicket] as [string, string]]),
      ],
    },
    {
      heading: label.transfer,
      rows: [
        [label.date, documentDate(input.occurredOn, input.language)],
        [label.time, `${input.occurredAt} (${input.timezone})`],
        [label.project, input.projectName],
        ...(input.note === null || input.note.trim() === "" ? [] : [[label.remark, input.note.trim()] as [string, string]]),
      ],
    },
  ]

  const pair = ([a, b]: [string, string]): [string, string] => [winAnsi(a), winAnsi(b)]
  return {
    title: winAnsi(label.title),
    number: pair([label.number, input.unloadId]),
    issuedOn: input.occurredOn,
    hazardBanner: waste.hazardous ? winAnsi(label.hazardBanner) : null,
    holder: [holder.legalName, ...(holder.postalAddress ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== ""), `${label.registration} ${holder.registrationNumber}`].map(winAnsi),
    sections: sections.map((section) => ({ heading: winAnsi(section.heading), rows: section.rows.map(pair) })),
    declaration: winAnsi(label.declaration),
    signatures: pair(label.signatures),
  }
}
