// The worker's HTTP face, two probes and nothing else: `GET /healthz`
// (liveness: the process answers, with its clock) and `GET /readyz`
// (readiness: pg-boss is started and answering, the API role's pool answers,
// this many jobs have failed and, where the composition root hands a count
// in, this many outbox rows have waited unpublished past the relay's stale
// bound — a number for an operator, never a reason for a 503, and left out
// of the body when it did not answer within the bound). No document, no
// authentication, no other
// route — the worker takes work from pg-boss and never from HTTP, so an
// unknown path is a plain 404 with no body to speak of. Everything the
// probes read comes in from the composition root: the probe pool (main.ts
// builds it from probePoolOptions; a test hands whatever it wants probed) and
// the boss probe over the started instance, so a test asks the app with a
// database that goes nowhere and a boss that never started.
//
// The same split the API's `fly.toml` and Dockerfile make holds here: a host
// checks `/healthz`, since `/readyz` answering 503 while the database is
// down is the worker's own answer for an operator to read and never a reason
// to restart a process that will reconnect on its next poll.
import { HealthResponse, type WorkerReadinessResponse } from "@waste/contracts/health"
import type { Database } from "@waste/db/client"
import { Hono } from "hono"

import { CHECK_TIMEOUT_MS, checkBoss, checkDatabase, countStale, type BossProbe } from "./readiness"

export type AppOptions = {
  /** The pool /readyz probes, as the API role: main.ts builds it from probePoolOptions; a test hands whatever it wants probed. */
  probe: Database
  /** pg-boss as started, the registered queues and whether it is started right now. */
  boss: BossProbe
  /** The server's clock; injected so a test can pin it. */
  now?: () => Date
  /** How long /readyz waits for each check before answering 503. */
  checkTimeoutMs?: number
  /** The relay's stale count (`staleOutboxCount` over the worker role's pool), read beside the checks and carried on a ready body as information; omitted where the worker has no outbox to relay, as a test's may not. */
  staleOutbox?: () => Promise<number>
}

export function createApp({ probe, boss, now = () => new Date(), checkTimeoutMs = CHECK_TIMEOUT_MS, staleOutbox }: AppOptions) {
  const app = new Hono()

  app.get("/healthz", (c) => {
    const body: HealthResponse = { status: "ok", time: now().toISOString() }
    return c.json(body)
  })

  app.get("/readyz", async (c) => {
    const [database, bossCheck, stale] = await Promise.all([
      checkDatabase(probe.sql, { timeoutMs: checkTimeoutMs }),
      checkBoss(boss, { timeoutMs: checkTimeoutMs }),
      staleOutbox === undefined ? undefined : countStale(staleOutbox, { timeoutMs: checkTimeoutMs }),
    ])
    if (database === "ok" && bossCheck.boss === "ok") {
      const body: WorkerReadinessResponse = { status: "ok", checks: { database, boss: "ok" }, failedJobs: bossCheck.failedJobs, ...(stale === undefined ? {} : { staleOutbox: stale }) }
      return c.json(body, 200)
    }
    const body: WorkerReadinessResponse = { status: "unavailable", checks: { database, boss: bossCheck.boss } }
    return c.json(body, 503)
  })

  return app
}
