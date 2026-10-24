"use client"

// One report as the Dashboard reads it (#292): asked again whenever its key
// changes — the window, the project, the filters (`reportKey`) — with the
// signed-in client, the request before it aborted. Two answers, kept apart:
// `report` is the current key's alone, what a figure is worked out from, a
// change computed against, a CSV written from; `shown` is the current key's
// or, while it is on its way or after it failed, the last one read, so a
// card holds its frame greyed rather than flashing empty — never to be
// counted from. A refusal or an unreachable API is the problem, in the API's
// sentence. `key` null asks nothing (no session yet, or a role the report's
// grant does not cover), and the hook then answers nothing at all.

import { useEffect, useRef, useState } from "react"

import { useApiSession, useApiClient } from "@/components/waste/api-session-store"
import type { ApiClient } from "@/lib/api/client"
import type { Problem } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"

export type ReportRead<Report> = {
  /** The current key's answer, or null while it is on its way or when it failed. */
  report: Report | null
  /** What a card shows: the current key's answer, else the last one read, greyed by `loading`. */
  shown: Report | null
  /** Whether the current key's answer has not arrived. */
  loading: boolean
  /** The current key's refusal, or null. */
  problem: Problem | null
}

type Answer<Report> = { key: string; report: Report | null; problem: Problem | null }

export function useReport<Report>(key: string | null, read: (client: ApiClient) => Promise<Report>): ReportRead<Report> {
  const client = useApiClient()
  const { me } = useApiSession()
  const [answer, setAnswer] = useState<Answer<Report> | null>(null)
  const [last, setLast] = useState<Report | null>(null)
  // The reader of the current render, so the effect asks with it and runs only when the key or the session changes.
  const reader = useRef(read)
  useEffect(() => {
    reader.current = read
  })
  // A token refresh hands a new client for the same person: the key and the person decide a read, not the token.
  const person = me?.user.id ?? null
  const signedIn = client !== null
  const latest = useRef(client)
  useEffect(() => {
    latest.current = client
  })

  useEffect(() => {
    const asking = latest.current
    if (key === null || asking === null || person === null) return
    const controller = new AbortController()
    reader.current({ ...asking, signal: controller.signal }).then(
      (report) => {
        if (controller.signal.aborted) return
        setAnswer({ key, report, problem: null })
        setLast(report)
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setAnswer({ key, report: null, problem: problemOfError(error) })
      },
    )
    return () => controller.abort()
  }, [key, person, signedIn])

  if (key === null) return { report: null, shown: null, loading: false, problem: null }
  const current = answer?.key === key ? answer : null
  return { report: current?.report ?? null, shown: current?.report ?? last, loading: current === null, problem: current?.problem ?? null }
}
