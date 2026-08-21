"use client"

// Settings → Commercial registries: zones, service levels, customer types
// and price lists managed as real entities (Asset-management style) instead
// of the read-only constants they replaced. Price Engine consumes them as
// select options (business-workspace.tsx injects them into the Add price and
// product forms), so names double as the condition values stored on price
// rows and product facts — a price list's name IS the row's "Price list" tag.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

export type RegistryStatus = "Active" | "Inactive"

export type PricingZone = {
  id: string
  name: string
  description: string
  status: RegistryStatus
  createdAt: string
  updatedAt: string
}

export type ServiceLevel = {
  id: string
  name: string
  code: string
  description: string
  status: RegistryStatus
  createdAt: string
  updatedAt: string
}

export type CustomerTypeEntry = {
  id: string
  name: string
  description: string
  status: RegistryStatus
  createdAt: string
  updatedAt: string
}

export type PriceListEntry = {
  id: string
  name: string
  description: string
  effectiveFrom: string
  status: RegistryStatus
  createdAt: string
  updatedAt: string
}

export type CommercialRegistriesState = {
  zones: PricingZone[]
  serviceLevels: ServiceLevel[]
  customerTypes: CustomerTypeEntry[]
  priceLists: PriceListEntry[]
}

type EntityWithId = { id: string }

type CommercialRegistriesStoreValue = CommercialRegistriesState & {
  hydrated: boolean
  saveZone: (value: PricingZone) => void
  deleteZone: (id: string) => void
  saveServiceLevel: (value: ServiceLevel) => void
  deleteServiceLevel: (id: string) => void
  saveCustomerType: (value: CustomerTypeEntry) => void
  deleteCustomerType: (id: string) => void
  savePriceList: (value: PriceListEntry) => void
  deletePriceList: (id: string) => void
}

const STORAGE_KEY = "wastehero.commercial-registries.v1"
const fixtureCreatedAt = "2026-01-01T00:00:00.000Z"

const fixture = (name: string, extra?: Partial<ServiceLevel>) => ({
  name,
  description: "",
  status: "Active" as RegistryStatus,
  createdAt: fixtureCreatedAt,
  updatedAt: fixtureCreatedAt,
  ...extra,
})

// Seeds mirror the values the fixture price rows and products already
// reference (lib/commercial/price-model.ts registries + product facts), so
// usage counts line up from the first render.
const defaultState: CommercialRegistriesState = {
  zones: [
    { id: "zone-north", ...fixture("Zone North") },
    { id: "zone-city-centre", ...fixture("City Centre") },
    { id: "zone-amager", ...fixture("Amager") },
    { id: "zone-harbor", ...fixture("Harbor") },
  ],
  serviceLevels: [
    {
      id: "service-standard-kerbside",
      code: "STD-KERB",
      ...fixture("Standard kerbside", {
        description: "Container presented at the kerb on the pickup day.",
      }),
    },
    {
      id: "service-backdoor",
      code: "BACKDOOR",
      ...fixture("Backdoor service", {
        description: "Crew collects the container from the property.",
      }),
    },
    {
      id: "service-crane-emptying",
      code: "CRANE",
      ...fixture("Crane emptying", {
        description: "Crane vehicle required — underground and igloo containers.",
      }),
    },
    {
      id: "service-same-week",
      code: "SAME-WEEK",
      ...fixture("Same-week", {
        description: "Guaranteed pickup within the same week.",
      }),
    },
    {
      id: "service-next-day",
      code: "NEXT-DAY",
      ...fixture("Next-day", {
        description: "Guaranteed pickup on the next working day.",
      }),
    },
  ],
  customerTypes: [
    { id: "customer-type-household", ...fixture("Household") },
    { id: "customer-type-commercial", ...fixture("Commercial") },
    { id: "customer-type-municipal", ...fixture("Municipal") },
  ],
  // Every tag the fixture price rows carry — including the two negotiated
  // deal tags — so usage counts and row-edit prefill line up from the first
  // render. Effective-from mirrors each tag's earliest fixture row.
  priceLists: [
    {
      id: "price-list-copenhagen-2026",
      effectiveFrom: "2026-01-01",
      ...fixture("PL-Copenhagen-2026", {
        description: "Annual tariff for Copenhagen municipal collection.",
      }),
    },
    {
      id: "price-list-harbor-2026",
      effectiveFrom: "2026-01-01",
      ...fixture("PL-Harbor-2026", {
        description: "Annual tariff for the Harbor contract area.",
      }),
    },
    {
      id: "price-list-negotiated-osterbro",
      effectiveFrom: "2026-02-03",
      ...fixture("Negotiated · Østerbro Housing", {
        description: "Negotiated deal for Østerbro Housing Association.",
      }),
    },
    {
      id: "price-list-negotiated-norrebro",
      effectiveFrom: "2026-04-08",
      ...fixture("Negotiated · Nørrebro CoWork", {
        description: "Negotiated deal for Nørrebro CoWork ApS.",
      }),
    },
  ],
}

