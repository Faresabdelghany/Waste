// Ticket Types (#545 of #544): the company's own types of case, each inside
// one kind. `GET /ticket-types` lists them, `POST /ticket-types` adds one,
// `GET`/`PATCH /ticket-types/:id` read and change one, `PUT
// /ticket-types/:id/fields` replaces its custom fields, `PUT
// /ticket-types/:id/permissions` the roles that may give each status
// command and `PUT /ticket-types/:id/actions` its automation (#546). No delete: a type the tickets it holds still name is retired by
// its status, which offers it to no new ticket and keeps the ones it holds.
//
// A type is the company's and no project's, like the Team, so every
// statement carries `company_id = the caller's` beside the fence (ADR-0001).
// Its kind never changes, since its tickets carry it. Each kind has one
// default type, the type of a ticket opened by kind alone: a create or a
// patch making a type its kind's default unmakes the one that was, the two
// writes to one kind's default taking turns under a transaction-scoped
// advisory lock, and the default is never retired (409) nor unmade but by
// making another (the contracts refuse `isDefault: false`).
//
// The fields, the permissions and the actions are sets that travel with the type: replaced
// whole, the type's own row stamped first, each replacement minting new ids,
// as a pre-trip checklist's items are. A field left out is gone from the type
// and its values stay on the tickets that hold them; each role a permission
// names is one of the company's (400 at `permissions.N.roleIds.M`).
//
// The grant is `configure.templates`, the prototype's Tickets &
// communication, where the teams and the SLA are. A type is read under
// `operate.tickets` too, since the people working tickets pick a type and
// fill in its fields.
import { Page } from "@waste/contracts/pagination"
import { DEFAULT_TYPE_OFFERED, TicketType, TicketTypeActionsSet, TicketTypeCreate, TicketTypeFieldsSet, TicketTypeListQuery, TicketTypePatch, TicketTypePermissionsSet, type TicketTypeAction, type TicketTypeActionBody, type TicketTypeField, type TicketTypePermission } from "@waste/contracts/ticket-types"
import type { Tx } from "@waste/db/client"
import { role, userAccount } from "@waste/db/schema/access"
import { vehicle } from "@waste/db/schema/fleet"
import { team, ticketType, ticketTypeAction, ticketTypeField, ticketTypePermission } from "@waste/db/schema/resolution"
import { notPlannable, plannedService } from "@waste/domain/resolution/automation"
import { TICKET_COMMANDS, type TicketCommand } from "@waste/domain/resolution/transitions"
import { TICKET_ACTION_TRIGGERS, type TicketActionCommand, type TicketActionKind, type TicketActionTrigger, type TicketFieldInput, type TicketFieldRequirement, type TicketKind, type TicketMessageRecipient, type TicketPriority, type TicketResolution, type TicketTypeStatus } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { allows, requireGrant, requireGrantOf } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { NOT_A_TEAM, NOT_A_USER_ACCOUNT } from "./references"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseDuplicate, stamp, stampsOf, strengthFor } from "./shared"
import { NOT_A_TICKET_TYPE } from "./ticket-type-rules"

const MODULE = "configure.templates"
const TICKETS = "operate.tickets"

/** A read's module: the tickets' for the people working them, the templates' for the office that keeps the types. */
const readModuleOf = (principal: Principal) => (allows(principal.grants, TICKETS, "view") ? TICKETS : MODULE)

const TicketTypePage = Page(TicketType)

const columns = { id: ticketType.id, name: ticketType.name, kind: ticketType.kind, description: ticketType.description, status: ticketType.status, isDefault: ticketType.isDefault, createdAt: ticketType.createdAt, updatedAt: ticketType.updatedAt }
type Row = Pick<typeof ticketType.$inferSelect, keyof typeof columns>

/** `unique (company_id, name)`: a name is one type's inside a company. */
const NAME_TAKEN = "ticket_type_name_key"
const nameTaken = (name: string) => `This company already has a ticket type called ${JSON.stringify(name)}`

/** What making a retired type its kind's default is told. */
export const retiredDefault = (name: string) => `The ticket type ${JSON.stringify(name)} is retired; make it active to make it its kind's default`

/** What a permission naming a role of another company, or none, is told. */
export const NOT_A_ROLE = "Not a role of this company"

