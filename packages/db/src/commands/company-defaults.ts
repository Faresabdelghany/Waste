// The rows every company starts with, built once (C33 of #291, #545 of #544):
// the twelve system roles and their grants, from the domain's charters
// (@waste/domain/access/system-roles), which the API never writes and only
// refuses a change to; the eight Decommission Reasons
// (@waste/domain/resources/decommission-reasons), which the office then
// renames and retires; and a default Ticket Type per kind
// (@waste/domain/resolution/ticket-types), which the office then renames and
// adds its own types beside. A provisioned company is given them all at once
// (`companyDefaultRows`, commands/provision-company.ts); the seed writes each
// set on its own fixed ids through the same builders; and a kind a company
// has no default type of is given one as its first ticket opens
// (`defaultTicketTypeOf`, commands/ticket-types.ts), the same row.
import { normaliseGrants } from "@waste/domain/access/grants"
import { SYSTEM_ROLES, type SystemRoleKey } from "@waste/domain/access/system-roles"
import { DEFAULT_TICKET_TYPE_NAMES } from "@waste/domain/resolution/ticket-types"
import { TICKET_KINDS, type TicketKind } from "@waste/domain/resolution/vocabulary"
import { DEFAULT_DECOMMISSION_REASONS } from "@waste/domain/resources/decommission-reasons"

import type { IdMinter } from "../ids"
import { role, roleGrant } from "../schema/access"
import { ticketType } from "../schema/resolution"
import { decommissionReason } from "../schema/stock"

/** The twelve system roles of a company, each under the id `idOf` gives its key. */
export function systemRoleRows(companyId: string, idOf: (key: SystemRoleKey) => string): (typeof role.$inferInsert)[] {
  return SYSTEM_ROLES.map((systemRole) => ({
    id: idOf(systemRole.key),
    companyId,
    key: systemRole.key,
    name: systemRole.name,
    scope: systemRole.scope,
    description: systemRole.description,
    system: systemRole.system,
  }))
}

// One row per action a charter allows. `normaliseGrants` is the rule the API
// applies to a grant set it stores (@waste/domain/access/grants); the charters
// already satisfy it, so it changes nothing today and keeps the rows right if
// a charter is ever spelled loosely.
/** The system roles' grants, one row per action, each role under the id `idOf` gives its key. */
export function systemGrantRows(companyId: string, idOf: (key: SystemRoleKey) => string): (typeof roleGrant.$inferInsert)[] {
  return SYSTEM_ROLES.flatMap((systemRole) =>
    normaliseGrants(systemRole.grants).flatMap((grant) =>
      grant.actions.map((action) => ({
        companyId,
        roleId: idOf(systemRole.key),
        moduleKey: grant.moduleKey,
        action,
      })),
    ),
  )
}

/** The Decommission Reasons a company starts with, active, each under the next id `nextId` gives. */
export function defaultDecommissionReasonRows(companyId: string, nextId: () => string): (typeof decommissionReason.$inferInsert)[] {
  return DEFAULT_DECOMMISSION_REASONS.map(({ code, name }) => ({ id: nextId(), companyId, code, name, status: "active" }))
}

/** The default type of one kind, under the domain's name. */
export function defaultTicketTypeRow(companyId: string, kind: TicketKind, id: string): typeof ticketType.$inferInsert {
  return { id, companyId, kind, name: DEFAULT_TICKET_TYPE_NAMES[kind], isDefault: true }
}

/** The default types a company starts with, one per kind, in the kinds' order. */
export function defaultTicketTypeRows(companyId: string, newId: IdMinter): (typeof ticketType.$inferInsert)[] {
  return TICKET_KINDS.map((kind) => defaultTicketTypeRow(companyId, kind, newId()))
}

/** Where a company's starting rows take their ids: a role's by its key, the others in turn. */
export type CompanyDefaultIds = { role: (key: SystemRoleKey) => string; next: IdMinter }

/** Every row a company starts with, set by set, in the order they are written: the roles before their grants. */
export function companyDefaultRows(companyId: string, ids: CompanyDefaultIds) {
  return {
    roles: systemRoleRows(companyId, ids.role),
    grants: systemGrantRows(companyId, ids.role),
    decommissionReasons: defaultDecommissionReasonRows(companyId, ids.next),
    ticketTypes: defaultTicketTypeRows(companyId, ids.next),
  }
}
