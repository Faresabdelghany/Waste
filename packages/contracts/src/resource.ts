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

/** What a refused empty patch says. */
export const somethingToChange = { message: "Give at least one field to change" }

/** A patch must change something. */
export const changesSomething = (patch: object) => Object.keys(patch).length > 0
