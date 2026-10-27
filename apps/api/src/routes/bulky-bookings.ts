// Bulky Bookings (O11 of #290, @waste/domain/execution/bulky): a customer's
// bulky items booked onto a collection day of the planning area their place
// lies in, one slot of the day's capacity each, routed by the office as a
// stop (`POST /routes/:id/pickups` with `service: bulky`) and charged once
// that stop is completed (the worker's finance consumer).
//
// The door is the one agreed on #383: `POST /bulky-bookings` takes the
// customer, the place, the agreement charged, the day, the fraction and the
// items; `GET /bulky-bookings/availability` answers a place's days with their
// slots left. Both run the shared statements of
// `@waste/db/commands/bulky-bookings`, which hold every rule of a booking, so
// the citizen portal reaches the same door behind its own fence. Here are the
// office's fences: the tenant and `inProjects`, a 400 for an id that is not
// the project's, the place served (409) — then the shared statement's 409s,
// each in the domain's sentence.
//
// A booking's status is read off its cancel stamp and its live stop, never
// stored; only a booked one is moved to another day, given other items or
// cancelled — a routed one's stop is taken off its route first. The grant is
// `operate.bulky-bookings`.
import { Page } from "@waste/contracts/pagination"
import { BulkyAvailability, BulkyAvailabilityQuery, BulkyBooking, BulkyBookingCancel, BulkyBookingCreate, BulkyBookingListQuery, BulkyBookingPatch, type BulkyStop } from "@waste/contracts/bulky"
import type { Tx } from "@waste/db/client"
import { bookBulky, bulkyDaysAt, bulkyItemsOf, replaceBulkyItems, requireChargeableAgreement, takeBulkySlot } from "@waste/db/commands/bulky-bookings"
import { projectToday } from "@waste/db/commands/project-clock"
import { agreement } from "@waste/db/schema/agreements"
import { bulkyBooking } from "@waste/db/schema/bulky"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { pickup } from "@waste/db/schema/execution"
import { bulkyBookingStatus, LIVE_STOP_STATUSES, onlyABookedBooking } from "@waste/domain/execution/bulky"
import type { BulkyBookingStatus, PickupStatus } from "@waste/domain/execution/vocabulary"
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lte, type SQL } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { NOT_AN_AGREEMENT, requireCustomer, requireProperty, requireSharedCollectionPoint, requireWasteFraction, type Scope } from "./references"
import { created, describeCreated, describeJson, IdParam, lockRow, stamp, stampsOf } from "./shared"
import { placeOf, refuseUnservedPlace } from "./statuses"

const MODULE = "operate.bulky-bookings"

const BookingPage = Page(BulkyBooking)

type ClockOptions = { now?: () => Date }

/** The planned or completed stop naming a booking: at most one, which `pickup_bulky_booking_id_key` holds. */
const liveStop = and(eq(pickup.companyId, bulkyBooking.companyId), eq(pickup.bulkyBookingId, bulkyBooking.id), inArray(pickup.status, LIVE_STOP_STATUSES))

/** What a booking for a customer who is not active is told: a status gates a new reference. */
export const INACTIVE_CUSTOMER = "The customer is inactive; a bulky collection is booked for an active customer"
/** What a query naming a project and a place of another is told. */
const NOT_THE_PROJECTS_PLACE = "Not a place of the project the query names"

const columns = {
  id: bulkyBooking.id,
  projectId: bulkyBooking.projectId,
  customerId: bulkyBooking.customerId,
  agreementId: bulkyBooking.agreementId,
  propertyId: bulkyBooking.propertyId,
  sharedCollectionPointId: bulkyBooking.sharedCollectionPointId,
  wasteFractionId: bulkyBooking.wasteFractionId,
  day: bulkyBooking.day,
  planningAreaId: bulkyBooking.planningAreaId,
  scheduleId: bulkyBooking.scheduleId,
  productId: bulkyBooking.productId,
  note: bulkyBooking.note,
  bookedBy: bulkyBooking.bookedBy,
  cancelledAt: bulkyBooking.cancelledAt,
  cancelledBy: bulkyBooking.cancelledBy,
  cancelReason: bulkyBooking.cancelReason,
  createdAt: bulkyBooking.createdAt,
  updatedAt: bulkyBooking.updatedAt,
  stopId: pickup.id,
  stopRouteId: pickup.routeId,
  stopStatus: pickup.status,
}


