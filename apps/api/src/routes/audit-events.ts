// The audit log's one read (#291, slice 9): `GET /audit-events`, newest
// first, one row's history — the row's own changes, and those of the sets it
// is the parent of two levels down (a role's grants, a vehicle's compartments
// and their fractions, a scheme's groups and their picks) — read under `view`
// on the module the table is audited under (`AUDITED_TABLES`,
// @waste/domain/audit/vocabulary), the grant its own routes are read under. A
// table the audit trail does not keep is the contract's 400 on `table`. A row
// of a project the caller does not work in is not there, as anywhere else; a
// company-wide row (a customer, a role) is.
//
// What the trigger wrote is what is answered: the table and the row, the
// columns that moved as `[before, after]`, the actor — the account, with its
// name as it stands, or none for the worker, the seed and the hook — the
// reason, and the transaction id, as a decimal string.
import { AuditEvent, AuditEventListQuery } from "@waste/contracts/audit"
import { Page } from "@waste/contracts/pagination"
import { userAccount } from "@waste/db/schema/access"
import { auditEvent } from "@waste/db/schema/audit"
import { AUDITED_TABLES } from "@waste/domain/audit/vocabulary"
import { and, eq, isNull, or, sql } from "drizzle-orm"
import { inProjects } from "../auth/projects"
import { requireAllowed } from "../auth/require"
import type { RouteDeps } from "../deps"
import { describeJson, routes } from "../operation"
import { mapPage, pageAt } from "../pagination"
import { describeProblem } from "../problem"
import { scoped } from "../scoped"

const AuditPage = Page(AuditEvent)

const columns = {
  id: auditEvent.id,
  recordedAt: auditEvent.recordedAt,
  projectId: auditEvent.projectId,
  table: auditEvent.tableName,
  rowId: auditEvent.rowId,
  parentTable: auditEvent.parentTable,
  parentId: auditEvent.parentId,
  action: auditEvent.action,
  changed: auditEvent.changed,
  actorId: auditEvent.actorUserAccountId,
  actorName: userAccount.fullName,
  reason: auditEvent.reason,
  transactionId: auditEvent.transactionId,
}

/** A row of the read, the actor's name null where the log names no account or the account is gone. */
type Row = {
  id: string
  recordedAt: Date
  projectId: string | null
  table: string
  rowId: string
  parentTable: string | null
  parentId: string | null
  action: string
  changed: unknown
  actorId: string | null
  actorName: string | null
  reason: string | null
  transactionId: number
}

const eventOf = (row: Row): AuditEvent => ({
  id: row.id,
  recordedAt: row.recordedAt.toISOString(),
  projectId: row.projectId,
  table: row.table,
  rowId: row.rowId,
  parentTable: row.parentTable,
  parentId: row.parentId,
  action: row.action as AuditEvent["action"],
  changed: row.changed as AuditEvent["changed"],
  actor: row.actorId === null ? null : { id: row.actorId, fullName: row.actorName ?? "" },
  reason: row.reason,
  transactionId: String(row.transactionId),
})

const { list: listEvents } = scoped(auditEvent, {
  noun: "audit event",
  reach: (principal) => or(isNull(auditEvent.projectId), inProjects(auditEvent.projectId, principal)),
  read: (tx) => tx.select(columns).from(auditEvent).leftJoin(userAccount, and(eq(userAccount.companyId, auditEvent.companyId), eq(userAccount.id, auditEvent.actorUserAccountId))),
  order: "desc",
})

export function auditEventRoutes(deps: RouteDeps) {
  return routes(deps).get(
    "/audit-events",
    {
      operationId: "listAuditEvents",
      summary: "The audit log",
      description:
        "One page of the audit log, newest first: what the audit trail recorded of every insert, update and delete of an audited table — the columns that moved as `[before, after]`, the account that made the change (null for the worker, the seed and the access token hook), the reason its request gave in the `Waste-Change-Reason` header, and the transaction it happened in, which one request's changes share. It is one row's history, named by `table` and `rowId`, with the changes of the sets it is the parent of two levels down — a role's grants, a property's parties, a vehicle's compartments and their fractions — under `view` on the module the table belongs to. A row of a project this account does not work in is not there. Hand `nextCursor` back as `cursor` for the next page.",
      query: AuditEventListQuery,
      invalid: ["`table` or `rowId` is missing", "`table` is not an audited table"],
      responses: {
        200: describeJson("One page of the audit log.", AuditPage),
        403: describeProblem("No active account here, or the caller's role does not allow `view` on the table's module."),
      },
    },
    async (c) => {
      const { table, rowId, limit, cursor } = c.req.valid("query")
      const at = pageAt({ cursor, limit })
      const tx = c.get("tx")
      const principal = c.get("principal")
      requireAllowed(principal.grants, AUDITED_TABLES[table], "view")
      // The row, its sets, and their sets: two levels, which every parent of the audit list is within.
      const children = sql`select ${auditEvent.rowId} from ${auditEvent} where ${auditEvent.companyId} = ${principal.companyId} and ${auditEvent.parentTable} = ${table} and ${auditEvent.parentId} = ${rowId}`
      const ofRow = or(and(eq(auditEvent.tableName, table), eq(auditEvent.rowId, rowId)), and(eq(auditEvent.parentTable, table), eq(auditEvent.parentId, rowId)), sql`${auditEvent.parentId} in (${children})`)
      const page = await listEvents(tx, principal, at, ofRow)
      return c.json(mapPage(page, eventOf))
    },
  )
}
