// The body of `GET /me`: who the caller is, as the API resolved it for this
// request (Issue #70). Everything here is what the request path already looked
// up to let the request through, so it costs nothing extra: the account the
// token's `sub` is bound to, the company its `app_metadata.company_id` names,
// the role with its grants normalised (edit, create and delete imply view,
// `@waste/domain/access/grants`), the projects the account works in (every
// project of the company when `allProjects`, else its Project Access rows),
// and the Service Provider it belongs to or null.
//
// Summaries, not resources: a project is its id and name here, the full
// Project is `organisation.ts`'s and the full User and Role are `access.ts`'s
// (slices 4 and 5). The frontend reads this once after sign-in to draw the
// sidebar and the permission gates; a change to a grant or a project shows on
// the next call, since nothing here is cached server-side.
import * as z from "zod"

import { Id } from "./ids"
import { Grant } from "./permissions"
import { Label } from "./text"

/** The caller's account. Always `active`: an invited account has no token yet and a deactivated one is refused with 403 before this body. */
const MeUser = z.object({
  id: Id,
  email: z.email(),
  fullName: Label,
  status: z.literal("active"),
  /** Works in every project of the company; `projects` then lists them all. */
  allProjects: z.boolean(),
  /** The one account per company that cannot be deactivated, re-roled or scoped down. */
  primaryAdministrator: z.boolean(),
})

const MeCompany = z.object({
  id: Id,
  name: Label,
})

/** The caller's role, with the grants the API applies to this request. */
const MeRole = z.object({
  id: Id,
  /** The stable key of a seeded role; null for a custom one. */
  key: z.string().nullable(),
  name: Label,
  scope: Label,
  system: z.boolean(),
  /** Normalised: one entry per module, sorted by key, `view` wherever anything else is granted. */
  grants: z.array(Grant),
})

const MeProject = z.object({
  id: Id,
  name: Label,
})

const MeServiceProvider = z.object({
  id: Id,
  legalName: Label,
})

export const Me = z.object({
  user: MeUser,
  company: MeCompany,
  role: MeRole,
  /** Sorted by name. Empty for a provider user, who reaches Service Areas through the provider instead. */
  projects: z.array(MeProject),
  /** The provider a provider user belongs to; null for a company user. */
  serviceProvider: MeServiceProvider.nullable(),
})
export type Me = z.infer<typeof Me>
