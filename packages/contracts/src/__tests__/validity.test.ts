import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { SOMETHING_TO_CHANGE } from "@waste/domain/requests"
import { validityOrdered } from "@waste/domain/periods"
import * as z from "zod"

import { Label } from "../text"
import { effectiveDated, effectiveDatedBodies } from "../validity"
import { refusal } from "./expect"

// The wording is pinned here and not read off the schema: zod moves a
// refinement's `message` into its own `error` when it takes the parameters.
const BACKWARDS = "validTo is the first day out of force, so it comes after validFrom"

describe("effectiveDated", () => {
  const Period = effectiveDated(z.object({}))

  test("is a period on the wire after the base's fields: a first day, and a first day out of force or null for open ended", () => {
    const closed = { validFrom: "2026-01-01", validTo: "2026-07-01" }
    const open = { validFrom: "2026-01-01", validTo: null }
    assert.deepEqual(Period.parse(closed), closed)
    assert.deepEqual(Period.parse(open), open)
    assert.deepEqual(Object.keys(effectiveDated(z.object({ name: Label })).shape), ["name", "validFrom", "validTo"])
  })

  test("refuses an end that is not after the start, the empty period included, at the field that is wrong", () => {
    for (const validTo of ["2026-01-01", "2025-12-31"]) {
      assert.deepEqual(refusal(Period.safeParse({ validFrom: "2026-01-01", validTo })), [{ path: "validTo", message: BACKWARDS }])
    }
  })

  test("takes calendar days and nothing else: no instant, no wall clock, no day that is not on the calendar", () => {
    for (const validFrom of ["2026-01-01T00:00:00Z", "2026-1-1", "2026-02-30", "01-01-2026", ""]) {
      assert.equal(Period.safeParse({ validFrom, validTo: null }).success, false, JSON.stringify(validFrom))
    }
  })

  test("needs both members: an absent end is not the same as an open one, and a create body says which", () => {
    assert.equal(Period.safeParse({ validFrom: "2026-01-01" }).success, false)
    assert.equal(Period.safeParse({ validTo: null }).success, false)
  })

  test("keeps what the base is: a strict one refuses a member it does not name", () => {
    const Strict = effectiveDated(z.strictObject({ name: Label }))
    assert.deepEqual(refusal(Strict.safeParse({ name: "Parkvej", validFrom: "2026-01-01", validTo: null, extra: 1 })).map((issue) => issue.path), [""])
  })
})

describe("effectiveDatedBodies", () => {
  const { create, patch } = effectiveDatedBodies({ name: Label }, { createOnly: { name: true } })

  test("a create takes the start, required, and an end absent, null or a day", () => {
    assert.deepEqual(create.parse({ name: "A", validFrom: "2026-01-01" }), { name: "A", validFrom: "2026-01-01" })
    assert.deepEqual(create.parse({ name: "A", validFrom: "2026-01-01", validTo: null }), { name: "A", validFrom: "2026-01-01", validTo: null })
    assert.deepEqual(refusal(create.safeParse({ name: "A", validTo: "2027-01-01" })).map((issue) => issue.path), ["validFrom"])
    assert.deepEqual(refusal(create.safeParse({ name: "A", validFrom: "2026-01-01", validTo: "2026-01-01" })), [{ path: "validTo", message: BACKWARDS }])
  })

  test("a patch moves either bound, is refused backwards where it holds both, and says nothing of a bound it does not hold", () => {
    assert.deepEqual(patch.parse({ validTo: null }), { validTo: null })
    assert.deepEqual(patch.parse({ validFrom: "2026-02-01" }), { validFrom: "2026-02-01" })
    assert.deepEqual(refusal(patch.safeParse({ validFrom: "2026-02-01", validTo: "2026-01-01" })), [{ path: "validTo", message: BACKWARDS }])
    assert.deepEqual(refusal(patch.safeParse({})), [{ path: "", message: SOMETHING_TO_CHANGE }])
    assert.deepEqual(refusal(patch.safeParse({ name: "B", validTo: null })).map((issue) => issue.path), [""], "a key is the create's alone")
  })

  test("a start the patch may not move is a key like any other", () => {
    const { patch: endOnly } = effectiveDatedBodies({ note: Label.optional() }, { createOnly: { validFrom: true } })
    assert.deepEqual(Object.keys(endOnly.shape), ["note", "validTo"])
    assert.deepEqual(refusal(endOnly.safeParse({ validFrom: "2026-01-01", note: "Moved" })).map((issue) => issue.path), [""])
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
