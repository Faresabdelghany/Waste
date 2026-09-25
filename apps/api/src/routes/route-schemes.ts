// What recurs (Issue #97, ADR-0002): the Route Scheme, with its Collection
// Groups on it. `GET /route-schemes` lists them, `POST /route-schemes` writes
// one with the groups it starts with, `GET`/`PATCH /route-schemes/:id` read
// and amend one, and `GET /route-schemes/:id/occurrences` previews the dates
// it would plan. The groups' own routes are routes/collection-groups.ts; what
// the two modules share is routes/scheme-groups.ts. No delete: a scheme ends
// by `validTo`, and a group by `days: []`.
//
// A scheme is effective-dated (ADR-0005) and the database holds one scheme of
// a name in force at a time in a project (`route_scheme_no_overlap`, 23P01),
// so "Create new version" is a new scheme of the same name starting when the
// old ends, and `refuseOverlap` turns the constraint into the one sentence.
// `?validOn=` is how "effective" and "expired" are asked for; `status` is the
// half of the lifecycle a person decides, `draft` or `validated`, and a
// validated scheme is held to the structural rules of
// @waste/domain/planning/checks on the create or patch that makes it so and
// on every write while it is — a 409 listing every sentence. A draft accepts
// partial configuration. The prototype's remaining blockers — a vehicle and a
// default driver per group, licence eligibility — wait for Resources (step 6)
// and are not held here.
//
// The recurrence has three rules the contracts spell and the database cannot
// all hold: the week rotation belongs to `every-2-weeks` and to nothing else,
// a daily scheme serves every weekday, and a group's days lie within the
// scheme's. A create body carries the whole picture and the contracts refuse
// it; a patch carries half, so this module merges it onto the stored row and
// holds the merged row to the same rules in the same words. Narrowing the
// service days under a group that runs on one of them is a 409 counting the
// groups, since they are not in the body and have to be moved first.
// Shortening the period is free: the next generation run cancels the planned
// routes it leaves outside.
//
// The occurrence read is pure and writes nothing: the scheme's recurrence,
// its holiday policy, and the project's weekend and holidays — the holidays
// of the project's Collection Calendars when the project has a `holidayList`,
// none otherwise, named as the calendar names them or as the list's own
// lookup does — through the domain's `generateOccurrences`, the one
// implementation the guided setup's preview and the generation job (part B)
// both call, so a preview row and a generated route agree by construction.
// The scheme's `validTo` is the first day out of force and the domain's
// `effectiveTo` the last day in it, which is the one place the two spellings
// meet.
//
// The grant is `route-studio.schemes` throughout.
import { Page } from "@waste/contracts/pagination"
import type { ProblemFieldError } from "@waste/contracts/problem"
import {
  DAILY_SERVES_EVERY_DAY,
  dailyServesEveryDay,
  GROUPS_MAX,
  Occurrence,
  OccurrenceQuery,
  RouteScheme,
  RouteSchemeCreate,
  RouteSchemeListQuery,
  RouteSchemePatch,
  WEEK_ROTATION_WITH_FORTNIGHTLY,
  weekRotationShape,
  withinServiceDays,
} from "@waste/contracts/route-schemes"
import { validOn } from "@waste/db/query/valid-on"
import { collectionCalendarHoliday } from "@waste/db/schema/collection-calendars"
import { project } from "@waste/db/schema/organisation"
import { collectionGroup, routeScheme } from "@waste/db/schema/route-schemes"
import type { HolidayPolicy, RecurrenceFrequency, ServiceDay, WeekRotation } from "@waste/domain/planning/vocabulary"
import { holidayLabel, holidayNamesFor, withCarriedNames } from "@waste/domain/route-schemes/holiday-names"
import { generateOccurrences, NO_HOLIDAYS, SHIFT_SEARCH_DAYS, type HolidayList } from "@waste/domain/route-schemes/occurrences"
import { addDays, type SchemeRecurrence } from "@waste/domain/route-schemes/recurrence"
import { count } from "@waste/domain/text"
import { and, asc, eq, gt, gte, lte } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import * as z from "zod"

