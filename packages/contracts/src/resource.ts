// What every resource and every write body of this API is made of, spelled
// once. `organisation.ts` and `access.ts` each carried their own copy from
// Issue #70, and the Registry's four modules would have made four more
// (Issue #78): a rule in six places is six chances for one of them to say
// something else.
//
// A resource carries what the server owns — the id it minted and the instants
// the database stamped — and a write body only what a caller may say. Write
// bodies are strict, so a member the server owns is refused by name instead
// of being silently dropped: a client that sends `id` on a create has a bug,
// and answering 201 to it would hide one.
//
// A patch is every field optional and at least one given, for the same
// reason: a change with nothing to change means nothing, and 200 would be a
// lie about it. What a patch leaves out is each resource's own business, but
// two exclusions run through all of them — the stamps, and the `projectId` of
// a project-scoped record, since a record does not move between projects (its
// keys all carry the project, packages/db/src/schema/references.ts).
//
// A ledger row (Issue #101: a Stock Movement, a Vehicle Allocation event)
// spreads `recorded` instead: its id and the instant it was appended. It is
// never updated, so it has no `updatedAt` to carry, and no patch takes it.
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { Id } from "./ids"

/** What the server owns on every resource: spread it first, so a resource reads id, stamps, then its own fields. */
export const stamped = {
  id: Id,
  /** When the row was made. */
  createdAt: IsoDateTime,
  /** When it last changed; the database keeps it, not the caller. */
  updatedAt: IsoDateTime,
}

/** What the server owns on a ledger row: the id it minted and the one instant, when the row was appended. */
export const recorded = {
  id: Id,
  /** When the row was appended; a ledger row is never updated. */
  recordedAt: IsoDateTime,
}

/** What a refused empty patch says. */
export const somethingToChange = { message: "Give at least one field to change" }

/** A patch must change something. */
export const changesSomething = (patch: object) => Object.keys(patch).length > 0

/**
 * The bounds of Postgres's `integer`, the column every whole number a body
 * writes lands in. zod's `int` stops at JavaScript's safe integers, far past
 * them, and a number between the two would reach the database and come back
 * as 22003, a 500; held here, it is the 400 naming its field.
 */
export const INT4_MAX = 2_147_483_647
export const INT4_MIN = -2_147_483_648

/** Whether a number a route computed from a body — a quantity times a price, an indexed fee — still fits an `integer` column. */
export const fitsInt4 = (value: number): boolean => Number.isInteger(value) && value >= INT4_MIN && value <= INT4_MAX

/**
 * A whole number above zero: an order among siblings, a count, a payload, a
 * volume, a distance. Every named positive integer of these modules
 * (`Ordinal`, `Quantity`, `Metres`, `Amount`, …) is this shape under the name
 * its field reads best by; the name adds nothing else. At most `INT4_MAX`,
 * since its column is an `integer`.
 */
export const PositiveInt = z.int().positive().max(INT4_MAX)

/**
 * A whole number of zero or more: a count of what a run did, of a route's
 * pickups, of a settlement's lines — where none yet is a count of zero and
 * not a missing one. `PositiveInt`'s sibling, spelled once for the same
 * reason; a module names it by what its field counts. At most `INT4_MAX`.
 */
export const NonNegativeInt = z.int().min(0).max(INT4_MAX)

/**
 * A sum over many rows that a report answers and nothing writes: summed in
 * `bigint` arithmetic, so it carries no `integer` bound — a city's tonnage
 * over a long window may pass one.
 */
export const NonNegativeTotal = z.int().min(0)

/** A whole number of either sign that a body writes into an `integer` column: basis points, which a deflator makes negative. */
export const Int4 = z.int().min(INT4_MIN).max(INT4_MAX)

/**
 * Money in minor units (Issue #112): a whole number of øre or cents, never a
 * decimal, so nothing is re-rounded downstream. `Minor` takes either sign,
 * since a reversal's and a credit line's amounts are negative;
 * `NonNegativeMinor` is a price, zero being a free service and not a missing
 * one — `NonNegativeInt` under the name a price reads by. The column is
 * `_minor` in the database and an integer there too.
 */
export const Minor = z.int()
export const NonNegativeMinor = NonNegativeInt

/**
 * Each entry of a set names its thing once, as the database's key insists:
 * the one rule behind every distinct-entries refine (a set of days, a rule's
 * fractions, a group's containers, a calendar's holidays by day, a vehicle
 * type's container types, a station's fractions). `key` says what identifies
 * an entry; the entry itself by default.
 */
export const eachOnce = <Entry>(entries: readonly Entry[], key: (entry: Entry) => unknown = (entry) => entry): boolean =>
  new Set(entries.map(key)).size === entries.length

/**
 * What a set with an entry twice is told, one shape for every module: "Name
 * each <subject> once: <reason>". A module spells its subject, and a reason
 * only where the rule has one of its own (a container has one place in a stop
 * order); otherwise the set either holds the thing or it does not.
 */
export const eachOnceSentence = (subject: string, reason = "the set holds it or it does not"): string => `Name each ${subject} once: ${reason}`
