// A transfer station's haul-out (M17 of #293, row 28.3): the Outbound Loads
// that take a Transfer Station's material on to the site that treats or
// disposes of it, a station's stock, and the office's adjustments of it.
//
//   GET    /outbound-loads                         view
//   POST   /outbound-loads                         create
//   GET    /outbound-loads/:id                     view
//   PATCH  /outbound-loads/:id                     edit    the costs, our ticket, the note
//   POST   /outbound-loads/:id/receive             edit    the receiving site's ticket
//   POST   /outbound-loads/:id/reconcile           edit
//   POST   /outbound-loads/:id/dispute             edit
//   POST   /outbound-loads/:id/cancel              edit
//   GET    /unloading-stations/:id/stock           view
//   GET    /unloading-stations/:id/adjustments     view
//   POST   /unloading-stations/:id/adjustments     create
//
// All under `route-studio.weights`, the module the Unload is read in: the
// roles that capture and review the weights that come in are the roles that
// send the material on and reconcile what the receiving site weighed. No new
// module and no charter changes.
//
// A load is a project's and its two stations are the company's. A create
// names a project the caller works in (400), stations and a fraction of the
// company (400 at the field), our vehicle of the project and a hauler of the
// company where it names them (400), and then answers the rules a person can
// fix as 409s: the station it leaves is a transfer station, and the station
// it goes to takes the fraction, in the Unload's sentences. The plate is the
// body's, or our vehicle's where the body gives none. Every instant the body
// gives is held to the request's clock by the skew the Unload capture is held
// to, and a receipt comes on or after the departure (400 at `receivedAt`).
//
// The commands lock the load, read it again, and ask the domain's machine
// (@waste/domain/execution/haul-out): the next status, the command already
// done (200 with no write), or the sentence as a 409. A receipt read beside a
// load is the receiving site's net against ours, within the project's weight
// tolerance or beyond it, read on every answer and stored nowhere.
//
// A station's stock is a reading, one row per project and fraction in the
// caller's projects (one with `projectId`): the Unloads tipped there by their
// weight review, as the tonnage report counts them — approved and not yet
// reviewed count, a rejected weight is reported beside and in no total, a
// corrected one is superseded by its correction, and a load the station
// refused counts nowhere — less the loads that left it not cancelled, plus
// the adjustments. It is answered for any station of the company the caller
// reaches; only a transfer station's means stock, and only a transfer
// station takes an adjustment (409). An adjustment is a ledger row, answered
// 201 with no address of its own: a station's adjustments are listed under it.
import { OUTBOUND_LOAD_COMMANDS, notATransferStation, outboundLoadTransition, receiptReading, SAY_WHY, type OutboundLoadCommand } from "@waste/domain/execution/haul-out"
import type { WeightReviewStatus } from "@waste/domain/finance/vocabulary"
import { unloadStanding } from "@waste/domain/insight/readings"
import {
  MaterialAdjustment,
  MaterialAdjustmentCreate,
  MaterialAdjustmentListQuery,
  MaterialStock,
  MaterialStockQuery,
  OutboundLoad,
  OutboundLoadCreate,
  OutboundLoadListQuery,
  OutboundLoadPatch,
  OutboundLoadReason,
  OutboundLoadReceive,
  OutboundLoadReconcile,
  type MaterialStockRow,
  type OutboundLoadStatus,
} from "@waste/contracts/haul-out"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { reviewStatus, weightReviewOf } from "@waste/db/query/weight-review"
import { unload } from "@waste/db/schema/execution"
import { vehicle } from "@waste/db/schema/fleet"
import { materialAdjustment, outboundLoad } from "@waste/db/schema/haul-out"
import { project } from "@waste/db/schema/organisation"
import { unloadingStation } from "@waste/db/schema/places"
import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import { Hono, type Context, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, projectIdsOf, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { requireServiceProvider, requireUnloadingStation, requireVehicle, requireWasteFraction } from "./references"
import { created, describeCreated, describeJson, IdParam, lockRow, requireNotAhead, stampsOf } from "./shared"
import { notTaken, stationTakes } from "./unload-writes"

const MODULE = "route-studio.weights"

const LoadPage = Page(OutboundLoad)
const AdjustmentPage = Page(MaterialAdjustment)

/** What a receipt from before the load left is told, at the receipt's instant. */
export const RECEIVED_BEFORE_IT_LEFT = "The load is received on or after it departed"

const loadColumns = {
  id: outboundLoad.id,
  projectId: outboundLoad.projectId,
  fromStationId: outboundLoad.fromStationId,
  toStationId: outboundLoad.toStationId,
  wasteFractionId: outboundLoad.wasteFractionId,
  vehicleId: outboundLoad.vehicleId,
  serviceProviderId: outboundLoad.serviceProviderId,
  vehicleRegistration: outboundLoad.vehicleRegistration,
  departedAt: outboundLoad.departedAt,
  grossKg: outboundLoad.grossKg,
  tareKg: outboundLoad.tareKg,
  netKg: outboundLoad.netKg,
  outboundTicket: outboundLoad.outboundTicket,
  receivingTicket: outboundLoad.receivingTicket,
  receivedNetKg: outboundLoad.receivedNetKg,
  receivedAt: outboundLoad.receivedAt,
  haulCostMinor: outboundLoad.haulCostMinor,
  disposalCostMinor: outboundLoad.disposalCostMinor,
  status: outboundLoad.status,
  note: outboundLoad.note,
  createdAt: outboundLoad.createdAt,
  updatedAt: outboundLoad.updatedAt,
}
type LoadRow = Pick<typeof outboundLoad.$inferSelect, keyof typeof loadColumns>

const adjustmentColumns = {
  id: materialAdjustment.id,
  projectId: materialAdjustment.projectId,
  unloadingStationId: materialAdjustment.unloadingStationId,
  wasteFractionId: materialAdjustment.wasteFractionId,
  deltaKg: materialAdjustment.deltaKg,
  note: materialAdjustment.note,
  recordedBy: materialAdjustment.recordedBy,
  recordedAt: materialAdjustment.recordedAt,
}
type AdjustmentRow = Pick<typeof materialAdjustment.$inferSelect, keyof typeof adjustmentColumns>

const adjustmentOf = (row: AdjustmentRow): MaterialAdjustment => ({ ...row, recordedAt: row.recordedAt.toISOString() })

const noSuchLoad = (id: string) => problem(404, { detail: `No outbound load ${id} in the projects this account works in` })
const noSuchStation = (id: string) => problem(404, { detail: `No unloading station ${id} in this company` })

const loadScope = (principal: Principal) => and(eq(outboundLoad.companyId, principal.companyId), inProjects(outboundLoad.projectId, principal))

/** Each project's weight tolerance, for the projects named: what a receipt is read against. */
async function tolerancesOf(tx: Tx, companyId: string, projectIds: readonly string[]): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map()
  const rows = await tx
    .select({ id: project.id, tolerance: project.weightTolerancePercent })
    .from(project)
    .where(and(eq(project.companyId, companyId), inArray(project.id, [...new Set(projectIds)])))
  return new Map(rows.map((row) => [row.id, row.tolerance]))
}

