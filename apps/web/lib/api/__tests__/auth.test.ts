// The sign-in seam and the configuration reads (Issue #81): the session a
// token response stands for, when a token counts as expired, what Auth's
// refusals are read as, the two calls to the token endpoint under a scripted
// fetch, and what the public variables turn on.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  EXPIRY_MARGIN_MS,
  isExpired,
  PasswordChangeRefused,
  refreshSession,
  refusalMessage,
  sessionOf,
  signInWithPassword,
  SignInRefused,
  signOut,
  updatePassword,
} from "../auth"
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
  test("reads Auth's token body, the expiry from expires_at in seconds or expires_in from now, and whose session it is", () => {
    assert.deepEqual(sessionOf({ access_token: "a", refresh_token: "r", expires_at: 1_800_000_003, user: { id: "u-1", email: "x@y.example" } }, NOW), {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1_800_000_003_000,
      email: "x@y.example",
      userId: "u-1",
    })
    assert.equal(sessionOf({ access_token: "a", refresh_token: "r", expires_in: 3600 }, NOW)?.expiresAt, NOW + 3_600_000)
    assert.equal(sessionOf({ access_token: "a", refresh_token: "r", expires_in: 3600 }, NOW)?.email, null)
    assert.equal(sessionOf({ access_token: "a", refresh_token: "r", expires_in: 3600 }, NOW)?.userId, null)
  })

  test("counts the expiry on this device's clock when Auth says how long the token lasts, so a clock that is off does not expire it at birth", () => {
    // Auth sends both; its `expires_at` is its own clock's, here an hour behind this device's.
    const authNow = NOW - 3_600_000
    const body = { access_token: "a", refresh_token: "r", expires_in: 3600, expires_at: authNow / 1000 + 3600, user: { id: "u-1" } }
    assert.equal(sessionOf(body, NOW)?.expiresAt, NOW + 3_600_000)
    assert.equal(isExpired({ expiresAt: sessionOf(body, NOW)?.expiresAt ?? 0 }, NOW), false)
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

describe("updatePassword (Issue #150)", () => {
  const FRESH = { access_token: "fresh", refresh_token: "r2", expires_in: 3600, user: { id: "u-1", email: "x@y.example" } }
  const answering = (token: () => Response, user: () => Response) => scripted((url) => (url.includes("/auth/v1/token") ? token() : user()))
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  test("verifies the current password by signing in with it, then sets the new one under that fresh session, which it answers", async () => {
    const { fetch, calls } = answering(() => json(FRESH), () => json({ id: "u-1", email: "x@y.example" }))
    const session = await updatePassword(config, "x@y.example", "the old one", "a new one of twelve", { fetch, now: () => NOW })
    assert.deepEqual(
      calls.map((call) => `${call.init.method} ${call.url}`),
      ["POST https://project.supabase.co/auth/v1/token?grant_type=password", "PUT https://project.supabase.co/auth/v1/user"],
    )
    assert.equal(calls[0].init.body, JSON.stringify({ email: "x@y.example", password: "the old one" }))
    const headers = calls[1].init.headers as Record<string, string>
    assert.equal(headers.authorization, "Bearer fresh")
    assert.equal(headers.apikey, "anon")
    assert.equal(calls[1].init.body, JSON.stringify({ password: "a new one of twelve" }))
    assert.deepEqual(session, { accessToken: "fresh", refreshToken: "r2", expiresAt: NOW + 3_600_000, email: "x@y.example", userId: "u-1" })
  })

  test("a current password Auth refuses stops it before the update, and says which password was wrong", async () => {
    const { fetch, calls } = answering(() => json({ code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }, 400), () => json({}))
    await assert.rejects(
      () => updatePassword(config, "x@y.example", "not it", "a new one of twelve", { fetch }),
      (error: unknown) => error instanceof PasswordChangeRefused && error.status === 400 && error.message === "The current password is not right",
    )
    assert.equal(calls.length, 1, "no update was sent")
  })

  test("a new password Auth refuses is refused in Auth's words; a lost network at either step is status 0", async () => {
    const weak = answering(() => json(FRESH), () => json({ code: 422, error_code: "weak_password", msg: "Password should be at least 12 characters." }, 422))
    await assert.rejects(
      () => updatePassword(config, "x@y.example", "the old one", "short", { fetch: weak.fetch }),
      (error: unknown) => error instanceof PasswordChangeRefused && error.status === 422 && error.message === "Password should be at least 12 characters.",
    )
    const lost = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/auth/v1/token")) return json(FRESH)
      throw new TypeError("Failed to fetch")
    }) as typeof fetch
    await assert.rejects(
      () => updatePassword(config, "x@y.example", "the old one", "a new one of twelve", { fetch: lost }),
      (error: unknown) => error instanceof PasswordChangeRefused && error.status === 0 && /did not answer/.test(error.message),
    )
  })
})

