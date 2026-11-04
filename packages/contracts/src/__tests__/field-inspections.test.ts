// The wire of field inspections (M23 of #293): one subject, a verdict its
// findings agree with, a patch that changes something, and a photo's upload.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { A_FINDING_TO_FOLLOW_UP, COMPLIANT_FINDS_NOTHING, EACH_FINDING_ONCE, FieldInspection, FieldInspectionCreate, FieldInspectionPatch, InspectionPhotoUploadRequest, ONE_SUBJECT } from "../field-inspections"
import { Pickup } from "../pickups"

const ID = "018f7c31-a000-7000-8000-000000000001"
const OTHER = "018f7c31-a000-7000-8000-000000000002"
const WHEN = "2026-10-29T08:00:00.000Z"

const issues = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) => (result.error?.issues ?? []).map((issue) => [issue.path.join("."), issue.message])

describe("FieldInspectionCreate", () => {
  test("is of a container or a property, exactly one", () => {
    assert.deepEqual(FieldInspectionCreate.parse({ containerId: ID, outcome: "compliant" }), { containerId: ID, outcome: "compliant", findings: [] })
    assert.equal(FieldInspectionCreate.safeParse({ propertyId: ID, outcome: "minor", findings: ["damaged"], note: "Lid cracked", inspectedAt: WHEN }).success, true)
    assert.deepEqual(issues(FieldInspectionCreate.safeParse({ outcome: "compliant" })), [["containerId", ONE_SUBJECT]])
    assert.deepEqual(issues(FieldInspectionCreate.safeParse({ containerId: ID, propertyId: OTHER, outcome: "compliant" })), [["containerId", ONE_SUBJECT]])
  })

  test("a verdict its findings agree with, each finding once", () => {
    assert.deepEqual(issues(FieldInspectionCreate.safeParse({ containerId: ID, outcome: "compliant", findings: ["damaged"] })), [["findings", COMPLIANT_FINDS_NOTHING]])
    assert.deepEqual(issues(FieldInspectionCreate.safeParse({ containerId: ID, outcome: "major" })), [["findings", A_FINDING_TO_FOLLOW_UP]])
    assert.deepEqual(issues(FieldInspectionCreate.safeParse({ containerId: ID, outcome: "major", findings: ["damaged", "damaged"] })), [["findings", EACH_FINDING_ONCE]])
    assert.equal(FieldInspectionCreate.safeParse({ containerId: ID, outcome: "major", findings: ["melted"] }).success, false, "not a finding")
  })

  test("leaves the server's members to the server", () => {
    for (const member of ["id", "projectId", "inspectorId", "status", "closedAt", "photos"]) {
      assert.equal(FieldInspectionCreate.safeParse({ containerId: ID, outcome: "compliant", [member]: ID }).success, false, member)
    }
  })
})

describe("FieldInspectionPatch", () => {
  test("changes something, and never the subject", () => {
    assert.equal(FieldInspectionPatch.safeParse({}).success, false)
    assert.equal(FieldInspectionPatch.safeParse({ note: null }).success, true)
    assert.equal(FieldInspectionPatch.safeParse({ containerId: ID }).success, false)
  })
})

describe("the inspection on the wire", () => {
  test("carries its photos and its status", () => {
    const row = { id: ID, createdAt: WHEN, updatedAt: WHEN, projectId: OTHER, containerId: ID, propertyId: null, inspectorId: OTHER, inspectedAt: WHEN, outcome: "minor", findings: ["overfilled"], note: null, status: "open", closedAt: null, photos: [{ id: OTHER, objectKey: `inspections/${ID}/${ID}/${OTHER}.jpg`, recordedAt: WHEN }] }
    assert.deepEqual(FieldInspection.parse(row), row)
  })

  test("a photo is one of the bucket's images", () => {
    assert.equal(InspectionPhotoUploadRequest.safeParse({ extension: "webp" }).success, true)
    assert.equal(InspectionPhotoUploadRequest.safeParse({ extension: "pdf" }).success, false)
  })
})

describe("a stop's fill estimate", () => {
  test("is one of the levels, and absent on an event from before it, read as none", () => {
    const stop = { id: ID, projectId: OTHER, routeId: OTHER, containerId: ID, position: 1, status: "completed", reason: null, note: null, propertyId: OTHER, sharedCollectionPointId: null, wasteFractionId: OTHER, arrivedAt: null, outcomeAt: WHEN, createdAt: WHEN, updatedAt: WHEN }
    assert.equal(Pickup.parse(stop).fill, null)
    assert.equal(Pickup.parse({ ...stop, fill: "overflowing" }).fill, "overflowing")
    assert.equal(Pickup.safeParse({ ...stop, fill: "brimming" }).success, false)
  })
})
