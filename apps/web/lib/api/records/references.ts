// How a record names a row of another module, and how that name goes back
// to the wire (Issue #181): through the store's resolver where the module is
// loaded, and as an id chip — `<prefix>-<uuid>`, the shape `webIdOf` gives a
// row no fixture names — where it is not yet, so a reference a record shows
// before its module is switched still travels back to the API as its id.
import type { BusinessRecord } from "@/lib/data/business-modules"

import type { LocalRefusal, MappingContext } from "./adapter"
import { typed, webIdOf } from "./adapter"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The web id a server id stands for: the loaded row's, else its id chip. */
export const webIdVia = (context: MappingContext, prefix: string, serverId: string): string => context.resolve.byServerId(serverId)?.id ?? webIdOf(prefix, serverId)

/** What a reference reads as: the loaded row's name, else its id chip. */
export const nameVia = (context: MappingContext, prefix: string, serverId: string): string => context.resolve.byServerId(serverId)?.name ?? webIdOf(prefix, serverId)

/**
 * The server id a web id names: the loaded row's, the id an id chip carries,
 * or — where the field takes one (`bare`) — a bare id as typed; undefined
 * for anything else, a fixture's id among them, since the API holds no row
 * of it.
 */
export function referencedServerId(webId: string, prefix: string, context: MappingContext, bare = false): string | undefined {
  const loaded = context.resolve.serverIdOf(webId)
  if (loaded !== undefined) return loaded
  const chip = webId.startsWith(`${prefix}-`) ? webId.slice(prefix.length + 1) : undefined
  if (chip !== undefined && UUID.test(chip)) return chip.toLowerCase()
  return bare && UUID.test(webId) ? webId.toLowerCase() : undefined
}

/** A reference a record's form names under `key`, as a server id: undefined when blank, a refusal in `refused`'s words when the API holds no such row. */
export function typedReference(record: BusinessRecord, key: string, prefix: string, context: MappingContext, refused: string): string | undefined | LocalRefusal {
  const webId = typed(record, key)
  if (webId === undefined) return undefined
  return referencedServerId(webId, prefix, context) ?? { path: key, message: refused }
}
