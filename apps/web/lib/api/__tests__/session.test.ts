// The API session (Issue #150), against one scripted `fetch` that answers for
// Auth and the API alike: the landing `/me` decides after sign-in, the
// session-ending rule — the account's problem type ends the session, a
// permission refusal does not, a refresh Auth refuses does — a sign-out that
// drops the session whatever Auth answers, and a password change that keeps
// the session it ran under.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { NO_ACTIVE_ACCOUNT } from "@waste/contracts/problem"

import { PasswordChangeRefused, type ApiSession } from "../auth"
import { get } from "../client"
import { landingOf } from "../landing"
import { ApiProblem, NO_ACTIVE_ACCOUNT_PROBLEM_TYPE, PROBLEM_MEDIA_TYPE } from "../problem"
import { createApiSession } from "../session"

type Call = { url: string; init: RequestInit }

/** A `fetch` that answers from a script, in order, and records what it was asked. */
function scripted(answers: Array<(call: Call) => Response | Promise<Response>>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init }
    calls.push(call)
    const answer = answers.shift()
    if (!answer) throw new Error(`unexpected call to ${call.url}`)
    return answer(call)
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}

const API = { baseUrl: "http://api.test" }
const AUTH = { supabaseUrl: "https://project.supabase.co", anonKey: "anon" }
const NOW = 1_800_000_000_000
const EMAIL = "mads.jensen@kystbyen.example"
const DRIVER_ID = "01a0d2a4-a280-7019-8000-000000000001"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const tokens = (accessToken: string, userId = "auth-mads") => json({ access_token: accessToken, refresh_token: `refresh-${accessToken}`, expires_in: 3600, user: { id: userId, email: EMAIL } })
const refused = (type: string, title: string, status: number, detail: string) =>
  new Response(JSON.stringify({ type, title, status, detail }), { status, headers: { "content-type": PROBLEM_MEDIA_TYPE } })
const accountRefused = (detail: string) => refused(NO_ACTIVE_ACCOUNT.type, NO_ACTIVE_ACCOUNT.title, 403, detail)
const me = (driver: { id: string } | null) =>
  json({
    user: { id: "01a0d2a4-a280-7005-8000-000000000003", email: EMAIL, fullName: "Mads Jensen", status: "active", allProjects: false, primaryAdministrator: false },
    company: { id: "01a0d2a4-a280-7001-8000-000000000001", name: "Kystbyen Renovation" },
    role: { id: "01a0d2a4-a280-7004-8000-000000000009", key: "driver", name: "Driver", scope: "Assigned projects", system: true, grants: [] },
    projects: [{ id: "01a0d2a4-a280-7002-8000-000000000001", name: "Copenhagen Central" }],
    serviceProvider: null,
    driver,
  })

/** A session signed in as Mads through the script's first answer, the rest of the script after it. */
async function signedIn(answers: Array<(call: Call) => Response | Promise<Response>>) {
  const script = scripted([() => tokens("a1"), ...answers])
  const session = createApiSession({ api: API, auth: AUTH, fetch: script.fetch, now: () => NOW })
  session.hydrate(null)
  await session.signIn(EMAIL, "the temporary one")
  return { session, calls: script.calls }
}

const stored = (overrides: Partial<ApiSession>): ApiSession => ({ accessToken: "a0", refreshToken: "r0", expiresAt: NOW + 3_600_000, email: EMAIL, userId: "auth-mads", ...overrides })

describe("the landing, by /me after sign-in", () => {
  test("a driver lands on the driver's app: /me names the active driver profile bound to the account", async () => {
    const { session, calls } = await signedIn([() => me({ id: DRIVER_ID })])
    assert.equal(landingOf(await session.loadMe()), "/driver")
    assert.equal(calls[1].url, "http://api.test/me")
    assert.equal((calls[1].init.headers as Record<string, string>).authorization, "Bearer a1")
  })

  test("an account no active profile is bound to lands on operations, and /me is kept for the sidebar", async () => {
    const { session } = await signedIn([() => me(null)])
    const read = await session.loadMe()
    assert.equal(landingOf(read), "/operate")
    assert.equal(session.store.getSnapshot().me?.user.fullName, "Mads Jensen")
  })
})

