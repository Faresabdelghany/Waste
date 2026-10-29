import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { documentKilograms, transferNoteOf, type TransferNoteInput } from "../transfer-note"

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

const rows = (document: ReturnType<typeof transferNoteOf>) => new Map(document.sections.flatMap((section) => section.rows))

describe("a waste transfer note", () => {
  test("names the transferor and carrier, the transferee, the waste with its code and weights, and the transfer, in Danish for a Danish project", () => {
    const document = transferNoteOf(note())
    assert.equal(document.title, "Følgeseddel for affald")
    assert.deepEqual(document.number, ["Følgeseddel nr.", "01a0d2a4-a280-7a00-8000-000000000042"])
    assert.equal(document.issuedOn, "2026-10-05")
    assert.equal(document.hazardBanner, null)
    assert.deepEqual(document.holder, ["Kystbyen Renovation A/S", "Havnegade 4", "2100 København Ø", "CVR 12345678"])
    assert.deepEqual(
      document.sections.map((section) => section.heading),
      ["Overdrager og transportør", "Modtager", "Affald", "Overdragelse"],
    )
    const said = rows(document)
    assert.equal(said.get("Adresse"), "Vindmøllevej 6, 2300 København S", "the station's address, the last section's own")
    assert.equal(said.get("Køretøj"), "AB 12 345")
    assert.equal(said.get("Affaldskode (EAK)"), "20 03 01")
    assert.equal(said.get("Farligt affald"), "Nej")
    assert.equal(said.get("Nettovægt"), "8.000 kg")
    assert.equal(said.get("Bruttovægt"), "22.000 kg")
    assert.equal(said.get("Taravægt"), "14.000 kg")
    assert.equal(said.get("Vejeseddel"), "WB-2026-3901")
    assert.equal(said.get("Dato"), "05.10.2026")
    assert.equal(said.get("Tidspunkt"), "14:32 (Europe/Copenhagen)")
    assert.deepEqual(document.signatures, ["Overdragers underskrift", "Modtagers underskrift"])
  })

  test("is in English for any other project, and says a hazardous fraction is hazardous under its starred code, with a banner", () => {
    const document = transferNoteOf(note({ language: "en", waste: { fractionName: "Batteries", wasteCode: "200133*", hazardous: true, netKg: 1_250, grossKg: null, tareKg: null } }))
    assert.equal(document.title, "Waste transfer note")
    assert.equal(document.hazardBanner, "HAZARDOUS WASTE")
    const said = rows(document)
    assert.equal(said.get("Waste code (EWC)"), "20 01 33*")
    assert.equal(said.get("Hazardous waste"), "Yes")
    assert.equal(said.get("Net weight"), "1,250 kg")
    assert.equal(said.has("Gross weight"), false, "no weighbridge readings, no gross or tare")
    assert.equal(said.get("Date"), "5 October 2026")
  })

  test("says what is not recorded rather than leaving it out: no code, no vehicle, no driver", () => {
    const said = rows(transferNoteOf(note({ language: "en", carrier: { vehicleRegistration: null, driverName: null, routeLabel: "RC-7" }, waste: { ...note().waste, wasteCode: null }, weighbridgeTicket: null, note: "  Tipped at the side gate " })))
    assert.equal(said.get("Waste code (EWC)"), "Not recorded")
    assert.equal(said.get("Vehicle"), "Not recorded")
    assert.equal(said.get("Driver"), "Not recorded")
    assert.equal(said.has("Weighbridge ticket"), false)
    assert.equal(said.get("Note"), "Tipped at the side gate")
  })

  test("writes every string in WinAnsi, a character outside it marked", () => {
    const said = rows(transferNoteOf(note({ station: { name: "Station 東", code: "S-1", address: "Vej 1" } })))
    assert.equal(said.get("Anlæg"), "Station ?")
  })

  test("groups kilograms as the language does and refuses a fraction of one", () => {
    assert.equal(documentKilograms(1_234_567, "da"), "1.234.567 kg")
    assert.equal(documentKilograms(950, "en"), "950 kg")
    assert.throws(() => documentKilograms(1.5, "en"))
  })
})
