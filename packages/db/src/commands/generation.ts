// What the two processes share of generation's job (Issue #97 part B): the
// queue the job is sent to and what it carries. A run of generation is asked
// for twice over — by the office's button (`POST /route-schemes/:id/generate`
// in apps/api) and by the nightly sweep (`planning.plan-ahead` in
// apps/worker) — and worked once, by `planning.generate-routes` in the worker;
// each sender writes the `generation_run` and sends this job in one
// transaction, so the queue's name and the payload are spelled here, once,
// rather than in two apps that cannot import each other.
//
// The queue is `exclusive` and every send carries the scheme's id as
// `singletonKey` (the worker's job definition creates it so), so while a job
// of a scheme is queued or active a second send answers null and no second
// run is started: two clicks, or a click beside the night's sweep, are one
// run.

/** The queue the generation job is sent to and worked on. */
export const GENERATE_ROUTES_QUEUE = "planning.generate-routes"

/** What the generation job carries. */
export type GenerateRoutesData = {
  /** The `generation_run` the sender wrote, `queued`. */
  generationRunId: string
  /** The run's company, so the handler opens the fenced transaction without a cross-tenant read. */
  companyId: string
}
