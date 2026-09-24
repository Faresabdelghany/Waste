// Is this token one of ours? Supabase Auth signs a signed-in user's access
// token with the project's asymmetric key (ES256 on the hosted project) and
// publishes the public half at `/auth/v1/.well-known/jwks.json`, so the API
// verifies a token against that key set and never holds a shared secret
// (Issue #70; the Supabase facts paragraph). Three things make a token ours:
// a signature by a published key, the project's issuer, and the audience Auth
// gives a signed-in user, `authenticated`; an expired one is refused like any
// other. Only asymmetric algorithms are accepted, so a token signed with a
// leaked or guessed shared secret is refused before any key is looked up.
//
// jose does the verifying: its remote key set caches the JWKS, refetches on a
// `kid` it has not seen and rate-limits that refetch, which is what Supabase's
// edge cache and rotation guidance need (Hono's own jwk middleware refetches
// per request). The key set is handed in, not built here: server.ts builds
// the remote one from SUPABASE_URL, and a test builds a local one over a key
// pair it generated, so no test ever fetches anything and this module never
// reads the environment.
//
// The outcome is a value, not an exception: verified claims, or a refusal
// with a reason and a sentence for the problem body. A failure of the key set
// itself (the JWKS cannot be fetched or is not a JWKS) is not a refusal, since
// it says nothing about the token, and is thrown for the error handler to log
// as the server's own 500.
import { errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose"

/** The audience Supabase Auth puts on a signed-in user's token; `anon` and service tokens carry another. */
export const TOKEN_AUDIENCE = "authenticated"

/** Asymmetric only: a token signed with a shared secret is never ours. */
export const TOKEN_ALGORITHMS = ["ES256", "RS256", "EdDSA"] as const

export type SupabaseAuth = {
  /** The `iss` claim a token must carry. */
  issuer: string
  /** Where the project publishes its signing keys. */
  jwks: URL
}

/** The issuer and key set of a Supabase project, from its origin (SUPABASE_URL, env.ts). */
export function supabaseAuth(supabaseUrl: string): SupabaseAuth {
  return {
    issuer: `${supabaseUrl}/auth/v1`,
    jwks: new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`),
  }
}

/** The payload of a verified token, with the subject it must have. */
export type VerifiedClaims = JWTPayload & { sub: string }

export type RefusalReason =
  /** Not a signed JWT at all. */
  | "malformed"
  /** A published key, but the signature does not verify under it. */
  | "signature"
  /** The header names a key the issuer does not publish (rotated away, or never ours). */
  | "unknown-key"
  /** Signed with an algorithm this API does not accept: a shared secret, or none. */
  | "algorithm"
  | "issuer"
  | "audience"
  | "expired"
  /** Another claim jose validates (`nbf`, `iat`) did not hold. */
  | "claims"
  /** Verified, but names no subject to look up. */
  | "no-subject"

export type TokenRefusal = {
  reason: RefusalReason
  /** One sentence for the problem body; never the token itself. */
  detail: string
}

export type Verified = { ok: true; claims: VerifiedClaims } | { ok: false; refusal: TokenRefusal }

/** What createApp is handed: a token in, its verified claims or a typed refusal out. */
export type Verifier = (token: string) => Promise<Verified>

export type VerifierOptions = {
  /** `createRemoteJWKSet(supabaseAuth(url).jwks)` in the process, `createLocalJWKSet(jwks)` in a test. */
  keySet: JWTVerifyGetKey
  issuer: string
}

export function createVerifier({ keySet, issuer }: VerifierOptions): Verifier {
  return async (token) => {
    let payload: JWTPayload
    try {
      ;({ payload } = await jwtVerify(token, keySet, { issuer, audience: TOKEN_AUDIENCE, algorithms: [...TOKEN_ALGORITHMS] }))
    } catch (error) {
      const refusal = refusalOf(error)
      if (refusal === undefined) throw error
      return { ok: false, refusal }
    }
    if (typeof payload.sub !== "string" || payload.sub === "") {
      return { ok: false, refusal: { reason: "no-subject", detail: "The token names no subject" } }
    }
    return { ok: true, claims: { ...payload, sub: payload.sub } }
  }
}

/** What jose threw, as a refusal; undefined when it was not the token's fault. */
function refusalOf(error: unknown): TokenRefusal | undefined {
  if (error instanceof errors.JWTExpired) {
    return { reason: "expired", detail: "The token has expired" }
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "iss") return { reason: "issuer", detail: "The token was issued by another party" }
    if (error.claim === "aud") return { reason: "audience", detail: "The token is not a signed-in user's" }
    return { reason: "claims", detail: `The token's ${error.claim} claim does not hold` }
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) {
    return { reason: "signature", detail: "The token's signature does not verify" }
  }
  if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) {
    return { reason: "unknown-key", detail: "The token names a signing key the issuer does not publish" }
  }
  if (error instanceof errors.JOSEAlgNotAllowed || error instanceof errors.JOSENotSupported) {
    return { reason: "algorithm", detail: "The token is signed with an algorithm this API does not accept" }
  }
  if (error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid) {
    return { reason: "malformed", detail: "The token is not a signed JWT" }
  }
  // JWKSTimeout, JWKSInvalid, a failed fetch: the key set could not be read.
  return undefined
}

/** What an Authorization header carried: nothing, one bearer token, or something else. */
export type BearerHeader = { kind: "absent" } | { kind: "malformed"; detail: string } | { kind: "token"; token: string }

/** RFC 6750 §2.1: the scheme, whitespace, one token68. */
const BEARER = /^Bearer[ \t]+(.+)$/i
const TOKEN68 = /^[A-Za-z0-9\-._~+/]+=*$/

/** Reads the one token of `Authorization: Bearer <token>`; the scheme in any case, as RFC 9110 has it. */
export function bearerToken(header: string | undefined): BearerHeader {
  if (header === undefined || header.trim() === "") return { kind: "absent" }
  const match = BEARER.exec(header.trim())
  if (!match) return { kind: "malformed", detail: "The Authorization header must be `Bearer <access token>`" }
  const token = match[1]
  if (!TOKEN68.test(token)) return { kind: "malformed", detail: "The Authorization header must carry exactly one bearer token" }
  return { kind: "token", token }
}
