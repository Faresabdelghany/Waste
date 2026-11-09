// The provider rule's two doors (routes/provider-shape.ts). No database.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ProblemError } from "../problem"
import { providerShapeIssue, requireProviderShape } from "../routes/provider-shape"

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
