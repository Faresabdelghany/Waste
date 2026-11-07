// The audit log on the wire (#291, slice 9): `GET /audit-events`, the history
// of one row — and of the sets it is the parent of — or of the whole company,
// newest first. A row of it says what happened to which row of which table,
// the columns that moved as `[before, after]`, who did it (an account, or
// none for the worker, the seed and the access token hook), why where the
// office said so, and the transaction it happened in, which groups a matrix
// replaced whole into one change.
//
// The reason travels in a header, `Waste-Change-Reason`, on any write: a
// person's own word for a change, percent-encoded as `encodeURIComponent`
// spells it — a header carries bytes, and a reason may be in any script — and
// bounded like any paragraph once decoded. The actor never travels: the API's
// principal is the only source of who.
import { AUDIT_ACTIONS, AUDITED_TABLES, NOT_AN_AUDITED_TABLE, TABLE_NAME_PATTERN, TABLE_NAME_SHAPE, type AuditedTableName } from "@waste/domain/audit/vocabulary"
import { WHOLE_NUMBER_PATTERN } from "@waste/domain/requests"
import * as z from "zod"

import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { recorded } from "./resource"

export const AuditAction = z.enum(AUDIT_ACTIONS)
export type AuditAction = z.infer<typeof AuditAction>

/** A table's name as the database spells it: `role_grant`, `property_party`. */
const TableName = z.string().regex(new RegExp(TABLE_NAME_PATTERN), TABLE_NAME_SHAPE)

/**
 * A table whose rows have a history (`AUDITED_TABLES`, @waste/domain/audit/vocabulary):
 * what a client names a row's table by. A row's history also carries its
 * sets' rows, so an event's own `table` is held to the name's shape alone.
 */
export const AuditedTable = z.enum(Object.keys(AUDITED_TABLES) as [AuditedTableName, ...AuditedTableName[]], {
  error: (issue) => (issue.input === undefined ? undefined : NOT_AN_AUDITED_TABLE),
})
export type AuditedTable = z.infer<typeof AuditedTable>

export const AuditEvent = z.object({
  ...recorded,
  /** The project of the row, where its table is project-scoped. */
  projectId: Id.nullable(),
  table: TableName,
  rowId: Id,
  /** The parent a set's row belongs to: a role's grant names its role. */
  parentTable: TableName.nullable(),
  parentId: Id.nullable(),
  action: AuditAction,
  /** `{ column: [before, after] }`, over the columns that moved, in the database's spelling; a value is the column's JSON. */
  changed: z.record(z.string(), z.tuple([z.unknown(), z.unknown()])),
  /** Who made the change; null for the worker, the seed and the access token hook. */
  actor: z.object({ id: Id, fullName: z.string() }).nullable(),
  reason: z.string().nullable(),
  /** One request's changes share it: a matrix replaced whole is one change. A decimal string, since it may outgrow a double. */
  transactionId: z.string().regex(new RegExp(WHOLE_NUMBER_PATTERN)),
})
export type AuditEvent = z.infer<typeof AuditEvent>

/**
 * A page of one row's history, newest first: its own changes and those of
 * the sets it is the parent of, two levels down.
 */
export const AuditEventListQuery = PageRequest.extend({
  table: AuditedTable,
  rowId: Id,
})
export type AuditEventListQuery = z.infer<typeof AuditEventListQuery>