import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { periodAfter, requireOrdered } from "./periods"
import { requirePlanningArea } from "./references"
import {
  findScheme,
  groupsOf,
  MODULE,
  mergeReferences,
  noSuchScheme,
  pickOf,
  referencesOf,
  requireGroupReferences,
  requireNotPickedTwice,
  requireStructure,
  SCHEME_NAME_IN_FORCE,
  SCHEME_NAME_IN_FORCE_SENTENCE,
  schemeColumns,
  schemeOf,
  schemeScope,
  schemeWithGroups,
  writeGroupSets,
  type Scope,
} from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseOverlap, timeOf } from "./shared"

const RouteSchemePage = Page(RouteScheme)
const Occurrences = z.array(Occurrence)

/** What a narrowing of the service days is refused with when groups run on the days it drops; they have to be moved first. */
const groupsLeftOutside = (rows: number): string => `${count(rows, "collection group")} ${rows === 1 ? "runs" : "run"} on days the scheme would no longer serve`

/** The bounds a create body's group list is held to, stated in prose the way every bound in this API is. */
const GROUPS_BOUND = `at least one, since a scheme without explicit groups has one implicit group and the server writes it as a row, and at most ${GROUPS_MAX}, since each may pick two hundred containers and a body past that is an import rather than a form`

/**
 * The two recurrence rules a patch escapes: the contracts hold a body that
 * carries both halves, and the merged row is held here in the same words, so
 * a client reads one answer whichever noticed.
 */
function requireRecurrence(merged: { frequency: string; weekRotation: string | null; serviceDays: readonly string[] }): void {
  const errors: ProblemFieldError[] = []
  if (!weekRotationShape(merged)) errors.push({ path: "weekRotation", message: WEEK_ROTATION_WITH_FORTNIGHTLY })
  if (!dailyServesEveryDay(merged)) errors.push({ path: "serviceDays", message: DAILY_SERVES_EVERY_DAY })
  if (errors.length > 0) throw invalidRequest("body", errors)
}

