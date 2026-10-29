import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BACKFILLED_DECOMMISSION_REASON, DEFAULT_DECOMMISSION_REASONS } from "../decommission-reasons"

describe("the decommission reasons a company starts with (O30 of #290, row 9.6)", () => {
  test("are eight, each code a lowercase slug and each code and name once, other among them", () => {
    assert.equal(DEFAULT_DECOMMISSION_REASONS.length, 8)
    for (const { code } of DEFAULT_DECOMMISSION_REASONS) assert.match(code, /^[a-z0-9]+(-[a-z0-9]+)*$/)
    assert.equal(new Set(DEFAULT_DECOMMISSION_REASONS.map((reason) => reason.code)).size, 8)
    assert.equal(new Set(DEFAULT_DECOMMISSION_REASONS.map((reason) => reason.name)).size, 8)
    assert.ok(DEFAULT_DECOMMISSION_REASONS.some((reason) => reason.code === BACKFILLED_DECOMMISSION_REASON))
  })
})
