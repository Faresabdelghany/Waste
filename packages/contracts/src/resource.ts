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
import { changesSomething, INT4_MAX, INT4_MIN, SOMETHING_TO_CHANGE } from "@waste/domain/requests"
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

/** What a refused empty patch says (@waste/domain/requests, `changesSomething`). */
export const somethingToChange = { message: SOMETHING_TO_CHANGE }

/**
 * A field as a patch takes it: optional, and without the default a create
 * fills an absent field with, since an absent field in a patch keeps what is
 * stored — nor the description the create gives it, which says what its
 * absence means there.
 */
export type PatchField<Field extends z.core.SomeType> = Field extends z.ZodOptional<infer Inner> | z.ZodDefault<infer Inner> ? z.ZodOptional<Inner> : z.ZodOptional<Field>

type PatchShape<Fields extends z.core.$ZodShape, Key extends keyof Fields, Patch extends z.core.$ZodShape> = {
  [Name in Exclude<keyof Fields, Key> | keyof Patch]: Name extends keyof Patch ? Patch[Name] : Name extends keyof Fields ? PatchField<Fields[Name]> : never
}

/** The field without the description a create gave it: a copy made from its definition has no parent, which is where zod's registry would find the description. */
const undescribed = (field: z.ZodType): z.ZodType => (z.globalRegistry.get(field)?.description === undefined ? field : field.clone(field.def))

const patchField = (field: z.ZodType): z.ZodType => undescribed(field instanceof z.ZodOptional || field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : field).optional()

/**
 * A rule over some of an object's fields, added after its others. The rule
 * reads only the fields it names, which a generic object's output cannot show
 * the type checker, so the object is refined as a plain one and handed back
 * as what it is.
 */
export function holding<Schema extends z.ZodObject, Value>(schema: Schema, holds: (value: Value) => boolean, params: { message: string; path?: string[] }): Schema {
  return (schema as unknown as z.ZodObject).refine((value) => holds(value as Value), params) as unknown as Schema
}

/**
 * A resource's two write bodies from the one list of fields a create takes:
 * the create strict, and the patch every field of it optional — a default
 * dropped, since a patch that leaves a field out keeps it — and at least one
 * given. `keys` are set once, by the create: a project, a code, the parent
 * the record hangs from. `patch` is what the patch takes otherwise: a field
 * it spells differently (a null that clears what a create leaves out) in the
 * create's place, and a field only a patch takes after the rest.
 */
export function resourceBodies<Fields extends z.core.$ZodShape, Key extends keyof Fields & string = never, Patch extends z.core.$ZodShape = Record<never, never>>(
  fields: Fields,
  options: { keys?: readonly Key[]; patch?: Patch } = {},
) {
  const keys: ReadonlySet<string> = new Set(options.keys)
  const patch: z.core.$ZodShape = options.patch ?? {}
  const patchShape: Record<string, z.core.SomeType> = {}
  for (const [name, field] of Object.entries(fields)) if (!keys.has(name)) patchShape[name] = patch[name] ?? patchField(field as z.ZodType)
  for (const [name, field] of Object.entries(patch)) if (!(name in patchShape)) patchShape[name] = field
  return {
    create: z.strictObject(fields),
    patch: z.strictObject(patchShape as PatchShape<Fields, Key, Patch>).refine(changesSomething, somethingToChange),
  }
}

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
