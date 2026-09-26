// Planning's closed lists (Issue #97): the days a rule may name, the cadences
// and rotations a Route Scheme recurs by, what a scheme does on a holiday and
// on an edit, what it collects, how a Collection Group finds its stops, and
// the statuses and purposes its rows carry. Like the Registry's
// (registry/vocabulary.ts), the database reads each list into its `CHECK`
// (`oneOf`, and for a set of days `subsetOf`, in packages/db/src/schema/checks.ts)
// and the contracts read the same list into a `z.enum`, so the check at the
// API boundary and the check in the column cannot drift.
//
// Three lists moved here from the route-scheme modules that grew them —
// `SERVICE_DAYS` from route-schemes/recurrence.ts, `HOLIDAY_POLICIES` from
// route-schemes/occurrences.ts, `SCHEME_EDIT_POLICIES` from
// route-schemes/creation.ts — and each of those modules re-exports its list,
// so no import in this package or in apps/web changed. `RECURRENCE_FREQUENCIES`
// is the tuple the existing `RecurrenceFrequency` union is now read off.
// One list is the tokens of a display tuple the prototype still reads by
// name: `SERVICE_TYPES` of route-schemes/scope.ts's `SCHEME_SERVICE_TYPES`
// ("Container collection"); the display tuple stays the web's until the
// adapter (#81) maps it, and this module is what the database and the API
// speak. The vehicle a rule asks for was a token list here too
// (`STOP_MATCH_VEHICLE_TYPES`, "a working taxonomy until Resources"); it left
// with Resources (Issue #101), where a vehicle type is a company's row
// (`vehicle_type`) and a rule names it by id, while route-schemes/matching.ts
// keeps its display tuple for the web. The last two lists are part B's
// (generation as a job) and are here because they are only tuples.
//
// A value is a kebab-case token: it goes into a migration as a SQL literal
// and onto the wire as an enum member, and those are the same string. A list
// is a `readonly` tuple with a type read off it; `PLANNING_VOCABULARIES`
// names them all for the test that walks them.

/** The seven weekdays, Monday first: a scheme's service days, a group's days, a project's weekend. */
export const SERVICE_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const
/** How often a Route Scheme recurs; `every-4-weeks` is kept for stored records, the forms offer the other five. */
export const RECURRENCE_FREQUENCIES = ["daily", "weekly", "every-2-weeks", "every-3-weeks", "every-4-weeks", "monthly"] as const
/** Which ISO-week parity an `every-2-weeks` scheme serves. */
export const WEEK_ROTATIONS = ["odd", "even"] as const
/** What a scheme does with a collection that falls on a holiday. */
export const HOLIDAY_POLICIES = ["shift-next", "shift-prev", "skip", "collect"] as const
/** What a recurrence date became under the holiday policy: a reading `generateOccurrences` answers, never stored. */
export const OCCURRENCE_STATUSES = ["planned", "shifted", "skipped", "holiday"] as const
/** How a later edit of a scheme with generated routes applies: ask each time, apply to future collections, or this collection only (route-schemes/edit.ts, #38). */
export const SCHEME_EDIT_POLICIES = ["ask", "future", "single"] as const
/** What kind of work a Route Scheme plans. */
export const SERVICE_TYPES = ["container-collection", "underground-collection", "kerbside-collection", "crane-collection", "tank-emptying"] as const
/** How a Collection Group finds its stops: a Stop Matching Rule, or containers picked by hand. */
export const STOP_SOURCES = ["rule", "manual"] as const
/** The stored half of a scheme's lifecycle; scheduled, effective and expired are readings of runs and of the period. */
export const ROUTE_SCHEME_STATUSES = ["draft", "validated"] as const
/** Why the Planning Area exists, which decides what reads it. */
export const PLANNING_AREA_PURPOSES = ["route-planning", "service-operations", "notification"] as const
/** What started a generation run (part B). */
export const GENERATION_TRIGGERS = ["on-demand", "cron"] as const
/** Where a generation run stands (part B). */
export const GENERATION_RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const

export type ServiceDay = (typeof SERVICE_DAYS)[number]
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number]
export type WeekRotation = (typeof WEEK_ROTATIONS)[number]
export type HolidayPolicy = (typeof HOLIDAY_POLICIES)[number]
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number]
export type SchemeEditPolicy = (typeof SCHEME_EDIT_POLICIES)[number]
export type ServiceType = (typeof SERVICE_TYPES)[number]
export type StopSource = (typeof STOP_SOURCES)[number]
export type RouteSchemeStatus = (typeof ROUTE_SCHEME_STATUSES)[number]
export type PlanningAreaPurpose = (typeof PLANNING_AREA_PURPOSES)[number]
export type GenerationTrigger = (typeof GENERATION_TRIGGERS)[number]
export type GenerationRunStatus = (typeof GENERATION_RUN_STATUSES)[number]

/**
 * The working week a Project has until it says otherwise: Saturday and
 * Sunday. Not a vocabulary but a value of one — the one spelling the database
 * column's default (`packages/db/src/schema/organisation.ts`) and the
 * contracts' `ProjectCreate` default are both built from, so the two cannot
 * drift. A weekend never holds all seven days: a project has a working day.
 */
export const DEFAULT_WEEKEND = ["saturday", "sunday"] as const satisfies readonly ServiceDay[]

/** Every list of this module by its name, for a test that walks them and for a reader looking for the whole vocabulary at once. */
export const PLANNING_VOCABULARIES = {
  SERVICE_DAYS,
  RECURRENCE_FREQUENCIES,
  WEEK_ROTATIONS,
  HOLIDAY_POLICIES,
  OCCURRENCE_STATUSES,
  SCHEME_EDIT_POLICIES,
  SERVICE_TYPES,
  STOP_SOURCES,
  ROUTE_SCHEME_STATUSES,
  PLANNING_AREA_PURPOSES,
  GENERATION_TRIGGERS,
  GENERATION_RUN_STATUSES,
} as const satisfies Record<string, readonly [string, ...string[]]>
