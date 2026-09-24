// The access half of Organisation & Access on the wire (Issue #70): who may
// sign in to a company, what role they hold, and what that role allows. Same
// split as organisation.ts — a resource carries what the server owns, a write
// body only what a caller may say, and every write body is strict, so a
// member the server owns is refused by name instead of silently dropped.
//
// A user's status is derived and never stored: `deactivated` while
// `deactivated_at` is set, `invited` while no login is bound, else `active`.
// Deactivated wins over invited, so an account that was switched off never
// looks like a pending invitation. The rule itself is the API's (one
// function, one test); here it is only the vocabulary the wire uses.
//
// What an account reaches is exactly one of three things, which is why
// `UserInvite` and the access half of `UserPatch` are a one-of and not three
// independent fields: every project of the company (`allProjects: true`),
// the projects it is given (`projectIds`, its Project Access rows), or one
// Service Provider (`serviceProviderId`, its Service Provider Access). A
// provider user takes no Project Access and a company user no Service
// Provider Access — the database says so too, since a Service Provider Access
// can only name the provider the account belongs to. `allProjects: false` is
// not a way to say anything: absent is.
//
// A role's grants travel with it, whole: `Role.grants` is the matrix as the
// system stores it, and `RoleGrants` replaces it. The set is normalised by
// @waste/domain/access/grants on the way in and out (`edit`, `create` and
// `delete` imply `view`), so a body that ticks one box and not the other is
// stored the same as one that ticks both. A seeded role's `key` and its
// `system` flag are its for life: neither write body names them.
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { Id } from "./ids"
import { Grant } from "./permissions"
import { Label } from "./text"

/** What the server owns on every resource here. */
const stamped = {
  id: Id,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}

/** A patch must change something. */
const somethingToChange = { message: "Give at least one field to change" }
const changesSomething = (patch: object) => Object.keys(patch).length > 0

/**
 * A user's status, derived from the row: `invited` until a login is bound,
 * `deactivated` while the account is switched off (which wins), else `active`.
 */
export const UserStatus = z.enum(["invited", "active", "deactivated"])
export type UserStatus = z.infer<typeof UserStatus>

/** The three ways an account reaches something, as a write body spells them. */
const access = {
  /** Every project of the company. `false` is not a value: leave it out. */
  allProjects: z.literal(true).optional(),
  /** The projects the account works in; at least one, and each one of the company's. */
  projectIds: z.array(Id).min(1).optional(),
  /** The Service Provider the account belongs to; it takes no Project Access. */
  serviceProviderId: Id.optional(),
}

type Access = { allProjects?: true; projectIds?: string[]; serviceProviderId?: string }
const waysGiven = (body: Access) =>
  [body.allProjects, body.projectIds, body.serviceProviderId].filter((given) => given !== undefined).length

const exactlyOneWay = {
  message: "Give exactly one of allProjects: true, projectIds or serviceProviderId",
}
const atMostOneWay = {
  message: "Give at most one of allProjects: true, projectIds or serviceProviderId",
}

export const User = z.object({
  ...stamped,
  email: z.email(),
  fullName: Label,
  /** Derived, never stored. */
  status: UserStatus,
  roleId: Id,
  allProjects: z.boolean(),
  /** The account's Project Access rows; empty when it reaches every project or belongs to a provider. */
  projectIds: z.array(Id),
  serviceProviderId: Id.nullable(),
  /** At most one account per company is it, and it cannot be deactivated, re-roled or narrowed. */
  primaryAdministrator: z.boolean(),
  deactivatedAt: IsoDateTime.nullable(),
})
export type User = z.infer<typeof User>

/**
 * An invitation: the account is written with no login bound (`invited`), and
 * the invitation e-mail itself is Supabase's. The e-mail is stored lowercase;
 * the route lowercases it before the database sees it, and the database's
 * check is the backstop, so what arrives here is what the caller typed.
 */
export const UserInvite = z
  .strictObject({
    email: z.email(),
    fullName: Label,
    roleId: Id,
    ...access,
  })
  .refine((body) => waysGiven(body) === 1, exactlyOneWay)
export type UserInvite = z.infer<typeof UserInvite>

/**
 * What an administrator may change about an account: its name, its role, and
 * the one way it reaches something. The access half is optional as a whole —
 * a patch that names none of the three leaves the account's access alone —
 * and naming two of them is a mistake, not a merge. The e-mail is the
 * invitation's and the status is derived, so neither is here.
 */
export const UserPatch = z
  .strictObject({
    fullName: Label.optional(),
    roleId: Id.optional(),
    ...access,
  })
  .refine(changesSomething, somethingToChange)
  .refine((patch) => waysGiven(patch) <= 1, atMostOneWay)
export type UserPatch = z.infer<typeof UserPatch>

export const Role = z.object({
  ...stamped,
  /** The stable key of a seeded role (`company-administrator`, ...); null for a custom one. */
  key: z.string().nullable(),
  name: Label,
  /** The label of what the role reaches: Company, Assigned projects, Own service provider, ... */
  scope: Label,
  description: Label,
  system: z.boolean(),
  /** The whole matrix, normalised. A module absent from it is not allowed at all. */
  grants: z.array(Grant),
})
export type Role = z.infer<typeof Role>

/** A custom role: the server writes `key: null` and `system: false`, so neither is here. */
export const RoleCreate = z.strictObject({
  name: Label,
  scope: Label,
  description: Label,
  grants: z.array(Grant).default([]).describe("Defaults to none when absent: a role that may do nothing until its matrix is set."),
})
export type RoleCreate = z.infer<typeof RoleCreate>

/** The copy of a role, a seeded one included. Its key and its system flag are not a caller's to change. */
export const RolePatch = z
  .strictObject({
    name: Label.optional(),
    scope: Label.optional(),
    description: Label.optional(),
  })
  .refine(changesSomething, somethingToChange)
export type RolePatch = z.infer<typeof RolePatch>

/** The whole matrix, replacing what the role had. An empty list is a role that may do nothing. */
export const RoleGrants = z.strictObject({ grants: z.array(Grant) })
export type RoleGrants = z.infer<typeof RoleGrants>