const noSuchType = (id: string) => problem(404, { detail: `No ticket type ${id} in this company` })

const scope = (principal: Principal) => eq(ticketType.companyId, principal.companyId)

async function findType(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(ticketType)
    .where(and(scope(principal), eq(ticketType.id, id)))
    .limit(1)
  return row
}

/** The types on the wire, each with its fields in order, its permissions in the commands' order and its actions by trigger and place: three reads for the whole page. */
async function typesOf(tx: Tx, companyId: string, rows: readonly Row[]): Promise<TicketType[]> {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const fields = await tx
    .select({ ticketTypeId: ticketTypeField.ticketTypeId, key: ticketTypeField.key, label: ticketTypeField.label, helpText: ticketTypeField.helpText, input: ticketTypeField.input, choices: ticketTypeField.choices, requirement: ticketTypeField.requirement })
    .from(ticketTypeField)
    .where(and(eq(ticketTypeField.companyId, companyId), inArray(ticketTypeField.ticketTypeId, ids)))
    .orderBy(asc(ticketTypeField.ticketTypeId), asc(ticketTypeField.position))
  const grants = await tx
    .select({ ticketTypeId: ticketTypePermission.ticketTypeId, command: ticketTypePermission.command, roleId: ticketTypePermission.roleId })
    .from(ticketTypePermission)
    .where(and(eq(ticketTypePermission.companyId, companyId), inArray(ticketTypePermission.ticketTypeId, ids)))
    .orderBy(asc(ticketTypePermission.id))
  const actions = await tx
    .select({ ticketTypeId: ticketTypeAction.ticketTypeId, trigger: ticketTypeAction.trigger, kind: ticketTypeAction.kind, teamId: ticketTypeAction.teamId, userAccountId: ticketTypeAction.userAccountId, priority: ticketTypeAction.priority, command: ticketTypeAction.command, resolution: ticketTypeAction.resolution, messageTemplateName: ticketTypeAction.messageTemplateName, recipient: ticketTypeAction.recipient, followUpTypeId: ticketTypeAction.followUpTypeId, vehicleId: ticketTypeAction.vehicleId, daysAhead: ticketTypeAction.daysAhead })
    .from(ticketTypeAction)
    .where(and(eq(ticketTypeAction.companyId, companyId), inArray(ticketTypeAction.ticketTypeId, ids)))
    .orderBy(asc(ticketTypeAction.ticketTypeId), asc(ticketTypeAction.position))
  const triggerOrder = (trigger: string) => TICKET_ACTION_TRIGGERS.indexOf(trigger as TicketActionTrigger)
  return rows.map((row) => {
    const own: TicketTypeField[] = fields
      .filter((field) => field.ticketTypeId === row.id)
      .map(({ ticketTypeId: _type, ...field }) => ({ ...field, input: field.input as TicketFieldInput, requirement: field.requirement as TicketFieldRequirement }))
    const permissions: TicketTypePermission[] = TICKET_COMMANDS.flatMap((command) => {
      const roleIds = grants.filter((grant) => grant.ticketTypeId === row.id && grant.command === command).map((grant) => grant.roleId)
      return roleIds.length === 0 ? [] : [{ command, roleIds }]
    })
    const automation: TicketTypeAction[] = actions
      .filter((action) => action.ticketTypeId === row.id)
      // A stable sort: each trigger's actions keep their places.
      .sort((one, other) => triggerOrder(one.trigger) - triggerOrder(other.trigger))
      .map(({ ticketTypeId: _type, ...action }) => ({
        ...action,
        trigger: action.trigger as TicketActionTrigger,
        kind: action.kind as TicketActionKind,
        priority: action.priority as TicketPriority | null,
        command: action.command as TicketActionCommand | null,
        resolution: action.resolution as TicketResolution | null,
        recipient: action.recipient as TicketMessageRecipient | null,
      }))
    return { id: row.id, name: row.name, kind: row.kind as TicketKind, description: row.description, status: row.status as TicketTypeStatus, isDefault: row.isDefault, fields: own, permissions, actions: automation, ...stampsOf(row) }
  })
}

const typeOf = async (tx: Tx, companyId: string, row: Row): Promise<TicketType> => (await typesOf(tx, companyId, [row]))[0]