const stopOf = (row: Row): BulkyStop | null => (row.stopId === null || row.stopRouteId === null || row.stopStatus === null ? null : { pickupId: row.stopId, routeId: row.stopRouteId, status: row.stopStatus as PickupStatus })

const statusOf = (row: Row): BulkyBookingStatus => bulkyBookingStatus({ cancelledAt: row.cancelledAt, stopStatus: row.stopStatus as PickupStatus | null })

function bookingOf(row: Row, items: readonly { description: string; quantity: number }[]): BulkyBooking {
  return {
    id: row.id,
    projectId: row.projectId,
    customerId: row.customerId,
    agreementId: row.agreementId,
    propertyId: row.propertyId,
    sharedCollectionPointId: row.sharedCollectionPointId,
    wasteFractionId: row.wasteFractionId,
    day: row.day,
    items: [...items],
    note: row.note,
    status: statusOf(row),
    planningAreaId: row.planningAreaId,
    scheduleId: row.scheduleId,
    productId: row.productId,
    stop: stopOf(row),
    bookedBy: row.bookedBy,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelledBy: row.cancelledBy,
    cancelReason: row.cancelReason,
    ...stampsOf(row),
  }
}

/** Where each status stands in the row: the stamp, then the live stop. */
const STATUS_WHERE: Readonly<Record<BulkyBookingStatus, SQL | undefined>> = {
  cancelled: isNotNull(bulkyBooking.cancelledAt),
  routed: and(isNull(bulkyBooking.cancelledAt), eq(pickup.status, "planned")),
  collected: and(isNull(bulkyBooking.cancelledAt), eq(pickup.status, "completed")),
  booked: and(isNull(bulkyBooking.cancelledAt), isNull(pickup.id)),
}

const noSuchBooking = (id: string) => problem(404, { detail: `No bulky booking ${id} in the projects this account works in` })

/** This company's bookings, in the projects the caller works in. */
const bookingScope = (principal: Principal) => and(eq(bulkyBooking.companyId, principal.companyId), inProjects(bulkyBooking.projectId, principal))

const selectBookings = (tx: Tx) => tx.select(columns).from(bulkyBooking).leftJoin(pickup, liveStop)

type Row = Awaited<ReturnType<typeof selectBookings>>[number]

async function findBooking(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await selectBookings(tx)
    .where(and(bookingScope(principal), eq(bulkyBooking.id, id)))
    .limit(1)
  return row
}

async function answerOf(tx: Tx, companyId: string, row: Row): Promise<BulkyBooking> {
  return bookingOf(row, (await bulkyItemsOf(tx, companyId, [row.id])).get(row.id) ?? [])
}

/** One booking under its row lock, with what it stands as: the path's row (404), then a booked one (409 in the domain's sentence). */
async function lockedBooked(tx: Tx, principal: Principal, id: string, command: "change" | "cancel"): Promise<Row> {
  await lockRow(tx, bulkyBooking, { companyId: principal.companyId, id })
  const row = await findBooking(tx, principal, id)
  if (row === undefined) throw noSuchBooking(id)
  const status = statusOf(row)
  if (status !== "booked") throw problem(409, { detail: onlyABookedBooking(status, command) })
  return row
}

/** The project a place a query names belongs to, among the caller's: the 400 at its field otherwise. */
async function placeProject(tx: Tx, principal: Principal, place: { propertyId?: string; sharedCollectionPointId?: string }): Promise<string> {
  if (place.propertyId !== undefined) {
    const [found] = await tx
      .select({ projectId: property.projectId })
      .from(property)
      .where(and(eq(property.companyId, principal.companyId), inProjects(property.projectId, principal), eq(property.id, place.propertyId)))
      .limit(1)
    if (found === undefined) throw invalidRequest("query", [{ path: "propertyId", message: "Not a property of the projects this account works in" }])
    return found.projectId
  }
  const [found] = await tx
    .select({ projectId: sharedCollectionPoint.projectId })
    .from(sharedCollectionPoint)
    .where(and(eq(sharedCollectionPoint.companyId, principal.companyId), inProjects(sharedCollectionPoint.projectId, principal), eq(sharedCollectionPoint.id, place.sharedCollectionPointId ?? "")))
    .limit(1)
  if (found === undefined) throw invalidRequest("query", [{ path: "sharedCollectionPointId", message: "Not a shared collection point of the projects this account works in" }])
  return found.projectId
}

