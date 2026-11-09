"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { toast } from "sonner"

import { createExternalStore, type ExternalStore } from "@/lib/external-store"
import {
  getModuleDefinition,
  type BusinessRecord,
  type WorkspaceId,
} from "@/lib/data/business-modules"
import {
  hasLegacyIds,
  migrateLegacyRecordBuckets,
} from "@/lib/data/legacy-ids"
import { problemSentence } from "@/lib/api/problem"
import { moduleKeyOf, type CommandInput, type Resolver } from "@/lib/api/records/adapter"
import { ME_PROJECTS } from "@/lib/api/records/me-projects"
import { serverModuleOf } from "@/lib/api/records/modules"
import { createRecordStore, type RecordStore, type RecordStoreNotices } from "@/lib/api/records/record-store"
import {
  IDLE,
  KEPT_ON_API,
  paneAnswerOf,
  readsChanged,
  resolverOver,
  type CommandOutcome,
  type ModuleState,
  type PaneAnswer,
  type RereadOutcome,
  type SendAction,
  type ServerRecordsState,
  type WriteOutcome,
} from "@/lib/api/records/server-records"
import { persistedStore } from "@/lib/persisted-store"
import { BUSINESS_RECORDS_STORAGE_KEY } from "@/lib/storage-keys"

import { useApiClient, useApiConfigured, useApiSession, useApiSessionIdentity } from "@/components/platform/api-session-store"

/**
 * Key renames specific to this store's records, on top of the shared map in
 * lib/data/legacy-ids.ts. Defensive only: no shipped form schema ever had a
 * bare `contractor` field (the access form's field is `serviceProviderId`,
 * which the shared map already covers), so no browser is known to hold this
 * key. It is kept because `organizationForRecord` in
 * lib/data/users-roles.ts (the Users & roles pane's fixture rows) reads
 * `submittedValues.serviceProvider`, and without an explicit entry a bare
 * `contractor` key would fall through to the token rewrite and become
 * `"service-provider"`, which nothing reads.
 */
const LEGACY_RECORD_KEY_RENAMES: Readonly<Record<string, string>> = {
  contractor: "serviceProvider",
}

type StoredRecords = Record<string, BusinessRecord[]>

type BusinessRecordStoreValue = {
  /**
   * A module's records: a switched module's the API's alone, once read, and
   * none before or where no API is configured; a module on fixtures its
   * fixtures merged with what the browser holds.
   */
  getRecords: (workspaceId: WorkspaceId, moduleId: string) => BusinessRecord[]
  /**
   * Saves a record. On a switched module, the write's outcome once the API
   * has answered — a caller that needs to know (a dialog that stays open on
   * a refusal) awaits it, and may say `report: false` to tell the person
   * itself instead of the store's toast; the rest of the workspace ignores
   * it. A `reason` travels with the write in the change-reason header, for
   * the API's audit log to keep beside it (#291); a module on fixtures has no log
   * and drops it. A write the API took whose answer could not be shown is `landed`,
   * told as saved whatever `report` says, and its module is read again. A
   * switched module the API has not read — no API configured, or a session
   * that has ended — refuses the write at once (`writeRouteOf`), never
   * keeping it in the browser. On a module on fixtures the record goes to
   * the browser's bucket, and there is nothing to await.
   */
  upsertRecord: (
    workspaceId: WorkspaceId,
    moduleId: string,
    record: BusinessRecord,
    options?: { report?: boolean; reason?: string },
  ) => Promise<WriteOutcome> | undefined
  /**
   * Sends one of a row's commands (`deactivate`, `reactivate`, …: the
   * adapter's `commands`) on a switched module that is ready, and puts the
   * API's answer in the row's place. `input` is what the command's dialog
   * says (a warehouse, a reason), which the command maps to its body. A
   * refusal is told to the person in the API's words, as a write's is, and
   * handed back.
   */
  sendCommand: (
    workspaceId: WorkspaceId,
    moduleId: string,
    recordId: string,
    name: string,
    input?: CommandInput,
  ) => Promise<CommandOutcome>
  /**
   * Sends one of a row's actions (the adapter's `actions`: a scheme's
   * generate) on a switched module that is ready, and hands back what it
   * answered — another resource; the row stays as it is. It takes its turn
   * on the row as a command does. A refusal is told in the API's words
   * unless `report: false` leaves that to the caller (a dialog that stays
   * open), and handed back. A page reaches an action through its adapter's
   * typed wrapper (`generateScheme`), never by name.
   */
  sendAction: SendAction
  /**
   * Reads one row of a switched module back from the API and puts it in
   * the row's place, for a row the server changed on its own account — a
   * scheme whose generation run has finished. It takes its turn on the row,
   * and a failed read leaves the row as it was.
   */
  refreshRecord: (
    workspaceId: WorkspaceId,
    moduleId: string,
    recordId: string,
  ) => Promise<RereadOutcome>
  /**
   * Reads a switched module again whole, as the store does after a command
   * that touches it (#213's re-read, the one read path), for a module whose
   * rows the server moves on its own account while a person watches it — the
   * Live board every 30 s. Only while the module is ready, and a failed read
   * leaves its rows as they were; nothing to do on any other module.
   */
  refreshModule: (workspaceId: WorkspaceId, moduleId: string) => Promise<void>
}

