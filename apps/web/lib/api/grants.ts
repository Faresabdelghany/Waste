// What a role's grants allow, as `/me` answers them: the one reading of them,
// typed by the domain's module keys and actions, which every page, the
// record store's reads and the workspace's actions go through.
import type { Grant } from "@waste/domain/access/grants"
import type { Action, ModuleKey } from "@waste/domain/access/modules"
import { SYSTEM_ROLES, type SystemRoleKey } from "@waste/domain/access/system-roles"

import type { ModuleLocation } from "../data/business-modules"

/** A role's grants as /me answers them. */
export type Grants = readonly Grant[]

/** Whether the grants allow the action on the module; nothing is allowed without grants. */
export const allows = (grants: Grants | undefined, moduleKey: ModuleKey, action: Action): boolean =>
  (grants ?? []).some((grant) => grant.moduleKey === moduleKey && grant.actions.includes(action))

/** The modules the grants let a role view: the API grants `view` wherever it grants anything, so it is the one action to look for. */
export const viewedModules = (grants: Grants | undefined): ReadonlySet<ModuleKey> =>
  new Set((grants ?? []).filter((grant) => grant.actions.includes("view")).map((grant) => grant.moduleKey))

/**
 * The grant a workspace module is read under: its `workspace.module` key,
 * which lib/data/__tests__/permission-catalogue.test.ts holds to the
 * vocabulary. A module of no workspace in the catalogue names no grant, and
 * nothing is allowed on it.
 */
export const grantKeyOf = (location: ModuleLocation): ModuleKey => `${location.workspaceId}.${location.moduleId}` as ModuleKey

/** The charter a seeded role starts with: what a fixture persona works under. */
const charterOf = (key: SystemRoleKey): Grants => SYSTEM_ROLES.find((role) => role.key === key)?.grants ?? []

/** The account a shell is signed in as: on the Pilot `/me`'s, null until it answers; in fixture mode the persona's seeded role, where it has one. */
export type SignedInAccount = {
  apiConfigured: boolean
  me: { role: { grants: Grants } } | null
  fixtureRole?: SystemRoleKey
}

/**
 * The grants the account works under, or null where nothing holds it back:
 * fixture mode's office, which may do everything, and the Pilot's while
 * `/me` is unread — the API then refuses what the role does not allow, as
 * the record store tries every module where `/me` cannot be read.
 */
export function accountGrants(account: SignedInAccount): Grants | null {
  if (account.apiConfigured) return account.me?.role.grants ?? null
  return account.fixtureRole === undefined ? null : charterOf(account.fixtureRole)
}

/** Whether the account may take the action on the module: its grants allow it, or nothing holds it back. */
export const mayOn = (grants: Grants | null, moduleKey: ModuleKey, action: Action): boolean =>
  grants === null || allows(grants, moduleKey, action)
