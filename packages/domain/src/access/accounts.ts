// What an account reaches is exactly one of three things: every project of
// the company, the projects it is given, or one Service Provider. An
// invitation names one way; a change to an account names at most one.

/** What an invitation naming no way, or two, is told. */
export const EXACTLY_ONE_WAY = "Give exactly one of allProjects: true, projectIds or serviceProviderId"

/** What a change naming two ways is told. */
export const AT_MOST_ONE_WAY = "Give at most one of allProjects: true, projectIds or serviceProviderId"

/**
 * The refusal of the account itself (RFC 9457's `type` and title): the token
 * is sound, but no active account in its company is bound to its login — the
 * token names no company, or the account there is deactivated or was never
 * this login's. Only the principal's two refusals carry it, and a client ends
 * its session on it; a permission refusal is `about:blank` and never ends one.
 */
export const NO_ACTIVE_ACCOUNT = { type: "urn:waste:problem:no-active-account", title: "No active account" } as const
