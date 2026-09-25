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
import type { ApiClient } from "@/lib/api/client"
import { problemSentence, type Problem } from "@/lib/api/problem"
import { moduleKeyOf } from "@/lib/api/records/adapter"
import { SERVER_MODULES, serverModuleOf } from "@/lib/api/records/modules"
import {
  IDLE,
  loadFailed,
  loadModule,
  loaded,
  loading,
  problemOfError,
  recordsOf,
  withCreated,
  withRecord,
  writeRecord,
  type ModuleState,
  type ServerRecordsState,
} from "@/lib/api/records/server-records"
import {
  BUSINESS_RECORDS_STORAGE_KEY,
  readPersisted,
} from "@/lib/storage-keys"

import { useApiClient } from "./api-session-store"

/**
 * Key renames specific to this store's records, on top of the shared map in
 * lib/data/legacy-ids.ts. Defensive only: no shipped form schema ever had a
 * bare `contractor` field (the access form's field is `serviceProviderId`,
 * which the shared map already covers), so no browser is known to hold this
 * key. It is kept because `organizationForRecord` in
 * components/settings/organization-access-management.tsx reads
 * `submittedValues.serviceProvider`, and without an explicit entry a bare
 * `contractor` key would fall through to the token rewrite and become
 * `"service-provider"`, which nothing reads.
 */
const LEGACY_RECORD_KEY_RENAMES: Readonly<Record<string, string>> = {
  contractor: "serviceProvider",
}

type StoredRecords = Record<string, BusinessRecord[]>

type BusinessRecordStoreValue = {
  getRecords: (
    workspaceId: WorkspaceId,
    moduleId: string,
    fixtureRecords: readonly BusinessRecord[],
  ) => BusinessRecord[]
  upsertRecord: (
    workspaceId: WorkspaceId,
    moduleId: string,
    record: BusinessRecord,
  ) => void
}

type BusinessRecordStores = {
  records: ExternalStore<StoredRecords>
  /**
   * Flips to true once the provider has loaded localStorage. Effects that
   * write derived records (Plan Ahead auto-generation) must wait for it:
   * child effects run before the provider's load effect on mount, and a
   * write planned against fixture-only state would be clobbered by the load.
   */
  hydrated: ExternalStore<boolean>
  /**
   * The server-backed modules (Issue #81): one entry per switched
   * `workspace.module`, keyed like the records above, each the server's rows
   * as the prototype shows them once its read has landed. Empty while the
   * adapter is off or nobody is signed in, so every module reads the
   * browser's own path then — and a write made in that window goes to the
   * browser's bucket, which a switched module stops reading once the
   * server has answered.
   */
  server: ExternalStore<ServerRecordsState>
  /** The client the writes go through; null when there is none. Held here so `upsertRecord` reads the current one when it runs. */
  client: ExternalStore<ApiClient | null>
  /**
   * Writes in flight, by web id, so a second save of a row whose first has
   * not answered waits its turn rather than racing it to the API. One map
   * for the whole store, since two components may write the same row.
   */
  pendingWrites: Map<string, Promise<void>>
}

// The context carries the stable store handles, never the state itself — see
// lib/external-store.ts for why (hydration safety under streaming SSR).
const BusinessRecordStoreContext = createContext<BusinessRecordStores | null>(
  null,
)

// The server (and every hydrating component) sees fixtures only.
const EMPTY_STORED_RECORDS: StoredRecords = {}
const NO_SERVER_MODULES: ServerRecordsState = new Map()

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

/** A refusal is told to the person in the API's words: the toast for a write or a read the API refused. */
function reportProblem(what: string, problem: Problem) {
  toast.error(what, { description: problemSentence(problem) })
}