export type BusinessRecordStores = {
  records: ExternalStore<StoredRecords>
  /**
   * Flips to true once the provider has loaded localStorage. Effects that
   * write derived records must wait for it: child effects run before the
   * provider's load effect on mount, and a write planned before it would be
   * clobbered by the load.
   */
  hydrated: ExternalStore<boolean>
  /** The switched modules and what moves them (lib/api/records/record-store.ts): the server's half of the store. */
  api: RecordStore
}

// The context carries the stable store handles, never the state itself — see
// lib/external-store.ts for why (hydration safety under streaming SSR).
const BusinessRecordStoreContext = createContext<BusinessRecordStores | null>(
  null,
)

// The server (and every hydrating component) sees no browser records.
const EMPTY_STORED_RECORDS: StoredRecords = {}
const NO_RECORDS: readonly BusinessRecord[] = []

function moduleKey(workspaceId: WorkspaceId, moduleId: string) {
  return moduleKeyOf(workspaceId, moduleId)
}

function isStoredRecords(value: unknown): value is StoredRecords {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.values(value).every(
    (records) =>
      Array.isArray(records) &&
      records.every(
        (record) =>
          record &&
          typeof record === "object" &&
          typeof (record as BusinessRecord).id === "string" &&
          typeof (record as BusinessRecord).name === "string",
      ),
  )
}

/**
 * The records made and edited in the browser. Browsers that wrote records
 * before the Contractor → Service provider rename still hold the old bucket
 * keys ("contractors.contract-areas") and old ids inside records: they are
 * migrated on load, and the persist that follows writes the migrated payload
 * back. The migration is idempotent and returns the parsed object itself
 * when nothing is legacy.
 */
const storedRecords = persistedStore<StoredRecords>(BUSINESS_RECORDS_STORAGE_KEY, {
  parse: (raw) => {
    const parsed: unknown = JSON.parse(raw)
    if (!isStoredRecords(parsed)) return null
    return hasLegacyIds(raw) ? migrateLegacyRecordBuckets(parsed, LEGACY_RECORD_KEY_RENAMES) : parsed
  },
})

/** What the store tells a person, as toasts. */
const TOASTS: RecordStoreNotices = {
  // A refusal is told to the person in the API's words: the toast for a write or a read the API refused.
  refused: (what, problem) => {
    toast.error(what, { description: problemSentence(problem) })
  },
  // A write the API took whose answer could not be shown (#243): said as saved, never as a refusal, so nobody sends it again.
  landed: (name) => {
    toast.warning(`${name} was saved`, { description: "The API took it, but its answer could not be shown here; it is read again from the API." })
  },
  // A command whose movement landed but whose row could not be read, even again (#263): said as done, so nobody sends it a second time.
  landedCommand: (name) => {
    toast.warning(`${name} was changed`, { description: "The API took it, but the row could not be read back; do not send it again. It is read again from the API." })
  },
  // A write refused before it was sent, its module not read (#243): one toast for the module, which a sync of many of its rows replaces rather than stacks.
  unsent: (key, name, problem) => {
    toast.error(`${name} was not saved`, { id: `unsent-${key}`, description: problemSentence(problem) })
  },
}

