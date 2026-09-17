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
import {
  getWorkspaceDefinition,
  type BusinessRecord,
} from "@/lib/data/business-modules"
import { migrateLegacyState } from "@/lib/data/legacy-ids"
import {
  activeRoutes,
  serviceProviderActiveRoutes,
  type ActiveRouteSummary,
} from "@/lib/data/sidebar"

const STORAGE_KEY = "wastehero-active-routes-v1"
// The service provider pins shipped first under their own key; keep reading it
// so stars saved before the operator scope existed survive the upgrade. The
// key literal predates the Contractor → Service provider rename and stays as
// written — it names what browsers already hold.
const LEGACY_SERVICE_PROVIDER_STORAGE_KEY = "wastehero-contractor-active-routes-v1"
// State persisted before that rename keyed the second scope by the old
// persona name. lib/data/legacy-ids.ts leaves this bare key to each store
// (it means a scope here and a field elsewhere), so the mapping lives here.
const LEGACY_SCOPE_KEYS: Readonly<Record<string, string>> = {
  contractor: "service-provider",
}

/**
 * Each signed-in persona pins routes to its own sidebar: the operator
 * (Operations manager) and the service provider manager star independently.
 */
export type ActiveRoutesScope = "operator" | "service-provider"

type StarredRoutesState = Record<ActiveRoutesScope, string[]>

// The server (and every hydrating component) sees the fixture pins only.
const DEFAULT_STARRED_ROUTES: StarredRoutesState = {
  operator: activeRoutes.map((route) => route.id),
  "service-provider": serviceProviderActiveRoutes.map((route) => route.id),
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

function loadStoredState(): StarredRoutesState | null {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  const parsed: unknown = raw ? JSON.parse(raw) : null
  // Idempotent: state already in the current shape passes through unchanged,
  // so this runs on every load rather than behind a version flag.
  const migrated = migrateLegacyState(parsed, LEGACY_SCOPE_KEYS)
  if (isStarredRoutesState(migrated)) return migrated
  const legacyRaw = window.localStorage.getItem(LEGACY_SERVICE_PROVIDER_STORAGE_KEY)
  const legacyParsed: unknown = legacyRaw ? JSON.parse(legacyRaw) : null
  if (isRouteIdList(legacyParsed)) {
    return { ...DEFAULT_STARRED_ROUTES, "service-provider": legacyParsed }
  }
  return null
}

export function ActiveRoutesStoreProvider({
  children,
}: {
  children: ReactNode
}) {
  const [store] = useState(() =>
    createExternalStore<StarredRoutesState>(DEFAULT_STARRED_ROUTES),
  )

  useEffect(() => {
    try {
      const stored = loadStoredState()
      if (stored) store.set(stored)
    } catch {
      // A corrupt or unavailable browser store keeps the fixture pins.
    }
    const persist = () => {
      try {
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify(store.getSnapshot()),
        )
      } catch {
        // In-memory stars remain usable when persistence is blocked.
      }
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

/** Fixture route days backing the Route Studio routes table. */
export const routeDayFixtures: readonly BusinessRecord[] =
  getWorkspaceDefinition("route-studio").modules.find(
    (module) => module.id === "routes",
  )?.records ?? []

const curatedSummariesByScope: Record<
  ActiveRoutesScope,
  Map<string, ActiveRouteSummary>
> = {
  operator: new Map(activeRoutes.map((route) => [route.id, route])),
  "service-provider": new Map(serviceProviderActiveRoutes.map((route) => [route.id, route])),
}

const routesTableHrefByScope: Record<ActiveRoutesScope, string> = {
  operator: "/route-studio?module=routes&record=",
  "service-provider": "/service-provider-workspace/routes?module=routes&record=",
}

const ROUTE_PIN_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

/**
 * Sidebar summary for a starred route day that has no curated fixture entry.
 * Route records carry no live completion figure, so progress falls back to a
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
    href: `${routesTableHrefByScope[scope]}${record.id}`,
  }
}

/**
 * Sidebar entries for a scope's starred routes, in starring order: fixture
 * pins keep their curated summary; other ids are summarized from their route
 * record and dropped when no record exists (e.g. a deleted created route).
 */
export function resolveActiveRouteSummaries(
  starredRouteIds: readonly string[],
  routeRecords: readonly BusinessRecord[],
  scope: ActiveRoutesScope,
): ActiveRouteSummary[] {
  const curated = curatedSummariesByScope[scope]
  return starredRouteIds.flatMap((routeId) => {
    const curatedSummary = curated.get(routeId)
    if (curatedSummary) return [curatedSummary]
    const record = routeRecords.find((candidate) => candidate.id === routeId)
    return record ? [summarizeStarredRoute(record, scope)] : []
  })
}
