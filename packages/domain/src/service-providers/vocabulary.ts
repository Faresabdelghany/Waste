// The service providers' closed lists (#474): what a Service Provider
// Activity is about, and where it stands. Like every vocabulary of this
// package, the database reads each list into its `CHECK` (`oneOf`) and the
// contracts read the same list into a `z.enum`, so neither can drift.
//
// A value is a kebab-case token: it goes into a migration as a SQL literal
// and onto the wire as an enum member. `SERVICE_PROVIDER_VOCABULARIES` names
// them all for the test that walks them.

/**
 * What a Service Provider Activity is about. A proposal — a `route-day-change`,
 * a Collection Group of a scheme the provider serves run on other days from a
 * day — asks for the office's Approval, which writes the scheme's next version;
 * a `compliance-follow-up` is the office asking the provider to bring what its
 * award requires up to date by a day; a `coordination-note` is a dated note
 * between the two, open until either closes it. A `vehicle-change` is a
 * proposal too: the group runs with another vehicle, and optionally another
 * driver, from a day; a `stop-set-change` the containers a group that picks
 * its stops runs on, in stop order, from a day. The other proposal kinds of
 * #474 join this list one by one, each with what approval applies.
 */
export const SERVICE_PROVIDER_ACTIVITY_KINDS = ["route-day-change", "compliance-follow-up", "coordination-note", "vehicle-change", "stop-set-change"] as const
/**
 * Where an Activity stands. A proposal is pending approval until the office
 * approves or rejects it or its provider withdraws it; every other kind is
 * open until it is completed or cancelled. Every end is final, and overdue is
 * a reading of an open follow-up's due day, never a status.
 */
export const SERVICE_PROVIDER_ACTIVITY_STATUSES = ["pending-approval", "approved", "rejected", "withdrawn", "open", "completed", "cancelled"] as const

export type ServiceProviderActivityKind = (typeof SERVICE_PROVIDER_ACTIVITY_KINDS)[number]
export type ServiceProviderActivityStatus = (typeof SERVICE_PROVIDER_ACTIVITY_STATUSES)[number]

/** Every list of this module by its name, for a test that walks them and for a reader looking for the whole vocabulary at once. */
export const SERVICE_PROVIDER_VOCABULARIES = {
  SERVICE_PROVIDER_ACTIVITY_KINDS,
  SERVICE_PROVIDER_ACTIVITY_STATUSES,
} as const satisfies Record<string, readonly [string, ...string[]]>
