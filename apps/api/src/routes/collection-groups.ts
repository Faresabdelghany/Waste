// The Collection Groups of a Route Scheme (Issue #97, ADR-0002): how a scheme
// finds its stops, one group at a time. `GET`/`POST /route-schemes/:id/collection-groups`
// list a scheme's groups and add one, `GET`/`PATCH /collection-groups/:id`
// read and change one, `PUT /collection-groups/:id/stop-matching-rule`
// replaces a rule group's rule and `PUT /collection-groups/:id/containers` a
// manual group's picked list. No delete: a group that no longer runs is
// patched to `days: []`, and the routes it generated stay behind it.
//
// A group finds its stops one way, and `stopSource` says which for the life
// of the group: a rule group has a Stop Matching Rule — the waste fractions
// it matches (one or more), the container types it is restricted to (none or
// more) and the vehicle it asks for — and picks no containers; a manual group
// picks containers in stop order and has no rule. The create body carries one
// or the other (the contracts refuse both or neither), and a patch moves the
// name, the order, the days and the provider and never the source, the rule
// or the list: those are sets and are replaced whole through their own routes,
// so a PUT on the wrong kind of group is a 409 saying which kind it is.
//
// The rule and the list are replaced the way routes/members.ts replaces a
// membership — the record stamped first, then delete-then-insert inside the
// request's transaction, never a diff — but through a sibling here rather
// than `replaceSet`: that descriptor is one table with a role per entry, and
// the rule is three things over two tables and a column, the list a
// positioned one. The mechanics of writing them are routes/scheme-groups.ts's,
// shared with the scheme's create.
//
// Every write here holds two rules across the scheme's groups, so every write
// takes the scheme's row lock first (routes/shared.ts; the scheme's own patch
// takes the same lock) and reads the group underneath it: a group's days lie
// within the scheme's service days (400 at `days`), and no container is
// picked by two groups that run on a shared day (400 at the entry, naming the
// group and the day — or at `days` when it is the days that moved). When the
// scheme is `validated`, the structural rules of
// @waste/domain/planning/checks are re-run over the groups as the write would
// leave them, and every sentence that fails is listed in a 409.
//
// A group is project-scoped like its scheme, so every statement carries the
// tenant and `inProjects` (auth/projects.ts); a group of another company, or
// of a project this account does not work in, is a group that does not exist
// here. The grant is `route-studio.schemes` throughout: a group is a part of
// its scheme and not a surface of its own.
import { Page, PageRequest } from "@waste/contracts/pagination"
import {
  CollectionGroup,
  CollectionGroupContainersSet,
  CollectionGroupCreate,
  CollectionGroupPatch,
  OUTSIDE_SERVICE_DAYS,
  StopMatchingRuleSet,
  withinServiceDays,
} from "@waste/contracts/route-schemes"
import type { Tx } from "@waste/db/client"
import { collectionGroup, routeScheme } from "@waste/db/schema/route-schemes"
import { alreadyPicked, containerPickedTwice } from "@waste/domain/planning/checks"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { requireServiceProvider } from "./references"
import {
  assembleGroups,
  findScheme,
  GROUP_NAME_TAKEN,
  groupColumns,
  groupNameTaken,
  groupScope,
  groupsOf,
  MODULE,
  noSuchGroup,
  noSuchScheme,
  pickOf,
  referencesOf,
  replaceGroupSet,
  requireGroupReferences,
  requireNotPickedTwice,
  requireStructure,
  writeGroupSets,
  type GroupRow,
  type Scope,
} from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseDuplicate } from "./shared"

const GroupPage = Page(CollectionGroup)

/** What a manual group's rule route answers: the group has no rule to replace. */
const MANUAL_HAS_NO_RULE = "This collection group picks containers; it has no stop matching rule"

/** What a rule group's containers route answers: its stops are matched, not picked. */
const RULE_PICKS_NOTHING = "This collection group matches by rule; its containers are not picked"

/** What a `days` patch is told when a day it adds is one another group already picks one of this group's containers on. */
const pickedOnNewDay = (containerId: string, found: Parameters<typeof alreadyPicked>[0]): string => `Container ${containerId} is already picked by ${found.group} on ${found.day}`

/** What a write of a group is held against: the state of the scheme it belongs to. */
type SchemeState = { status: string; serviceDays: string[]; planningAreaId: string | null }

/**
 * One group with what a write of it is held against — its scheme's status,
 * service days and planning area — in one statement, since every write here
 * needs all of it and the join is on a primary key.
 */
