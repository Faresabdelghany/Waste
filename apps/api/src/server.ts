// The process entry: read the environment, open the database pools, build the
// verifier, bind the app, stop on the signals a host sends. Everything with
// behaviour lives in the modules this file composes, and is tested there.
//
// Two pools on the one connection string, both as the API role: the probe
// pool /readyz uses (probePoolOptions in readiness.ts says why a probe gets
// its own) and the request pool every authenticated request runs a
// transaction on (auth/principal.ts), sized by DATABASE_POOL_MAX where the
// environment sets it (#149) and postgres.js's 10 otherwise. Opening them connects to nothing:
// postgres.js dials on the first query, so the process starts whether or not
// the database is up, and /readyz says which (a database that is down at boot
// is the same as one that goes down later, and both are the balancer's to
// route around). The verifier holds the project's remote key set: jose
// fetches it on the first token, caches it, and refetches when a token names
// a key it has not seen, so key rotation needs no restart. The build /healthz
// names is the image's own file, read once here (build-info.ts): an image
// whose file says nothing usable stops before it binds.
import { createDb, DEFAULT_POOL_MAX } from "@waste/db/client"
import { providerFromEnv } from "@waste/routing/select"
import { createRemoteJWKSet } from "jose"

import { createApp } from "./app"
import { createVerifier, supabaseAuth } from "./auth/verify"
import { readBuildInfo } from "./build-info"
import { parseEnv } from "./env"
import { listen } from "./listen"
import { DATABASE_CHECK_TIMEOUT_MS, probePoolOptions } from "./readiness"

const env = parseEnv(process.env)
const build = readBuildInfo()
const probe = createDb(env.DATABASE_URL, probePoolOptions(DATABASE_CHECK_TIMEOUT_MS))
// An unset knob is `max: undefined`, which createDb reads as its default.
const pool = createDb(env.DATABASE_URL, { max: env.DATABASE_POOL_MAX })
const auth = supabaseAuth(env.SUPABASE_URL)
const verifier = createVerifier({ keySet: createRemoteJWKSet(auth.jwks), issuer: auth.issuer })
const listening = await listen(createApp({ probe, pool, verifier, databaseTimeoutMs: DATABASE_CHECK_TIMEOUT_MS, build, routing: providerFromEnv({ ROUTING_PROVIDER: env.ROUTING_PROVIDER }) }), {
  host: env.HOST,
  port: env.PORT,
})
console.log(`@waste/api listening on ${listening.url}, verifying tokens from ${auth.issuer}, build ${build?.commit ?? "none"}, request pool max ${env.DATABASE_POOL_MAX ?? DEFAULT_POOL_MAX}`)

// Shutdown: the listener drains and the probe pool closes together, since a
// probe is not a request and 503 is the right answer to one that arrives
// mid-shutdown; so the two ceilings (the listener's grace, the pool's end
// timeout) overlap instead of adding up. The request pool closes after the
// listener, so a request in flight keeps the connection its transaction runs
// on until it has answered. Every close is idempotent, so a signal delivered
// twice (a terminal Ctrl-C plus tsx's relay of it, or SIGINT followed by
// SIGTERM) joins the one shutdown instead of killing the process mid-drain;
// hence `on`, not `once`. Every failure is printed, not only the last, and
// any failure exits 1.
const shutdown = async () => {
  const outcomes = await Promise.allSettled([listening.close(), probe.close()])
  outcomes.push(...(await Promise.allSettled([pool.close()])))
  const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
  for (const { reason } of failures) console.error(reason)
  process.exit(failures.length === 0 ? 0 : 1)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
