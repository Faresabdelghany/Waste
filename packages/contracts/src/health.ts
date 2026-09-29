// The two probes a host asks of the API. `GET /healthz` is liveness: the
// process is up and this is its clock, which lets a client spot a server whose
// time has drifted. `GET /readyz` is readiness: the API can serve a request
// right now, which means its one dependency, the database, answers. A load
// balancer takes an instance out of rotation on the second and leaves the
// process alone; a supervisor restarts it on the first. The readiness body
// says which check failed, so an operator reads the reason off the probe; with
// one check the status follows it exactly, and the union below says so, so a
// ready body with an unreachable database does not parse. More checks join
// `checks` when the API gains dependencies (the job queue, build-order step
// 6), and then "ok" means all of them.
//
// The worker (`apps/worker`, Issue #97 part B) asks the same two questions
// of itself and answers `/healthz` with the same body. Its readiness has two
// checks: `database`, the API role's pool every job writes on, and `boss`,
// pg-boss started and answering on the worker role's connection — "stopped"
// while the process is starting up or going down, "unreachable" when it is
// started and its database does not answer. A ready body carries
// `failedJobs`, the count of failed jobs still retained across its queues,
// which is the number an operator or an alert reads off the probe; the
// unavailable body names the check that failed, and a body whose status
// disagrees with its checks does not parse, as the API's does not.
//
// `/healthz` also says which build answers (Issue #152): `build.commit` is
// the full id of the commit the image was built from, baked into the image
// as a file written from its build argument beside the OCI revision label,
// never a runtime variable a host could set, and null where the process runs
// from a checkout or an image built without it. The Pilot's release proves a
// deployment live by reading it; both probes answer `Cache-Control: no-store`,
// so what a release observes is the process and never a cache's copy.
import * as z from "zod"

import { IsoDateTime } from "./dates"

/** What both probes answer in `Cache-Control` (Issue #152): never cached, so what a release observes is the process and never a cache's copy. */
export const PROBE_CACHE_CONTROL = "no-store"
/** The response headers both probes answer with, the one spelling the API, the worker and the Pilot's release share. */
export const PROBE_HEADERS: Record<string, string> = { "Cache-Control": PROBE_CACHE_CONTROL }

/** A full commit id, as a build records it and GitHub names it: forty lowercase hex digits. */
export const CommitId = z.string().regex(/^[0-9a-f]{40}$/, "a full commit id: forty lowercase hex digits")

/** What an image says about its own build: the commit it was built from. */
export const BuildInfo = z.object({ commit: CommitId })
export type BuildInfo = z.infer<typeof BuildInfo>

export const HealthResponse = z.object({
  status: z.literal("ok"),
  time: IsoDateTime,
  build: BuildInfo.nullable(),
})
export type HealthResponse = z.infer<typeof HealthResponse>

/** The 200 body of `GET /readyz`: every check passed. */
export const ReadyResponse = z.object({
  status: z.literal("ok"),
  checks: z.object({ database: z.literal("ok") }),
})
export type ReadyResponse = z.infer<typeof ReadyResponse>

/** The 503 body of `GET /readyz`: the database did not answer within the probe's bound. */
export const UnavailableResponse = z.object({
  status: z.literal("unavailable"),
  checks: z.object({ database: z.literal("unreachable") }),
})
export type UnavailableResponse = z.infer<typeof UnavailableResponse>

export const ReadinessResponse = z.discriminatedUnion("status", [ReadyResponse, UnavailableResponse])
export type ReadinessResponse = z.infer<typeof ReadinessResponse>

/** What the worker's database check answers. */
export const WorkerDatabaseCheck = z.enum(["ok", "unreachable"])
/** What the worker's pg-boss check answers: started and answering, not started, or started and not answering. */
export const WorkerBossCheck = z.enum(["ok", "stopped", "unreachable"])

/** The 200 body of the worker's `GET /readyz`: both checks passed, this many failed jobs are retained across its queues, this many wait on its dead-letter queue where it has one, and, where the worker relays an outbox, this many rows have waited unpublished past its stale bound. */
export const WorkerReadyResponse = z.object({
  status: z.literal("ok"),
  checks: z.object({ database: z.literal("ok"), boss: z.literal("ok") }),
  /** Failed jobs still retained, a rolling count of recent failures under each queue's retention and not an all-time total; zero is the healthy answer. */
  failedJobs: z.int().min(0),
  /** Jobs waiting on the consumers' dead-letter queue (`outbox.dead`): each failed past its retries and waits, data intact, for an operator's redrive. Information for an operator, never a reason for a 503; absent where the worker names no dead-letter queue or has not created it yet. */
  deadLetters: z.int().min(0).optional(),
  /** Outbox rows unpublished for longer than the relay's stale bound (an hour), across companies: a poison event or a relay that has not run. Information for an operator, never a reason for a 503; absent where the worker could not count in time. */
  staleOutbox: z.int().min(0).optional(),
})
export type WorkerReadyResponse = z.infer<typeof WorkerReadyResponse>

/** The 503 body of the worker's `GET /readyz`: at least one check did not pass, and the checks say which. */
export const WorkerUnavailableResponse = z
  .object({
    status: z.literal("unavailable"),
    checks: z.object({ database: WorkerDatabaseCheck, boss: WorkerBossCheck }),
  })
  .refine((body) => body.checks.database !== "ok" || body.checks.boss !== "ok", {
    error: "an unavailable body names a check that did not pass",
    path: ["checks"],
  })
export type WorkerUnavailableResponse = z.infer<typeof WorkerUnavailableResponse>

export const WorkerReadinessResponse = z.discriminatedUnion("status", [WorkerReadyResponse, WorkerUnavailableResponse])
export type WorkerReadinessResponse = z.infer<typeof WorkerReadinessResponse>
