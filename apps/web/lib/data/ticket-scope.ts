// What a project's ticket setting is for (#548 of #544): the SLA's targets,
// the default teams and the ticket charges each name a kind or one Ticket
// Type, the type's own winning over its kind's — and a target may name
// neither, for every kind. A pane holds the choice as one picker value: a
// kind's token, every kind's own value, or `type:<server id>`. Its own module,
// so the teams', the SLA's and the charges' data modules share it without
// reaching into the ticket types', which reads the teams'.
import type { TicketType } from "@waste/contracts/ticket-types"
import { kindOrTypeKey } from "@waste/domain/resolution/ticket-types"
import type { TicketKind } from "@waste/domain/resolution/vocabulary"

import { statusLabel } from "../api/records/adapter"

/** A ticket type as the settings by type list it: its server id, its name, its kind, whether it takes new tickets, and whether it is its kind's default, whose setting is its kind's row. */
export type TypeChoice = Pick<TicketType, "id" | "name" | "status"> & { kind: TicketType["kind"] | null; isDefault?: boolean }

/** A setting's scope as the wire names it: a kind, a type, or neither for every kind. */
export type TicketScope = { kind: TicketKind | null; ticketTypeId: string | null }

const TYPE_PREFIX = "type:"

/** A type's picker value. */
export const typeScope = (ticketTypeId: string): string => `${TYPE_PREFIX}${ticketTypeId}`

/** A picker value as the wire's scope: a type's, a kind's, or every kind's where the value is `every`. */
export function scopeOfValue(value: string, every?: string): TicketScope {
  if (value.startsWith(TYPE_PREFIX)) return { kind: null, ticketTypeId: value.slice(TYPE_PREFIX.length) }
  return { kind: value === every ? null : (value as TicketKind), ticketTypeId: null }
}

/** A scope as its picker value, every kind as `every`. */
export const valueOfScope = (scope: TicketScope, every: string): string => (scope.ticketTypeId !== null ? typeScope(scope.ticketTypeId) : (scope.kind ?? every))

/** A scope's row key, the domain's `kindOrTypeKey`. */
export const scopeKey = (scope: TicketScope): string => kindOrTypeKey(scope)

/** How a type reads in a list of settings: its name, and its kind's beside it where the list told it. */
export const typeLabel = (type: Pick<TypeChoice, "name" | "kind">): string => (type.kind === null ? type.name : `${type.name} (${statusLabel(type.kind)})`)

/** What a type a set names reads as where the types do not hold it: still being read (`types` null), or one the role reads no list of — never its id, which tells a person nothing. */
export const unknownTypeName = (types: readonly TypeChoice[] | null): string => (types === null ? "Reading the type…" : "A ticket type not shown to your role")

/** A type a set names that the types do not hold, its kind unknown. */
const unknownType = (id: string, types: readonly TypeChoice[] | null): TypeChoice => ({ id, name: unknownTypeName(types), kind: null, status: "active" })

/** The types a pane lists a row for: the active ones in the order given but each kind's default, whose setting is its kind's row, then any the set names already that are retired, a default or unread, so a setting kept is shown. `types` is null while they are read. */
export function typesListed(types: readonly TypeChoice[] | null, named: Iterable<string>): TypeChoice[] {
  const listed = (types ?? []).filter((type) => type.status === "active" && type.isDefault !== true)
  const shown = new Set(listed.map((type) => type.id))
  for (const id of named) {
    if (shown.has(id)) continue
    shown.add(id)
    listed.push(types?.find((type) => type.id === id) ?? unknownType(id, types))
  }
  return listed
}

/** The label of a type a set names, read from the types where they hold it. */
export function labelOfType(types: readonly TypeChoice[] | null, id: string): string {
  const type = types?.find((candidate) => candidate.id === id)
  return type === undefined ? unknownTypeName(types) : typeLabel(type)
}
