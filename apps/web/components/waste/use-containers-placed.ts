"use client"

// Whether the stop-rule preview had the API's containers placed (#207): the
// containers and every module their records are read through ready, so a
// zero match is evidence and blocks as in fixture mode. Until then — a module
// loading, failed, or not granted to the person's role — the preview counts
// the fixtures' containers or the API's standing nowhere, and the zero match
// is said as a notice instead (`validationWhenUnplaced`).
//
// Nor while the containers are behind (#232): the store reads them again once
// something their last read was mapped against has moved since it began
// (business-record-store.tsx's watcher, `readsChanged`), and until that read
// lands the preview reads them as not placed, by the same rule the store
// reads, so every preview mounted agrees.
import { useApiConfigured } from "@/components/platform/api-session-store"
import { useReadBehind, useServerModuleState } from "@/components/platform/business-record-store"
import { CONTAINER_PLACE_MODULES } from "@/lib/api/records/container-places"
import { CONTAINERS_MODULE } from "@/lib/api/records/containers"
import { containersPlaced } from "@/lib/data/route-schemes"

const [agreements, properties, shared, areas, master] = CONTAINER_PLACE_MODULES

export function useContainersPlaced(): boolean {
  const configured = useApiConfigured()
  const containers = useServerModuleState(CONTAINERS_MODULE.workspaceId, CONTAINERS_MODULE.moduleId)
  const through = [
    useServerModuleState(agreements.workspaceId, agreements.moduleId),
    useServerModuleState(properties.workspaceId, properties.moduleId),
    useServerModuleState(shared.workspaceId, shared.moduleId),
    useServerModuleState(areas.workspaceId, areas.moduleId),
    useServerModuleState(master.workspaceId, master.moduleId),
  ]
  const behind = useReadBehind(CONTAINERS_MODULE.workspaceId, CONTAINERS_MODULE.moduleId)
  return containersPlaced(configured, containers, through) && !behind
}
