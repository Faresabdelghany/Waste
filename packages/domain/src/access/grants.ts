// What a role allows, as data, and the one rule that tidies it.
//
// A grant is a module key and the actions allowed on it; absent is not
// allowed. The rule the prototype's permission matrix has always applied —
// editing, creating or deleting a record means seeing it — is spelled here
// once, because three places apply it: the seed writes the system roles'
// grants through it (packages/db/src/seed/demo.ts), the API resolves a
// caller's grants through it, and `PUT /roles/:id/grants` stores what it
// returns. A caller that ticks "can delete" and nothing else therefore gets
// the same rows whichever door it came through.
//
// Tidying also settles the spelling: one entry per module key, actions in
// ACTIONS order, entries sorted by module key, an empty action list dropped
// (a grant of nothing is not a grant). That makes two grant sets comparable
// by value — which is what a seed run that must change nothing needs.
import { ACTIONS, type Action, type ModuleKey } from "./modules"

/** The actions a role allows on one module. */
export type Grant = {
  moduleKey: ModuleKey
  actions: readonly Action[]
}

/** The action the other three imply. */
const IMPLIED_BY_ANY: Action = "view"

/**
 * The same grants, tidied but not read: one entry per module key with its
 * actions merged in ACTIONS order, entries sorted by module key, a module
 * granted nothing dropped. This is the half of the rule that only spells
 * things; a grant set that is stored or answered goes through
 * `normaliseGrants`, which also applies the implication. Pure.
 */
export function mergeGrants(grants: readonly Grant[]): Grant[] {
  const byModule = new Map<ModuleKey, Set<Action>>()
  for (const grant of grants) {
    if (grant.actions.length === 0) continue
    const actions = byModule.get(grant.moduleKey) ?? new Set<Action>()
    for (const action of grant.actions) actions.add(action)
    byModule.set(grant.moduleKey, actions)
  }
  return [...byModule.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([moduleKey, actions]) => ({ moduleKey, actions: ACTIONS.filter((action) => actions.has(action)) }))
}

/**
 * The same grants as the system stores them: `edit`, `create` and `delete`
 * each imply `view`, and the set is tidied as `mergeGrants` describes. Pure:
 * the input is left as it was, and normalising twice changes nothing.
 */
export function normaliseGrants(grants: readonly Grant[]): Grant[] {
  return mergeGrants(
    grants.map((grant) => (grant.actions.length === 0 ? grant : { ...grant, actions: [...grant.actions, IMPLIED_BY_ANY] })),
  )
}
