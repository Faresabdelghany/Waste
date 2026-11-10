// The waste-data report's question (#291 slice 29): the period and the
// project it is asked for, and the separator its file is asked with. The
// Compliance tab's rules (compliance.ts) and the client (lib/api/reports.ts)
// both read it here.
import type { WasteDataFileQuery } from "@waste/contracts/reports"

/** The waste-data report's question: one project's or every one the caller works in, a filing's period of days both inclusive, no series. */
export type WasteDataQuery = { projectId?: string; from: string; to: string }

/** How the file separates its fields: commas, or semicolons for a spreadsheet under a Danish locale. */
export type FileSeparator = WasteDataFileQuery["separator"]
