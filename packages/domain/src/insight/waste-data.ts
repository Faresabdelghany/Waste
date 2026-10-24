// The waste-data report as a file (#291 slice 29, C29, row 19.4): a period's
// reviewed Unloads as net kilograms per municipality, unloading station and
// waste fraction, each fraction with its waste code (registry/waste-code.ts),
// for the office to file with the national waste-data system by hand. The
// API reads it (`GET /reports/waste-data`) and writes it
// (`GET /reports/waste-data.csv`) through this module, so the file and the
// screen say the same thing in the same words.
//
// The file is a documented, plain CSV of our own and not the national
// system's import layout, which direct submission will need later. Its
// columns, in order:
//
//   period_from        the period's first day, YYYY-MM-DD
//   period_to          its last day, inclusive
//   municipality       the project the unloads were collected for, by
//                      name — a Project is a municipality, a contract or a
//                      region, and one that is not a municipality is
//                      warned of
//   unloading_station  the station the load was delivered to
//   fraction           the waste fraction
//   waste_code         its code, six digits of the European List of Waste;
//                      blank where the fraction has none
//   kg                 the net weight in whole kilograms
//   warning            blank on a data row
//
// A data row is one municipality, station and fraction with any reviewed
// weight in the period. Below the data rows, a warning row each: a fraction
// of a data row with no waste code (its data rows carry the code blank), a
// project of a data row whose kind is not a municipality (`isMunicipality`),
// and the unloads nobody has reviewed yet, per municipality, station and
// fraction, which the file does not count. A warning row carries what it is
// about in the same columns, `kg` blank, and its sentence in `warning`. The
// file starts with the byte-order mark a spreadsheet reads UTF-8 by and ends
// every record with a CRLF; a field a spreadsheet would run as a formula is
// guarded (`csvField`).

import { csvField } from "../imports/csv"
import { count } from "../text"
import type { WasteDataWarningKind } from "./vocabulary"

/** One municipality's reviewed weight of one fraction at one station over the period. */
export type WasteDataRow = {
  projectId: string
  /** The project's name: the municipality the unloads were collected for. */
  municipality: string
  unloadingStationId: string
  unloadingStationName: string
  wasteFractionId: string
  wasteFractionName: string
  /** Null where the fraction has none. */
  wasteCode: string | null
  /** Whole kilograms, net, of the reviewed unloads. */
  netKg: number
  /** How many reviewed unloads. */
  unloads: number
}

/** What the report warns of beside its rows, one shape per kind of the vocabulary's. */
export type WasteDataWarning =
  | { kind: Extract<WasteDataWarningKind, "no-waste-code">; wasteFractionId: string; wasteFractionName: string }
  | {
      kind: Extract<WasteDataWarningKind, "not-a-municipality">
      projectId: string
      /** The project's name, which its rows carry as the municipality. */
      municipality: string
      /** The project's kind as the office wrote it (`Business unit`). */
      projectKind: string
    }
  | {
      kind: Extract<WasteDataWarningKind, "not-reviewed">
      projectId: string
      municipality: string
      unloadingStationId: string
      unloadingStationName: string
      wasteFractionId: string
      wasteFractionName: string
      unloads: number
      netKg: number
    }

/** A project's kind that is a municipality: the label the office gives one, in any case. A project's kind is free text (`@waste/contracts/organisation`). */
export const MUNICIPALITY_KIND = "Municipality"

/** Whether a project of this kind is a municipality, whose household waste the national system files under the municipality. */
export const isMunicipality = (projectKind: string): boolean => projectKind.trim().toLowerCase() === MUNICIPALITY_KIND.toLowerCase()

/** The file's columns, in order. */
export const WASTE_DATA_COLUMNS = ["period_from", "period_to", "municipality", "unloading_station", "fraction", "waste_code", "kg", "warning"] as const

/** A warning in the words a person reads, on the screen and in the file. */
export function wasteDataWarningSentence(warning: WasteDataWarning): string {
  switch (warning.kind) {
    case "no-waste-code":
      return `${warning.wasteFractionName} has no waste code: set it under the fraction in Settings › Master data before the report is filed`
    case "not-a-municipality":
      return `${warning.municipality} is not a municipality (its kind is ${warning.projectKind}): its rows carry the project's name where the national system expects a municipality's`
    case "not-reviewed": {
      const one = warning.unloads === 1
      return `${count(warning.unloads, "unload")} of ${warning.wasteFractionName} at ${warning.unloadingStationName} (${warning.netKg} kg) ${one ? "is" : "are"} not reviewed and not counted: review ${one ? "it" : "them"} under Weights before the report is filed`
    }
  }
}

/** What a warning row says it is about, in the municipality, station and fraction columns. */
function warningPlace(warning: WasteDataWarning): [municipality: string, station: string, fraction: string] {
  switch (warning.kind) {
    case "no-waste-code":
      return ["", "", warning.wasteFractionName]
    case "not-a-municipality":
      return [warning.municipality, "", ""]
    case "not-reviewed":
      return [warning.municipality, warning.unloadingStationName, warning.wasteFractionName]
  }
}

/** The report as a CSV file's text. */
export function wasteDataCsv(report: { from: string; to: string; rows: readonly WasteDataRow[]; warnings: readonly WasteDataWarning[] }, separator: "," | ";" = ","): string {
  const line = (fields: readonly string[]) => fields.map((field) => csvField(field, separator)).join(separator)
  const period = [report.from, report.to]
  const records = [
    line(WASTE_DATA_COLUMNS),
    ...report.rows.map((row) => line([...period, row.municipality, row.unloadingStationName, row.wasteFractionName, row.wasteCode ?? "", String(row.netKg), ""])),
    ...report.warnings.map((warning) =>
      line([...period, ...warningPlace(warning), "", "", wasteDataWarningSentence(warning)]),
    ),
  ]
  return `﻿${records.map((record) => `${record}\r\n`).join("")}`
}
