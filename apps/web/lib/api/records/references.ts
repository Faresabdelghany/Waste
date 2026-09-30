// How a record names a row of another module, and how that name goes back
// to the wire (Issue #181): through the store's resolver where the module is
// loaded, and as an id chip — `<prefix>-<uuid>`, the shape `webIdOf` gives a
// row no fixture names — where it is not yet, so a reference a record shows
// before its module is switched still travels back to the API as its id.
import type { LocalRefusal, MappingContext } from "./adapter"
import { webIdOf } from "./adapter"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether a mapping's answer is a refusal naming a field. */
export const isRefusal = (value: unknown): value is LocalRefusal => typeof value === "object" && value !== null && "path" in value && "message" in value

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

/** Whether text is an id as the API spells one. */
export const isServerId = (value: string): boolean => UUID.test(value)
