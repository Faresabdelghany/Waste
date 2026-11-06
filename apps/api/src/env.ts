// The process environment, declared with @waste/server/env's pieces: where
// to listen, the database, and the Supabase project whose Auth signs the
// tokens; the routing provider and its key, which the guided setup's preview
// calls (#173); the address register, its token and its gateway, which the
// address lookup calls (#291 C13); and the knobs, absent unless set (#149:
// the Pilot's are its host's environment, never a default here). The keys of
// `Env` are the variables turbo.json hands `@waste/api#dev`, exactly.
import { Host, parseEnvironment, Port, PostgresUrl, wholeNumber } from "@waste/server/env"
import { API_PORT, type Environment } from "@waste/server/process"
import * as z from "zod"

/** The database, as the API role `wms_api` (see .env.example at the repository root; through Supabase's pooler the user is `wms_api.<project-ref>`). */
const DatabaseUrl = PostgresUrl("the API role's connection string")

/**
 * The Supabase project whose Auth issues the tokens this API accepts. The
 * issuer a token must carry is `${SUPABASE_URL}/auth/v1` and the keys it is
 * verified against are published at `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`
 * (auth/verify.ts spells both from this value). An origin and nothing more:
 * http or https, a host, and no path, query, fragment or credentials. A
 * trailing slash is refused, not stripped, so the one spelling in .env is the
 * one the issuer is compared against. No default: without it no token can be
 * verified, and an API that cannot verify a token has no authenticated route.
 */
const SupabaseUrl = z.string().refine(isOrigin, {
  error: "must be the project's origin, https://<project-ref>.supabase.co, without a trailing slash, path, query or credentials",
})

function isOrigin(value: string): boolean {
  if (!/^https?:\/\//.test(value) || value.endsWith("/")) return false
  try {
    const url = new URL(value)
    return url.hostname !== "" && url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === ""
  } catch {
    return false
  }
}

/**
 * The request pool's size: how many connections every authenticated request
 * shares (server.ts). postgres.js's 10 unless set; the probe pool is one more
 * and is not counted here.
 */
const PoolMax = wholeNumber(1, " of connections, at least 1")

export const Env = z.object({
  HOST: Host,
  PORT: Port(API_PORT),
  DATABASE_URL: DatabaseUrl,
  SUPABASE_URL: SupabaseUrl,
  /** The routing provider's name (#170, #131): unset means the fake; the one validator of the value is providerFromEnv (@waste/routing/select), so the refusal has one spelling. */
  ROUTING_PROVIDER: z.string().optional(),
  /** Supabase's service-role key (O1 of #290): the API signs uploads and reads of proof photos and signatures in the private `proofs` bucket with it (`@waste/db/storage`), server-side only, never logged and never the web's. Unset, those routes answer 503 and the Driver App keeps its photos waiting. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  /** OpenRouteService's key (#171), when ROUTING_PROVIDER names it: the guided setup's preview calls the provider from the API (#173); one person's, server-side only, never logged; `providerFromEnv` refuses the provider without it. */
  OPENROUTESERVICE_API_KEY: z.string().optional(),
  /** How many preview calls a minute the API makes per family (#173): PREVIEW_CALLS_PER_MINUTE, 10, unless set — the rest of the plan's 40 beside the worker's ROUTING_CALLS_PER_MINUTE, on the one key. The preview is interactive, so the reserves are the worker's alone. */
  ROUTING_PREVIEW_CALLS_PER_MINUTE: wholeNumber(1, " of calls a minute, at least 1"),
  /** The address register's name (#291 C13): unset means none, and the lookup answers 503; `fake` only where named (CI, e2e, a developer's .env); the one validator of the value is addressRegisterFrom (address-register/select.ts), so the refusal has one spelling. */
  ADDRESS_PROVIDER: z.string().optional(),
  /** The owner's Dataforsyningen token (#77), when ADDRESS_PROVIDER names `dataforsyningen`: the address lookup calls the register from the API alone; server-side only, never logged; `addressRegisterFrom` refuses the register without it. */
  DATAFORSYNINGEN_TOKEN: z.string().optional(),
  /** The register's gateway, `https://api.dataforsyningen.dk` unless set: the one seam its URL sits behind. */
  ADDRESS_REGISTER_URL: z.url({ protocol: /^https?$/ }).optional(),
  DATABASE_POOL_MAX: PoolMax,
  /** Each public client's requests a minute on the public door (ADR-0010): PUBLIC_REQUESTS_PER_MINUTE, 60, unless set. */
  PUBLIC_REQUESTS_PER_MINUTE: wholeNumber(1, " of requests a minute, at least 1"),
  /**
   * How many proxies in front of the API append to X-Forwarded-For (ADR-0010):
   * the public door counts a client by the entry the outermost one wrote. Unset
   * is 0, which ignores the header and counts the socket's peer, since a header
   * no trusted proxy wrote is whatever the client says.
   */
  PUBLIC_TRUSTED_PROXIES: wholeNumber(0, " of proxies, 0 or more"),
})
export type Env = z.infer<typeof Env>

/** Reads the environment, or throws one error naming every bad variable. */
export const parseEnv = (source: Environment): Env => parseEnvironment(Env, source)
