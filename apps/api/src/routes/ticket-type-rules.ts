// The Ticket Type a ticket's write names, and the rules a ticket of it is
// held to (#545 of #544), for `POST /tickets`, `PATCH /tickets/:id` and the
// status commands (routes/tickets.ts).
//
// A create names its type, its kind, or both: a type is one of the company's
// (400 at `ticketTypeId`) whose kind the body's agrees with (400 at `kind`),
// and a kind alone opens the kind's default type, made where the company has
// none (`defaultTicketTypeOf`). A patch moves the ticket to another type, its
// kind following, or to another kind's default type when it names the kind
// alone. A type named afresh is offered (409, `refuseRetiredTicketType`,
// after every 400); the type a ticket already is of is kept whatever its
// status, the rule every status gate keeps.
//
// The values are the type's: a body's value under a key the type has no field
// for, or one its field does not take, is a 400 at `fieldValues.<key>`; a
// patch's null clears a value, whatever its key, since a field taken off the
// type leaves its value to be cleared. A create without a field the type
// requires to open is a 400 at that field. A type moved by a patch keeps the
// values the ticket holds: a key the new type has no field for is read, not
// judged.
//
// A status command is a person's in the office: the type may name the roles
// that may give it, and another role is refused (403, naming them); a
// completion short of a field the type requires to complete — or holding a
// value its field no longer takes — is refused (409, naming them), the
// ticket's own state refusing. Neither binds the system's work — a stop
// servicing its ticket, the stop's record answering a missed collection —
// which never comes through here: a driver's completion is never held back by
// the office's paperwork.
import { ticketTypeRules, defaultTicketTypeOf, type TicketTypeRules } from "@waste/db/commands/ticket-types"
import type { Tx } from "@waste/db/client"
import { role } from "@waste/db/schema/access"
import { ticketType } from "@waste/db/schema/resolution"
import { fieldRequiredToOpen, fieldValuesIssues, mayGive, missingFields, needsBeforeCompleting, onlyRolesMay, typeOfAnotherKind, type TicketFieldValues } from "@waste/domain/resolution/ticket-types"
import type { TicketCommand } from "@waste/domain/resolution/transitions"
import type { TicketKind, TicketTypeStatus } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq, inArray } from "drizzle-orm"
import { newId } from "@waste/db/ids"

import type { Principal } from "../auth/principal"
import { invalidRequest, problem } from "../problem"
import { refuseRetiredTicketType } from "./statuses"

/** What a body naming a type of another company, or none, is told. */
export const NOT_A_TICKET_TYPE = "Not a ticket type of this company"

/** One refusal of a body's field. */
type Issue = { path: string; message: string }

/** The type the body names, with its rules: the company's, or a 400 at `path`. Its status is the caller's 409 to ask, after every 400. */
export async function findNamedType(tx: Tx, companyId: string, id: string, path = "ticketTypeId"): Promise<TicketTypeRules> {
  const found = await ticketTypeRules(tx, companyId, id)
  if (found === undefined) throw invalidRequest("body", [{ path, message: NOT_A_TICKET_TYPE }])
  return found
}

/** The rules of a type the database holds the ticket to: never missing, since the ticket's key names it. */
async function rulesOf(tx: Tx, companyId: string, id: string): Promise<TicketTypeRules> {
  const found = await ticketTypeRules(tx, companyId, id)
  if (found === undefined) throw new Error(`ticket type ${id} of company ${companyId} is gone from under a ticket`)
  return found
}

/** The type named, its kind held to the body's where the body names one too (400 at `kind`). */
async function namedOfKind(tx: Tx, companyId: string, id: string, kind: TicketKind | undefined): Promise<TicketTypeRules> {
  const named = await findNamedType(tx, companyId, id)
  if (kind !== undefined && kind !== named.kind) throw invalidRequest("body", [{ path: "kind", message: typeOfAnotherKind(named.name, named.kind) }])
  return named
}

/** The type a create opens the ticket of, and whether the body named it, which asks its status. */
export async function typeToOpen(tx: Tx, companyId: string, body: { kind?: TicketKind; ticketTypeId?: string }): Promise<{ rules: TicketTypeRules; named: boolean }> {
  if (body.ticketTypeId !== undefined) return { rules: await namedOfKind(tx, companyId, body.ticketTypeId, body.kind), named: true }
  // The contracts hold a create to a type or a kind.
  const kind = body.kind as TicketKind
  return { rules: await rulesOf(tx, companyId, await defaultTicketTypeOf(tx, companyId, kind, newId)), named: false }
}

