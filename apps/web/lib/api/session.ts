// The API session apart from React (Issue #150): who the browser is signed in
// as, and the one place that decides when that begins and ends. The provider
// (components/waste/api-session-store.tsx) holds one controller, hands it the
// session it read from the browser's storage, writes back what it holds, and
// ticks its refresh; everything else here is testable against a scripted
// `fetch`, which is how its tests drive it.
//
// A session ends four ways, and `ended` says which, so /login can say why:
//
//   signed out  — the person asked; the session is dropped at once and
//                 revoked at Auth best-effort (auth.ts, `signOut`);
//   refused     — the account itself was refused: an API answer of the one
//                 problem type beyond `about:blank`, `NO_ACTIVE_ACCOUNT`, from
//                 `/me` or any other call (every client this hands out tells
//                 it of a refusal before throwing it, client.ts `onRefused`),
//                 or a refresh Auth would not honour, which is how the hook's
//                 "This account is deactivated" arrives mid-session; the
//                 sentence is kept to show;
//   expired     — the access token ran out and nobody could refresh it (no
//                 identity provider configured, or a tab that did not sign in
//                 itself and so holds no refresh token).
//
// Authentication and authorization stay apart: a 403 of `about:blank` is a
// role's grant refused, which the person sees in-session as before, and it
// ends nothing. Nor does a request that never reached the API.
//
// `me` is the caller as `/me` last answered for the open session: the
// landing (`landingOf`, landing.ts) and the sidebar's identity read it, and a
// new session starts without one.
import type { Me } from "@waste/contracts/me"

import { createExternalStore, type ExternalStore } from "../external-store"
import {
  isExpired,
  PasswordChangeRefused,
  refreshSession,
  signInWithPassword,
  SignInRefused,
  signOut as revokeSession,
  updatePassword as changePassword,
  type ApiSession,
  type AuthOptions,
} from "./auth"
import { get, UNREACHABLE_STATUS, type ApiClient } from "./client"
import type { ApiConfig, AuthConfig } from "./config"
import { ApiProblem, genericProblem, isAccountRefusal, type Problem } from "./problem"

/**
 * How the last session ended: the person signed out; the account was
 * refused — by the API (`NO_ACTIVE_ACCOUNT`) or by Auth at a refresh — with
 * the sentence /login shows; or it ran out with nobody able to refresh it.
 */
export type SessionEnding = { reason: "signed-out" } | { reason: "refused"; detail: string } | { reason: "expired" }

export type SessionState = {
  session: ApiSession | null
  /** Flips to true once the browser's stored session has been read. */
  hydrated: boolean
  /** How the last session ended; null while one is open, and before any has ended. */
  ended: SessionEnding | null
  /** The caller as `/me` last answered for the open session; null until it has. */
  me: Me | null
}

/** Before the browser's storage is read: nobody signed in, and nothing known yet. The server renders this. */
export const UNREAD_SESSION: SessionState = { session: null, hydrated: false, ended: null, me: null }

/**
 * Who a session is, apart from its tokens: Auth's user id, the same across
 * every refresh, else the e-mail, else the token itself (the older, never
 * worse behaviour of reloading on a refresh).
 */
export function whoOf(session: ApiSession): string {
  return session.userId ?? session.email ?? session.accessToken
}

export type ApiSessionOptions = {
  /** The API the clients call; null when the adapter is off. */
  api: ApiConfig | null
  /** The identity provider sign-in, refresh, password change and sign-out go to; null when none is configured. */
  auth: AuthConfig | null
  /** The `fetch` every call goes through, to Auth and to the API alike; the environment's when absent. */
  fetch?: typeof fetch
  now?: () => number
}

export type ApiSessionController = {
  readonly store: ExternalStore<SessionState>
  readonly api: ApiConfig | null
  readonly auth: AuthConfig | null
  /** The session read from the browser's storage, or null: the state is hydrated from here on. */
  hydrate: (session: ApiSession | null) => void
  /** Signs in and opens the session, clearing why the last one ended; throws `SignInRefused` in Auth's words. */
  signIn: (email: string, password: string) => Promise<ApiSession>
  /** Drops the session at once, then revokes it at Auth best-effort; settles when Auth has answered or not. */
  signOut: () => Promise<void>
  /** Refreshes the token when it is about to expire; ends the session when Auth refuses or nobody can refresh it. */
  refreshIfDue: () => Promise<void>
  /** The client for the open session — null while the adapter is off, nobody is signed in, or the token has expired unrefreshed. */
  client: () => ApiClient | null
  /** The client for a given session, carrying the rule that ends it on the account's refusal. */
  clientFor: (session: ApiSession) => ApiClient | null
  /**
   * `GET /me` for the open session, kept in the state as `me`; one read in
   * flight per person, shared. An account refusal ends the session before
   * the promise rejects with it.
   */
  loadMe: () => Promise<Me>
  /** Changes the password (auth.ts, `updatePassword`) and keeps the fresh session it ran under; throws `PasswordChangeRefused`. */
  updatePassword: (currentPassword: string, newPassword: string) => Promise<void>
}

