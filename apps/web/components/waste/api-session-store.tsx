"use client"

// The API session (Issue #81): who the browser is signed in as, kept where
// the server-backed record store can find it. One external store, like the
// other providers (lib/external-store.ts says why the context carries the
// handle and not the state): the session read from localStorage after
// hydration, refreshed through Supabase Auth a minute before its access
// token expires (lib/api/auth.ts), and dropped on sign-out or when Auth no
// longer honours the refresh token.
//
// The provider decides nothing about data: it holds the tokens, and
// `useApiClient` hands out the `ApiClient` the store calls with, or null when
// the adapter is off (no `NEXT_PUBLIC_WASTE_API_URL`) or nobody is signed in
// — in which case every module reads its fixtures, as before this issue.
//
// The session's storage key is `API_SESSION_STORAGE_KEY`; the tokens are
// what a browser session holds in every Supabase app, and the domain schema
// is not reachable with them (ADR-0001: the API is the one door, and it
// looks the caller's grants up on every request).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"

import { isExpired, refreshSession, signInWithPassword, SignInRefused, type ApiSession } from "@/lib/api/auth"
import type { ApiClient } from "@/lib/api/client"
import { API_CONFIG, AUTH_CONFIG, type ApiConfig, type AuthConfig } from "@/lib/api/config"
import { createExternalStore, type ExternalStore } from "@/lib/external-store"
import { API_SESSION_STORAGE_KEY, readPersisted } from "@/lib/storage-keys"

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

function isSession(value: unknown): value is ApiSession {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.accessToken === "string" &&
    typeof candidate.refreshToken === "string" &&
    typeof candidate.expiresAt === "number" &&
    (candidate.email === null || typeof candidate.email === "string")
  )
}

/** How often the provider looks at the clock to see whether the token is about to expire. */
const REFRESH_TICK_MS = 30_000

export function ApiSessionProvider({ children, api = API_CONFIG, auth = AUTH_CONFIG }: { children: ReactNode; api?: ApiConfig | null; auth?: AuthConfig | null }) {
  const [store] = useState<ApiSessionStore>(() => ({ ...createExternalStore<ApiSessionSnapshot>(SERVER_SNAPSHOT), api, auth }))

  useEffect(() => {
    let parsed: unknown = null
    try {
      const raw = readPersisted(window.localStorage, API_SESSION_STORAGE_KEY)
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      // A corrupt store is nobody signed in.
    }
    store.set({ session: isSession(parsed) ? parsed : null, hydrated: true })
    const persist = () => {
      const { session } = store.getSnapshot()
      try {
        if (session === null) window.localStorage.removeItem(API_SESSION_STORAGE_KEY)
        else window.localStorage.setItem(API_SESSION_STORAGE_KEY, JSON.stringify(session))
      } catch {
        // The session stays usable for this tab when persistence is blocked.
      }
    }
    return store.subscribe(persist)
  }, [store])

  // Refresh a minute before the access token expires, so a request sent then
  // does not arrive with a token the API refuses; a refresh Auth refuses is a
  // session that is over, and so is an expired session nobody can refresh
  // (no identity provider configured).
  useEffect(() => {
    const auth = store.auth
    let refreshing = false
    const tick = async () => {
      const { session, hydrated } = store.getSnapshot()
      if (!hydrated || session === null || refreshing || !isExpired(session)) return
      if (auth === null) {
        store.set((current) => (current.session === session ? { ...current, session: null } : current))
        return
      }
      refreshing = true
      try {
        const next = await refreshSession(auth, session.refreshToken)
        store.set((current) => (current.session?.refreshToken === session.refreshToken ? { ...current, session: next } : current))
      } catch (error) {
        // A refresh Auth refused ends the session; a refresh the network lost is tried again next tick.
        if (error instanceof SignInRefused && error.status !== 0) {
          store.set((current) => (current.session?.refreshToken === session.refreshToken ? { ...current, session: null } : current))
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
 * client per token, so a consumer keyed on it reloads when the token moves.
 */
export function useApiClient(): ApiClient | null {
  const store = useApiSessionStore()
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
  return useMemo(() => {
    if (store.api === null || snapshot.session === null || isExpired(snapshot.session)) return null
    return { baseUrl: store.api.baseUrl, token: snapshot.session.accessToken }
  }, [store.api, snapshot.session])
}
