// What recurs, on the wire (Issue #97, ADR-0002): the Route Scheme, its
// Collection Groups, and each group's Stop Matching Rule or picked containers.
// These are rules and never work: the generation job turns them into dated
// Routes and Pickups, and `Occurrence` is the pure preview of the dates it
// would plan, read through `GET /route-schemes/:id/occurrences`.
//
// A scheme is effective-dated (ADR-0005), its period the time it plans for,
// and the database holds one scheme of a name in force at a time, so "Create
// new version" is a new scheme of the same name starting when the old ends.
// `status` is the half of the lifecycle a person decides, `draft` or
// `validated`; scheduled, effective, expired and Attention are readings of
// runs, of the period and of the drift stamps, and none is on the wire. The
// recurrence has three rules the database cannot all hold, spelled once each
// with its sentence so the route can refuse a patch, which carries half the
// picture, in the same words: the week rotation belongs to `every-2-weeks`
// and to nothing else (`route_scheme_week_rotation_shape` holds it too), a
// daily scheme serves every weekday, and a group's days lie within the
// scheme's.
//
// A Collection Group finds its stops one way: `stopSource` says which, and
// the create body carries the rule or the containers to match it, never both
// — `ONE_WAY_TO_FIND_STOPS`, refused at `stopSource`. The rule is three things
// (the fractions it matches, one or more; the container types it is
// restricted to, none or more; the vehicle type it asks for, or none — a
// vehicle type being a row of the company's since Resources, Issue #101, and
// named by id where 0006 had a token), the manual alternative a list of
// containers in stop order. Both are sets and are replaced whole through their
// own routes; a group's patch moves its name, order, days and provider and
// never its source, its rule or its list. A scheme's patch may carry its
// groups whole instead (#205), each entry the create's group with the id it
// restates, so the scheme and its groups move in one request that the route
// holds once, on the state they leave behind. The implicit group of a scheme
// without explicit groups is a row the server writes:
// `RouteSchemeCreate.collectionGroups` has at least one entry, and the quick
// form's one rule becomes that one group. Fractions are the group's and
// plural, as the glossary has them; the adapter writes the scheme's one
// fraction into each group.
//
// Resources gave the group its vehicle and default driver and the scheme its
// depot and unloading station (Issue #101): the four are on the resources,
// nullable, and since #101's slice 6 on the write bodies too — the group's
// create and patch take `vehicleId` and `driverId`, the scheme's create and
// patch `depotId` and `unloadingStationId`, each nullable so a form may clear
// what it set — and the routes hold them: a powered vehicle of the project, a
// driver of the project who may take that vehicle, no vehicle or driver on
// two groups a shared day (a validated scheme's structural rule), a depot of
// the project, a station of the company. Not here: a scheme's own service
// demand (a Subscription is the Registry's).
//
// What the generation runs left is on the resource as a reading, `generation`
// (Issue #177, carried from #97 part B): when the scheme's last run
// succeeded, and each rule group's two latest match stamps — the set it
// matched as of a run's first day and the rule it matched under — which is
// what a client's drift reading compares (`containerDriftBetween`,
// apps/web/lib/prototype/route-schemes/container-drift). It is read from
// `generation_run` and `generation_match` whenever the scheme is, never kept
// on the scheme's row and never written by a body, so the one place it is
// stored is the runs'.
//
// A scheme's Seasons (O17 of #290) are a set like a rule's fractions: a
// stretch of every year, `startsOn` its first day and `endsOn` the first day
// out of it (month-days, `mm-dd`, half-open, over the new year where the end
// comes first), in which the scheme serves its service days at the season's
// cadence. The create writes them and a patch replaces them whole, `[]`
// clearing them; a body's seasons are held to one name each and to no day
// shared, which a list always shows whole, and a daily scheme carries none,
// a pair a patch may see half of and the route holds against the stored row.
import { ISO_WEEKS_MAX } from "@waste/domain/days"
import { PLAN_AHEAD_DAYS_BOUND, PLAN_AHEAD_DAYS_DEFAULT, PLAN_AHEAD_DAYS_MAX } from "@waste/domain/planning/lifecycle"
import {
  AT_MOST_GROUPS,
  AT_MOST_GROUPS_RESTATED,
  CONTAINERS_MAX,
  DAILY_HAS_NO_SEASONS,
  DAILY_SERVES_EVERY_DAY,
  dailyHasNoSeasons,
  dailyServesEveryDay,
  EACH_CONTAINER_ONCE,
  EACH_CONTAINER_TYPE_ONCE,
  EACH_FRACTION_ONCE,
  EACH_GROUP_NAME_ONCE,
  EACH_GROUP_ONCE,
  GROUPS_MAX,
  OCCURRENCE_WINDOW_MAX_DAYS,
  ONE_WAY_TO_FIND_STOPS,
  OUTSIDE_SERVICE_DAYS,
  WEEK_ROTATION_WITH_FORTNIGHTLY,
  weekRotationShape,
  WINDOW_AT_MOST_A_YEAR,
  withinServiceDays,
} from "@waste/domain/planning/schemes"
import { OCCURRENCE_STATUSES } from "@waste/domain/planning/vocabulary"
import { eachOnce } from "@waste/domain/requests"
import { AT_MOST_SEASONS, EACH_SEASON_NAME_ONCE, MONTH_DAY_SHAPE, MONTH_DAY_SOURCE, overlappingSeasons, SEASON_PART_OF_YEAR, SEASONS_KEEP_APART, SEASONS_MAX } from "@waste/domain/planning/seasons"
import * as z from "zod"