export function createApiSession({ api, auth, fetch: doFetch, now = Date.now }: ApiSessionOptions): ApiSessionController {
  const store = createExternalStore<SessionState>(UNREAD_SESSION)
  const authOptions: AuthOptions = { ...(doFetch === undefined ? {} : { fetch: doFetch }), now }
  let refreshing = false
  let meInFlight: { who: string; read: Promise<Me> } | null = null

  /** Ends the open session when it is the one `holds` picks out, for the reason given; a session opened since is left alone. */
  const endWhen = (holds: (current: ApiSession) => boolean, ending: SessionEnding) => {
    store.set((state) => (state.session !== null && holds(state.session) ? { ...state, session: null, me: null, ended: ending } : state))
  }

  // The rule, for a client of `session`: the account's refusal ends the
  // session of that person — whichever token of theirs is held by now — and
  // nothing else ends anything.
  const refused = (session: ApiSession, problem: Problem) => {
    if (!isAccountRefusal(problem)) return
    const who = whoOf(session)
    endWhen((current) => whoOf(current) === who, { reason: "refused", detail: problem.detail ?? problem.title })
  }

  const clientFor = (session: ApiSession): ApiClient | null => {
    if (api === null || isExpired(session, now())) return null
    return {
      baseUrl: api.baseUrl,
      token: session.accessToken,
      ...(doFetch === undefined ? {} : { fetch: doFetch }),
      onRefused: (problem) => refused(session, problem),
    }
  }

  return {
    store,
    api,
    auth,
    hydrate: (session) => store.set((state) => ({ ...state, session, hydrated: true })),
    signIn: async (email, password) => {
      if (auth === null) throw new SignInRefused(0, "Password sign-in is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY")
      const session = await signInWithPassword(auth, email, password, authOptions)
      store.set((state) => ({ ...state, session, ended: null, me: null }))
      return session
    },
    signOut: async () => {
      const { session } = store.getSnapshot()
      if (session === null) return
      endWhen((current) => current === session, { reason: "signed-out" })
      if (auth !== null) await revokeSession(auth, session.accessToken, authOptions)
    },
    refreshIfDue: async () => {
      const { session, hydrated } = store.getSnapshot()
      if (!hydrated || session === null || refreshing || !isExpired(session, now())) return
      if (auth === null || session.refreshToken === null) {
        endWhen((current) => current === session, { reason: "expired" })
        return
      }
      refreshing = true
      try {
        const next = await refreshSession(auth, session.refreshToken, authOptions)
        store.set((state) => (state.session === session ? { ...state, session: next } : state))
      } catch (error) {
        // A refresh Auth refused ends the session; one the network lost is tried again on the next tick.
        if (error instanceof SignInRefused && error.status !== 0) endWhen((current) => current === session, { reason: "refused", detail: error.message })
      } finally {
        refreshing = false
      }
    },
    client: () => {
      const { session } = store.getSnapshot()
      return session === null ? null : clientFor(session)
    },
    clientFor,
    loadMe: () => {
      const { session } = store.getSnapshot()
      const client = session === null ? null : clientFor(session)
      if (session === null || client === null) return Promise.reject(new ApiProblem(genericProblem(UNREACHABLE_STATUS, "Nobody is signed in")))
      const who = whoOf(session)
      if (meInFlight !== null && meInFlight.who === who) return meInFlight.read
      const read = get<Me>(client, "/me").then((me) => {
        store.set((state) => (state.session !== null && whoOf(state.session) === who ? { ...state, me } : state))
        return me
      })
      meInFlight = { who, read }
      const settled = () => {
        if (meInFlight?.read === read) meInFlight = null
      }
      read.then(settled, settled)
      return read
    },
    updatePassword: async (currentPassword, newPassword) => {
      const { session, me } = store.getSnapshot()
      const email = session?.email ?? me?.user.email ?? null
      if (auth === null || session === null || email === null) throw new PasswordChangeRefused(0, "Nobody is signed in")
      const fresh = await changePassword(auth, email, currentPassword, newPassword, authOptions)
      // Auth has ended every other session of the Login, the one held a moment ago included.
      const who = whoOf(session)
      store.set((state) => (state.session !== null && whoOf(state.session) === who ? { ...state, session: fresh } : state))
    },
  }
}
