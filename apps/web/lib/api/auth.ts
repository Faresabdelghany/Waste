// Signing in, as the web does it (Issue #81): Supabase Auth's endpoints,
// spoken directly. The API verifies a Supabase access token (ADR-0001; the
// hook puts the home company into it), so the web needs one, and the calls
// that get, keep and end one are small enough that a client library would
// weigh more than it carries into the bundle:
//
//   POST {supabaseUrl}/auth/v1/token?grant_type=password       { email, password }
//   POST {supabaseUrl}/auth/v1/token?grant_type=refresh_token  { refresh_token }
//   PUT  {supabaseUrl}/auth/v1/user                            { password }       (bearer)
//   POST {supabaseUrl}/auth/v1/logout?scope=local                                 (bearer)
//
// all under the project's publishable key as `apikey`; the two token grants
// answer the same session body: the access token, when it expires, and the
// refresh token that gets the next one. The last two are Issue #150's: a
// person changes the temporary password they were handed, and a sign-out
// revokes the session. Sign-up is not here: it is off (supabase/config.toml).
// On the Pilot the Supabase organisation's Owner creates a Login in the
// dashboard (supabase/README.md) and the access token hook binds it to the
// person's User Account on its first sign-in; no e-mail is ever sent.
//
// The functions take `fetch` from the environment (a test hands its own) and
// know nothing of the browser or of storage: session.ts keeps the session and
// decides when to refresh and when it has ended.
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
  // `expires_in` is seconds from now, which this device's clock can count;
  // `expires_at`, epoch seconds on Auth's clock, only when that is all there
  // is, since a device clock that is off would read it as long past or far off.
  const expiresAt =
    typeof token.expires_in === "number"
      ? now + token.expires_in * 1000
      : typeof token.expires_at === "number"
        ? token.expires_at * 1000
        : null
  if (expiresAt === null) return null
  const email = token.user && typeof token.user.email === "string" ? token.user.email : null
  const userId = token.user && typeof token.user.id === "string" ? token.user.id : null
  return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt, email, userId }
}

/**
 * The sentence an Auth refusal carries, or null when its body carries none.
 * Auth has spelled its errors two ways over time — `{ msg }` with a `code`,
 * and OAuth's `{ error, error_description }` — so both are read.
 */
function authSentence(body: unknown): string | null {
  if (typeof body === "object" && body !== null) {
    const candidate = body as Record<string, unknown>
    for (const key of ["msg", "error_description", "message", "error"]) {
      const value = candidate[key]
      if (typeof value === "string" && value !== "") return value
    }
  }
  return null
}

/** The sentence a sign-in refusal carries; a body that carries none falls back on the status. */
export function refusalMessage(body: unknown, status: number): string {
  return authSentence(body) ?? (status === 400 || status === 401 ? "The e-mail address or the password is not right" : `Sign-in failed (HTTP ${status})`)
}

type AuthAnswer = { status: number; ok: boolean; body: unknown }

/**
 * One request to Auth under the publishable key, and under the person's
 * access token when one is given. Resolves with whatever Auth answered, its
 * body parsed where it is JSON (a 204 is not); rejects only when Auth did not
 * answer at all, with the sentence `unreachable` spells.
 */
async function callAuth(config: AuthConfig, path: string, { method, token, body }: { method: string; token?: string; body?: unknown }, doFetch: typeof fetch): Promise<AuthAnswer> {
  let response: Response
  try {
    response = await doFetch(`${config.supabaseUrl}${path}`, {
      method,
      headers: {
        apikey: config.anonKey,
        accept: "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (cause) {
    throw new Error(`The identity provider at ${config.supabaseUrl} did not answer${cause instanceof Error && cause.message ? ` (${cause.message})` : ""}`)
  }
  let parsed: unknown = null
  try {
    parsed = await response.json()
  } catch {
    parsed = null
  }
  return { status: response.status, ok: response.ok, body: parsed }
}

/** The message of what `callAuth` rejected with: the sentence for an Auth that did not answer. */
const unreachable = (error: unknown): string => (error instanceof Error ? error.message : "The identity provider did not answer")

async function token(config: AuthConfig, grant: string, body: unknown, doFetch: typeof fetch, now: number): Promise<ApiSession> {
  let answer: AuthAnswer
  try {
    answer = await callAuth(config, `/auth/v1/token?grant_type=${grant}`, { method: "POST", body }, doFetch)
  } catch (error) {
    throw new SignInRefused(0, unreachable(error))
  }
  if (!answer.ok) throw new SignInRefused(answer.status, refusalMessage(answer.body, answer.status))
  const session = sessionOf(answer.body, now)
  if (session === null) throw new SignInRefused(answer.status, "The identity provider answered without a session")
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

/** A password change Auth refused, in words for the person making it: the current password did not verify, or the new one will not do. */
export class PasswordChangeRefused extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "PasswordChangeRefused"
    this.status = status
  }
}

/**
 * Sets a new password for the person signed in as `email` (Issue #150), in
 * two steps. The current password is verified by signing in with it —
 * Supabase's "secure password change" would ask for a nonce it mails, and no
 * mail is sent on the Pilot — and the new one is set by `PUT /auth/v1/user`
 * under the access token that sign-in answered, never before it. Auth ends
 * every other session of the Login when its password changes, the one the
 * web held included, so the session the update ran under is the one to keep:
 * it is answered, and the caller adopts it. Refused with
 * `PasswordChangeRefused`: the current password not right (400), the new one
 * in Auth's words (a 422 for one too short or unchanged), status 0 when Auth
 * did not answer.
 */
export async function updatePassword(
  config: AuthConfig,
  email: string,
  currentPassword: string,
  newPassword: string,
  { fetch: doFetch = fetch, now = Date.now }: AuthOptions = {},
): Promise<ApiSession> {
  let verified: ApiSession
  try {
    verified = await signInWithPassword(config, email, currentPassword, { fetch: doFetch, now })
  } catch (error) {
    if (!(error instanceof SignInRefused)) throw error
    throw new PasswordChangeRefused(error.status, error.status === 400 ? "The current password is not right" : error.message)
  }
  let answer: AuthAnswer
  try {
    answer = await callAuth(config, "/auth/v1/user", { method: "PUT", token: verified.accessToken, body: { password: newPassword } }, doFetch)
  } catch (error) {
    throw new PasswordChangeRefused(0, unreachable(error))
  }
  if (!answer.ok) throw new PasswordChangeRefused(answer.status, authSentence(answer.body) ?? `The new password was not accepted (HTTP ${answer.status})`)
  return verified
}

/**
 * Revokes a session at Auth (`POST /auth/v1/logout`, Issue #150), so its
 * refresh token is spent whatever becomes of the browser's copy. The scope
 * is `local`, this session alone: Auth's default would end every session of
 * the Login, and a person signed in on a phone and a laptop signs out of the
 * one in their hand. Best-effort, so nothing is thrown — an expired token, a
 * refusal and a lost network all leave the caller doing what it does next
 * anyway, which is dropping the session it holds.
 */
export async function signOut(config: AuthConfig, accessToken: string, { fetch: doFetch = fetch }: AuthOptions = {}): Promise<void> {
  try {
    await callAuth(config, "/auth/v1/logout?scope=local", { method: "POST", token: accessToken }, doFetch)
  } catch {
    // Best-effort: Auth did not answer, and the session is dropped all the same.
  }
}