import { IsoDate, IsoDateTime, IsoTime } from "./dates"
import { Id } from "./ids"
import { HolidayPolicy, RecurrenceFrequency, RouteSchemeStatus, SchemeEditPolicy, SeasonFrequency, ServiceDays, ServiceType, StopSource, WeekRotation } from "./planning"
import { requiredDayWindow, ProjectScopedListQuery } from "./queries"
import { QueryFlag } from "./query-strings"
import { NonNegativeInt, PositiveInt, resourceBodies, stamped } from "./resource"
import { Label } from "./text"
import { effectiveDated, effectiveDatedBodies } from "./validity"

/** An order among siblings: whole and positive, since the first is number one, and no larger than `collection_group.position` holds — `PositiveInt`'s own bound, so a larger one is refused at its field rather than failing the write (22003). */
const Ordinal = PositiveInt

/** A distinct set of ids, bounded: a rule's two sets are bounded on the resource too, because the rule is one schema for the row and the body. */
const idSet = (message: string) => z.array(Id).max(CONTAINERS_MAX).refine((ids) => eachOnce(ids), { message })

/**
 * How a rule group finds its stops: the fractions it matches (one or more),
 * the container types it is restricted to (none or more) and the vehicle type
 * it asks for, if any — one of the company's rows, applied by generation
 * through the type's compatibility set and never by name — and the planning
 * area it matches within where it is not the scheme's. The same shape is
 * the resource's `rule` and the body of `PUT /collection-groups/:id/stop-matching-rule`.
 */
export const StopMatchingRule = z.strictObject({
  wasteFractionIds: idSet(EACH_FRACTION_ONCE).min(1),
  containerTypeIds: idSet(EACH_CONTAINER_TYPE_ONCE),
  vehicleTypeId: Id.nullable(),
  /** A planning area of the scheme's project the rule matches within instead of the scheme's (O30 of #290, row 2.17); null, or absent in a body, is the scheme's. */
  planningAreaId: Id.nullable().optional().describe("A planning area of the scheme's project the rule matches within instead of the scheme's; null or absent is the scheme's."),
})
export type StopMatchingRule = z.infer<typeof StopMatchingRule>

/** The whole rule, replacing what the group had. */
export const StopMatchingRuleSet = StopMatchingRule
export type StopMatchingRuleSet = z.infer<typeof StopMatchingRuleSet>

const ContainerIds = idSet(EACH_CONTAINER_ONCE)