/** The loads as the wire spells them, each receipt read against its project's tolerance: one statement for the page. */
async function loadsOf(tx: Tx, companyId: string, rows: readonly LoadRow[]): Promise<OutboundLoad[]> {
  const tolerances = await tolerancesOf(tx, companyId, rows.filter((row) => row.receivedNetKg !== null).map((row) => row.projectId))
  return rows.map((row) => {
    const { receivingTicket, receivedNetKg, receivedAt, departedAt, ...rest } = row
    const receipt =
      receivingTicket === null || receivedNetKg === null || receivedAt === null
        ? null
        : { ticket: receivingTicket, netKg: receivedNetKg, receivedAt: receivedAt.toISOString(), ...receiptReading({ netKg: row.netKg, receivedNetKg }, tolerances.get(row.projectId) ?? 0) }
    return { ...rest, departedAt: departedAt.toISOString(), status: row.status as OutboundLoadStatus, receipt, ...stampsOf(row) }
  })
}

async function findLoad(tx: Tx, principal: Principal, id: string): Promise<LoadRow | undefined> {
  const [row] = await tx
    .select(loadColumns)
    .from(outboundLoad)
    .where(and(loadScope(principal), eq(outboundLoad.id, id)))
    .limit(1)
  return row
}

/** A station of the company the caller reaches: an account that works in no project reaches none, as on the stations' own routes. */
async function findStation(tx: Tx, principal: Principal, id: string): Promise<{ id: string; name: string; transfer: boolean } | undefined> {
  if (projectIdsOf(principal).length === 0 && !principal.user.allProjects) return undefined
  const [row] = await tx
    .select({ id: unloadingStation.id, name: unloadingStation.name, transfer: unloadingStation.transfer })
    .from(unloadingStation)
    .where(and(eq(unloadingStation.companyId, principal.companyId), eq(unloadingStation.id, id)))
    .limit(1)
  return row
}

