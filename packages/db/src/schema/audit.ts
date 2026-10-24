// The audit log (#291, slice 9; ADR-0005: "the history of edits is the audit
// log, not the domain model"). One ledger, `audit_event`, written by a
// trigger and by nothing else: `wms.audit_row()` (migration 0019,
// sql/audit-trail.ts) runs AFTER INSERT, UPDATE or DELETE on every table the
// audit list names and appends what the row underwent, so the history is
// complete by construction — the office's writes, the worker's and the
// seed's alike — and no write route has a call to forget.
//
// A row says which table and which row (`table_name`, `row_id`), and for a
// row of a set the parent it belongs to (`parent_table`, `parent_id`: a
// role's grants, an account's project access, a property's parties), so the
// history of a role reads its matrix's changes beside its own. `changed` is
// `{ column: [before, after] }` over the columns that moved — every value
// the row had for a delete, every value it took for an insert — less the id,
// the tenant and the stamps, and less the columns the table's trigger names
// as ignored (the company's document counters, which every route, ticket and
// invoice steps). `actor_user_account_id` is the principal's, from the
// transaction-local `wms.user_account_id` the API's guard sets and nothing
// else does; null is the worker, the seed or the access token hook.
// `reason` is the office's own word for a change, from the request's
// `Waste-Change-Reason` header, bounded by the API. `transaction_id` groups
// what one request did, so a matrix replaced whole reads as one change.
//
// The references are soft, as the outbox's are: a row outlives what it
// describes — a deleted row's history is exactly what is kept — so
// `row_id`, `parent_id`, `project_id` and the actor are uuids and not keys.
// The one key is the tenant's, and it is the schema's one cascade
// (references.ts says nothing cascades): a company's trail goes with the
// company. Only the owner ever deletes a company — no route does — and the
// rows the deletion's own sweep appends would otherwise hold it in place,
// since the API role may not delete a ledger row. The company row's own
// delete is not audited, for the same reason.
//
// GDPR: `changed` carries a person's values — a customer's name and address,
// an account's e-mail — so an erasure (#291 slice 19) scrubs them here too,
// as the owner, the revoke below leaving that right with the owner alone.
import { AUDIT_ACTIONS } from "@waste/domain/audit/vocabulary"
import { sql } from "drizzle-orm"
import { bigint, index, jsonb, text, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { oneOf } from "./checks"
import { id, recorded, tenant } from "./columns"
import { company } from "./organisation"
import { companyReference } from "./references"
import { wms } from "./wms"

export const auditEvent = wms.table(
  "audit_event",
  {
    ...id,
    ...tenant,
    ...recorded,
    /** The project of the row, where its table is project-scoped; null for a company-wide row. */
    projectId: uuid(),
    /** The audited table, as `TG_TABLE_NAME` spells it. */
    tableName: text().notNull(),
    rowId: uuid().notNull(),
    /** The table and the row a row of a set belongs to; null for a row of no set. */
    parentTable: text(),
    parentId: uuid(),
    action: text().notNull(),
    /** `{ column: [before, after] }`, over the columns that moved. */
    changed: jsonb().notNull(),
    /** The principal's account; null for the worker, the seed and the hook. */
    actorUserAccountId: uuid(),
    reason: text(),
    /** `pg_current_xact_id()`: what one transaction did, together. */
    transactionId: bigint({ mode: "number" }).notNull(),
  },
  (t) => [
    companyReference(t, company).onDelete("cascade"),
    oneOf(t.action, AUDIT_ACTIONS),
    // The history of one row, newest first.
    index(tableObjectName(t.companyId.table, "row_idx", "auditEvent")).on(t.companyId, t.tableName, t.rowId, t.id),
    // The history of a set, under its parent: most rows have none, so the index is partial.
    index(tableObjectName(t.companyId.table, "parent_idx", "auditEvent"))
      .on(t.companyId, t.parentTable, t.parentId, t.id)
      .where(sql`${t.parentId} is not null`),
  ],
)
