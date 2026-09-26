// Where the web finds the API and the identity provider (Issue #81). Two
// pairs of public variables, inlined into the client bundle by Next at build
// time, which is why each is read by its literal name and never through a
// computed key:
//
//   NEXT_PUBLIC_WASTE_API_URL      — the base the browser calls: `/waste-api`
//                                    when next.config.mjs proxies to the API
//                                    (WASTE_API_ORIGIN set), or the API's own
//                                    origin once its CORS admits the web.
//                                    Unset, the adapter is off and every module
//                                    reads its fixtures and the browser's own
//                                    records, exactly as before this issue.
//   NEXT_PUBLIC_SUPABASE_URL and
//   NEXT_PUBLIC_SUPABASE_ANON_KEY  — the Supabase project whose Auth signs the
//                                    tokens the API verifies (the same project
//                                    the API's SUPABASE_URL names) and its
//                                    publishable key, which Auth asks for on
//                                    every request and which is safe in a
//                                    browser: it opens nothing by itself, and
//                                    the domain schema is not exposed to it
//                                    (ADR-0001). Unset, /login offers no
//                                    password sign-in, only the fixture picker.
//
// Read once at module load; a test hands `apiConfigOf` and `authConfigOf` an
// environment of its own.

export type ApiConfig = {
  /** The base every request path is appended to; no trailing slash. */
  baseUrl: string
}

export type AuthConfig = {
  /** The Supabase project's origin, no trailing slash. */
  supabaseUrl: string
  /** The project's publishable (anon) key, sent as `apikey`. */
  anonKey: string
}

type Env = Readonly<Record<string, string | undefined>>

const trimmed = (value: string | undefined): string | undefined => {
  const text = value?.trim()
  return text === undefined || text === "" ? undefined : text.replace(/\/+$/, "")
}

/** The API the browser calls, or null when none is configured and the adapter stays off. */
export function apiConfigOf(env: Env): ApiConfig | null {
  const baseUrl = trimmed(env.NEXT_PUBLIC_WASTE_API_URL)
  return baseUrl === undefined ? null : { baseUrl }
}

/** The identity provider /login signs in against, or null when the picker is all there is. */
export function authConfigOf(env: Env): AuthConfig | null {
  const supabaseUrl = trimmed(env.NEXT_PUBLIC_SUPABASE_URL)
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
  return supabaseUrl === undefined || !anonKey ? null : { supabaseUrl, anonKey }
}

// The literal reads Next inlines. Anything else in the environment is not
// the browser's business.
const PUBLIC_ENV: Env = {
  NEXT_PUBLIC_WASTE_API_URL: process.env.NEXT_PUBLIC_WASTE_API_URL,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
}

export const API_CONFIG: ApiConfig | null = apiConfigOf(PUBLIC_ENV)
export const AUTH_CONFIG: AuthConfig | null = authConfigOf(PUBLIC_ENV)
