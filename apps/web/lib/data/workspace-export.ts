// The workspace's Export (#292, #291 slice 28): a CSV of the current module's
// rows as the table shows them — the rows the search, the filters and the
// project scope leave (every page of them, in the table's order), and the
// columns the table draws for the module under the person's view options, by
// the headers it draws them under. Client-side and the same in both modes: on
// the Pilot the rows are the API's as the store mapped them, in fixture mode
// the fixtures and the browser's own; what is exported is what is shown.
//
// `shownColumns` restates the table's column logic in
// components/waste/business-workspace.tsx, header for header and cell for
// cell: the containers' asset view, the routes', the provider users', the
// calendars', the schemes' and the generic rich view, each with the view
// options that switch a column on. A cell that draws a badge, a progress ring
// or a sensor reading exports the text beside it; the row's star, its
// actions menu and its scheme attention badge are controls and not data, and
// are left out. The table does not render from this module, so the two are
// held together by hand: a column added to the table is added here, and
// lib/data/__tests__/workspace-export.test.ts spells each view's columns as
// the table draws them today. The rows go out in the table's order before
// any grouping, every page of them.
import type { BusinessRecord } from "./business-modules"
import { csvFileName, csvOf, downloadCsv } from "./csv"

/** What a column exports: the header the table draws, and the text of its cell for a record. */
export type ExportColumn = { header: string; cell: (record: BusinessRecord) => string }

/** The view options that switch a column on, as the workspace's table reads them. */
export type ShownOptions = {
  showDescription: boolean
  showContext: boolean
  showUpdated: boolean
  showArea: boolean
  showContainerType: boolean
  showWasteFraction: boolean
  showAddress: boolean
  showFillLevel: boolean
  showNextCollection: boolean
  showProject: boolean
}

/** Which table the module draws, and what its cells read beyond the record. */
export type ShownTable = {
  /** The containers' asset view, or one of the record views. */
  view: "containers" | "routes" | "provider-users" | "calendars" | "schemes" | "records"
  /** The rich view adds its pinned and its fact columns. */
  rich: boolean
  entityLabel: string
  contextLabel: string
  valueLabel: string
  options: ShownOptions
  /** The rich view's pinned fact columns, then the rest, as the view options leave them. */
  staticColumns: readonly string[]
  factColumns: readonly string[]
  /** A calendar's project scope as its context cell reads it. */
  projectScopeOf?: (record: BusinessRecord) => string
  /** A calendar's derived Holidays and Validity. */
  calendarRowOf?: (record: BusinessRecord) => { holidays: string; validity: string } | undefined
  /** A scheme's derived Recurrence and Waste fraction. */
  schemeRowOf?: (record: BusinessRecord) => { recurrence: string; wasteFraction: string } | undefined
}

/** A fact as the table shows it: its trimmed value, else the fallback, the dash unless said. */
export function factOf(record: BusinessRecord, label: string, fallback = "—"): string {
  const value = record.facts[label]?.trim()
  return value || fallback
}

/** A container's sensor cell, as its two lines read: the fill level and the sensor, or that it has none. */
function sensorCell(record: BusinessRecord): string {
  const sensor = factOf(record, "Sensor", "Not fitted")
  if (/^(none|not fitted|no sensor|—)$/i.test(sensor)) return "No sensor"
  return `${factOf(record, "Fill level", record.value)} · ${sensor}`
}

const fact = (header: string, label = header): ExportColumn => ({ header, cell: (record) => factOf(record, label) })

/** The columns the table draws for this module and these options, in its order. */
export function shownColumns(table: ShownTable): ExportColumn[] {
  const { options } = table
  if (table.view === "containers") {
    return [
      { header: "Container ID", cell: (record) => factOf(record, "Container ID", record.name) },
      ...(options.showDescription ? [{ header: "Description", cell: (record: BusinessRecord) => record.description }] : []),
      { header: "Status", cell: (record) => record.status },
      ...(options.showContainerType ? [fact("Container type")] : []),
      ...(options.showWasteFraction ? [fact("Waste fraction", "Waste fractions")] : []),
      ...(options.showAddress
        ? [
            {
              header: "Address / location",
              cell: (record: BusinessRecord) => {
                const address = factOf(record, "Address", record.context)
                const curb = factOf(record, "Curb location")
                return curb === "—" ? address : `${address} · ${curb}`
              },
            },
          ]
        : []),
      ...(options.showFillLevel ? [{ header: "Fill level / sensor", cell: sensorCell }] : []),
      ...(options.showNextCollection ? [fact("Next collection")] : []),
      ...(options.showProject ? [fact("Project")] : []),
    ]
  }

  const columns: ExportColumn[] = [
    { header: table.view === "routes" ? "Route ID" : table.view === "provider-users" ? "Full name" : table.entityLabel, cell: (record) => record.name },
  ]
  if (options.showDescription && table.view !== "provider-users") columns.push({ header: "Description", cell: (record) => record.description })
  if (table.rich) columns.push(...table.staticColumns.map((column) => fact(column)))
  if (table.view === "routes") {
    if (options.showProject) columns.push(fact("Project"))
    if (options.showArea) columns.push(fact("Area"))
  } else if (table.view === "provider-users") {
    columns.push(
      { header: "Email", cell: (record) => factOf(record, "Email", factOf(record, "User email")) },
      fact("Phone number"),
      { header: "Role", cell: (record) => factOf(record, "Role", factOf(record, "Service provider role")) },
    )
  } else if (options.showContext) {
    columns.push(
      table.view === "calendars"
        ? { header: table.contextLabel, cell: (record) => (record.projectIds?.length ? (table.projectScopeOf?.(record) ?? "—") : "—") }
        : { header: table.contextLabel, cell: (record) => record.context },
    )
  }
  columns.push({ header: "Status", cell: (record) => record.status })
  if (table.view === "calendars") {
    columns.push(
      { header: "Holidays", cell: (record) => table.calendarRowOf?.(record)?.holidays ?? "—" },
      { header: "Validity", cell: (record) => table.calendarRowOf?.(record)?.validity ?? "—" },
    )
  }
  if (table.view === "schemes") {
    columns.push(
      { header: "Recurrence", cell: (record) => table.schemeRowOf?.(record)?.recurrence ?? "—" },
      { header: "Waste fraction", cell: (record) => table.schemeRowOf?.(record)?.wasteFraction ?? "—" },
    )
  } else if (table.view !== "provider-users") {
    columns.push({ header: table.valueLabel, cell: (record) => record.value })
  }
  if (table.rich) columns.push(...table.factColumns.map((column) => fact(column)))
  if (options.showUpdated) columns.push({ header: "Updated", cell: (record) => record.updated })
  return columns
}

/** The rows as a CSV text under the columns' headers. */
export function tableCsv(records: readonly BusinessRecord[], columns: readonly ExportColumn[]): string {
  return csvOf(
    columns.map((column) => column.header),
    records.map((record) => columns.map((column) => column.cell(record))),
  )
}

/** The Export button's work: the rows as the table shows them, saved as `<workspace>-<module>-<day>.csv`; answers how many rows went out. */
export function exportShownRows(records: readonly BusinessRecord[], table: ShownTable, names: { workspace: string; module: string; day: string }): number {
  downloadCsv(csvFileName(names.workspace, names.module, names.day), tableCsv(records, shownColumns(table)))
  return records.length
}
