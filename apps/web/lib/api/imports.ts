// What Improve › Imports asks the API (#291 slice 12, row 20.1): a kind's
// template, the preview that stores nothing, a run and its batches, and the
// runs and their rows read back. Outside the record store: an import is a
// conversation about a file, never a module's rows, and the records it
// writes are read again by their own modules when a person opens them. The
// contracts are types here; a runtime zod import would land in the page's
// bundle.
import type {
  ImportBatchResult,
  ImportKind,
  ImportPreview,
  ImportRowOutcome,
  ImportRowValues,
  ImportRun,
  ImportRunRow,
} from "@waste/contracts/imports"

import { CHANGE_REASON_HEADER, importReason } from "@/lib/imports/import-file"

import { create, get, listAll, listPage, post, withQuery, type ApiClient, type Page } from "./client"

/** A kind's template, the header row as the API writes it. */
export function importTemplate(client: ApiClient, kind: ImportKind, separator: "comma" | "semicolon"): Promise<string> {
  return get<string>(client, withQuery(`/imports/templates/${kind}`, { separator }))
}

/** What the rows would become; nothing is stored. */
export async function previewImport(client: ApiClient, body: { kind: ImportKind; projectId?: string; fileName: string; rows: ImportRowValues[] }): Promise<ImportPreview> {
  return (await post<ImportPreview>(client, "/imports/preview", body)).body
}

/** The run a commit's batches belong to. */
export async function startImportRun(client: ApiClient, body: { kind: ImportKind; projectId?: string; fileName: string; rowCount: number }): Promise<ImportRun> {
  return (await create<ImportRun>(client, "/imports", body)).body
}

/** One batch of the run's rows, each request carrying its reason for the audit log (slice 9a). Safe to send again: rows already recorded are answered as recorded. */
export async function sendImportBatch(client: ApiClient, run: Pick<ImportRun, "id" | "fileName">, rows: ImportRowValues[]): Promise<ImportBatchResult> {
  const reasoned: ApiClient = { ...client, headers: { ...client.headers, [CHANGE_REASON_HEADER]: importReason(run.fileName) } }
  return (await post<ImportBatchResult>(reasoned, `/imports/${run.id}/rows`, { rows })).body
}

/** The newest runs, one page of them. */
export function recentImportRuns(client: ApiClient, query: { kind?: ImportKind; projectId?: string; limit?: number } = {}): Promise<Page<ImportRun>> {
  return listPage<ImportRun>(client, "/imports", query)
}

/** Every row a run recorded, every outcome or one, page after page. */
export function importRunRows(client: ApiClient, runId: string, query: { outcome?: ImportRowOutcome } = {}): Promise<ImportRunRow[]> {
  return listAll<ImportRunRow>(client, `/imports/${runId}/rows`, query)
}
