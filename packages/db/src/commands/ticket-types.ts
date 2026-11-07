// The Ticket Types' statements both processes run (#545 of #544): the
// default types a company starts with, the type a ticket opened by kind alone
// is given, and a type with the rules a ticket of it is held to — its fields
// and the roles each status command is theirs alone.
//
// A company is given a default type per kind by the migration that made the
// types, by its provisioning and by the seed, under the domain's names
// (`defaultTicketTypeRows`). A kind that has none — one a later migration
// adds, or a tenant a test mints by hand — is given it as its first ticket
// opens (`defaultTicketTypeOf`), so every opener reaches a type: the office's
// create naming a kind, the worker's consumer, a work order, a weighbridge
// deviation. Two transactions making the same default meet the partial unique
// index (`ticket_type_default_kind_key`) and the second reads the first's.
import { DEFAULT_TICKET_TYPE_NAMES, type CommandPermission, type TicketFieldDefinition } from "@waste/domain/resolution/ticket-types"
import { TICKET_KINDS, type TicketCommand, type TicketKind, type TicketTypeStatus } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq } from "drizzle-orm"

import type { Tx } from "../client"
import type { IdMinter } from "../ids"
import { ticketType, ticketTypeField, ticketTypePermission } from "../schema/resolution"

/** The default types a company starts with, one per kind, in the kinds' order. */
export function defaultTicketTypeRows(companyId: string, newId: IdMinter): (typeof ticketType.$inferInsert)[] {
  return TICKET_KINDS.map((kind) => ({ id: newId(), companyId, kind, name: DEFAULT_TICKET_TYPE_NAMES[kind], isDefault: true }))
}

async function findDefault(tx: Tx, companyId: string, kind: TicketKind): Promise<string | undefined> {
  const [row] = await tx
    .select({ id: ticketType.id })
    .from(ticketType)
    .where(and(eq(ticketType.companyId, companyId), eq(ticketType.kind, kind), eq(ticketType.isDefault, true)))
    .limit(1)
  return row?.id
}

/** The id of the kind's default type, made under the domain's name where the company has none. */
export async function defaultTicketTypeOf(tx: Tx, companyId: string, kind: TicketKind, newId: IdMinter): Promise<string> {
  const found = await findDefault(tx, companyId, kind)
  if (found !== undefined) return found
  await tx.insert(ticketType).values({ id: newId(), companyId, kind, name: DEFAULT_TICKET_TYPE_NAMES[kind], isDefault: true }).onConflictDoNothing()
  const made = await findDefault(tx, companyId, kind)
  // A conflict on the name rather than the default: a type of another kind took the name first.
  if (made === undefined) throw new Error(`ticket type: company ${companyId} has no default type for ${kind}, and its name ${JSON.stringify(DEFAULT_TICKET_TYPE_NAMES[kind])} is taken`)
  return made
}

/** A type as a ticket of it is held to it: its name, kind and status, its fields in order, and the roles it names per command. */
export type TicketTypeRules = {
  id: string
  name: string
  kind: TicketKind
  status: TicketTypeStatus
  fields: TicketFieldDefinition[]
  permissions: CommandPermission[]
}

/** The type with its rules; undefined for no type of the company by that id. */
export async function ticketTypeRules(tx: Tx, companyId: string, id: string): Promise<TicketTypeRules | undefined> {
  const [row] = await tx
    .select({ id: ticketType.id, name: ticketType.name, kind: ticketType.kind, status: ticketType.status })
    .from(ticketType)
    .where(and(eq(ticketType.companyId, companyId), eq(ticketType.id, id)))
    .limit(1)
  if (row === undefined) return undefined
  const fields = await tx
    .select({ key: ticketTypeField.key, label: ticketTypeField.label, input: ticketTypeField.input, choices: ticketTypeField.choices, requirement: ticketTypeField.requirement })
    .from(ticketTypeField)
    .where(and(eq(ticketTypeField.companyId, companyId), eq(ticketTypeField.ticketTypeId, id)))
    .orderBy(asc(ticketTypeField.position))
  const grants = await tx
    .select({ command: ticketTypePermission.command, roleId: ticketTypePermission.roleId })
    .from(ticketTypePermission)
    .where(and(eq(ticketTypePermission.companyId, companyId), eq(ticketTypePermission.ticketTypeId, id)))
  const byCommand = new Map<TicketCommand, string[]>()
  for (const grant of grants) byCommand.set(grant.command, [...(byCommand.get(grant.command) ?? []), grant.roleId])
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    fields: fields.map((field) => ({ ...field, input: field.input, requirement: field.requirement })),
    permissions: [...byCommand.entries()].map(([command, roleIds]) => ({ command, roleIds })),
  }
}
