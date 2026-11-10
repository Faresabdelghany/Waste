import { NOT_A_STATION } from "@waste/domain/execution/commands"
import { routeLabel, scaleTicketLabel } from "@waste/domain/numbering"
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
} from "@waste/contracts/scale-house"
import type { ProblemFieldError } from "@waste/contracts/problem"
import type { Tx } from "@waste/db/client"
import { notTaken, stationTakes, writeUnload } from "@waste/db/commands/unloads"
import { dayInTimezone } from "@waste/domain/clock"
import { projectTimezone } from "@waste/db/query/project-clock"
import { lockRow, nextNumber, refuseDuplicate } from "@waste/db/commands/shared"
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
import type { ProductStatus } from "@waste/domain/registry/vocabulary"
import { linesIssue, netOf, registeredTare, tareKeyOf } from "@waste/domain/scale-house/rules"
import { refuseUnofferedProduct } from "@waste/domain/registry/catalogue"
import { and, eq } from "drizzle-orm"
import { newId } from "@waste/db/ids"
import { emit } from "@waste/db/commands/outbox"
import { scaleLineColumns, scaleTicketColumns, scaleTicketOf, scaleTicketsOf } from "@waste/db/shapes/scale-tickets"
import { stampsOf } from "@waste/db/shapes/times"
import { requireProject } from "../auth/projects"
import type { RouteDeps } from "../deps"
import { created, describeCreated, describeJson, IdParam, routes } from "../operation"
import { pageAt } from "../pagination"
import { describeProblem, invalidRequest, problem } from "../problem"
import { scoped } from "../scoped"
import { requireAgreement, requireCustomer, requireProduct, requireWasteFraction } from "./references"
import { requireNotAhead } from "./shared"
import { routesOf } from "./weighbridge"

const MODULE = "operate.scale-house"

const TarePage = Page(VehicleTare)
const TicketPage = Page(ScaleTicket)

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
  status: row.status,
})

/** What a second active tare of one plate, trailer and container is told. */
export const TARE_TAKEN = "An active tare is registered for this plate, trailer and container already: re-weigh that one, or retire it first"

/** What a plate, a trailer's plate or a container's reference with nothing to key it by is told. */
export const NOTHING_TO_KEY = "Give letters or digits: the register keys a plate by them alone"

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

const { get: getTare, list: listTares } = scoped(vehicleTare, { noun: "registered tare", reach: "projects", columns: tareColumns })

const { get: getTicket, locked: lockedTicket, list: listTickets } = scoped(scaleTicket, { noun: "scale ticket", reach: "projects", columns: scaleTicketColumns })

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

