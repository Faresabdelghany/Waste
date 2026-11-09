// What the app hands every route module (#574): one object, built once from
// the app's options, every default applied here or in the one module that
// owns it, and never in the composition root as well. A route module takes
// the whole object and reads what it needs, so a module that comes to need
// the clock or the job sender changes itself and nothing in app.ts.
import type { Database } from "@waste/db/client"
import { createJobSender, type JobSender } from "@waste/db/jobs"
import type { ProofStorage } from "@waste/db/storage"
import type { BuildInfo } from "@waste/contracts/health"
import { FakeProvider } from "@waste/routing/fake"
import type { RoutingIdentity, RoutingProvider } from "@waste/routing/provider"
import { QuotaEngine, quotaKnobs } from "@waste/routing/quota"
import type { Context, MiddlewareHandler } from "hono"

import type { AddressRegister } from "./address-register/register"
import { authenticate, identify } from "./auth/principal"
import { Allowance, FEED_ADDRESSES_PER_CLIENT, FEED_REQUESTS_PER_ADDRESS, FeedAllowance, PUBLIC_REQUESTS_PER_MINUTE, publicDoor, type PublicEnv } from "./auth/public-door"
import type { Verifier } from "./auth/verify"
import type { Guards } from "./operation"

/**
 * The preview's calls a minute per family unless ROUTING_PREVIEW_CALLS_PER_MINUTE
 * says otherwise: with the worker's 30 (ROUTING_CALLS_PER_MINUTE), the
 * Standard plan's 40 on the one key both processes call with — raising one
 * means lowering the other.
 */
export const PREVIEW_CALLS_PER_MINUTE = 10

/** The quota engine the guided setup's preview asks through (#173): the provider's, interactive and never waiting inside a request, at `callsPerMinute` or the preview's own. */
export const previewEngine = (provider: RoutingProvider, callsPerMinute = PREVIEW_CALLS_PER_MINUTE): QuotaEngine =>
  new QuotaEngine(provider, { ...quotaKnobs({ callsPerMinute }), waits: false })

export type AppOptions = {
  /** The pool /readyz probes, as the API role: server.ts builds it from probePoolOptions; a test hands whatever it wants probed. */
  probe: Database
  /** The request pool, as the API role: every authenticated request is one of its transactions. */
  pool: Database
  /** Verifies a bearer token against the project's keys; a test hands one over a local key set. */
  verifier: Verifier
  /** The server's clock; injected so a test can pin it. */
  now?: () => Date
  /** How long /readyz waits for the database before answering 503. */
  databaseTimeoutMs?: number
  /** Where the cause of a 500 goes, and what the driver door notes; console.error unless a test wants to look. */
  log?: (error: unknown) => void
  /** The build /healthz names: server.ts reads the image's build file (build-info.ts); null from a checkout. */
  build?: BuildInfo | null
  /**
   * pg-boss's `send` for this process, which runs no pg-boss (Issue #168):
   * the generation trigger sends the worker its job through it, inside the
   * request's transaction. Built over the probe pool when absent
   * (`createJobSender`, `@waste/db/jobs`): an instance never started, whose
   * one read is the queue's row — through the probe pool and never the
   * request pool, since a request holds its own connection while it sends,
   * and a cold cache under `max` such requests would wait for a connection
   * none of them can free.
   */
  jobs?: JobSender
  /** The routing provider (#170, #131): its name keys every Plan fingerprint, and no Plan route ever calls it (#124 §4). The preview's provider unless a test names another. */
  routing?: RoutingIdentity
  /**
   * The provider behind the quota engine the guided setup's preview asks
   * through (#173), the one route that calls it, interactive class and never
   * waiting inside a request (`waits: false`). server.ts builds it from the
   * environment, with the key; absent, the fake with the preview's knobs; a
   * test injects one over a scripted fake.
   */
  routingEngine?: QuotaEngine
  /** Each public client's requests a minute on the public door (ADR-0010): PUBLIC_REQUESTS_PER_MINUTE unless set, on the app's clock. */
  publicRequestsPerMinute?: number
  /** The public door's allowance itself, where a test injects one with a small allowance or a pinned clock. */
  publicAllowance?: Allowance
  /** Each company's ingest batches a minute at `POST /sensor-readings` (O26 of #290); the module's own unless a test injects a small allowance or a pinned clock. */
  sensorIngestAllowance?: Allowance
  /** An address's calendar feed's own allowance, per client and address and per client across addresses; a test injects small bounds or a pinned clock. */
  feedAllowance?: FeedAllowance
  /** Each company's weighbridge batches a minute (O27 of #290); the module's own unless a test injects a small allowance or a pinned clock. */
  weighbridgeAllowance?: Allowance
  /** A weighbridge batch's bytes before the token is read; the module's own unless a test injects a small bound. */
  weighbridgeMaxBodyBytes?: number
  /** The socket's peer address, the public door's client where no trusted proxy names one: server.ts reads the Node request's; a test has none. */
  peer?: (c: Context) => string | undefined
  /** How many proxies in front of the API append to X-Forwarded-For (PUBLIC_TRUSTED_PROXIES): 0, the default, ignores the header. */
  trustedProxies?: number
  /** The address register the lookup and a property's `addressId` ask (#291 C13); null where ADDRESS_PROVIDER names none, and the lookup answers 503. server.ts builds it from the environment, with the token; a test injects the fake, scripted down where it needs the 502. */
  addressRegister?: AddressRegister | null
  /** The proofs' Storage (O1 of #290), which signs uploads and reads of photos and signatures; null where the deployment holds no service-role key, and its routes answer 503. server.ts builds it from the environment; a test injects a fake. */
  storage?: ProofStorage | null
}

