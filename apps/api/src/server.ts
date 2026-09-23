// The process entry: read the environment, open the database pool, bind the
// app, stop on the signals a host sends. Everything with behaviour lives in
// the modules this file composes, and is tested there.
//
// One pool so far, the one /readyz probes (probePoolOptions in readiness.ts
// says why a probe gets its own; the request pool joins with the first domain
// route). Opening it connects to nothing: postgres.js dials on the first
// query, so the process starts whether or not the database is up, and /readyz
// says which (a database that is down at boot is the same as one that goes
// down later, and both are the balancer's to route around).
import { createDb } from "@waste/db/client"

import { createApp } from "./app"
import { parseEnv } from "./env"
import { listen } from "./listen"
import { DATABASE_CHECK_TIMEOUT_MS, probePoolOptions } from "./readiness"

const env = parseEnv(process.env)
const probe = createDb(env.DATABASE_URL, probePoolOptions(DATABASE_CHECK_TIMEOUT_MS))
const listening = await listen(createApp({ probe, databaseTimeoutMs: DATABASE_CHECK_TIMEOUT_MS }), { host: env.HOST, port: env.PORT })
console.log(`@waste/api listening on ${listening.url}`)

// Shutdown: the listener drains and the probe pool closes together, since a
// probe is not a request and 503 is the right answer to one that arrives
// mid-shutdown; so the two ceilings (the listener's grace, the pool's end
// timeout) overlap instead of adding up. A request pool, when there is one,
// closes after the listener, so a request in flight keeps the connection its
// queries run on. Every close is idempotent, so a signal delivered twice (a
// terminal Ctrl-C plus tsx's relay of it, or SIGINT followed by SIGTERM)
// joins the one shutdown instead of killing the process mid-drain; hence
// `on`, not `once`. Every failure is printed, not only the last, and any
// failure exits 1.
const shutdown = async () => {
  const outcomes = await Promise.allSettled([listening.close(), probe.close()])
  const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
  for (const { reason } of failures) console.error(reason)
  process.exit(failures.length === 0 ? 0 : 1)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
