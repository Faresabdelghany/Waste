// Tokens a test signs itself. The API verifies a Supabase access token
// against the project's JWKS (auth/verify.ts); here the project is a key pair
// generated once per test file, its public half published as a local key set
// and its private half signing whatever claims a test wants, so a test never
// fetches anything and can mint a token that is wrong in exactly one way: the
// signature, the issuer, the audience, the expiry, the algorithm, the key id.
// The claims are shaped as Supabase Auth shapes them (`role`, `email`,
// `app_metadata` with the hook's `company_id`), so a test's token is the
// hosted project's token in every way but the key.
import { randomUUID } from "node:crypto"

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JSONWebKeySet, type JWK } from "jose"

import { createVerifier, supabaseAuth, TOKEN_AUDIENCE, type Verifier } from "../auth/verify"

/** A project that does not exist; the issuer is derived from it as the API derives the real one. */
export const TEST_SUPABASE_URL = "https://test-project.supabase.co"
export const TEST_ISSUER = supabaseAuth(TEST_SUPABASE_URL).issuer

export type SigningKeys = {
  kid: string
  privateKey: CryptoKey
  /** The public half, as a JWKS the API would fetch. */
  jwks: JSONWebKeySet
  /** The API's verifier over that key set: what createApp is handed in tests. */
  verifier: Verifier
}

/** An ES256 key pair, as the hosted project signs with, published under one `kid`. */
export async function signingKeys(kid = `test-${randomUUID()}`): Promise<SigningKeys> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true })
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" }
  const jwks: JSONWebKeySet = { keys: [jwk] }
  return { kid, privateKey, jwks, verifier: createVerifier({ keySet: createLocalJWKSet(jwks), issuer: TEST_ISSUER }) }
}

export type TokenOptions = {
  /** The auth user id; a fresh UUID by default, which no account is bound to. */
  sub?: string
  /** The hook's claim; absent by default, as for a login with no account. */
  companyId?: string
  /** Replaces the whole `app_metadata` when a test wants a malformed one. */
  appMetadata?: Record<string, unknown>
  email?: string
  issuer?: string
  audience?: string
  /** jose's spelling: a duration (`1h`), an epoch second or a Date. */
  expiresAt?: string | number | Date
  /** The key id in the header; the signing key's by default. */
  kid?: string
  /** Signs with another key than the published one: a bad signature under a known `kid`. */
  privateKey?: CryptoKey
  /** Anything else in the payload. */
  claims?: Record<string, unknown>
}

/** A token as Supabase Auth would issue it, signed by the test's key. */
export async function signToken(keys: SigningKeys, options: TokenOptions = {}): Promise<string> {
  const {
    sub = randomUUID(),
    companyId,
    email = "someone@example.test",
    issuer = TEST_ISSUER,
    audience = TOKEN_AUDIENCE,
    expiresAt = "1h",
    kid = keys.kid,
    privateKey = keys.privateKey,
    claims = {},
  } = options
  const appMetadata = options.appMetadata ?? {
    provider: "email",
    providers: ["email"],
    ...(companyId === undefined ? {} : { company_id: companyId }),
  }
  return new SignJWT({ email, role: "authenticated", app_metadata: appMetadata, ...claims })
    .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(privateKey)
}

/** A verifier for an app whose routes under test never present a token. */
export const neverVerifies: Verifier = async () => ({
  ok: false,
  refusal: { reason: "signature", detail: "this test's app verifies no token" },
})