/** Makes the kind's default this type alone: the default that was is unmade first, under the kind's lock, so the index holding one default per kind never meets two. */
async function unmakeDefaults(tx: Tx, companyId: string, kind: string, except?: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ticket-type-default:${companyId}:${kind}`}, 0))`)
  await tx
    .update(ticketType)
    .set({ isDefault: false })
    .where(and(eq(ticketType.companyId, companyId), eq(ticketType.kind, kind), eq(ticketType.isDefault, true), except === undefined ? undefined : ne(ticketType.id, except)))
}

/** Which of the ids a set names are the company's: one read for the whole set. */
async function heldIds(tx: Tx, table: typeof team | typeof userAccount | typeof ticketType, companyId: string, ids: readonly string[], also?: SQL): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const found = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.companyId, companyId), inArray(table.id, [...ids]), also))
  return new Set(found.map((one) => one.id))
}

/** What a plan in a route naming no vehicle of a project the caller works in is told. */
export const NOT_A_COMPANY_VEHICLE = "Not a vehicle of a project you work in"

/**
 * The projects of the vehicles a set names, by vehicle: a vehicle is a
 * project's, which the action keeps beside it for the key. A vehicle of a
 * project the caller works in, or one the type's actions name already — a
 * reference made stands, so a set restated whole is not refused for it.
 */
async function vehicleProjects(tx: Tx, principal: Principal, typeId: string, actions: readonly TicketTypeActionBody[]): Promise<Map<string, string>> {
  const named = [...new Set(actions.flatMap((action) => (action.vehicleId === null ? [] : [action.vehicleId])))]
  if (named.length === 0) return new Map()
  const kept = tx
    .select({ vehicleId: ticketTypeAction.vehicleId })
    .from(ticketTypeAction)
    .where(and(eq(ticketTypeAction.companyId, principal.companyId), eq(ticketTypeAction.ticketTypeId, typeId), isNotNull(ticketTypeAction.vehicleId)))
  const found = await tx
    .select({ id: vehicle.id, projectId: vehicle.projectId })
    .from(vehicle)
    .where(and(eq(vehicle.companyId, principal.companyId), inArray(vehicle.id, named), or(inProjects(vehicle.projectId, principal), inArray(vehicle.id, kept))))
  return new Map(found.map((one) => [one.id, one.projectId]))
}

/** A set's team, person, follow-up type and vehicle each the company's, the person not deactivated, and a plan in a route only of a kind a planned stop answers: every one that is not, at its action. */
async function referenceIssues(tx: Tx, companyId: string, kind: TicketKind, actions: readonly TicketTypeActionBody[], vehicles: ReadonlyMap<string, string>): Promise<{ path: string; message: string }[]> {
  const named = (key: "teamId" | "userAccountId" | "followUpTypeId") => [...new Set(actions.flatMap((action) => (action[key] === null ? [] : [action[key]])))]
  const teams = await heldIds(tx, team, companyId, named("teamId"))
  const people = await heldIds(tx, userAccount, companyId, named("userAccountId"), isNull(userAccount.deactivatedAt))
  const types = await heldIds(tx, ticketType, companyId, named("followUpTypeId"))
  return actions.flatMap((action, index) => [
    ...(action.teamId === null || teams.has(action.teamId) ? [] : [{ path: `actions.${index}.teamId`, message: NOT_A_TEAM }]),
    ...(action.userAccountId === null || people.has(action.userAccountId) ? [] : [{ path: `actions.${index}.userAccountId`, message: NOT_A_USER_ACCOUNT }]),
    ...(action.followUpTypeId === null || types.has(action.followUpTypeId) ? [] : [{ path: `actions.${index}.followUpTypeId`, message: NOT_A_TICKET_TYPE }]),
    ...(action.vehicleId === null || vehicles.has(action.vehicleId) ? [] : [{ path: `actions.${index}.vehicleId`, message: NOT_A_COMPANY_VEHICLE }]),
    ...(action.kind !== "plan-in-route" || plannedService(kind) !== undefined ? [] : [{ path: `actions.${index}.kind`, message: notPlannable(kind) }]),
  ])
}

const commonProblems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(
    action === "view" ? `No active account here, or the caller's role allows \`view\` on neither \`${TICKETS}\` nor \`${MODULE}\`.` : `No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`,
  ),
})

