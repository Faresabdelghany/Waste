// The provider switch (#131): one environment setting on the API and the
// worker, read where their env modules read everything else. The fake is the
// default, and the only provider until #171 lands OpenRouteService — CI and
// the e2e lane never name anything else, since no credential exists on the
// public repository.
import { FakeProvider } from "./fake"
import type { RoutingProvider } from "./provider"

export const ROUTING_PROVIDER_VARIABLE = "ROUTING_PROVIDER"

export function providerFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): RoutingProvider {
  const name = env[ROUTING_PROVIDER_VARIABLE] || "fake"
  if (name === "fake") return new FakeProvider()
  throw new Error(`${ROUTING_PROVIDER_VARIABLE}=${name} names no provider here: "fake" is the one that exists (openrouteservice arrives with #171)`)
}