/** The fixtures of a module still on the browser's path; a switched module has none. */
function fixturesOf(workspaceId: WorkspaceId, moduleId: string): readonly BusinessRecord[] {
  return getModuleDefinition({ workspaceId, moduleId })?.records ?? []
}

export function BusinessRecordStoreProvider({
  children,
}: {
  children: ReactNode
}) {
  const [stores] = useState<BusinessRecordStores>(() => ({
    records: createExternalStore<StoredRecords>(EMPTY_STORED_RECORDS),
    hydrated: createExternalStore(false),
    api: createRecordStore(TOASTS),
  }))
  const client = useApiClient()
  const identity = useApiSessionIdentity()
  const { loadMe } = useApiSession()

  // The current client, whatever token it carries, for a write or a load
  // that reads it when it runs.
  useEffect(() => {
    stores.api.client.set(client)
  }, [client, stores])

  useEffect(() => {
    const store = stores.records
    const stored = storedRecords.read()
    if (stored !== null) store.set(stored)
    stores.hydrated.set(true)
    const persist = () => {
      storedRecords.write(store.getSnapshot())
    }
    persist()
    return store.subscribe(persist)
  }, [stores])

  // The switched modules follow the session, not the token: read again only
  // when the API or the person changes (`useApiSessionIdentity`, `startSession`).
  useEffect(() => stores.api.startSession(identity !== null, loadMe), [identity, stores, loadMe])

  // The watcher: what a module's last read read, and the day it read (`watchReads`).
  useEffect(() => stores.api.watch(), [stores])

  return (
    <BusinessRecordStoreContext.Provider value={stores}>
      {children}
    </BusinessRecordStoreContext.Provider>
  )
}

/** True once stored records have been loaded — see BusinessRecordStores. */
export function useBusinessRecordsHydrated(): boolean {
  const stores = useContext(BusinessRecordStoreContext)
  if (!stores) {
    throw new Error(
      "useBusinessRecordsHydrated must be used within BusinessRecordStoreProvider",
    )
  }
  return useSyncExternalStore(
    stores.hydrated.subscribe,
    stores.hydrated.getSnapshot,
    stores.hydrated.getServerSnapshot,
  )
}

