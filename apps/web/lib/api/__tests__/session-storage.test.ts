// Where the API session is kept (Issue #81): the access token and its
// company in one storage, the refresh token in another, the two read back as
// one session, and what a tab that never signed in itself gets.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { ApiSession } from "../auth"
import { readStoredSession, writeStoredSession } from "../session-storage"
import { API_REFRESH_TOKEN_STORAGE_KEY, API_SESSION_STORAGE_KEY } from "../../storage-keys"

/** The browser `Storage` surface, in memory, so a test can read it back. */
function memoryStorage(entries: Readonly<Record<string, string>> = {}): Storage {
  const map = new Map<string, string>(Object.entries(entries))
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key)
    },
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
  }
}

const session: ApiSession = { accessToken: "a", refreshToken: "r", expiresAt: 1_800_000_000_000, email: "x@y.example", userId: "u-1" }

describe("the stored session", () => {
  test("the refresh token goes to the tab's storage and nothing else does; the rest is shared", () => {
    const shared = memoryStorage()
    const tab = memoryStorage()
    writeStoredSession(shared, tab, session)
    const persisted = JSON.parse(shared.getItem(API_SESSION_STORAGE_KEY) ?? "null") as Record<string, unknown>
    assert.deepEqual(persisted, { accessToken: "a", expiresAt: 1_800_000_000_000, email: "x@y.example", userId: "u-1" })
    assert.equal("refreshToken" in persisted, false, "the long-lived credential never reaches the shared storage")
    assert.equal(tab.getItem(API_REFRESH_TOKEN_STORAGE_KEY), "r")
    assert.equal(tab.length, 1)
  })

  test("read back, the two halves are one session", () => {
    const shared = memoryStorage()
    const tab = memoryStorage()
    writeStoredSession(shared, tab, session)
    assert.deepEqual(readStoredSession(shared, tab), session)
  })

  test("a tab that did not sign in itself has the shared half and no refresh token", () => {
    const shared = memoryStorage()
    writeStoredSession(shared, memoryStorage(), session)
    assert.deepEqual(readStoredSession(shared, memoryStorage()), { ...session, refreshToken: null })
  })

  test("null clears both; a refresh token alone, a corrupt shared half or a foreign shape is nobody signed in", () => {
    const shared = memoryStorage()
    const tab = memoryStorage()
    writeStoredSession(shared, tab, session)
    writeStoredSession(shared, tab, null)
    assert.equal(shared.length, 0)
    assert.equal(tab.length, 0)
    assert.equal(readStoredSession(shared, memoryStorage({ [API_REFRESH_TOKEN_STORAGE_KEY]: "r" })), null)
    assert.equal(readStoredSession(memoryStorage({ [API_SESSION_STORAGE_KEY]: "{not json" }), tab), null)
    assert.equal(readStoredSession(memoryStorage({ [API_SESSION_STORAGE_KEY]: JSON.stringify({ accessToken: 1 }) }), tab), null)
  })

  test("a shared half written before the split is read for the access token's life, its refresh token ignored, and the next write drops it", () => {
    const shared = memoryStorage({ [API_SESSION_STORAGE_KEY]: JSON.stringify({ accessToken: "a", refreshToken: "old-r", expiresAt: 1, email: null }) })
    const tab = memoryStorage()
    const read = readStoredSession(shared, tab)
    assert.deepEqual(read, { accessToken: "a", refreshToken: null, expiresAt: 1, email: null, userId: null })
    writeStoredSession(shared, tab, read)
    assert.equal((shared.getItem(API_SESSION_STORAGE_KEY) ?? "").includes("old-r"), false, "the refresh token has left the shared storage")
    assert.equal(tab.length, 0)
  })

  test("a session without a refresh token writes none and clears a stale one", () => {
    const shared = memoryStorage()
    const tab = memoryStorage({ [API_REFRESH_TOKEN_STORAGE_KEY]: "stale" })
    writeStoredSession(shared, tab, { ...session, refreshToken: null })
    assert.equal(tab.getItem(API_REFRESH_TOKEN_STORAGE_KEY), null)
    assert.equal(readStoredSession(shared, tab)?.refreshToken, null)
  })

  test("a storage that refuses is left as it is and the other half still lands; no storage at all reads null", () => {
    const shared = memoryStorage()
    shared.setItem = () => {
      throw new Error("quota exceeded")
    }
    const tab = memoryStorage()
    writeStoredSession(shared, tab, session)
    assert.equal(tab.getItem(API_REFRESH_TOKEN_STORAGE_KEY), "r")
    assert.equal(readStoredSession(null, undefined), null)
  })
})