async function findGroup(tx: Tx, principal: Principal, id: string): Promise<(GroupRow & { scheme: SchemeState }) | undefined> {
  const [row] = await tx
    .select({ ...groupColumns, schemeStatus: routeScheme.status, schemeServiceDays: routeScheme.serviceDays, schemePlanningAreaId: routeScheme.planningAreaId })
    .from(collectionGroup)
    .innerJoin(routeScheme, and(eq(routeScheme.companyId, collectionGroup.companyId), eq(routeScheme.id, collectionGroup.routeSchemeId)))
    .where(and(groupScope(principal), eq(collectionGroup.id, id)))
    .limit(1)
  if (row === undefined) return undefined
  const { schemeStatus, schemeServiceDays, schemePlanningAreaId, ...group } = row
  return { ...group, scheme: { status: schemeStatus, serviceDays: schemeServiceDays, planningAreaId: schemePlanningAreaId } }
}

/**
 * The group the path names, read, then read again under its scheme's row
 * lock: the first read only says which scheme to lock, and the rules below
 * are held against what the lock protects. Locks go top-down, the scheme
 * before anything of its groups, so no two requests hold half of each other's
 * pair. Not one joined `select … for update of route_scheme`: that locks the
 * scheme and re-checks the scheme's row on a conflict, but the group's row
 * would be the statement's snapshot — a `days` patch that committed while
 * this waited for the lock would go unseen, which is exactly what the second
 * read is for.
 */
async function lockedGroup(tx: Tx, principal: Principal, id: string): Promise<GroupRow & { scheme: SchemeState }> {
  const found = await findGroup(tx, principal, id)
  if (found === undefined) throw noSuchGroup(id)
  await lockRow(tx, routeScheme, { companyId: principal.companyId, id: found.routeSchemeId })
  const current = await findGroup(tx, principal, id)
  if (current === undefined) throw noSuchGroup(id)
  return current
}

/** One group on the wire, its sets read the way a page reads them. */
async function groupWithSets(tx: Tx, companyId: string, row: GroupRow): Promise<CollectionGroup> {
  const [group] = await assembleGroups(tx, companyId, [row])
  return group
}