export function useBusinessRecordStore(): BusinessRecordStoreValue {
  const stores = useContext(BusinessRecordStoreContext)
  if (!stores) {
    throw new Error(
      "useBusinessRecordStore must be used within BusinessRecordStoreProvider",
    )
  }
  const store = stores.records
  const storedRecords = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  )
  const serverModules = useSyncExternalStore(
    stores.api.server.subscribe,
    stores.api.server.getSnapshot,
    stores.api.server.getServerSnapshot,
  )
  const apiConfigured = useApiConfigured()
  /** The switched module's state, or null for a module still on the browser's own path. */
  const serverModuleState = useCallback(
    (workspaceId: WorkspaceId, moduleId: string): ModuleState | null => switchedModuleState(serverModules, apiConfigured, workspaceId, moduleId),
    [serverModules, apiConfigured],
  )

  const getRecords = useCallback(
    (workspaceId: WorkspaceId, moduleId: string) => {
      // A switched module answers the server's rows once they are here, and
      // nothing else: never the browser's own bucket (Issue #81).
      const server = serverModuleState(workspaceId, moduleId)
      if (server !== null) return server.status === "ready" ? server.records : []

      const fixtureRecords = fixturesOf(workspaceId, moduleId)
      const stored = storedRecords[moduleKey(workspaceId, moduleId)] ?? []
      const storedById = new Map(stored.map((record) => [record.id, record]))
      const fixtureIds = new Set(fixtureRecords.map((record) => record.id))
      const createdRecords = stored.filter((record) => !fixtureIds.has(record.id))
      const mergedFixtures = fixtureRecords.map(
        (record) => storedById.get(record.id) ?? record,
      )

      return [...createdRecords, ...mergedFixtures]
    },
    [serverModuleState, storedRecords],
  )

  const upsertRecord = useCallback(
    (workspaceId: WorkspaceId, moduleId: string, record: BusinessRecord, options?: { report?: boolean; reason?: string }) => {
      const key = moduleKey(workspaceId, moduleId)
      const label = serverModuleOf(workspaceId, moduleId) === undefined ? key : (getModuleDefinition({ workspaceId, moduleId })?.label ?? key)
      const written = stores.api.write(workspaceId, moduleId, record, { apiConfigured, label }, options)
      if (written !== undefined) return written

      // The browser's own path: a module on fixtures.
      store.set((current) => {
        const existing = current[key] ?? []
        const hasRecord = existing.some((candidate) => candidate.id === record.id)
        return {
          ...current,
          [key]: hasRecord
            ? existing.map((candidate) =>
                candidate.id === record.id ? record : candidate,
              )
            : [record, ...existing],
        }
      })
      return undefined
    },
    [apiConfigured, store, stores],
  )

  const sendCommand = useCallback(
    (workspaceId: WorkspaceId, moduleId: string, recordId: string, name: string, input?: CommandInput): Promise<CommandOutcome> => stores.api.sendCommand(workspaceId, moduleId, recordId, name, input),
    [stores],
  )

  const sendAction = useCallback<SendAction>((...request) => stores.api.sendAction(...request), [stores])

  const refreshRecord = useCallback(
    (workspaceId: WorkspaceId, moduleId: string, recordId: string): Promise<RereadOutcome> => stores.api.refreshRecord(workspaceId, moduleId, recordId),
    [stores],
  )

  const refreshModule = useCallback((workspaceId: WorkspaceId, moduleId: string): Promise<void> => stores.api.refreshModule(workspaceId, moduleId), [stores])

  return useMemo(
    () => ({ getRecords, upsertRecord, sendCommand, sendAction, refreshRecord, refreshModule }),
    [getRecords, upsertRecord, sendCommand, sendAction, refreshRecord, refreshModule],
  )
}

/** The person's projects from `/me` where the role does not view the organisation (Issue #217), as the resolver reads them; none otherwise. */
export function useMeProjects(): readonly BusinessRecord[] {
  const stores = useContext(BusinessRecordStoreContext)
  if (!stores) {
    throw new Error("useMeProjects must be used within BusinessRecordStoreProvider")
  }
  const serverModules = useSyncExternalStore(
    stores.api.server.subscribe,
    stores.api.server.getSnapshot,
    stores.api.server.getServerSnapshot,
  )
  return serverModules.get(ME_PROJECTS)?.records ?? NO_RECORDS
}

/** A switched module's state as the store holds it, `KEPT_ON_API` where no API is configured; null for a module on the browser's own path. */
function switchedModuleState(serverModules: ServerRecordsState, apiConfigured: boolean, workspaceId: WorkspaceId, moduleId: string): ModuleState | null {
  if (serverModuleOf(workspaceId, moduleId) === undefined) return null
  if (!apiConfigured) return KEPT_ON_API
  return serverModules.get(moduleKey(workspaceId, moduleId)) ?? IDLE
}

/**
 * The state of a switched module — idle, not granted, loading, ready,
 * failed or kept on the API, with its problem — or null for a module on the
 * browser's own path.
 */
export function useServerModuleState(workspaceId: WorkspaceId, moduleId: string): ModuleState | null {
  const stores = useContext(BusinessRecordStoreContext)
  if (!stores) {
    throw new Error(
      "useServerModuleState must be used within BusinessRecordStoreProvider",
    )
  }
  const serverModules = useSyncExternalStore(
    stores.api.server.subscribe,
    stores.api.server.getSnapshot,
    stores.api.server.getServerSnapshot,
  )
  return switchedModuleState(serverModules, useApiConfigured(), workspaceId, moduleId)
}

