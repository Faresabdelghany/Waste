// Service frequency — the typed home for the customer's collection-cadence
// promise (issue #20).
//
// The frequency promise is a reusable, project-scoped Pickup Setting record
// referenced by product and container — NOT a field on the agreement
// (agreement views display what the container inherits). This catalog has that shape
// under the canonical "Service frequency" name: containers and products
// reference a definition by id (submittedValues.serviceFrequencyId), the
// container's "Service frequency" fact is derived from it, and agreements
// display the frequency inherited from their assigned container.
//
// Vocabulary follows the server's interval model (collections/week plus
// weeks-between or days-between — every-N-weeks is natively expressible by
// shape even where no definition is seeded). The interval fields are what the
// reconciliation validation (issue #21) actually compares against scheme
// recurrence, via promisedCollectionsPerWeek. Each definition also names the
// scheme RecurrenceFrequency its display label corresponds to; that mapping
// is a vocabulary link, and the rate fallback for `monthly` only — the
// prototype's `monthly` has no server-vocabulary counterpart (no weeks-between
// value is faithful), so that definition carries only the scheme mapping.
//
// The catalogue is the demo tenant's: the web's fixture records name a
// definition by id, and `pnpm db:seed` writes one `service_frequency` row per
// definition and project (packages/db/src/seed/registry.ts).

import type { RecurrenceFrequency } from "@waste/domain/planning/vocabulary"

export type ServiceFrequencyDefinition = {
  id: string
  /** Display name — the derived "Service frequency" fact value. */
  name: string
  description: string
  /** Real-product interval vocabulary. null = on demand (no promised cadence). */
  collectionsPerWeek: number | null
  /** Weeks between collections when collectionsPerWeek is 1. */
  weeksBetween: number | null
  /** Days between collections when collectionsPerWeek is above 1. */
  daysBetween: number | null
  /**
   * The scheme cadence this promise's label corresponds to — a vocabulary
   * link, and the reconciliation rate fallback for the interval-less monthly
   * definition only (the issue #21 comparison itself runs on the interval
   * fields, promisedCollectionsPerWeek). null = no scheme equivalent.
   */
  schemeFrequency: RecurrenceFrequency | null
  /** Project-scoped like the real record. Ids match FIXTURE_PROJECT_IDS. */
  projectIds: readonly string[]
}

const ALL_PROJECTS = ["project-copenhagen", "project-harbor"] as const

export const SERVICE_FREQUENCIES = [
  {
    id: "freq-weekly",
    name: "Every week",
    description: "One collection per week on the serviced weekday.",
    collectionsPerWeek: 1,
    weeksBetween: 1,
    daysBetween: null,
    schemeFrequency: "weekly",
    projectIds: [...ALL_PROJECTS],
  },
  {
    id: "freq-every-2-weeks",
    name: "Every 2 weeks",
    description: "One collection every second week (14-day service).",
    collectionsPerWeek: 1,
    weeksBetween: 2,
    daysBetween: null,
    schemeFrequency: "every-2-weeks",
    projectIds: [...ALL_PROJECTS],
  },
  {
    id: "freq-monthly",
    name: "Once a month",
    description:
      "The first serviced weekday of each month. No faithful weeks-between value exists — the real model is strictly week-based.",
    collectionsPerWeek: 1,
    weeksBetween: null,
    daysBetween: null,
    schemeFrequency: "monthly",
    projectIds: [...ALL_PROJECTS],
  },
  {
    id: "freq-on-demand",
    name: "On demand",
    description: "No standing cadence — collections are ordered per occasion.",
    collectionsPerWeek: null,
    weeksBetween: null,
    daysBetween: null,
    schemeFrequency: null,
    projectIds: [...ALL_PROJECTS],
  },
] as const satisfies readonly ServiceFrequencyDefinition[]

/** A definition's id: `freq-weekly`. */
export type ServiceFrequencyId = (typeof SERVICE_FREQUENCIES)[number]["id"]
