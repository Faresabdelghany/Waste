"use client"

// The records the guided setup reads, in one hook: fixture data merged with
// user-created records from the record store, the Settings waste fractions,
// plus the fleet profiles and the two catalogue resolvers the estimates need
// — the container weight (asset-management catalogue first, fallback table
// second) and, since Issue #39, the container type's emptying time, which
// the road basis adds to the routed drive time.

import { useMemo } from "react"

import { useAssetManagementStore } from "@/components/settings/asset-management-store"
import { useModuleRecords } from "@/components/waste/scheme-route-map"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { COLLECTION_CALENDARS_MODULE } from "@/lib/data/collection-calendars"
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
  projects: BusinessRecord[]
  areas: BusinessRecord[]
  calendars: BusinessRecord[]
  depots: BusinessRecord[]
  stations: BusinessRecord[]
  /** Powered collection vehicles (trailers excluded). */
  vehicles: BusinessRecord[]
  drivers: BusinessRecord[]
  containers: BusinessRecord[]
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

export function useWizardRecords(): WizardRecords {
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
  const { containerTypes, wasteFractions } = useAssetManagementStore()

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
    projects: projectRecords.length > 0 ? projectRecords : projects,
    areas,
    calendars,
    depots: locations.filter((record) => locationType(record) !== "unloading"),
    stations: locations.filter((record) => locationType(record) !== "depot"),
    vehicles,
    drivers,
    containers,
    schemes,
    allocations,
    wasteFractions: wasteFractions
      .filter((fraction) => fraction.status === "Active")
      .map((fraction) => fraction.name),
    vehicleProfiles: vehicles.map(vehicleProfile),
    driverProfiles: drivers.map(driverProfile),
    weightKg,
    stopMinutes,
  }
}