/** The whole list in stop order, replacing what the group had; a manual group picks at least one. */
export const CollectionGroupContainersSet = z.strictObject({
  containerIds: ContainerIds.min(1),
})
export type CollectionGroupContainersSet = z.infer<typeof CollectionGroupContainersSet>

export const CollectionGroup = z.object({
  ...stamped,
  routeSchemeId: Id,
  /** Unique within the scheme. */
  name: Label,
  /** Group order: the first rule group wins a container on a shared day. */
  position: Ordinal,
  /** The scheme's service days this group runs on; empty for a group that no longer runs. */
  days: ServiceDays,
  stopSource: StopSource,
  /** The rule, for a rule group; null for a manual one. */
  rule: StopMatchingRule.nullable(),
  /** The picked containers in stop order, for a manual group; empty for a rule group. */
  containerIds: z.array(Id),
  serviceProviderId: Id.nullable(),
  /** The vehicle the group runs with, a powered vehicle of the project; null while unsaid. */
  vehicleId: Id.nullable(),
  /** The default driver, one of the project's who may take the vehicle; null while unsaid. */
  driverId: Id.nullable(),
})
export type CollectionGroup = z.infer<typeof CollectionGroup>

/** What a group whose source and stops disagree is told, at the field that says which it is. */
const oneWayToFindStops = { message: ONE_WAY_TO_FIND_STOPS, path: ["stopSource"] }

type StopsGiven = { stopSource?: string; rule?: unknown; containerIds?: readonly unknown[] | null }

/**
 * A rule group carries a rule and no containers, a manual group at least one
 * container and no rule. A null rule or an empty list counts as not given,
 * which is what a form with both fields sends for the half it does not use.
 */
export function oneWayToFindStopsGiven(body: StopsGiven): boolean {
  const byRule = body.rule != null
  const byContainers = (body.containerIds?.length ?? 0) > 0
  return body.stopSource === "rule" ? byRule && !byContainers : byContainers && !byRule
}

/** A group as a body spells it whole: what a create writes, and what an entry of a scheme's patch says the group now is. */
const collectionGroupBody = {
  name: Label,
  position: Ordinal.optional().describe("Where the group stands among the scheme's; after the last when absent."),
  days: ServiceDays,
  stopSource: StopSource,
  rule: StopMatchingRule.nullable().optional(),
  containerIds: ContainerIds.nullable().optional(),
  serviceProviderId: Id.nullable().optional(),
  /** A powered vehicle of the scheme's project (Issue #101). */
  vehicleId: Id.nullable().optional(),
  /** A driver of the scheme's project who may take the vehicle, judged on the scheme's start or today, whichever is later (Issue #101). */
  driverId: Id.nullable().optional(),
}

/**
 * The scheme is the path's and the project the scheme's, so neither is here;
 * the position is appended when absent. A patch moves the name, the order,
 * the days, the provider, the vehicle and the driver; the source, the rule
 * and the list never move through one.
 */
const collectionGroupBodies = resourceBodies(collectionGroupBody, { keys: ["stopSource", "rule", "containerIds"] })

export const CollectionGroupCreate = collectionGroupBodies.create.refine(oneWayToFindStopsGiven, oneWayToFindStops)
export type CollectionGroupCreate = z.infer<typeof CollectionGroupCreate>

/**
 * One entry of a scheme patch's `collectionGroups` (#205): the group whole, as
 * the create spells it, with the id of the scheme's group it restates, or no
 * id for a group the edit adds. A group keeps its source for life, which the
 * route holds against the stored one.
 */
export const CollectionGroupEntry = z
  .strictObject({
    id: Id.optional().describe("The scheme's group this entry restates; absent for a group the edit adds."),
    ...collectionGroupBody,
    position: Ordinal.optional().describe("Where the group stands among the scheme's; when absent, a restated group keeps its own and an added one goes after the last."),
  })
  .refine(oneWayToFindStopsGiven, oneWayToFindStops)
export type CollectionGroupEntry = z.infer<typeof CollectionGroupEntry>