/** A sum of whole kilograms, as a number. */
const kilograms = (column: PgColumn) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number)

/** The station's stock by project and fraction, in the projects `projectIds` names. */
async function stockOf(tx: Tx, principal: Principal, stationId: string, projectId: string | undefined): Promise<MaterialStockRow[]> {
  const { companyId } = principal
  const inScope = (column: typeof unload.projectId | typeof outboundLoad.projectId | typeof materialAdjustment.projectId) =>
    and(inProjects(column, principal), projectId === undefined ? undefined : eq(column, projectId))
  const review = weightReviewOf(tx, companyId, unload.id)
  const status = reviewStatus(review.decision)
  const tipped = await tx
    .select({ projectId: unload.projectId, wasteFractionId: unload.wasteFractionId, status, netKg: kilograms(unload.netKg) })
    .from(unload)
    .leftJoinLateral(review, sql`true`)
    .where(and(eq(unload.companyId, companyId), eq(unload.unloadingStationId, stationId), sql`${unload.refusalReason} is null`, inScope(unload.projectId)))
    .groupBy(unload.projectId, unload.wasteFractionId, status)
  const sent = await tx
    .select({ projectId: outboundLoad.projectId, wasteFractionId: outboundLoad.wasteFractionId, netKg: kilograms(outboundLoad.netKg) })
    .from(outboundLoad)
    .where(and(eq(outboundLoad.companyId, companyId), eq(outboundLoad.fromStationId, stationId), ne(outboundLoad.status, "cancelled"), inScope(outboundLoad.projectId)))
    .groupBy(outboundLoad.projectId, outboundLoad.wasteFractionId)
  const adjusted = await tx
    .select({ projectId: materialAdjustment.projectId, wasteFractionId: materialAdjustment.wasteFractionId, deltaKg: kilograms(materialAdjustment.deltaKg) })
    .from(materialAdjustment)
    .where(and(eq(materialAdjustment.companyId, companyId), eq(materialAdjustment.unloadingStationId, stationId), inScope(materialAdjustment.projectId)))
    .groupBy(materialAdjustment.projectId, materialAdjustment.wasteFractionId)
  const rows = new Map<string, Omit<MaterialStockRow, "onHandKg">>()
  const rowOf = (key: { projectId: string; wasteFractionId: string }) => {
    const at = `${key.projectId} ${key.wasteFractionId}`
    const row = rows.get(at) ?? { projectId: key.projectId, wasteFractionId: key.wasteFractionId, inKg: 0, rejectedKg: 0, outKg: 0, adjustedKg: 0 }
    rows.set(at, row)
    return row
  }
  for (const group of tipped) {
    const standing = unloadStanding(group.status as WeightReviewStatus)
    if (standing === "approved" || standing === "captured") rowOf(group).inKg += group.netKg
    else if (standing === "rejected") rowOf(group).rejectedKg += group.netKg
  }
  for (const group of sent) rowOf(group).outKg += group.netKg
  for (const group of adjusted) rowOf(group).adjustedKg += group.deltaKg
  return [...rows.values()]
    .map((row) => ({ ...row, onHandKg: row.inKg - row.outKg + row.adjustedKg }))
    .sort((a, b) => a.projectId.localeCompare(b.projectId) || a.wasteFractionId.localeCompare(b.wasteFractionId))
}

