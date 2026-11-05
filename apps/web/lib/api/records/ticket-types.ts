// Ticket Types on the prototype's records (#545 of #544): the company's own
// types of case, as records of `configure.templates` beside the teams, the
// API keeping both under that grant. The wire shapes are the contracts'
// (`@waste/contracts/ticket-types`), imported as types; the routes are
// apps/api/src/routes/ticket-types.ts.
//
// A type is `ticket-type-<uuid>`, named by its name, `Active` or `Inactive` —
// retired is an edit, as a team's is — of a kind it never leaves. It carries
// its custom fields and its permissions as the wire's lists in JSON
// (`TICKET_TYPE_FIELDS_KEY`, `TICKET_TYPE_PERMISSIONS_KEY`), each role by its
// web id among Users & roles. A create writes the type alone; an edit patches
// its own fields, then replaces the fields and the permissions each through
// its own route where it changed, the type first.
import type { TicketType, TicketTypeCreate, TicketTypeField, TicketTypePatch, TicketTypePermission } from "@waste/contracts/ticket-types"
import { TICKET_KINDS, type TicketKind } from "@waste/domain/resolution/vocabulary"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { TICKET_TYPE_FIELDS_KEY, TICKET_TYPE_PERMISSIONS_KEY, TICKET_TYPE_PREFIX, typeFieldsOf, typePermissionsOf } from "@/lib/data/ticket-types"

import { create, listAll, patch, put } from "../client"
import { inheritedPresentation, ofKind, stampFacts, statusLabel, statusToken, typed, webIdOf, type LocalRefusal, type MappingContext, type ResourceAdapter } from "./adapter"
import { roleAdapter } from "./organisation"
import { referencedServerId, webIdVia } from "./references"

/** Whether a loaded row is a ticket type: its id, or — a row made this session — its kind. */
export const isTicketTypeRecord = ofKind(TICKET_TYPE_PREFIX, ["Ticket type"])

const refusal = (path: string, message: string): LocalRefusal => ({ path, message })

export function toTicketTypeRecord(type: TicketType, context: MappingContext): BusinessRecord {
  const permissions = type.permissions.map((entry) => ({ command: entry.command, roleIds: entry.roleIds.map((id) => webIdVia(context, "role", id)) }))
  return {
    id: webIdOf(TICKET_TYPE_PREFIX, type.id),
    name: type.name,
    context: type.isDefault ? `${statusLabel(type.kind)} · default` : statusLabel(type.kind),
    status: statusLabel(type.status),
    ...inheritedPresentation(undefined),
    ...stampFacts(type, context.now),
    description: type.description ?? "A type of case the company keeps.",
    facts: {
      Kind: statusLabel(type.kind),
      Fields: type.fields.length === 0 ? "None" : type.fields.map((field) => field.label).join(", "),
      Default: type.isDefault ? "Yes" : "No",
      Status: statusLabel(type.status),
    },
    companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
    projectIds: [],
    recordKind: "Ticket type",
    submittedValues: {
      name: type.name,
      kind: type.kind,
      description: type.description ?? "",
      status: statusLabel(type.status),
      isDefault: type.isDefault,
      [TICKET_TYPE_FIELDS_KEY]: JSON.stringify(type.fields),
      [TICKET_TYPE_PERMISSIONS_KEY]: JSON.stringify(permissions),
    },
  }
}

/** The type's own fields as the record says them: the name, the description, the status in the wire's word and whether it is its kind's default. */
function typeFieldsOfRecord(record: BusinessRecord): { name: string; description: string | null; status: "active" | "inactive"; isDefault: boolean } | LocalRefusal {
  const name = typed(record, "name") ?? record.name.trim()
  if (name === "") return refusal("name", "Name the ticket type")
  const status = statusToken(typed(record, "status") ?? "Active")
  if (status !== "active" && status !== "inactive") return refusal("status", "A ticket type is active or inactive")
  const description = typed(record, "description")
  return { name, description: description === undefined || description.trim() === "" ? null : description, status, isDefault: record.submittedValues?.isDefault === true }
}

