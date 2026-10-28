// A row's history (#291): the API's audit log of one row and of the sets it
// is the parent of, newest first (`GET /audit-events?table=…&rowId=…`). The
// row is named by its kind's audited table (`ResourceAdapter.auditTable`) and
// its server id; a kind whose table keeps no history — a ledger, execution,
// the money the work makes — and a row the API has not answered yet have
// none to read. The read is under the grant the row's module is read under,
// so a person who sees the row may read its history.
import type { AuditedTable, AuditEvent } from "@waste/contracts/audit"

import type { BusinessRecord } from "@/lib/data/business-modules"

import { listPage, type ApiClient, type Page } from "../client"
import type { ServerModule } from "./adapter"
import { adapterFor } from "./server-records"

/** The row a history is read by. */
export type HistorySubject = { table: AuditedTable; rowId: string }

/** The row a record's history is read by: its kind's audited table and its server id; null for a kind that keeps none, or a row with no server id yet. */
export function historySubjectOf(module: ServerModule, record: BusinessRecord, serverIds: ReadonlyMap<string, string>): HistorySubject | null {
  const table = adapterFor(module, record)?.auditTable
  const rowId = serverIds.get(record.id)
  return table === undefined || rowId === undefined ? null : { table, rowId }
}

/** The newest page of a row's history: as many changes as one page holds, `nextCursor` saying older ones were left. */
export const historyPage = (client: ApiClient, subject: HistorySubject): Promise<Page<AuditEvent>> =>
  listPage<AuditEvent>(client, "/audit-events", { table: subject.table, rowId: subject.rowId })

/** The module whose `view` reads the company's whole history (`GET /audit-events` with no row). */
export const COMPANY_HISTORY_MODULE = "configure.privacy"

/** One page of the company's whole history, newest first: from the newest change, or from `cursor` — the page before's `nextCursor` — back. */
export const companyHistoryPage = (client: ApiClient, cursor?: string): Promise<Page<AuditEvent>> =>
  listPage<AuditEvent>(client, "/audit-events", { cursor })
