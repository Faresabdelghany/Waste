"use client"

// The routing quota as the banners read it (#173, #132 §5): `GET
// /routing/quota` while any banner is mounted with a signed-in API client —
// Route Studio's pages and the guided setup's step 4, nowhere else — and
// again every minute for as long as one stays mounted, so a banner appears
// and clears off the reading alone. One reading and one timer however many
// banners are mounted (step 4 opens over Route Studio's own), the request
// made with the newest client, since a token refresh replaces it. Without
// the API, before the first answer, and when the read is refused (a role
// without `view` on the routes module) there is no reading and so no
// banner. The clock beside it ticks the minute the sentences are read
// against.

import { useEffect, useState, useSyncExternalStore } from "react"

import type { RoutingQuota } from "@waste/contracts/routing-quota"
import { useApiClient } from "@/components/waste/api-session-store"
import type { ApiClient } from "@/lib/api/client"
import { routingQuota } from "@/lib/api/routing"

/** How often a mounted banner reads the quota again. */
export const QUOTA_REREAD_MS = 60_000

let reading: RoutingQuota | null = null
let readAt = 0
let reader: ApiClient | null = null
let watchers = 0
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

const emit = () => {
  for (const listener of listeners) listener()
}

function read(): void {
  const client = reader
  if (client === null) return
  routingQuota(client).then(
    (answer) => {
      reading = answer
      readAt = Date.now()
      emit()
    },
    () => {
      reading = null
      emit()
    },
  )
}

/** One more banner reading the quota with `client`; the returned function is its leaving. */
function watch(client: ApiClient): () => void {
  reader = client
  watchers += 1
  if (watchers === 1) {
    // A reading older than the re-read is not one a banner shows on its first paint.
    if (Date.now() - readAt >= QUOTA_REREAD_MS && reading !== null) {
      reading = null
      emit()
    }
    read()
    timer = setInterval(read, QUOTA_REREAD_MS)
  }
  return () => {
    watchers -= 1
    if (watchers > 0 || timer === null) return
    clearInterval(timer)
    timer = null
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useRoutingQuota(): RoutingQuota | null {
  const client = useApiClient()
  const quota = useSyncExternalStore(
    subscribe,
    () => reading,
    () => null,
  )
  useEffect(() => {
    if (client === null) return
    return watch(client)
  }, [client])
  return client === null ? null : quota
}

/** The browser's clock, a new reading every minute while mounted: what "resumes at" and a reset gone by are read against. */
export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}