export const CollectionGroupPatch = collectionGroupBodies.patch
export type CollectionGroupPatch = z.infer<typeof CollectionGroupPatch>

const weekRotationWithFortnightly = { message: WEEK_ROTATION_WITH_FORTNIGHTLY, path: ["weekRotation"] }
const dailyServesEveryDayIssue = { message: DAILY_SERVES_EVERY_DAY, path: ["serviceDays"] }

/** What a create body naming two groups alike is told, at the list. */
const eachGroupNameOnce = { message: EACH_GROUP_NAME_ONCE, path: ["collectionGroups"] }

/** No two groups of a body share a name; a half-seen list is not judged. */
const groupNamesOnce = (body: { collectionGroups?: unknown }): boolean =>
  !Array.isArray(body.collectionGroups) || eachOnce(body.collectionGroups, (group: { name?: unknown }) => group?.name)

/** A day of every calendar year, `mm-dd`: the database's check reads the same pattern. */
export const MonthDay = z.string().regex(new RegExp(MONTH_DAY_SOURCE), MONTH_DAY_SHAPE)

/**
 * One season: a stretch of every year with its own cadence. The resource's
 * entry and the body's are the same, since the set is replaced whole and an
 * entry has no identity of its own beyond its name.
 */
export const SchemeSeason = z
  .strictObject({
    /** Unique within the scheme: "Summer". */
    name: Label,
    /** The season's first day every year. */
    startsOn: MonthDay,
    /** The first day out of the season every year; before `startsOn` for a season over the new year. */
    endsOn: MonthDay,
    frequency: SeasonFrequency,
    /** Which ISO-week parity an every-2-weeks season serves; null for every other cadence. */
    weekRotation: WeekRotation.nullable(),
  })
  .refine(weekRotationShape, weekRotationWithFortnightly)
  .refine((season) => season.startsOn !== season.endsOn, { message: SEASON_PART_OF_YEAR, path: ["endsOn"] })
export type SchemeSeason = z.infer<typeof SchemeSeason>

/** No two seasons share a name or a day; the later of an overlapping pair is the one refused. */
const seasonsApart = (seasons: readonly SchemeSeason[], ctx: z.RefinementCtx) => {
  if (!eachOnce(seasons, (season) => season.name)) ctx.addIssue({ code: "custom", message: EACH_SEASON_NAME_ONCE })
  const pair = overlappingSeasons(seasons)
  if (pair !== undefined) ctx.addIssue({ code: "custom", message: SEASONS_KEEP_APART, path: [pair[1]] })
}

/** A scheme's seasons, whole. */
export const SchemeSeasons = z.array(SchemeSeason).max(SEASONS_MAX, AT_MOST_SEASONS).superRefine(seasonsApart)

const dailyHasNoSeasonsIssue = { message: DAILY_HAS_NO_SEASONS, path: ["seasons"] }

/** What one rule group matched as of a run's first day: the rule it matched under, compared whole, and the containers, sorted. */
export const GenerationMatchStamp = z.object({
  ruleSignature: z.string(),
  containerIds: z.array(Id),
})
export type GenerationMatchStamp = z.infer<typeof GenerationMatchStamp>

/** A rule group's two latest distinct stamps; a group no run has stamped is not listed. */
export const SchemeGroupGeneration = z.object({
  groupId: Id,
  latest: GenerationMatchStamp,
  /** The stamp before the latest; null for a group stamped once. */
  previous: GenerationMatchStamp.nullable(),
})
export type SchemeGroupGeneration = z.infer<typeof SchemeGroupGeneration>

/** What the scheme's generation runs left, read from them on every read. */
export const SchemeGeneration = z.object({
  /** When the scheme's latest succeeded run finished; null for a scheme no run has generated. */
  lastGeneratedAt: IsoDateTime.nullable(),
  /** The rule groups' stamps, in group order. */
  groups: z.array(SchemeGroupGeneration),
})
export type SchemeGeneration = z.infer<typeof SchemeGeneration>

/** What a patch naming one of the scheme's groups in two entries is told, at the list. */
const eachGroupOnce = { message: EACH_GROUP_ONCE, path: ["collectionGroups"] }

