// A run of generation, asked for (Issue #97 part B, #168): the queue the job
// is sent to, what it carries, and the one way a run is started. A run is
// asked for by the office's button (`POST /route-schemes/:id/generate` and
// the writes that hand a route back to generation, in apps/api) and by the
// nightly sweep (`planning.plan-ahead` in apps/worker), and worked once, by
// `planning.generate-routes` in the worker; every asker starts it here, so
// the run and its job are written one way, in one transaction.
//
// The queue is `exclusive` and every send carries the scheme's id as
// `singletonKey` (the worker's job definition creates it so), so while a job
// of a scheme is queued or active a second send answers null and no second
// run is started: two clicks, or a click beside the night's sweep, are one
// run. The job is sent first, under an id minted for the run, and the run
// written only once pg-boss has taken its job, so a send pg-boss absorbs
// writes nothing to take back, and a database no worker has started on
// (`QueueMissing`) is refused before anything is written.
import type { GenerationTrigger } from "@waste/domain/planning/vocabulary"

import type { Tx } from "../client"
import { newId } from "../ids"
import { sendInTransaction, type Send } from "../jobs"
import { generationRun } from "../schema/generation"

/** The queue the generation job is sent to and worked on. */
export const GENERATE_ROUTES_QUEUE = "planning.generate-routes"

/** What the generation job carries. */
export type GenerateRoutesData = {
  /** The `generation_run` the sender wrote, `queued`. */
  generationRunId: string
  /** The run's company, so the handler opens the fenced transaction without a cross-tenant read. */
  companyId: string
}

/**
 * Sends the generation of one run inside `tx`, under the scheme's id as
 * `singletonKey`: null when a job of that scheme is already queued or
 * active, in which case the caller writes no run — the run whose job pg-boss
 * holds covers it.
 */
export function sendGenerateRoutes(send: Send, tx: Tx, run: GenerateRoutesData & { routeSchemeId: string }): Promise<string | null> {
  const data: GenerateRoutesData = { generationRunId: run.generationRunId, companyId: run.companyId }
  return sendInTransaction(send, tx, GENERATE_ROUTES_QUEUE, data, { singletonKey: run.routeSchemeId })
}

/** What a run is asked over: the scheme, who asked, and the window of service dates. */
export type GenerationAsk = { companyId: string; projectId: string; routeSchemeId: string; trigger: GenerationTrigger; window: { from: string; to: string } }

/**
 * Starts a run of the scheme over the window in the caller's transaction:
 * its job sent, then the run written `queued` naming it. Answers the run's
 * id, or null where a job of the scheme is already queued or active, nothing
 * written; throws `QueueMissing` for a database no worker has started on.
 */
export async function startGenerationRun(tx: Tx, send: Send, ask: GenerationAsk): Promise<string | null> {
  const id = newId()
  const jobId = await sendGenerateRoutes(send, tx, { generationRunId: id, companyId: ask.companyId, routeSchemeId: ask.routeSchemeId })
  if (jobId === null) return null
  await tx
    .insert(generationRun)
    .values({ id, companyId: ask.companyId, projectId: ask.projectId, routeSchemeId: ask.routeSchemeId, trigger: ask.trigger, windowFrom: ask.window.from, windowTo: ask.window.to, status: "queued", jobId })
  return id
}
