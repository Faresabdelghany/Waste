// A value kept in the browser: read through its legacy keys, parsed by its
// owner, written back under its key, and never a failure of the page when
// the storage refuses or holds something else.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { memoryStorage } from "../api/__tests__/memory-storage"
import { persistedStore } from "../persisted-store"
import { BASE_MAP_STORAGE_KEY, LEGACY_STORAGE_KEYS } from "../storage-keys"

const [LEGACY_BASE_MAP] = LEGACY_STORAGE_KEYS[BASE_MAP_STORAGE_KEY]

/** A storage whose every call throws, as a blocked one does. */
const refusing: Storage = {
  length: 0,
  clear: () => {
    throw new Error("blocked")
  },
  getItem: () => {
    throw new Error("blocked")
  },
  key: () => {
    throw new Error("blocked")
  },
  removeItem: () => {
    throw new Error("blocked")
  },
  setItem: () => {
    throw new Error("blocked")
  },
}

const counts = (storage: Storage | undefined) =>
  persistedStore<number[]>(BASE_MAP_STORAGE_KEY, {
    parse: (raw) => {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "number") ? parsed : null
    },
    storage: () => storage,
  })

describe("persistedStore", () => {
  test("writes a value under its key and reads it back parsed", () => {
    const storage = memoryStorage()
    assert.equal(counts(storage).write([1, 2]), true)
    assert.equal(storage.getItem(BASE_MAP_STORAGE_KEY), "[1,2]")
    assert.deepEqual(counts(storage).read(), [1, 2])
  })

  test("reads a value kept under the key it replaced", () => {
    const storage = memoryStorage({ [LEGACY_BASE_MAP]: "[3]" })
    assert.deepEqual(counts(storage).read(), [3])
  })

  test("reads nothing where nothing is kept, or what is kept is not a value", () => {
    assert.equal(counts(memoryStorage()).read(), null)
    assert.equal(counts(memoryStorage({ [BASE_MAP_STORAGE_KEY]: "{not json" })).read(), null)
    assert.equal(counts(memoryStorage({ [BASE_MAP_STORAGE_KEY]: "[\"a\"]" })).read(), null)
  })

  test("never fails where storage refuses or is not there: nothing is read, and the write says it was not kept", () => {
    for (const storage of [refusing, undefined]) {
      assert.equal(counts(storage).read(), null)
      assert.equal(counts(storage).write([1]), false)
      assert.doesNotThrow(() => counts(storage).forget())
    }
  })

  test("forgets the value under its key and every key it replaced", () => {
    const storage = memoryStorage({ [BASE_MAP_STORAGE_KEY]: "[1]", [LEGACY_BASE_MAP]: "[2]" })
    counts(storage).forget()
    assert.equal(storage.length, 0)
  })

  test("keeps text as the owner spells it", () => {
    const storage = memoryStorage()
    const named = persistedStore<string>(BASE_MAP_STORAGE_KEY, { parse: (raw) => raw, serialize: (value) => value, storage: () => storage })
    named.write("streets")
    assert.equal(storage.getItem(BASE_MAP_STORAGE_KEY), "streets")
    assert.equal(named.read(), "streets")
  })
})
