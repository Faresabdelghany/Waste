// The audit log's one read (#291, slice 9): `GET /audit-events`, newest
// first. With `table` and `rowId` it is one row's history — the row's own
// changes, and those of the sets it is the parent of two levels down (a
// role's grants, a vehicle's compartments and their fractions, a scheme's
// groups and their picks) — read under `view` on the module the table belongs
// to (the audit list, @waste/db/sql/audit-trail), the grant its own routes
// are read under. Without them it is the company's whole history, read under
// `view` on `configure.privacy`. Either way a row of a project the caller does
// not work in is not there, as anywhere else; a company-wide row (a customer,
// a role) is.
//
// What the trigger wrote is what is answered: the table and the row, the
// columns that moved as `[before, after]`, the actor — the account, with its
// name as it stands, or none for the worker, the seed and the hook — the
// reason, and the transaction id, as a decimal string.
import { AuditEvent, AuditEventListQuery } from "@waste/contracts/audit"
import { Page } from "@waste/contracts/pagination"
import { userAccount } from "@waste/db/schema/access"
import { auditEvent } from "@waste/db/schema/audit"
import { AUDITED } from "@waste/db/sql/audit-trail"
import type { ModuleKey } from "@waste/domain/access/modules"
import { and, desc, eq, getTableName, isNull, lt, or, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { requireAllowed } from "../auth/require"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, validate } from "../problem"
import { describeJson } from "./shared"

const AuditPage = Page(AuditEvent)

/** The module each audited table's history is read under, by the table's name. */
const MODULE_OF: ReadonlyMap<string, ModuleKey> = new Map(AUDITED.map((entry) => [getTableName(entry.table), entry.module]))

/** The company's whole history is read under the privacy module's view (#291): who changed what, everywhere. */
const COMPANY_HISTORY: ModuleKey = "configure.privacy"

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

export function auditEventRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>().get(
    "/audit-events",
    describeRoute({
      operationId: "listAuditEvents",
      summary: "The audit log",
      description:
        "One page of the audit log, newest first: what the audit trail recorded of every insert, update and delete of an audited table — the columns that moved as `[before, after]`, the account that made the change (null for the worker, the seed and the access token hook), the reason its request gave in the `Waste-Change-Reason` header, and the transaction it happened in, which one request's changes share. With `table` and `rowId` it is one row's history, with the changes of the sets it is the parent of two levels down — a role's grants, a property's parties, a vehicle's compartments and their fractions — under `view` on the module the table belongs to; without them, the company's whole history, under `view` on `configure.privacy`. A row of a project this account does not work in is not there. Hand `nextCursor` back as `cursor` for the next page.",
      security: BEARER_SECURITY,
      responses: {
        200: describeJson("One page of the audit log.", AuditPage),
        400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `table` is not an audited table, or only one of `table` and `rowId` is given."),
        401: describeProblem("No usable token (see WWW-Authenticate)."),
        403: describeProblem("No active account here, or the caller's role does not allow `view` on the table's module, or on `configure.privacy` for the company's whole history."),
      },
    }),
    guard,
    validate("query", AuditEventListQuery),
    async (c) => {
      const { table, rowId, limit, cursor } = c.req.valid("query")
      const after = afterCursor(cursor)
      const tx = c.get("tx")
      const principal = c.get("principal")
      let ofRow = undefined
      if (table !== undefined && rowId !== undefined) {
        const module = MODULE_OF.get(table)
        if (module === undefined) throw invalidRequest("query", [{ path: "table", message: "Not an audited table" }])
        requireAllowed(principal.grants, module, "view")
        // The row, its sets, and their sets: two levels, which every parent of the audit list is within.
        const children = sql`select ${auditEvent.rowId} from ${auditEvent} where ${auditEvent.companyId} = ${principal.companyId} and ${auditEvent.parentTable} = ${table} and ${auditEvent.parentId} = ${rowId}`
        ofRow = or(and(eq(auditEvent.tableName, table), eq(auditEvent.rowId, rowId)), and(eq(auditEvent.parentTable, table), eq(auditEvent.parentId, rowId)), sql`${auditEvent.parentId} in (${children})`)
      } else {
        requireAllowed(principal.grants, COMPANY_HISTORY, "view")
      }
      const rows = await tx
        .select(columns)
        .from(auditEvent)
        .leftJoin(userAccount, and(eq(userAccount.companyId, auditEvent.companyId), eq(userAccount.id, auditEvent.actorUserAccountId)))
        .where(
          and(
            eq(auditEvent.companyId, principal.companyId),
            or(isNull(auditEvent.projectId), inProjects(auditEvent.projectId, principal)),
            ofRow,
            after === undefined ? undefined : lt(auditEvent.id, after),
          ),
        )
        .orderBy(desc(auditEvent.id))
        .limit(fetchLimit(limit))
      return c.json(pageOf(rows.map(eventOf), limit))
    },
  )
}
