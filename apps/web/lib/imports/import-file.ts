// Improve › Imports on the Pilot (#291 slice 12, row 20.1): what the screen
// makes of a file before the API sees it, kept out of the components so it
// is tested without a browser. The reading of a CSV and the columns of each
// kind are the domain's (@waste/domain/imports), the same ones the API's
// template writes; this module says how a person meets them — the kinds a
// role may import, the file's bytes read as UTF-8 or, failing that, as the
// Windows code page a spreadsheet saves "CSV" in, what a header row must be
// told before any row is sent, the batches a commit is sent in, the reason
// a write carries for the audit log, and the separator a template is asked
// for.
import type { ImportKind, ImportRowResult } from "@waste/contracts/imports"
import type { ModuleKey } from "@waste/domain/access/modules"
import { importRows, type ImportFile, type ImportRow } from "@waste/domain/imports/csv"
import { planningAreaRows } from "@waste/domain/imports/geojson"
import { IMPORT_BATCH_MAX, IMPORT_ROWS_MAX } from "@waste/domain/imports/vocabulary"

import { allows, type Grants } from "@/lib/api/grants"
import { REASON_MAX } from "@/lib/data/action-decision"

/** Each kind as the screen offers it: its label, the module its rows are written to, and whether a file of it is a project's. */
export const IMPORT_KIND_OPTIONS = [
  { kind: "customers", label: "Customers", moduleKey: "customers.contacts", projectScoped: false },
  { kind: "properties", label: "Properties", moduleKey: "customers.properties", projectScoped: true },
  { kind: "containers", label: "Containers", moduleKey: "resources.containers", projectScoped: true },
  { kind: "agreements", label: "Agreements and subscriptions", moduleKey: "customers.agreements", projectScoped: true },
  // The company's catalogue (O30 of #290, row 1.18), kept in Settings › Master data.
  { kind: "waste-fractions", label: "Waste fractions", moduleKey: "configure.master", projectScoped: false },
  { kind: "container-types", label: "Container types", moduleKey: "configure.master", projectScoped: false },
  { kind: "vehicle-types", label: "Vehicle types", moduleKey: "configure.master", projectScoped: false },
  // A project's fleet (O30 of #290, row 1.18).
  { kind: "vehicles", label: "Vehicles", moduleKey: "fleet.vehicles", projectScoped: true },
  { kind: "drivers", label: "Drivers", moduleKey: "fleet.drivers", projectScoped: true },
  // A project's calendars and planning areas (O30 of #290, row 1.18), the areas from a GeoJSON file or a CSV one.
  { kind: "collection-calendars", label: "Collection calendars", moduleKey: "configure.calendars", projectScoped: true },
  { kind: "planning-areas", label: "Planning areas (GeoJSON)", moduleKey: "configure.areas", projectScoped: true },
] as const satisfies readonly { kind: ImportKind; label: string; moduleKey: ModuleKey; projectScoped: boolean }[]

export type ImportKindOption = (typeof IMPORT_KIND_OPTIONS)[number]

export const kindOption = (kind: ImportKind): ImportKindOption => IMPORT_KIND_OPTIONS.find((option) => option.kind === kind) ?? IMPORT_KIND_OPTIONS[0]

/** Whether the role reads the imports run here: the import's own `view`. */
export const mayView = (grants: Grants | undefined): boolean => allows(grants, "improve.imports", "view")

/** Whether the role may run an import at all: the import's own `create`. */
export const mayImport = (grants: Grants | undefined): boolean => allows(grants, "improve.imports", "create")

/** The kinds a role may import: those whose module it may write a row to, by making a record or changing one. */
export function importableKinds(grants: Grants | undefined): ImportKindOption[] {
  if (!mayImport(grants)) return []
  return IMPORT_KIND_OPTIONS.filter((option) => allows(grants ?? [], option.moduleKey, "create") || allows(grants ?? [], option.moduleKey, "edit"))
}

/**
 * A file's bytes as text: UTF-8, as the template is written and a
 * spreadsheet saves "CSV UTF-8"; and, where the bytes are not UTF-8, the
 * Windows code page a spreadsheet saves plain "CSV" in on a Danish machine,
 * so "Østerbro" is read as it was typed rather than refused or garbled.
 */
