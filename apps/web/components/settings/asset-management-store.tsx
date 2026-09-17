"use client"

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import { createExternalStore, type ExternalStore } from "@/lib/external-store"

import { FIXTURE_PROJECT_IDS } from "@/lib/data/business-modules"

export type LifecycleStatus = "Active" | "Inactive"
export type ContainerKind = "waste-collection" | "wastewater"

export type ContainerType = {
  id: string
  name: string
  kind: ContainerKind
  projectIds: string[]
  emplacement: string
  vehicleCoupling: string
  emptyingTimeMinutes: number
  customizeEmptyingTime: boolean
  emptyingTimeSeconds: number
  volumePreset: string
  volume: number
  volumeUnit: "L" | "m³"
  cylinderShape: boolean
  heightCm: number
  lengthCm: number
  widthCm: number
  diameterCm: number
  wasteFractionWeights: Record<string, number>
  color: string
  icon: string
  lidType: string
  loadingMethod: string
  warrantyMonths: number
  lifecycleStatus: LifecycleStatus
  createdAt: string
  updatedAt: string
}

export type WasteFraction = {
  id: string
  name: string
  projectIds: string[]
  wasteSubstance: string
  disposalMethod: string
  wasteType: string
  weightToVolumeRatio: number
  status: LifecycleStatus
  ewcCode: string
  rdCode: string
  hazardous: boolean
  recyclable: boolean
  mustIncludeVat: boolean
  recyclingPercent: number
  energyRecoveryPercent: number
  materialRecoveryPercent: number
  emptyingIntervalMinDays: number
  emptyingIntervalMaxDays: number
  style: string
  color: string
  createdAt: string
  updatedAt: string
}

export type PartType = {
  id: string
  name: string
  seeded: boolean
  active: boolean
  createdAt: string
}

export type SparePart = {
  id: string
  name: string
  containerTypeId: string
  additionalContainerTypeIds: string[]
  partTypeId: string
  sku: string
  description: string
  active: boolean
  createdAt: string
  updatedAt: string
}

export type PropertyEquipment = {
  id: string
  name: string
  system: boolean
  active: boolean
  description: string
  createdAt: string
  updatedAt: string
}

export type KeyType = {
  id: string
  name: string
  system: boolean
  active: boolean
  chargeableByDefault: boolean
  feeProduct: string
  deposit: number
  instructions: string
  createdAt: string
  updatedAt: string
}

export type MeasurementSetting = {
  id: string
  projectId: string
  name: string
  transmitHours: number[]
  transmitExcludeDays: number[]
  useRecommendedSettings: boolean
  measurementHours: number[]
  measurementsPerHour: number
  measurementExcludeDays: number[]
  active: boolean
  createdAt: string
  updatedAt: string
}

export type ContainerImportJob = {
  id: string
  kind: "containers" | "weights"
  projectId: string
  fileName: string
  delimiter: string
  shouldCreate?: boolean
  shouldUpdate?: boolean
  shouldUpdateGeocodeLocation?: boolean
  status: "Completed" | "Completed with warnings" | "Failed"
  rowCount: number
  warningCount: number
  createdAt: string
}

export type AssetManagementState = {
  containerTypes: ContainerType[]
  wasteFractions: WasteFraction[]
  partTypes: PartType[]
  spareParts: SparePart[]
  propertyEquipment: PropertyEquipment[]
  keyTypes: KeyType[]
  measurementSettings: MeasurementSetting[]
  importJobs: ContainerImportJob[]
  locksmithEmail: string
  features: {
    inventoryEnabled: boolean
    wastewaterTreatmentEnabled: boolean
    physicalKeysEnabled: boolean
  }
}

type EntityWithId = { id: string }

type AssetManagementStoreValue = AssetManagementState & {
  hydrated: boolean
  saveContainerType: (value: ContainerType) => void
  deleteContainerType: (id: string) => void
  saveWasteFraction: (value: WasteFraction) => void
  deleteWasteFraction: (id: string) => void
  savePartType: (value: PartType) => void
  saveSparePart: (value: SparePart) => void
  deleteSparePart: (id: string) => void
  savePropertyEquipment: (value: PropertyEquipment) => void
  saveKeyType: (value: KeyType) => void
  saveMeasurementSetting: (value: MeasurementSetting) => void
  deleteMeasurementSetting: (id: string) => void
  addImportJob: (value: ContainerImportJob) => void
  setLocksmithEmail: (value: string) => void
}

const STORAGE_KEY = "wastehero.asset-management.v1"
const fixtureCreatedAt = "2026-01-01T00:00:00.000Z"

