// The provider switch (#131): one environment setting on the API and the
// worker, read where their env modules read everything else. The fake is the
// default — CI and the e2e lane never name anything else, since no
// credential exists on the public repository — and OpenRouteService (#171)
// is the Pilot's. A process that calls the provider builds it with its key
// and, asked for it without one, refuses to start rather than fail every job
// on a 401; a process that only keys fingerprints and reads rows by the
// provider's name — the API, until S5's preview calls from it — reads the
// name alone, so the key lives only where calls are made.
import { FakeProvider } from "./fake"
import { OpenRouteServiceProvider } from "./openrouteservice"
import type { RoutingProvider } from "./provider"

export const ROUTING_PROVIDER_VARIABLE = "ROUTING_PROVIDER"
export const OPENROUTESERVICE_KEY_VARIABLE = "OPENROUTESERVICE_API_KEY"

const NAMES = ["fake", "openrouteservice"] as const
export type ProviderName = (typeof NAMES)[number]

/** The provider the environment names, checked; the fake where it names none. */
export function providerNameFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): ProviderName {
  const name = env[ROUTING_PROVIDER_VARIABLE] || "fake"
  if ((NAMES as readonly string[]).includes(name)) return name as ProviderName
  throw new Error(`${ROUTING_PROVIDER_VARIABLE}=${name} names no provider here: "fake" and "openrouteservice" are the ones that exist`)
}

export function providerFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): RoutingProvider {
  if (providerNameFromEnv(env) === "fake") return new FakeProvider()
  const apiKey = env[OPENROUTESERVICE_KEY_VARIABLE]?.trim()
  if (!apiKey) throw new Error(`${ROUTING_PROVIDER_VARIABLE}=openrouteservice needs ${OPENROUTESERVICE_KEY_VARIABLE}, the account's key, in this process's environment`)
  return new OpenRouteServiceProvider({ apiKey })
}
