"use client"

// Whether the stop-rule preview had the API's containers placed (#207): the
// containers and every module their records are read through ready, so a
// zero match is evidence and blocks as in fixture mode. Until then — a module
// loading, failed, or not granted to the person's role — the preview counts
// the fixtures' containers or the API's standing nowhere, and the zero match
// is said as a notice instead (`validationWhenUnplaced`).
//
// It also keeps them current wherever it is mounted — the workspace and every
// preview (#232): a container's
// place, areas and serving period are read when the containers are, so once a
// module they are read through has new rows (an area drawn, an agreement
// written) or the project's day has turned, the containers are read again
// through the store's `refreshModule`, and the preview says nothing from them
// until then. The rule is `placeBasis`/`placesChanged`/`readingDayPassed`
// (lib/data/route-schemes.ts); one read at a time across every preview
// mounted, a burst collapsing into one a second after its last change. The
// map reads the containers as they were loaded until #232's map half.
import { useEffect, useState, useSyncExternalStore } from "react"

import { useApiConfigured } from "@/components/waste/api-session-store"
import { useBusinessRecordStore, useServerModuleState } from "@/components/waste/business-record-store"
import { CONTAINER_PLACE_MODULES } from "@/lib/api/records/container-places"
import { CONTAINERS_MODULE } from "@/lib/api/records/containers"
import { containersPlaced, placeBasis, placesChanged, projectToday, readingDayPassed, timezoneOfProject, type PlaceBasis } from "@/lib/data/route-schemes"

const [agreements, properties, shared, areas, master] = CONTAINER_PLACE_MODULES

/** The browser's day, checked each minute: what tells a preview a day may have turned, without a render until one has. */
const browserDay = () => projectToday(undefined)
function subscribeToDay(onChange: () => void): () => void {
  const timer = setInterval(onChange, 60_000)
  return () => clearInterval(timer)
}

let readTimer: ReturnType<typeof setTimeout> | undefined
let reading = false

/** One read of the API's containers at a time across every preview mounted, a burst of changes collapsing into one read a second after its last. */
function readContainersAgain(read: () => Promise<void>): void {
  if (readTimer !== undefined) clearTimeout(readTimer)
  readTimer = setTimeout(() => {
    readTimer = undefined
    if (reading) return
    reading = true
    void read().finally(() => {
      reading = false
    })
  }, 1_000)
}

export function useContainersPlaced(): boolean {
  const configured = useApiConfigured()
  const { refreshModule } = useBusinessRecordStore()
  const containers = useServerModuleState(CONTAINERS_MODULE.workspaceId, CONTAINERS_MODULE.moduleId)
  const through = [
    useServerModuleState(agreements.workspaceId, agreements.moduleId),
    useServerModuleState(properties.workspaceId, properties.moduleId),
    useServerModuleState(shared.workspaceId, shared.moduleId),
    useServerModuleState(areas.workspaceId, areas.moduleId),
    useServerModuleState(master.workspaceId, master.moduleId),
  ]
  const organisation = useServerModuleState("configure", "organization")
  const day = useSyncExternalStore(subscribeToDay, browserDay, browserDay)

  // What the containers were read against, taken anew with their rows (the stored-from-the-last-render pattern).
  const [basis, setBasis] = useState<PlaceBasis | null>(null)
  const current = placeBasis(basis, containers, through)
  if (current !== basis) setBasis(current)

  const projects = organisation?.status === "ready" ? organisation.records : []
  const dayPassed = current !== null && readingDayPassed(current.containers, (record) => {
    const timezone = timezoneOfProject(projects, record.projectIds?.[0])
    return timezone === undefined ? day : projectToday(timezone)
  })
  const stale = configured && (placesChanged(current, through) || dayPassed)

  useEffect(() => {
    if (stale) readContainersAgain(() => refreshModule(CONTAINERS_MODULE.workspaceId, CONTAINERS_MODULE.moduleId))
  }, [refreshModule, stale])

  return containersPlaced(configured, containers, through) && !stale
}