/** The permissions as server ids, each a role the API holds; a refusal for one it does not. */
function permissionServerIds(record: BusinessRecord, context: MappingContext): TicketTypePermission[] | LocalRefusal {
  const permissions: TicketTypePermission[] = []
  for (const entry of typePermissionsOf(record)) {
    const roleIds: string[] = []
    for (const webId of entry.roleIds) {
      const serverId = referencedServerId(webId, "role", context, { owns: roleAdapter.owns })
      if (serverId === undefined) return refusal("permissions", "Pick roles the API holds")
      roleIds.push(serverId)
    }
    if (roleIds.length > 0) permissions.push({ command: entry.command, roleIds })
  }
  return permissions
}

/** An edit's three halves: the type's own fields, the whole list of fields, the whole set of permissions — each where the edit changed it. */
type TypeWrite = { type?: TicketTypePatch; fields?: TicketTypeField[]; permissions?: TicketTypePermission[] }

export const ticketTypeAdapter: ResourceAdapter<TicketType> = {
  prefix: TICKET_TYPE_PREFIX,
  auditTable: "ticket_type",
  owns: isTicketTypeRecord,
  // The status is a field of the pane's edit: retiring a type is an edit.
  statuses: undefined,
  list: (client) => listAll<TicketType>(client, "/ticket-types"),
  toRecord: toTicketTypeRecord,
  toCreateBody: (record) => {
    const fields = typeFieldsOfRecord(record)
    if ("path" in fields) return fields
    const kind = typed(record, "kind")
    if (kind === undefined || !(TICKET_KINDS as readonly string[]).includes(kind)) return refusal("kind", "Pick the kind the type belongs to")
    const body: TicketTypeCreate = { name: fields.name, kind: kind as TicketKind, description: fields.description, status: fields.status, isDefault: fields.isDefault }
    return body
  },
  toPatchBody: (before, after, context) => {
    const was = typeFieldsOfRecord(before)
    const is = typeFieldsOfRecord(after)
    if ("path" in is) return is
    const type: TicketTypePatch = {}
    if ("path" in was || was.name !== is.name) type.name = is.name
    if ("path" in was || was.description !== is.description) type.description = is.description
    if ("path" in was || was.status !== is.status) type.status = is.status
    // The default moves and never disappears: only making it one is said.
    if (is.isDefault && ("path" in was || !was.isDefault)) type.isDefault = true
    const fields = typeFieldsOf(after)
    const fieldsMoved = JSON.stringify(typeFieldsOf(before)) !== JSON.stringify(fields)
    const permissionsMoved = JSON.stringify(typePermissionsOf(before)) !== JSON.stringify(typePermissionsOf(after))
    const permissions = permissionsMoved ? permissionServerIds(after, context) : undefined
    if (permissions !== undefined && "path" in permissions) return permissions
    if (Object.keys(type).length === 0 && !fieldsMoved && !permissionsMoved) return null
    const write: TypeWrite = { ...(Object.keys(type).length === 0 ? {} : { type }), ...(fieldsMoved ? { fields } : {}), ...(permissions === undefined ? {} : { permissions }) }
    return write
  },
  create: (client, body) => create<TicketType>(client, "/ticket-types", body).then((created) => created.body),
  // The type first, then each whole set through its own route; the answer is the type as it now stands.
  update: async (client, serverId, body) => {
    const write = body as TypeWrite
    let type: TicketType | undefined
    if (write.type !== undefined) type = await patch<TicketType>(client, `/ticket-types/${serverId}`, write.type)
    if (write.fields !== undefined) type = await put<TicketType>(client, `/ticket-types/${serverId}/fields`, { fields: write.fields })
    if (write.permissions !== undefined) type = await put<TicketType>(client, `/ticket-types/${serverId}/permissions`, { permissions: write.permissions })
    if (type === undefined) throw new Error(`ticketTypeAdapter.update: nothing to write for ${serverId}`)
    return type
  },
}
