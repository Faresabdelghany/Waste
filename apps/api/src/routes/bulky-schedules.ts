// A Planning Area's Bulky Schedules (O11 of #290,
// @waste/domain/execution/bulky): the days it collects bulky waste on, the
// slots each day has, and the product a booking is charged at. A schedule
// recurs as a Route Scheme does and is effective-dated per area (ADR-0005),
// one in force at a time (`bulky_schedule_no_overlap`); its area and its
// recurrence are its key, so a patch moves the slots, the product and the end
// alone. A booking freezes the schedule, the area and the product it was made
// under, so a schedule changed later moves none already made: fewer slots
// close a day to new bookings, and a new product charges the next. An end
// that would leave a booking not cancelled on or after it is refused,
// counting them. The grant is `route-studio.schemes`, the module of the
// recurrences it is spelled like.
import { Page } from "@waste/contracts/pagination"
import { BulkySchedule, BulkyScheduleCreate, BulkyScheduleListQuery, BulkySchedulePatch } from "@waste/contracts/bulky"
import type { ProductStatus } from "@waste/contracts/catalogue"
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { bulkyBooking, bulkySchedule } from "@waste/db/schema/bulky"
import type { HolidayPolicy, RecurrenceFrequency, ServiceDay, WeekRotation } from "@waste/domain/planning/vocabulary"
import { and, asc, eq, gt, gte, isNull } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { periodAfter, refuseStranded, requireOrdered } from "./periods"
import { requirePlanningArea, type Scope } from "./references"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseOverlap, stampsOf } from "./shared"
import { requireJobProduct } from "./work-order-charges"

const MODULE = "route-studio.schemes"

const SchedulePage = Page(BulkySchedule)

const columns = {
  id: bulkySchedule.id,
  projectId: bulkySchedule.projectId,
  planningAreaId: bulkySchedule.planningAreaId,
  frequency: bulkySchedule.frequency,
  serviceDays: bulkySchedule.serviceDays,
  weekRotation: bulkySchedule.weekRotation,
  holidayPolicy: bulkySchedule.holidayPolicy,
  slotsPerDay: bulkySchedule.slotsPerDay,
  productId: bulkySchedule.productId,
  validFrom: bulkySchedule.validFrom,
  validTo: bulkySchedule.validTo,
  createdAt: bulkySchedule.createdAt,
  updatedAt: bulkySchedule.updatedAt,
}

type Row = Pick<typeof bulkySchedule.$inferSelect, keyof typeof columns>

function scheduleOf(row: Row): BulkySchedule {
  return {
    id: row.id,
    projectId: row.projectId,
    planningAreaId: row.planningAreaId,
    frequency: row.frequency as RecurrenceFrequency,
    serviceDays: row.serviceDays as ServiceDay[],
    weekRotation: row.weekRotation as WeekRotation | null,
    holidayPolicy: row.holidayPolicy as HolidayPolicy,
    slotsPerDay: row.slotsPerDay,
    productId: row.productId,
    validFrom: row.validFrom,
    validTo: row.validTo,
    ...stampsOf(row),
  }
}

const SCHEDULE_RUNNING = "bulky_schedule_no_overlap"
const SCHEDULE_RUNNING_SENTENCE = "The planning area has a bulky schedule in force over part of that period already; end it first or start this one after it"

/** What a product a schedule names that is not offered is told. */
export const unofferedBulkyProduct = (status: Exclude<ProductStatus, "active">): string => `The product is ${status}; a bulky schedule charges an active one`

/** What an end that leaves bookings outside it is told. */
export const bookingsOutside = (rows: number): string =>
  `${rows} ${rows === 1 ? "booking is" : "bookings are"} for a day on or after the new end; cancel ${rows === 1 ? "it" : "them"} or end the schedule later`

const noSuchSchedule = (id: string) => problem(404, { detail: `No bulky schedule ${id} in the projects this account works in` })

/** This company's schedules, in the projects the caller works in. */
const scheduleScope = (principal: Principal) => and(eq(bulkySchedule.companyId, principal.companyId), inProjects(bulkySchedule.projectId, principal))

async function findSchedule(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(bulkySchedule)
    .where(and(scheduleScope(principal), eq(bulkySchedule.id, id)))
    .limit(1)
  return row
}

/** A product a schedule names: the project's, sold by the job (400 each), and active (409) unless it is the one the schedule already charges. */
async function requireBulkyProduct(tx: Tx, scope: Scope, id: string, kept?: string): Promise<void> {
  const status = await requireJobProduct(tx, scope, id)
  if (status !== "active" && id !== kept) throw problem(409, { detail: unofferedBulkyProduct(status) })
}

const commonProblems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

