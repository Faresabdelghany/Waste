"use client"

// The API session (Issues #81, #150): who the browser is signed in as, kept
// where the gate, /login, the sidebar and the server-backed record store can
// find it. The rules — when a session begins, refreshes and ends, and what
// `/me` said about the person — are lib/api/session.ts's, a controller with
// no React in it; this provider holds one (lib/external-store.ts says why the
// context carries the handle and not the state), binds it to the browser's
// storage after hydration and tells it of other tabs' writes, ticks its
// refresh a minute before the access token expires, and reads `/me` once for
// each person signed in, for the sidebar's identity.
//
// `useApiClient` hands out the `ApiClient` the store calls with, or null when
// the adapter is off (no `NEXT_PUBLIC_WASTE_API_URL`) or nobody is signed in.
// With the adapter off every module reads its fixtures, as before Issue #81;
// with it on, the gate (components/auth/sign-in-gate.tsx) shows no page but
// /login to a browser without a session.
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
// borrows the shared token and holds no refresh: `refreshToken` is null
// there. It takes the token the signing tab refreshes when the storage event
// says so, and if its copy runs out first its session ends as expired — the
// shared half left alone — and the gate sends it to /login, back to the page
// it was on once it signs in. A sign-out in any tab removes the shared half,
// and every other tab signs out with it.
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"

import { isExpired } from "@/lib/api/auth"
import type { ApiClient } from "@/lib/api/client"
import { API_CONFIG, AUTH_CONFIG, type ApiConfig, type AuthConfig } from "@/lib/api/config"
import { createApiSession, whoOf, type ApiSessionController, type SessionState } from "@/lib/api/session"
import { API_SESSION_STORAGE_KEY } from "@/lib/storage-keys"

const ApiSessionContext = createContext<ApiSessionController | null>(null)

/** How often the provider looks at the clock to see whether the token is about to expire. */
const REFRESH_TICK_MS = 30_000

export function ApiSessionProvider({ children, api = API_CONFIG, auth = AUTH_CONFIG }: { children: ReactNode; api?: ApiConfig | null; auth?: AuthConfig | null }) {
  const [controller] = useState<ApiSessionController>(() => createApiSession({ api, auth }))

  useEffect(() => {
    const detach = controller.attachStorage(window.localStorage, window.sessionStorage)
    // Another tab's sign-in, refresh or sign-out reaches this one as a
    // storage event on the shared half (`key` is null when storage is cleared).
    const follow = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && (event.key === null || event.key === API_SESSION_STORAGE_KEY)) controller.storageChanged()
    }
    window.addEventListener("storage", follow)
    return () => {
      window.removeEventListener("storage", follow)
      detach()
    }
  }, [controller])

  useEffect(() => {
    void controller.refreshIfDue()
    const handle = window.setInterval(() => void controller.refreshIfDue(), REFRESH_TICK_MS)
    return () => window.clearInterval(handle)
  }, [controller])

  // `/me` once per person, for the sidebar: when someone is signed in with a
  // token the API will take, and again only when the person changes. A read
  // that failed is tried again on the store's next change (the next refresh
  // at the latest); one the account's refusal failed has ended the session.
  useEffect(() => {
    let readFor: string | null = null
    const follow = () => {
      const { session } = controller.store.getSnapshot()
      const who = session === null || controller.client() === null ? null : whoOf(session)
      if (who === readFor) return
      readFor = who
      if (who === null) return
      controller.loadMe().catch(() => {
        if (readFor === who) readFor = null
      })
    }
    follow()
    return controller.store.subscribe(follow)
  }, [controller])

  return <ApiSessionContext.Provider value={controller}>{children}</ApiSessionContext.Provider>
}

function useApiSessionController(): ApiSessionController {
  const controller = useContext(ApiSessionContext)
  if (!controller) throw new Error("useApiSession must be used within ApiSessionProvider")
  return controller
}

function useSessionState(controller: ApiSessionController): SessionState {
  return useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot, controller.store.getServerSnapshot)
}

/** Whether the adapter is on: the Pilot's rules (sign-in required, identity from `/me`) apply only then. Read without subscribing to the session. */
export function useApiConfigured(): boolean {
  return useApiSessionController().api !== null
}

export type ApiSessionValue = SessionState & {
  /** Whether the web is configured to call an API at all. */
  apiConfigured: boolean
  /** Whether the web can sign a person in with a password. */
  passwordSignInAvailable: boolean
  /** Signs in and keeps the session; throws `SignInRefused` in Auth's words. */
  signIn: ApiSessionController["signIn"]
  /** Drops the session at once and revokes it at Auth best-effort. */
  signOut: ApiSessionController["signOut"]
  /** Reads `/me` for the session; an account refusal ends the session before the promise rejects. */
  loadMe: ApiSessionController["loadMe"]
  /** Changes the password and keeps the session it ran under; throws `PasswordChangeRefused`. */
  updatePassword: ApiSessionController["updatePassword"]
}

export function useApiSession(): ApiSessionValue {
  const controller = useApiSessionController()
  const snapshot = useSessionState(controller)
  return useMemo(
    () => ({
      ...snapshot,
      apiConfigured: controller.api !== null,
      passwordSignInAvailable: controller.auth !== null,
      signIn: controller.signIn,
      signOut: controller.signOut,
      loadMe: controller.loadMe,
      updatePassword: controller.updatePassword,
    }),
    [snapshot, controller],
  )
}

/**
 * The client the record store calls the API with: the configured base, the
 * session's access token and the rule that ends the session on the
 * account's refusal; null while the adapter is off, nobody is signed in, or
 * the token has expired and not yet been refreshed. A new object per token —
 * a consumer that must not reload on a refresh keys on
 * `useApiSessionIdentity` instead and reads the client at call time.
 */
export function useApiClient(): ApiClient | null {
  const controller = useApiSessionController()
  const { session } = useSessionState(controller)
  return useMemo(() => (session === null ? null : controller.clientFor(session)), [controller, session])
}

/**
 * What a session *is*, apart from its tokens: the API it reaches and whom it
 * reaches it as (`whoOf`). Stable across a token refresh, which changes
 * neither, and different across a sign-out, a sign-in as someone else, and
 * an expiry nobody refreshed (null then), so a consumer that loads once per
 * session — the record store's switched modules — keys on this and not on
 * the client.
 */
export type ApiSessionIdentity = { baseUrl: string; who: string }

export function useApiSessionIdentity(): ApiSessionIdentity | null {
  const controller = useApiSessionController()
  const { session } = useSessionState(controller)
  const baseUrl = controller.api?.baseUrl
  const who = session === null || isExpired(session) ? null : whoOf(session)
  return useMemo(() => (baseUrl === undefined || who === null ? null : { baseUrl, who }), [baseUrl, who])
}
