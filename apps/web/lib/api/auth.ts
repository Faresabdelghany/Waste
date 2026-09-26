// Signing in, as the web does it (Issue #81): Supabase Auth's token endpoint,
// spoken directly. The API verifies a Supabase access token (ADR-0001; the
// hook puts the home company into it), so the web needs one, and the two
// calls that get and keep one are small enough that a client library would
// weigh more than it carries into the bundle:
//
//   POST {supabaseUrl}/auth/v1/token?grant_type=password       { email, password }
//   POST {supabaseUrl}/auth/v1/token?grant_type=refresh_token  { refresh_token }
//
// both under the project's publishable key as `apikey`, both answering the
// same session body: the access token, when it expires, and the refresh token
// that gets the next one. Sign-up is not here: it is invitation-only
// (supabase/config.toml), so an account is made by an administrator and the
// person confirms the address the invitation went to.
//
// The functions take `fetch` from the environment (a test hands its own) and
// know nothing of the browser or of storage: session-store.tsx keeps the
// session and decides when to refresh.
import type { AuthConfig } from "./config"

export type ApiSession = {
  accessToken: string
  /**
   * What gets the next access token; null in a tab that did not sign in
   * itself — the refresh token is kept tab-scoped (api-session-store.tsx),
   * so such a tab has the access token's remaining life and then signs in.
   */
  refreshToken: string | null
  /** The instant the access token stops being accepted, in epoch milliseconds. */
  expiresAt: number
  /** Whose session this is, as Auth spelled it; shown, never trusted for anything else. */
  email: string | null
  /** Auth's id for the account (`user.id`), the same across every refresh: what a consumer keys on to know the person has not changed. */
  userId: string | null
}

/** A sign-in the identity provider refused, in its own words. */
export class SignInRefused extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "SignInRefused"
    this.status = status
  }
}

/**
 * How long before its expiry a token is treated as expired, so a request sent
 * a moment before the deadline does not arrive after it. One minute.
 */
export const EXPIRY_MARGIN_MS = 60_000

/** Whether the session's token has expired, or will within the margin. */
export function isExpired(session: Pick<ApiSession, "expiresAt">, now = Date.now()): boolean {
  return session.expiresAt - EXPIRY_MARGIN_MS <= now
}

type TokenResponse = {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  expires_at?: unknown
  user?: { id?: unknown; email?: unknown } | null
}

/** The session a token response stands for, or null when the body is not one. */
export function sessionOf(body: unknown, now = Date.now()): ApiSession | null {
  if (typeof body !== "object" || body === null) return null
  const token = body as TokenResponse
  if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string") return null
  // `expires_at` is epoch seconds when Auth sends it; `expires_in` seconds from now otherwise.
  const expiresAt =
    typeof token.expires_at === "number"
      ? token.expires_at * 1000
      : typeof token.expires_in === "number"
        ? now + token.expires_in * 1000
        : null
  if (expiresAt === null) return null
  const email = token.user && typeof token.user.email === "string" ? token.user.email : null
  const userId = token.user && typeof token.user.id === "string" ? token.user.id : null
  return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt, email, userId }
}

/**
 * The sentence an Auth refusal carries. Auth has spelled its errors two ways
 * over time — `{ msg }` with a `code`, and OAuth's `{ error, error_description }`
 * — so both are read, and a body that is neither falls back on the status.
 */
export function refusalMessage(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null) {
    const candidate = body as Record<string, unknown>
    for (const key of ["msg", "error_description", "message", "error"]) {
      const value = candidate[key]
      if (typeof value === "string" && value !== "") return value
    }
  }
  return status === 400 || status === 401 ? "The e-mail address or the password is not right" : `Sign-in failed (HTTP ${status})`
}

async function token(config: AuthConfig, grant: string, body: unknown, doFetch: typeof fetch, now: number): Promise<ApiSession> {
  let response: Response
  try {
    response = await doFetch(`${config.supabaseUrl}/auth/v1/token?grant_type=${grant}`, {
      method: "POST",
      headers: { apikey: config.anonKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    })
  } catch (cause) {
    throw new SignInRefused(0, `The identity provider at ${config.supabaseUrl} did not answer${cause instanceof Error && cause.message ? ` (${cause.message})` : ""}`)
  }
  let parsed: unknown = null
  try {
    parsed = await response.json()
  } catch {
    parsed = null
  }
  if (!response.ok) throw new SignInRefused(response.status, refusalMessage(parsed, response.status))
  const session = sessionOf(parsed, now)
  if (session === null) throw new SignInRefused(response.status, "The identity provider answered without a session")
  return session
}

export type AuthOptions = { fetch?: typeof fetch; now?: () => number }

/** A session for an e-mail address and its password; throws `SignInRefused` with Auth's sentence otherwise. */
export function signInWithPassword(config: AuthConfig, email: string, password: string, { fetch: doFetch = fetch, now = Date.now }: AuthOptions = {}): Promise<ApiSession> {
  return token(config, "password", { email: email.trim(), password }, doFetch, now())
}

/** The next session from a refresh token; throws `SignInRefused` when Auth no longer honours it. */
export function refreshSession(config: AuthConfig, refreshToken: string, { fetch: doFetch = fetch, now = Date.now }: AuthOptions = {}): Promise<ApiSession> {
  return token(config, "refresh_token", { refresh_token: refreshToken }, doFetch, now())
}