async function requireSite(tx: Tx, companyId: string, id: string): Promise<void> {
  const [row] = await tx
    .select({ ownership: unloadingStation.ownership, weighbridge: unloadingStation.weighbridge, status: unloadingStation.status })
    .from(unloadingStation)
    .where(and(eq(unloadingStation.companyId, companyId), eq(unloadingStation.id, id)))
    .limit(1)
  if (row === undefined) throw invalidRequest("body", [{ path: "unloadingStationId", message: NOT_A_STATION }])
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

export function scaleHouseRoutes(deps: RouteDeps) {
  const { now } = deps
  return (
    routes(deps)
      .get(
        "/vehicle-tares",
        {
          operationId: "listVehicleTares",
          summary: "The tare register",
          description:
            "One page of the registered tares in the projects the caller works in, oldest first (ids are time-ordered). `projectId`, `plate` (keyed as stored: upper case, letters and digits alone, however it is typed) and `status` narrow the page. Hand `nextCursor` back as `cursor` for the next page.",
          module: MODULE,
          action: "view",
          query: VehicleTareListQuery,
          invalid: ["the project is not one the caller works in", "the status is not one of the two"],
          responses: {
            200: describeJson("One page of registered tares.", TarePage),
          },
        },
        async (c) => {
          const { limit, cursor, projectId, plate, status } = c.req.valid("query")
          const principal = c.get("principal")
          if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
          const at = pageAt({ cursor, limit })
          const page = await listTares(c.get("tx"), principal, at, projectId === undefined ? undefined : eq(vehicleTare.projectId, projectId), plate === undefined ? undefined : eq(vehicleTare.plate, tareKeyOf(plate) ?? ""), status === undefined ? undefined : eq(vehicleTare.status, status))
          return c.json({ ...page, items: page.items.map(tareOf) })
        },
      )
      .post(
        "/vehicle-tares",
        {
          operationId: "createVehicleTare",
          summary: "Register a tare",
          description:
            "Registers a vehicle's weight empty in a project the caller works in, by its plate and, where it is weighed with them, its trailer's plate and the container it carries — each stored as upper case letters and digits alone — with the day it was weighed and, optionally, the haulier it belongs to. A tare starts active, and one is active per plate, trailer and container. The server mints the id.",
          module: MODULE,
          action: "create",
          body: VehicleTareCreate,
          invalid: ["the body is missing a field, holds a value of the wrong shape, names a member the server owns, a project the caller does not work in or a customer that is not the company's, or a plate with no letter or digit"],
          responses: {
            201: describeCreated("The tare as it was written.", VehicleTare),
            409: describeProblem("An active tare is registered for the plate, trailer and container already."),
          },
        },
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
        {
          operationId: "getVehicleTare",
          summary: "One registered tare",
          description: "One registered tare of the projects the caller works in.",
          module: MODULE,
          action: "view",
          params: IdParam,
          responses: {
            200: describeJson("The tare.", VehicleTare),
            404: describeProblem("No registered tare with that id in the projects the caller works in."),
          },
        },
        async (c) => {
          const { id } = c.req.valid("param")
          const row = await getTare(c.get("tx"), c.get("principal"), id)
          return c.json(tareOf(row))
        },
      )
      .patch(
        "/vehicle-tares/:id",
        {
          operationId: "patchVehicleTare",
          summary: "Re-weigh, re-own or retire a tare",
          description:
            "Changes the weight and the day it was weighed, the haulier, the label, or the status: `retired` keeps the tare for the tickets completed on it and finds it for no new one; `active` takes it back where no other tare of its plate, trailer and container is active. The plates and the container are what the tare is of: register another.",
          module: MODULE,
          action: "edit",
          params: IdParam,
          body: VehicleTarePatch,
          invalid: ["the body changes nothing, holds a value of the wrong shape, names a member the server owns or a customer that is not the company's"],
          responses: {
            200: describeJson("The tare as it now stands.", VehicleTare),
            404: describeProblem("No registered tare with that id in the projects the caller works in."),
            409: describeProblem("Another tare of the plate, trailer and container is active."),
          },
        },
        async (c) => {
          const { id } = c.req.valid("param")
          const patch = c.req.valid("json")
          const principal = c.get("principal")
          const tx = c.get("tx")
          await lockRow(tx, vehicleTare, { companyId: principal.companyId, id })
          await getTare(tx, principal, id)
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
      .get(
        "/scale-tickets",
        {
          operationId: "listScaleTickets",
          summary: "The scale house's tickets",
          description:
            "One page of the scale tickets in the projects the caller works in, oldest first (ids are time-ordered), each with its lines. `projectId`, `unloadingStationId`, `status`, `party` and `customerId` narrow the page. Hand `nextCursor` back as `cursor` for the next page.",
          module: MODULE,
          action: "view",
          query: ScaleTicketListQuery,
          invalid: ["the project is not one the caller works in", "a filter holds a value of the wrong shape"],
          responses: {
            200: describeJson("One page of tickets.", TicketPage),
          },
        },
        async (c) => {
          const { limit, cursor, projectId, unloadingStationId, status, party, customerId } = c.req.valid("query")
          const principal = c.get("principal")
          if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
          const at = pageAt({ cursor, limit })
          const tx = c.get("tx")
          const page = await listTickets(tx, principal, at, projectId === undefined ? undefined : eq(scaleTicket.projectId, projectId), unloadingStationId === undefined ? undefined : eq(scaleTicket.unloadingStationId, unloadingStationId), status === undefined ? undefined : eq(scaleTicket.status, status), party === undefined ? undefined : eq(scaleTicket.party, party), customerId === undefined ? undefined : eq(scaleTicket.customerId, customerId))
          return c.json({ ...page, items: await scaleTicketsOf(tx, principal.companyId, page.items) })
        },
      )
      .post(
        "/scale-tickets",
        {
          operationId: "createScaleTicket",
          summary: "Weigh a vehicle in",
          description:
            "The first pass over the scale: a ticket at its gross, at one of our own stations in use with a weighbridge, for an account customer under one of its agreements in the ticket's project, or a walk-in. `weighedInAt` is now where omitted, and no later than the clock. A plate that is one of the project's vehicles names it. The ticket opens numbered in the company's series (`ST-<n>`). The server mints the id.",
          module: MODULE,
          action: "create",
          body: ScaleTicketCreate,
          invalid: ["the body is missing a field, holds a value of the wrong shape, names a member the server owns, a project the caller does not work in, a station that is not one of our own in use with a weighbridge, a customer that is not the company's, an agreement that is not this customer's in the project, a visitor on an account's ticket, or an instant ahead of the clock"],
          responses: {
            201: describeCreated("The ticket as it was written, open.", ScaleTicket),
          },
        },
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
            .returning(scaleTicketColumns)
          return created(c, "/scale-tickets", scaleTicketOf(row!, []))
        },
      )
      .get(
        "/scale-tickets/:id",
        {
          operationId: "getScaleTicket",
          summary: "One scale ticket",
          description: "One scale ticket of the projects the caller works in, with its lines.",
          module: MODULE,
          action: "view",
          params: IdParam,
          responses: {
            200: describeJson("The ticket.", ScaleTicket),
            404: describeProblem("No scale ticket with that id in the projects the caller works in."),
          },
        },
        async (c) => {
          const { id } = c.req.valid("param")
          const principal = c.get("principal")
          const tx = c.get("tx")
          const row = await getTicket(tx, principal, id)
          const [answer] = await scaleTicketsOf(tx, principal.companyId, [row])
          return c.json(answer!)
        },
      )
      .patch(
        "/scale-tickets/:id",
        {
          operationId: "patchScaleTicket",
          summary: "Correct an open ticket's visitor or note",
          description: "Changes an open ticket's walk-in name or its note. What was weighed and for whom is what the ticket is: void it and weigh again.",
          module: MODULE,
          action: "edit",
          params: IdParam,
          body: ScaleTicketPatch,
          invalid: ["the body changes nothing, holds a value of the wrong shape, names a member the server owns, or names a visitor on an account's ticket"],
          responses: {
            200: describeJson("The ticket as it now stands.", ScaleTicket),
            404: describeProblem("No scale ticket with that id in the projects the caller works in."),
            409: describeProblem("The ticket is completed or voided."),
          },
        },
        async (c) => {
          const { id } = c.req.valid("param")
          const patch = c.req.valid("json")
          const principal = c.get("principal")
          const tx = c.get("tx")
          const ticket = await lockedTicket(tx, principal, id)
          if (ticket.status !== "open") throw problem(409, { detail: notOpen(ticket.number, ticket.status, "corrected") })
          if (ticket.party === "account" && patch.visitorName != null) throw invalidRequest("body", [{ path: "visitorName", message: ACCOUNT_HAS_NO_VISITOR }])
          const [row] = await tx
            .update(scaleTicket)
            .set(patch)
            .where(and(eq(scaleTicket.companyId, principal.companyId), eq(scaleTicket.id, id)))
            .returning(scaleTicketColumns)
          return c.json(scaleTicketOf(row!, []))
        },
      )
      .post(
        "/scale-tickets/:id/complete",
        {
          operationId: "completeScaleTicket",
          summary: "Weigh a vehicle out",
          description:
            "Completes an open ticket at its tare — a second pass (`weighed`), or the active tare registered for its plate, trailer and container (`registered`) — with the load split into lines of fractions the station takes, each fraction and origin once, summing to the net. `weighedOutAt` is now where omitted, after the first pass and no later than the clock. One of our own vehicles' ticket is one line, and is matched to the route the vehicle ran as a weighbridge's ticket is: matched, it is written as that route's Unload (`source = integration`) and `unload-recorded` is emitted; unmatched, it keeps why.",
          module: MODULE,
          action: "edit",
          params: IdParam,
          body: ScaleTicketComplete,
          invalid: ["the body is missing a field, holds a value of the wrong shape, names a member the server owns, a tare not under the gross, a second pass before the first or ahead of the clock, a fraction that is not the company's or that the station does not take, lines that do not sum to the net, or several lines for one of our own vehicles"],
          responses: {
            200: describeJson("The ticket as it now stands, completed with its lines.", ScaleTicket),
            404: describeProblem("No scale ticket with that id in the projects the caller works in."),
            409: describeProblem("The ticket is completed or voided, or no active tare is registered for its vehicle, or the registered tare is not under the gross."),
          },
        },
        async (c) => {
          const { id } = c.req.valid("param")
          const body = c.req.valid("json")
          const principal = c.get("principal")
          const tx = c.get("tx")
          const ticket = await lockedTicket(tx, principal, id)
          if (ticket.status !== "open") throw problem(409, { detail: notOpen(ticket.number, ticket.status, "completed") })

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
            const unit = sold!.unit
            if (!soldAtTheWindow(unit)) throw invalidRequest("body", [{ path: at("productId"), message: NOT_SOLD_AT_THE_WINDOW }])
            if (unit === CUBIC_METRE_UNIT && line.volumeLitres == null) throw invalidRequest("body", [{ path: at("volumeLitres"), message: VOLUME_REQUIRED }])
            if (unit !== CUBIC_METRE_UNIT && line.volumeLitres != null) throw invalidRequest("body", [{ path: at("volumeLitres"), message: VOLUME_ONLY_BY_THE_CUBIC_METRE }])
          }

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
          // Every 400 above, every 409 below (@waste/domain/status-gates): a product no longer offered is a new reference refused.
          for (const status of offered) refuseUnofferedProduct(status)

          let match: { routeId: string | null; unloadId: string | null; unmatchedReason: WeighbridgeUnmatchedReason | null } = { routeId: null, unloadId: null, unmatchedReason: null }
          if (ticket.vehicleId !== null) {
            const truck = { id: ticket.vehicleId, projectId: ticket.projectId, timezone: await projectTimezone(tx, principal.companyId, ticket.projectId) }
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
            .returning(scaleTicketColumns)
          const written = await tx
            .insert(scaleTicketLine)
            .values(lines.map((line, index) => ({ id: newId(), companyId: principal.companyId, projectId: ticket.projectId, ticketId: id, position: index + 1, ...line })))
            .returning(scaleLineColumns)
          const answered = scaleTicketOf(row!, written)
          // Finance's news, after the rows it describes: an account's lines are charged by its consumer.
          await emit(tx, principal, { aggregateId: id, kind: "scale-ticket-completed", payload: answered, projectId: ticket.projectId, occurredAt: weighedOutAt })
          return c.json(answered)
        },
      )
      .post(
        "/scale-tickets/:id/void",
        {
          operationId: "voidScaleTicket",
          summary: "Void a ticket",
          description:
            "Voids an open or completed ticket with its reason — written in error, a duplicate, the visitor left before the second pass, or another the note says — and the instant and the account. A ticket is never deleted. One written as a route's Unload stands: weight control settles that Unload.",
          module: MODULE,
          action: "edit",
          params: IdParam,
          body: ScaleTicketVoid,
          invalid: ["the body is missing the reason, holds a value of the wrong shape, names a member the server owns, or gives another reason with no note"],
          responses: {
            200: describeJson("The ticket as it now stands, voided.", ScaleTicket),
            404: describeProblem("No scale ticket with that id in the projects the caller works in."),
            409: describeProblem("The ticket is voided already, or was written as a route's Unload."),
          },
        },
        async (c) => {
          const { id } = c.req.valid("param")
          const body = c.req.valid("json")
          const principal = c.get("principal")
          const tx = c.get("tx")
          const ticket = await lockedTicket(tx, principal, id)
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
            .returning(scaleTicketColumns)
          const [answer] = await scaleTicketsOf(tx, principal.companyId, [row!])
          // A completed ticket's charges are Finance's to undo; an open one was never charged.
          if (ticket.status === "completed") await emit(tx, principal, { aggregateId: id, kind: "scale-ticket-voided", payload: answer!, projectId: ticket.projectId, occurredAt: now() })
          return c.json(answer!)
        },
      )
      .get(
        "/scale-tickets/:id/amount-due",
        {
          operationId: "getScaleTicketAmountDue",
          summary: "What a ticket comes to at the window",
          description:
            "Each line of a completed ticket priced as Finance would price it on its weighed-out day: an account's under its agreement, a walk-in's under the project's default list with no customer — the line's product per tonne or per cubic metre, the quantity tier its measure meets, the rate times its kilograms or litres — or the reason it has none (`no-product`, `no-price-list`, `no-price-row`, `no-vat-rate`, `agreement-draft`, `amount-too-large`); with the net, the VAT and the total of the priced lines, and whether every line was. It stores nothing and takes no payment. An open or voided ticket comes to nothing yet (409).",
          module: MODULE,
          action: "view",
          params: IdParam,
          responses: {
            200: describeJson("What the ticket comes to.", ScaleTicketAmountDue),
            404: describeProblem("No scale ticket with that id in the projects the caller works in."),
            409: describeProblem("The ticket is open or voided."),
          },
        },
        async (c) => {
          const { id } = c.req.valid("param")
          const principal = c.get("principal")
          const tx = c.get("tx")
          const ticket = await getTicket(tx, principal, id)
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
