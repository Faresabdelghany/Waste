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
import { ROUTES_MODULE } from "@/lib/data/routes"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { migrateLegacyState } from "@/lib/data/legacy-ids"
import type { ActiveRouteSummary } from "@/lib/data/sidebar"
import { workspaceHref } from "@/lib/data/workspace-href"
import { providerPagePath } from "@/lib/modules/provider-pages"
import { persistedStore } from "@/lib/persisted-store"
import { ACTIVE_ROUTES_STORAGE_KEY } from "@/lib/storage-keys"

// Two generations of this store live behind the current key (see
// lib/storage-keys.ts): the pins the service provider saved before the
// operator scope existed, a bare route-id list, and the two-scope object that
// replaced it. `readPersisted` hands over whichever the browser holds and
// `storedStarredRoutes` recognises both shapes. The chain stops at the first key
// that holds anything, so a newer key with an unreadable value is not backed
// out of into an older one: no writer ever produced such a value, and no pins
// are the better answer to a corrupt newer store than pins the user last saw
// generations ago.
//
// State persisted before the Contractor → Service provider rename keyed the
// second scope by the old persona name. lib/data/legacy-ids.ts leaves this
// bare key to each store (it means a scope here and a field elsewhere), so
// the mapping lives here.
const LEGACY_SCOPE_KEYS: Readonly<Record<string, string>> = {
  contractor: "service-provider",
}

/**
 * Each signed-in persona pins routes to its own sidebar: the operator
 * (Operations manager) and the service provider manager star independently.
 */
export type ActiveRoutesScope = "operator" | "service-provider"

type StarredRoutesState = Record<ActiveRoutesScope, string[]>

// The server (and every hydrating component) sees no pins.
const DEFAULT_STARRED_ROUTES: StarredRoutesState = {
  operator: [],
  "service-provider": [],
}

type ActiveRoutesValue = {
  /** Route ids pinned to this scope's sidebar, in starring order. */
  starredRouteIds: string[]
  isRouteStarred: (routeId: string) => boolean
  toggleRouteStarred: (routeId: string) => void
}

// The context carries the stable store handle, never the state itself — see
// lib/external-store.ts for why (hydration safety under streaming SSR).
const ActiveRoutesContext =
  createContext<ExternalStore<StarredRoutesState> | null>(null)

function isRouteIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string")
}

function isStarredRoutesState(value: unknown): value is StarredRoutesState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const state = value as Partial<StarredRoutesState>
  return isRouteIdList(state.operator) && isRouteIdList(state["service-provider"])
}

const storedStarredRoutes = persistedStore<StarredRoutesState>(ACTIVE_ROUTES_STORAGE_KEY, {
  parse: (raw) => {
    // Idempotent: state already in the current shape passes through unchanged,
    // so this runs on every load rather than behind a version flag.
    const migrated = migrateLegacyState(JSON.parse(raw) as unknown, LEGACY_SCOPE_KEYS)
    if (isStarredRoutesState(migrated)) return migrated
    // The oldest generation held the service provider's pins alone.
    if (isRouteIdList(migrated)) {
      return { ...DEFAULT_STARRED_ROUTES, "service-provider": migrated }
    }
    return null
  },
})

export function ActiveRoutesStoreProvider({
  children,
}: {
  children: ReactNode
}) {
  const [store] = useState(() =>
    createExternalStore<StarredRoutesState>(DEFAULT_STARRED_ROUTES),
  )

  useEffect(() => {
    const stored = storedStarredRoutes.read()
    if (stored) store.set(stored)
    const persist = () => {
      storedStarredRoutes.write(store.getSnapshot())
    }
    // Persist once right after loading — so a migrated legacy shape is written
    // back in the current shape immediately — and then on every change.
    persist()
    return store.subscribe(persist)
  }, [store])

  return (
    <ActiveRoutesContext.Provider value={store}>
      {children}
    </ActiveRoutesContext.Provider>
  )
}

export function useActiveRoutes(scope: ActiveRoutesScope): ActiveRoutesValue {
  const store = useContext(ActiveRoutesContext)
  if (!store) {
    throw new Error(
      "useActiveRoutes must be used within ActiveRoutesStoreProvider",
    )
  }
  const starredRoutes = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  )
  const starredRouteIds = starredRoutes[scope]

  const isRouteStarred = useCallback(
    (routeId: string) => starredRouteIds.includes(routeId),
    [starredRouteIds],
  )

  const toggleRouteStarred = useCallback(
    (routeId: string) => {
      store.set((current) => ({
        ...current,
        [scope]: current[scope].includes(routeId)
          ? current[scope].filter((id) => id !== routeId)
          : [...current[scope], routeId],
      }))
    },
    [scope, store],
  )

  return useMemo(
    () => ({ starredRouteIds, isRouteStarred, toggleRouteStarred }),
    [starredRouteIds, isRouteStarred, toggleRouteStarred],
  )
}

/** Where a scope's routes are shown: the provider's own routes page, or Route Studio's. */
const routesPageByScope: Record<ActiveRoutesScope, string | undefined> = {
  operator: undefined,
  "service-provider": providerPagePath("routes"),
}

const ROUTE_PIN_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

/**
 * Sidebar summary for a starred route day. Route records carry no live completion figure, so progress falls back to a
 * lifecycle-based placeholder (parseable "n/m stops" values win when present).
 */
function summarizeStarredRoute(
  record: BusinessRecord,
  scope: ActiveRoutesScope,
): ActiveRouteSummary {
  const area = record.facts["Area"]?.trim()
  const completedStops = record.value.match(/(\d+)\s*\/\s*(\d+)/)
  const progress = completedStops
    ? Math.round(
        (Number(completedStops[1]) / Math.max(Number(completedStops[2]), 1)) *
          100,
      )
    : /^(completed|approved)$/i.test(record.status)
      ? 100
      : /^active$/i.test(record.status)
        ? 50
        : 0
  const colorSeed = [...record.id].reduce(
    (sum, char) => sum + char.charCodeAt(0),
    0,
  )
  return {
    id: record.id,
    name: area ? `${area} · ${record.name}` : record.name,
    color: ROUTE_PIN_COLORS[colorSeed % ROUTE_PIN_COLORS.length],
    progress,
    href: workspaceHref(ROUTES_MODULE, record.id, { page: routesPageByScope[scope] }),
  }
}

/**
 * Sidebar entries for a scope's starred routes, in starring order, each
 * summarized from its route record (`routeRecords`, the API's rows alone):
 * a pin is a route the API holds, else nothing (#248).
 */
export function resolveActiveRouteSummaries(
  starredRouteIds: readonly string[],
  routeRecords: readonly BusinessRecord[],
  scope: ActiveRoutesScope,
): ActiveRouteSummary[] {
  return starredRouteIds.flatMap((routeId) => {
    const record = routeRecords.find((candidate) => candidate.id === routeId)
    return record ? [summarizeStarredRoute(record, scope)] : []
  })
}
