"use client"

// The records the guided setup reads, in one hook: fixture data merged with
// user-created records from the record store, the Settings waste fractions,
// plus the fleet profiles and the two catalogue resolvers the estimates need
// — the container weight (asset-management catalogue first, fallback table
// second) and, since Issue #39, the container type's emptying time, which
// the road basis adds to the routed drive time.
//
// On the Pilot (#178) every list is the API's: a module's rows once the
// store has read them and none before — a fixture row names nothing the API
// holds, and the create would be refused over it — and none of a module
// still on fixtures (pickable-records.ts). The waste fractions are the
// master data's; the asset-management catalogue is the browser's own, so it
// lends no weight or emptying time there and the estimates read the
// domain's fallback table.

import { useMemo } from "react"

import { useAssetManagementStore } from "@/components/settings/asset-management-store"
import { useApiConfigured } from "@/components/waste/api-session-store"
import { useModuleRecords as useStoreModuleRecords } from "@/components/waste/business-record-store"
import { usePickableRecords } from "@/components/waste/pickable-records"
import { isServerBacked } from "@/lib/api/records/modules"
import { getModuleDefinition, type BusinessRecord, type WorkspaceId } from "@/lib/data/business-modules"
import { COLLECTION_CALENDARS_MODULE } from "@/lib/data/collection-calendars"
import { MASTER_DATA_MODULE } from "@/lib/data/master-data"
import { masterDataKindOf } from "@/lib/data/master-data-kinds"
import { PLANNING_AREAS_MODULE } from "@/lib/data/planning-areas"
import {
  fallbackContainerWeight,
  type ContainerWeightResolver,
  type StopMinutesResolver,
} from "@waste/domain/route-schemes/estimates"
import {
  collectionVehicles,
  driverProfile,
  vehicleProfile,
  type DriverProfile,
  type VehicleProfile,
} from "@waste/domain/route-schemes/fleet-profiles"

export type WizardRecords = {
  /** Whether the records are the API's (the Pilot): a group's driver is then judged on the day the API judges it (lib/data/route-schemes.ts `licenceDayOf`). */
  onApi: boolean
  projects: BusinessRecord[]
  areas: BusinessRecord[]
  calendars: BusinessRecord[]
  depots: BusinessRecord[]
  stations: BusinessRecord[]
  /** Powered collection vehicles (trailers excluded). */
  vehicles: BusinessRecord[]
  drivers: BusinessRecord[]
  containers: BusinessRecord[]
  /** Whether the containers are the API's (the Pilot), which the preview's matcher cannot place yet (lib/data/route-schemes.ts `validationOnApi`). */
  containersOnApi: boolean
  /** On the Pilot, the master data's container types, which a rule names; null in fixture mode, where they are the ones the containers carry. */
  containerTypeNames: string[] | null
  schemes: BusinessRecord[]
  allocations: BusinessRecord[]
  /** Active waste fraction names from Settings master data — the step 1 options. */
  wasteFractions: string[]
  vehicleProfiles: VehicleProfile[]
  driverProfiles: DriverProfile[]
  weightKg: ContainerWeightResolver
  /** The catalogue's emptying time per container type, minutes; null for a type it does not list. */
  stopMinutes: StopMinutesResolver
}

const locationType = (record: BusinessRecord): "depot" | "unloading" | "unknown" => {
  const typed = record.submittedValues?.locationType
  if (typed === "depot" || typed === "unloading") return typed
  if (/^depot/i.test(record.context)) return "depot"
  if (/^unloading/i.test(record.context)) return "unloading"
  return "unknown"
}

const NO_CATALOGUE: ReturnType<typeof useAssetManagementStore>["containerTypes"] = []

/** A module's rows as the wizard may offer them: fixtures and the browser's, or on the Pilot the API's once read and none before. */
function useModuleRecords(workspaceId: WorkspaceId, moduleId: string): BusinessRecord[] {
  const fixtures = getModuleDefinition({ workspaceId, moduleId })?.records ?? []
  const { records } = useStoreModuleRecords(workspaceId, moduleId, fixtures)
  return usePickableRecords(workspaceId, moduleId, records)
}

