"use client"
// A stop's photos and signatures as read URLs (O1 of #290): the bucket is
// private and the API signs each for minutes (`GET /pickups/:id/proof-objects`,
// under the stops' grant). Asked for only where the stop has an object to
// show — a null stop asks nothing — and asked again before the URLs lapse, so
// a details left open never offers a dead link. The stop's details and a
// ticket's evidence (M6 of #293) read them through this one hook.
import { useEffect, useState } from "react"

import { useApiClient } from "@/components/waste/api-session-store"
import { problemSentence } from "@/lib/api/problem"
import { pickupProofObjects } from "@/lib/api/records/pickups"
import { problemOfError } from "@/lib/api/records/server-records"
import type { ProofObjectLink } from "@waste/contracts/proof-objects"

/** How long before its read URLs lapse a stop's objects are read again. */
const RENEW_BEFORE_MS = 30_000

/** The read URLs of the objects of the stop under `pickupServerId`, null for none to ask; `version` asks again after a change. */
export function useProofObjectLinks(pickupServerId: string | null, version: number | string = 0): { rows: ProofObjectLink[] | null; problem: string | null } {
  const client = useApiClient()
  const [renewals, setRenewals] = useState(0)
  const key = `${pickupServerId ?? ""}|${version}|${renewals}`
  const [state, setState] = useState<{ key: string; rows: ProofObjectLink[] | null; problem: string | null }>({ key: "", rows: null, problem: null })
  useEffect(() => {
    if (client === null || pickupServerId === null) return
    let current = true
    pickupProofObjects(client, pickupServerId).then(
      (rows) => current && setState({ key, rows, problem: null }),
      (error: unknown) => current && setState({ key, rows: null, problem: problemSentence(problemOfError(error)) }),
    )
    return () => {
      current = false
    }
  }, [client, key, pickupServerId])
  const read = state.key === key ? state : { rows: null, problem: null }
  const lapsesAt = read.rows?.reduce<number | null>((soonest, link) => Math.min(soonest ?? Infinity, Date.parse(link.expiresAt)), null) ?? null
  useEffect(() => {
    if (lapsesAt === null) return
    const renew = setTimeout(() => setRenewals((count) => count + 1), Math.max(0, lapsesAt - RENEW_BEFORE_MS - Date.now()))
    return () => clearTimeout(renew)
  }, [lapsesAt])
  return { rows: read.rows, problem: read.problem }
}
