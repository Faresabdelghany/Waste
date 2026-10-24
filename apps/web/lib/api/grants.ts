// What a role's grants allow, as `/me` answers them: the one reading a page
// that asks the API directly makes of the role (the imports, the ticket SLA),
// where the record store's modules read theirs through records/modules.ts.

/** A role's grants as /me answers them. */
export type Grants = readonly { moduleKey: string; actions: readonly string[] }[]

/** Whether the grants allow the action on the module; nothing is allowed without grants. */
export const allows = (grants: Grants | undefined, moduleKey: string, action: string): boolean =>
  (grants ?? []).some((grant) => grant.moduleKey === moduleKey && grant.actions.includes(action))
