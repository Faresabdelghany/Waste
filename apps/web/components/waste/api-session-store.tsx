"use client"

// The API session (Issue #81): who the browser is signed in as, kept where
// the server-backed record store can find it. One external store, like the
// other providers (lib/external-store.ts says why the context carries the
// handle and not the state): the session read from the browser's storage
// after hydration, refreshed through Supabase Auth a minute before its access
// token expires (lib/api/auth.ts), and dropped on sign-out or when Auth no
// longer honours the refresh token.
//
// The provider decides nothing about data: it holds the tokens, and
// `useApiClient` hands out the `ApiClient` the store calls with, or null when
// the adapter is off (no `NEXT_PUBLIC_WASTE_API_URL`) or nobody is signed in
// — in which case every module reads its fixtures, as before this issue.
//
// Where the session lives. The two tokens are kept apart, since they are not
// the same kind of secret (lib/api/session-storage.ts does the reading and
// writing). The access token, its expiry, the e-mail and the user id go to
// localStorage under `API_SESSION_STORAGE_KEY`, shared by every tab so a
// second tab is signed in too; an access token is an hour's credential and
// the domain schema is not reachable with it (ADR-0001: the API is the one
// door, and it looks the caller's grants up on every request). The refresh
// token goes to sessionStorage under `API_REFRESH_TOKEN_STORAGE_KEY`, this
// tab's alone: it is the one long-lived credential, and this app carries
// surfaces script can reach (the legacy dashboard's `dangerouslySetInnerHTML`,
// tiptap), so it is kept where only the tab that signed in can read it and
// where closing the tab ends it. A tab that did not sign in itself therefore
// has the access token's remaining life and no refresh: `refreshToken` is
// null there, and when the token expires that tab reads fixtures until it
// signs in. This is the prototype's answer, revisited with the real login
// (Issue 5).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"

import { isExpired, refreshSession, signInWithPassword, SignInRefused, type ApiSession } from "@/lib/api/auth"
import type { ApiClient } from "@/lib/api/client"
import { API_CONFIG, AUTH_CONFIG, type ApiConfig, type AuthConfig } from "@/lib/api/config"
import { readStoredSession, writeStoredSession } from "@/lib/api/session-storage"
import { createExternalStore, type ExternalStore } from "@/lib/external-store"

export type ApiSessionSnapshot = {
  session: ApiSession | null
  /** Flips to true once the provider has read the browser's storage. */
  hydrated: boolean
}

type ApiSessionStore = ExternalStore<ApiSessionSnapshot> & {
  api: ApiConfig | null
  auth: AuthConfig | null
}

const ApiSessionContext = createContext<ApiSessionStore | null>(null)

// The server, and every hydrating component, sees nobody signed in.
const SERVER_SNAPSHOT: ApiSessionSnapshot = { session: null, hydrated: false }

/** How often the provider looks at the clock to see whether the token is about to expire. */
const REFRESH_TICK_MS = 30_000

export function ApiSessionProvider({ children, api = API_CONFIG, auth = AUTH_CONFIG }: { children: ReactNode; api?: ApiConfig | null; auth?: AuthConfig | null }) {
  const [store] = useState<ApiSessionStore>(() => ({ ...createExternalStore<ApiSessionSnapshot>(SERVER_SNAPSHOT), api, auth }))

  useEffect(() => {
    store.set({ session: readStoredSession(window.localStorage, window.sessionStorage), hydrated: true })
    const persist = () => writeStoredSession(window.localStorage, window.sessionStorage, store.getSnapshot().session)
    // Written back once on load, so a shared half in an older shape takes this one — and a refresh token it carried leaves localStorage.
    persist()
    return store.subscribe(persist)
  }, [store])

  // Refresh a minute before the access token expires, so a request sent then
  // does not arrive with a token the API refuses; a refresh Auth refuses is a
  // session that is over, and so is an expired session nobody can refresh
  // (no identity provider configured, or a tab without the refresh token).
  useEffect(() => {
    const auth = store.auth
    let refreshing = false
    const tick = async () => {
      const { session, hydrated } = store.getSnapshot()
      if (!hydrated || session === null || refreshing || !isExpired(session)) return
      if (auth === null || session.refreshToken === null) {
        store.set((current) => (current.session === session ? { ...current, session: null } : current))
        return
      }
      refreshing = true
      try {
        const next = await refreshSession(auth, session.refreshToken)
        store.set((current) => (current.session === session ? { ...current, session: next } : current))
      } catch (error) {
        // A refresh Auth refused ends the session; a refresh the network lost is tried again next tick.
        if (error instanceof SignInRefused && error.status !== 0) {
          store.set((current) => (current.session === session ? { ...current, session: null } : current))
        }
      } finally {
        refreshing = false
      }
    }
    void tick()
    const handle = window.setInterval(() => void tick(), REFRESH_TICK_MS)
    return () => window.clearInterval(handle)
  }, [store])

  return <ApiSessionContext.Provider value={store}>{children}</ApiSessionContext.Provider>
}

