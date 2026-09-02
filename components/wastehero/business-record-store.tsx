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

import { createExternalStore, type ExternalStore } from "@/lib/external-store"
import type {
  BusinessRecord,
  WorkspaceId,
} from "@/lib/data/business-modules"
import {
  hasLegacyIds,
  migrateLegacyRecordBuckets,
} from "@/lib/data/legacy-ids"

const STORAGE_KEY = "wastehero-business-records-v1"

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
}

// The context carries the stable store handles, never the state itself — see
// lib/external-store.ts for why (hydration safety under streaming SSR).
const BusinessRecordStoreContext = createContext<BusinessRecordStores | null>(
  null,
)

// The server (and every hydrating component) sees fixtures only.
const EMPTY_STORED_RECORDS: StoredRecords = {}

function moduleKey(workspaceId: WorkspaceId, moduleId: string) {
  return `${workspaceId}.${moduleId}`
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

export function BusinessRecordStoreProvider({
  children,
}: {
  children: ReactNode
}) {
  const [stores] = useState<BusinessRecordStores>(() => ({
    records: createExternalStore<StoredRecords>(EMPTY_STORED_RECORDS),
    hydrated: createExternalStore(false),
  }))

  useEffect(() => {
    const store = stores.records
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
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
          STORAGE_KEY,
          JSON.stringify(store.getSnapshot()),
        )
      } catch {
        // The in-memory record graph remains usable when persistence is blocked.
      }
    }
    persist()
    return store.subscribe(persist)
  }, [stores])

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

  const getRecords = useCallback(
    (
      workspaceId: WorkspaceId,
      moduleId: string,
      fixtureRecords: readonly BusinessRecord[],
    ) => {
      const stored = storedRecords[moduleKey(workspaceId, moduleId)] ?? []
      const storedById = new Map(stored.map((record) => [record.id, record]))
      const fixtureIds = new Set(fixtureRecords.map((record) => record.id))
      const createdRecords = stored.filter((record) => !fixtureIds.has(record.id))
      const mergedFixtures = fixtureRecords.map(
        (record) => storedById.get(record.id) ?? record,
      )

      return [...createdRecords, ...mergedFixtures]
    },
    [storedRecords],
  )

  const upsertRecord = useCallback(
    (workspaceId: WorkspaceId, moduleId: string, record: BusinessRecord) => {
      const key = moduleKey(workspaceId, moduleId)
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
    [store],
  )

  return useMemo(
    () => ({ getRecords, upsertRecord }),
    [getRecords, upsertRecord],
  )
}
