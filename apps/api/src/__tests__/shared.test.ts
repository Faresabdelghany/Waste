// The pure helpers of routes/shared.ts that need no request: how a row's
// stamps and a `time` column are spelled on the wire (Issue #97). No database.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { IsoTime } from "@waste/contracts/dates"

import { ProblemError } from "../problem"
import { providerShapeIssue, requireProviderShape, stampsOf, timeOf } from "../routes/shared"

describe("timeOf", () => {
  test("drops the seconds Postgres spells a time with, so the value is the contracts' IsoTime", () => {
    assert.equal(timeOf("06:30:00"), "06:30")
    assert.equal(timeOf("23:59:59"), "23:59")
    assert.equal(timeOf("06:30:00.5"), "06:30", "fractional seconds go too")
    for (const value of ["06:30:00", "00:00:00"]) assert.ok(IsoTime.safeParse(timeOf(value)).success, value)
  })

  test("passes a time already spelled HH:MM through", () => {
    assert.equal(timeOf("06:30"), "06:30")
  })

  test("throws on anything that is not a time of day, since that is a statement's bug and not a client's", () => {
    for (const value of ["", "6:30:00", "06:30:00+02:00", "2026-09-25T06:30:00", "morning"]) {
      assert.throws(() => timeOf(value), /timeOf: .* is not a time of day as Postgres spells one \(HH:MM:SS\)/, value)
    }
  })
})

describe("providerShapeIssue and requireProviderShape, the provider rule's two doors", () => {
  const PROVIDER = "01a0d3a5-e5e0-7000-8000-000000000001"
  const SENTENCE = "the family's sentence"
  const issue = { path: "serviceProviderId", message: SENTENCE }

  test("answer nothing where the merged row holds, and the field error at serviceProviderId where it does not", () => {
    assert.equal(providerShapeIssue("company", { serviceProviderId: null }, SENTENCE), undefined)
    assert.equal(providerShapeIssue("service-provider", { serviceProviderId: PROVIDER }, SENTENCE), undefined)
    assert.deepEqual(providerShapeIssue("service-provider", { serviceProviderId: null }, SENTENCE), issue, "a provider's row names no provider")
    assert.deepEqual(providerShapeIssue("company", { serviceProviderId: PROVIDER }, SENTENCE), issue, "the company's row names one")
  })

  test("the throwing door is the same answer as a 400, so a caller with one rule to hold and one collecting several agree", () => {
    requireProviderShape("company", { serviceProviderId: null }, SENTENCE)
    assert.throws(
      () => requireProviderShape("company", { serviceProviderId: PROVIDER }, SENTENCE),
      (error: unknown) => error instanceof ProblemError && error.body.status === 400 && JSON.stringify(error.body.errors) === JSON.stringify([issue]),
    )
  })
})

describe("stampsOf", () => {
  test("spells the two instants as RFC 3339 in UTC", () => {
    const at = new Date("2026-09-25T06:30:00.000+02:00")
    assert.deepEqual(stampsOf({ createdAt: at, updatedAt: at }), { createdAt: "2026-09-25T04:30:00.000Z", updatedAt: "2026-09-25T04:30:00.000Z" })
  })
})