export function ticketTypeRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/ticket-types",
      describeRoute({
        operationId: "listTicketTypes",
        summary: "The company's ticket types",
        description:
          "One page of the company's ticket types, oldest first (ids are time-ordered), each with its custom fields in order and the roles it names per status command. `status` narrows the page to the active or the retired, `kind` to one kind's types. Every company starts with a default type per kind, the type of a ticket opened by kind alone. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of ticket types.", TicketTypePage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, or a filter is not one of its list."),
          ...commonProblems("view"),
        },
      }),
      guard,
      requireGrantOf(readModuleOf, "view"),
      validate("query", TicketTypeListQuery),
      async (c) => {
        const { limit, cursor, status, kind } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        const rows = await tx
          .select(columns)
          .from(ticketType)
          .where(and(scope(principal), status === undefined ? undefined : eq(ticketType.status, status), kind === undefined ? undefined : eq(ticketType.kind, kind), after === undefined ? undefined : gt(ticketType.id, after)))
          .orderBy(asc(ticketType.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: await typesOf(tx, principal.companyId, items), nextCursor })
      },
    )
    .post(
      "/ticket-types",
      describeRoute({
        operationId: "createTicketType",
        summary: "Add a ticket type",
        description:
          "Adds a type of case of one kind to the company. `name` is unique inside the company; `status` is `active` unless said; `isDefault: true` makes it its kind's default in place of the one that was, which stays a type of the kind, and a default is active (400 at `status`). Its fields and permissions start empty, each set through its own route. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The type as it was written.", TicketType),
          400: describeProblem("The body is missing a field, names a member the server owns, names a kind the vocabulary does not hold, or makes a retired type the default."),
          ...commonProblems("create"),
          409: describeProblem("The company already has a type with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", TicketTypeCreate),
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (values.isDefault) await unmakeDefaults(tx, principal.companyId, values.kind)
        const [row] = await refuseDuplicate({ [NAME_TAKEN]: nameTaken(values.name) }, () =>
          tx
            .insert(ticketType)
            .values({ ...values, id: newId(), companyId: principal.companyId })
            .returning(columns),
        )
        return created(c, "/ticket-types", await typeOf(tx, principal.companyId, row))
      },
    )
    .get(
      "/ticket-types/:id",
      describeRoute({
        operationId: "getTicketType",
        summary: "One ticket type",
        description: "One type of the caller's company, with its fields and permissions. Another company's type is a type that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The type, with its fields and permissions.", TicketType),
          400: describeProblem("The path does not hold an id."),
          ...commonProblems("view"),
          404: describeProblem("No ticket type with that id in this company."),
        },
      }),
      guard,
      requireGrantOf(readModuleOf, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findType(tx, principal, id)
        if (row === undefined) throw noSuchType(id)
        return c.json(await typeOf(tx, principal.companyId, row))
      },
    )
    .patch(
      "/ticket-types/:id",
      describeRoute({
        operationId: "patchTicketType",
        summary: "Rename, describe, retire or make a ticket type its kind's default",
        description:
          "Changes the name, the description or the status, or makes the type its kind's default with `isDefault: true`, unmaking the one that was. `inactive` retires the type, so no new ticket and no patch moving a ticket names it, while every ticket it holds keeps it; a kind's default is never retired (409, `" +
          DEFAULT_TYPE_OFFERED +
          "`), so another type is made the default first. The kind never changes, since the type's tickets carry it; the fields and the permissions are sets with their own routes. Under the type's row lock.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The type as it now stands.", TicketType),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own — the kind, the fields and the permissions included — unmakes the default, or makes it the default while retiring it."),
          ...commonProblems("edit"),
          404: describeProblem("No ticket type with that id in this company."),
          409: describeProblem("The company already has another type with that name, or the patch retires the kind's default, or makes a retired type the default."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TicketTypePatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockRow(tx, ticketType, { companyId: principal.companyId, id }, strengthFor(ticketType, patch))
        const current = await findType(tx, principal, id)
        if (current === undefined) throw noSuchType(id)
        const status = patch.status ?? current.status
        const isDefault = patch.isDefault ?? current.isDefault
        // A default is offered: the database's `ticket_type_default_shape`, as the sentence a person reads — retiring the default, or making a retired type one.
        if (isDefault && status !== "active") throw problem(409, { detail: current.isDefault ? DEFAULT_TYPE_OFFERED : retiredDefault(current.name) })
        if (patch.isDefault === true && !current.isDefault) await unmakeDefaults(tx, principal.companyId, current.kind, current.id)
        const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
        const [row] = await refuseDuplicate(sentences, () =>
          tx
            .update(ticketType)
            .set(patch)
            .where(and(scope(principal), eq(ticketType.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchType(id)
        return c.json(await typeOf(tx, principal.companyId, row))
      },
    )
    .put(
      "/ticket-types/:id/fields",
      describeRoute({
        operationId: "putTicketTypeFields",
        summary: "Replace a ticket type's custom fields",
        description:
          "Replaces the type's whole list of custom fields, in order, with the one in the body. A field is a key — lowercase words joined by hyphens, which a ticket's values are held by — a label, an optional help text, an input (`text`, `paragraph`, `number`, `date`, `yes-no` or `choice`), the choices a `choice` field offers and no other does, and when it must be filled in: `optional`, `to-open` or `to-complete`. Each key is named once (400 at `fields.N.key`). A field left out is gone from the type: the tickets that hold a value of it keep the value, which is read and no longer judged. The type's `updatedAt` moves, since the list is part of the type on the wire.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The type with the fields it now has.", TicketType),
          400: describeProblem("The path does not hold an id, or the body is missing `fields`, names a member it does not own, names a key twice or of the wrong shape, or gives choices to a field that is not a choice or none to one that is — at the field at fault."),
          ...commonProblems("edit"),
          404: describeProblem("No ticket type with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TicketTypeFieldsSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { fields } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const [row] = await tx
          .update(ticketType)
          .set(stamp())
          .where(and(scope(principal), eq(ticketType.id, id)))
          .returning(columns)
        if (row === undefined) throw noSuchType(id)
        await tx.delete(ticketTypeField).where(and(eq(ticketTypeField.companyId, principal.companyId), eq(ticketTypeField.ticketTypeId, id)))
        if (fields.length > 0) {
          await tx.insert(ticketTypeField).values(fields.map((field, index) => ({ ...field, id: newId(), companyId: principal.companyId, ticketTypeId: id, position: index + 1 })))
        }
        return c.json(await typeOf(tx, principal.companyId, row))
      },
    )
    .put(
      "/ticket-types/:id/permissions",
      describeRoute({
        operationId: "putTicketTypePermissions",
        summary: "Replace who may give a ticket type's status commands",
        description:
          "Replaces the whole set with the one in the body: per status command — `start`, `wait`, `hold`, `complete`, `reject`, `reopen` — the roles that may give it on a ticket of the type. A command left out, or naming no role, is anyone's who works tickets, as every command is without one; a command naming roles is theirs alone, and another role's caller is refused (403, naming them). Each command is named once (400 on `permissions`), each role once in it (400 at `permissions.N.roleIds`), and each a role of this company (400 at `permissions.N.roleIds.M`). The rule binds a person's command in the office; a stop that services its ticket, and the system's own work, are not held to it. The type's `updatedAt` moves.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The type with the permissions it now has.", TicketType),
          400: describeProblem("The path does not hold an id, or the body is missing `permissions`, names a member it does not own, names a command twice or one the type has no status for, names a role twice in a command, or names one that is not this company's."),
          ...commonProblems("edit"),
          404: describeProblem("No ticket type with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TicketTypePermissionsSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { permissions } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const [row] = await tx
          .update(ticketType)
          .set(stamp())
          .where(and(scope(principal), eq(ticketType.id, id)))
          .returning(columns)
        if (row === undefined) throw noSuchType(id)
        const named = [...new Set(permissions.flatMap((entry) => entry.roleIds))]
        const held = new Set(
          named.length === 0
            ? []
            : (
                await tx
                  .select({ id: role.id })
                  .from(role)
                  .where(and(eq(role.companyId, principal.companyId), inArray(role.id, named)))
              ).map((found) => found.id),
        )
        const issues = permissions.flatMap((entry, index) => entry.roleIds.flatMap((roleId, at) => (held.has(roleId) ? [] : [{ path: `permissions.${index}.roleIds.${at}`, message: NOT_A_ROLE }])))
        if (issues.length > 0) throw invalidRequest("body", issues)
        await tx.delete(ticketTypePermission).where(and(eq(ticketTypePermission.companyId, principal.companyId), eq(ticketTypePermission.ticketTypeId, id)))
        const rows = permissions.flatMap((entry) => entry.roleIds.map((roleId) => ({ id: newId(), companyId: principal.companyId, ticketTypeId: id, command: entry.command as TicketCommand, roleId })))
        if (rows.length > 0) await tx.insert(ticketTypePermission).values(rows)
        return c.json(await typeOf(tx, principal.companyId, row))
      },
    )
    .put(
      "/ticket-types/:id/actions",
      describeRoute({
        operationId: "putTicketTypeActions",
        summary: "Replace a ticket type's automation",
        description:
          "Replaces the type's whole automation with the one in the body (#546 of #544): actions, each on a trigger — `opened`, or reaching `in-progress`, `pending`, `on-hold`, `completed` or `rejected` — and run in the order the body names them among its trigger's. An action assigns a team (`teamId`) or a person (`userAccountId`), sets the priority (`priority`), moves the status (`command`, one of `start`, `wait`, `hold`, `complete` with its `resolution`, `reject`), sends a message from the ticket's project's template of `messageTemplateName` to `recipient` — the ticket's customer or the party of a role at its property — opens a follow-up ticket of type `followUpTypeId`, or plans the ticket in a route (#546, part 2): the stop its kind is answered by that names nothing but its container — an overflow's emptying, a defect's repair, on a type of such a kind alone (400 at `actions.N.kind`) — on the next route of vehicle `vehicleId` that has not started, `daysAhead` days after the project's today as the action runs at the earliest, booked to the ticket as `POST /routes/{id}/pickups` books one; each names what its kind needs and nothing else (400 at the member at fault), and a move to the status its trigger is is refused (400 at `actions.N.command`). A team, a person and a follow-up's type are this company's (400 at theirs), the person not deactivated, and a vehicle is one of a project the caller works in, or one the type's actions name already (400 at its field). The actions run in the transaction of the change that fires them, as the system and held to neither the type's roles nor its required fields; one that cannot run — a team since retired, a person who does not work in the ticket's project, no active template of the name in its project, no one to write to, no route of the vehicle to plan in, a stop the office booked already — leaves a line saying why in the ticket's history and the rest run. A move fires its own status's actions and a follow-up its type's opening actions, a chain running five levels deep at most. The type's `updatedAt` moves.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The type with the automation it now has.", TicketType),
          400: describeProblem("The path does not hold an id, or the body is missing `actions`, names more than the type holds or a member it does not own, gives an action a parameter its kind does not take or leaves out one it needs, moves a ticket to the status its trigger is, names a team, a person, a ticket type or a vehicle that is not this company's, or plans in a route a type of a kind no stop naming its container answers — at the action at fault."),
          ...commonProblems("edit"),
          404: describeProblem("No ticket type with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", TicketTypeActionsSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { actions } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const [row] = await tx
          .update(ticketType)
          .set(stamp())
          .where(and(scope(principal), eq(ticketType.id, id)))
          .returning(columns)
        if (row === undefined) throw noSuchType(id)
        const vehicles = await vehicleProjects(tx, principal, id, actions)
        const issues = await referenceIssues(tx, principal.companyId, row.kind as TicketKind, actions, vehicles)
        if (issues.length > 0) throw invalidRequest("body", issues)
        await tx.delete(ticketTypeAction).where(and(eq(ticketTypeAction.companyId, principal.companyId), eq(ticketTypeAction.ticketTypeId, id)))
        const placed = new Map<string, number>()
        const rows = actions.map((action) => {
          const position = (placed.get(action.trigger) ?? 0) + 1
          placed.set(action.trigger, position)
          return { ...action, id: newId(), companyId: principal.companyId, ticketTypeId: id, position, vehicleProjectId: action.vehicleId === null ? null : (vehicles.get(action.vehicleId) as string) }
        })
        if (rows.length > 0) await tx.insert(ticketTypeAction).values(rows)
        return c.json(await typeOf(tx, principal.companyId, row))
      },
    )
}
