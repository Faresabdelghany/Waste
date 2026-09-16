"use client"

// The records the guided setup reads, in one hook: fixture data merged with
// user-created records from the record store, plus the fleet profiles and
// the container-weight resolver (asset-management catalogue first, fallback
// table second) the estimates need.

import { useMemo } from "react"

import { useAssetManagementStore } from "@/components/settings/asset-management-store"
import { useModuleRecords } from "@/components/wastehero/scheme-route-map"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { PLANNING_AREAS_MODULE } from "@/lib/data/planning-areas"
import { fallbackContainerWeightKg, type ContainerWeightResolver } from "@/lib/route-schemes/estimates"
import {
  collectionVehicles,
  driverProfile,
  vehicleProfile,
  type DriverProfile,
  type VehicleProfile,
} from "@/lib/route-schemes/fleet-profiles"

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
  vehicleProfiles: VehicleProfile[]
  driverProfiles: DriverProfile[]
  weightKg: ContainerWeightResolver
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
  const calendars = useModuleRecords("plan", "calendars")
  const locations = useModuleRecords("resources", "depots")
  const fleet = useModuleRecords("fleet", "vehicles")
  const drivers = useModuleRecords("fleet", "drivers")
  const containers = useModuleRecords("resources", "containers")
  const schemes = useModuleRecords("route-studio", "schemes")
  const allocations = useModuleRecords("fleet", "vehicle-planning")
  const { containerTypes } = useAssetManagementStore()

  const weightKg = useMemo<ContainerWeightResolver>(() => {
    const byName = new Map(containerTypes.map((type) => [type.name.toLowerCase(), type]))
    return (containerType, fraction) => {
      const catalogued = containerType ? byName.get(containerType.toLowerCase()) : undefined
      const weight =
        catalogued && fraction ? catalogued.wasteFractionWeights[fraction.toLowerCase()] : undefined
      return typeof weight === "number" && weight > 0
        ? weight
        : fallbackContainerWeightKg(containerType, fraction)
    }
  }, [containerTypes])

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
    vehicleProfiles: vehicles.map(vehicleProfile),
    driverProfiles: drivers.map(driverProfile),
    weightKg,
  }
}
