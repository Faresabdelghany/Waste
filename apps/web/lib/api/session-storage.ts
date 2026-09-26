// Where the API session is kept in the browser (Issue #81), apart from the
// React provider that reads and writes it (components/waste/api-session-store.tsx
// says why the two tokens are kept in two places): the tab-shared half — the
// access token, its expiry, the e-mail and the user id — in one storage
// under `API_SESSION_STORAGE_KEY`, and the refresh token, the one long-lived
// credential, in another under `API_REFRESH_TOKEN_STORAGE_KEY`. The provider
// hands `localStorage` and `sessionStorage`; a test hands two in-memory
// stores. Nothing here knows the identity provider: lib/api/auth.ts speaks
// to it, and this only keeps what it answered.
import type { ApiSession } from "./auth"
import { API_REFRESH_TOKEN_STORAGE_KEY, API_SESSION_STORAGE_KEY, readPersisted } from "../storage-keys"

/** The tab-shared half of a session as it is persisted: everything but the refresh token. */
export type PersistedSession = Omit<ApiSession, "refreshToken">

function isPersistedSession(value: unknown): value is PersistedSession {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.accessToken === "string" &&
    typeof candidate.expiresAt === "number" &&
    (candidate.email === null || typeof candidate.email === "string") &&
    (candidate.userId === undefined || candidate.userId === null || typeof candidate.userId === "string")
  )
}

/**
 * The session the browser holds: the shared half from `shared`, the refresh
 * token from `tab` — null when this tab never signed in itself. Null when
 * there is no shared half: a refresh token alone is nobody signed in, and a
 * corrupt shared half is too. Only the fields the shape names are read, so
 * a shared half written before the split (the refresh token beside the
 * access token, no user id) is a session with the access token's remaining
 * life and no refresh; the provider's first write puts it in this shape.
 */
export function readStoredSession(shared: Storage | null | undefined, tab: Storage | null | undefined): ApiSession | null {
  let parsed: unknown = null
  try {
    const raw = readPersisted(shared, API_SESSION_STORAGE_KEY)
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    // A corrupt store is nobody signed in.
  }
  if (!isPersistedSession(parsed)) return null
  return {
    accessToken: parsed.accessToken,
    expiresAt: parsed.expiresAt,
    email: parsed.email,
    userId: parsed.userId ?? null,
    refreshToken: readPersisted(tab, API_REFRESH_TOKEN_STORAGE_KEY),
  }
}

/**
 * Writes a session to the two storages — the refresh token never reaches
 * `shared` — or clears both for null. A storage that refuses is left as it
 * is: the session stays usable for this tab when persistence is blocked.
 */
export function writeStoredSession(shared: Storage | null | undefined, tab: Storage | null | undefined, session: ApiSession | null): void {
  try {
    if (session === null) shared?.removeItem(API_SESSION_STORAGE_KEY)
    else {
      const persisted: PersistedSession = { accessToken: session.accessToken, expiresAt: session.expiresAt, email: session.email, userId: session.userId }
      shared?.setItem(API_SESSION_STORAGE_KEY, JSON.stringify(persisted))
    }
  } catch {
    // Left as it is.
  }
  try {
    if (session === null || session.refreshToken === null) tab?.removeItem(API_REFRESH_TOKEN_STORAGE_KEY)
    else tab?.setItem(API_REFRESH_TOKEN_STORAGE_KEY, session.refreshToken)
  } catch {
    // Likewise.
  }
}
