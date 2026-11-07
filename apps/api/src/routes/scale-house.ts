// The scale house (M16a of #293, #404): the tare register and the tickets
// weighed at the window of one of our own sites.
//
// `/vehicle-tares` is the register: a vehicle's weight empty in a project, by
// its plate and, where it is weighed with them, its trailer's plate and the
// container it carries, each stored as the match reads a plate
// (`tareKeyOf`). One active tare per plate, trailer and container; a
// re-weighing patches the row, which the audit trail keeps, and a retired one
// stays for the tickets completed on it.
//
// `/scale-tickets` is the window. A ticket is weighed in at its gross
// (`POST /scale-tickets`), numbered in the company's series, at a station
// that is ours (`ownership = company`), weighs (`weighbridge`) and is in use,
// for an account customer under one of its agreements in the ticket's
// project, or a walk-in. A plate that is one of the project's vehicles names
// it. `POST …/complete` takes the tare — a second pass, or the vehicle's
// registered tare — and the load split into lines of the station's fractions
// that sum to the net (`linesIssue`), all in one transaction under the
// ticket's lock. One of our own vehicles' ticket is a single fraction and is
// matched as a weighbridge's ticket is (`matchTicket`, over O27's
// `routesOf`): matched, it is written as that route's Unload through O27's
// writer, which emits `unload-recorded`; unmatched, it keeps why. `POST
// …/void` voids a ticket with its reason, never deleting it; one written as
// an Unload stands, since weight control settles that Unload.
//
// The window's prices (M16b of #293): a line may name the window's product it
// is sold by — one of the project's, per tonne or per cubic metre, the latter
// with its declared volume — and the completion and the void are news for
// Finance (`scale-ticket-completed`, `scale-ticket-voided`), whose consumer
// charges an account's lines under its agreement and cancels them on the void.
// `GET …/amount-due` reads what a ticket comes to at the window, a walk-in's
// under the project's default list, priced as Finance would; it stores
// nothing. No payment is taken here: that waits for the owner's decision
// (M15).
import { routeLabel } from "@waste/contracts/execution"
import { Page } from "@waste/contracts/pagination"
import {
  ScaleTicket,
  ScaleTicketComplete,
  ScaleTicketCreate,
  ScaleTicketListQuery,
  ScaleTicketPatch,
  ScaleTicketVoid,
  VehicleTare,
  VehicleTareCreate,
  VehicleTareListQuery,
  VehicleTarePatch,
  ScaleTicketAmountDue,
  type AmountDueLine,
  type ScaleTicketParty,
  type ScaleTicketStatus,
  type ScaleTicketVoidReason,
  type TareSource,
  type VehicleTareStatus,
} from "@waste/contracts/scale-house"
import type { ProblemFieldError } from "@waste/contracts/problem"
import type { Tx } from "@waste/db/client"
import { notTaken, stationTakes } from "@waste/db/commands/unloads"
import { dayInTimezone } from "@waste/domain/clock"
import { projectTimezone } from "@waste/db/commands/project-clock"
import { nextNumber } from "@waste/db/commands/shared"
import { priceWindowLine, windowLinesOf } from "@waste/db/commands/window-prices"
import { product } from "@waste/db/schema/catalogue"
import { agreement } from "@waste/db/schema/agreements"
import { route } from "@waste/db/schema/execution"
import { vehicle } from "@waste/db/schema/fleet"
import { project } from "@waste/db/schema/organisation"
import { unloadingStation } from "@waste/db/schema/places"
import { scaleTicket, scaleTicketLine, vehicleTare } from "@waste/db/schema/scale-house"
import type { WeighbridgeUnmatchedReason } from "@waste/domain/execution/vocabulary"
import { matchTicket, plateKey } from "@waste/domain/execution/weighbridge"
import { CUBIC_METRE_UNIT, soldAtTheWindow } from "@waste/domain/finance/window"
import type { ProductStatus, ProductUnit } from "@waste/domain/registry/vocabulary"
import { linesIssue, netOf, registeredTare, tareKeyOf } from "@waste/domain/scale-house/rules"
import { and, asc, eq, gt, inArray } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { newId } from "@waste/db/ids"
import { emit } from "@waste/db/commands/outbox"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { NOT_AN_UNLOADING_STATION, requireAgreement, requireCustomer, requireProduct, requireWasteFraction } from "./references"
import { refuseUnofferedProduct } from "./statuses"
import type { ClockOptions } from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseDuplicate, requireNotAhead, stampsOf } from "./shared"
import { writeUnload } from "./unload-writes"
import { routesOf } from "./weighbridge"

const MODULE = "operate.scale-house"

const TarePage = Page(VehicleTare)
const TicketPage = Page(ScaleTicket)

/** A ticket's number as the customer is handed it. */
export const scaleTicketLabel = (number: number): string => `ST-${number}`

// --- The tare register -------------------------------------------------------

const tareColumns = {
  id: vehicleTare.id,
  projectId: vehicleTare.projectId,
  createdAt: vehicleTare.createdAt,
  updatedAt: vehicleTare.updatedAt,
  plate: vehicleTare.plate,
  trailerPlate: vehicleTare.trailerPlate,
  containerRef: vehicleTare.containerRef,
  tareKg: vehicleTare.tareKg,
  weighedOn: vehicleTare.weighedOn,
  customerId: vehicleTare.customerId,
  label: vehicleTare.label,
  status: vehicleTare.status,
}

type TareRow = Pick<typeof vehicleTare.$inferSelect, keyof typeof tareColumns>