/** The type a patch leaves the ticket of, and whether it moved to one named afresh, which asks its status. */
export async function typeAfterPatch(tx: Tx, companyId: string, current: { kind: string; ticketTypeId: string }, body: { kind?: TicketKind; ticketTypeId?: string }): Promise<{ rules: TicketTypeRules; named: boolean }> {
  if (body.ticketTypeId !== undefined) {
    const rules = await namedOfKind(tx, companyId, body.ticketTypeId, body.kind)
    return { rules, named: body.ticketTypeId !== current.ticketTypeId }
  }
  if (body.kind !== undefined && body.kind !== current.kind) return { rules: await rulesOf(tx, companyId, await defaultTicketTypeOf(tx, companyId, body.kind, newId)), named: false }
  return { rules: await rulesOf(tx, companyId, current.ticketTypeId), named: false }
}

/** The type named afresh is offered: the 409, after every 400. */
export function refuseRetiredType(type: { rules: TicketTypeRules; named: boolean }): void {
  if (type.named) refuseRetiredTicketType(type.rules.status, type.rules.name)
}

/** A body's values against the type, at `fieldValues.<key>`: each key a field it holds and each value one the field takes, one issue per key in one pass; a null clears a value, whatever its key. The contracts bound how many a body names. */
export function valueIssues(rules: TicketTypeRules, values: Readonly<Record<string, unknown>> | undefined): Issue[] {
  if (values === undefined) return []
  const given = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null))
  return fieldValuesIssues(rules.fields, given, rules.name).map((issue) => ({ path: `fieldValues.${issue.key}`, message: issue.message }))
}

/** The fields the type requires to open that a create leaves empty, each at `fieldValues.<key>`; a value the field does not take is `valueIssues`' to tell. */
export function openingIssues(rules: TicketTypeRules, values: TicketFieldValues): Issue[] {
  return missingFields(rules.fields, values, "open")
    .filter((field) => !Object.hasOwn(values, field.key))
    .map((field) => ({ path: `fieldValues.${field.key}`, message: fieldRequiredToOpen(field.label, rules.name) }))
}

/** A person's status command on a ticket of the type: their role named for it, or none named for it at all; else 403, naming the roles that may. */
export async function requireMayGive(tx: Tx, principal: Principal, rules: TicketTypeRules, command: TicketCommand): Promise<void> {
  if (mayGive(rules.permissions, command, principal.role.id)) return
  const roleIds = rules.permissions.find((entry) => entry.command === command)?.roleIds ?? []
  const named = await tx
    .select({ name: role.name })
    .from(role)
    .where(and(eq(role.companyId, principal.companyId), inArray(role.id, [...roleIds])))
    .orderBy(asc(role.name))
  throw problem(403, { detail: onlyRolesMay(named.map((row) => row.name), command, rules.name) })
}

/** A completion of a ticket short of a field its type requires to open or to complete: 409, naming them. */
export function requireFieldsToComplete(rules: TicketTypeRules, ticket: { label: string; fieldValues: unknown }): void {
  const missing = missingFields(rules.fields, ticket.fieldValues as TicketFieldValues, "complete")
  if (missing.length > 0) throw problem(409, { detail: needsBeforeCompleting(ticket.label, missing) })
}

/** The rules of the type the ticket is of, for a status command. */
export const rulesOfTicket = (tx: Tx, companyId: string, ticket: { ticketTypeId: string }): Promise<TicketTypeRules> => rulesOf(tx, companyId, ticket.ticketTypeId)

/**
 * The ticket types a project's set of a setting names (#548 of #544) — its
 * SLA's targets, its default teams, its ticket charges — each the company's,
 * or a 400 at `<field>.N.ticketTypeId`. Answers the gate the route asks after
 * its other 400s: a type the set did not name before, `kept`, is offered
 * (409), and one it names already stands whatever its status.
 */
export async function requireSetTypes(tx: Tx, companyId: string, entries: readonly { ticketTypeId: string | null }[], field: string, kept: ReadonlySet<string>): Promise<() => void> {
  const named = [...new Set(entries.flatMap((entry) => (entry.ticketTypeId === null ? [] : [entry.ticketTypeId])))]
  if (named.length === 0) return () => undefined
  const found = new Map(
    (
      await tx
        .select({ id: ticketType.id, name: ticketType.name, status: ticketType.status })
        .from(ticketType)
        .where(and(eq(ticketType.companyId, companyId), inArray(ticketType.id, named)))
    ).map((row) => [row.id, row]),
  )
  const issues = entries.flatMap((entry, index) => (entry.ticketTypeId === null || found.has(entry.ticketTypeId) ? [] : [{ path: `${field}.${index}.ticketTypeId`, message: NOT_A_TICKET_TYPE }]))
  if (issues.length > 0) throw invalidRequest("body", issues)
  return () => {
    for (const id of named) {
      const type = found.get(id)
      if (type !== undefined && !kept.has(id)) refuseRetiredTicketType(type.status as TicketTypeStatus, type.name)
    }
  }
}
