// Local Logins for the local stack (Issue #151): a confirmed Supabase Auth
// Login for every seeded User Account and every extra address the environment
// names, so a person — or the e2e suite — can sign in through the real
// password grant against the stack `pnpm stack:start` brings up. The access
// token hook then binds each Login to its invited account on first sign-in,
// exactly as on the Pilot.
//
// This is local and CI bootstrap only, and the plan holds it to that: the
// Auth URL must be loopback, strictly, the way bootstrap refuses a non-local
// admin host. The Pilot's Logins are made by the owner alone (supabase/
// README.md, #129), and nothing here may ever become a provisioning path for
// them — a hosted URL is refused before any request is built.
//
// The Admin API is spoken directly (`POST /auth/v1/admin/users` under the
// stack's secret key): one call per address, `email_confirm: true` so no
// mail is involved, and one password for every Login, from
// `LOCAL_LOGIN_PASSWORD` or the public local default below. Idempotent: an
// address Auth already knows is left as it is, password included.
import { isLocalHost } from "../local-host"

/**
 * The one password every local Login gets unless `LOCAL_LOGIN_PASSWORD` says
 * otherwise. Public on purpose — it opens a stack on somebody's own machine
 * and nothing else — and longer than the eight characters
 * `minimum_password_length = 8` in supabase/config.toml asks for, locally as
 * on the Pilot (#164).
 * apps/web/e2e-api/env.ts spells the same value as the suite's default.
 */
export const DEFAULT_LOCAL_LOGIN_PASSWORD = "local-waste-password"

/** The shortest password local Auth accepts: `[auth] minimum_password_length` in supabase/config.toml, eight as on the Pilot (#164). */
export const MINIMUM_PASSWORD_LENGTH = 8

/**
 * The API e2e suite's tester (apps/web/e2e-api/env.ts spells the same
 * address as its default): in every local plan, so a stack started with
 * nothing set can run the suite, whose scenarios invite this address and
 * sign in as it. `LOCAL_EXTRA_LOGINS` adds to it, never replaces it.
 */
export const E2E_TESTER_LOGIN = "e2e-tester@waste-e2e.example"

export type LocalLoginsPlan = {
  /** The stack's API origin, loopback, no trailing slash (`http://127.0.0.1:54321`). */
  apiUrl: string
  /** The stack's secret key, sent as `apikey` and as the bearer. */
  secretKey: string
  password: string
  /** Every address to hold a Login, lowercase, each once, in the order given. */
  emails: readonly string[]
}

const trimmedOrigin = (url: string) => url.replace(/\/+$/, "")

/** `LOCAL_EXTRA_LOGINS` as addresses: separated by commas, whitespace or both; empty entries dropped. */
export function parseExtraLogins(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
}

/**
 * What `db:logins` will do, decided from the environment, the seed's own
 * list and the suite's tester, and refused when it would reach anything but
 * this machine. Pure, so the refusals are unit-tested.
 */
export function planLocalLogins({
  apiUrl,
  secretKey,
  password = DEFAULT_LOCAL_LOGIN_PASSWORD,
  seeded,
  extra = [],
}: {
  apiUrl: string | undefined
  secretKey: string | undefined
  password?: string
  seeded: readonly string[]
  extra?: readonly string[]
}): LocalLoginsPlan {
  if (!apiUrl) throw new Error("API_URL is not set: run `supabase status -o env` on a started stack, or let db:logins read it")
  let parsed: URL
  try {
    parsed = new URL(apiUrl)
  } catch {
    throw new Error(`API_URL is not a URL: ${apiUrl}`)
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !isLocalHost(apiUrl)) {
    throw new Error(
      `db:logins is for the local stack; API_URL points at ${parsed.hostname}. A hosted project's Logins are the owner's to create (supabase/README.md), never this script's.`,
    )
  }
  if (!secretKey) throw new Error("SECRET_KEY is not set: the stack's secret key from `supabase status -o env`")
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new Error(`LOCAL_LOGIN_PASSWORD has ${password.length} characters; local Auth requires at least ${MINIMUM_PASSWORD_LENGTH}`)
  }
  const emails: string[] = []
  for (const address of [...seeded, E2E_TESTER_LOGIN, ...extra]) {
    const email = address.trim().toLowerCase()
    if (email === "" || !email.includes("@")) throw new Error(`"${address}" is not an e-mail address`)
    if (!emails.includes(email)) emails.push(email)
  }
  return { apiUrl: trimmedOrigin(apiUrl), secretKey, password, emails }
}

export type LoginOutcome = "created" | "existing"

export type LocalLoginsReport = {
  created: string[]
  existing: string[]
}

/** How the Admin API says an address is taken; GoTrue has spelled it as a code and as a sentence over time. */
function alreadyRegistered(status: number, body: unknown): boolean {
  if (status !== 422 && status !== 400) return false
  if (typeof body !== "object" || body === null) return false
  const { error_code, msg, message } = body as { error_code?: unknown; msg?: unknown; message?: unknown }
  if (error_code === "email_exists") return true
  const sentence = typeof msg === "string" ? msg : typeof message === "string" ? message : ""
  return /already (been )?registered/i.test(sentence)
}

/** One Login, created confirmed, or found to exist already. Throws on any other answer, with Auth's sentence. */
export async function ensureLogin(plan: LocalLoginsPlan, email: string, doFetch: typeof fetch = fetch): Promise<LoginOutcome> {
  const response = await doFetch(`${plan.apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: plan.secretKey,
      authorization: `Bearer ${plan.secretKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ email, password: plan.password, email_confirm: true }),
  })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (response.ok) return "created"
  if (alreadyRegistered(response.status, body)) return "existing"
  const said = typeof body === "object" && body !== null ? ((body as { msg?: unknown }).msg ?? (body as { message?: unknown }).message) : undefined
  throw new Error(`Auth at ${plan.apiUrl} refused the Login for ${email}: HTTP ${response.status}${typeof said === "string" ? ` — ${said}` : ""}`)
}

/** Every Login of the plan, one after the other, and which were new. */
export async function ensureLogins(plan: LocalLoginsPlan, doFetch: typeof fetch = fetch): Promise<LocalLoginsReport> {
  const report: LocalLoginsReport = { created: [], existing: [] }
  for (const email of plan.emails) {
    report[await ensureLogin(plan, email, doFetch)].push(email)
  }
  return report
}

/**
 * `supabase status -o env` as variables: one `NAME="value"` per line, the
 * value optionally quoted; anything else on stdout (a notice, a blank line)
 * is skipped. The keys are the CLI's own names: `API_URL`, `PUBLISHABLE_KEY`,
 * `SECRET_KEY`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `DB_URL`, …
 */
export function parseStatusEnv(output: string): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (match === null) continue
    const [, name, raw] = match
    const value = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw
    variables[name] = value
  }
  return variables
}
