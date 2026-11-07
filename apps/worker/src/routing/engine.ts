import type { JobContext } from "../runtime/definition"
import type { QuotaEngine } from "@waste/routing/quota"

/**
 * What a job that asks or makes a Plan adds to the core: the routing adapter
 * (#169, #171), the provider — the fake unless `ROUTING_PROVIDER` says
 * otherwise, built by main.ts through `providerFromEnv` (@waste/routing/select)
 * — behind the quota engine (@waste/routing/quota), which paces the calls,
 * holds the reserve and reads every answer. One per process, so one key's
 * quota is spent in one place. Never called inside a database transaction
 * (#124 §4); a test builds its own over a scripted fake.
 */
export type RoutingEngine = { routing: QuotaEngine }

/** The context of a routing job. */
export type RoutingContext = JobContext & RoutingEngine