/** No two entries of a patch name one group; an entry without an id is a new group, and a half-seen list is not judged. */
const groupIdsOnce = (body: { collectionGroups?: unknown }): boolean =>
  !Array.isArray(body.collectionGroups) ||
  eachOnce(
    body.collectionGroups.filter((group: { id?: unknown }) => group?.id !== undefined),
    (group: { id?: unknown }) => group.id,
  )

/** Every group's days lie within the service days, refused at that group's days; zod 4 runs a check on a body whose fields failed, and a patch carrying one half leaves the pair to the route, so a half-seen pair is not judged. */
const groupsWithinServiceDays = (body: { serviceDays?: unknown; collectionGroups?: unknown }, ctx: z.RefinementCtx) => {
  const { serviceDays, collectionGroups } = body
  if (!Array.isArray(serviceDays) || !Array.isArray(collectionGroups)) return
  collectionGroups.forEach((group: { days?: unknown }, n) => {
    if (Array.isArray(group?.days) && !withinServiceDays(serviceDays, group.days)) {
      ctx.addIssue({ code: "custom", message: OUTSIDE_SERVICE_DAYS, path: ["collectionGroups", n, "days"] })
    }
  })
}

/** How many days from tomorrow the nightly job keeps a scheme planned (O21 of #290): a whole number in 1..28. */
export const PlanAheadDays = PositiveInt.max(PLAN_AHEAD_DAYS_MAX, PLAN_AHEAD_DAYS_BOUND)

export const RouteScheme = effectiveDated(
  z.object({
    ...stamped,
    projectId: Id,
    /** Unique among the schemes of the project in force at one time, which the database holds. */
    name: Label,
    /** Null while a draft has none; a validated scheme with a rule group needs one (the route's rule). */
    planningAreaId: Id.nullable(),
    serviceType: ServiceType,
    frequency: RecurrenceFrequency,
    /** The weekdays the scheme serves, one or more, each once. */
    serviceDays: ServiceDays.min(1),
    /** Which ISO-week parity an every-2-weeks scheme serves; null for every other cadence. */
    weekRotation: WeekRotation.nullable(),
    /** A time on the project's clock; carried, not used in the date math. */
    plannedStartTime: IsoTime.nullable(),
    holidayPolicy: HolidayPolicy,
    /** How a later edit of the running scheme applies (#38): ask each time, apply to future collections, or this collection only. */
    editPolicy: SchemeEditPolicy,
    /** Whether the nightly job keeps the coming days planned. */
    planAhead: z.boolean(),
    /** How many days from tomorrow it keeps planned (O21 of #290). */
    planAheadDays: PlanAheadDays,
    status: RouteSchemeStatus,
    /** When the office archived the scheme (O21 of #290), null while it plans: an archived scheme is never planned or edited again, and nothing it made is erased. */
    archivedAt: IsoDateTime.nullable(),
    /** Where the routes depart from, a depot of the project; null while unsaid. */
    depotId: Id.nullable(),
    /** Where the routes empty, a station of the company; null while unsaid. */
    unloadingStationId: Id.nullable(),
    /** The seasons, by the day they start (O17 of #290); empty for a scheme at one cadence all year. */
    seasons: z.array(SchemeSeason),
    /** By position. */
    collectionGroups: z.array(CollectionGroup),
    /** A reading of the runs, never written: see the header. */
    generation: SchemeGeneration,
    /**
     * Non-blocking caveats, read on every read and never written (O22 of #290):
     * the containers the scheme collects whose promised service frequency its
     * cadence under- or over-serves. A write that leaves one still succeeds.
     */
    warnings: z.array(z.string()),
  }),
).refine(weekRotationShape, weekRotationWithFortnightly)
export type RouteScheme = z.infer<typeof RouteScheme>

