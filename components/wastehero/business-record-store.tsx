"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import type {
  BusinessRecord,
  WorkspaceId,
} from "@/lib/data/business-modules"

const STORAGE_KEY = "wastehero-business-records-v1"

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

const BusinessRecordStoreContext =
  createContext<BusinessRecordStoreValue | null>(null)

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
  const [storedRecords, setStoredRecords] = useState<StoredRecords>({})
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      const parsed: unknown = raw ? JSON.parse(raw) : null
      if (isStoredRecords(parsed)) setStoredRecords(parsed)
    } catch {
      // A corrupt or unavailable browser store should not block the workspace.
    } finally {
      setHydrated(true)
    }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(storedRecords))
    } catch {
      // The in-memory record graph remains usable when persistence is blocked.
    }
  }, [hydrated, storedRecords])

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
      setStoredRecords((current) => {
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
    [],
  )

  const value = useMemo(
    () => ({ getRecords, upsertRecord }),
    [getRecords, upsertRecord],
  )

  return (
    <BusinessRecordStoreContext.Provider value={value}>
      {children}
    </BusinessRecordStoreContext.Provider>
  )
}

export function useBusinessRecordStore() {
  const value = useContext(BusinessRecordStoreContext)
  if (!value) {
    throw new Error(
      "useBusinessRecordStore must be used within BusinessRecordStoreProvider",
    )
  }
  return value
}
