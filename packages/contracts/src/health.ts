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
import * as z from "zod"

import { IsoDateTime } from "./dates"

export const HealthResponse = z.object({
  status: z.literal("ok"),
  time: IsoDateTime,
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
