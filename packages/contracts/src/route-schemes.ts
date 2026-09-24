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
// restricted to, none or more; the vehicle it asks for, or none), the manual
// alternative a list of containers in stop order. Both are sets and are
// replaced whole through their own routes; a group's patch moves its name,
// order, days and provider and never its source, its rule or its list. The
// implicit group of a scheme without explicit groups is a row the server
// writes: `RouteSchemeCreate.collectionGroups` has at least one entry, and the
// quick form's one rule becomes that one group. Fractions are the group's and
// plural, as the glossary has them; the adapter writes the scheme's one
// fraction into each group.
//
// Not here: the group's vehicle and driver and the scheme's depot and
// unloading station (Resources, with step 6), a scheme's own service demand
// (a Subscription is the Registry's), and `lastGeneratedAt` and the drift
// stamps (part B adds them to the resource).
import { OCCURRENCE_STATUSES, SERVICE_DAYS } from "@waste/domain/planning/vocabulary"
import * as z from "zod"

import { IsoDate, IsoTime } from "./dates"
import { Id } from "./ids"
import { eachOnce, HolidayPolicy, RecurrenceFrequency, RouteSchemeStatus, SchemeEditPolicy, ServiceDays, ServiceType, StopMatchVehicleType, StopSource, WeekRotation } from "./planning"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, somethingToChange, stamped } from "./resource"
import { Label } from "./text"
import { endsAfterItStarts, Validity, ValidityCreate, validityOrdered } from "./validity"

/**
 * The most a set of this module may carry — a group's containers, a rule's
 * fractions and container types: a form's list, not an import. A group's
 * container list is unbounded on the resource, since a set already stored has
 * to read back however long it grew; a rule's two sets are bounded on the
 * resource too, because the rule is one schema for the row and the body, and
 * two hundred fractions is more than any company's catalogue holds.
 */
export const CONTAINERS_MAX = 200

/** An order among siblings: whole and positive, since the first is number one. */
const Ordinal = z.int().positive()

export const EACH_FRACTION_ONCE = "Name each waste fraction once: a rule matches a fraction or it does not"
export const EACH_CONTAINER_TYPE_ONCE = "Name each container type once: a rule is restricted to a type or it is not"
export const EACH_CONTAINER_ONCE = "Name each container once: a container has one place in the group's stop order"

/** A distinct set of ids, bounded. */
const idSet = (message: string) => z.array(Id).max(CONTAINERS_MAX).refine((ids) => eachOnce(ids), { message })

/**
 * How a rule group finds its stops: the fractions it matches (one or more),
 * the container types it is restricted to (none or more) and the vehicle it
 * asks for, if any. The same shape is the resource's `rule` and the body of
 * `PUT /collection-groups/:id/stop-matching-rule`.
 */
export const StopMatchingRule = z.strictObject({
  wasteFractionIds: idSet(EACH_FRACTION_ONCE).min(1),
  containerTypeIds: idSet(EACH_CONTAINER_TYPE_ONCE),
  vehicleType: StopMatchVehicleType.nullable(),
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
})
export type CollectionGroup = z.infer<typeof CollectionGroup>

/** What a group whose source and stops disagree is told, at the field that says which it is. */
export const ONE_WAY_TO_FIND_STOPS = "A collection group matches by rule or picks containers, never both"
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

/** The scheme is the path's and the project the scheme's, so neither is here; the position is appended when absent. */
export const CollectionGroupCreate = z
  .strictObject({
    name: Label,
    position: Ordinal.optional().describe("Where the group stands among the scheme's; after the last when absent."),
    days: ServiceDays,
    stopSource: StopSource,
    rule: StopMatchingRule.nullable().optional(),
    containerIds: ContainerIds.nullable().optional(),
    serviceProviderId: Id.nullable().optional(),
  })
  .refine(oneWayToFindStopsGiven, oneWayToFindStops)
export type CollectionGroupCreate = z.infer<typeof CollectionGroupCreate>

