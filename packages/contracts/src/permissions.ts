// What a role may do, on the wire. The vocabulary itself is not a wire
// concern: `@waste/domain/access/modules` spells every `workspace.module` key
// of the prototype's permission matrix and the four actions, and these schemas
// are that list turned into the check the API boundary runs (Issue #70). The
// database stores both as text — adding a module is a code change and never a
// migration — so this enum is what keeps an unknown key out of `role_grant`.
//
// This is the first contracts module that reads the domain: the inner ring
// depends on nothing, so contracts may depend on it and not the other way
// round. The purity gate lists the exact specifier below.
//
// The implied-`view` rule (`edit`, `create` and `delete` mean `view` too) is
// not spelled here: it is a rule about a grant set, and it lives in
// `@waste/domain/access/grants`, which both the seed and the API apply, so a
// body that arrives without `view` is accepted and stored with it.
import { ACTIONS, MODULE_KEYS } from "@waste/domain/access/modules"
import * as z from "zod"

/** A surface a grant can name: `workspace.module`, from the domain's vocabulary. */
export const ModuleKey = z.enum(MODULE_KEYS)
export type ModuleKey = z.infer<typeof ModuleKey>

/** What a grant allows on a module. */
export const Action = z.enum(ACTIONS)
export type Action = z.infer<typeof Action>

/** One module and the actions a role allows on it. A module absent from a role's grants is not allowed at all. */
export const Grant = z.object({
  moduleKey: ModuleKey,
  actions: z.array(Action),
})
export type Grant = z.infer<typeof Grant>
