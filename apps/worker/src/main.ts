// The process entry: read the environment, open the pools, start pg-boss with
// every job of the registry, bind the probes, stop on the signals a host
// sends. Everything with behaviour lives in the modules this file composes,
// and is tested there.
//
// Three pools. pg-boss's own, through `pg`, on the worker role's URL
// (boss.ts). Then two of `@waste/db`'s on the two roles: the API role's, on
// which every job writes under `withCompany`, and the worker role's, on which
// the sweeps read across tenants; both go into the context every handler
// receives. A fourth, the probe pool /readyz uses, is one connection on the
// API role's URL (readiness.ts says why a probe gets its own). Opening the
// three `@waste/db` pools connects to nothing — postgres.js dials on the first
// query — but `startBoss` does: pg-boss checks the installed schema version
// before anything else, so a worker on a database without migration 0011, or
// with a pg-boss whose schema moved, exits here with the reason, and never
// polls a schema it does not understand.
//
// The probes bind after pg-boss started, so `/readyz` never answers for a
// process that is about to exit, and `/healthz` answers only for one that
// took its queues. A host that probes `/healthz` before the bind sees a
// refused connection, which is the same answer as a process still loading
// its modules, and waits. A boot that fails — the schema missing, the role
// refused, the port taken — is printed and exits 1 in so many words, rather
// than left to Node's unhandled-rejection report of a top-level await, so a
// host's log names the reason and its restart policy sees a clean exit code.
import { createDb } from "@waste/db/client"

import { createApp } from "./app"
import { createBoss, startBoss } from "./boss"
import { parseEnv } from "./env"
import { JOBS } from "./jobs"
import { staleOutboxCount } from "./jobs/relay-outbox"
import { listen } from "./listen"
import { CHECK_TIMEOUT_MS, probePoolOptions } from "./readiness"

const env = parseEnv(process.env)
const api = createDb(env.DATABASE_URL)
const worker = createDb(env.WORKER_DATABASE_URL)
const probe = createDb(env.DATABASE_URL, probePoolOptions(CHECK_TIMEOUT_MS))
const boss = createBoss({ url: env.WORKER_DATABASE_URL })
let started = false

/** pg-boss started with every job, and the probes bound; a failure of either is the process's exit. */
async function boot() {
  const running = await startBoss(boss, JOBS, {
    api,
    worker,
    now: () => new Date(),
    log: (message) => console.log(message),
    send: (name, data, options) => boss.send(name, data, options),
  })
  started = true
  const listening = await listen(createApp({ probe, boss: { boss, queues: running.queues, isStarted: () => started }, checkTimeoutMs: CHECK_TIMEOUT_MS, staleOutbox: () => staleOutboxCount(worker, new Date()) }), {
    host: env.HOST,
    port: env.PORT,
  })
  return { running, listening }
}

const { running, listening } = await boot().catch(async (error: unknown) => {
  console.error(`@waste/worker failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  await Promise.allSettled([boss.stop({ graceful: false, close: true, timeout: 1_000 }), probe.close(), api.close(), worker.close()])
  process.exit(1)
})
console.log(`@waste/worker running ${running.queues.length} ${running.queues.length === 1 ? "queue" : "queues"} (${running.queues.join(", ")}), probes on ${listening.url}`)

// Shutdown: the workers stop taking jobs and a handler in flight gets
// STOP_TIMEOUT_MS to finish before pg-boss fails it and closes its pool;
// the listener drains alongside, since a probe mid-shutdown should read
// "stopped" and then nothing. The two application pools close after, so a
// handler that is finishing keeps the connection its transaction runs on.
// Every close is idempotent, so a signal delivered twice joins the one
// shutdown; hence `on`, not `once`. Every failure is printed, and any
// failure exits 1.
const shutdown = async () => {
  started = false
  const outcomes = await Promise.allSettled([running.stop(), listening.close(), probe.close()])
  outcomes.push(...(await Promise.allSettled([api.close(), worker.close()])))
  const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
  for (const { reason } of failures) console.error(reason)
  process.exit(failures.length === 0 ? 0 : 1)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