export function useWizardRecords(): WizardRecords {
  const onApi = useApiConfigured()
  const projects = useModuleRecords("configure", "organization")
  const areas = useModuleRecords(PLANNING_AREAS_MODULE.workspaceId, PLANNING_AREAS_MODULE.moduleId)
  const calendars = useModuleRecords(
    COLLECTION_CALENDARS_MODULE.workspaceId,
    COLLECTION_CALENDARS_MODULE.moduleId,
  )
  const locations = useModuleRecords("resources", "depots")
  const fleet = useModuleRecords("fleet", "vehicles")
  const drivers = useModuleRecords("fleet", "drivers")
  const containers = useModuleRecords("resources", "containers")
  const schemes = useModuleRecords("route-studio", "schemes")
  const allocations = useModuleRecords("fleet", "vehicle-planning")
  const master = useModuleRecords(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId)
  const assets = useAssetManagementStore()
  const containerTypes = onApi ? NO_CATALOGUE : assets.containerTypes
  // The master data's names on the Pilot, derived once per read of the module rather than on every render.
  const containerTypeNames = useMemo(
    () => (onApi ? master.filter((record) => masterDataKindOf(record) === "container-type").map((record) => record.name) : null),
    [master, onApi],
  )
  const wasteFractionNames = useMemo(
    () =>
      onApi
        ? master.filter((record) => masterDataKindOf(record) === "waste-fraction").map((record) => record.name)
        : assets.wasteFractions.filter((fraction) => fraction.status === "Active").map((fraction) => fraction.name),
    [assets.wasteFractions, master, onApi],
  )

  const byName = useMemo(
    () => new Map(containerTypes.map((type) => [type.name.toLowerCase(), type])),
    [containerTypes],
  )

  const weightKg = useMemo<ContainerWeightResolver>(
    () => (containerType, fraction) => {
      const catalogued = containerType ? byName.get(containerType.toLowerCase()) : undefined
      const weight =
        catalogued && fraction ? catalogued.wasteFractionWeights[fraction.toLowerCase()] : undefined
      return typeof weight === "number" && weight > 0
        ? { kg: weight, fallback: false }
        : fallbackContainerWeight(containerType, fraction)
    },
    [byName],
  )

  // The catalogue's emptying time, the seconds override when the type is timed that finely.
  const stopMinutes = useMemo<StopMinutesResolver>(
    () => (containerType) => {
      const catalogued = containerType ? byName.get(containerType.toLowerCase()) : undefined
      if (!catalogued) return null
      const minutes =
        catalogued.customizeEmptyingTime && catalogued.emptyingTimeSeconds > 0
          ? catalogued.emptyingTimeSeconds / 60
          : catalogued.emptyingTimeMinutes
      return Number.isFinite(minutes) && minutes > 0 ? minutes : null
    },
    [byName],
  )

  const vehicles = collectionVehicles(fleet)
  // Projects are the organisation records with a project context; the
  // company record itself is not a scope a scheme plans for.
  const projectRecords = projects.filter((record) => /^project/i.test(record.context))

  return {
    onApi,
    projects: projectRecords.length > 0 ? projectRecords : projects,
    areas,
    calendars,
    depots: locations.filter((record) => locationType(record) !== "unloading"),
    stations: locations.filter((record) => locationType(record) !== "depot"),
    vehicles,
    drivers,
    containers,
    containersOnApi: onApi && isServerBacked("resources", "containers"),
    containerTypeNames,
    schemes,
    allocations,
    wasteFractions: wasteFractionNames,
    vehicleProfiles: vehicles.map(vehicleProfile),
    driverProfiles: drivers.map(driverProfile),
    weightKg,
    stopMinutes,
  }
}