describe("the session-ending rule", () => {
  test("an account refusal from any call ends the session and keeps the API's sentence for /login", async () => {
    const { session } = await signedIn([() => accountRefused("No active account in this company is bound to this login")])
    const client = session.client()
    assert.ok(client)
    await assert.rejects(() => get(client, "/projects"), (error: unknown) => error instanceof ApiProblem && error.status === 403)
    const state = session.store.getSnapshot()
    assert.equal(state.session, null)
    assert.deepEqual(state.ended, { reason: "refused", detail: "No active account in this company is bound to this login" })
    assert.equal(session.client(), null, "nothing calls the API as the refused account again")
  })

  test("the same refusal from /me ends it, and the next sign-in clears why the last session ended", async () => {
    const { session } = await signedIn([() => accountRefused("The token names no company: this login has no account here"), () => tokens("a2")])
    await assert.rejects(() => session.loadMe())
    assert.deepEqual(session.store.getSnapshot().ended, { reason: "refused", detail: "The token names no company: this login has no account here" })
    await session.signIn(EMAIL, "again")
    assert.equal(session.store.getSnapshot().ended, null)
    assert.equal(session.store.getSnapshot().session?.accessToken, "a2")
  })

  test("a permission refusal, a 403 of about:blank, leaves the session alive", async () => {
    const { session } = await signedIn([() => refused("about:blank", "Forbidden", 403, "This account's role does not allow edit on configure.access")])
    const client = session.client()
    assert.ok(client)
    await assert.rejects(() => get(client, "/users"), (error: unknown) => error instanceof ApiProblem && error.problem.type === "about:blank")
    const state = session.store.getSnapshot()
    assert.equal(state.session?.accessToken, "a1")
    assert.equal(state.ended, null)
    assert.notEqual(session.client(), null)
  })

  test("a refresh Auth refuses ends the session in Auth's words", async () => {
    const script = scripted([() => json({ code: 403, error_code: "unexpected_failure", msg: "This account is deactivated" }, 403)])
    const session = createApiSession({ api: API, auth: AUTH, fetch: script.fetch, now: () => NOW })
    session.hydrate(stored({ expiresAt: NOW + 30_000 }))
    await session.refreshIfDue()
    assert.equal(script.calls[0].url, "https://project.supabase.co/auth/v1/token?grant_type=refresh_token")
    const state = session.store.getSnapshot()
    assert.equal(state.session, null)
    assert.deepEqual(state.ended, { reason: "refused", detail: "This account is deactivated" })
  })

  test("a refresh the network lost keeps the session and is tried again; a token not yet due is left alone", async () => {
    const script = scripted([
      () => {
        throw new TypeError("Failed to fetch")
      },
      () => tokens("a2"),
    ])
    const session = createApiSession({ api: API, auth: AUTH, fetch: script.fetch, now: () => NOW })
    session.hydrate(stored({ expiresAt: NOW + 30_000 }))
    await session.refreshIfDue()
    assert.equal(session.store.getSnapshot().session?.accessToken, "a0")
    assert.equal(session.store.getSnapshot().ended, null)
    await session.refreshIfDue()
    assert.equal(session.store.getSnapshot().session?.accessToken, "a2")
    await session.refreshIfDue()
    assert.equal(script.calls.length, 2, "the fresh token is an hour from expiry")
  })

  test("a session nobody can refresh — a tab that did not sign in itself — ends as expired once its token runs out", async () => {
    const session = createApiSession({ api: API, auth: AUTH, fetch: scripted([]).fetch, now: () => NOW })
    session.hydrate(stored({ refreshToken: null, expiresAt: NOW - 1 }))
    await session.refreshIfDue()
    assert.deepEqual(session.store.getSnapshot(), { session: null, hydrated: true, ended: { reason: "expired" }, me: null })
  })

  test("a refusal that arrives for a session already over does not end the one signed in since", async () => {
    const { session } = await signedIn([() => new Response(null, { status: 204 }), () => tokens("b1", "auth-lars"), () => accountRefused("No active account in this company is bound to this login")])
    const stale = session.client()
    assert.ok(stale)
    await session.signOut()
    await session.signIn("lars.mikkelsen@nordren.example", "his own")
    await assert.rejects(() => get(stale, "/projects"))
    assert.equal(session.store.getSnapshot().session?.accessToken, "b1")
    assert.equal(session.store.getSnapshot().ended, null)
  })
})

describe("signing out", () => {
  test("drops the session at once and revokes it at Auth under its own token", async () => {
    const { session, calls } = await signedIn([() => new Response(null, { status: 204 })])
    const pending = session.signOut()
    assert.equal(session.store.getSnapshot().session, null, "dropped before Auth has answered")
    await pending
    assert.equal(calls[1].url, "https://project.supabase.co/auth/v1/logout?scope=local")
    assert.equal((calls[1].init.headers as Record<string, string>).authorization, "Bearer a1")
    assert.deepEqual(session.store.getSnapshot().ended, { reason: "signed-out" })
  })

  test("a revocation Auth refuses, or never answers, drops the session all the same", async () => {
    const refusing = await signedIn([() => json({ code: 401, msg: "invalid JWT: unable to parse or verify signature" }, 401)])
    await refusing.session.signOut()
    assert.equal(refusing.session.store.getSnapshot().session, null)
    const lost = await signedIn([
      () => {
        throw new TypeError("Failed to fetch")
      },
    ])
    await lost.session.signOut()
    assert.equal(lost.session.store.getSnapshot().session, null)
    assert.deepEqual(lost.session.store.getSnapshot().ended, { reason: "signed-out" })
  })
})

describe("changing the password", () => {
  test("verifies the current password, sets the new one, and keeps the fresh session it ran under for the same person", async () => {
    const { session, calls } = await signedIn([() => tokens("fresh"), () => json({ id: "auth-mads", email: EMAIL })])
    await session.updatePassword("the temporary one", "a password of my own")
    assert.deepEqual(
      calls.slice(1).map((call) => `${call.init.method} ${call.url}`),
      ["POST https://project.supabase.co/auth/v1/token?grant_type=password", "PUT https://project.supabase.co/auth/v1/user"],
    )
    assert.equal(calls[1].init.body, JSON.stringify({ email: EMAIL, password: "the temporary one" }))
    const state = session.store.getSnapshot()
    assert.equal(state.session?.accessToken, "fresh")
    assert.equal(state.session?.userId, "auth-mads")
  })

  test("a refused change leaves the session as it was", async () => {
    const { session } = await signedIn([() => json({ code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }, 400)])
    await assert.rejects(() => session.updatePassword("not it", "a password of my own"), PasswordChangeRefused)
    assert.equal(session.store.getSnapshot().session?.accessToken, "a1")
  })
})

describe("the account's problem type", () => {
  test("is the contracts' own, re-spelled so no zod reaches the bundle and held equal so the two cannot drift", () => {
    assert.equal(NO_ACTIVE_ACCOUNT_PROBLEM_TYPE, NO_ACTIVE_ACCOUNT.type)
  })
})
