import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { OBJECT_KEY_SHAPE } from "../execution"
import { PROOF_BUCKET, ProofObjectLinks, ProofUpload, ProofUploadRequest } from "../proof-objects"

const COMPANY = "01a0d2a4-a280-7000-8000-000000000001"
const ROUTE = "01a0d2a4-a280-7031-8000-000000000001"
const COMMAND = "01a0d2a4-a280-7099-8000-000000000001"
const PROOF = "01a0d2a4-a280-7034-8000-000000000001"
const KEY = `${COMPANY}/${ROUTE}/${COMMAND}.jpg`

describe("proof objects: the bytes of a photo or a signature, signed by the API and never carried by it (O1 of #290)", () => {
  test("live in one private bucket", () => {
    assert.equal(PROOF_BUCKET, "proofs")
  })

  test("a device asks for the object of one of its commands, on a route, in one of the four formats", () => {
    const asked = { routeId: ROUTE, commandId: COMMAND, extension: "jpg" }
    assert.deepEqual(ProofUploadRequest.parse(asked), asked)
    assert.equal(ProofUploadRequest.safeParse({ ...asked, extension: "gif" }).success, false, "an image format the bucket takes")
    assert.equal(ProofUploadRequest.safeParse({ ...asked, objectKey: KEY }).success, false, "the API names the key, never the device")
    for (const member of ["routeId", "commandId", "extension"]) {
      const without: Record<string, unknown> = { ...asked }
      delete without[member]
      assert.equal(ProofUploadRequest.safeParse(without).success, false, member)
    }
  })

  test("is answered with where to put the bytes until when, or that they are there already", () => {
    const upload = { state: "upload", objectKey: KEY, uploadUrl: `https://project.supabase.co/storage/v1/object/upload/sign/proofs/${KEY}?token=t`, expiresAt: "2026-10-24T10:00:00.000Z" }
    assert.deepEqual(ProofUpload.parse(upload), upload)
    assert.deepEqual(ProofUpload.parse({ state: "uploaded", objectKey: KEY }), { state: "uploaded", objectKey: KEY })
    assert.equal(ProofUpload.safeParse({ ...upload, uploadUrl: "not a url" }).success, false)
    assert.deepEqual(
      ProofUpload.safeParse({ ...upload, objectKey: "photo.jpg" }).error?.issues.map((issue) => issue.message),
      [OBJECT_KEY_SHAPE],
    )
  })

  test("the office reads a stop's objects through URLs that lapse, null where Storage holds none", () => {
    const links = {
      items: [
        { proofId: PROOF, objectKey: KEY, url: `https://project.supabase.co/storage/v1/object/sign/proofs/${KEY}?token=t`, expiresAt: "2026-10-24T08:10:00.000Z" },
        { proofId: PROOF, objectKey: KEY, url: null, expiresAt: "2026-10-24T08:10:00.000Z" },
      ],
    }
    assert.deepEqual(ProofObjectLinks.parse(links), links)
  })
})
