// Organisation & Access's closed lists (Issue #70): where a company and a
// project stand, and a user's status. The database reads the company's and
// the project's into its `CHECK` (`oneOf` in packages/db/src/schema/checks.ts)
// and the contracts read all three into their `z.enum`, so the check at the
// API boundary and the check in the column cannot drift.
//
// A user's status is derived and never stored: `deactivated` while the
// account is switched off, which wins, `invited` while no login is bound,
// else `active`. The rule is the API's (apps/api/src/access-shape.ts); this is
// the vocabulary it answers in.

/** A company's status: onboarding until its first project runs. */
export const COMPANY_STATUSES = ["active", "onboarding"] as const
export type CompanyStatus = (typeof COMPANY_STATUSES)[number]

/** A project's status: onboarding until it runs. */
export const PROJECT_STATUSES = ["active", "onboarding"] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

/** A user's status, derived from the row. */
export const USER_STATUSES = ["invited", "active", "deactivated"] as const
export type UserStatus = (typeof USER_STATUSES)[number]

/** Every list of the module, for a test that walks them. */
export const ACCESS_VOCABULARIES = { COMPANY_STATUSES, PROJECT_STATUSES, USER_STATUSES } as const
