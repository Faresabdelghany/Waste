"use client"

// The routing quota as the banners read it (#173, #132 §5): `GET
// /routing/quota` once the component mounts with a signed-in API client,
// and again every minute for as long as it stays mounted — Route Studio's
// pages and the guided setup's step 4, nowhere else — so a banner appears
// and clears off the reading alone. Without the API, before the first
// answer, and when the read is refused (a role without `view` on the routes
// module), there is no reading and so no banner. The clock beside it ticks
// the minute the sentences are read against.

import { useEffect, useState } from "react"

import type { RoutingQuota } from "@waste/contracts/routing-quota"
import { useApiClient } from "@/components/waste/api-session-store"
import { routingQuota } from "@/lib/api/routing"

/** How often a mounted banner reads the quota again. */
export const QUOTA_REREAD_MS = 60_000

export function useRoutingQuota(): RoutingQuota | null {
  const client = useApiClient()
  const [quota, setQuota] = useState<RoutingQuota | null>(null)
  useEffect(() => {
    if (client === null) return
    let live = true
    const read = () => {
      routingQuota(client).then(
        (answer) => live && setQuota(answer),
        () => live && setQuota(null),
      )
    }
    read()
    const timer = setInterval(read, QUOTA_REREAD_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
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
