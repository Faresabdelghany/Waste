// The access half of Organisation & Access (Issue #70): who may sign in to a
// company and what they may do there. Supabase Auth is the identity provider
// and knows nothing of companies; these tables do. A grant is present or
// absent, never effective-dated (ADR-0005): revocation is immediate because
// every request looks its grants up (ADR-0001).
//
// `user_account` (the wire object is `User`; `user` is reserved in SQL). Its
// status is derived, never stored: `invited` while `auth_user_id` is null,
// `deactivated` while `deactivated_at` is set, else `active`. `auth_user_id` is
// a soft reference to `auth.users`, not a foreign key: the access token hook
// (migration 0002) binds it on first sign-in, our own commands deactivate and
// reactivate, and the auth user's lifecycle stays Supabase's; a foreign key
// would couple `wms` to a schema another service migrates and make every API
// test seed `auth.users` as the owner. `unique (auth_user_id)` is one company
// per login for now, the one line to relax when a person has accounts in more
// than one. The e-mail is stored lowercase (the hook binds by
// `lower(claims.email)`) and is unique within the company. At most one account
// per company is the primary administrator: a partial unique index over
// `company_id where primary_administrator`. An account belongs to a Service
// Provider or to none; `unique (company_id, id, service_provider_id)` is what
// a Service Provider Access points at, so a grant can only name the provider
// the account belongs to.
//
// `role`: the eleven seeded roles carry a stable `key`
// (`company-administrator`, ..., `integration-writer`, spelled in
// @waste/domain/access/system-roles from slice 2) and `system = true`; a custom
// role has neither. `role_grant` is one `(module_key, action)` a role allows;
// `module_key` is a `workspace.module` key of the vocabulary and `action` one
// of view, edit, create, delete, both text checked at the API boundary by the
// contracts, so adding a module is a code change and not a migration.
//
// `project_access` is which projects a user works in (or `all_projects` on the
// account); `service_provider_access` is a provider user's grant for their
// provider. What that unlocks (the Service Areas assigned to the provider) is
// resolved when Finance & Contracting lands.
import { sql } from "drizzle-orm"
import { boolean, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { lowercase } from "./checks"
import { id, tenant, timestamps } from "./columns"
import { company, project, serviceProvider } from "./organisation"
import { companyReference, tenantIndex, tenantKey, tenantReference, tenantUnique, uniqueOn } from "./references"
import { wms } from "./wms"

export const role = wms.table(
  "role",
  {
    ...id,
    ...tenant,
    ...timestamps,
    /** The stable key of a seeded role; null for a custom one. */
    key: text(),
    name: text().notNull(),
    /** The label of what the role reaches: Company, Assigned projects, Own service provider, ... */
    scope: text().notNull(),
    description: text().notNull(),
    system: boolean().notNull(),
  },
  (t) => [companyReference(t, company), tenantUnique(t, t.key), tenantUnique(t, t.name), tenantKey(t)],
)

export const userAccount = wms.table(
  "user_account",
  {
    ...id,
    ...tenant,
    ...timestamps,
    /** `auth.users.id`, once the hook has bound the account; null while invited. */
    authUserId: uuid(),
    email: text().notNull(),
    fullName: text().notNull(),
    roleId: uuid().notNull(),
    allProjects: boolean().notNull().default(false),
    serviceProviderId: uuid(),
    primaryAdministrator: boolean().notNull().default(false),
    deactivatedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    tenantReference(t, [t.roleId], role),
    tenantReference(t, [t.serviceProviderId], serviceProvider),
    uniqueOn(t.authUserId),
    tenantUnique(t, t.email),
    tenantKey(t),
    tenantUnique(t, t.id, t.serviceProviderId),
    lowercase(t.email),
    uniqueIndex(tableObjectName(t.companyId.table, "primary_administrator_idx", "userAccount")).on(t.companyId).where(sql`${t.primaryAdministrator}`),
    tenantIndex(t, t.roleId),
    tenantIndex(t, t.serviceProviderId),
  ],
)

export const roleGrant = wms.table(
  "role_grant",
  {
    ...id,
    ...tenant,
    ...timestamps,
    roleId: uuid().notNull(),
    /** A `workspace.module` key of the vocabulary. */
    moduleKey: text().notNull(),
    /** view, edit, create or delete. */
    action: text().notNull(),
  },
  (t) => [tenantReference(t, [t.roleId], role), tenantUnique(t, t.roleId, t.moduleKey, t.action)],
)

export const projectAccess = wms.table(
  "project_access",
  {
    ...id,
    ...tenant,
    ...timestamps,
    userAccountId: uuid().notNull(),
    projectId: uuid().notNull(),
  },
  (t) => [
    tenantReference(t, [t.userAccountId], userAccount),
    tenantReference(t, [t.projectId], project),
    tenantUnique(t, t.userAccountId, t.projectId),
    tenantIndex(t, t.projectId),
  ],
)

export const serviceProviderAccess = wms.table(
  "service_provider_access",
  {
    ...id,
    ...tenant,
    ...timestamps,
    userAccountId: uuid().notNull(),
    serviceProviderId: uuid().notNull(),
  },
  (t) => [
    // The account's own provider, or nothing: the key names the provider column on both sides.
    tenantReference(t, [t.userAccountId, t.serviceProviderId], userAccount, [userAccount.id, userAccount.serviceProviderId]),
    tenantUnique(t, t.userAccountId, t.serviceProviderId),
  ],
)