export function bulkyScheduleRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/bulky-schedules",
      describeRoute({
        operationId: "listBulkySchedules",
        summary: "The projects' bulky schedules",
        description:
          "One page of the Bulky Schedules (O11 of #290) of the projects the caller works in, oldest first (ids are time-ordered): each planning area's recurrence of bulky collection days, the slots each day has and the product a booking is charged at. `projectId` narrows it to one of those projects (naming another is refused), `planningAreaId` to one area, and `validOn` to the schedules in force on that day, `validFrom` inclusive and `validTo` exclusive. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of schedules.", SchedulePage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a day is not a calendar day, or `projectId` is not a project this account works in."),
          ...commonProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", BulkyScheduleListQuery),
      async (c) => {
        const { limit, cursor, projectId, planningAreaId, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(columns)
          .from(bulkySchedule)
          .where(
            and(
              scheduleScope(principal),
              projectId === undefined ? undefined : eq(bulkySchedule.projectId, projectId),
              planningAreaId === undefined ? undefined : eq(bulkySchedule.planningAreaId, planningAreaId),
              day === undefined ? undefined : validOn(bulkySchedule, day),
              after === undefined ? undefined : gt(bulkySchedule.id, after),
            ),
          )
          .orderBy(asc(bulkySchedule.id))
          .limit(fetchLimit(limit))
        const page = pageOf(rows, limit)
        return c.json({ ...page, items: page.items.map(scheduleOf) })
      },
    )
    .post(
      "/bulky-schedules",
      describeRoute({
        operationId: "createBulkySchedule",
        summary: "Add a bulky schedule",
        description:
          "Adds a Bulky Schedule to a planning area of a project the caller works in (400 at `projectId`, or at `planningAreaId` for an area of another project): the days bulky waste is collected there — a frequency, the service days, a week rotation with every-2-weeks and with nothing else, and the holiday policy, `skip` unless given, exactly as a Route Scheme's — the slots each day has, one per booking, and the product a booking is charged at once collected: a product of the project (400) sold by the job (400 at `productId`, `A work order's job is charged at a product sold by the job`) and active (409). One schedule of an area is in force at a time (409). The days are `generateOccurrences`' over the recurrence: a skipped holiday is no day, a shifted one is offered on the day it moved to.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The schedule as it was written.", BulkySchedule),
          400: describeProblem("The body is missing a field, names a member the server owns, a week rotation without every-2-weeks or every-2-weeks without one, no service day, a period ending on or before it starts, a project this account does not work in, an area of another project, or a product of another project or one not sold by the job."),
          ...commonProblems("create"),
          409: describeProblem("The product is not active, or the area has a schedule in force over part of the period."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", BulkyScheduleCreate),
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        const scope: Scope = { companyId: principal.companyId, projectId: values.projectId }
        await requirePlanningArea(tx, scope, values.planningAreaId)
        await requireBulkyProduct(tx, scope, values.productId)
        const [row] = await refuseOverlap({ [SCHEDULE_RUNNING]: SCHEDULE_RUNNING_SENTENCE }, () =>
          tx
            .insert(bulkySchedule)
            .values({ ...values, weekRotation: values.weekRotation ?? null, validTo: values.validTo ?? null, id: newId(), companyId: principal.companyId })
            .returning(columns),
        )
        return created(c, "/bulky-schedules", scheduleOf(row))
      },
    )
    .get(
      "/bulky-schedules/:id",
      describeRoute({
        operationId: "getBulkySchedule",
        summary: "One bulky schedule",
        description: "One Bulky Schedule of a project the caller works in. A schedule of another company, or of a project this account does not work in, is a schedule that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The schedule.", BulkySchedule),
          400: describeProblem("The path does not hold an id."),
          ...commonProblems("view"),
          404: describeProblem("No schedule with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findSchedule(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchSchedule(id)
        return c.json(scheduleOf(row))
      },
    )
    .patch(
      "/bulky-schedules/:id",
      describeRoute({
        operationId: "patchBulkySchedule",
        summary: "Amend a bulky schedule",
        description:
          "Changes the slots per day, the product or the end of one Bulky Schedule of a project the caller works in; every field is optional and at least one must be given. The area, the recurrence and the start do not change: they are the schedule's key and its period, so other days are another schedule, and this one is ended on the day the other starts. Under the schedule's row lock — the one a booking takes its slot under: the end still comes after the start (400 on `validTo`), and leaves no booking not cancelled on a day on or after it (409, counting them); a new product is held as on the create, the one already charged kept whatever its status now; and the schedule still overlaps no other of its area (409). Bookings already made keep their product and their slot: fewer slots close a day to new bookings and move none.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The schedule as it now stands.", BulkySchedule),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own (the area, the recurrence and the start included), ends on or before the day the schedule starts, or names a product of another project or one not sold by the job."),
          ...commonProblems("edit"),
          404: describeProblem("No schedule with that id in the projects this account works in."),
          409: describeProblem("The new product is not active, the new end leaves bookings outside it, or the area has another schedule in force over part of the new period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", BulkySchedulePatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const fields = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockRow(tx, bulkySchedule, { companyId: principal.companyId, id })
        const current = await findSchedule(tx, principal, id)
        if (current === undefined) throw noSuchSchedule(id)
        const period = periodAfter(current, fields)
        requireOrdered(period)
        const scope: Scope = { companyId: principal.companyId, projectId: current.projectId }
        if (fields.productId !== undefined) await requireBulkyProduct(tx, scope, fields.productId, current.productId)
        if (period.validTo !== null && period.validTo !== current.validTo) {
          await refuseStranded(tx, bulkyBooking, and(eq(bulkyBooking.companyId, principal.companyId), eq(bulkyBooking.scheduleId, id), gte(bulkyBooking.day, period.validTo), isNull(bulkyBooking.cancelledAt)), bookingsOutside)
        }
        const [row] = await refuseOverlap({ [SCHEDULE_RUNNING]: SCHEDULE_RUNNING_SENTENCE }, () =>
          tx
            .update(bulkySchedule)
            .set(fields)
            .where(and(scheduleScope(principal), eq(bulkySchedule.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchSchedule(id)
        return c.json(scheduleOf(row))
      },
    )
}