const commonProblems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

const DAY_REFUSALS =
  "the place has no location, or lies in no planning area with a bulky schedule; the day is today or earlier, not a bulky collection day where the place is, or fully booked (`2027-03-09 is fully booked: every bulky collection slot that day is taken`)"

export function bulkyBookingRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/bulky-bookings",
      describeRoute({
        operationId: "listBulkyBookings",
        summary: "The projects' bulky bookings",
        description:
          "One page of the Bulky Bookings of the projects the caller works in, oldest first (ids are time-ordered), each with its items in the order listed and its live stop — the planned one, or the one that collected it — and its status read from the two: `booked`, `routed`, `collected` or `cancelled`. `projectId` narrows it to one of those projects (naming another is refused); `status`, `customerId`, `propertyId`, `sharedCollectionPointId` and `planningAreaId` to one of each; `from` and `to` to a window of the booking's day, both inclusive. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of bookings.", BookingPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a day is not a calendar day, the window ends before it starts, or `projectId` is not a project this account works in."),
          ...commonProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", BulkyBookingListQuery),
      async (c) => {
        const { limit, cursor, projectId, status, customerId, propertyId, sharedCollectionPointId, planningAreaId, from, to } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await selectBookings(tx)
          .where(
            and(
              bookingScope(principal),
              projectId === undefined ? undefined : eq(bulkyBooking.projectId, projectId),
              status === undefined ? undefined : STATUS_WHERE[status],
              customerId === undefined ? undefined : eq(bulkyBooking.customerId, customerId),
              propertyId === undefined ? undefined : eq(bulkyBooking.propertyId, propertyId),
              sharedCollectionPointId === undefined ? undefined : eq(bulkyBooking.sharedCollectionPointId, sharedCollectionPointId),
              planningAreaId === undefined ? undefined : eq(bulkyBooking.planningAreaId, planningAreaId),
              from === undefined ? undefined : gte(bulkyBooking.day, from),
              to === undefined ? undefined : lte(bulkyBooking.day, to),
              after === undefined ? undefined : gt(bulkyBooking.id, after),
            ),
          )
          .orderBy(asc(bulkyBooking.id))
          .limit(fetchLimit(limit))
        const page = pageOf(rows, limit)
        const items = await bulkyItemsOf(
          tx,
          principal.companyId,
          page.items.map((row) => row.id),
        )
        return c.json({ ...page, items: page.items.map((row) => bookingOf(row, items.get(row.id) ?? [])) })
      },
    )
    .get(
      "/bulky-bookings/availability",
      describeRoute({
        operationId: "getBulkyAvailability",
        summary: "The days a place may be booked for a bulky collection",
        description:
          "The days of the window, both ends included, a place — `propertyId` or `sharedCollectionPointId`, one of the two, of a project the caller works in (400 at the field otherwise), and of `projectId` where the query names one (400 at `projectId` for a project the caller does not work in, at the place's field for a place of another) — may book a bulky collection on: the days of the Bulky Schedule of the planning area the place lies in on each day, its location inside the area's boundary in force that day, after the project's today on its clock, in date order. Each day names its slots, how many bookings not cancelled hold one, how many are left — a full day is listed with none left, and a booking of it is refused — and the schedule and area they are counted under; where two scheduled areas hold the place on a day, the lowest area code's. The days are the schedule's occurrences (`generateOccurrences`): a skipped holiday is no day, and a shifted one is offered on the day it moved to. The window is at most 92 days. A place with no location, or in no planning area with a bulky schedule over the window, is refused (409).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The place's days with their slots.", BulkyAvailability),
          400: describeProblem("The query names no place or two, a project this account does not work in or a place not of the project it names, a day that is not a calendar day, a window ending before it starts or longer than 92 days, or a place of a project this account does not work in."),
          ...commonProblems("view"),
          409: describeProblem("The place has no location, or lies in no planning area with a bulky schedule over the window."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", BulkyAvailabilityQuery),
      async (c) => {
        const { projectId: named, propertyId, sharedCollectionPointId, from, to } = c.req.valid("query")
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (named !== undefined) requireProject(principal, named, "projectId", "query")
        const projectId = await placeProject(tx, principal, { propertyId, sharedCollectionPointId })
        if (named !== undefined && named !== projectId)
          throw invalidRequest("query", [{ path: propertyId !== undefined ? "propertyId" : "sharedCollectionPointId", message: NOT_THE_PROJECTS_PLACE }])
        const scope: Scope = { companyId: principal.companyId, projectId }
        const today = await projectToday(tx, scope, now)()
        const days = await bulkyDaysAt(tx, scope, { propertyId: propertyId ?? null, sharedCollectionPointId: sharedCollectionPointId ?? null }, { from, to }, today)
        return c.json({ days })
      },
    )
    .post(
      "/bulky-bookings",
      describeRoute({
        operationId: "createBulkyBooking",
        summary: "Book a bulky collection",
        description: `Books a bulky collection for a customer: at one of the two places — a property or a shared collection point of the agreement's project — on a day, of a waste fraction, with its items (at least one, each a description and a count), charged to an agreement of a project the caller works in (400 at \`agreementId\` otherwise). The customer is the company's (400) and the agreement's (400 at \`customerId\`), the place the project's (400 at its field) and the fraction the company's (400). Then the rows: the customer active (409), the place served — an active property, an open or restricted point (409); the agreement signed, in force on the day, and serving the place that day through a subscription there (409 each); then the day: ${DAY_REFUSALS} (409). The booking takes one slot of its day under its schedule's row lock, so two bookings of the last slot take turns and the second is refused. It freezes the area, the schedule and the schedule's product — what its completion is charged at — and stands \`booked\` until the office routes it as a stop (\`POST /routes/{id}/pickups\` with \`service: bulky\`). The same statement answers the citizen portal's door (#383).`,
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The booking, booked, with its items.", BulkyBooking),
          400: describeProblem("The body is missing a field, names a member the server owns, no place or two, no item or too many, an agreement of a project this account does not work in or of another customer, or a customer, place or fraction that is not the company's or the project's."),
          ...commonProblems("create"),
          409: describeProblem(`The customer is inactive; the place is not served; the agreement is not signed, not in force on the day, or serves nothing at the place; ${DAY_REFUSALS}.`),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", BulkyBookingCreate),
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const [found] = await tx
          .select({ projectId: agreement.projectId })
          .from(agreement)
          .where(and(eq(agreement.companyId, principal.companyId), inProjects(agreement.projectId, principal), eq(agreement.id, body.agreementId)))
          .limit(1)
        if (found === undefined) throw invalidRequest("body", [{ path: "agreementId", message: NOT_AN_AGREEMENT }])
        const scope: Scope = { companyId: principal.companyId, projectId: found.projectId }
        const customerStatus = await requireCustomer(tx, principal.companyId, body.customerId)
        const propertyStatus = await requireProperty(tx, scope, body.propertyId)
        const pointStatus = await requireSharedCollectionPoint(tx, scope, body.sharedCollectionPointId)
        await requireWasteFraction(tx, principal.companyId, body.wasteFractionId)
        const place = { propertyId: body.propertyId ?? null, sharedCollectionPointId: body.sharedCollectionPointId ?? null }
        // The agreement's customer is the body's own field, a 400 asked before any 409.
        await requireChargeableAgreement(tx, scope, { customerId: body.customerId, agreementId: body.agreementId, place, day: body.day }, { customerOnly: true })
        if (customerStatus !== undefined && customerStatus !== "active") throw problem(409, { detail: INACTIVE_CUSTOMER })
        refuseUnservedPlace(placeOf(propertyStatus, pointStatus), "booking")
        const today = await projectToday(tx, scope, now)()
        const id = await bookBulky(tx, scope, newId(), { ...body, place, note: body.note ?? null, bookedBy: principal.user.id }, today)
        const row = await findBooking(tx, principal, id)
        if (row === undefined) throw new Error(`bulky booking ${id} written and then not there`)
        return created(c, "/bulky-bookings", await answerOf(tx, principal.companyId, row))
      },
    )
    .get(
      "/bulky-bookings/:id",
      describeRoute({
        operationId: "getBulkyBooking",
        summary: "One bulky booking",
        description: "One Bulky Booking of a project the caller works in, with its items, its live stop and its status. A booking of another company, or of a project this account does not work in, is a booking that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The booking.", BulkyBooking),
          400: describeProblem("The path does not hold an id."),
          ...commonProblems("view"),
          404: describeProblem("No booking with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findBooking(tx, principal, id)
        if (row === undefined) throw noSuchBooking(id)
        return c.json(await answerOf(tx, principal.companyId, row))
      },
    )
    .patch(
      "/bulky-bookings/:id",
      describeRoute({
        operationId: "patchBulkyBooking",
        summary: "Change a bulky booking",
        description: `Moves a booked Bulky Booking to another day, replaces its items whole, or changes its note; every field is optional and at least one must be given. Under the booking's row lock, only a \`booked\` one changes (409: a routed one's stop is taken off its route first, a collected or cancelled one stands). A new day is judged as on the create — the agreement in force on it and serving the place that day, then ${DAY_REFUSALS} (409) — and takes a slot of it, its area, schedule and product those of the new day; the old day's slot is freed. The way to book again a booking whose stop was missed.`,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The booking as it now stands.", BulkyBooking),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a member it does not take, or lists no item or too many."),
          ...commonProblems("edit"),
          404: describeProblem("No booking with that id in the projects this account works in."),
          409: describeProblem(`The booking is not booked; the agreement is not in force on the new day or serves nothing at the place then; ${DAY_REFUSALS}.`),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", BulkyBookingPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const fields = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedBooked(tx, principal, id, "change")
        const scope: Scope = { companyId: principal.companyId, projectId: current.projectId }
        const place = { propertyId: current.propertyId, sharedCollectionPointId: current.sharedCollectionPointId }
        const moved = fields.day !== undefined && fields.day !== current.day
        let slot = {}
        if (moved) {
          await requireChargeableAgreement(tx, scope, { customerId: current.customerId, agreementId: current.agreementId, place, day: fields.day as string })
          slot = { day: fields.day, ...(await takeBulkySlot(tx, scope, place, fields.day as string, await projectToday(tx, scope, now)())) }
        }
        await tx
          .update(bulkyBooking)
          .set({ ...slot, ...(fields.note === undefined ? {} : { note: fields.note }), ...stamp() })
          .where(and(bookingScope(principal), eq(bulkyBooking.id, id)))
        if (fields.items !== undefined) await replaceBulkyItems(tx, scope, id, fields.items)
        const row = await findBooking(tx, principal, id)
        if (row === undefined) throw noSuchBooking(id)
        return c.json(await answerOf(tx, principal.companyId, row))
      },
    )
    .post(
      "/bulky-bookings/:id/cancel",
      describeRoute({
        operationId: "cancelBulkyBooking",
        summary: "Cancel a bulky booking",
        description:
          "Cancels a booked Bulky Booking, saying why: its instant, the person and the reason are stamped, and its slot is freed. Under the booking's row lock, only a `booked` one is cancelled (409: a routed one's stop is taken off its route first, `POST /pickups/{id}/remove`; a collected or cancelled one stands). The row stays, with its items.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The booking, cancelled.", BulkyBooking),
          400: describeProblem("The path does not hold an id, or the body has no reason or carries a member the command does not take."),
          ...commonProblems("edit"),
          404: describeProblem("No booking with that id in the projects this account works in."),
          409: describeProblem("The booking is routed, collected or cancelled already."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", BulkyBookingCancel),
      async (c) => {
        const { id } = c.req.valid("param")
        const { reason } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockedBooked(tx, principal, id, "cancel")
        await tx
          .update(bulkyBooking)
          .set({ cancelledAt: now(), cancelledBy: principal.user.id, cancelReason: reason })
          .where(and(bookingScope(principal), eq(bulkyBooking.id, id)))
        const row = await findBooking(tx, principal, id)
        if (row === undefined) throw noSuchBooking(id)
        return c.json(await answerOf(tx, principal.companyId, row))
      },
    )
}