describe("updatePassword when the update does not go through", () => {
  const FRESH = { access_token: "fresh", refresh_token: "r2", expires_in: 3600, user: { id: "u-1", email: "x@y.example" } }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  test("a new password Auth refuses revokes the session the verification opened, which nobody would hold", async () => {
    const { fetch, calls } = scripted((url) =>
      url.includes("/auth/v1/token") ? json(FRESH) : url.includes("/auth/v1/logout") ? new Response(null, { status: 204 }) : json({ code: 422, error_code: "same_password", msg: "New password should be different from the old password." }, 422),
    )
    await assert.rejects(
      () => updatePassword(config, "x@y.example", "the old one", "the old one", { fetch }),
      (error: unknown) => error instanceof PasswordChangeRefused && error.status === 422 && error.session === null,
    )
    assert.deepEqual(
      calls.map((call) => `${call.init.method} ${call.url}`),
      [
        "POST https://project.supabase.co/auth/v1/token?grant_type=password",
        "PUT https://project.supabase.co/auth/v1/user",
        "POST https://project.supabase.co/auth/v1/logout?scope=local",
      ],
    )
    assert.equal((calls[2].init.headers as Record<string, string>).authorization, "Bearer fresh")
  })

  test("an update Auth did not answer, or failed at, may have gone through: the verification's session is handed back to keep", async () => {
    const lost = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/auth/v1/token")) return json(FRESH)
      throw new TypeError("Failed to fetch")
    }) as typeof fetch
    await assert.rejects(
      () => updatePassword(config, "x@y.example", "the old one", "a new one of twelve", { fetch: lost }),
      (error: unknown) => error instanceof PasswordChangeRefused && error.status === 0 && error.session?.accessToken === "fresh",
    )
    const failing = scripted((url) => (url.includes("/auth/v1/token") ? json(FRESH) : json({ code: 503, msg: "Service Unavailable" }, 503)))
    await assert.rejects(
      () => updatePassword(config, "x@y.example", "the old one", "a new one of twelve", { fetch: failing.fetch }),
      (error: unknown) => error instanceof PasswordChangeRefused && error.status === 503 && error.session?.accessToken === "fresh",
    )
    assert.equal(failing.calls.length, 2, "nothing is revoked: the change may stand")
  })
})

describe("signOut (Issue #150)", () => {
  test("revokes this browser's session at Auth, under its own token and the publishable key", async () => {
    const { fetch, calls } = scripted(() => new Response(null, { status: 204 }))
    await signOut(config, "t0k3n", { fetch })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://project.supabase.co/auth/v1/logout?scope=local")
    assert.equal(calls[0].init.method, "POST")
    const headers = calls[0].init.headers as Record<string, string>
    assert.equal(headers.authorization, "Bearer t0k3n")
    assert.equal(headers.apikey, "anon")
  })

  test("is best-effort: a refusal and a lost network settle as a success does, and nothing is thrown", async () => {
    const refusing = scripted(() => new Response(JSON.stringify({ msg: "invalid JWT" }), { status: 401 }))
    await signOut(config, "expired", { fetch: refusing.fetch })
    const failing = (async () => {
      throw new TypeError("Failed to fetch")
    }) as typeof fetch
    await signOut(config, "t0k3n", { fetch: failing })
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
