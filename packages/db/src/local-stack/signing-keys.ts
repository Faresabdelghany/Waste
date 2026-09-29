// The local stack's JWT signing key (Issue #151). `supabase/config.toml` names
// `[auth] signing_keys_path`, so local Auth signs ES256 like the hosted
// project and the API's verifier (apps/api/src/auth/verify.ts, asymmetric
// algorithms only) accepts a local token unchanged. The CLI cannot bootstrap
// the key itself: once the path is configured it fails to load its config
// while the file is missing, and `supabase gen signing-key` refuses for the
// same reason. So every root command that can start the stack runs
// scripts/signing-key.ts first, which writes one here when there is none.
//
// The key is minted by `node:crypto` on the machine that starts the stack,
// per clone and per CI run; the file is gitignored by name and never leaves
// the machine. Nothing here reaches the hosted project: `config push` does
// not carry signing keys.
import { generateKeyPairSync, randomUUID, type JsonWebKey } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/** A JWK as GoTrue reads one from `GOTRUE_JWT_KEYS`: the key pair plus the fields that say what it is for. */
export type SigningKey = JsonWebKey & {
  kid: string
  alg: "ES256"
  use: "sig"
  key_ops: ["sign", "verify"]
}

/** One fresh ES256 (P-256) key pair as a private JWK, in the shape the CLI's own `gen signing-key` writes. */
export function generateSigningKey(): SigningKey {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const jwk = privateKey.export({ format: "jwk" })
  return { ...jwk, kid: randomUUID(), alg: "ES256", use: "sig", key_ops: ["sign", "verify"] }
}

/** What the file holds: an array, since GoTrue reads a set and signs with the first key. */
export function renderSigningKeys(keys: readonly SigningKey[]): string {
  return `${JSON.stringify(keys, null, 2)}\n`
}

export type EnsureOutcome = { path: string; written: boolean }

/**
 * Writes a fresh key set to `path` when no file is there, and leaves an
 * existing one alone, whatever it holds: a developer's stack keeps the key
 * its running Auth signs with, so tokens issued earlier stay verifiable.
 * Readable by the owner only, like any private key.
 */
export function ensureSigningKeys(path: string): EnsureOutcome {
  if (existsSync(path)) return { path, written: false }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, renderSigningKeys([generateSigningKey()]), { mode: 0o600, flag: "wx" })
  return { path, written: true }
}