const partTypeNames = [
  "Axle",
  "Brake",
  "Castor",
  "Container body",
  "Drain",
  "Handle",
  "Hinge",
  "Label",
  "Lid",
  "Lock",
  "Pedal",
  "RFID tag",
  "Seal",
  "Sensor mount",
  "Wheel",
  "Other",
]

const defaultState: AssetManagementState = {
  containerTypes: [
    {
      id: "two-wheel-240",
      name: "Two-wheel bin · 240 L",
      kind: "waste-collection",
      projectIds: [],
      emplacement: "Surface",
      vehicleCoupling: "Comb lift",
      emptyingTimeMinutes: 2,
      customizeEmptyingTime: false,
      emptyingTimeSeconds: 0,
      volumePreset: "240 L",
      volume: 240,
      volumeUnit: "L",
      cylinderShape: false,
      heightCm: 107,
      lengthCm: 74,
      widthCm: 58,
      diameterCm: 0,
      wasteFractionWeights: { residual: 18, organic: 22, paper: 12 },
      color: "#2563eb",
      icon: "bin",
      lidType: "Hinged",
      loadingMethod: "Rear loader",
      warrantyMonths: 60,
      lifecycleStatus: "Active",
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
    {
      id: "four-wheel-660",
      name: "Four-wheel bin · 660 L",
      kind: "waste-collection",
      projectIds: [],
      emplacement: "Surface",
      vehicleCoupling: "DIN trunnion",
      emptyingTimeMinutes: 3,
      customizeEmptyingTime: false,
      emptyingTimeSeconds: 0,
      volumePreset: "660 L",
      volume: 660,
      volumeUnit: "L",
      cylinderShape: false,
      heightCm: 122,
      lengthCm: 137,
      widthCm: 78,
      diameterCm: 0,
      wasteFractionWeights: { residual: 49, mixed: 45 },
      color: "#0f766e",
      icon: "dumpster",
      lidType: "Flat",
      loadingMethod: "Rear loader",
      warrantyMonths: 60,
      lifecycleStatus: "Active",
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
    {
      id: "four-wheel-1100",
      name: "Four-wheel bin · 1,100 L",
      kind: "waste-collection",
      projectIds: [],
      emplacement: "Surface",
      vehicleCoupling: "DIN trunnion",
      emptyingTimeMinutes: 4,
      customizeEmptyingTime: false,
      emptyingTimeSeconds: 0,
      volumePreset: "1,100 L",
      volume: 1100,
      volumeUnit: "L",
      cylinderShape: false,
      heightCm: 147,
      lengthCm: 137,
      widthCm: 107,
      diameterCm: 0,
      wasteFractionWeights: { residual: 75, cardboard: 58 },
      color: "#475569",
      icon: "dumpster",
      lidType: "Domed",
      loadingMethod: "Rear loader",
      warrantyMonths: 72,
      lifecycleStatus: "Active",
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
    {
      id: "wastewater-3000",
      name: "Wastewater tank · 3,000 L",
      kind: "wastewater",
      projectIds: [],
      emplacement: "Underground",
      vehicleCoupling: "Suction hose",
      emptyingTimeMinutes: 18,
      customizeEmptyingTime: false,
      emptyingTimeSeconds: 0,
      volumePreset: "3,000 L",
      volume: 3000,
      volumeUnit: "L",
      cylinderShape: true,
      heightCm: 220,
      lengthCm: 0,
      widthCm: 0,
      diameterCm: 140,
      wasteFractionWeights: { wastewater: 3000 },
      color: "#0891b2",
      icon: "tank",
      lidType: "Inspection cover",
      loadingMethod: "Vacuum",
      warrantyMonths: 120,
      lifecycleStatus: "Active",
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
  ],
  wasteFractions: [
    ["residual", "Residual", "20 03 01", "D10", "Disposal", "Municipal waste", "#64748b"],
    ["organic", "Organic", "20 01 08", "R3", "Composting", "Biowaste", "#16a34a"],
    ["cardboard", "Cardboard", "20 01 01", "R3", "Recycling", "Paper and cardboard", "#b45309"],
    ["paper", "Paper", "20 01 01", "R3", "Recycling", "Paper and cardboard", "#2563eb"],
    ["glass", "Glass", "20 01 02", "R5", "Recycling", "Glass", "#0891b2"],
    ["mixed", "Mixed", "20 03 01", "R12", "Sorting", "Mixed municipal", "#7c3aed"],
    ["wastewater", "Wastewater", "20 03 04", "D8", "Treatment", "Wastewater", "#0284c7"],
  ].map(([id, name, ewcCode, rdCode, disposalMethod, wasteType, color]) => ({
    id,
    name,
    projectIds: [],
    wasteSubstance: wasteType,
    disposalMethod,
    wasteType,
    weightToVolumeRatio: id === "wastewater" ? 1 : 0.12,
    status: "Active" as const,
    ewcCode,
    rdCode,
    hazardous: false,
    recyclable: ["organic", "cardboard", "paper", "glass"].includes(id),
    mustIncludeVat: false,
    recyclingPercent: ["cardboard", "paper", "glass"].includes(id) ? 90 : 0,
    energyRecoveryPercent: id === "residual" ? 75 : 0,
    materialRecoveryPercent: ["cardboard", "paper", "glass"].includes(id) ? 90 : 0,
    emptyingIntervalMinDays: 7,
    emptyingIntervalMaxDays: 30,
    style: "Solid",
    color,
    createdAt: fixtureCreatedAt,
    updatedAt: fixtureCreatedAt,
  })),
  partTypes: partTypeNames.map((name, index) => ({
    id: `part-type-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name,
    seeded: true,
    active: true,
    createdAt: new Date(Date.parse(fixtureCreatedAt) + index).toISOString(),
  })),
  spareParts: [
    {
      id: "spare-part-240-lid",
      name: "240 L replacement lid",
      containerTypeId: "two-wheel-240",
      additionalContainerTypeIds: [],
      partTypeId: "part-type-lid",
      sku: "WH-LID-240",
      description: "Blue hinged lid for the standard 240 L bin.",
      active: true,
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
    {
      id: "spare-part-castor-200",
      name: "200 mm castor",
      containerTypeId: "four-wheel-660",
      additionalContainerTypeIds: ["four-wheel-1100"],
      partTypeId: "part-type-castor",
      sku: "WH-CASTOR-200",
      description: "Locking castor shared by 660 L and 1,100 L bins.",
      active: true,
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
  ],
  propertyEquipment: [
    {
      id: "property-equipment-grease-separator",
      name: "Grease separator",
      system: true,
      active: true,
      description: "Property-side wastewater separator.",
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
    {
      id: "property-equipment-settling-tank",
      name: "Settling tank",
      system: true,
      active: true,
      description: "Primary settling equipment.",
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
  ],
  keyTypes: [
    {
      id: "key-type-standard-door",
      name: "Standard door key",
      system: true,
      active: true,
      chargeableByDefault: false,
      feeProduct: "",
      deposit: 0,
      instructions: "Record the key number without storing access codes.",
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
    {
      id: "key-type-electronic-fob",
      name: "Electronic access fob",
      system: true,
      active: true,
      chargeableByDefault: true,
      feeProduct: "Replacement access fob",
      deposit: 250,
      instructions: "Confirm the property access window before dispatch.",
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
  ],
  measurementSettings: [
    {
      id: "standard-4h",
      projectId: FIXTURE_PROJECT_IDS.copenhagen,
      name: "Standard · every 4 hours",
      transmitHours: [1, 13],
      transmitExcludeDays: [],
      useRecommendedSettings: true,
      measurementHours: [1, 5, 9, 13, 17, 21],
      measurementsPerHour: 1,
      measurementExcludeDays: [],
      active: true,
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
    {
      id: "dynamic-1h",
      projectId: FIXTURE_PROJECT_IDS.copenhagen,
      name: "Dynamic · every hour",
      transmitHours: [1, 5, 9, 13, 17, 21],
      transmitExcludeDays: [],
      useRecommendedSettings: false,
      measurementHours: Array.from({ length: 24 }, (_, index) => index + 1),
      measurementsPerHour: 1,
      measurementExcludeDays: [],
      active: true,
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
    {
      id: "low-power-12h",
      projectId: FIXTURE_PROJECT_IDS.harbor,
      name: "Low power · every 12 hours",
      transmitHours: [1, 13],
      transmitExcludeDays: [0],
      useRecommendedSettings: false,
      measurementHours: [1, 13],
      measurementsPerHour: 1,
      measurementExcludeDays: [0],
      active: true,
      createdAt: fixtureCreatedAt,
      updatedAt: fixtureCreatedAt,
    },
  ],
  importJobs: [],
  locksmithEmail: "keys@wastehero.example",
  features: {
    inventoryEnabled: true,
    wastewaterTreatmentEnabled: true,
    physicalKeysEnabled: true,
  },
}

type AssetManagementSnapshot = AssetManagementState & { hydrated: boolean }

type AssetManagementActions = Omit<
  AssetManagementStoreValue,
  keyof AssetManagementSnapshot
>

type AssetManagementStoreHandle = ExternalStore<AssetManagementSnapshot> & {
  actions: AssetManagementActions
}

// The server (and every hydrating component) sees the fixture configuration
// only — see lib/external-store.ts for why the context carries a stable
// handle instead of the state itself (hydration safety under streaming SSR).
const serverSnapshot: AssetManagementSnapshot = {
  ...defaultState,
  hydrated: false,
}

const AssetManagementStoreContext =
  createContext<AssetManagementStoreHandle | null>(null)

function isAssetManagementState(value: unknown): value is AssetManagementState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<AssetManagementState>
  return (
    Array.isArray(candidate.containerTypes) &&
    Array.isArray(candidate.wasteFractions) &&
    Array.isArray(candidate.partTypes) &&
    Array.isArray(candidate.spareParts) &&
    Array.isArray(candidate.propertyEquipment) &&
    Array.isArray(candidate.keyTypes) &&
    Array.isArray(candidate.measurementSettings) &&
    Array.isArray(candidate.importJobs) &&
    typeof candidate.locksmithEmail === "string" &&
    Boolean(candidate.features)
  )
}

function mergeStoredState(stored: AssetManagementState): AssetManagementState {
  return {
    ...defaultState,
    ...stored,
    features: { ...defaultState.features, ...stored.features },
  }
}

function upsert<T extends EntityWithId>(items: T[], value: T) {
  return items.some((item) => item.id === value.id)
    ? items.map((item) => (item.id === value.id ? value : item))
    : [value, ...items]
}

export function assetEntityId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function createAssetManagementStore(): AssetManagementStoreHandle {
  const store = createExternalStore<AssetManagementSnapshot>(serverSnapshot)
  return {
    ...store,
    actions: {
      saveContainerType: (value) =>
        store.set((current) => ({
          ...current,
          containerTypes: upsert(current.containerTypes, value),
        })),
      deleteContainerType: (id) =>
        store.set((current) => ({
          ...current,
          containerTypes: current.containerTypes.filter((item) => item.id !== id),
        })),
      saveWasteFraction: (value) =>
        store.set((current) => ({
          ...current,
          wasteFractions: upsert(current.wasteFractions, value),
        })),
      deleteWasteFraction: (id) =>
        store.set((current) => ({
          ...current,
          wasteFractions: current.wasteFractions.filter((item) => item.id !== id),
        })),
      savePartType: (value) =>
        store.set((current) => ({
          ...current,
          partTypes: upsert(current.partTypes, value),
        })),
      saveSparePart: (value) =>
        store.set((current) => ({
          ...current,
          spareParts: upsert(current.spareParts, value),
        })),
      deleteSparePart: (id) =>
        store.set((current) => ({
          ...current,
          spareParts: current.spareParts.filter((item) => item.id !== id),
        })),
      savePropertyEquipment: (value) =>
        store.set((current) => ({
          ...current,
          propertyEquipment: upsert(current.propertyEquipment, value),
        })),
      saveKeyType: (value) =>
        store.set((current) => ({
          ...current,
          keyTypes: upsert(current.keyTypes, value),
        })),
      saveMeasurementSetting: (value) =>
        store.set((current) => ({
          ...current,
          measurementSettings: upsert(current.measurementSettings, value),
        })),
      deleteMeasurementSetting: (id) =>
        store.set((current) => ({
          ...current,
          measurementSettings: current.measurementSettings.filter(
            (item) => item.id !== id,
          ),
        })),
      addImportJob: (value) =>
        store.set((current) => ({
          ...current,
          importJobs: [value, ...current.importJobs],
        })),
      setLocksmithEmail: (locksmithEmail) =>
        store.set((current) => ({ ...current, locksmithEmail })),
    },
  }
}

export function AssetManagementStoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createAssetManagementStore)

  useEffect(() => {
    let parsed: unknown = null
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      // Safe fixture configuration remains available when storage is unavailable.
    }
    store.set((current) =>
      isAssetManagementState(parsed)
        ? { ...mergeStoredState(parsed), hydrated: true }
        : { ...current, hydrated: true },
    )
    const persist = () => {
      const { hydrated: _hydrated, ...persistable } = store.getSnapshot()
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable))
      } catch {
        // Keep the in-memory configuration usable when persistence is blocked.
      }
    }
    persist()
    return store.subscribe(persist)
  }, [store])

  return (
    <AssetManagementStoreContext.Provider value={store}>
      {children}
    </AssetManagementStoreContext.Provider>
  )
}

export function useAssetManagementStore(): AssetManagementStoreValue {
  const store = useContext(AssetManagementStoreContext)
  if (!store) {
    throw new Error(
      "useAssetManagementStore must be used within AssetManagementStoreProvider",
    )
  }
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  )
  return useMemo(() => ({ ...snapshot, ...store.actions }), [snapshot, store])
}