/**
 * Whether the store's read of a switched module is behind: something its
 * last read's mapping read has moved since (`readsChanged`), so the store is
 * about to read it again. False for a module on the browser's own path.
 */
export function useReadBehind(workspaceId: WorkspaceId, moduleId: string): boolean {
  const stores = useContext(BusinessRecordStoreContext)
  if (!stores) {
    throw new Error("useReadBehind must be used within BusinessRecordStoreProvider")
  }
  const serverModules = useSyncExternalStore(stores.api.server.subscribe, stores.api.server.getSnapshot, stores.api.server.getServerSnapshot)
  return useApiConfigured() && readsChanged(serverModules, moduleKey(workspaceId, moduleId)).length > 0
}

/**
 * A resolver over every switched module as the store holds it now, for a
 * pane that names rows of any module by server id: a record's history, whose
 * changes point at rows of other modules (#291).
 */
export function useServerResolver(): Resolver {
  const stores = useContext(BusinessRecordStoreContext)
  if (!stores) {
    throw new Error("useServerResolver must be used within BusinessRecordStoreProvider")
  }
  const serverModules = useSyncExternalStore(stores.api.server.subscribe, stores.api.server.getSnapshot, stores.api.server.getServerSnapshot)
  return useMemo(() => resolverOver(serverModules), [serverModules])
}

/**
 * The records a pane lists. On the browser's own path, `getRecords` as ever.
 * A switched module's rows once they are here and nothing before, with the
 * load's state beside them, for the pane's empty row and its create button
 * (Issue #163's rule for Settings › Users & roles, here for every pane that
 * reads a module): a module the person's role does not view is not pending,
 * its problem says so, and nobody is toasted (`paneAnswerOf`, Issue #200);
 * where no API is configured its problem is that the API keeps it.
 */
export function useModuleRecords(workspaceId: WorkspaceId, moduleId: string): PaneAnswer {
  const state = useServerModuleState(workspaceId, moduleId)
  const { getRecords } = useBusinessRecordStore()
  if (state !== null) return paneAnswerOf(state)
  return { records: getRecords(workspaceId, moduleId), ready: true, pending: false, notGranted: false, problem: null }
}

/**
 * How a pane waits on a write's outcome — the one way. On the Pilot
 * `upsertRecord` answers once the API has, so the dialog stays open and the
 * success is said only then; a refusal is the store's toast, in the API's
 * words, over the form still holding what was typed, and `done` never runs.
 * `settled`, when given, runs either way once the answer is in — for a pane
 * that holds its form against a second submit while the first is out. On
 * the browser's own path there is nothing to wait for, and both run at once.
 * `done` is handed the outcome (undefined on the browser's path), for a pane
 * that says what the row now is (`savedRow`) or that nothing moved.
 */
export function whenSaved(outcome: Promise<WriteOutcome> | undefined, done: (saved: SavedOutcome | undefined) => void, settled?: () => void): void {
  if (outcome === undefined) {
    done(undefined)
    settled?.()
    return
  }
  void outcome.then(
    (result) => {
      settled?.()
      if (result.kind !== "refused") done(result)
    },
    // A write that threw instead of answering — a store fault, never the API's word — frees the pane and says so (#263).
    () => {
      settled?.()
      toast.error("The write did not complete", { description: "Nothing was saved that the page can show; try again." })
    },
  )
}

/** A write's outcome other than a refusal: what `whenSaved` hands `done`. */
export type SavedOutcome = Exclude<WriteOutcome, { kind: "refused" }>

/**
 * The row a saved write left, under the id the store holds it by: the API's
 * answer, mapped — a create's under the id the workspace minted, as
 * `withCreated` files it — or, on the browser's path or where the API took
 * the write but its answer could not be shown, the row as written.
 */
export function savedRow(saved: SavedOutcome | undefined, written: BusinessRecord): BusinessRecord {
  if (saved === undefined || saved.kind === "landed") return written
  return saved.kind === "created" ? { ...saved.record, id: saved.optimisticId } : saved.record
}