export function textOf(bytes: ArrayBuffer | Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder("windows-1252").decode(bytes)
  }
}

/** What a file is told before any row is sent: the reasons it cannot be previewed, and the columns it holds that the kind will not read. */
export type FileReading = { file: ImportFile; blocking: string[]; ignored: string[] }

/** Whether a kind reads a GeoJSON file: the planning areas, whose text then opens as a JSON object does. */
const readsGeoJson = (kind: ImportKind, text: string): boolean => kind === "planning-areas" && text.trimStart().replace(/^\uFEFF/, "").startsWith("{")

/** The files the file picker offers for a kind: a CSV, and for the planning areas a GeoJSON file too. */
export const acceptedFiles = (kind: ImportKind): string => (kind === "planning-areas" ? ".geojson,.json,application/geo+json,application/json,.csv,text/csv" : ".csv,text/csv")

export function readImportFile(kind: ImportKind, text: string): FileReading {
  const geojson = readsGeoJson(kind, text) ? planningAreaRows(text) : undefined
  if (geojson !== undefined && "problem" in geojson) return { file: { rows: [], issues: { unknown: [], missing: [], repeated: [], unclosedQuote: null } }, blocking: [geojson.problem], ignored: [] }
  const file = geojson ?? importRows(kind, text)
  const blocking: string[] = []
  const { missing, repeated, unknown, unclosedQuote } = file.issues
  if (unclosedQuote !== null) blocking.push(`Row ${unclosedQuote} opens a quoted cell that never closes, so every row after it ran into it; close the quote and choose the file again.`)
  if (missing.length > 0) blocking.push(`The file has no ${listed(missing)} ${missing.length === 1 ? "column" : "columns"}; every row needs ${missing.length === 1 ? "it" : "them"}.`)
  if (repeated.length > 0) blocking.push(`The file names ${listed(repeated)} twice; give each column once.`)
  if (file.rows.length === 0) blocking.push(geojson === undefined ? "The file has no rows below its header." : "The file has no features.")
  if (file.rows.length > IMPORT_ROWS_MAX) blocking.push(`The file has ${file.rows.length} rows; an import takes at most ${IMPORT_ROWS_MAX}, so split it.`)
  return { file, blocking, ignored: unknown }
}

const listed = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`

/** A commit's rows in the batches it sends them in, each at most what one batch may write. */
export function batchesOf<Row>(rows: readonly Row[], size: number = IMPORT_BATCH_MAX): Row[][] {
  const batches: Row[][] = []
  for (let start = 0; start < rows.length; start += size) batches.push(rows.slice(start, start + size))
  return batches
}

/**
 * The reason an import's writes are recorded under in the audit log (#291
 * slice 9a): the office's own where it typed one, else "CSV import <file>",
 * at most what the log keeps. The client carries it (`ApiClient.reason`) and
 * percent-encodes it into the change-reason header.
 */
export function importReason(fileName: string, typed?: string): string {
  const given = typed?.trim() ?? ""
  return (given === "" ? `CSV import ${fileName}` : given).slice(0, REASON_MAX)
}

/** The separator a template is asked for: semicolons where the locale writes a decimal comma, as a spreadsheet there splits columns on them. */
export function templateSeparatorFor(locale: string | undefined): "comma" | "semicolon" {
  return new Intl.NumberFormat(locale).format(1.5).includes(",") ? "semicolon" : "comma"
}

/** How many rows came out each way. */
export type OutcomeCounts = Record<ImportRowResult["outcome"], number>

export function countsOf(results: readonly ImportRowResult[]): OutcomeCounts {
  const counts: OutcomeCounts = { created: 0, updated: 0, unchanged: 0, refused: 0 }
  for (const result of results) counts[result.outcome] += 1
  return counts
}

/** The rows a preview answered, each beside the cells it was read from, for the table that shows them. */
export function joinedRows(rows: readonly ImportRow[], results: readonly ImportRowResult[]): { row: ImportRow; result: ImportRowResult | undefined }[] {
  const byRow = new Map(results.map((result) => [result.row, result]))
  return rows.map((row) => ({ row, result: byRow.get(row.row) }))
}
