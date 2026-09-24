// The two rules the access routes are made of, kept out of the handlers
// because both are worth reading on their own and neither needs a database.
//
// A user's status is derived, never stored (Issue #70's domain model): the
// row carries `auth_user_id` (bound by the access token hook on first
// sign-in) and `deactivated_at` (ours), and the status is what those two say.
// Deactivated wins over invited — an account that was switched off before
// anyone signed in must not read as a pending invitation, because the one
// thing an administrator would do about an invitation is send it again.
//
// What an account reaches is exactly one of three things, and the contracts'
// one-of rule holds a body to that (@waste/contracts/access). This turns the
// body into the shape the route writes: the account's own two columns, and
// the access rows beside them. The project list is kept exactly as the body
// spelled it, so a route that refuses one of them names it by its place in
// that list; a project named twice is one row, which is the write's business
// (`uniqueIds`) — the unique would refuse the second, and a caller repeating
// itself means no harm.
//
// A role's grants are here for the same reason: one spelling of "the set as
// the system stores it" for the two role routes that write one and the two
// that answer one, over the one rule in @waste/domain/access/grants (`edit`,
// `create` and `delete` imply `view`). A stored row naming a module or an
// action the vocabulary no longer has grants nothing — there is no surface
// with that key to reach — so it is dropped on the way out, as the principal
// lookup drops it on the way in (auth/principal.ts).
import type { UserStatus } from "@waste/contracts/access"
import type { Grant } from "@waste/contracts/permissions"
import { normaliseGrants } from "@waste/domain/access/grants"
import { ACTIONS, MODULE_KEYS } from "@waste/domain/access/modules"

/** The row's two columns the status is read from. */
export type StatusColumns = {
  /** `auth.users.id` once the hook has bound the account; null while invited. */
  authUserId: string | null
  deactivatedAt: Date | null
}

/** A user's status: deactivated if it is switched off, else invited until a login is bound, else active. */
export function userStatus({ authUserId, deactivatedAt }: StatusColumns): UserStatus {
  if (deactivatedAt !== null) return "deactivated"
  return authUserId === null ? "invited" : "active"
}

/** The one way an account reaches something. */
export type AccessShape =
  | { kind: "all-projects" }
  | { kind: "projects"; projectIds: string[] }
  | { kind: "provider"; serviceProviderId: string }

/** The access half of `UserInvite` and `UserPatch`, as the contracts spell it. */
export type AccessBody = {
  allProjects?: true | undefined
  projectIds?: string[] | undefined
  serviceProviderId?: string | undefined
}

/** The same ids, each once, in the order they came. */
export function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

/**
 * The access a body asks for, or undefined when it names none (a patch that
 * leaves the account's access alone). The projects come through in the body's
 * own order, repeats and all, because the route reports an unknown one by its
 * place in that list. Two ways at once is a bug here, not a refusal: the
 * contracts answered 400 long before the handler ran.
 */
export function accessOf(body: AccessBody): AccessShape | undefined {
  const given = [body.allProjects, body.projectIds, body.serviceProviderId].filter((value) => value !== undefined)
  if (given.length > 1) {
    throw new Error("an access change names exactly one of allProjects, projectIds and serviceProviderId")
  }
  if (body.allProjects !== undefined) return { kind: "all-projects" }
  if (body.projectIds !== undefined) return { kind: "projects", projectIds: [...body.projectIds] }
  if (body.serviceProviderId !== undefined) return { kind: "provider", serviceProviderId: body.serviceProviderId }
  return undefined
}

/** What the account's own row says about its access; the Project Access or Service Provider Access rows say the rest. */
export function accessColumns(shape: AccessShape): { allProjects: boolean; serviceProviderId: string | null } {
  return {
    allProjects: shape.kind === "all-projects",
    serviceProviderId: shape.kind === "provider" ? shape.serviceProviderId : null,
  }
}

const MODULE_KEY_SET: ReadonlySet<string> = new Set(MODULE_KEYS)
const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS)

/**
 * The same grants, as the system stores and answers them: `view` wherever
 * anything else is granted, one entry per module in ACTIONS order, entries
 * sorted by module key, a module granted nothing dropped. The actions are
 * copied, so what a caller gets is its own to hold.
 */
export function normalisedGrants(grants: readonly Grant[]): Grant[] {
  return normaliseGrants(grants).map((grant) => ({ moduleKey: grant.moduleKey, actions: [...grant.actions] }))
}

/** A role's `role_grant` rows as the set it grants; a row outside the vocabulary grants nothing. */
export function grantsOfRows(rows: readonly { moduleKey: string; action: string }[]): Grant[] {
  return normalisedGrants(
    rows.flatMap((row) =>
      MODULE_KEY_SET.has(row.moduleKey) && ACTION_SET.has(row.action)
        ? [{ moduleKey: row.moduleKey as Grant["moduleKey"], actions: [row.action as Grant["actions"][number]] }]
        : [],
    ),
  )
}
