// The sign-in seam and the configuration reads (Issue #81): the session a
// token response stands for, when a token counts as expired, what Auth's
// refusals are read as, the two calls to the token endpoint under a scripted
// fetch, and what the public variables turn on.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { EXPIRY_MARGIN_MS, isExpired, refreshSession, refusalMessage, sessionOf, signInWithPassword, SignInRefused } from "../auth"
import { apiConfigOf, authConfigOf } from "../config"

const config = { supabaseUrl: "https://project.supabase.co", anonKey: "anon" }
const NOW = 1_800_000_000_000

function scripted(answer: (url: string, init: RequestInit) => Response): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init })
    return answer(String(input), init)
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}

describe("sessionOf", () => {
  test("reads Auth's token body, the expiry from expires_at in seconds or expires_in from now", () => {
    assert.deepEqual(sessionOf({ access_token: "a", refresh_token: "r", expires_at: 1_800_000_003, user: { email: "x@y.example" } }, NOW), {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1_800_000_003_000,
      email: "x@y.example",
    })
    assert.equal(sessionOf({ access_token: "a", refresh_token: "r", expires_in: 3600 }, NOW)?.expiresAt, NOW + 3_600_000)
    assert.equal(sessionOf({ access_token: "a", refresh_token: "r", expires_in: 3600 }, NOW)?.email, null)
  })

  test("refuses what is not a session", () => {
    assert.equal(sessionOf(null), null)
    assert.equal(sessionOf({ access_token: "a" }), null)
    assert.equal(sessionOf({ access_token: "a", refresh_token: "r" }), null)
  })
})

describe("isExpired", () => {
  test("a token is expired within the margin of its deadline, and not before", () => {
    assert.equal(isExpired({ expiresAt: NOW + EXPIRY_MARGIN_MS + 1 }, NOW), false)
    assert.equal(isExpired({ expiresAt: NOW + EXPIRY_MARGIN_MS }, NOW), true)
    assert.equal(isExpired({ expiresAt: NOW - 1 }, NOW), true)
  })
})

describe("refusalMessage", () => {
  test("reads Auth's two error shapes and falls back on the status", () => {
    assert.equal(refusalMessage({ code: 400, msg: "Invalid login credentials" }, 400), "Invalid login credentials")
    assert.equal(refusalMessage({ error: "invalid_grant", error_description: "Invalid Refresh Token" }, 400), "Invalid Refresh Token")
    assert.equal(refusalMessage(null, 400), "The e-mail address or the password is not right")
    assert.equal(refusalMessage("nope", 502), "Sign-in failed (HTTP 502)")
  })
})

describe("the token endpoint", () => {
  test("signInWithPassword posts the credentials under the publishable key and answers the session", async () => {
    const { fetch, calls } = scripted(() => new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, user: { email: "x@y.example" } }), { status: 200 }))
    const session = await signInWithPassword(config, "  x@y.example ", "pw", { fetch, now: () => NOW })
    assert.equal(session.accessToken, "a")
    assert.equal(session.expiresAt, NOW + 3_600_000)
    assert.equal(calls[0].url, "https://project.supabase.co/auth/v1/token?grant_type=password")
    assert.equal(calls[0].init.method, "POST")
    assert.equal((calls[0].init.headers as Record<string, string>).apikey, "anon")
    assert.equal(calls[0].init.body, JSON.stringify({ email: "x@y.example", password: "pw" }))
  })

  test("refreshSession posts the refresh token", async () => {
    const { fetch, calls } = scripted(() => new Response(JSON.stringify({ access_token: "a2", refresh_token: "r2", expires_in: 3600 }), { status: 200 }))
    const session = await refreshSession(config, "r", { fetch, now: () => NOW })
    assert.equal(session.refreshToken, "r2")
    assert.equal(calls[0].url, "https://project.supabase.co/auth/v1/token?grant_type=refresh_token")
    assert.equal(calls[0].init.body, JSON.stringify({ refresh_token: "r" }))
  })

  test("a refusal is thrown in Auth's words with its status; an unreachable provider is status 0", async () => {
    const refusing = scripted(() => new Response(JSON.stringify({ code: 400, msg: "Invalid login credentials" }), { status: 400 }))
    await assert.rejects(
      () => signInWithPassword(config, "x@y.example", "pw", { fetch: refusing.fetch }),
      (error: unknown) => error instanceof SignInRefused && error.status === 400 && error.message === "Invalid login credentials",
    )
    const failing = (async () => {
      throw new TypeError("Failed to fetch")
    }) as typeof fetch
    await assert.rejects(
      () => signInWithPassword(config, "x@y.example", "pw", { fetch: failing }),
      (error: unknown) => error instanceof SignInRefused && error.status === 0 && /did not answer/.test(error.message),
    )
    const empty = scripted(() => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await assert.rejects(
      () => signInWithPassword(config, "x@y.example", "pw", { fetch: empty.fetch }),
      (error: unknown) => error instanceof SignInRefused && /without a session/.test(error.message),
    )
  })
})

describe("the public configuration", () => {
  test("the API is configured by its public URL alone, a trailing slash dropped; unset is off", () => {
    assert.deepEqual(apiConfigOf({ NEXT_PUBLIC_WASTE_API_URL: "http://127.0.0.1:3001/" }), { baseUrl: "http://127.0.0.1:3001" })
    assert.deepEqual(apiConfigOf({ NEXT_PUBLIC_WASTE_API_URL: "/waste-api" }), { baseUrl: "/waste-api" })
    assert.equal(apiConfigOf({ NEXT_PUBLIC_WASTE_API_URL: "  " }), null)
    assert.equal(apiConfigOf({}), null)
  })

  test("password sign-in needs both the project and its key", () => {
    assert.deepEqual(authConfigOf({ NEXT_PUBLIC_SUPABASE_URL: "https://p.supabase.co/", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" }), { supabaseUrl: "https://p.supabase.co", anonKey: "k" })
    assert.equal(authConfigOf({ NEXT_PUBLIC_SUPABASE_URL: "https://p.supabase.co" }), null)
    assert.equal(authConfigOf({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" }), null)
  })
})
