"use client"

// The records the guided setup reads, in one hook (#178): every list the
// API's, a module's rows once the store has read them and none before, the
// waste fractions and container types the master data's, and the fleet
// profiles; the estimates' container weight is the domain's fallback table,
// and no container type lends an emptying time.

import { useMemo } from "react"

import { useApiConfigured } from "@/components/platform/api-session-store"
import { useModuleRecords as useStoreModuleRecords } from "@/components/platform/business-record-store"
import { useContainersPlaced } from "@/components/waste/use-containers-placed"
import type { BusinessRecord, WorkspaceId } from "@/lib/data/business-modules"
import { COLLECTION_CALENDARS_MODULE } from "@/lib/data/collection-calendars"
import { MASTER_DATA_MODULE } from "@/lib/data/master-data"
import { masterDataKindOf } from "@/lib/data/master-data-kinds"
import { PLANNING_AREAS_MODULE } from "@/lib/data/planning-areas"
import {
  fallbackContainerWeight,
  type ContainerWeightResolver,
  type StopMinutesResolver,
} from "@/lib/prototype/route-schemes/estimates"
import {
  collectionVehicles,
  driverProfile,
  vehicleProfile,
  type DriverProfile,
  type VehicleProfile,
} from "@/lib/prototype/route-schemes/fleet-profiles"

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
  /** Whether the preview had the API's containers placed (`useContainersPlaced`), so a zero match is evidence: always in fixture mode. */
  containersPlaced: boolean
  /** The master data's container types, which a rule names. */
  containerTypeNames: string[] | null
  schemes: BusinessRecord[]
  allocations: BusinessRecord[]
  /** Active waste fraction names from Settings master data — the step 1 options. */
  wasteFractions: string[]
  vehicleProfiles: VehicleProfile[]
  driverProfiles: DriverProfile[]
  weightKg: ContainerWeightResolver
  /** The emptying time per container type, minutes; null for a type nothing times. */
  stopMinutes: StopMinutesResolver
}

const locationType = (record: BusinessRecord): "depot" | "unloading" | "unknown" => {
  const typed = record.submittedValues?.locationType
  if (typed === "depot" || typed === "unloading") return typed
  if (/^depot/i.test(record.context)) return "depot"
  if (/^unloading/i.test(record.context)) return "unloading"
  return "unknown"
}

/** A module's rows as the wizard may offer them: the API's once read and none before. */
function useModuleRecords(workspaceId: WorkspaceId, moduleId: string): BusinessRecord[] {
  return useStoreModuleRecords(workspaceId, moduleId).records
}

export function useWizardRecords(): WizardRecords {
  const onApi = useApiConfigured()
  const containersPlaced = useContainersPlaced()
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
  const containerTypeNames = useMemo(() => master.filter((record) => masterDataKindOf(record) === "container-type").map((record) => record.name), [master])
  const wasteFractionNames = useMemo(() => master.filter((record) => masterDataKindOf(record) === "waste-fraction").map((record) => record.name), [master])

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
    containersPlaced,
    containerTypeNames,
    schemes,
    allocations,
    wasteFractions: wasteFractionNames,
    vehicleProfiles: vehicles.map(vehicleProfile),
    driverProfiles: drivers.map(driverProfile),
    weightKg: fallbackContainerWeight,
    stopMinutes: () => null,
  }
}
