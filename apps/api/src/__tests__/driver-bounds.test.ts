// The key a driver command's replay names, and the clock bounds a device's
// command is held within (Issue #104, slice 4). No database.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { driverCommand, session } from "@waste/db/schema/execution"
import { OCCURRED_AT_SKEW_MS } from "@waste/domain/execution/commands"

import { COMMAND_BACKDATE_MS, primaryKeyOf } from "../routes/driver"

describe("primaryKeyOf", () => {
  test("names a table's primary key the way Postgres does", () => {
    assert.equal(primaryKeyOf(driverCommand), "driver_command_pkey")
    assert.equal(primaryKeyOf(session), "session_pkey")
  })
})

describe("the clock bounds a recorded instant is held within", () => {
  test("are five minutes ahead and forty-eight hours behind the request, spelled once", () => {
    assert.equal(OCCURRED_AT_SKEW_MS, 5 * 60_000)
    assert.equal(COMMAND_BACKDATE_MS, 48 * 60 * 60_000)
  })
})
