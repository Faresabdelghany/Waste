// A project's privacy policy in Settings › Privacy on the Pilot (#291 C19):
// read off the project record's JSON, shown in words, and written whole from
// a form whose empty parts are no policy of the project's own.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../business-modules"
import { gpsPurposeLabel, NO_PRIVACY_POLICY, PRIVACY_POLICY_KEY, privacyPolicyFormOf, privacyPolicyFromForm, privacyPolicyOf, retentionLabel, retentionRefusalOf } from "../privacy-policy"

const projectWith = (value: unknown): BusinessRecord => ({ id: "project-copenhagen", name: "Copenhagen Central", submittedValues: value === undefined ? {} : { [PRIVACY_POLICY_KEY]: value } }) as unknown as BusinessRecord

describe("a project's privacy policy", () => {
  test("is read off the record's JSON, and is no policy where the record carries none or no policy", () => {
    const policy = { positionRetentionDays: 14, proofRetentionDays: 365, gpsPurpose: "dispatch-and-proof" }
    assert.deepEqual(privacyPolicyOf(projectWith(JSON.stringify(policy))), policy)
    assert.deepEqual(privacyPolicyOf(projectWith(undefined)), NO_PRIVACY_POLICY)
    assert.deepEqual(privacyPolicyOf(projectWith("not json")), NO_PRIVACY_POLICY)
    assert.deepEqual(privacyPolicyOf(projectWith(JSON.stringify({ gpsPurpose: "marketing" }))), NO_PRIVACY_POLICY)
  })

  test("is shown in words: days, or the deployment's setting; a purpose, or none declared", () => {
    assert.equal(retentionLabel(14), "14 days")
    assert.equal(retentionLabel(1), "1 day")
    assert.equal(retentionLabel(null), "Deployment setting")
    assert.equal(gpsPurposeLabel("dispatch"), "Dispatch")
    assert.equal(gpsPurposeLabel(null), "Not declared")
  })

  test("is written whole from the form: an empty part is no policy of the project's own, and days outside a kind's bounds are refused before the API", () => {
    assert.deepEqual(privacyPolicyFromForm({ positionRetentionDays: " 7 ", proofRetentionDays: "", gpsPurpose: "dispatch" }), { positionRetentionDays: 7, proofRetentionDays: null, gpsPurpose: "dispatch" })
    assert.deepEqual(privacyPolicyFromForm(privacyPolicyFormOf(NO_PRIVACY_POLICY)), NO_PRIVACY_POLICY)
    assert.equal(retentionRefusalOf("positions", "31"), "Positions are kept a whole number of days from 1 to 30")
    assert.equal(retentionRefusalOf("proofs", "0"), "Photos and signatures are kept a whole number of days from 1 to 3650")
    assert.equal(retentionRefusalOf("proofs", "2.5"), "Photos and signatures are kept a whole number of days from 1 to 3650")
    assert.equal(privacyPolicyFromForm({ positionRetentionDays: "31", proofRetentionDays: "", gpsPurpose: "" }), null)
  })
})
