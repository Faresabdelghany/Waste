import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { NO_ACTIVE_ACCOUNT } from "@waste/contracts/problem"
import { createDb } from "@waste/db/client"
import { generateSecret, SignJWT } from "jose"

import { createApp } from "../app"
import { TOKEN_AUDIENCE } from "../auth/verify"
import { readProblem } from "./read-problem"
import { signingKeys, signToken, TEST_ISSUER, type SigningKeys } from "./tokens"
import { REFUSED_URL } from "./unreachable"

// Every request here is refused before the database is asked anything, so the
// pools go nowhere: a dial would fail the test, which is the point.
const idle = createDb(REFUSED_URL, { max: 1 })
after(() => idle.close())

let keys: SigningKeys
let app: ReturnType<typeof createApp>
before(async () => {
  keys = await signingKeys()
  app = createApp({ probe: idle, pool: idle, verifier: keys.verifier })
})

const me = (headers: Record<string, string> = {}) => app.request("/me", { headers })
const withToken = (token: string) => me({ authorization: `Bearer ${token}` })

describe("GET /me without a usable token", () => {
  test("answers 401 with a challenge and a problem body when there is no Authorization header", async () => {
    const response = await me()
    assert.equal(response.status, 401)
    assert.equal(response.headers.get("www-authenticate"), "Bearer")
    const body = await readProblem(response)
    assert.equal(body.title, "Unauthorized")
    assert.match(body.detail ?? "", /Authorization: Bearer/)
  })

  test("answers 401 invalid_request when the header is not one Bearer token", async () => {
    for (const authorization of ["Basic dXNlcjpwYXNz", "Bearer", "Bearer one two", "Token abc"]) {
      const response = await me({ authorization })
      assert.equal(response.status, 401, authorization)
      assert.equal(response.headers.get("www-authenticate"), 'Bearer error="invalid_request"', authorization)
      await readProblem(response)
    }
  })

  test("answers 401 invalid_token for a bad signature, a wrong issuer, a wrong audience, an expired token, an HS256 token and an unknown kid", async () => {
    const other = await signingKeys()
    const secret = await generateSecret("HS256", { extractable: true })
    const symmetric = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256", kid: keys.kid })
      .setSubject(randomUUID())
      .setIssuer(TEST_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setExpirationTime("1h")
      .sign(secret)
    const refused: Record<string, string> = {
      "bad signature": await signToken(keys, { privateKey: other.privateKey }),
      "wrong issuer": await signToken(keys, { issuer: "https://another.supabase.co/auth/v1" }),
      "wrong audience": await signToken(keys, { audience: "anon" }),
      expired: await signToken(keys, { expiresAt: Math.floor(Date.now() / 1000) - 60 }),
      HS256: symmetric,
      "unknown kid": await signToken(keys, { kid: "rotated-away" }),
      "not a token": "abc.def.ghi",
    }
    for (const [name, token] of Object.entries(refused)) {
      const response = await withToken(token)
      assert.equal(response.status, 401, name)
      assert.equal(response.headers.get("www-authenticate"), 'Bearer error="invalid_token"', name)
      const body = await readProblem(response)
      assert.equal(body.title, "Unauthorized", name)
      assert.equal((body.detail ?? "").includes(token), false, `${name}: the token is not echoed`)
    }
  })
})

describe("GET /me with a good token that names no company", () => {
  test("answers 403 with a problem body of the account's kind when app_metadata carries no company_id: this login has no account", async () => {
    const response = await withToken(await signToken(keys))
    assert.equal(response.status, 403)
    assert.equal(response.headers.get("www-authenticate"), null)
    const body = await readProblem(response, NO_ACTIVE_ACCOUNT)
    assert.match(body.detail ?? "", /company/)
  })

  test("answers 403 when the claim is not a UUID, and when app_metadata is missing or not an object", async () => {
    for (const appMetadata of [{ company_id: 42 }, { company_id: "not-a-uuid" }, { company_id: null }, {}, undefined]) {
      const token =
        appMetadata === undefined
          ? await signToken(keys, { claims: { app_metadata: "text" } })
          : await signToken(keys, { appMetadata })
      const response = await withToken(token)
      assert.equal(response.status, 403, JSON.stringify(appMetadata))
      await readProblem(response, NO_ACTIVE_ACCOUNT)
    }
  })
})

describe("the probes and the document", () => {
  test("need no token", async () => {
    assert.equal((await app.request("/healthz")).status, 200)
    assert.equal((await app.request("/openapi.json")).status, 200)
    assert.equal((await app.request("/readyz")).status, 503, "the probe pool goes nowhere; the point is that it is not 401")
  })

  test("ignore a token that is offered anyway", async () => {
    const response = await app.request("/healthz", { headers: { authorization: "Bearer not.a.token" } })
    assert.equal(response.status, 200)
  })
})
