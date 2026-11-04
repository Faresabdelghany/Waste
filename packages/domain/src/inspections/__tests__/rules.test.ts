// A field inspection's rules (M23 of #293): its verdict and findings agree,
// and a photo's key is the inspection's own.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { A_FINDING_TO_FOLLOW_UP, COMPLIANT_FINDS_NOTHING, EACH_FINDING_ONCE, findingsIssue, inspectionPhotoKeyNames, inspectionPhotoKeyOf, photoIdOf } from "../rules"

const COMPANY = "018f7c31-a000-7000-8000-000000000001"
const INSPECTION = "018f7c31-a000-7000-8000-000000000002"
const PHOTO = "018f7c31-a000-7000-8000-000000000003"

describe("findingsIssue", () => {
  test("a compliant visit found nothing, a minor or a major one something, each once", () => {
    assert.equal(findingsIssue("compliant", []), undefined)
    assert.equal(findingsIssue("compliant", ["damaged"]), COMPLIANT_FINDS_NOTHING)
    assert.equal(findingsIssue("minor", []), A_FINDING_TO_FOLLOW_UP)
    assert.equal(findingsIssue("major", ["contamination", "overfilled"]), undefined)
    assert.equal(findingsIssue("major", ["contamination", "contamination"]), EACH_FINDING_ONCE)
  })
})

describe("an inspection photo's key", () => {
  const ids = { companyId: COMPANY, inspectionId: INSPECTION }
  test("is under the inspection's prefix, a photo id and an image format", () => {
    const key = inspectionPhotoKeyOf({ ...ids, photoId: PHOTO }, "jpg")
    assert.equal(key, `inspections/${COMPANY}/${INSPECTION}/${PHOTO}.jpg`)
    assert.equal(inspectionPhotoKeyNames(key, ids), true)
    assert.equal(photoIdOf(key), PHOTO)
    assert.equal(inspectionPhotoKeyNames(key, { ...ids, inspectionId: PHOTO }), false, "another inspection")
    assert.equal(inspectionPhotoKeyNames(`inspections/${COMPANY}/${INSPECTION}/${PHOTO}.pdf`, ids), false, "not an image")
    assert.equal(inspectionPhotoKeyNames(`inspections/${COMPANY}/${INSPECTION}/../${PHOTO}.jpg`, ids), false, "not a photo id")
    assert.equal(inspectionPhotoKeyNames(`${COMPANY}/${INSPECTION}/${PHOTO}.jpg`, ids), false, "a stop's proof, not an inspection's")
  })
})
