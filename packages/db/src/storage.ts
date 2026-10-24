// The proofs' Storage (O1 of #290): Supabase Storage's REST API over the
// private `proofs` bucket, under the service-role key, which the API alone
// holds, server-side (the owner's decision, superseding #129's no-key rule
// for this one purpose). It signs and never carries a byte: an upload URL for
// one key, which the device puts the bytes to; read URLs for keys, which the
// office's browser fetches; and the worker's purge removes by key. A
// deployment without the key has no Storage, and the routes that need it
// answer 503 (`server.ts`). Storage refusing a call — a bucket that is not
// there, a key it does not take, which it answers 400 with the real status in
// its body — is the deployment's state and `StorageRefused`; Storage not
// answering, within `STORAGE_TIMEOUT_MS` or at all, or answering 5xx, is
// `StorageSilent`, which a retry may get past.
import { PROOF_BUCKET, PROOF_OBJECT_MAX_BYTES } from "@waste/contracts/proof-objects"

import { PROOF_MIME_TYPES } from "./sql/proof-storage"

/** A signed upload URL lasts two hours: Storage's own term, not a choice here. */
export const UPLOAD_URL_TTL_MS = 2 * 60 * 60 * 1000

/** How long one call to Storage may go unanswered: a request waiting on it holds an API connection, and a phone gives up at its own 30 s. */
export const STORAGE_TIMEOUT_MS = 10_000

export type ProofStorage = {
  /** The URL to put one object's bytes to, until it lapses; `exists` where the bucket holds the key already. */
  signUpload(key: string): Promise<{ kind: "upload"; url: string; expiresAt: Date } | { kind: "exists" }>
  /** Read URLs for the keys, null for a key the bucket does not hold, each lapsing after `seconds`. */
  signReads(keys: readonly string[], seconds: number): Promise<Map<string, string | null>>
  /** Removes the objects and answers how many Storage held; a key no longer there is nothing to remove. */
  remove(keys: readonly string[]): Promise<number>
}

/** Supabase's Storage: the proofs' calls, and the bucket's own upkeep, which only the API's boot asks for. */
export type SupabaseStorage = ProofStorage & {
  /** The bucket as its migration makes it (`proof-storage.ts`), for a database that gained Storage after the migration ran: made where Storage lacks it, or kept private with its limits; answers which. The migration and this are the two places the bucket's settings are written, from the one spelling of its limits. */
  ensureBucket(): Promise<"made" | "kept">
}

/** Storage did not answer, in time or at all, or answered 5xx: nothing was signed or removed, and the request may be asked again. */
export class StorageSilent extends Error {
  override name = "StorageSilent"
}

/** Storage refused the call — the bucket is not there, the key is not one it takes: the deployment's state, which asking again does not change. */
export class StorageRefused extends Error {
  override name = "StorageRefused"
}

export type SupabaseStorageOptions = {
  /** The project's URL, `SUPABASE_URL`: Storage is its `/storage/v1`. */
  url: string
  serviceKey: string
  bucket?: string
  fetch?: typeof globalThis.fetch
  now?: () => Date
  timeoutMs?: number
}

/** Supabase Storage's answer to a key it holds already. */
const KEY_ALREADY_EXISTS = "KeyAlreadyExists"

/** And to a bucket it holds already, which it answers 400. */
const BUCKET_ALREADY_EXISTS = "BucketAlreadyExists"

export function supabaseStorage({ url, serviceKey, bucket = PROOF_BUCKET, fetch = globalThis.fetch, now = () => new Date(), timeoutMs = STORAGE_TIMEOUT_MS }: SupabaseStorageOptions): SupabaseStorage {
  const base = `${url.replace(/\/+$/, "")}/storage/v1`
  const auth = { authorization: `Bearer ${serviceKey}`, apikey: serviceKey }

  /** One call to Storage, its JSON answer and status, or StorageSilent where the network fails. */
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; answer: unknown }> {
    let response: Response
    try {
      const signal = AbortSignal.timeout(timeoutMs)
      // A type only over a body: Storage refuses an empty one that says it is JSON.
      response = await fetch(`${base}${path}`, body === undefined ? { method, headers: auth, signal } : { method, headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body), signal })
    } catch (error) {
      throw new StorageSilent(`Storage did not answer ${method} ${path}`, { cause: error })
    }
    const text = await response.text()
    let answer: unknown = null
    try {
      answer = text === "" ? null : JSON.parse(text)
    } catch {
      answer = text
    }
    return { status: response.status, answer }
  }

  /** An answer that is not the call's: a refusal where Storage says 4xx, its silence otherwise. */
  const refused = (method: string, path: string, status: number, answer: unknown) => {
    const said = `Storage answered ${method} ${path} with ${status}: ${JSON.stringify(answer).slice(0, 200)}`
    const real = Number((answer as { statusCode?: unknown } | null)?.statusCode)
    const refusal = (status >= 400 && status < 500) || (real >= 400 && real < 500)
    return refusal ? new StorageRefused(said) : new StorageSilent(said)
  }

  return {
    async signUpload(key) {
      const path = `/object/upload/sign/${bucket}/${key}`
      const { status, answer } = await call("POST", path)
      if (status === 409 || (answer as { code?: unknown } | null)?.code === KEY_ALREADY_EXISTS) return { kind: "exists" }
      const signed = (answer as { url?: unknown } | null)?.url
      if (status !== 200 || typeof signed !== "string") throw refused("POST", path, status, answer)
      return { kind: "upload", url: `${base}${signed}`, expiresAt: new Date(now().getTime() + UPLOAD_URL_TTL_MS) }
    },

    async signReads(keys, seconds) {
      const reads = new Map<string, string | null>()
      if (keys.length === 0) return reads
      const path = `/object/sign/${bucket}`
      const { status, answer } = await call("POST", path, { expiresIn: seconds, paths: keys })
      if (status !== 200 || !Array.isArray(answer)) throw refused("POST", path, status, answer)
      for (const key of keys) reads.set(key, null)
      for (const row of answer as Array<{ path?: unknown; signedURL?: unknown }>) {
        if (typeof row.path === "string" && reads.has(row.path)) reads.set(row.path, typeof row.signedURL === "string" ? `${base}${row.signedURL}` : null)
      }
      return reads
    },

    async remove(keys) {
      if (keys.length === 0) return 0
      const path = `/object/${bucket}`
      const { status, answer } = await call("DELETE", path, { prefixes: keys })
      // Storage answers the objects it removed, none for a key it no longer held.
      if (status !== 200 || !Array.isArray(answer)) throw refused("DELETE", path, status, answer)
      return answer.length
    },

    async ensureBucket() {
      const settings = { public: false, file_size_limit: PROOF_OBJECT_MAX_BYTES, allowed_mime_types: [...PROOF_MIME_TYPES] }
      const made = await call("POST", "/bucket", { id: bucket, name: bucket, ...settings })
      if (made.status === 200) return "made"
      const said = made.answer as { code?: unknown; statusCode?: unknown } | null
      if (made.status !== 409 && said?.statusCode !== "409" && said?.code !== BUCKET_ALREADY_EXISTS) throw refused("POST", "/bucket", made.status, made.answer)
      // Held already: kept private with its limits, as the migration's ON CONFLICT does, so one made public by hand is private again.
      const path = `/bucket/${bucket}`
      const kept = await call("PUT", path, settings)
      if (kept.status !== 200) throw refused("PUT", path, kept.status, kept.answer)
      return "kept"
    },
  }
}