const commonProblems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

const COMMAND_DESCRIPTIONS: Record<OutboundLoadCommand, { summary: string; description: string; problems: string }> = {
  receive: {
    summary: "Record the receiving site's ticket",
    description:
      "Records the receiving site's own ticket — its number, its net and when it weighed — on a departed load, which then reads as received with the site's net against our out-weighing beside it. Given again on a received or disputed load, it corrects the receipt and the load reads as received.",
    problems: "The load is reconciled or cancelled.",
  },
  reconcile: {
    summary: "Reconcile a load",
    description: "Accepts the receiving site's ticket against our out-weighing, within the tolerance or not; a disputed load is reconciled once the difference is settled. A reconciled load does not change. The note, where given, says how a dispute was settled.",
    problems: "The load is not received yet, or it is cancelled.",
  },
  dispute: {
    summary: "Dispute a load",
    description: "Records that the office does not accept the receiving site's ticket, saying why. A disputed load is reconciled once the difference is settled, or its receipt corrected.",
    problems: "The load is not received yet, or it is reconciled or cancelled.",
  },
  cancel: {
    summary: "Cancel a load",
    description: "Cancels a load that has not been received, saying why: it never left, or left on the wrong ticket and is sent again. A cancelled load no longer counts out of the station's stock.",
    problems: "The load was received, or it is reconciled.",
  },
}

const COMMAND_BODIES = { receive: OutboundLoadReceive, reconcile: OutboundLoadReconcile, dispute: OutboundLoadReason, cancel: OutboundLoadReason } as const

export type OutboundLoadRouteOptions = { now?: () => Date }

