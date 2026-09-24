import assert from "node:assert/strict"
import { describe, test } from "node:test"
import * as z from "zod"

import { Validity, ValidityCreate, validityOrdered } from "../validity"

// The wording is pinned here and not read off the schema: zod moves a
// refinement's `message` into its own `error` when it takes the parameters.
const BACKWARDS = "validTo is the first day out of force, so it comes after validFrom"

/** Each issue a failed parse produced, as the API's 400 would spell it. */
const refusal = (result: { success: boolean; error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } }) => {
  assert.equal(result.success, false)
  return (result.error?.issues ?? []).map((issue) => ({ path: issue.path.join("."), message: issue.message }))
}

describe("Validity", () => {
  test("is a period on the wire: a first day, and a first day out of force or null for open ended", () => {
    const closed = { validFrom: "2026-01-01", validTo: "2026-07-01" }
    const open = { validFrom: "2026-01-01", validTo: null }
    assert.deepEqual(Validity.parse(closed), closed)
    assert.deepEqual(Validity.parse(open), open)
  })

  test("refuses an end that is not after the start, the empty period included, at the field that is wrong", () => {
    for (const validTo of ["2026-01-01", "2025-12-31"]) {
      assert.deepEqual(refusal(Validity.safeParse({ validFrom: "2026-01-01", validTo })), [{ path: "validTo", message: BACKWARDS }])
    }
  })

  test("takes calendar days and nothing else: no instant, no wall clock, no day that is not on the calendar", () => {
    for (const validFrom of ["2026-01-01T00:00:00Z", "2026-1-1", "2026-02-30", "01-01-2026", ""]) {
      assert.equal(Validity.safeParse({ validFrom, validTo: null }).success, false, JSON.stringify(validFrom))
    }
  })

  test("needs both members: an absent end is not the same as an open one, and a create body says which", () => {
    assert.equal(Validity.safeParse({ validFrom: "2026-01-01" }).success, false)
    assert.equal(Validity.safeParse({ validTo: null }).success, false)
  })
})

describe("ValidityCreate", () => {
  const Body = z.strictObject({ ...ValidityCreate })

  test("is the fragment a create body spreads: the start is required, the end is absent, null or a day", () => {
    assert.deepEqual(Body.parse({ validFrom: "2026-01-01" }), { validFrom: "2026-01-01" })
    assert.deepEqual(Body.parse({ validFrom: "2026-01-01", validTo: null }), { validFrom: "2026-01-01", validTo: null })
    assert.deepEqual(Body.parse({ validFrom: "2026-01-01", validTo: "2027-01-01" }), { validFrom: "2026-01-01", validTo: "2027-01-01" })
    assert.deepEqual(refusal(Body.safeParse({ validTo: "2027-01-01" })).map((issue) => issue.path), ["validFrom"])
  })
})

describe("validityOrdered", () => {
  test("holds an end against its start by string comparison, which for YYYY-MM-DD is date order", () => {
    assert.equal(validityOrdered({ validFrom: "2026-01-01", validTo: "2026-01-02" }), true)
    assert.equal(validityOrdered({ validFrom: "2026-01-31", validTo: "2026-02-01" }), true)
    assert.equal(validityOrdered({ validFrom: "2026-01-01", validTo: "2026-01-01" }), false)
    assert.equal(validityOrdered({ validFrom: "2026-02-01", validTo: "2026-01-31" }), false)
  })

  test("says nothing about a period it cannot see whole, which is what a patch gives it", () => {
    assert.equal(validityOrdered({ validFrom: "2026-01-01", validTo: null }), true)
    assert.equal(validityOrdered({ validTo: "2026-01-01" }), true)
    assert.equal(validityOrdered({ validFrom: "2026-01-01" }), true)
    assert.equal(validityOrdered({}), true)
  })
})
