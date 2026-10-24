// The audit log's contract (#291, slice 9): a row of it as the API answers it,
// the query that reads a row's history or the company's, and the header a
// write's reason travels in.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { AUDIT_ACTIONS } from "@waste/domain/audit/vocabulary"

import { AuditAction, AuditEvent, AuditEventListQuery, CHANGE_REASON_HEADER } from "../audit"

const ROW = "01a0d2a4-a280-7012-8000-000000000001"
const event = {
  id: "019995e0-0000-7000-8000-0000000000a1",
  recordedAt: "2026-10-24T10:00:00.000Z",
  projectId: null,
  table: "role_grant",
  rowId: ROW,
  parentTable: "role",
  parentId: "01a0d2a4-a280-7004-8000-000000000003",
  action: "delete",
  changed: { module_key: ["operate.tickets", null], action: ["view", null] },
  actor: { id: "01a0d2a4-a280-7005-8000-000000000001", fullName: "Fares Abdelghany" },
  reason: "Night desk no longer opens tickets",
  transactionId: "48213",
}

describe("the audit contract", () => {
  test("an action is the vocabulary's: insert, update or delete", () => {
    assert.deepEqual(AuditAction.options, [...AUDIT_ACTIONS])
  })

  test("a row says which table and row, its parent, what moved as [before, after], who, why and in which transaction", () => {
    assert.deepEqual(AuditEvent.parse(event), event)
    assert.ok(AuditEvent.safeParse({ ...event, actor: null, reason: null, parentTable: null, parentId: null }).success, "the worker's write, of no set")
    assert.ok(!AuditEvent.safeParse({ ...event, table: "Role Grant" }).success, "a table in the database's spelling")
    assert.ok(!AuditEvent.safeParse({ ...event, changed: { name: ["only before"] } }).success, "a change is a pair")
    assert.ok(!AuditEvent.safeParse({ ...event, transactionId: 48213 }).success, "a decimal string, since it may outgrow a double")
  })

  test("a page is one row's history, with table and rowId together, or the company's, with neither", () => {
    assert.ok(AuditEventListQuery.safeParse({ table: "agreement", rowId: ROW }).success)
    assert.ok(AuditEventListQuery.safeParse({}).success)
    const half = AuditEventListQuery.safeParse({ table: "agreement" })
    assert.ok(!half.success)
    assert.deepEqual(half.error.issues.map((issue) => issue.path), [["rowId"]])
    assert.ok(!AuditEventListQuery.safeParse({ rowId: ROW }).success)
  })

  test("the reason's header is one name, lowercase as a header is read", () => {
    assert.equal(CHANGE_REASON_HEADER, "waste-change-reason")
  })
})
