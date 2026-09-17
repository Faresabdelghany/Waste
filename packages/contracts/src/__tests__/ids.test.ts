import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Id } from "../ids"

describe("Id", () => {
  test("accepts a UUID version 7 in either case and returns it in lowercase", () => {
    assert.equal(Id.parse("0192b3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d"), "0192b3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d")
    assert.equal(Id.parse("0192B3D4-5E6F-7A8B-9C0D-1E2F3A4B5C6D"), "0192b3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d")
  })

  test("rejects other UUID versions, other strings and non-strings", () => {
    assert.equal(Id.safeParse("550e8400-e29b-41d4-a716-446655440000").success, false, "version 4")
    assert.equal(Id.safeParse("00000000-0000-0000-0000-000000000000").success, false, "nil")
    assert.equal(Id.safeParse("container-001").success, false, "a fixture id")
    assert.equal(Id.safeParse("").success, false)
    assert.equal(Id.safeParse(42).success, false)
    assert.equal(Id.safeParse(null).success, false)
  })
})
