import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  ACTIVE_ROUTES_STORAGE_KEY,
  BUSINESS_RECORDS_STORAGE_KEY,
  LEGACY_STORAGE_KEYS,
  persistedKeys,
  readPersisted,
} from "../storage-keys"

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

const [LEGACY_ACTIVE_ROUTES, LEGACY_SERVICE_PROVIDER_ROUTES] =
  LEGACY_STORAGE_KEYS[ACTIVE_ROUTES_STORAGE_KEY]
const [LEGACY_BUSINESS_RECORDS] = LEGACY_STORAGE_KEYS[BUSINESS_RECORDS_STORAGE_KEY]

describe("readPersisted", () => {
  test("the current key wins and its legacy key is left alone", () => {
    const storage = memoryStorage({
      [BUSINESS_RECORDS_STORAGE_KEY]: "current",
      [LEGACY_BUSINESS_RECORDS]: "legacy",
    })

    assert.equal(
      readPersisted(storage, BUSINESS_RECORDS_STORAGE_KEY),
      "current",
    )
    assert.equal(storage.getItem(LEGACY_BUSINESS_RECORDS), "legacy")
  })

  test("a legacy value is returned and moved to the current key", () => {
    const storage = memoryStorage({ [LEGACY_BUSINESS_RECORDS]: "legacy" })

    assert.equal(readPersisted(storage, BUSINESS_RECORDS_STORAGE_KEY), "legacy")
    assert.equal(storage.getItem(BUSINESS_RECORDS_STORAGE_KEY), "legacy")
    assert.equal(storage.getItem(LEGACY_BUSINESS_RECORDS), null)
    // The move is idempotent: the second read finds the current key.
    assert.equal(readPersisted(storage, BUSINESS_RECORDS_STORAGE_KEY), "legacy")
    assert.equal(storage.length, 1)
  })

  test("two legacy keys are tried in order and the first wins", () => {
    const storage = memoryStorage({
      [LEGACY_ACTIVE_ROUTES]: "newer",
      [LEGACY_SERVICE_PROVIDER_ROUTES]: "older",
    })

    assert.equal(readPersisted(storage, ACTIVE_ROUTES_STORAGE_KEY), "newer")
    assert.equal(storage.getItem(ACTIVE_ROUTES_STORAGE_KEY), "newer")
    assert.equal(storage.getItem(LEGACY_ACTIVE_ROUTES), null)
    // Only the key that was read is moved; the older one waits for a load
    // that finds nothing newer.
    assert.equal(storage.getItem(LEGACY_SERVICE_PROVIDER_ROUTES), "older")
  })

  test("the oldest key alone is still read", () => {
    const storage = memoryStorage({
      [LEGACY_SERVICE_PROVIDER_ROUTES]: "older",
    })

    assert.equal(readPersisted(storage, ACTIVE_ROUTES_STORAGE_KEY), "older")
    assert.equal(storage.getItem(ACTIVE_ROUTES_STORAGE_KEY), "older")
    assert.equal(storage.getItem(LEGACY_SERVICE_PROVIDER_ROUTES), null)
  })

  test("an empty store, an unmapped key and no storage at all read null", () => {
    const storage = memoryStorage()

    assert.equal(readPersisted(storage, BUSINESS_RECORDS_STORAGE_KEY), null)
    assert.equal(readPersisted(storage, "waste-nothing-here-v1"), null)
    assert.equal(storage.length, 0)
    assert.equal(readPersisted(null, BUSINESS_RECORDS_STORAGE_KEY), null)
    assert.equal(readPersisted(undefined, BUSINESS_RECORDS_STORAGE_KEY), null)
  })

  test("a storage that refuses writes still hands back the value", () => {
    const storage = memoryStorage({ [LEGACY_BUSINESS_RECORDS]: "legacy" })
    storage.setItem = () => {
      throw new Error("quota exceeded")
    }

    assert.equal(readPersisted(storage, BUSINESS_RECORDS_STORAGE_KEY), "legacy")
    assert.equal(storage.getItem(LEGACY_BUSINESS_RECORDS), "legacy")
  })

  test("a storage that refuses reads is not an error", () => {
    const storage = memoryStorage()
    storage.getItem = () => {
      throw new Error("access denied")
    }

    assert.equal(readPersisted(storage, BUSINESS_RECORDS_STORAGE_KEY), null)
  })
})

describe("persistedKeys", () => {
  test("lists the current key first, then its legacy keys in order", () => {
    assert.deepEqual(persistedKeys(ACTIVE_ROUTES_STORAGE_KEY), [
      ACTIVE_ROUTES_STORAGE_KEY,
      LEGACY_ACTIVE_ROUTES,
      LEGACY_SERVICE_PROVIDER_ROUTES,
    ])
    assert.deepEqual(persistedKeys("waste-nothing-here-v1"), [
      "waste-nothing-here-v1",
    ])
  })
})

describe("the key map", () => {
  test("every current key carries the working name", () => {
    for (const key of Object.keys(LEGACY_STORAGE_KEYS)) {
      assert.ok(
        key.startsWith("waste-") || key.startsWith("waste."),
        `${key} does not carry the working name`,
      )
    }
  })

  test("no legacy key equals a current key, and none repeats", () => {
    const current = new Set(Object.keys(LEGACY_STORAGE_KEYS))
    const seen = new Set<string>()
    for (const [key, legacyKeys] of Object.entries(LEGACY_STORAGE_KEYS)) {
      assert.ok(legacyKeys.length > 0, `${key} lists no legacy key`)
      for (const legacyKey of legacyKeys) {
        assert.notEqual(legacyKey, key)
        assert.ok(!current.has(legacyKey), `${legacyKey} is also a current key`)
        assert.ok(!seen.has(legacyKey), `${legacyKey} is listed twice`)
        seen.add(legacyKey)
      }
    }
  })
})
