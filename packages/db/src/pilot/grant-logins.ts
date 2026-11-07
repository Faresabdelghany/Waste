// `grant-logins` (Issue #152): the app roles' hosted logins, from the `pilot`
// environment's URL secrets and nothing else — the owner's, and one for every
// role the table (roles.ts) gives a URL of its own. Before any statement
// runs, every URL is held to what it must be — the Pilot's session pooler,
// the `postgres` database, the user `<role>.<ref>` of the role it is for and
// of the Pilot's Supabase project (`passwordOf`) — and every password is
// handed back for the workflow to mask, so a secret pasted into the wrong
// variable, or pointed at another Supabase project, is refused by name and
// never printed. The grant itself is `grantLogin` (bootstrap.ts), the
// statement the local bootstrap runs; the bootstrap plan keeps refusing any
// host that is not this machine.
import { GRANTED_ROLES, OWNER } from "../roles"
import { passwordOf, type PilotTarget } from "../supabase"

export type PilotLogin = { role: string; password: string }
export type PilotLoginPlan = {
  /** The roles to give LOGIN, each with its password. */
  logins: PilotLogin[]
  /** Every password the URLs carry, for the workflow to mask before anything runs. */
  secrets: string[]
}

/** Holds each URL, keyed by its `pilot` secret's name, to the Pilot and to its role; answers the logins and every secret to mask. */
export function planPilotLogins(urls: Readonly<Record<string, string | undefined>>, pilot: PilotTarget): PilotLoginPlan {
  const owner = passwordOf(OWNER, urls[OWNER.urls.pilot], pilot)
  const logins = GRANTED_ROLES.map((role) => ({ role: role.name, password: passwordOf(role, urls[role.urls.pilot], pilot) }))
  return { logins, secrets: [owner, ...logins.map((login) => login.password)] }
}