export function collectionGroupRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/route-schemes/:id/collection-groups",
      describeRoute({
        operationId: "listRouteSchemeCollectionGroups",
        summary: "One route scheme's collection groups",
        description:
          "One page of the scheme's collection groups, oldest first (ids are time-ordered), each with its stop matching rule or its picked containers in stop order. The path says the scheme, so there is no filter; the groups by position are on the scheme itself, `GET /route-schemes/{id}`. A scheme of another company, or of a project this account does not work in, is a scheme that does not exist here. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the scheme's collection groups.", GroupPage),
          400: describeProblem("The path does not hold an id, the page size is outside 1..200, or the cursor is not one this API wrote."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `route-studio.schemes`."),
          404: describeProblem("No route scheme with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", PageRequest),
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit, cursor } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if ((await findScheme(tx, principal, id)) === undefined) throw noSuchScheme(id)
        const rows = await tx
          .select(groupColumns)
          .from(collectionGroup)
          .where(and(groupScope(principal), eq(collectionGroup.routeSchemeId, id), after === undefined ? undefined : gt(collectionGroup.id, after)))
          .orderBy(asc(collectionGroup.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: await assembleGroups(tx, principal.companyId, items), nextCursor })
      },
    )
    .post(
      "/route-schemes/:id/collection-groups",
      describeRoute({
        operationId: "createCollectionGroup",
        summary: "Add a collection group to a route scheme",
        description:
          "Adds one collection group to the scheme the path names; the scheme says the project, so the body names neither. The name is unique within the scheme. The group finds its stops one way: `stopSource: rule` with a rule naming one or more waste fractions of this company, none or more container types of this company and, optionally, a vehicle type, and no containers; or `stopSource: manual` with one or more containers of the scheme's project in stop order and no rule. The service provider, where given, is this company's. The group's days lie within the scheme's service days, and no container it picks may already be picked by another group of the scheme on a day both run — the entry is refused naming that group and the day. The position is where the group stands among the scheme's, after the last when absent; it is not unique, and the first rule group wins a container on a shared day. On a `validated` scheme the structural rules are re-run as the scheme would stand with the group — a rule group needs a planning area to match inside — and every sentence that fails is listed (409). The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The collection group as it was written.", CollectionGroup),
          400: describeProblem(
            "The path does not hold an id, or the body is missing a field, names a member the server owns, gives both a rule and containers or neither, runs on a day the scheme does not serve, picks a container another group runs on the same day, or names a waste fraction, container type, container or service provider outside the scope its key allows — each at the entry that is wrong.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `route-studio.schemes`."),
          404: describeProblem("No route scheme with that id in the projects this account works in."),
          409: describeProblem("The scheme already has a collection group with that name, or the scheme is `validated` and does not hold together with the group: the detail lists every structural sentence that fails."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", CollectionGroupCreate),
      async (c) => {
        const { id } = c.req.valid("param")
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The scheme this group is held inside, locked before it is read, so
        // a patch narrowing its days cannot commit between the two.
        await lockRow(tx, routeScheme, { companyId: principal.companyId, id })
        const scheme = await findScheme(tx, principal, id)
        if (scheme === undefined) throw noSuchScheme(id)
        const within: Scope = { companyId: principal.companyId, projectId: scheme.projectId }

        if (!withinServiceDays(scheme.serviceDays, values.days)) throw invalidRequest("body", [{ path: "days", message: OUTSIDE_SERVICE_DAYS }])
        await requireGroupReferences(tx, within, referencesOf(values))
        const others = (await groupsOf(tx, principal.companyId, [id])).get(id) ?? []
        requireNotPickedTwice(others.map(pickOf), pickOf(values), (m) => `containerIds.${m}`)
        requireStructure(scheme, [...others, values])

        const [row] = await refuseDuplicate({ [GROUP_NAME_TAKEN]: groupNameTaken(values.name) }, () =>
          tx
            .insert(collectionGroup)
            .values({
              id: newId(),
              companyId: principal.companyId,
              projectId: scheme.projectId,
              routeSchemeId: scheme.id,
              name: values.name,
              position: values.position ?? Math.max(0, ...others.map((group) => group.position)) + 1,
              days: values.days,
              stopSource: values.stopSource,
              ruleVehicleType: values.rule?.vehicleType ?? null,
              serviceProviderId: values.serviceProviderId ?? null,
            })
            .returning(groupColumns),
        )
        await writeGroupSets(tx, within, [{ id: row.id, rule: values.rule, containerIds: values.containerIds }])
        return created(c, "/collection-groups", await groupWithSets(tx, principal.companyId, row))
      },
    )
    .get(
      "/collection-groups/:id",
      describeRoute({
        operationId: "getCollectionGroup",
        summary: "One collection group",
        description:
          "One collection group of a project the caller works in, with its stop matching rule or its picked containers in stop order. A group of another company, or of a project this account does not work in, is a group that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The collection group.", CollectionGroup),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `route-studio.schemes`."),
          404: describeProblem("No collection group with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findGroup(tx, principal, id)
        if (row === undefined) throw noSuchGroup(id)
        return c.json(await groupWithSets(tx, principal.companyId, row))
      },
    )
    .patch(
      "/collection-groups/:id",
      describeRoute({
        operationId: "patchCollectionGroup",
        summary: "Change a collection group",
        description:
          "Changes the name, the position, the days or the service provider of one collection group; every field is optional and at least one must be given. The source, the rule and the picked list never move through a patch: the rule is `PUT /collection-groups/{id}/stop-matching-rule`, the list `PUT /collection-groups/{id}/containers`, and a group that should find its stops the other way is another group. A null clears the provider. New days lie within the scheme's service days, and may not put one of this group's containers on a day another group already picks it — refused at `days`, naming the container, the group and the day. `days: []` is a group that no longer runs. On a `validated` scheme a change of days re-runs the structural rules — every service day still has a group — and every sentence that fails is listed (409); the name, the position and the provider change nothing those rules read.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The collection group as it now stands.", CollectionGroup),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (the source, the rule and the containers included), runs on a day the scheme does not serve, puts a picked container on a day another group already picks it, or names a service provider that is not this company's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `route-studio.schemes`."),
          404: describeProblem("No collection group with that id in the projects this account works in."),
          409: describeProblem("The scheme already has another collection group with that name, or the scheme is `validated` and would not hold together: the detail lists every structural sentence that fails."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", CollectionGroupPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        const current = await lockedGroup(tx, principal, id)
        await requireServiceProvider(tx, principal.companyId, patch.serviceProviderId)

        if (patch.days !== undefined) {
          if (!withinServiceDays(current.scheme.serviceDays, patch.days)) throw invalidRequest("body", [{ path: "days", message: OUTSIDE_SERVICE_DAYS }])
          const groups = (await groupsOf(tx, principal.companyId, [current.routeSchemeId])).get(current.routeSchemeId) ?? []
          const moved = groups.map((group) => (group.id === id ? { ...group, days: patch.days ?? group.days } : group))
          const mine = moved.find((group) => group.id === id)
          if (mine !== undefined) {
            const found = containerPickedTwice(moved.filter((group) => group.id !== id).map(pickOf), pickOf(mine))
            if (found !== undefined) throw invalidRequest("body", [{ path: "days", message: pickedOnNewDay(mine.containerIds[found.index], found) }])
          }
          requireStructure(current.scheme, moved)
        }

        const sentences: Record<string, string> = patch.name === undefined ? {} : { [GROUP_NAME_TAKEN]: groupNameTaken(patch.name) }
        const [row] = await refuseDuplicate(sentences, () =>
          tx
            .update(collectionGroup)
            .set(patch)
            .where(and(groupScope(principal), eq(collectionGroup.id, id)))
            .returning(groupColumns),
        )
        if (row === undefined) throw noSuchGroup(id)
        return c.json(await groupWithSets(tx, principal.companyId, row))
      },
    )
    .put(
      "/collection-groups/:id/stop-matching-rule",
      describeRoute({
        operationId: "putCollectionGroupStopMatchingRule",
        summary: "Replace a collection group's stop matching rule",
        description:
          "Replaces the whole rule of a rule group with the one in the body: the waste fractions it matches (one or more, this company's), the container types it is restricted to (none or more, this company's) and the vehicle type it asks for, or null. A manual group has no rule to replace, and asking is refused (409) rather than turned into a rule group. The three sets are replaced together under the scheme's row lock, and the group's `updatedAt` moves, since the rule is part of the group on the wire. On a `validated` scheme the structural rules are re-run — a rule group needs a planning area to match inside — and every sentence that fails is listed (409).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The collection group with the rule it now has.", CollectionGroup),
          400: describeProblem(
            "The path does not hold an id, or the body is missing a field, names a member it does not own, names a fraction or a type twice, or names a waste fraction or container type that is not this company's — at the entry that is wrong.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `route-studio.schemes`."),
          404: describeProblem("No collection group with that id in the projects this account works in."),
          409: describeProblem("The group picks containers and has no stop matching rule, or the scheme is `validated` and has no planning area for a rule group to match inside."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", StopMatchingRuleSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const rule = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        const current = await lockedGroup(tx, principal, id)
        if (current.stopSource !== "rule") throw problem(409, { detail: MANUAL_HAS_NO_RULE })
        const within: Scope = { companyId: principal.companyId, projectId: current.projectId }
        // The body is the rule, so its sets sit at the top of it.
        await requireGroupReferences(tx, within, referencesOf({ rule }, { rulePrefix: "" }))
        const groups = (await groupsOf(tx, principal.companyId, [current.routeSchemeId])).get(current.routeSchemeId) ?? []
        requireStructure(
          current.scheme,
          groups.map((group) => (group.id === id ? { ...group, rule } : group)),
        )

        const row = await replaceGroupSet(tx, principal, id, { rule })
        if (row === undefined) throw noSuchGroup(id)
        return c.json(await groupWithSets(tx, principal.companyId, row))
      },
    )
    .put(
      "/collection-groups/:id/containers",
      describeRoute({
        operationId: "putCollectionGroupContainers",
        summary: "Replace a collection group's picked containers",
        description:
          "Replaces the whole list of a manual group with the one in the body, in stop order: a container the body leaves out is not in the group afterwards, positions are 1..n in the body's order, and a manual group picks at least one. Every container is one of the scheme's project, named once, and none may already be picked by another group of the scheme on a day both run — the entry is refused naming that group and the day. A rule group's stops are matched and not picked, and asking is refused (409) rather than turned into a manual group. The list is replaced under the scheme's row lock, and the group's `updatedAt` moves, since the list is part of the group on the wire. On a `validated` scheme the structural rules are re-run and every sentence that fails is listed (409).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The collection group with the containers it now picks.", CollectionGroup),
          400: describeProblem(
            "The path does not hold an id, or the body is missing `containerIds`, names a member it does not own, is empty or over two hundred, names a container twice, picks a container another group runs on the same day, or picks a container that is not of this project — at the entry that is wrong.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `route-studio.schemes`."),
          404: describeProblem("No collection group with that id in the projects this account works in."),
          409: describeProblem("The group matches by rule and its containers are not picked, or the scheme is `validated` and would not hold together: the detail lists every structural sentence that fails."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", CollectionGroupContainersSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { containerIds } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        const current = await lockedGroup(tx, principal, id)
        if (current.stopSource !== "manual") throw problem(409, { detail: RULE_PICKS_NOTHING })
        const within: Scope = { companyId: principal.companyId, projectId: current.projectId }
        await requireGroupReferences(tx, within, referencesOf({ containerIds }))
        const groups = (await groupsOf(tx, principal.companyId, [current.routeSchemeId])).get(current.routeSchemeId) ?? []
        requireNotPickedTwice(groups.filter((group) => group.id !== id).map(pickOf), { days: current.days, containerIds }, (m) => `containerIds.${m}`)
        requireStructure(
          current.scheme,
          groups.map((group) => (group.id === id ? { ...group, containerIds } : group)),
        )

        const row = await replaceGroupSet(tx, principal, id, { containerIds })
        if (row === undefined) throw noSuchGroup(id)
        return c.json(await groupWithSets(tx, principal.companyId, row))
      },
    )
}
