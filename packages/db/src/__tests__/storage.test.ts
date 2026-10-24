// The proofs' Storage (O1 of #290) over a scripted fetch: what the client asks
// Supabase Storage's REST API under the service-role key, and how it reads
// the answers — a signed upload, a key the bucket holds already, read URLs
// with a null for a key it does not, a purge by keys, and Storage's silence.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { StorageRefused, StorageSilent, supabaseStorage } from "../storage"

const BASE = "https://project.supabase.co"
const KEY = "01a0d2a4-a280-7000-8000-000000000001/01a0d2a4-a280-7031-8000-000000000001/01a0d2a4-a280-7099-8000-000000000001.jpg"
const NOW = new Date("2026-10-24T08:00:00.000Z")

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown }

function scripted(...answers: Array<(call: Call) => Response>) {
  const calls: Call[] = []
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const answer = answers.shift()
    if (answer === undefined) throw new Error(`unexpected ${call.method} ${call.url}`)
    return answer(call)
  }) as typeof globalThis.fetch
  return { calls, storage: supabaseStorage({ url: BASE, serviceKey: "service-role-key", fetch, now: () => NOW }) }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("the proofs' Storage", () => {
  test("signs an upload for one key under the service-role key, and answers the absolute URL and when it lapses", async () => {
    const { calls, storage } = scripted(() => json(200, { url: `/object/upload/sign/proofs/${KEY}?token=t0k3n`, token: "t0k3n" }))
    assert.deepEqual(await storage.signUpload(KEY), { kind: "upload", url: `${BASE}/storage/v1/object/upload/sign/proofs/${KEY}?token=t0k3n`, expiresAt: new Date("2026-10-24T10:00:00.000Z") })
    assert.equal(calls[0].method, "POST")
    assert.equal(calls[0].url, `${BASE}/storage/v1/object/upload/sign/proofs/${KEY}`)
    assert.equal(calls[0].headers.authorization, "Bearer service-role-key")
    assert.equal(calls[0].headers.apikey, "service-role-key")
    assert.equal(calls[0].headers["content-type"], undefined, "the request has no body, and Storage refuses JSON's type over nothing")
  })

  test("a key the bucket holds already is no upload: the retry after a lost answer is done", async () => {
    // Storage answers 400 and says 409 in its body (probed on a local stack), or a plain 409.
    for (const status of [400, 409]) {
      const { storage } = scripted(() => json(status, { statusCode: "409", error: "Duplicate", message: "The resource already exists", code: "KeyAlreadyExists" }))
      assert.deepEqual(await storage.signUpload(KEY), { kind: "exists" }, String(status))
    }
  })

  test("signs reads for many keys in one call, a key the bucket does not hold read as null", async () => {
    const other = KEY.replace(/\.jpg$/, ".png")
    const { calls, storage } = scripted(() =>
      json(200, [
        { error: null, path: KEY, signedURL: `/object/sign/proofs/${KEY}?token=r` },
        { error: "Either the object does not exist or you do not have access to it", path: other, signedURL: null },
      ]),
    )
    const reads = await storage.signReads([KEY, other], 600)
    assert.deepEqual([...reads], [
      [KEY, `${BASE}/storage/v1/object/sign/proofs/${KEY}?token=r`],
      [other, null],
    ])
    assert.equal(calls[0].url, `${BASE}/storage/v1/object/sign/proofs`)
    assert.deepEqual(calls[0].body, { expiresIn: 600, paths: [KEY, other] })
  })

  test("no keys asks nothing", async () => {
    const { calls, storage } = scripted()
    assert.deepEqual([...(await storage.signReads([], 600))], [])
    assert.equal(await storage.remove([]), 0)
    assert.equal(calls.length, 0)
  })

  test("removes objects by key and counts what Storage held, a key no longer there being nothing to remove", async () => {
    const { calls, storage } = scripted(() => json(200, [{ name: KEY }]))
    assert.equal(await storage.remove([KEY, KEY.replace(/\.jpg$/, ".png")]), 1)
    assert.equal(calls[0].method, "DELETE")
    assert.equal(calls[0].url, `${BASE}/storage/v1/object/proofs`)
    assert.deepEqual(calls[0].body, { prefixes: [KEY, KEY.replace(/\.jpg$/, ".png")] })
  })

  test("Storage's silence — a 5xx, no answer, none in time — is StorageSilent, its status kept for the log", async () => {
    const { storage } = scripted(() => json(500, { message: "internal" }), () => {
      throw new TypeError("fetch failed")
    })
    await assert.rejects(storage.signUpload(KEY), (error) => error instanceof StorageSilent && /500/.test(error.message))
    await assert.rejects(storage.signReads([KEY], 600), StorageSilent)
  })

  test("a call unanswered within its time is given up", async () => {
    const storage = supabaseStorage({
      url: BASE,
      serviceKey: "service-role-key",
      timeoutMs: 20,
      fetch: ((_input: string | URL | Request, init: RequestInit = {}) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof globalThis.fetch,
    })
    // The timeout's own timer does not hold the process open, as a real request's socket would.
    const held = setTimeout(() => {}, 5_000)
    try {
      await assert.rejects(storage.signUpload(KEY), StorageSilent)
    } finally {
      clearTimeout(held)
    }
  })

  test("ensures the bucket as its migration makes it: made where Storage lacks it, held private with its limits where it has it", async () => {
    const settings = { public: false, file_size_limit: 2_097_152, allowed_mime_types: ["image/jpeg", "image/png", "image/webp"] }
    const fresh = scripted(() => json(200, { name: "proofs" }))
    assert.equal(await fresh.storage.ensureBucket(), "made")
    assert.deepEqual([fresh.calls[0].method, fresh.calls[0].url, fresh.calls[0].body], ["POST", `${BASE}/storage/v1/bucket`, { id: "proofs", name: "proofs", ...settings }])
    // Storage answers a bucket it holds already 400, its code saying so (probed on a local stack).
    const held = scripted(() => json(400, { statusCode: "409", error: "Duplicate", message: "The resource already exists", code: "BucketAlreadyExists" }), () => json(200, { message: "Successfully updated" }))
    assert.equal(await held.storage.ensureBucket(), "kept")
    assert.deepEqual([held.calls[1].method, held.calls[1].url, held.calls[1].body], ["PUT", `${BASE}/storage/v1/bucket/proofs`, settings], "a bucket made public by hand is made private again")
    const refusing = scripted(() => json(400, { statusCode: "403", error: "Unauthorized", message: "Invalid Compact JWS", code: "AccessDenied" }))
    await assert.rejects(refusing.storage.ensureBucket(), StorageRefused)
  })

  test("Storage's refusal — a bucket not there, a key it does not take, a 400 with the real status in its body — is StorageRefused: the deployment's state, not its silence", async () => {
    const { storage } = scripted(
      () => json(400, { statusCode: "404", error: "InvalidRequest", message: "The related resource does not exist", code: "InvalidRequest" }),
      () => json(400, { statusCode: "403", error: "Unauthorized", message: "Invalid Compact JWS", code: "AccessDenied" }),
      () => json(403, { message: "forbidden" }),
    )
    await assert.rejects(storage.signUpload(KEY), (error) => error instanceof StorageRefused && /404/.test(error.message))
    await assert.rejects(storage.signReads([KEY], 600), StorageRefused)
    await assert.rejects(storage.remove([KEY]), StorageRefused)
  })
})