const tareOf = (row: TareRow): VehicleTare => ({
  id: row.id,
  ...stampsOf(row),
  projectId: row.projectId,
  plate: row.plate,
  trailerPlate: row.trailerPlate,
  containerRef: row.containerRef,
  tareKg: row.tareKg,
  weighedOn: row.weighedOn,
  customerId: row.customerId,
  label: row.label,
  status: row.status as VehicleTareStatus,
})

const tareScope = (principal: Principal) => and(eq(vehicleTare.companyId, principal.companyId), inProjects(vehicleTare.projectId, principal))

const noSuchTare = (id: string) => problem(404, { detail: `No registered tare ${id} in the projects this account works in` })

/** What a second active tare of one plate, trailer and container is told. */
export const TARE_TAKEN = "An active tare is registered for this plate, trailer and container already: re-weigh that one, or retire it first"

/** What a plate, a trailer's plate or a container's reference with nothing to key it by is told. */
export const NOTHING_TO_KEY = "Give letters or digits: the register keys a plate by them alone"

/** The keys a body's plate, trailer and container are stored by, refused at the field where a given one keys to nothing. */
function tareKeys(body: { plate: string; trailerPlate?: string | null; containerRef?: string | null }, paths = { plate: "plate", trailerPlate: "trailerPlate", containerRef: "containerRef" }) {
  const errors: ProblemFieldError[] = []
  const keyed = (value: string | null | undefined, path: string): string | null => {
    if (value == null) return null
    const key = tareKeyOf(value)
    if (key === null) errors.push({ path, message: NOTHING_TO_KEY })
    return key
  }
  const keys = { plate: keyed(body.plate, paths.plate), trailerPlate: keyed(body.trailerPlate, paths.trailerPlate), containerRef: keyed(body.containerRef, paths.containerRef) }
  if (errors.length > 0) throw invalidRequest("body", errors)
  return keys as { plate: string; trailerPlate: string | null; containerRef: string | null }
}

async function findTare(tx: Tx, principal: Principal, id: string): Promise<TareRow | undefined> {
  const [row] = await tx
    .select(tareColumns)
    .from(vehicleTare)
    .where(and(tareScope(principal), eq(vehicleTare.id, id)))
    .limit(1)
  return row
}

// --- The tickets -------------------------------------------------------------

const ticketColumns = {
  id: scaleTicket.id,
  projectId: scaleTicket.projectId,
  createdAt: scaleTicket.createdAt,
  updatedAt: scaleTicket.updatedAt,
  number: scaleTicket.number,
  unloadingStationId: scaleTicket.unloadingStationId,
  vehiclePlate: scaleTicket.vehiclePlate,
  trailerPlate: scaleTicket.trailerPlate,
  containerRef: scaleTicket.containerRef,
  vehicleId: scaleTicket.vehicleId,
  party: scaleTicket.party,
  customerId: scaleTicket.customerId,
  agreementId: scaleTicket.agreementId,
  visitorName: scaleTicket.visitorName,
  grossKg: scaleTicket.grossKg,
  weighedInAt: scaleTicket.weighedInAt,
  tareKg: scaleTicket.tareKg,
  tareSource: scaleTicket.tareSource,
  vehicleTareId: scaleTicket.vehicleTareId,
  weighedOutAt: scaleTicket.weighedOutAt,
  netKg: scaleTicket.netKg,
  status: scaleTicket.status,
  routeId: scaleTicket.routeId,
  unloadId: scaleTicket.unloadId,
  unmatchedReason: scaleTicket.unmatchedReason,
  voidReason: scaleTicket.voidReason,
  voidNote: scaleTicket.voidNote,
  voidedAt: scaleTicket.voidedAt,
  note: scaleTicket.note,
  recordedBy: scaleTicket.recordedBy,
}

type TicketRow = Pick<typeof scaleTicket.$inferSelect, keyof typeof ticketColumns>

const lineColumns = {
  id: scaleTicketLine.id,
  ticketId: scaleTicketLine.ticketId,
  position: scaleTicketLine.position,
  wasteFractionId: scaleTicketLine.wasteFractionId,
  originMunicipality: scaleTicketLine.originMunicipality,
  netKg: scaleTicketLine.netKg,
  productId: scaleTicketLine.productId,
  volumeLitres: scaleTicketLine.volumeLitres,
}

type LineRow = Pick<typeof scaleTicketLine.$inferSelect, keyof typeof lineColumns>

const ticketOf = (row: TicketRow, lines: readonly LineRow[]): ScaleTicket => ({
  id: row.id,
  ...stampsOf(row),
  projectId: row.projectId,
  number: row.number,
  unloadingStationId: row.unloadingStationId,
  vehiclePlate: row.vehiclePlate,
  trailerPlate: row.trailerPlate,
  containerRef: row.containerRef,
  vehicleId: row.vehicleId,
  party: row.party as ScaleTicketParty,
  customerId: row.customerId,
  agreementId: row.agreementId,
  visitorName: row.visitorName,
  grossKg: row.grossKg,
  weighedInAt: row.weighedInAt.toISOString(),
  tareKg: row.tareKg,
  tareSource: row.tareSource as TareSource | null,
  vehicleTareId: row.vehicleTareId,
  weighedOutAt: row.weighedOutAt?.toISOString() ?? null,
  netKg: row.netKg,
  status: row.status as ScaleTicketStatus,
  lines: lines.map((line) => ({ id: line.id, position: line.position, wasteFractionId: line.wasteFractionId, originMunicipality: line.originMunicipality, netKg: line.netKg, productId: line.productId, volumeLitres: line.volumeLitres })),
  routeId: row.routeId,
  unloadId: row.unloadId,
  unmatchedReason: row.unmatchedReason as WeighbridgeUnmatchedReason | null,
  voidReason: row.voidReason as ScaleTicketVoidReason | null,
  voidNote: row.voidNote,
  voidedAt: row.voidedAt?.toISOString() ?? null,
  note: row.note,
  recordedBy: row.recordedBy,
})