export function routeSchemeRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/route-schemes",
      describeRoute({
        operationId: "listRouteSchemes",
        summary: "The route schemes the caller's projects hold",
        description:
          "One page of route schemes, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page — each with its collection groups by position, their stop matching rule or their picked containers in stop order. `projectId` narrows it to one of those projects; naming another is refused. `planningAreaId` answers the schemes matching inside one area, `status` the drafts or the validated ones, `planAhead` the ones the nightly job keeps planned or the ones it leaves alone. `validOn` asks for the schemes in force on that day, `validFrom` inclusive and `validTo` exclusive, which is how \"effective\" and \"expired\" are asked for; scheduled and Attention are readings of the generation runs, which part B adds. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of route schemes, each with its collection groups.", RouteSchemePage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `route-studio.schemes`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", RouteSchemeListQuery),
      async (c) => {
        const { limit, cursor, projectId, planningAreaId, status, planAhead, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(schemeColumns)
          .from(routeScheme)
          .where(
            and(
              schemeScope(principal),
              projectId === undefined ? undefined : eq(routeScheme.projectId, projectId),
              planningAreaId === undefined ? undefined : eq(routeScheme.planningAreaId, planningAreaId),
              status === undefined ? undefined : eq(routeScheme.status, status),
              planAhead === undefined ? undefined : eq(routeScheme.planAhead, planAhead),
              day === undefined ? undefined : validOn(routeScheme, day),
              after === undefined ? undefined : gt(routeScheme.id, after),
            ),
          )
          .orderBy(asc(routeScheme.id))
          .limit(fetchLimit(limit))
        // Paged first, so the row that only proves there is a next page is not one whose groups are loaded.
        const { items, nextCursor } = pageOf(rows, limit)
        const groups = await groupsOf(tx, principal.companyId, items.map((row) => row.id))
        return c.json({ items: items.map((row) => schemeOf(row, groups.get(row.id) ?? [])), nextCursor })
      },
    )
    .post(
      "/route-schemes",
      describeRoute({
        operationId: "createRouteScheme",
        summary: "Write a route scheme with its collection groups",
        description:
          "Writes a route scheme in one project, which must be a project the caller works in, with the collection groups it starts with — " +
          GROUPS_BOUND +
          ". The planning area, where given, is one of that project's. Every group finds its stops one way: a rule group carries a rule naming one or more waste fractions of this company, none or more container types of this company and, optionally, a vehicle type, and picks no containers; a manual group picks one or more containers of this project in stop order and carries no rule. A group's service provider is this company's. A group's days lie within the scheme's service days, and no container is picked by two groups that run on a shared day — the entry is refused naming the group and the day. Groups take positions 1..n in the body's order where a position is absent. The period is half-open, `validFrom` the first day in force and `validTo` the first day out of it, absent meaning the scheme runs on; one scheme of a name is in force at a time in a project, so a new version of a name starts when the old ends and an overlapping one is refused. The week rotation is given with `every-2-weeks` and with nothing else, and a daily scheme serves every weekday. `status` defaults to `draft`, which accepts partial configuration; a scheme created `validated` is held to the structural rules — every service day has a collection group, a rule group names a waste fraction, a manual group picks a container, and a rule group has a planning area to match inside — and refused with every sentence that fails. A vehicle and a driver per group, and their licence eligibility, wait for Resources and are not held here. The server mints every id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The route scheme as it was written, with its collection groups.", RouteScheme),
          400: describeProblem(
            `The body is missing a field, names a member the server owns, names a project this account does not work in, ends on or before the day it starts, gives the week rotation with the wrong cadence, leaves a weekday out of a daily scheme, carries no group or more than ${GROUPS_MAX}, names a group twice, runs a group on a day the scheme does not serve, gives a group both a rule and containers or neither, picks a container two groups run on the same day, or names a planning area, waste fraction, container type, container or service provider outside the scope its key allows — each at the entry that is wrong.`,
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `route-studio.schemes`."),
          409: describeProblem("A route scheme of this name is already in force over part of that period, or the scheme is created `validated` and does not hold together: the detail lists every structural sentence that fails."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", RouteSchemeCreate),
      async (c) => {
        const { collectionGroups: asked, ...values } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        const scope: Scope = { companyId: principal.companyId, projectId: values.projectId }

        // The 400s first, each at its entry: what the body points at, and
        // the picks across its groups. Then the 409s: the structure, and the
        // period the database refuses.
        await requirePlanningArea(tx, scope, values.planningAreaId)
        await requireGroupReferences(tx, scope, mergeReferences(asked.map((group, n) => referencesOf(group, { prefix: `collectionGroups.${n}.` }))))
        asked.forEach((group, n) => {
          requireNotPickedTwice(asked.slice(0, n).map(pickOf), pickOf(group), (m) => `collectionGroups.${n}.containerIds.${m}`)
        })
        requireStructure({ status: values.status, serviceDays: values.serviceDays, planningAreaId: values.planningAreaId ?? null }, asked)

        const schemeId = newId()
        const [row] = await refuseOverlap({ [SCHEME_NAME_IN_FORCE]: SCHEME_NAME_IN_FORCE_SENTENCE }, () =>
          tx
            .insert(routeScheme)
            .values({
              ...values,
              id: schemeId,
              companyId: principal.companyId,
              planningAreaId: values.planningAreaId ?? null,
              weekRotation: values.weekRotation ?? null,
              plannedStartTime: values.plannedStartTime ?? null,
              validTo: values.validTo ?? null,
            })
            .returning(schemeColumns),
        )

        const groups = asked.map((group, n) => ({
          id: newId(),
          companyId: principal.companyId,
          projectId: values.projectId,
          routeSchemeId: schemeId,
          name: group.name,
          position: group.position ?? n + 1,
          days: group.days,
          stopSource: group.stopSource,
          ruleVehicleType: group.rule?.vehicleType ?? null,
          serviceProviderId: group.serviceProviderId ?? null,
        }))
        // The contracts hold a body to one group per name, so the key cannot meet two here.
        await tx.insert(collectionGroup).values(groups)
        await writeGroupSets(
          tx,
          scope,
          groups.map((group, n) => ({ id: group.id, rule: asked[n].rule, containerIds: asked[n].containerIds })),
        )
        return created(c, "/route-schemes", await schemeWithGroups(tx, principal.companyId, row))
      },
    )
    .get(
      "/route-schemes/:id",
      describeRoute({
        operationId: "getRouteScheme",
        summary: "One route scheme",
        description:
          "One route scheme of a project the caller works in, with its collection groups by position, each with its stop matching rule or its picked containers in stop order. A scheme of another company, or of a project this account does not work in, is a scheme that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The route scheme, with its collection groups.", RouteScheme),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `route-studio.schemes`."),
          404: describeProblem("No route scheme with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findScheme(tx, principal, id)
        if (row === undefined) throw noSuchScheme(id)
        return c.json(await schemeWithGroups(tx, principal.companyId, row))
      },
    )
    .patch(
      "/route-schemes/:id",
      describeRoute({
        operationId: "patchRouteScheme",
        summary: "Amend a route scheme",
        description:
          "Amends one route scheme of a project the caller works in; every field is optional and at least one must be given. The project and the collection groups are not patchable: a record does not move between projects, and a group is `PATCH /collection-groups/{id}` or the routes under it. The patch takes the scheme's row lock and holds the row it leaves behind to the recurrence rules in the contracts' words: the end still comes after the start, the week rotation is given with `every-2-weeks` and with nothing else, and a daily scheme serves every weekday. New service days must still cover every collection group's days — a narrowing under a group that runs on a dropped day is refused (409) counting the groups, which have to be moved first. A planning area is one of the scheme's project's. The structural rules are re-run when the scheme is or becomes `validated`, and every sentence that fails is listed (409); a scheme going back to `draft` is held to none of them. A period that overlaps another scheme of the same name is refused; shortening the period is free, since the next generation run cancels the planned routes it leaves outside.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The route scheme as it now stands, with its collection groups.", RouteScheme),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (the project and the groups included), ends on or before the day it starts, gives the week rotation with the wrong cadence, leaves a weekday out of a daily scheme, or names a planning area that is not this project's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `route-studio.schemes`."),
          404: describeProblem("No route scheme with that id in the projects this account works in."),
          409: describeProblem("Collection groups run on days the scheme would no longer serve, the scheme is or becomes `validated` and does not hold together (the detail lists every sentence), or another scheme of that name is already in force over part of the period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", RouteSchemePatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The row every rule below is held against, locked before it is
        // read: a narrowing of the days and a group being added on one of
        // them are two halves of one rule, and they serialise here
        // (routes/shared.ts); the group routes take this same lock.
        await lockRow(tx, routeScheme, { companyId: principal.companyId, id })
        const current = await findScheme(tx, principal, id)
        if (current === undefined) throw noSuchScheme(id)
        const scope: Scope = { companyId: principal.companyId, projectId: current.projectId }
        const merged = { ...current, ...patch }

        await requirePlanningArea(tx, scope, patch.planningAreaId)
        if (patch.validFrom !== undefined || patch.validTo !== undefined) requireOrdered(periodAfter(current, patch))
        requireRecurrence(merged)

        const groups = (await groupsOf(tx, principal.companyId, [id])).get(id) ?? []
        if (patch.serviceDays !== undefined) {
          const outside = groups.filter((group) => !withinServiceDays(merged.serviceDays, group.days)).length
          if (outside > 0) throw problem(409, { detail: groupsLeftOutside(outside) })
        }
        requireStructure(merged, groups)

        const [row] = await refuseOverlap({ [SCHEME_NAME_IN_FORCE]: SCHEME_NAME_IN_FORCE_SENTENCE }, () =>
          tx
            .update(routeScheme)
            .set(patch)
            .where(and(schemeScope(principal), eq(routeScheme.id, id)))
            .returning(schemeColumns),
        )
        if (row === undefined) throw noSuchScheme(id)
        return c.json(schemeOf(row, groups))
      },
    )
    .get(
      "/route-schemes/:id/occurrences",
      describeRoute({
        operationId: "listRouteSchemeOccurrences",
        summary: "The dates a route scheme would plan",
        description:
          "The collections the scheme makes between `from` and `to`, both inclusive and at most a year apart, in date order and numbered, as the generation job will plan them: one row per recurrence date inside the scheme's period, with the holiday policy applied to the dates on the project's holiday list. A shifted row keeps the recurrence date as `plannedDate` — the route's identity — and moves `date` to the nearest working day in the policy's direction, a working day being one neither on the project's weekend nor on its list; a skipped row keeps its date, carries no number and is not a collection; a `holiday` row is collected as planned. The holidays are those of the project's collection calendars when the project has a `holidayList`, named as the calendar names them or, where it does not, as the list's own lookup does; a project without a list rests on its weekend only, whatever calendars it has. Pure: nothing is written, and no generation run is started.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The occurrences in the window, in date order.", Occurrences),
          400: describeProblem("The path does not hold an id, `from` or `to` is not a calendar day, `to` comes before `from`, or the window spans more than a year."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `route-studio.schemes`."),
          404: describeProblem("No route scheme with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", OccurrenceQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const window = c.req.valid("query")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const scheme = await findScheme(tx, principal, id)
        if (scheme === undefined) throw noSuchScheme(id)

        const [calendar] = await tx
          .select({ weekend: project.weekend, holidayList: project.holidayList })
          .from(project)
          .where(and(eq(project.companyId, principal.companyId), eq(project.id, scheme.projectId)))
          .limit(1)
        if (calendar === undefined) throw noSuchScheme(id)

        let holidays: HolidayList = NO_HOLIDAYS
        if (calendar.holidayList !== null) {
          // The project's holidays near enough to the window to bear on it: a
          // recurrence date lies inside it and a shift walks at most
          // SHIFT_SEARCH_DAYS from one (the domain's own bound), so nothing
          // further out is read and the two cannot diverge.
          const rows = await tx
            .select({ day: collectionCalendarHoliday.day, name: collectionCalendarHoliday.name })
            .from(collectionCalendarHoliday)
            .where(
              and(
                eq(collectionCalendarHoliday.companyId, principal.companyId),
                eq(collectionCalendarHoliday.projectId, scheme.projectId),
                gte(collectionCalendarHoliday.day, addDays(window.from, -SHIFT_SEARCH_DAYS)),
                lte(collectionCalendarHoliday.day, addDays(window.to, SHIFT_SEARCH_DAYS)),
              ),
            )
          // A name the calendar carries wins; the list's lookup names the days it does not.
          const carried = new Map(rows.flatMap((row) => (row.name === null ? [] : [[row.day, row.name] as const])))
          const names = withCarriedNames(carried, holidayNamesFor(calendar.holidayList))
          holidays = new Map(rows.map((row) => [row.day, holidayLabel(row.day, names)]))
        }

        const recurrence: SchemeRecurrence = {
          frequency: scheme.frequency as RecurrenceFrequency,
          serviceDays: scheme.serviceDays as ServiceDay[],
          ...(scheme.weekRotation === null ? {} : { weekRotation: scheme.weekRotation as WeekRotation }),
          effectiveFrom: scheme.validFrom,
          // `validTo` is the first day out of force; the domain's `effectiveTo` is the last day in it.
          effectiveTo: scheme.validTo === null ? "" : addDays(scheme.validTo, -1),
          ...(scheme.plannedStartTime === null ? {} : { startTime: timeOf(scheme.plannedStartTime) }),
        }
        const rows = generateOccurrences({
          recurrence,
          window,
          holidayPolicy: scheme.holidayPolicy as HolidayPolicy,
          calendar: { holidays, weekend: calendar.weekend as ServiceDay[] },
        })
        return c.json(rows)
      },
    )
}
