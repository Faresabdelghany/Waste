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
 * A whole number above zero: an order among siblings, a count, a payload, a
 * volume, a distance. Every named positive integer of these modules
 * (`Ordinal`, `Quantity`, `Metres`, `Amount`, …) is this shape under the name
 * its field reads best by; the name adds nothing else.
 */
export const PositiveInt = z.int().positive()

/**
 * A whole number of zero or more: a count of what a run did, of a route's
 * pickups, of a settlement's lines — where none yet is a count of zero and
 * not a missing one. `PositiveInt`'s sibling, spelled once for the same
 * reason; a module names it by what its field counts.
 */
export const NonNegativeInt = z.int().min(0)

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