export type RouteDeps = Guards & {
  now: () => Date
  log: (error: unknown) => void
  jobs: JobSender
  routing: RoutingIdentity
  routingEngine: QuotaEngine
  storage: ProofStorage | null
  addressRegister: AddressRegister | null
  /** The public door (ADR-0010), and the calendar feed's, counted by its address as well. */
  publicDoor: MiddlewareHandler<PublicEnv>
  feedDoor: MiddlewareHandler<PublicEnv>
  sensorIngestAllowance?: Allowance
  weighbridgeAllowance?: Allowance
  weighbridgeMaxBodyBytes?: number
}

export function routeDeps({
  pool,
  verifier,
  probe,
  now = () => new Date(),
  log = console.error,
  jobs = createJobSender(probe),
  routingEngine = previewEngine(new FakeProvider()),
  routing = { name: routingEngine.name },
  publicRequestsPerMinute = PUBLIC_REQUESTS_PER_MINUTE,
  publicAllowance = new Allowance(publicRequestsPerMinute, now),
  feedAllowance = new FeedAllowance(FEED_REQUESTS_PER_ADDRESS, FEED_ADDRESSES_PER_CLIENT, now),
  peer = () => undefined,
  trustedProxies = 0,
  storage = null,
  addressRegister = null,
  sensorIngestAllowance,
  weighbridgeAllowance,
  weighbridgeMaxBodyBytes,
}: AppOptions): RouteDeps {
  return {
    authenticate: authenticate({ pool, verifier }),
    identify: identify({ pool, verifier }),
    now,
    log,
    jobs,
    routing,
    routingEngine,
    storage,
    addressRegister,
    publicDoor: publicDoor({ pool, allowance: publicAllowance, peer, trustedProxies }),
    // A feed is counted by its address too: the path's `:id`, read before it is validated, so a malformed one counts like any other.
    feedDoor: publicDoor({ pool, allowance: { take: (client, c) => feedAllowance.take(client, c.req.param("id") ?? "") }, peer, trustedProxies }),
    sensorIngestAllowance,
    weighbridgeAllowance,
    weighbridgeMaxBodyBytes,
  }
}