/** The name, the order, the days and the provider; the source, the rule and the list never move through a patch. */
export const CollectionGroupPatch = z
  .strictObject({
    name: Label.optional(),
    position: Ordinal.optional(),
    days: ServiceDays.optional(),
    serviceProviderId: Id.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type CollectionGroupPatch = z.infer<typeof CollectionGroupPatch>

type Recurrence = { frequency?: string; weekRotation?: string | null; serviceDays?: readonly string[] }

/** What a rotation given with the wrong cadence, or missing with the right one, is told. */
export const WEEK_ROTATION_WITH_FORTNIGHTLY = "Give weekRotation with every-2-weeks and with nothing else"
const weekRotationWithFortnightly = { message: WEEK_ROTATION_WITH_FORTNIGHTLY, path: ["weekRotation"] }

/**
 * The week rotation belongs to the fortnightly cadence and to no other. A
 * half-seen pair is not judged — that is a patch giving one of the two, and
 * only the route, which has the stored row, can hold the two together.
 */
export function weekRotationShape(value: Recurrence): boolean {
  const { frequency, weekRotation } = value
  if (frequency === undefined || weekRotation === undefined) return true
  return (frequency === "every-2-weeks") === (weekRotation !== null)
}

/** What a daily scheme that leaves a weekday out is told. */
export const DAILY_SERVES_EVERY_DAY = "A daily scheme serves every weekday"
const dailyServesEveryDayIssue = { message: DAILY_SERVES_EVERY_DAY, path: ["serviceDays"] }

/** A daily scheme serves all seven days; any other cadence serves the days it names. A half-seen pair is not judged. */
export function dailyServesEveryDay(value: Recurrence): boolean {
  const { frequency, serviceDays } = value
  if (frequency === undefined || serviceDays === undefined) return true
  return frequency !== "daily" || SERVICE_DAYS.every((day) => serviceDays.includes(day))
}

/** What a group whose days the scheme does not serve is told, at that group's days. */
export const OUTSIDE_SERVICE_DAYS = "Outside the scheme's service days"

/** Every day a group runs on is a day the scheme serves. */
export const withinServiceDays = (serviceDays: readonly string[], days: readonly string[]): boolean => days.every((day) => serviceDays.includes(day))

/** What a create body naming two groups alike is told, at the list: the database's key (`collection_group_route_scheme_id_name_key`) would say the same as a 23505. */
export const EACH_GROUP_NAME_ONCE = "A collection group name is used once in a scheme"
const eachGroupNameOnce = { message: EACH_GROUP_NAME_ONCE, path: ["collectionGroups"] }

/** No two groups of a body share a name; a half-seen list is not judged. */
const groupNamesOnce = (body: { collectionGroups?: unknown }): boolean =>
  !Array.isArray(body.collectionGroups) || eachOnce(body.collectionGroups, (group: { name?: unknown }) => group?.name)

const RouteSchemeFields = {
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
  /** Stored so the choice survives; nothing consumes it yet (#38). */
  editPolicy: SchemeEditPolicy,
  /** Whether the nightly job keeps the coming week planned. */
  planAhead: z.boolean(),
  status: RouteSchemeStatus,
  /** By position. */
  collectionGroups: z.array(CollectionGroup),
  ...Validity.shape,
}

export const RouteScheme = z.object(RouteSchemeFields).refine(validityOrdered, endsAfterItStarts).refine(weekRotationShape, weekRotationWithFortnightly)
export type RouteScheme = z.infer<typeof RouteScheme>

export const RouteSchemeCreate = z
  .strictObject({
    projectId: Id,
    name: Label,
    planningAreaId: Id.nullable().optional(),
    serviceType: ServiceType,
    frequency: RecurrenceFrequency,
    serviceDays: ServiceDays.min(1),
    weekRotation: WeekRotation.nullable().optional(),
    plannedStartTime: IsoTime.nullable().optional(),
    holidayPolicy: HolidayPolicy.default("skip").describe("Defaults to skip when absent: a collection on a holiday is dropped."),
    editPolicy: SchemeEditPolicy.default("ask").describe("Defaults to ask when absent; stored, consumed by nothing yet."),
    planAhead: z.boolean().default(true).describe("Defaults to true when absent: the nightly job keeps the coming week planned."),
    status: RouteSchemeStatus.default("draft").describe("Defaults to draft when absent: a draft accepts partial configuration, a validated scheme is held to the structural rules."),
    /** At least one: a scheme without explicit groups has one implicit group, which the server writes as a row. */
    collectionGroups: z.array(CollectionGroupCreate).min(1),
    ...ValidityCreate,
  })
  .refine(validityOrdered, endsAfterItStarts)
  .refine((body) => weekRotationShape({ ...body, weekRotation: body.weekRotation ?? null }), weekRotationWithFortnightly)
  .refine(dailyServesEveryDay, dailyServesEveryDayIssue)
  .refine(groupNamesOnce, eachGroupNameOnce)
  .superRefine((body, ctx) => {
    // zod 4 runs a check on a body whose fields failed, so a half-seen pair is not judged here either.
    if (!Array.isArray(body.serviceDays) || !Array.isArray(body.collectionGroups)) return
    body.collectionGroups.forEach((group, n) => {
      if (Array.isArray(group?.days) && !withinServiceDays(body.serviceDays, group.days)) {
        ctx.addIssue({ code: "custom", message: OUTSIDE_SERVICE_DAYS, path: ["collectionGroups", n, "days"] })
      }
    })
  })
export type RouteSchemeCreate = z.infer<typeof RouteSchemeCreate>

/**
 * Everything but the project, the groups and the stamps. The two recurrence
 * rules are held here where the patch carries both halves; the route holds
 * them against the stored row otherwise, and holds every group's days within
 * new service days.
 */
export const RouteSchemePatch = z
  .strictObject({
    name: Label.optional(),
    planningAreaId: Id.nullable().optional(),
    serviceType: ServiceType.optional(),
    frequency: RecurrenceFrequency.optional(),
    serviceDays: ServiceDays.min(1).optional(),
    weekRotation: WeekRotation.nullable().optional(),
    plannedStartTime: IsoTime.nullable().optional(),
    holidayPolicy: HolidayPolicy.optional(),
    editPolicy: SchemeEditPolicy.optional(),
    planAhead: z.boolean().optional(),
    status: RouteSchemeStatus.optional(),
    validFrom: IsoDate.optional(),
    /** Null reopens the period; a day ends it. */
    validTo: IsoDate.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
  .refine(validityOrdered, endsAfterItStarts)
  .refine(weekRotationShape, weekRotationWithFortnightly)
  .refine(dailyServesEveryDay, dailyServesEveryDayIssue)
export type RouteSchemePatch = z.infer<typeof RouteSchemePatch>

/** A page of schemes: one project's, one planning area's, by status, by whether the nightly job plans them, in force on a day. */
export const RouteSchemeListQuery = ProjectScopedListQuery.extend({
  planningAreaId: Id.optional(),
  status: RouteSchemeStatus.optional(),
  /** A query string spells a boolean as `true` or `false`, exactly. */
  planAhead: z.stringbool({ truthy: ["true"], falsy: ["false"], case: "sensitive" }).optional(),
  /** The day the period is read against; absent asks for every scheme, whenever it ran. */
  validOn: IsoDate.optional(),
})
export type RouteSchemeListQuery = z.infer<typeof RouteSchemeListQuery>

/** The longest window the occurrence read walks: a year, as the generation job's walk cap. */
export const OCCURRENCE_WINDOW_MAX_DAYS = 366

export const WINDOW_ORDERED = "to is the last day of the window, so it comes on or after from"
export const WINDOW_AT_MOST_A_YEAR = `A window spans at most ${OCCURRENCE_WINDOW_MAX_DAYS} days`

const DAY_MS = 86_400_000
/** The days from one calendar day to another; both are `YYYY-MM-DD`, so the UTC midnight of each is exact. */
const daysBetween = (from: string, to: string): number => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS

/**
 * The window of `GET /route-schemes/:id/occurrences`: both ends inclusive,
 * `to` on or after `from`, spanning at most 366 days — so the two days are
 * fewer than 366 apart, since a window of one day is `from` and `to` on the
 * same day and zero apart.
 */
export const OccurrenceQuery = z
  .object({
    from: IsoDate,
    to: IsoDate,
  })
  .refine((window) => window.to >= window.from, { message: WINDOW_ORDERED, path: ["to"] })
  .refine((window) => daysBetween(window.from, window.to) < OCCURRENCE_WINDOW_MAX_DAYS, { message: WINDOW_AT_MOST_A_YEAR, path: ["to"] })
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
  week: z.int().min(1).max(53),
  status: OccurrenceStatus,
  /** The holiday's name on a shifted, skipped or holiday row. */
  note: z.string().optional(),
})
export type Occurrence = z.infer<typeof Occurrence>
