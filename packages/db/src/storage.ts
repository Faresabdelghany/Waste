// The proofs' Storage (O1 of #290): Supabase Storage's REST API over the
// private `proofs` bucket, under the service-role key, which the API alone
// holds, server-side (the owner's decision, superseding #129's no-key rule
// for this one purpose). It signs and never carries a byte: an upload URL for
// one key, which the device puts the bytes to; read URLs for keys, which the
// office's browser fetches; and the worker's purge removes by key. A
// deployment without the key has no Storage, and the routes that need it
// answer 503 (`server.ts`).
import { PROOF_BUCKET } from "@waste/contracts/proof-objects"

/** A signed upload URL lasts two hours: Storage's own term, not a choice here. */
export const UPLOAD_URL_TTL_MS = 2 * 60 * 60 * 1000

export type ProofStorage = {
  /** The URL to put one object's bytes to, until it lapses; `exists` where the bucket holds the key already. */
  signUpload(key: string): Promise<{ kind: "upload"; url: string; expiresAt: Date } | { kind: "exists" }>
  /** Read URLs for the keys, null for a key the bucket does not hold, each lapsing after `seconds`. */
  signReads(keys: readonly string[], seconds: number): Promise<Map<string, string | null>>
  /** Removes the objects; a key no longer there is nothing to remove. */
  remove(keys: readonly string[]): Promise<void>
}

/** Storage answered with an error, or not at all: nothing was signed or removed, and the request may be asked again. */
export class StorageSilent extends Error {
  override name = "StorageSilent"
}

export type SupabaseStorageOptions = {
  /** The project's URL, `SUPABASE_URL`: Storage is its `/storage/v1`. */
  url: string
  serviceKey: string
  bucket?: string
  fetch?: typeof globalThis.fetch
  now?: () => Date
}

/** Supabase Storage's answer to a key it holds already. */
const KEY_ALREADY_EXISTS = "KeyAlreadyExists"

export function supabaseStorage({ url, serviceKey, bucket = PROOF_BUCKET, fetch = globalThis.fetch, now = () => new Date() }: SupabaseStorageOptions): ProofStorage {
  const base = `${url.replace(/\/+$/, "")}/storage/v1`
  const auth = { authorization: `Bearer ${serviceKey}`, apikey: serviceKey }

  /** One call to Storage, its JSON answer and status, or StorageSilent where the network fails. */
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; answer: unknown }> {
    let response: Response
    try {
      // A type only over a body: Storage refuses an empty one that says it is JSON.
      response = await fetch(`${base}${path}`, body === undefined ? { method, headers: auth } : { method, headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) })
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

  const refused = (method: string, path: string, status: number, answer: unknown) => new StorageSilent(`Storage answered ${method} ${path} with ${status}: ${JSON.stringify(answer).slice(0, 200)}`)

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
      if (keys.length === 0) return
      const path = `/object/${bucket}`
      const { status, answer } = await call("DELETE", path, { prefixes: keys })
      if (status !== 200) throw refused("DELETE", path, status, answer)
    },
  }
}