/** The tickets with their lines, in position order, read in one statement. */
async function ticketsOf(tx: Tx, companyId: string, rows: readonly TicketRow[]): Promise<ScaleTicket[]> {
  if (rows.length === 0) return []
  const lines = await tx
    .select(lineColumns)
    .from(scaleTicketLine)
    .where(
      and(
        eq(scaleTicketLine.companyId, companyId),
        inArray(
          scaleTicketLine.ticketId,
          rows.map((row) => row.id),
        ),
      ),
    )
    .orderBy(asc(scaleTicketLine.ticketId), asc(scaleTicketLine.position))
  const byTicket = new Map<string, LineRow[]>()
  for (const line of lines) byTicket.set(line.ticketId, [...(byTicket.get(line.ticketId) ?? []), line])
  return rows.map((row) => ticketOf(row, byTicket.get(row.id) ?? []))
}

const ticketScope = (principal: Principal) => and(eq(scaleTicket.companyId, principal.companyId), inProjects(scaleTicket.projectId, principal))

const noSuchTicket = (id: string) => problem(404, { detail: `No scale ticket ${id} in the projects this account works in` })

async function findTicket(tx: Tx, principal: Principal, id: string): Promise<TicketRow | undefined> {
  const [row] = await tx
    .select(ticketColumns)
    .from(scaleTicket)
    .where(and(ticketScope(principal), eq(scaleTicket.id, id)))
    .limit(1)
  return row
}

/** What a station a ticket names is told where it is not one of our own in use with a weighbridge. */
export const NOT_A_SITE = "Not one of our own stations in use with a weighbridge"

/** What an agreement of another customer is told. */
export const NOT_THE_CUSTOMERS_AGREEMENT = "Not an agreement of this customer"

/** What a walk-in's name on an account's ticket is told. */
export const ACCOUNT_HAS_NO_VISITOR = "An account's ticket names its customer, not a visitor"

/** What a command on a ticket that is not open is told. */
export const notOpen = (number: number, status: string, verb: string) => `Ticket ${scaleTicketLabel(number)} is ${status}; only an open ticket is ${verb}`

/** What a weighed tare not under the gross is told. */
export const tareNotUnder = (grossKg: number) => `The tare must be less than the gross of ${grossKg} kg`

/** What a registered tare not under the gross is told. */
export const registeredTareNotUnder = (tareKg: number, grossKg: number) => `The registered tare of ${tareKg} kg is not less than the gross of ${grossKg} kg: weigh the vehicle out`

/** What a ticket with no registered tare for its vehicle is told. */
export const noRegisteredTare = (plate: string) => `No active tare is registered for ${plate} with this trailer and container: weigh the vehicle out`

/** What lines that do not sum to the net are told. */
export const linesOffNet = (sum: number, netKg: number) => `The lines come to ${sum} kg; the net is ${netKg} kg`

/** What one of our own vehicles' ticket split into several lines is told. */
export const OWN_LOAD_IS_ONE_FRACTION = "One of our own vehicles' load is one fraction: it is written as its route's Unload"

/** What a line's product the window does not sell by is told. */
export const NOT_SOLD_AT_THE_WINDOW = "Not a product the window sells by the tonne or the cubic metre"

/** What a cubic-metre line without its volume is told. */
export const VOLUME_REQUIRED = "A load sold by the cubic metre declares its volume"

/** What a volume on a line sold otherwise is told. */
export const VOLUME_ONLY_BY_THE_CUBIC_METRE = "Only a load sold by the cubic metre declares a volume"

/** What a second pass before the first is told. */
export const OUT_BEFORE_IN = "The second pass comes after the first"

/** What a void of a ticket written as an Unload is told. */
export const writtenAsUnload = (number: number, routeNumber: number) =>
  `Ticket ${scaleTicketLabel(number)} was written as route ${routeLabel(routeNumber)}'s Unload; weight control settles that Unload, so the ticket stands`

/** The station a ticket names: the company's, ours, weighing and in use, else a 400 at the field. */
async function requireSite(tx: Tx, companyId: string, id: string): Promise<void> {
  const [row] = await tx
    .select({ ownership: unloadingStation.ownership, weighbridge: unloadingStation.weighbridge, status: unloadingStation.status })
    .from(unloadingStation)
    .where(and(eq(unloadingStation.companyId, companyId), eq(unloadingStation.id, id)))
    .limit(1)
  if (row === undefined) throw invalidRequest("body", [{ path: "unloadingStationId", message: NOT_AN_UNLOADING_STATION }])
  if (row.ownership !== "company" || !row.weighbridge || !["active", "seasonal"].includes(row.status)) throw invalidRequest("body", [{ path: "unloadingStationId", message: NOT_A_SITE }])
}

/** The project's vehicle the plate is, with its project's clock; null where it is none, or where two of its vehicles key to it. */
async function vehicleOfPlate(tx: Tx, companyId: string, projectId: string, plate: string): Promise<{ id: string; projectId: string; timezone: string } | null> {
  const key = plateKey(plate)
  const rows = await tx
    .select({ id: vehicle.id, registration: vehicle.registration, timezone: project.timezone })
    .from(vehicle)
    .innerJoin(project, and(eq(project.companyId, vehicle.companyId), eq(project.id, vehicle.projectId)))
    .where(and(eq(vehicle.companyId, companyId), eq(vehicle.projectId, projectId)))
  const matches = rows.filter((row) => plateKey(row.registration) === key)
  return matches.length === 1 ? { id: matches[0].id, projectId, timezone: matches[0].timezone } : null
}

