// Recycling-centre visits' closed lists (Issue #393, M4 of #293): what an
// Access Credential is, where a Site Visit came from and how it was
// identified, whether it was admitted and why not, and what a Visit Rule says
// of its charge. Like every context's lists, the database reads each into its
// `CHECK` (`oneOf`, packages/db/src/schema/checks.ts) and the contracts into
// a `z.enum`, so the two cannot drift.
//
// `ACCESS_CREDENTIAL_KINDS` is a vehicle plate or an access card.
// `SITE_VISIT_SOURCES` is the attendant's check-in or the gate's read (M8 of
// #293, ADR-0011). `SITE_VISIT_IDENTIFICATIONS` is how a visit was
// identified: a plate or a card as read, or the Property the attendant found
// by its address. `SITE_VISIT_REFUSAL_REASONS` follows the identification
// order of visits/charges.ts. `VISIT_CHARGE_BASES` is a reading, never a
// column: why a visit costs what it costs.

/** What a credential is: a vehicle plate, or an access card. */
export const ACCESS_CREDENTIAL_KINDS = ["plate", "card"] as const
/** Who recorded a visit: the site's attendant at check-in, or the gate's read (M8 of #293). */
export const SITE_VISIT_SOURCES = ["staff", "gate"] as const
/** How a visit was identified: a plate or a card as read, or the Property the attendant found by its address. */
export const SITE_VISIT_IDENTIFICATIONS = ["plate", "card", "property"] as const
/** Whether a visit was let in. A refused visit is still recorded: the ledger says who was turned away. */
export const SITE_VISIT_OUTCOMES = ["admitted", "refused"] as const
/** Why a visit was refused, in the identification order: no credential for the plate or the card, a household not paying for collection, a credential blocked. */
export const SITE_VISIT_REFUSAL_REASONS = ["unknown-identifier", "not-fee-paying", "credential-blocked"] as const
/** Why a visit costs what it costs: no rule in force, only free fractions brought, inside the household's free visits, a step of the ladder, inside a business's annual access, or a business's per-visit product. A reading, never a column. */
export const VISIT_CHARGE_BASES = ["no-rule", "free-fractions", "free-quota", "ladder", "annual-access", "per-visit"] as const

export type AccessCredentialKind = (typeof ACCESS_CREDENTIAL_KINDS)[number]
export type SiteVisitSource = (typeof SITE_VISIT_SOURCES)[number]
export type SiteVisitIdentification = (typeof SITE_VISIT_IDENTIFICATIONS)[number]
export type SiteVisitOutcome = (typeof SITE_VISIT_OUTCOMES)[number]
export type SiteVisitRefusalReason = (typeof SITE_VISIT_REFUSAL_REASONS)[number]
export type VisitChargeBasis = (typeof VISIT_CHARGE_BASES)[number]

/** Every list of this module by its name, for the test that walks them. */
export const VISITS_VOCABULARIES = {
  ACCESS_CREDENTIAL_KINDS,
  SITE_VISIT_SOURCES,
  SITE_VISIT_IDENTIFICATIONS,
  SITE_VISIT_OUTCOMES,
  SITE_VISIT_REFUSAL_REASONS,
  VISIT_CHARGE_BASES,
} as const satisfies Record<string, readonly [string, ...string[]]>
