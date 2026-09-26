// The shape Settings › Asset management keeps in the browser, and how it is
// read back (Issue #39, 2026-09-26) — beside the fixture catalogue in
// asset-catalogue.ts and out of the React store, so a test can hold the
// hydration to its rules without a browser. The store persists the whole
// state under one key; on load the stored state stands over the defaults,
// its feature flags over the default flags, and the fixture container types
// it has never been seeded with are appended: a browser holding the
// four-type catalogue from before Issue #39 would otherwise never see the
// 140 L bin, the igloo or the underground unit, and every kerbside and crane
// group in its guided setup would keep "Fallback weight". Seeding appends and
// never overwrites — a weight or a name the person changed stays changed —
// and it goes by the ledger `seededContainerTypeIds`, the fixture ids this
// browser has been given: a fixture type the ledger names but the catalogue
// lacks was deleted on purpose and stays deleted; one the ledger does not
// name is new and is appended. A store from before the ledger has none, so
// every fixture type it lacks is appended once, and the ledger is written.

import { FIXTURE_CONTAINER_TYPES, type ContainerType, type LifecycleStatus } from "./asset-catalogue"

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
  /**
   * The fixture container type ids this browser has been seeded with — the
   * ledger seeding goes by (see the module doc). Stores written before Issue
   * #39 have none; the hydration treats that as empty.
   */
  seededContainerTypeIds: string[]
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

/** A stored value the store can take over: every list a list, the email a string, the flags an object; the ledger may be absent. */
export function isAssetManagementState(value: unknown): value is AssetManagementState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<AssetManagementState>
  return (
    Array.isArray(candidate.containerTypes) &&
    (candidate.seededContainerTypeIds === undefined || Array.isArray(candidate.seededContainerTypeIds)) &&
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

/**
 * The catalogue with the fixture types it has never been seeded with
 * appended, in the fixtures' order, after everything it holds — nothing
 * held is touched — and the ledger brought up to every fixture id. A type
 * the ledger names but the catalogue lacks was deleted and is left deleted.
 */
export function seedMissingContainerTypes<S extends Pick<AssetManagementState, "containerTypes" | "seededContainerTypeIds">>(
  state: S,
  fixtures: readonly ContainerType[] = FIXTURE_CONTAINER_TYPES,
): S {
  const held = new Set(state.containerTypes.map((type) => type.id))
  const seeded = new Set(state.seededContainerTypeIds)
  const missing = fixtures.filter((type) => !held.has(type.id) && !seeded.has(type.id))
  const ledger = [...state.seededContainerTypeIds, ...fixtures.map((type) => type.id).filter((id) => !seeded.has(id))]
  if (missing.length === 0 && ledger.length === state.seededContainerTypeIds.length) return state
  return {
    ...state,
    containerTypes: missing.length === 0 ? state.containerTypes : [...state.containerTypes, ...missing],
    seededContainerTypeIds: ledger,
  }
}

/**
 * What the browser holds, read back over `defaults`: null when there is
 * nothing, or not this shape (the store then keeps the defaults); otherwise
 * the stored state, its flags over the default flags, seeded as above.
 */
export function hydrateAssetManagementState(raw: string | null, defaults: AssetManagementState): AssetManagementState | null {
  let parsed: unknown = null
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
  if (!isAssetManagementState(parsed)) return null
  return seedMissingContainerTypes({
    ...defaults,
    ...parsed,
    seededContainerTypeIds: parsed.seededContainerTypeIds ?? [],
    features: { ...defaults.features, ...parsed.features },
  })
}