function useApiSessionStore(): ApiSessionStore {
  const store = useContext(ApiSessionContext)
  if (!store) throw new Error("useApiSession must be used within ApiSessionProvider")
  return store
}

export type ApiSessionValue = ApiSessionSnapshot & {
  /** Whether the web is configured to call an API at all. */
  apiConfigured: boolean
  /** Whether the web can sign a person in with a password. */
  passwordSignInAvailable: boolean
  /** Signs in and keeps the session; throws `SignInRefused` in Auth's words. */
  signIn: (email: string, password: string) => Promise<ApiSession>
  /** Drops the session; every switched module reads its fixtures again. */
  signOut: () => void
}

export function useApiSession(): ApiSessionValue {
  const store = useApiSessionStore()
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
  const signIn = useCallback(
    async (email: string, password: string) => {
      if (store.auth === null) throw new SignInRefused(0, "Password sign-in is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY")
      const session = await signInWithPassword(store.auth, email, password)
      store.set((current) => ({ ...current, session }))
      return session
    },
    [store],
  )
  const signOut = useCallback(() => {
    store.set((current) => ({ ...current, session: null }))
  }, [store])
  return useMemo(
    () => ({ ...snapshot, apiConfigured: store.api !== null, passwordSignInAvailable: store.auth !== null, signIn, signOut }),
    [snapshot, store.api, store.auth, signIn, signOut],
  )
}

/**
 * The client the record store calls the API with: the configured base and
 * the session's access token; null while the adapter is off, nobody is
 * signed in, or the token has expired and not yet been refreshed. A new
 * object per token — a consumer that must not reload on a refresh keys on
 * `useApiSessionIdentity` instead and reads the client at call time.
 */
export function useApiClient(): ApiClient | null {
  const store = useApiSessionStore()
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
  return useMemo(() => {
    if (store.api === null || snapshot.session === null || isExpired(snapshot.session)) return null
    return { baseUrl: store.api.baseUrl, token: snapshot.session.accessToken }
  }, [store.api, snapshot.session])
}

/**
 * What a session *is*, apart from its tokens: the API it reaches and whom it
 * reaches it as. Stable across a token refresh, which changes neither, and
 * different across a sign-out, a sign-in as someone else, and an expiry
 * nobody refreshed (null then), so a consumer that loads once per session —
 * the record store's switched modules — keys on this and not on the client.
 * The user id when Auth sent one (it always does), else the e-mail; a
 * session with neither falls back on the access token and so reloads on a
 * refresh, which is the old behaviour and never the worse one.
 */
export type ApiSessionIdentity = { baseUrl: string; who: string }

export function useApiSessionIdentity(): ApiSessionIdentity | null {
  const store = useApiSessionStore()
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
  const baseUrl = store.api?.baseUrl
  const session = snapshot.session
  const who = session === null || isExpired(session) ? null : (session.userId ?? session.email ?? session.accessToken)
  return useMemo(() => (baseUrl === undefined || who === null ? null : { baseUrl, who }), [baseUrl, who])
}
