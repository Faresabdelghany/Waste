// The proofs bucket's objects: each kind's key layout and formats.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ATTACHMENT_KEY_PATTERN, inspectionPhotoKeyNames, inspectionPhotoKeyOf, objectKeyOf, photoIdOf, PROOF_BUCKET, PROOF_KEY_PATTERN } from "../storage-objects"

const COMPANY = "018f7c31-a000-7000-8000-000000000001"
const INSPECTION = "018f7c31-a000-7000-8000-000000000002"
const PHOTO = "018f7c31-a000-7000-8000-000000000003"

describe("proof objects: the bytes of a photo or a signature (O1 of #290)", () => {
  test("live in one private bucket", () => {
    assert.equal(PROOF_BUCKET, "proofs")
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

describe("a proof's and an attachment's key", () => {
  test("share the path of three ids, and part by their formats: a document is an attachment's alone", () => {
    const proof = objectKeyOf({ companyId: COMPANY, routeId: INSPECTION, commandId: PHOTO }, "webp")
    assert.match(proof, new RegExp(PROOF_KEY_PATTERN))
    assert.match(proof, new RegExp(ATTACHMENT_KEY_PATTERN))
    const document = `${COMPANY}/${INSPECTION}/${PHOTO}.pdf`
    assert.doesNotMatch(document, new RegExp(PROOF_KEY_PATTERN))
    assert.match(document, new RegExp(ATTACHMENT_KEY_PATTERN))
    assert.doesNotMatch(`inspections/${COMPANY}/${INSPECTION}/${PHOTO}.jpg`, new RegExp(PROOF_KEY_PATTERN))
  })
})
