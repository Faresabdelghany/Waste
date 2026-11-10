// The commands a Service Provider's account sends on the Pilot (#291 slice
// 23b, C24): the adapters' own, by module, offered only where its role allows
// `edit` (`useCommandOffered`). Its workspace — /me read, its team's and
// its tickets' forms — is lib/data/provider-workspace.ts'.
import type { ModuleKey } from "@waste/domain/access/modules"

import { TEAM_MODULE } from "@/lib/data/provider-workspace"
import { allows, type Grants } from "@/lib/modules/grants"
import { moduleKeyOf } from "@/lib/modules/keys"

import { DEACTIVATE_USER, REACTIVATE_USER } from "./records/organisation"
import { COMPLETE_ACTIVITY, WITHDRAW_ACTIVITY } from "./records/provider-activities"
import { ASSIGN_ROUTE, DISPATCH_ROUTE } from "./records/routes"

/**
 * The commands a Service Provider's account sends, by module (#291 slice
 * 23b): it crews a route it runs and sends it to its own driver, and switches
 * its own team's accounts off and on again. Every other command of a module —
 * a stop's, a ticket's, a ticket's patch — is the office's: the API finds no
 * row for a provider's, so no surface offers it one.
 */
/** A row's own fields changed by its patch, which a surface asks after as it asks after a command: a provider's account patches no ticket. */
export const PATCH_RECORD = "patch"

export const PROVIDER_COMMANDS: Readonly<Partial<Record<ModuleKey, readonly string[]>>> = {
  "route-studio.routes": [ASSIGN_ROUTE, DISPATCH_ROUTE],
  [moduleKeyOf(TEAM_MODULE.workspaceId, TEAM_MODULE.moduleId)]: [DEACTIVATE_USER, REACTIVATE_USER],
  // Its own proposals and notes (#474): withdrawn, completed and corrected; the office alone decides a proposal.
  "service-providers.activities": [WITHDRAW_ACTIVITY, COMPLETE_ACTIVITY, PATCH_RECORD],
}

/**
 * Whether a surface offers a command of a module to the account signed in:
 * an office account every one, as before; a provider's account those the
 * API gives a provider (`PROVIDER_COMMANDS`), and only where its role allows
 * `edit` on the module.
 */
export function commandOffered(account: { provider: boolean; grants: Grants | undefined }, moduleKey: ModuleKey, command: string): boolean {
  if (!account.provider) return true
  return (PROVIDER_COMMANDS[moduleKey] ?? []).includes(command) && allows(account.grants, moduleKey, "edit")
}
