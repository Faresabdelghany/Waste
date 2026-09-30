// The Command Queue's storage (Issue #145, decided on #125): the durable,
// ordered queue on a driver's device of the commands their taps produce, each
// kept until the server has answered it (CONTEXT.md, Command Queue). One
// IndexedDB database per origin with two stores:
//
//   installation — the device's id, `web-<uuid>`, minted once and read back
//                  on every later open. Clearing the site's data makes a new
//                  device, and the server's receipts keep the commands sent
//                  before idempotent all the same;
//   queue        — one row per command, keyed by that installation id and the
//                  command's own, so a row is written once at the tap and
//                  rewritten in place when its location arrives, and the key
//                  order — the UUIDv7 ids' — is the order of the taps.
//
// Only storage: what a row's state means, when the queue drains and what an
// answer does to it is the controller's (driver-app.ts). The factory is an
// argument, the browser's `indexedDB` in the page and fake-indexeddb's in the
// tests.
import { DRIVER_COMMAND_QUEUE_DATABASE } from "../storage-keys"
import type { PilotCommand } from "./commands"

const VERSION = 1
const INSTALLATION = "installation"
const QUEUE = "queue"
/** The installation store's one key. */
const DEVICE = "device"

/**
 * One queued command: whose tap it was (the signed-in login, `whoOf` in
 * lib/api/session.ts, so a phone handed to another driver never sends the
 * last one's commands under the new one's token), whether a location lookup
 * may still enrich it, and the envelope exactly as the door takes it.
 */
export type QueueEntry = {
  owner: string
  /** `location-pending` from the tap until the lookup answers or gives up; `ready` once it may be sent as it stands. */
  state: "location-pending" | "ready"
  command: PilotCommand
}

export type CommandQueueStore = {
  /** This installation's id, the envelope's `deviceId`. */
  readonly deviceId: string
  /** This installation's rows, in the order of their ids. */
  list: () => Promise<QueueEntry[]>
  /** Writes a row, or rewrites the one with its id. */
  put: (entry: QueueEntry) => Promise<void>
  remove: (ids: readonly string[]) => Promise<void>
  close: () => void
}

function settled(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error("the Command Queue's transaction was aborted"))
  })
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DRIVER_COMMAND_QUEUE_DATABASE, VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(INSTALLATION)) database.createObjectStore(INSTALLATION)
      if (!database.objectStoreNames.contains(QUEUE)) database.createObjectStore(QUEUE, { keyPath: ["command.deviceId", "command.id"] })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** The installation's id, minted inside the transaction that finds none, so two tabs opening at once agree on one. */
async function installationOf(database: IDBDatabase, mint: () => string): Promise<string> {
  const transaction = database.transaction(INSTALLATION, "readwrite")
  const store = transaction.objectStore(INSTALLATION)
  let deviceId: string | undefined
  const read = store.get(DEVICE)
  read.onsuccess = () => {
    if (typeof read.result === "string") {
      deviceId = read.result
      return
    }
    deviceId = mint()
    store.add(deviceId, DEVICE)
  }
  await settled(transaction)
  if (deviceId === undefined) throw new Error("the Command Queue's installation id was neither read nor minted")
  return deviceId
}

export async function openCommandQueue(factory: IDBFactory, { mintDeviceId = () => `web-${crypto.randomUUID()}` }: { mintDeviceId?: () => string } = {}): Promise<CommandQueueStore> {
  const database = await openDatabase(factory)
  // Another tab opening a later version waits on this one; let it through.
  database.onversionchange = () => database.close()
  const deviceId = await installationOf(database, mintDeviceId)

  const write = async (change: (store: IDBObjectStore) => void) => {
    const transaction = database.transaction(QUEUE, "readwrite")
    change(transaction.objectStore(QUEUE))
    await settled(transaction)
  }

  return {
    deviceId,
    list: async () => {
      const transaction = database.transaction(QUEUE, "readonly")
      const read = transaction.objectStore(QUEUE).getAll()
      await settled(transaction)
      return (read.result as QueueEntry[]).filter((entry) => entry.command.deviceId === deviceId)
    },
    put: (entry) => write((store) => store.put(entry)),
    remove: (ids) =>
      write((store) => {
        for (const id of ids) store.delete([deviceId, id])
      }),
    close: () => database.close(),
  }
}