const commonProblems = (action: "view" | "create" | "edit") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

export function scaleHouseRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return (
    new Hono<AuthEnv>()
      // --- The tare register ---
      .get(
        "/vehicle-tares",
        describeRoute({
          operationId: "listVehicleTares",
          summary: "The tare register",
          description:
            "One page of the registered tares in the projects the caller works in, oldest first (ids are time-ordered). `projectId`, `plate` (keyed as stored: upper case, letters and digits alone, however it is typed) and `status` narrow the page. Hand `nextCursor` back as `cursor` for the next page.",
          security: BEARER_SECURITY,
          responses: {
            200: describeJson("One page of registered tares.", TarePage),
            400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, the project is not one the caller works in, or the status is not one of the two."),
            ...commonProblems("view"),
          },
        }),
        guard,
        requireGrant(MODULE, "view"),
        validate("query", VehicleTareListQuery),
        async (c) => {
          const { limit, cursor, projectId, plate, status } = c.req.valid("query")
          const principal = c.get("principal")
          if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
          const after = afterCursor(cursor)
          const rows = await c
            .get("tx")
            .select(tareColumns)
            .from(vehicleTare)
            .where(
              and(
                tareScope(principal),
                projectId === undefined ? undefined : eq(vehicleTare.projectId, projectId),
                plate === undefined ? undefined : eq(vehicleTare.plate, tareKeyOf(plate) ?? ""),
                status === undefined ? undefined : eq(vehicleTare.status, status),
                after === undefined ? undefined : gt(vehicleTare.id, after),
              ),
            )
            .orderBy(asc(vehicleTare.id))
            .limit(fetchLimit(limit))
          const page = pageOf(rows, limit)
          return c.json({ ...page, items: page.items.map(tareOf) })
        },
      )
      .post(
        "/vehicle-tares",
        describeRoute({
          operationId: "createVehicleTare",
          summary: "Register a tare",
          description:
            "Registers a vehicle's weight empty in a project the caller works in, by its plate and, where it is weighed with them, its trailer's plate and the container it carries — each stored as upper case letters and digits alone — with the day it was weighed and, optionally, the haulier it belongs to. A tare starts active, and one is active per plate, trailer and container. The server mints the id.",
          security: BEARER_SECURITY,
          responses: {
            201: describeCreated("The tare as it was written.", VehicleTare),
            400: describeProblem("The body is missing a field, holds a value of the wrong shape, names a member the server owns, a project the caller does not work in or a customer that is not the company's, or a plate with no letter or digit."),
            ...commonProblems("create"),
            409: describeProblem("An active tare is registered for the plate, trailer and container already."),
          },
        }),
        guard,
        requireGrant(MODULE, "create"),
        validate("json", VehicleTareCreate),
        async (c) => {
          const body = c.req.valid("json")
          const principal = c.get("principal")
          requireProject(principal, body.projectId)
          const keys = tareKeys(body)
          const tx = c.get("tx")
          await requireCustomer(tx, principal.companyId, body.customerId)
          const [row] = await refuseDuplicate({ vehicle_tare_active_key: TARE_TAKEN }, () =>
            tx
              .insert(vehicleTare)
              .values({
                id: newId(),
                companyId: principal.companyId,
                projectId: body.projectId,
                ...keys,
                tareKg: body.tareKg,
                weighedOn: body.weighedOn,
                customerId: body.customerId ?? null,
                label: body.label ?? null,
                status: "active",
              })
              .returning(tareColumns),
          )
          return created(c, "/vehicle-tares", tareOf(row!))
        },
      )
      .get(
        "/vehicle-tares/:id",
        describeRoute({
          operationId: "getVehicleTare",
          summary: "One registered tare",
          description: "One registered tare of the projects the caller works in.",
          security: BEARER_SECURITY,
          responses: {
            200: describeJson("The tare.", VehicleTare),
            400: describeProblem("The path does not hold an id."),
            ...commonProblems("view"),
            404: describeProblem("No registered tare with that id in the projects the caller works in."),
          },
        }),
        guard,
        requireGrant(MODULE, "view"),
        validate("param", IdParam),
        async (c) => {
          const { id } = c.req.valid("param")
          const row = await findTare(c.get("tx"), c.get("principal"), id)
          if (row === undefined) throw noSuchTare(id)
          return c.json(tareOf(row))
        },
      )
      .patch(
        "/vehicle-tares/:id",
        describeRoute({
          operationId: "patchVehicleTare",
          summary: "Re-weigh, re-own or retire a tare",
          description:
            "Changes the weight and the day it was weighed, the haulier, the label, or the status: `retired` keeps the tare for the tickets completed on it and finds it for no new one; `active` takes it back where no other tare of its plate, trailer and container is active. The plates and the container are what the tare is of: register another.",
          security: BEARER_SECURITY,
          responses: {
            200: describeJson("The tare as it now stands.", VehicleTare),
            400: describeProblem("The path does not hold an id, or the body changes nothing, holds a value of the wrong shape, names a member the server owns or a customer that is not the company's."),
            ...commonProblems("edit"),
            404: describeProblem("No registered tare with that id in the projects the caller works in."),
            409: describeProblem("Another tare of the plate, trailer and container is active."),
          },
        }),
        guard,
        requireGrant(MODULE, "edit"),
        validate("param", IdParam),
        validate("json", VehicleTarePatch),
        async (c) => {
          const { id } = c.req.valid("param")
          const patch = c.req.valid("json")
          const principal = c.get("principal")
          const tx = c.get("tx")
          await lockRow(tx, vehicleTare, { companyId: principal.companyId, id })
          if ((await findTare(tx, principal, id)) === undefined) throw noSuchTare(id)
          await requireCustomer(tx, principal.companyId, patch.customerId)
          const [row] = await refuseDuplicate({ vehicle_tare_active_key: TARE_TAKEN }, () =>
            tx
              .update(vehicleTare)
              .set(patch)
              .where(and(eq(vehicleTare.companyId, principal.companyId), eq(vehicleTare.id, id)))
              .returning(tareColumns),
          )
          return c.json(tareOf(row!))
        },
      )
      // --- The tickets ---
      .get(
        "/scale-tickets",
        describeRoute({
          operationId: "listScaleTickets",
          summary: "The scale house's tickets",
          description:
            "One page of the scale tickets in the projects the caller works in, oldest first (ids are time-ordered), each with its lines. `projectId`, `unloadingStationId`, `status`, `party` and `customerId` narrow the page. Hand `nextCursor` back as `cursor` for the next page.",
          security: BEARER_SECURITY,
          responses: {
            200: describeJson("One page of tickets.", TicketPage),
            400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, the project is not one the caller works in, or a filter holds a value of the wrong shape."),
            ...commonProblems("view"),
          },
        }),
        guard,
        requireGrant(MODULE, "view"),
        validate("query", ScaleTicketListQuery),
        async (c) => {
          const { limit, cursor, projectId, unloadingStationId, status, party, customerId } = c.req.valid("query")
          const principal = c.get("principal")
          if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
          const after = afterCursor(cursor)
          const tx = c.get("tx")
          const rows = await tx
            .select(ticketColumns)
            .from(scaleTicket)
            .where(
              and(
                ticketScope(principal),
                projectId === undefined ? undefined : eq(scaleTicket.projectId, projectId),
                unloadingStationId === undefined ? undefined : eq(scaleTicket.unloadingStationId, unloadingStationId),
                status === undefined ? undefined : eq(scaleTicket.status, status),
                party === undefined ? undefined : eq(scaleTicket.party, party),
                customerId === undefined ? undefined : eq(scaleTicket.customerId, customerId),
                after === undefined ? undefined : gt(scaleTicket.id, after),
              ),
            )
            .orderBy(asc(scaleTicket.id))
            .limit(fetchLimit(limit))
          const page = pageOf(rows, limit)
          return c.json({ ...page, items: await ticketsOf(tx, principal.companyId, page.items) })
        },
      )
      .post(
        "/scale-tickets",
        describeRoute({
          operationId: "createScaleTicket",
          summary: "Weigh a vehicle in",
          description:
            "The first pass over the scale: a ticket at its gross, at one of our own stations in use with a weighbridge, for an account customer under one of its agreements in the ticket's project, or a walk-in. `weighedInAt` is now where omitted, and no later than the clock. A plate that is one of the project's vehicles names it. The ticket opens numbered in the company's series (`ST-<n>`). The server mints the id.",
          security: BEARER_SECURITY,
          responses: {
            201: describeCreated("The ticket as it was written, open.", ScaleTicket),
            400: describeProblem(
              "The body is missing a field, holds a value of the wrong shape, names a member the server owns, a project the caller does not work in, a station that is not one of our own in use with a weighbridge, a customer that is not the company's, an agreement that is not this customer's in the project, a visitor on an account's ticket, or an instant ahead of the clock.",
            ),
            ...commonProblems("create"),
          },
        }),
        guard,
        requireGrant(MODULE, "create"),
        validate("json", ScaleTicketCreate),
        async (c) => {
          const body = c.req.valid("json")
          const principal = c.get("principal")
          requireProject(principal, body.projectId)
          const at = now()
          const weighedInAt = body.weighedInAt === undefined ? at : new Date(body.weighedInAt)
          requireNotAhead(weighedInAt, at, "weighedInAt")
          if (body.party === "account" && body.visitorName != null) throw invalidRequest("body", [{ path: "visitorName", message: ACCOUNT_HAS_NO_VISITOR }])
          const tx = c.get("tx")
          await requireSite(tx, principal.companyId, body.unloadingStationId)
          await requireCustomer(tx, principal.companyId, body.customerId)
          await requireAgreement(tx, { companyId: principal.companyId, projectId: body.projectId }, body.agreementId)
          if (body.agreementId != null) {
            const [held] = await tx
              .select({ customerId: agreement.customerId })
              .from(agreement)
              .where(and(eq(agreement.companyId, principal.companyId), eq(agreement.id, body.agreementId)))
            if (held?.customerId !== body.customerId) throw invalidRequest("body", [{ path: "agreementId", message: NOT_THE_CUSTOMERS_AGREEMENT }])
          }
          const truck = await vehicleOfPlate(tx, principal.companyId, body.projectId, body.vehiclePlate)
          const number = await nextNumber(tx, principal.companyId, "nextScaleTicketNumber")
          const [row] = await tx
            .insert(scaleTicket)
            .values({
              id: newId(),
              companyId: principal.companyId,
              projectId: body.projectId,
              number,
              unloadingStationId: body.unloadingStationId,
              vehiclePlate: body.vehiclePlate,
              trailerPlate: body.trailerPlate ?? null,
              containerRef: body.containerRef ?? null,
              vehicleId: truck?.id ?? null,
              party: body.party,
              customerId: body.customerId ?? null,
              agreementId: body.agreementId ?? null,
              visitorName: body.visitorName ?? null,
              grossKg: body.grossKg,
              weighedInAt,
              status: "open",
              note: body.note ?? null,
              recordedBy: principal.user.id,
            })
            .returning(ticketColumns)
          return created(c, "/scale-tickets", ticketOf(row!, []))
        },
      )
      .get(
        "/scale-tickets/:id",
        describeRoute({
          operationId: "getScaleTicket",
          summary: "One scale ticket",
          description: "One scale ticket of the projects the caller works in, with its lines.",
          security: BEARER_SECURITY,
          responses: {
            200: describeJson("The ticket.", ScaleTicket),
            400: describeProblem("The path does not hold an id."),
            ...commonProblems("view"),
            404: describeProblem("No scale ticket with that id in the projects the caller works in."),
          },
        }),
        guard,
        requireGrant(MODULE, "view"),
        validate("param", IdParam),
        async (c) => {
          const { id } = c.req.valid("param")
          const principal = c.get("principal")
          const tx = c.get("tx")
          const row = await findTicket(tx, principal, id)
          if (row === undefined) throw noSuchTicket(id)
          const [answer] = await ticketsOf(tx, principal.companyId, [row])
          return c.json(answer!)
        },
      )
      .patch(
        "/scale-tickets/:id",
        describeRoute({
          operationId: "patchScaleTicket",
          summary: "Correct an open ticket's visitor or note",
          description: "Changes an open ticket's walk-in name or its note. What was weighed and for whom is what the ticket is: void it and weigh again.",
          security: BEARER_SECURITY,
          responses: {
            200: describeJson("The ticket as it now stands.", ScaleTicket),
            400: describeProblem("The path does not hold an id, or the body changes nothing, holds a value of the wrong shape, names a member the server owns, or names a visitor on an account's ticket."),
            ...commonProblems("edit"),
            404: describeProblem("No scale ticket with that id in the projects the caller works in."),
            409: describeProblem("The ticket is completed or voided."),
          },
        }),
        guard,
        requireGrant(MODULE, "edit"),
        validate("param", IdParam),
        validate("json", ScaleTicketPatch),
        async (c) => {
          const { id } = c.req.valid("param")
          const patch = c.req.valid("json")
          const principal = c.get("principal")
          const tx = c.get("tx")
          await lockRow(tx, scaleTicket, { companyId: principal.companyId, id })
          const ticket = await findTicket(tx, principal, id)
          if (ticket === undefined) throw noSuchTicket(id)
          if (ticket.status !== "open") throw problem(409, { detail: notOpen(ticket.number, ticket.status, "corrected") })
          if (ticket.party === "account" && patch.visitorName != null) throw invalidRequest("body", [{ path: "visitorName", message: ACCOUNT_HAS_NO_VISITOR }])
          const [row] = await tx
            .update(scaleTicket)
            .set(patch)
            .where(and(eq(scaleTicket.companyId, principal.companyId), eq(scaleTicket.id, id)))
            .returning(ticketColumns)
          return c.json(ticketOf(row!, []))
        },
      )
      .post(
        "/scale-tickets/:id/complete",
        describeRoute({
          operationId: "completeScaleTicket",
          summary: "Weigh a vehicle out",
          description:
            "Completes an open ticket at its tare — a second pass (`weighed`), or the active tare registered for its plate, trailer and container (`registered`) — with the load split into lines of fractions the station takes, each fraction and origin once, summing to the net. `weighedOutAt` is now where omitted, after the first pass and no later than the clock. One of our own vehicles' ticket is one line, and is matched to the route the vehicle ran as a weighbridge's ticket is: matched, it is written as that route's Unload (`source = integration`) and `unload-recorded` is emitted; unmatched, it keeps why.",
          security: BEARER_SECURITY,
          responses: {
            200: describeJson("The ticket as it now stands, completed with its lines.", ScaleTicket),
            400: describeProblem(
              "The path does not hold an id, or the body is missing a field, holds a value of the wrong shape, names a member the server owns, a tare not under the gross, a second pass before the first or ahead of the clock, a fraction that is not the company's or that the station does not take, lines that do not sum to the net, or several lines for one of our own vehicles.",
            ),
            ...commonProblems("edit"),
            404: describeProblem("No scale ticket with that id in the projects the caller works in."),
            409: describeProblem("The ticket is completed or voided, or no active tare is registered for its vehicle, or the registered tare is not under the gross."),
          },
        }),
        guard,
        requireGrant(MODULE, "edit"),
        validate("param", IdParam),
        validate("json", ScaleTicketComplete),
        async (c) => {
          const { id } = c.req.valid("param")
          const body = c.req.valid("json")
          const principal = c.get("principal")
          const tx = c.get("tx")
          await lockRow(tx, scaleTicket, { companyId: principal.companyId, id })
          const ticket = await findTicket(tx, principal, id)
          if (ticket === undefined) throw noSuchTicket(id)
          if (ticket.status !== "open") throw problem(409, { detail: notOpen(ticket.number, ticket.status, "completed") })

          // The body's fields, each at its own.
          const at = now()
          const weighedOutAt = body.weighedOutAt === undefined ? at : new Date(body.weighedOutAt)
          requireNotAhead(weighedOutAt, at, "weighedOutAt")
          if (weighedOutAt.getTime() < ticket.weighedInAt.getTime()) throw invalidRequest("body", [{ path: "weighedOutAt", message: OUT_BEFORE_IN }])
          if (body.tare.source === "weighed" && netOf(ticket.grossKg, body.tare.tareKg) === null) throw invalidRequest("body", [{ path: "tare.tareKg", message: tareNotUnder(ticket.grossKg) }])
          if (ticket.vehicleId !== null && body.lines.length > 1) throw invalidRequest("body", [{ path: "lines", message: OWN_LOAD_IS_ONE_FRACTION }])
          for (const [index, line] of body.lines.entries()) {
            const path = `lines.${index}.wasteFractionId`
            await requireWasteFraction(tx, principal.companyId, line.wasteFractionId, path)
            const takes = await stationTakes(tx, principal.companyId, ticket.unloadingStationId, line.wasteFractionId)
            if (!takes.takes) throw invalidRequest("body", [{ path, message: notTaken(takes) }])
          }
          // Each line's product, where it names one: the project's, sold by the tonne or the cubic metre, the volume exactly where the unit needs it (M16b of #293).
          const offered: (ProductStatus | undefined)[] = []
          for (const [index, line] of body.lines.entries()) {
            const at = (field: string) => `lines.${index}.${field}`
            if (line.productId == null) {
              if (line.volumeLitres != null) throw invalidRequest("body", [{ path: at("volumeLitres"), message: VOLUME_ONLY_BY_THE_CUBIC_METRE }])
              continue
            }
            offered.push(await requireProduct(tx, { companyId: principal.companyId, projectId: ticket.projectId }, line.productId, at("productId")))
            const [sold] = await tx
              .select({ unit: product.unit })
              .from(product)
              .where(and(eq(product.companyId, principal.companyId), eq(product.id, line.productId)))
            const unit = sold!.unit as ProductUnit
            if (!soldAtTheWindow(unit)) throw invalidRequest("body", [{ path: at("productId"), message: NOT_SOLD_AT_THE_WINDOW }])
            if (unit === CUBIC_METRE_UNIT && line.volumeLitres == null) throw invalidRequest("body", [{ path: at("volumeLitres"), message: VOLUME_REQUIRED }])
            if (unit !== CUBIC_METRE_UNIT && line.volumeLitres != null) throw invalidRequest("body", [{ path: at("volumeLitres"), message: VOLUME_ONLY_BY_THE_CUBIC_METRE }])
          }

          // The tare the body asks for, then the net it makes.
          let tareKg: number
          let vehicleTareId: string | null = null
          if (body.tare.source === "weighed") {
            tareKg = body.tare.tareKg
          } else {
            const register = await tx
              .select({ id: vehicleTare.id, plate: vehicleTare.plate, trailerPlate: vehicleTare.trailerPlate, containerRef: vehicleTare.containerRef, tareKg: vehicleTare.tareKg })
              .from(vehicleTare)
              .where(and(eq(vehicleTare.companyId, principal.companyId), eq(vehicleTare.projectId, ticket.projectId), eq(vehicleTare.status, "active"), eq(vehicleTare.plate, tareKeyOf(ticket.vehiclePlate) ?? "")))
            const found = registeredTare(register, { plate: ticket.vehiclePlate, trailerPlate: ticket.trailerPlate, containerRef: ticket.containerRef })
            if (found === undefined) throw problem(409, { detail: noRegisteredTare(ticket.vehiclePlate) })
            if (netOf(ticket.grossKg, found.tareKg) === null) throw problem(409, { detail: registeredTareNotUnder(found.tareKg, ticket.grossKg) })
            tareKg = found.tareKg
            vehicleTareId = found.id
          }
          const netKg = netOf(ticket.grossKg, tareKg)!
          const lines = body.lines.map((line) => ({ wasteFractionId: line.wasteFractionId, originMunicipality: line.originMunicipality ?? null, netKg: line.netKg, productId: line.productId ?? null, volumeLitres: line.volumeLitres ?? null }))
          const issue = linesIssue(lines, netKg)
          if (issue !== null) {
            if (issue.kind === "sum") throw invalidRequest("body", [{ path: "lines", message: linesOffNet(issue.sum, issue.netKg) }])
            throw new Error(`the contract let through lines the rule refuses: ${issue.kind}`)
          }
          // Every 400 above, every 409 below (routes/statuses.ts): a product no longer offered is a new reference refused.
          for (const status of offered) refuseUnofferedProduct(status)

          // One of our own vehicles' load: matched to its route and written as its Unload, or kept with why not.
          let match: { routeId: string | null; unloadId: string | null; unmatchedReason: WeighbridgeUnmatchedReason | null } = { routeId: null, unloadId: null, unmatchedReason: null }
          if (ticket.vehicleId !== null) {
            const [held] = await tx
              .select({ timezone: project.timezone })
              .from(project)
              .where(and(eq(project.companyId, principal.companyId), eq(project.id, ticket.projectId)))
            const truck = { id: ticket.vehicleId, projectId: ticket.projectId, timezone: held!.timezone }
            const routes = await routesOf(tx, principal.companyId, truck, weighedOutAt)
            const decision = matchTicket({ vehicleId: truck.id, ...routes, wasteFractionId: lines[0]!.wasteFractionId, stationTakes: true })
            if (decision.kind === "matched") {
              const written = await writeUnload(tx, principal, {
                routeId: decision.routeId,
                wasteFractionId: decision.wasteFractionId,
                unloadingStationId: ticket.unloadingStationId,
                weighedAt: weighedOutAt,
                grossKg: ticket.grossKg,
                tareKg,
                netKg,
                ticketNumber: scaleTicketLabel(ticket.number),
              })
              match = { routeId: decision.routeId, unloadId: written.unloadId, unmatchedReason: null }
            } else {
              match = { routeId: null, unloadId: null, unmatchedReason: decision.reason }
            }
          }

          const [row] = await tx
            .update(scaleTicket)
            .set({ status: "completed", tareKg, tareSource: body.tare.source, vehicleTareId, weighedOutAt, netKg, ...match })
            .where(and(eq(scaleTicket.companyId, principal.companyId), eq(scaleTicket.id, id)))
            .returning(ticketColumns)
          const written = await tx
            .insert(scaleTicketLine)
            .values(lines.map((line, index) => ({ id: newId(), companyId: principal.companyId, projectId: ticket.projectId, ticketId: id, position: index + 1, ...line })))
            .returning(lineColumns)
          const answered = ticketOf(row!, written)
          // Finance's news, after the rows it describes: an account's lines are charged by its consumer.
          await emit(tx, principal, { aggregateId: id, kind: "scale-ticket-completed", payload: answered, projectId: ticket.projectId, occurredAt: weighedOutAt })
          return c.json(answered)
        },
      )
      .post(
        "/scale-tickets/:id/void",
        describeRoute({
          operationId: "voidScaleTicket",
          summary: "Void a ticket",
          description:
            "Voids an open or completed ticket with its reason — written in error, a duplicate, the visitor left before the second pass, or another the note says — and the instant and the account. A ticket is never deleted. One written as a route's Unload stands: weight control settles that Unload.",
          security: BEARER_SECURITY,
          responses: {
            200: describeJson("The ticket as it now stands, voided.", ScaleTicket),
            400: describeProblem("The path does not hold an id, or the body is missing the reason, holds a value of the wrong shape, names a member the server owns, or gives another reason with no note."),
            ...commonProblems("edit"),
            404: describeProblem("No scale ticket with that id in the projects the caller works in."),
            409: describeProblem("The ticket is voided already, or was written as a route's Unload."),
          },
        }),
        guard,
        requireGrant(MODULE, "edit"),
        validate("param", IdParam),
        validate("json", ScaleTicketVoid),
        async (c) => {
          const { id } = c.req.valid("param")
          const body = c.req.valid("json")
          const principal = c.get("principal")
          const tx = c.get("tx")
          await lockRow(tx, scaleTicket, { companyId: principal.companyId, id })
          const ticket = await findTicket(tx, principal, id)
          if (ticket === undefined) throw noSuchTicket(id)
          if (ticket.status === "voided") throw problem(409, { detail: `Ticket ${scaleTicketLabel(ticket.number)} is voided already` })
          if (ticket.routeId !== null) {
            const [ran] = await tx
              .select({ number: route.number })
              .from(route)
              .where(and(eq(route.companyId, principal.companyId), eq(route.id, ticket.routeId)))
            throw problem(409, { detail: writtenAsUnload(ticket.number, ran!.number) })
          }
          const [row] = await tx
            .update(scaleTicket)
            .set({ status: "voided", voidReason: body.reason, voidNote: body.note ?? null, voidedAt: now(), voidedBy: principal.user.id })
            .where(and(eq(scaleTicket.companyId, principal.companyId), eq(scaleTicket.id, id)))
            .returning(ticketColumns)
          const [answer] = await ticketsOf(tx, principal.companyId, [row!])
          // A completed ticket's charges are Finance's to undo; an open one was never charged.
          if (ticket.status === "completed") await emit(tx, principal, { aggregateId: id, kind: "scale-ticket-voided", payload: answer!, projectId: ticket.projectId, occurredAt: now() })
          return c.json(answer!)
        },
      )
      .get(
        "/scale-tickets/:id/amount-due",
        describeRoute({
          operationId: "getScaleTicketAmountDue",
          summary: "What a ticket comes to at the window",
          description:
            "Each line of a completed ticket priced as Finance would price it on its weighed-out day: an account's under its agreement, a walk-in's under the project's default list with no customer — the line's product per tonne or per cubic metre, the quantity tier its measure meets, the rate times its kilograms or litres — or the reason it has none (`no-product`, `no-price-list`, `no-price-row`, `no-vat-rate`, `agreement-draft`, `amount-too-large`); with the net, the VAT and the total of the priced lines, and whether every line was. It stores nothing and takes no payment. An open or voided ticket comes to nothing yet (409).",
          security: BEARER_SECURITY,
          responses: {
            200: describeJson("What the ticket comes to.", ScaleTicketAmountDue),
            400: describeProblem("The path does not hold an id."),
            ...commonProblems("view"),
            404: describeProblem("No scale ticket with that id in the projects the caller works in."),
            409: describeProblem("The ticket is open or voided."),
          },
        }),
        guard,
        requireGrant(MODULE, "view"),
        validate("param", IdParam),
        async (c) => {
          const { id } = c.req.valid("param")
          const principal = c.get("principal")
          const tx = c.get("tx")
          const ticket = await findTicket(tx, principal, id)
          if (ticket === undefined) throw noSuchTicket(id)
          if (ticket.status !== "completed" || ticket.weighedOutAt === null) throw problem(409, { detail: `Ticket ${scaleTicketLabel(ticket.number)} is ${ticket.status}; only a completed ticket comes to an amount` })
          const scope = { companyId: principal.companyId, projectId: ticket.projectId }
          const serviceDate = dayInTimezone(ticket.weighedOutAt, await projectTimezone(tx, principal.companyId, ticket.projectId))
          const lines: AmountDueLine[] = []
          let currency: string | null = null
          for (const line of await windowLinesOf(tx, principal.companyId, id)) {
            const outcome = await priceWindowLine(tx, scope, { serviceDate, agreementId: ticket.agreementId, line })
            currency = outcome.price?.currency ?? currency
            lines.push({
              lineId: line.lineId,
              productId: line.product?.id ?? null,
              quantity: outcome.quantity,
              unitPriceMinor: outcome.price?.unitPriceMinor ?? null,
              netMinor: outcome.price?.netMinor ?? null,
              vatMinor: outcome.price?.vatMinor ?? null,
              blockReason: outcome.blockReason,
            })
          }
          const netMinor = lines.reduce((sum, line) => sum + (line.netMinor ?? 0), 0)
          const vatMinor = lines.reduce((sum, line) => sum + (line.vatMinor ?? 0), 0)
          const answer: ScaleTicketAmountDue = { ticketId: id, currency, lines, netMinor, vatMinor, totalMinor: netMinor + vatMinor, complete: lines.every((line) => line.blockReason === null) }
          return c.json(answer)
        },
      )
  )
}
