// Planning's closed lists at the API boundary (Issue #97): each of
// @waste/domain/planning/vocabulary's tuples turned into the `z.enum` the
// routes validate against, so an unknown token never reaches a `CHECK` that
// would refuse it as a 500 naming nothing. Shared here because three modules
// read them — `organisation.ts` for a project's weekend, `route-schemes.ts` for
// nearly everything, `planning-areas.ts` for a purpose — and a list spelled in
// one place is a list that cannot drift between them. The vehicle a rule asks
// for is not an enum since Resources (Issue #101): a vehicle type is a row of
// the company's (`vehicle-types.ts`), and a Stop Matching Rule names it by id.
//
// `ServiceDays` is the one shape of a set of weekdays: a project's weekend, a
// scheme's service days, a group's days are each a list of `ServiceDay` with
// no day named twice. It may be empty here — a project that never rests, a
// group that no longer runs — and the scheme, which has to serve some day,
// adds `.min(1)` where it uses it. The set travels as an array and not as
// seven booleans because the database stores a `text[]` held to the seven by
// the same tuple (`subsetOf` in packages/db), and an array with a day twice
// would store a day twice.
import {
  HOLIDAY_POLICIES,
  PLANNING_AREA_PURPOSES,
  RECURRENCE_FREQUENCIES,
  ROUTE_SCHEME_STATUSES,
  SCHEME_EDIT_POLICIES,
  SERVICE_DAYS,
  SERVICE_TYPES,
  STOP_SOURCES,
  WEEK_ROTATIONS,
} from "@waste/domain/planning/vocabulary"
import * as z from "zod"

/** One of the seven weekdays. */
export const ServiceDay = z.enum(SERVICE_DAYS)
export type ServiceDay = z.infer<typeof ServiceDay>

/** How often a Route Scheme recurs. */
export const RecurrenceFrequency = z.enum(RECURRENCE_FREQUENCIES)
export type RecurrenceFrequency = z.infer<typeof RecurrenceFrequency>

/** Which ISO-week parity an every-2-weeks scheme serves. */
export const WeekRotation = z.enum(WEEK_ROTATIONS)
export type WeekRotation = z.infer<typeof WeekRotation>

/** What a scheme does with a collection that falls on a holiday. */
export const HolidayPolicy = z.enum(HOLIDAY_POLICIES)
export type HolidayPolicy = z.infer<typeof HolidayPolicy>

/** How a later edit of a scheme with generated routes applies; stored, consumed by nothing yet (#38). */
export const SchemeEditPolicy = z.enum(SCHEME_EDIT_POLICIES)
export type SchemeEditPolicy = z.infer<typeof SchemeEditPolicy>

/** What kind of work a Route Scheme plans. */
export const ServiceType = z.enum(SERVICE_TYPES)
export type ServiceType = z.infer<typeof ServiceType>

/** How a Collection Group finds its stops: by rule, or by containers picked by hand. */
export const StopSource = z.enum(STOP_SOURCES)
export type StopSource = z.infer<typeof StopSource>

/** The stored half of a scheme's lifecycle; scheduled, effective and expired are readings, never sent. */
export const RouteSchemeStatus = z.enum(ROUTE_SCHEME_STATUSES)
export type RouteSchemeStatus = z.infer<typeof RouteSchemeStatus>

/** Why a Planning Area exists. */
export const PlanningAreaPurpose = z.enum(PLANNING_AREA_PURPOSES)
export type PlanningAreaPurpose = z.infer<typeof PlanningAreaPurpose>

/**
 * Each entry of a set names its thing once, as the database's key insists:
 * the one rule behind every distinct-entries refine of Planning's modules (a
 * set of days, a rule's fractions, a group's containers, a calendar's
 * holidays by day). `key` says what identifies an entry; the entry itself by
 * default.
 */
export const eachOnce = <Entry>(entries: readonly Entry[], key: (entry: Entry) => unknown = (entry) => entry): boolean =>
  new Set(entries.map(key)).size === entries.length

/** What a set of days with a day in it twice is told. */
export const EACH_DAY_ONCE = "Name each day once: a set of days holds each day at most once"

/** A set of weekdays, each named at most once; may be empty. A scheme's service days add `.min(1)`, a project's weekend `.max(6)`. */
export const ServiceDays = z.array(ServiceDay).refine((days) => eachOnce(days), { message: EACH_DAY_ONCE })
export type ServiceDays = z.infer<typeof ServiceDays>
