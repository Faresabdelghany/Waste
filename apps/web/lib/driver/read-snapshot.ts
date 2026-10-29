// The Driver App's display cache (O25 of #290): the door's last answers — the
// start screen and each of the day's routes — kept on the phone per login, so
// a driver with no signal can still read their stops. What is kept is only
// what the server answered, each with the instant it answered; the screens
// show it marked as the last known answer and never mix a tap into it, so a
// cached read is a stale server answer, never a locally decided outcome. The
// Command Queue is apart (command-queue.ts) and unchanged.
//
// One IndexedDB database per origin, one store, one row per login (`whoOf`,
// lib/api/session.ts), so a phone handed to another driver shows them
// nothing of the last one's day. A row keeps the routes the start screen it
// holds still names, and a row older than `SNAPSHOT_MAX_AGE_MS` is read as
// none: yesterday's routes are not today's work.
//
// Only storage: when a read is kept and when a kept one is shown is the
// controller's (driver-app.ts). The factory is an argument, the browser's
// `indexedDB` in the page and fake-indexeddb's in the tests.
import type { DriverMe, DriverRouteDetail } from "@waste/contracts/driver-commands"

import { DRIVER_READ_SNAPSHOT_DATABASE } from "../storage-keys"

const VERSION = 1
const SNAPSHOTS = "snapshots"

/** How long a kept answer may be shown: a working day and its evening, never the next day's start. */
export const SNAPSHOT_MAX_AGE_MS = 18 * 60 * 60 * 1000

/** An answer of the door and when it came. */
export type Kept<Answer> = { answer: Answer; readAt: string }

/** One login's last answers: the start screen, and the routes by id. */
export type ReadSnapshot = { me: Kept<DriverMe> | null; routes: Readonly<Record<string, Kept<DriverRouteDetail>>> }

export const EMPTY_SNAPSHOT: ReadSnapshot = { me: null, routes: {} }

type Row = ReadSnapshot & { owner: string }

export type ReadSnapshotStore = {
  /** The login's last answers, those older than the bound left out. */
  read: (owner: string, now: number) => Promise<ReadSnapshot>
  /** Writes the login's answers whole. */
  write: (owner: string, snapshot: ReadSnapshot) => Promise<void>
  /** Forgets the login's answers: a sign-out, or a login the door no longer takes. */
  forget: (owner: string) => Promise<void>
  close: () => void
}

const fresh = <Answer>(kept: Kept<Answer> | null | undefined, now: number): kept is Kept<Answer> => kept != null && now - Date.parse(kept.readAt) <= SNAPSHOT_MAX_AGE_MS

/**
 * What a login's row keeps: the answers inside the bound, and of the routes
 * only those the start screen kept beside them names — a route no longer the
 * driver's, or done with yesterday, drops out with the start screen that
 * stopped naming it. With no start screen kept, the routes stand alone.
 */
export function kept(snapshot: ReadSnapshot, now: number): ReadSnapshot {
  const me = fresh(snapshot.me, now) ? snapshot.me : null
  const named = me === null ? null : new Set(me.answer.routes.map((route) => route.id))
  const routes = Object.fromEntries(Object.entries(snapshot.routes).filter(([id, route]) => fresh(route, now) && (named === null || named.has(id))))
  return { me, routes }
}

function settled(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error("the read snapshot's transaction was aborted"))
  })
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DRIVER_READ_SNAPSHOT_DATABASE, VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(SNAPSHOTS)) database.createObjectStore(SNAPSHOTS, { keyPath: "owner" })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function openReadSnapshot(factory: IDBFactory): Promise<ReadSnapshotStore> {
  const database = await openDatabase(factory)
  database.onversionchange = () => database.close()
  const change = async (write: (store: IDBObjectStore) => void) => {
    const transaction = database.transaction(SNAPSHOTS, "readwrite")
    write(transaction.objectStore(SNAPSHOTS))
    await settled(transaction)
  }
  return {
    read: async (owner, now) => {
      const transaction = database.transaction(SNAPSHOTS, "readonly")
      const request = transaction.objectStore(SNAPSHOTS).get(owner)
      await settled(transaction)
      const row = request.result as Row | undefined
      return row === undefined ? EMPTY_SNAPSHOT : kept({ me: row.me, routes: row.routes }, now)
    },
    write: (owner, snapshot) => change((store) => store.put({ owner, me: snapshot.me, routes: snapshot.routes } satisfies Row)),
    forget: (owner) => change((store) => store.delete(owner)),
    close: () => database.close(),
  }
}
