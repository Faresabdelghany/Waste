// How a record names a row of another module, and how that name goes back
// to the wire (Issue #181): through the store's resolver where the module is
// loaded — the row held to its kind, as places.ts' `depotServerIdOf` holds a
// depot, so a fraction picked where a depot belongs is refused — and as an id
// chip (`<prefix>-<uuid>`, the shape `webIdOf` gives a row nothing loaded
// carries) where it is not, so a reference a record shows before its module
// loads still travels back to the API as its id and an unchanged reference is
// never refused. The server-to-web direction is places.ts' `referenced`.
import type { BusinessRecord } from "@/lib/data/business-modules"

import { typed, type LocalRefusal, type MappingContext } from "./adapter"
import { referenced, refusal } from "./places"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The web id a server id stands for: the loaded row's, else its id chip. */
export const webIdVia = (context: MappingContext, prefix: string, serverId: string): string => referenced(context, prefix, serverId).webId

/** What a reference reads as: the loaded row's name, else its id chip. */
export function nameVia(context: MappingContext, prefix: string, serverId: string): string {
  const row = referenced(context, prefix, serverId)
  return row.name ?? row.webId
}

export type ReferenceRule = {
  /** Whether a loaded row is of the kind the field names; absent takes any row the store holds. */
  owns?: (record: BusinessRecord) => boolean
  /** Whether the field takes a bare id as typed (a subscription's, until its module is switched). */
  bare?: boolean
}

/**
 * The server id a web id names: the loaded row's when it is of the field's
 * kind, the id an id chip carries, or — where the field takes one — a bare
 * id as typed; undefined for anything else, a fixture's id among them, since
 * the API holds no row of it.
 */
export function referencedServerId(webId: string, prefix: string, context: MappingContext, { owns, bare = false }: ReferenceRule = {}): string | undefined {
  const loaded = context.resolve.serverIdOf(webId)
  if (loaded !== undefined) {
    if (owns === undefined) return loaded
    const named = context.resolve.byServerId(loaded)
    return named !== undefined && owns(named) ? loaded : undefined
  }
  const chip = webId.startsWith(`${prefix}-`) ? webId.slice(prefix.length + 1) : undefined
  if (chip !== undefined && UUID.test(chip)) return chip.toLowerCase()
  return bare && UUID.test(webId) ? webId.toLowerCase() : undefined
}

/** A reference a record's form names under `key`, as a server id: undefined when blank, a refusal in `refused`'s words when the API holds no such row of the kind. */
export function typedReference(record: BusinessRecord, key: string, prefix: string, context: MappingContext, refused: string, rule?: ReferenceRule): string | undefined | LocalRefusal {
  const webId = typed(record, key)
  if (webId === undefined) return undefined
  return referencedServerId(webId, prefix, context, rule) ?? refusal(key, refused)
}
