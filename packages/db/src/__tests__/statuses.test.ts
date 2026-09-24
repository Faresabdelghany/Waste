// A status is text with a CHECK here (schema/checks.ts) and a zod enum at the
// API boundary (@waste/contracts/organisation). Two lists, one vocabulary:
// this test holds them equal in both directions and in order, so adding a
// status is one migration and one contract change and never half of each — a
// value the database allows that the contracts refuse would answer 500 on a
// row that is perfectly legal, and a value the contracts allow that the
// database refuses would answer 500 on a write that looked fine.
//
// No database: both lists are source. The check constraints themselves are
// pinned by organisation-access-rendering.test.ts and proved against Postgres
// by organisation-access.test.ts.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CompanyStatus, ProjectStatus } from "@waste/contracts/organisation"

import { COMPANY_STATUSES, PROJECT_STATUSES } from "../schema/organisation"

describe("the statuses the database checks and the contracts enumerate", () => {
  test("are the same list for a company", () => {
    assert.deepEqual([...COMPANY_STATUSES], CompanyStatus.options)
  })

  test("are the same list for a project", () => {
    assert.deepEqual([...PROJECT_STATUSES], ProjectStatus.options)
  })

  test("are not empty, and every value is one the other side parses", () => {
    assert.ok(COMPANY_STATUSES.length > 0 && PROJECT_STATUSES.length > 0)
    for (const status of COMPANY_STATUSES) assert.equal(CompanyStatus.parse(status), status)
    for (const status of PROJECT_STATUSES) assert.equal(ProjectStatus.parse(status), status)
  })
})