const CommercialRegistriesStoreContext =
  createContext<CommercialRegistriesStoreValue | null>(null)

// Deliberately does NOT require priceLists: stored state predating that
// slice must still hydrate (the provider backfills the seeds).
function isCommercialRegistriesState(
  value: unknown,
): value is CommercialRegistriesState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<CommercialRegistriesState>
  return (
    Array.isArray(candidate.zones) &&
    Array.isArray(candidate.serviceLevels) &&
    Array.isArray(candidate.customerTypes)
  )
}

function upsert<T extends EntityWithId>(items: T[], value: T) {
  return items.some((item) => item.id === value.id)
    ? items.map((item) => (item.id === value.id ? value : item))
    : [value, ...items]
}

export function registryEntityId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function CommercialRegistriesStoreProvider({
  children,
}: {
  children: ReactNode
}) {
  const [state, setState] = useState<CommercialRegistriesState>(defaultState)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      const parsed: unknown = raw ? JSON.parse(raw) : null
      if (isCommercialRegistriesState(parsed)) {
        // State persisted before price lists became managed lacks the slice —
        // keep the seeds instead of discarding the whole stored state.
        setState({
          ...defaultState,
          ...parsed,
          priceLists: Array.isArray(parsed.priceLists)
            ? parsed.priceLists
            : defaultState.priceLists,
        })
      }
    } catch {
      // Safe fixture registries remain available when storage is unavailable.
    } finally {
      setHydrated(true)
    }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // Keep the in-memory registries usable when persistence is blocked.
    }
  }, [hydrated, state])

  const saveZone = useCallback((value: PricingZone) => {
    setState((current) => ({ ...current, zones: upsert(current.zones, value) }))
  }, [])
  const deleteZone = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      zones: current.zones.filter((item) => item.id !== id),
    }))
  }, [])
  const saveServiceLevel = useCallback((value: ServiceLevel) => {
    setState((current) => ({
      ...current,
      serviceLevels: upsert(current.serviceLevels, value),
    }))
  }, [])
  const deleteServiceLevel = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      serviceLevels: current.serviceLevels.filter((item) => item.id !== id),
    }))
  }, [])
  const saveCustomerType = useCallback((value: CustomerTypeEntry) => {
    setState((current) => ({
      ...current,
      customerTypes: upsert(current.customerTypes, value),
    }))
  }, [])
  const deleteCustomerType = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      customerTypes: current.customerTypes.filter((item) => item.id !== id),
    }))
  }, [])
  const savePriceList = useCallback((value: PriceListEntry) => {
    setState((current) => ({
      ...current,
      priceLists: upsert(current.priceLists, value),
    }))
  }, [])
  const deletePriceList = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      priceLists: current.priceLists.filter((item) => item.id !== id),
    }))
  }, [])

  const value = useMemo<CommercialRegistriesStoreValue>(
    () => ({
      ...state,
      hydrated,
      saveZone,
      deleteZone,
      saveServiceLevel,
      deleteServiceLevel,
      saveCustomerType,
      deleteCustomerType,
      savePriceList,
      deletePriceList,
    }),
    [
      deleteCustomerType,
      deletePriceList,
      deleteServiceLevel,
      deleteZone,
      hydrated,
      saveCustomerType,
      savePriceList,
      saveServiceLevel,
      saveZone,
      state,
    ],
  )

  return (
    <CommercialRegistriesStoreContext.Provider value={value}>
      {children}
    </CommercialRegistriesStoreContext.Provider>
  )
}

export function useCommercialRegistriesStore() {
  const value = useContext(CommercialRegistriesStoreContext)
  if (!value) {
    throw new Error(
      "useCommercialRegistriesStore must be used within CommercialRegistriesStoreProvider",
    )
  }
  return value
}
