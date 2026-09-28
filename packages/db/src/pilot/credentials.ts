// `grant-logins` (Issue #152): the app roles' hosted logins, from the `pilot`
// environment's three URL secrets and nothing else. Before any statement runs,
// every URL is held to what it must be — the Pilot's session pooler on 5432,
// the `postgres` database, the user `<role>.<ref>` of the role it is for — and
// every password is handed back for the workflow to mask, so a secret pasted
// into the wrong variable, or pointed at another Supabase project, is refused
// by name and never printed. The grant itself is `grantLogin` (bootstrap.ts),
// the statement the local bootstrap runs, for exactly the two roles; the
// bootstrap plans keep refusing any host that is not this machine.
import { API_ROLE, WORKER_ROLE } from "../roles"

/** The session pooler's port: migrations, pg-boss and the API all need a session (migrate.ts). */
const SESSION_POOLER_PORT = "5432"
const OWNER_ROLE = "postgres"

export type PilotLogin = { role: typeof API_ROLE | typeof WORKER_ROLE; password: string }
export type PilotLoginPlan = {
  /** The two roles to give LOGIN, each with its password. */
  logins: PilotLogin[]
  /** Every password the three URLs carry, for the workflow to mask before anything runs. */
  secrets: string[]
}

type Urls = { adminUrl: string; apiUrl: string; workerUrl: string }
type Expected = { ref: string; host: string }

function passwordOf(variable: string, raw: string, role: string, { ref, host }: Expected): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${variable}: not a postgresql:// URL`)
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new Error(`${variable}: not a postgresql:// URL`)
  if (url.hostname.toLowerCase() !== host) throw new Error(`${variable}: host is not the Pilot's session pooler`)
  if (url.port !== SESSION_POOLER_PORT) throw new Error(`${variable}: port ${url.port || "(none)"} is not the session pooler's ${SESSION_POOLER_PORT}`)
  if (url.pathname !== "/postgres") throw new Error(`${variable}: database is not postgres`)
  const user = decodeURIComponent(url.username)
  const dot = user.lastIndexOf(".")
  const [name, project] = dot === -1 ? [user, ""] : [user.slice(0, dot), user.slice(dot + 1)]
  if (name !== role) throw new Error(`${variable}: logs in as ${name}, not ${role}`)
  if (project !== ref) throw new Error(`${variable}: names another Supabase project`)
  const password = decodeURIComponent(url.password)
  if (password === "") throw new Error(`${variable}: carries no password`)
  return password
}

/** Holds the three URLs to the Pilot and to their roles; answers the two logins and every secret to mask. */
export function planPilotLogins({ adminUrl, apiUrl, workerUrl }: Urls, expected: Expected): PilotLoginPlan {
  const owner = passwordOf("PILOT_DATABASE_ADMIN_URL", adminUrl, OWNER_ROLE, expected)
  const api = passwordOf("PILOT_DATABASE_URL", apiUrl, API_ROLE, expected)
  const worker = passwordOf("PILOT_WORKER_DATABASE_URL", workerUrl, WORKER_ROLE, expected)
  return {
    logins: [
      { role: API_ROLE, password: api },
      { role: WORKER_ROLE, password: worker },
    ],
    secrets: [owner, api, worker],
  }
}
