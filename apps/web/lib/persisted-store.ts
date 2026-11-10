// One value a page keeps in the browser across visits: read through its key
// and the keys it replaced (`readPersisted`), parsed by its owner, and written
// back under its key. Storage may be unavailable — private mode, a blocked or
// full store — or hold something no writer of ours produced; neither ever
// fails the page, which renders without the value: a read answers null, and a
// write answers false, what was chosen lasting the session.
import { persistedKeys, readPersisted } from "./storage-keys"

export type PersistedStore<T> = {
  /** The value kept, parsed; null where none is kept, the storage cannot be read, or what it holds is not one. */
  read(): T | null
  /** Keeps the value under its key; false where the storage refused it. */
  write(value: T): boolean
  /** Removes the value, under its key and every key it replaced. */
  forget(): void
}

type PersistedStoreOptions<T> = {
  /** The owner's reading of the kept text, a migration of an older shape included; null, or a throw, for what is not a value. */
  parse: (raw: string) => T | null
  serialize?: (value: T) => string
  /** The storage, asked for at each use; the browser's localStorage unless said otherwise. */
  storage?: () => Storage | undefined
}

/** The browser's localStorage; none on the server, which renders without it. */
const browserStorage = (): Storage | undefined => (typeof window === "undefined" ? undefined : window.localStorage)

export function persistedStore<T>(key: string, { parse, serialize = JSON.stringify, storage = browserStorage }: PersistedStoreOptions<T>): PersistedStore<T> {
  return {
    read() {
      try {
        const raw = readPersisted(storage(), key)
        return raw === null ? null : parse(raw)
      } catch {
        return null
      }
    },
    write(value) {
      try {
        const store = storage()
        if (store === undefined) return false
        store.setItem(key, serialize(value))
        return true
      } catch {
        return false
      }
    },
    forget() {
      try {
        const store = storage()
        for (const name of persistedKeys(key)) store?.removeItem(name)
      } catch {
        // Nothing is read from a storage that refuses, either.
      }
    },
  }
}