export function outboundLoadRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: OutboundLoadRouteOptions = {}) {
  /** A command on a load: locked, read again, asked of the machine, and written with what it sets beside the status. */
  async function command(c: Context<AuthEnv>, id: string, name: OutboundLoadCommand, sets: (found: LoadRow) => Partial<typeof outboundLoad.$inferInsert>): Promise<Response> {
    const principal = c.get("principal")
    const tx = c.get("tx")
    if ((await findLoad(tx, principal, id)) === undefined) throw noSuchLoad(id)
    await lockRow(tx, outboundLoad, { companyId: principal.companyId, id })
    const found = (await findLoad(tx, principal, id))!
    const transition = outboundLoadTransition(found.status as OutboundLoadStatus, name)
    if (transition.kind === "refuse") throw problem(409, { detail: transition.sentence })
    if (transition.kind === "stay") return c.json((await loadsOf(tx, principal.companyId, [found]))[0]!)
    const [row] = await tx
      .update(outboundLoad)
      .set({ ...sets(found), status: transition.to })
      .where(and(eq(outboundLoad.companyId, principal.companyId), eq(outboundLoad.id, id)))
      .returning(loadColumns)
    return c.json((await loadsOf(tx, principal.companyId, [row!]))[0]!)
  }

  const routes = new Hono<AuthEnv>()
    .get(
      "/outbound-loads",
      describeRoute({
        operationId: "listOutboundLoads",
        summary: "The outbound loads",
        description:
          "One page of the loads sent on from transfer stations in the projects the caller works in, oldest first (ids are time-ordered), each with the receiving site's ticket read against our out-weighing once it is recorded. `projectId`, `status`, `fromStationId` and `toStationId` narrow the page. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of outbound loads.", LoadPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, the project is not one the caller works in, or the status is not one of the five."),
          ...commonProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", OutboundLoadListQuery),
      async (c) => {
        const { limit, cursor, projectId, status, fromStationId, toStationId } = c.req.valid("query")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const rows = await tx
          .select(loadColumns)
          .from(outboundLoad)
          .where(
            and(
              loadScope(principal),
              projectId === undefined ? undefined : eq(outboundLoad.projectId, projectId),
              status === undefined ? undefined : eq(outboundLoad.status, status),
              fromStationId === undefined ? undefined : eq(outboundLoad.fromStationId, fromStationId),
              toStationId === undefined ? undefined : eq(outboundLoad.toStationId, toStationId),
              after === undefined ? undefined : gt(outboundLoad.id, after),
            ),
          )
          .orderBy(asc(outboundLoad.id))
          .limit(fetchLimit(limit))
        const page = pageOf(rows, limit)
        return c.json({ ...page, items: await loadsOf(tx, principal.companyId, page.items) })
      },
    )
    .post(
      "/outbound-loads",
      describeRoute({
        operationId: "createOutboundLoad",
        summary: "Send a load on",
        description:
          "Records a load leaving a transfer station for another station of the company, usually an external plant: the fraction, the carrier — our vehicle of the project, whose plate is the load's unless the body gives one, or a hauler with the plate — when it left, our out-weighing, and the haul and disposal costs in the project's currency where they are known. Costs are recorded and never billed or settled. The load departs; the server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The load as it was written.", OutboundLoad),
          400: describeProblem(
            "The body is missing a field, holds a value of the wrong shape, names a member the server owns, sends a load to the station it leaves, gives neither our vehicle nor a plate, breaks the weights' rule, names a project the caller does not work in or a station, fraction, vehicle or hauler that is not one, or departs after the request's clock.",
          ),
          ...commonProblems("create"),
          409: describeProblem("The station it leaves is not a transfer station, or the station it goes to does not take the fraction."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", OutboundLoadCreate),
      async (c) => {
        const values = c.req.valid("json")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        const tx = c.get("tx")
        const { companyId } = principal
        const within = { companyId, projectId: values.projectId }
        await requireUnloadingStation(tx, companyId, values.fromStationId, "fromStationId")
        await requireUnloadingStation(tx, companyId, values.toStationId, "toStationId")
        await requireWasteFraction(tx, companyId, values.wasteFractionId)
        await requireVehicle(tx, within, values.vehicleId)
        await requireServiceProvider(tx, companyId, values.serviceProviderId)
        const departedAt = new Date(values.departedAt)
        requireNotAhead(departedAt, now(), "departedAt")
        // Every 400 above, every 409 below.
        const from = (await findStation(tx, principal, values.fromStationId))!
        if (!from.transfer) throw problem(409, { detail: notATransferStation(from.name) })
        const takes = await stationTakes(tx, companyId, values.toStationId, values.wasteFractionId)
        if (!takes.takes) throw problem(409, { detail: notTaken(takes) })
        const registration =
          values.vehicleRegistration ??
          (await tx
            .select({ registration: vehicle.registration })
            .from(vehicle)
            .where(and(eq(vehicle.companyId, companyId), eq(vehicle.id, values.vehicleId!)))
            .limit(1))[0]!.registration
        const [row] = await tx
          .insert(outboundLoad)
          .values({ ...values, id: newId(), companyId, vehicleRegistration: registration, departedAt, status: "departed" })
          .returning(loadColumns)
        const [answer] = await loadsOf(tx, companyId, [row!])
        return created(c, "/outbound-loads", answer!)
      },
    )
    .get(
      "/outbound-loads/:id",
      describeRoute({
        operationId: "getOutboundLoad",
        summary: "One outbound load",
        description: "One load of the projects the caller works in, with the receiving site's ticket read against our out-weighing once it is recorded.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The load.", OutboundLoad),
          400: describeProblem("The path does not hold an id."),
          ...commonProblems("view"),
          404: describeProblem("No outbound load with that id in the projects the caller works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const principal = c.get("principal")
        const tx = c.get("tx")
        const row = await findLoad(tx, principal, id)
        if (row === undefined) throw noSuchLoad(id)
        return c.json((await loadsOf(tx, principal.companyId, [row]))[0]!)
      },
    )
    .patch(
      "/outbound-loads/:id",
      describeRoute({
        operationId: "patchOutboundLoad",
        summary: "Record a load's costs, ticket or note",
        description:
          "Records the haul and disposal costs, our weighbridge's ticket or the note as they become known, in any status but cancelled. The stations, the carrier and the weights are the load's: a wrong one is cancelled and sent again. A disputed load keeps a note, since it says why.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The load as it now stands.", OutboundLoad),
          400: describeProblem("The path does not hold an id, the patch is empty or names a field the caller does not own, or it takes the note off a disputed load."),
          ...commonProblems("edit"),
          404: describeProblem("No outbound load with that id in the projects the caller works in."),
          409: describeProblem("The load is cancelled."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", OutboundLoadPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const principal = c.get("principal")
        const tx = c.get("tx")
        if ((await findLoad(tx, principal, id)) === undefined) throw noSuchLoad(id)
        await lockRow(tx, outboundLoad, { companyId: principal.companyId, id })
        const found = (await findLoad(tx, principal, id))!
        if (patch.note === null && found.status === "disputed") throw invalidRequest("body", [{ path: "note", message: SAY_WHY }])
        if (found.status === "cancelled") throw problem(409, { detail: "The load is cancelled and does not change" })
        const [row] = await tx
          .update(outboundLoad)
          .set(patch)
          .where(and(eq(outboundLoad.companyId, principal.companyId), eq(outboundLoad.id, id)))
          .returning(loadColumns)
        return c.json((await loadsOf(tx, principal.companyId, [row!]))[0]!)
      },
    )
    .get(
      "/unloading-stations/:id/stock",
      describeRoute({
        operationId: "getUnloadingStationStock",
        summary: "What a station holds",
        description:
          "What the station holds by project and fraction, in the projects the caller works in (one with `projectId`): what our Unloads tipped there by their weight review — approved or not yet reviewed (`inKg`); under a weight a review rejected, beside and in no total (`rejectedKg`); a corrected unload by its correction; a load the station refused nowhere — less what left on outbound loads not cancelled (`outKg`), plus the stock counts' adjustments (`adjustedKg`). What that leaves (`onHandKg`) may read below zero. Only a transfer station's reading is stock.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The station's stock.", MaterialStock),
          400: describeProblem("The path does not hold an id, or the project is not one the caller works in."),
          ...commonProblems("view"),
          404: describeProblem("No unloading station with that id that the caller reaches."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", MaterialStockQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const { projectId } = c.req.valid("query")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const tx = c.get("tx")
        if ((await findStation(tx, principal, id)) === undefined) throw noSuchStation(id)
        return c.json({ unloadingStationId: id, rows: await stockOf(tx, principal, id, projectId) })
      },
    )
    .get(
      "/unloading-stations/:id/adjustments",
      describeRoute({
        operationId: "listMaterialAdjustments",
        summary: "A station's stock adjustments",
        description: "One page of the station's stock adjustments in the projects the caller works in, oldest first. `projectId` and `wasteFractionId` narrow the page. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the station's adjustments.", AdjustmentPage),
          400: describeProblem("The path does not hold an id, the page size is outside 1..200, the cursor is not one this API wrote, or the project is not one the caller works in."),
          ...commonProblems("view"),
          404: describeProblem("No unloading station with that id that the caller reaches."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", MaterialAdjustmentListQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit, cursor, projectId, wasteFractionId } = c.req.valid("query")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const tx = c.get("tx")
        if ((await findStation(tx, principal, id)) === undefined) throw noSuchStation(id)
        const after = afterCursor(cursor)
        const rows = await tx
          .select(adjustmentColumns)
          .from(materialAdjustment)
          .where(
            and(
              eq(materialAdjustment.companyId, principal.companyId),
              inProjects(materialAdjustment.projectId, principal),
              eq(materialAdjustment.unloadingStationId, id),
              projectId === undefined ? undefined : eq(materialAdjustment.projectId, projectId),
              wasteFractionId === undefined ? undefined : eq(materialAdjustment.wasteFractionId, wasteFractionId),
              after === undefined ? undefined : gt(materialAdjustment.id, after),
            ),
          )
          .orderBy(asc(materialAdjustment.id))
          .limit(fetchLimit(limit))
        const page = pageOf(rows, limit)
        return c.json({ ...page, items: page.items.map(adjustmentOf) })
      },
    )
    .post(
      "/unloading-stations/:id/adjustments",
      describeRoute({
        operationId: "createMaterialAdjustment",
        summary: "Adjust a station's stock",
        description:
          "Appends a stock count's correction of what a transfer station holds of a fraction for a project: signed whole kilograms, never zero, with the count's words. A wrong adjustment is answered by another; the ledger keeps both.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The adjustment as it was appended.", MaterialAdjustment),
          400: describeProblem("The path does not hold an id, or the body is missing a field, holds a value of the wrong shape, adjusts by zero, or names a project the caller does not work in or a fraction that is not the company's."),
          ...commonProblems("create"),
          404: describeProblem("No unloading station with that id that the caller reaches."),
          409: describeProblem("The station is not a transfer station."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", MaterialAdjustmentCreate),
      async (c) => {
        const { id } = c.req.valid("param")
        const values = c.req.valid("json")
        const principal = c.get("principal")
        const tx = c.get("tx")
        const station = await findStation(tx, principal, id)
        if (station === undefined) throw noSuchStation(id)
        requireProject(principal, values.projectId)
        await requireWasteFraction(tx, principal.companyId, values.wasteFractionId)
        if (!station.transfer) throw problem(409, { detail: notATransferStation(station.name) })
        const [row] = await tx
          .insert(materialAdjustment)
          .values({ ...values, id: newId(), companyId: principal.companyId, unloadingStationId: id, recordedBy: principal.user.id })
          .returning(adjustmentColumns)
        return c.json(adjustmentOf(row!), 201)
      },
    )

  for (const name of OUTBOUND_LOAD_COMMANDS) {
    const { summary, description, problems } = COMMAND_DESCRIPTIONS[name]
    routes.post(
      `/outbound-loads/:id/${name}`,
      describeRoute({
        operationId: `${name}OutboundLoad`,
        summary,
        description,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The load as it now stands; a command already done answers the load unchanged.", OutboundLoad),
          400: describeProblem(name === "receive" ? "The path does not hold an id, or the body is missing a field, holds a value of the wrong shape, or receives the load before it departed or after the request's clock." : "The path does not hold an id, or the body holds a value of the wrong shape or is missing the reason."),
          ...commonProblems("edit"),
          404: describeProblem("No outbound load with that id in the projects the caller works in."),
          409: describeProblem(problems),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", COMMAND_BODIES[name]),
      async (c) => {
        const { id } = c.req.valid("param")
        const body = c.req.valid("json") as Record<string, unknown>
        if (name === "receive") {
          const receive = body as OutboundLoadReceive
          const receivedAt = new Date(receive.receivedAt)
          requireNotAhead(receivedAt, now(), "receivedAt")
          const found = await findLoad(c.get("tx"), c.get("principal"), id)
          if (found !== undefined && receivedAt < found.departedAt) throw invalidRequest("body", [{ path: "receivedAt", message: RECEIVED_BEFORE_IT_LEFT }])
          return command(c, id, name, () => ({ receivingTicket: receive.receivingTicket, receivedNetKg: receive.receivedNetKg, receivedAt }))
        }
        const note = (body as { note?: string }).note
        return command(c, id, name, (found) => ({ note: note ?? found.note }))
      },
    )
  }
  return routes
}
