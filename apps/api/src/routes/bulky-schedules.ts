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
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { bulkyBooking, bulkySchedule } from "@waste/db/schema/bulky"
import { product } from "@waste/db/schema/catalogue"
import { A_BULKY_PRODUCT_IS_SOLD_BY_THE_JOB_OR_ITEM, isBulkyProductUnit } from "@waste/domain/execution/bulky"
import type { UnofferedStatus } from "@waste/domain/registry/catalogue"
import { OFFERED_PRODUCT_STATUSES } from "@waste/domain/registry/vocabulary"
import { refuseUnless } from "@waste/domain/status-gates"
import { and, eq, gte, isNull } from "drizzle-orm"
import { newId } from "@waste/db/ids"
import { refuseOverlap } from "@waste/db/commands/shared"
import { stampsOf } from "@waste/db/shapes/times"
import { refuseStranded } from "@waste/db/commands/periods"
import { requireProject } from "../auth/projects"
import type { RouteDeps } from "../deps"
import { created, describeCreated, describeJson, IdParam, routes } from "../operation"
import { pageAt } from "../pagination"
import { describeProblem, invalidRequest } from "../problem"
import { scoped } from "../scoped"
import { periodAfter, requireOrdered } from "./periods"
import { NOT_A_PRODUCT, requirePlanningArea, type Scope } from "./references"

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
    frequency: row.frequency,
    serviceDays: row.serviceDays,
    weekRotation: row.weekRotation,
    holidayPolicy: row.holidayPolicy,
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
export const unofferedBulkyProduct = (status: UnofferedStatus): string => `The product is ${status}; a bulky schedule charges an active one`

/** What an end that leaves bookings outside it is told. */
export const bookingsOutside = (rows: number): string =>
  `${rows} ${rows === 1 ? "booking is" : "bookings are"} for a day on or after the new end; cancel ${rows === 1 ? "it" : "them"} or end the schedule later`

const { scope: scheduleScope, noSuch: noSuchSchedule, get: getSchedule, locked: lockedSchedule, list: listSchedules } = scoped(bulkySchedule, { noun: "bulky schedule", reach: "projects", columns })

/** A product a schedule names: the project's, sold by the job or by the item (#449; 400 each), and active (409) unless it is the one the schedule already charges. */
async function requireBulkyProduct(tx: Tx, scope: Scope, id: string, kept?: string): Promise<void> {
  const [found] = await tx
    .select({ status: product.status, unit: product.unit })
    .from(product)
    .where(and(eq(product.companyId, scope.companyId), eq(product.projectId, scope.projectId), eq(product.id, id)))
    .limit(1)
  if (found === undefined) throw invalidRequest("body", [{ path: "productId", message: NOT_A_PRODUCT }])
  if (!isBulkyProductUnit(found.unit)) throw invalidRequest("body", [{ path: "productId", message: A_BULKY_PRODUCT_IS_SOLD_BY_THE_JOB_OR_ITEM }])
  if (id !== kept) refuseUnless(found.status, OFFERED_PRODUCT_STATUSES, unofferedBulkyProduct)
}

export function bulkyScheduleRoutes(deps: RouteDeps) {
  return routes(deps)
    .get(
      "/bulky-schedules",
      {
        operationId: "listBulkySchedules",
        summary: "The projects' bulky schedules",
        description:
          "One page of the Bulky Schedules (O11 of #290) of the projects the caller works in, oldest first (ids are time-ordered): each planning area's recurrence of bulky collection days, the slots each day has and the product a booking is charged at. `projectId` narrows it to one of those projects (naming another is refused), `planningAreaId` to one area, and `validOn` to the schedules in force on that day, `validFrom` inclusive and `validTo` exclusive. Hand `nextCursor` back as `cursor` for the next page.",
        module: MODULE,
        action: "view",
        query: BulkyScheduleListQuery,
        invalid: ["a day is not a calendar day", "`projectId` is not a project this account works in"],
        responses: {
          200: describeJson("One page of schedules.", SchedulePage),
        },
      },
      async (c) => {
        const { limit, cursor, projectId, planningAreaId, validOn: day } = c.req.valid("query")
        const at = pageAt({ cursor, limit })
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const page = await listSchedules(tx, principal, at, projectId === undefined ? undefined : eq(bulkySchedule.projectId, projectId), planningAreaId === undefined ? undefined : eq(bulkySchedule.planningAreaId, planningAreaId), day === undefined ? undefined : validOn(bulkySchedule, day))
        return c.json({ ...page, items: page.items.map(scheduleOf) })
      },
    )
    .post(
      "/bulky-schedules",
      {
        operationId: "createBulkySchedule",
        summary: "Add a bulky schedule",
        description:
          "Adds a Bulky Schedule to a planning area of a project the caller works in (400 at `projectId`, or at `planningAreaId` for an area of another project): the days bulky waste is collected there — a frequency, the service days, a week rotation with every-2-weeks and with nothing else, and the holiday policy, `skip` unless given, exactly as a Route Scheme's — the slots each day has, one per booking, and the product a booking is charged at once collected: a product of the project (400) sold by the job, charged once per booking, or by the item, charged the booking's item count (#449) (400 at `productId`, `A bulky collection is charged at a product sold by the job or by the item`), and active (409). One schedule of an area is in force at a time (409). The days are `generateOccurrences`' over the recurrence: a skipped holiday is no day, a shifted one is offered on the day it moved to.",
        module: MODULE,
        action: "create",
        body: BulkyScheduleCreate,
        invalid: ["the body is missing a field, names a member the server owns, a week rotation without every-2-weeks or every-2-weeks without one, no service day, a period ending on or before it starts, a project this account does not work in, an area of another project, or a product of another project or one sold by neither the job nor the item"],
        responses: {
          201: describeCreated("The schedule as it was written.", BulkySchedule),
          409: describeProblem("The product is not active, or the area has a schedule in force over part of the period."),
        },
      },
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
      {
        operationId: "getBulkySchedule",
        summary: "One bulky schedule",
        description: "One Bulky Schedule of a project the caller works in. A schedule of another company, or of a project this account does not work in, is a schedule that does not exist here.",
        module: MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The schedule.", BulkySchedule),
          404: describeProblem("No schedule with that id in the projects this account works in."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await getSchedule(c.get("tx"), c.get("principal"), id)
        return c.json(scheduleOf(row))
      },
    )
    .patch(
      "/bulky-schedules/:id",
      {
        operationId: "patchBulkySchedule",
        summary: "Amend a bulky schedule",
        description:
          "Changes the slots per day, the product or the end of one Bulky Schedule of a project the caller works in; every field is optional and at least one must be given. The area, the recurrence and the start do not change: they are the schedule's key and its period, so other days are another schedule, and this one is ended on the day the other starts. Under the schedule's row lock — the one a booking takes its slot under: the end still comes after the start (400 on `validTo`), and leaves no booking not cancelled on a day on or after it (409, counting them); a new product is held as on the create, the one already charged kept whatever its status now; and the schedule still overlaps no other of its area (409). Bookings already made keep their product and their slot: fewer slots close a day to new bookings and move none.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: BulkySchedulePatch,
        invalid: ["the patch is empty, names a field the caller does not own (the area, the recurrence and the start included), ends on or before the day the schedule starts, or names a product of another project or one sold by neither the job nor the item"],
        responses: {
          200: describeJson("The schedule as it now stands.", BulkySchedule),
          404: describeProblem("No schedule with that id in the projects this account works in."),
          409: describeProblem("The new product is not active, the new end leaves bookings outside it, or the area has another schedule in force over part of the new period."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const fields = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedSchedule(tx, principal, id)
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