/**
 * A create names a depot of the project and an unloading station of the
 * company (Issue #101), and at least one group: a scheme without explicit
 * groups has one implicit group, which the server writes as a row; at most
 * `GROUPS_MAX`.
 *
 * A patch takes everything but the project; a null depot or station clears
 * it, and a null end reopens the period. The two recurrence rules are held
 * here where the patch carries both halves; the route holds them against the
 * stored row otherwise, and holds every group's days within new service
 * days. `collectionGroups` (#205) is the scheme's groups whole, so an edit
 * that moves the scheme and its groups together is one request: an entry
 * with an id restates that group, one without adds a group, and a group the
 * list leaves out is parked, since there is no delete; absent, the groups
 * stay as they are. Its bounds are the create's, each group once by name and
 * by id. The seasons (O17 of #290) are replaced whole, `[]` clearing them and
 * absent leaving them as they are.
 */
const routeSchemeBodies = effectiveDatedBodies(
  {
    projectId: Id,
    name: Label,
    planningAreaId: Id.nullable().optional(),
    serviceType: ServiceType,
    frequency: RecurrenceFrequency,
    serviceDays: ServiceDays.min(1),
    weekRotation: WeekRotation.nullable().optional(),
    plannedStartTime: IsoTime.nullable().optional(),
    holidayPolicy: HolidayPolicy.default("skip").describe("Defaults to skip when absent: a collection on a holiday is dropped."),
    editPolicy: SchemeEditPolicy.default("ask").describe("Defaults to ask when absent: an edit of the running scheme asks whether it applies to every future collection or to the next one only."),
    planAhead: z.boolean().default(true).describe("Defaults to true when absent: the nightly job keeps the coming days planned."),
    planAheadDays: PlanAheadDays.default(PLAN_AHEAD_DAYS_DEFAULT).describe(`Defaults to ${PLAN_AHEAD_DAYS_DEFAULT} when absent: the nightly job plans tomorrow through a week ahead.`),
    status: RouteSchemeStatus.default("draft").describe("Defaults to draft when absent: a draft accepts partial configuration, a validated scheme is held to the structural rules."),
    depotId: Id.nullable().optional(),
    unloadingStationId: Id.nullable().optional(),
    collectionGroups: z.array(CollectionGroupCreate).min(1).max(GROUPS_MAX, AT_MOST_GROUPS),
    seasons: SchemeSeasons.default([]).describe("Defaults to none when absent: the scheme runs at its own cadence all year."),
  },
  { keys: ["projectId"], patch: { collectionGroups: z.array(CollectionGroupEntry).min(1).max(GROUPS_MAX, AT_MOST_GROUPS_RESTATED).optional() } },
)

export const RouteSchemeCreate = routeSchemeBodies.create
  .refine((body) => weekRotationShape({ ...body, weekRotation: body.weekRotation ?? null }), weekRotationWithFortnightly)
  .refine(dailyServesEveryDay, dailyServesEveryDayIssue)
  .refine(dailyHasNoSeasons, dailyHasNoSeasonsIssue)
  .refine(groupNamesOnce, eachGroupNameOnce)
  .superRefine(groupsWithinServiceDays)
export type RouteSchemeCreate = z.infer<typeof RouteSchemeCreate>

export const RouteSchemePatch = routeSchemeBodies.patch
  .refine(weekRotationShape, weekRotationWithFortnightly)
  .refine(dailyServesEveryDay, dailyServesEveryDayIssue)
  .refine(dailyHasNoSeasons, dailyHasNoSeasonsIssue)
  .refine(groupNamesOnce, eachGroupNameOnce)
  .refine(groupIdsOnce, eachGroupOnce)
  .superRefine(groupsWithinServiceDays)
export type RouteSchemePatch = z.infer<typeof RouteSchemePatch>

/** A page of schemes: one project's, one planning area's, by status, by whether the nightly job plans them, in force on a day. */
export const RouteSchemeListQuery = ProjectScopedListQuery.extend({
  planningAreaId: Id.optional(),
  status: RouteSchemeStatus.optional(),
  /** A query string spells a boolean as `true` or `false`, exactly. */
  planAhead: QueryFlag.optional(),
  /** The day the period is read against; absent asks for every scheme, whenever it ran. */
  validOn: IsoDate.optional(),
  /** `true` the archived schemes alone, `false` the ones still planning; absent both. */
  archived: QueryFlag.optional(),
})
export type RouteSchemeListQuery = z.infer<typeof RouteSchemeListQuery>

