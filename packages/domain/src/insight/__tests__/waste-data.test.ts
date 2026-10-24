import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { csvRecords } from "../../imports/csv"
import { WASTE_DATA_WARNINGS } from "../vocabulary"
import { isMunicipality, WASTE_DATA_COLUMNS, wasteDataCsv, wasteDataWarningSentence, type WasteDataRow, type WasteDataWarning } from "../waste-data"

const row = (values: Partial<WasteDataRow>): WasteDataRow => ({
  projectId: "p",
  municipality: "Copenhagen Central",
  unloadingStationId: "s",
  unloadingStationName: "Amager Ressourcecenter",
  wasteFractionId: "f",
  wasteFractionName: "Residual",
  wasteCode: "200301",
  netKg: 12_400,
  unloads: 3,
  ...values,
})

const warnings: WasteDataWarning[] = [
  { kind: "no-waste-code", wasteFractionId: "g", wasteFractionName: "Mixed" },
  { kind: "not-a-municipality", projectId: "h", municipality: "Harbor Commercial", projectKind: "Business unit" },
  { kind: "not-reviewed", projectId: "p", municipality: "Copenhagen Central", unloadingStationId: "s", unloadingStationName: "Amager Ressourcecenter", wasteFractionId: "f", wasteFractionName: "Residual", unloads: 2, netKg: 5_200 },
]

describe("the waste-data report's warnings", () => {
  test("each kind of the vocabulary has a sentence a person can act on", () => {
    assert.deepEqual(warnings.map((warning) => warning.kind), [...WASTE_DATA_WARNINGS])
    assert.equal(wasteDataWarningSentence(warnings[0]!), "Mixed has no waste code: set it under the fraction in Settings › Master data before the report is filed")
    assert.equal(
      wasteDataWarningSentence(warnings[1]!),
      "Harbor Commercial is not a municipality (its kind is Business unit): its rows carry the project's name where the national system expects a municipality's",
    )
    assert.equal(wasteDataWarningSentence(warnings[2]!), "2 unloads of Residual at Amager Ressourcecenter (5200 kg) are not reviewed and not counted: review them under Weights before the report is filed")
    assert.equal(
      wasteDataWarningSentence({ ...(warnings[2] as Extract<WasteDataWarning, { kind: "not-reviewed" }>), unloads: 1, netKg: 800 }),
      "1 unload of Residual at Amager Ressourcecenter (800 kg) is not reviewed and not counted: review it under Weights before the report is filed",
    )
  })

  test("takes a project for a municipality by its kind, in any case and spacing, and nothing else for one", () => {
    assert.equal(isMunicipality("Municipality"), true)
    assert.equal(isMunicipality(" municipality "), true)
    for (const kind of ["Business unit", "Contract", "Region", "Municipal contract"]) assert.equal(isMunicipality(kind), false, kind)
  })
})

describe("the waste-data report as a file", () => {
  test("is its columns, then a data row per municipality, station and fraction, then a warning row each, behind the byte-order mark with CRLFs", () => {
    const text = wasteDataCsv({ from: "2026-01-01", to: "2026-03-31", rows: [row({}), row({ wasteFractionId: "g", wasteFractionName: "Mixed", wasteCode: null, netKg: 900, unloads: 1 })], warnings })
    assert.ok(text.startsWith("﻿") && text.endsWith("\r\n"))
    assert.deepEqual(
      csvRecords(text).map((record) => record.fields),
      [
        [...WASTE_DATA_COLUMNS],
        ["2026-01-01", "2026-03-31", "Copenhagen Central", "Amager Ressourcecenter", "Residual", "200301", "12400", ""],
        ["2026-01-01", "2026-03-31", "Copenhagen Central", "Amager Ressourcecenter", "Mixed", "", "900", ""],
        ["2026-01-01", "2026-03-31", "", "", "Mixed", "", "", wasteDataWarningSentence(warnings[0]!)],
        ["2026-01-01", "2026-03-31", "Harbor Commercial", "", "", "", "", wasteDataWarningSentence(warnings[1]!)],
        ["2026-01-01", "2026-03-31", "Copenhagen Central", "Amager Ressourcecenter", "Residual", "", "", wasteDataWarningSentence(warnings[2]!)],
      ],
    )
  })

  test("is written with semicolons where asked, a field holding one quoted, and a name a spreadsheet would run guarded", () => {
    const text = wasteDataCsv({ from: "2026-01-01", to: "2026-01-31", rows: [row({ municipality: "Kystbyen; Nord", wasteFractionName: "=HYPERLINK()" })], warnings: [] }, ";")
    const lines = text.replace(/^﻿/, "").split("\r\n")
    assert.equal(lines[0], WASTE_DATA_COLUMNS.join(";"))
    assert.equal(lines[1], `2026-01-01;2026-01-31;"Kystbyen; Nord";Amager Ressourcecenter;'=HYPERLINK();200301;12400;`)
  })
})
