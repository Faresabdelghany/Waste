// A scheme's generation runs on the Pilot (#178, slice 4 of #81): its runs
// and one run as the API reads them, and the watch the scheme page keeps on
// a run that is still open. The runs are not a module's records: the page
// reads them beside the scheme, as it reads the scheme's next collections
// (`schemeOccurrences`), and the store holds none of them.
//
// A run is `queued` until the worker's one transaction has generated it,
// then `succeeded` or `failed` (@waste/contracts/generation), and nothing on
// its row says whether its job is still alive: a run whose worker died stays
// open there for good, and only the API's own trigger knows better. So the
// page reads again only a run that is open and was last updated under
// fifteen minutes ago — every three seconds, one timer per run, none for the
// page — and stops once the run has finished, once that age has passed (the
// worker has not reported on it), or once the page is gone.
import type { GenerationRun } from "@waste/contracts/generation"

import { get, listPage, type ApiClient } from "../client"
import type { Problem } from "../problem"
import { problemOfError } from "./server-records"

/** How often an open run is read again. */
export const RUN_READ_EVERY_MS = 3_000

/** How long after its last update an open run is still read again; past it, the worker has not reported on it. */
export const RUN_REPORTS_WITHIN_MS = 15 * 60_000

/** How many of a scheme's runs the page shows: the newest. */
const RUNS_SHOWN = 10

/** A scheme's newest runs, newest first, as the API lists them. */
export async function schemeGenerationRuns(client: ApiClient, schemeServerId: string): Promise<GenerationRun[]> {
  const page = await listPage<GenerationRun>(client, `/route-schemes/${schemeServerId}/generation-runs`, { limit: RUNS_SHOWN })
  return page.items
}

/** One run, as the worker has left it. */
export function generationRunOf(client: ApiClient, runId: string): Promise<GenerationRun> {
  return get<GenerationRun>(client, `/generation-runs/${runId}`)
}

/**
 * How the page reads a run it shows: `watched` while it is open and was
 * last updated under fifteen minutes ago, `unreported` once it is open and
 * older than that, `finished` once it has succeeded or failed.
 */
export function runReading(run: Pick<GenerationRun, "status" | "updatedAt">, now: number): "watched" | "unreported" | "finished" {
  if (run.status !== "queued" && run.status !== "running") return "finished"
  return now - Date.parse(run.updatedAt) < RUN_REPORTS_WITHIN_MS ? "watched" : "unreported"
}

/** The timer a watch waits on; a test hands one it fires by hand. */
export type RunTimer = { set: (fire: () => void, ms: number) => unknown; clear: (handle: unknown) => void }

const TIMER: RunTimer = { set: (fire, ms) => setTimeout(fire, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }

export type RunWatch = {
  /** The run's read, cut short when the watch stops. */
  read: (runId: string, signal: AbortSignal) => Promise<GenerationRun>
  /** Every answer, the run as it now stands. */
  onRun: (run: GenerationRun) => void
  /** A read that failed; one the API refused (4xx) ends the watch, one it did not answer is tried again. */
  onProblem?: (problem: Problem) => void
  /** The run is open and past fifteen minutes since its last update: no longer read. */
  onUnreported?: (run: GenerationRun) => void
  timer?: RunTimer
  now?: () => number
}

/**
 * Watches one run: reads it again every three seconds while `runReading`
 * says `watched`, telling each answer, and stops by itself once it is not.
 * The run handed in is shown as it is, so the first read waits its
 * interval. Answers the stop, which clears the timer and drops a read in
 * flight — for the page that unmounts.
 */
export function watchGenerationRun(run: GenerationRun, { read, onRun, onProblem, onUnreported, timer = TIMER, now = Date.now }: RunWatch): () => void {
  const controller = new AbortController()
  let latest = run
  let handle: unknown
  let stopped = false

  // Waits for the next read while the run is watched, and says so once it is left unreported.
  const next = () => {
    const reading = runReading(latest, now())
    if (reading === "unreported") onUnreported?.(latest)
    if (reading === "watched") handle = timer.set(tick, RUN_READ_EVERY_MS)
  }
  const tick = () => {
    handle = undefined
    if (runReading(latest, now()) !== "watched") {
      next()
      return
    }
    read(latest.id, controller.signal).then(
      (answered) => {
        if (stopped) return
        latest = answered
        onRun(answered)
        next()
      },
      (error: unknown) => {
        if (stopped) return
        const problem = problemOfError(error)
        onProblem?.(problem)
        if (problem.status >= 400 && problem.status < 500) return
        next()
      },
    )
  }

  next()
  return () => {
    stopped = true
    controller.abort()
    if (handle !== undefined) timer.clear(handle)
  }
}