/** The fixtures of a module, the seed's origin, which every mapping matches by name. */
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
    server: createExternalStore<ServerRecordsState>(NO_SERVER_MODULES),
    client: createExternalStore<ApiClient | null>(null),
    pendingWrites: new Map(),
  }))
  const client = useApiClient()

  useEffect(() => {
    const store = stores.records
    try {
      const raw = readPersisted(
        window.localStorage,
        BUSINESS_RECORDS_STORAGE_KEY,
      )
      const parsed: unknown = raw ? JSON.parse(raw) : null
      if (isStoredRecords(parsed)) {
        // Browsers that wrote records before the Contractor → Service provider
        // rename still hold the old bucket keys ("contractors.contract-areas")
        // and old ids inside records. Migrate once on load; the migration is
        // idempotent and returns the parsed object itself when nothing is
        // legacy, and the persist below writes the migrated payload back.
        store.set(
          raw && hasLegacyIds(raw)
            ? migrateLegacyRecordBuckets(parsed, LEGACY_RECORD_KEY_RENAMES)
            : parsed,
        )
      }
    } catch {
      // A corrupt or unavailable browser store should not block the workspace.
    }
    stores.hydrated.set(true)
    const persist = () => {
      try {
        window.localStorage.setItem(
          BUSINESS_RECORDS_STORAGE_KEY,
          JSON.stringify(store.getSnapshot()),
        )
      } catch {
        // The in-memory record graph remains usable when persistence is blocked.
      }
    }
    persist()
    return store.subscribe(persist)
  }, [stores])

  // The server-backed modules follow the client: a new token reloads them,
  // and no client (signed out, adapter off) empties them, so every module
  // reads the browser's own path again. The switched modules load in
  // SERVER_MODULES' order, one after the other, since a later module's
  // mapping resolves the earlier ones' rows (a user names its role and its
  // projects); each lands as it arrives, and a module that fails is reported
  // once and left on its fixtures.
  useEffect(() => {
    const server = stores.server
    stores.client.set(client)
    if (client === null) {
      server.set(NO_SERVER_MODULES)
      return
    }
    let cancelled = false
    const run = async () => {
      for (const module of SERVER_MODULES) {
        if (cancelled) return
        const key = moduleKey(module.workspaceId, module.moduleId)
        server.set((current) => new Map(current).set(key, loading(current.get(key) ?? IDLE)))
        try {
          const result = await loadModule(client, module, { fixtures: fixturesOf(module.workspaceId, module.moduleId), state: server.getSnapshot() })
          if (cancelled) return
          server.set((current) => new Map(current).set(key, loaded(result, Date.now())))
        } catch (error) {
          if (cancelled) return
          const problem = problemOfError(error)
          server.set((current) => new Map(current).set(key, loadFailed(current.get(key) ?? IDLE, problem)))
          reportProblem(`${key} could not be read from the API`, problem)
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [client, stores])

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
    stores.server.subscribe,
    stores.server.getSnapshot,
    stores.server.getServerSnapshot,
  )
  /** The switched module's state, or null for a module still on the browser's own path. */
  const serverModuleState = useCallback(
    (workspaceId: WorkspaceId, moduleId: string): ModuleState | null =>
      serverModuleOf(workspaceId, moduleId) === undefined ? null : (serverModules.get(moduleKey(workspaceId, moduleId)) ?? IDLE),
    [serverModules],
  )

  const getRecords = useCallback(
    (
      workspaceId: WorkspaceId,
      moduleId: string,
      fixtureRecords: readonly BusinessRecord[],
    ) => {
      // A switched module answers the server's rows once they are here and
      // the fixtures until then — never a mixture with the browser's own
      // bucket, whose records were made against a store that no longer
      // decides (Issue #81).
      const server = serverModuleState(workspaceId, moduleId)
      if (server !== null && server.status === "ready") return recordsOf(server, fixtureRecords)

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
    (workspaceId: WorkspaceId, moduleId: string, record: BusinessRecord) => {
      const key = moduleKey(workspaceId, moduleId)
      const module = serverModuleOf(workspaceId, moduleId)
      const serverStore = stores.server
      const current = module === undefined ? undefined : serverStore.getSnapshot().get(key)
      const client = stores.client.getSnapshot()

      if (module !== undefined && current !== undefined && current.status === "ready" && client !== null) {
        // Optimistic and reconciled: the row shows what was saved at once,
        // the API's answer replaces it, a refusal puts the row back and
        // tells the person why in the API's words.
        const before = current.records.find((candidate) => candidate.id === record.id)
        serverStore.set((state) => new Map(state).set(key, withRecord(state.get(key) ?? current, record)))
        const run = async () => {
          const outcome = await writeRecord(client, module, current, record, { fixtures: fixturesOf(workspaceId, moduleId), state: serverStore.getSnapshot() })
          serverStore.set((state) => {
            const latest = state.get(key) ?? current
            switch (outcome.kind) {
              case "created":
                return new Map(state).set(key, withCreated(latest, outcome.optimisticId, outcome.record, outcome.serverId))
              case "updated":
                return new Map(state).set(key, withRecord(latest, outcome.record, outcome.serverId))
              case "unchanged":
                return state
              case "refused": {
                const restored =
                  before === undefined
                    ? { ...latest, records: latest.records.filter((candidate) => candidate.id !== outcome.recordId) }
                    : withRecord(latest, before)
                return new Map(state).set(key, { ...restored, problem: outcome.problem })
              }
            }
          })
          if (outcome.kind === "refused") reportProblem(`${record.name} was not saved`, outcome.problem)
        }
        const pending = stores.pendingWrites
        const previous = pending.get(record.id) ?? Promise.resolve()
        const next: Promise<void> = previous.then(run, run).finally(() => {
          if (pending.get(record.id) === next) pending.delete(record.id)
        })
        pending.set(record.id, next)
        return
      }

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
    },
    [store, stores],
  )

  return useMemo(
    () => ({ getRecords, upsertRecord }),
    [getRecords, upsertRecord],
  )
}
