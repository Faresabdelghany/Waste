import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { before, describe, test } from "node:test"

import { createLocalJWKSet, exportJWK, generateKeyPair, generateSecret, SignJWT } from "jose"

import { bearerToken, createVerifier, supabaseAuth, TOKEN_ALGORITHMS, TOKEN_AUDIENCE, type Verified } from "../auth/verify"
import { signingKeys, signToken, TEST_ISSUER, type SigningKeys } from "./tokens"

const refusal = (verified: Verified) => {
  assert.equal(verified.ok, false)
  return verified.ok ? assert.fail("verified") : verified.refusal
}

describe("supabaseAuth", () => {
  test("derives the issuer and the key set's address from the project URL, as Supabase publishes them", () => {
    assert.deepEqual(supabaseAuth("https://ztmisreemxepvjxelbql.supabase.co"), {
      issuer: "https://ztmisreemxepvjxelbql.supabase.co/auth/v1",
      jwks: new URL("https://ztmisreemxepvjxelbql.supabase.co/auth/v1/.well-known/jwks.json"),
    })
    assert.equal(supabaseAuth("http://127.0.0.1:54321").issuer, "http://127.0.0.1:54321/auth/v1")
  })

  test("verifies against the audience Supabase gives a signed-in user, with asymmetric algorithms only", () => {
    assert.equal(TOKEN_AUDIENCE, "authenticated")
    assert.deepEqual(TOKEN_ALGORITHMS, ["ES256", "RS256", "EdDSA"])
  })
})

describe("bearerToken", () => {
  test("reads the one token of a Bearer header, the scheme in any case", () => {
    assert.deepEqual(bearerToken("Bearer abc.def.ghi"), { kind: "token", token: "abc.def.ghi" })
    assert.deepEqual(bearerToken("bearer abc.def.ghi"), { kind: "token", token: "abc.def.ghi" })
    assert.deepEqual(bearerToken("BEARER  abc.def.ghi"), { kind: "token", token: "abc.def.ghi" }, "more than one space is still one token")
  })

  test("says when there is no header at all", () => {
    assert.deepEqual(bearerToken(undefined), { kind: "absent" })
    assert.deepEqual(bearerToken(""), { kind: "absent" })
  })

  test("refuses another scheme, a Bearer with no token, two tokens, and characters a token cannot carry", () => {
    for (const header of ["Basic dXNlcjpwYXNz", "Bearer", "Bearer ", "Bearer one two", "Bearer abc,def", "Token abc", "abc.def.ghi", "Bearer abc def ghi"]) {
      const parsed = bearerToken(header)
      assert.equal(parsed.kind, "malformed", header)
      if (parsed.kind === "malformed") assert.ok(parsed.detail.length > 0, header)
    }
  })
})

describe("createVerifier", () => {
  let keys: SigningKeys
  let other: SigningKeys
  before(async () => {
    keys = await signingKeys("kid-one")
    other = await signingKeys("kid-two")
  })

  test("accepts a token signed by the published key for this issuer and audience, and hands back its claims", async () => {
    const sub = randomUUID()
    const companyId = randomUUID()
    const verified = await keys.verifier(await signToken(keys, { sub, companyId, email: "olivia@example.test" }))
    assert.equal(verified.ok, true)
    if (!verified.ok) return
    assert.equal(verified.claims.sub, sub)
    assert.equal(verified.claims.iss, TEST_ISSUER)
    assert.equal(verified.claims.aud, TOKEN_AUDIENCE)
    assert.equal(verified.claims.email, "olivia@example.test")
    assert.deepEqual(verified.claims.app_metadata, { provider: "email", providers: ["email"], company_id: companyId })
  })

  test("refuses a signature by another key under the published kid", async () => {
    const forged = await signToken(keys, { privateKey: other.privateKey })
    assert.equal(refusal(await keys.verifier(forged)).reason, "signature")
  })

  test("refuses a kid the key set does not publish", async () => {
    const unknown = await signToken(keys, { kid: "kid-nobody" })
    assert.equal(refusal(await keys.verifier(unknown)).reason, "unknown-key")
  })

  test("refuses another issuer: a token from another project, however well signed", async () => {
    const elsewhere = await signToken(keys, { issuer: "https://another-project.supabase.co/auth/v1" })
    assert.equal(refusal(await keys.verifier(elsewhere)).reason, "issuer")
    const trailing = await signToken(keys, { issuer: `${TEST_ISSUER}/` })
    assert.equal(refusal(await keys.verifier(trailing)).reason, "issuer", "the issuer is compared as a string, slash included")
  })

  test("refuses another audience: an anon token is not a signed-in user", async () => {
    const anon = await signToken(keys, { audience: "anon" })
    assert.equal(refusal(await keys.verifier(anon)).reason, "audience")
  })

  test("refuses an expired token", async () => {
    const expired = await signToken(keys, { expiresAt: Math.floor(Date.now() / 1000) - 60 })
    assert.equal(refusal(await keys.verifier(expired)).reason, "expired")
  })

  test("refuses a token signed with a shared secret (HS256), whatever the secret", async () => {
    const secret = await generateSecret("HS256", { extractable: true })
    const symmetric = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256", kid: keys.kid })
      .setSubject(randomUUID())
      .setIssuer(TEST_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setExpirationTime("1h")
      .sign(secret)
    assert.equal(refusal(await keys.verifier(symmetric)).reason, "algorithm")
  })

  test("refuses an unsigned token (alg none) as an algorithm this API does not accept", async () => {
    const unsigned = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0."
    assert.equal(refusal(await keys.verifier(unsigned)).reason, "algorithm")
  })

  test("refuses anything that is not a compact JWS as malformed", async () => {
    for (const token of ["abc", "abc.def", "abc.def.ghi", "a.b.c.d"]) {
      assert.equal(refusal(await keys.verifier(token)).reason, "malformed", token)
    }
  })

  test("refuses a token that names no subject: there is no one to look up", async () => {
    const anonymous = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid: keys.kid })
      .setIssuer(TEST_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setExpirationTime("1h")
      .sign(keys.privateKey)
    assert.equal(refusal(await keys.verifier(anonymous)).reason, "no-subject")
  })

  test("a refusal explains itself in a sentence and never repeats the token", async () => {
    const token = await signToken(keys, { audience: "anon" })
    const { detail } = refusal(await keys.verifier(token))
    assert.ok(detail.length > 0)
    assert.equal(detail.includes(token), false)
    assert.equal(detail.includes(token.split(".")[2]), false, "not the signature either")
  })

  test("accepts RS256 and EdDSA keys too, since a project may rotate to one", async () => {
    for (const alg of ["RS256", "EdDSA"] as const) {
      const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true })
      const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: alg, alg, use: "sig" }] }
      const verifier = createVerifier({ keySet: createLocalJWKSet(jwks), issuer: TEST_ISSUER })
      const token = await new SignJWT({ role: "authenticated" })
        .setProtectedHeader({ alg, kid: alg })
        .setSubject(randomUUID())
        .setIssuer(TEST_ISSUER)
        .setAudience(TOKEN_AUDIENCE)
        .setExpirationTime("1h")
        .sign(privateKey)
      assert.equal((await verifier(token)).ok, true, alg)
    }
  })

  test("lets a failure of the key set itself through as an error, since that is the server's problem and not the token's", async () => {
    const broken = createVerifier({
      keySet: () => {
        throw new TypeError("fetch failed")
      },
      issuer: TEST_ISSUER,
    })
    await assert.rejects(broken(await signToken(keys)), /fetch failed/)
  })
})