/**
 * `POST /route-schemes/:id/archive` (O21 of #290): the scheme's delete,
 * which erases nothing. `effectiveFrom` is the first day the scheme no
 * longer runs, tomorrow on the project's clock when absent and never sooner.
 */
export const RouteSchemeArchive = z.strictObject({
  effectiveFrom: IsoDate.optional(),
})
export type RouteSchemeArchive = z.infer<typeof RouteSchemeArchive>

/** `POST /route-schemes/:id/successor` (O21 of #290): the next version of the scheme's name, from `validFrom`, the day the scheme gives way to it. */
export const RouteSchemeSuccessorCreate = z.strictObject({
  validFrom: IsoDate,
})
export type RouteSchemeSuccessorCreate = z.infer<typeof RouteSchemeSuccessorCreate>

/** What ending a scheme from a day did to its routes: the planned ones cancelled, those trimmed for an office stop they carry, and the dispatched or running ones left for the office. */
export const SchemeEndingCounts = z.object({
  cancelled: NonNegativeInt,
  trimmed: NonNegativeInt,
  /** `ready` or `active` routes on or after the day, which stay; cancel one by hand where it must not run. */
  kept: NonNegativeInt,
})
export type SchemeEndingCounts = z.infer<typeof SchemeEndingCounts>

/** The archive's answer: the scheme as it now stands, and what became of its routes. */
export const RouteSchemeArchived = z.object({
  scheme: RouteScheme,
  routes: SchemeEndingCounts,
})
export type RouteSchemeArchived = z.infer<typeof RouteSchemeArchived>

/** The successor's answer: the scheme it took over from, ended on the day, the new version, what became of the predecessor's routes from that day, and the run queued to plan the new version. */
export const RouteSchemeSuccession = z.object({
  predecessor: RouteScheme,
  successor: RouteScheme,
  routes: SchemeEndingCounts,
  /** The generation run queued for a validated successor over its Plan Ahead window from its first day, read at `/generation-runs/{id}`; null for a draft, or where no worker has made the queue yet, when the office generates it itself. */
  generationRunId: Id.nullable(),
})
export type RouteSchemeSuccession = z.infer<typeof RouteSchemeSuccession>

/** The window of `GET /route-schemes/:id/occurrences`: both ends inclusive, `to` on or after `from`, at most a year — the window a generation run walks too (generation.ts). */
export const OccurrenceQuery = requiredDayWindow(z.object({}), { maxDays: { days: OCCURRENCE_WINDOW_MAX_DAYS, tooLong: WINDOW_AT_MOST_A_YEAR } })
export type OccurrenceQuery = z.infer<typeof OccurrenceQuery>

/** What a recurrence date became under the holiday policy: the domain's `OccurrenceStatus`, a reading and never stored, read from its tuple like every other Planning enum. */
export const OccurrenceStatus = z.enum(OCCURRENCE_STATUSES)
export type OccurrenceStatus = z.infer<typeof OccurrenceStatus>

/** One row of the preview: the domain's `Occurrence` as `generateOccurrences` answers it. */
export const Occurrence = z.object({
  /** Running collection number; null for a skipped row. */
  n: z.int().positive().nullable(),
  /** The day the collection happens, after any shift. */
  date: IsoDate,
  /** The recurrence day the row stems from; differs from `date` when shifted. */
  plannedDate: IsoDate,
  /** The ISO week of `date`. */
  week: z.int().min(1).max(ISO_WEEKS_MAX),
  status: OccurrenceStatus,
  /** The holiday's name on a shifted, skipped or holiday row. */
  note: z.string().optional(),
  /** The season the recurrence day fell in, by name (O17 of #290); absent outside every season. */
  season: z.string().optional(),
})
export type Occurrence = z.infer<typeof Occurrence>
