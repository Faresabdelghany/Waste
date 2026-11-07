// Route Messages (O24 of #290): the office and the route's driver writing to
// each other about one route, the route's own thread. Two doors over one
// ledger (`route_message`, packages/db's schema/route-messages.ts):
//
// - the office's, `GET` and `POST /routes/:id/messages`, under
//   `route-studio.routes` (`view` to read, `edit` to write), fenced as every
//   route statement is: a route of another company or a project the caller
//   does not work in is the family's 404;
// - the driver's, `GET` and `POST /driver/routes/:id/messages`, under
//   `operate.driver-app`, fenced by the assignment (`findAssignedRoute`): a
//   route not planned for or started by the caller's driver profile is the
//   driver door's 404, so the device learns nothing of routes it was not
//   given. The driver's message takes the id their device minted, so a send
//   tried again over a lost answer is answered as the message already written
//   (200, the same row); an id another message holds is refused (409).
//
// A message is written once and never edited or taken back, an append to a
// ledger: 201 with the message and no `Location`, since a thread is read
// whole and a message has no read of its own. A thread reads oldest first,
// every message with the name beside it — the office's person's or the
// driver's — and is read whatever the route's status: a word after the
// route ended is a word too.
import { DriverRouteMessageCreate, RouteMessage, RouteMessageCreate, type RouteMessageAuthor } from "@waste/contracts/route-messages"
import type { Tx } from "@waste/db/client"
import { userAccount } from "@waste/db/schema/access"
import { driver } from "@waste/db/schema/fleet"
import { routeMessage } from "@waste/db/schema/route-messages"
import { and, asc, eq } from "drizzle-orm"
import { resolver } from "hono-openapi"
import * as z from "zod"
import { newId } from "@waste/db/ids"
import { replayed } from "@waste/db/commands/shared"
import type { RouteRow } from "@waste/db/shapes/routes"

import { resolveDriver } from "../auth/driver"
import type { Principal } from "../auth/principal"
import type { RouteDeps } from "../deps"
import { routes } from "../operation"
import { describeProblem, problem } from "../problem"
import { findAssignedRoute, findRoute, noSuchAssignedRoute, noSuchRoute } from "./execution-shapes"
import { describeJson, IdParam } from "./shared"

const OFFICE_MODULE = "route-studio.routes"
const DRIVER_MODULE = "operate.driver-app"
const RouteMessages = z.array(RouteMessage)

/** What a driver's send under an id another message holds is told. */
export const MESSAGE_ID_TAKEN = "That id names another message; mint a new one for a new message"

const columns = {
  id: routeMessage.id,
  projectId: routeMessage.projectId,
  routeId: routeMessage.routeId,
  author: routeMessage.author,
  sentBy: routeMessage.sentBy,
  driverId: routeMessage.driverId,
  body: routeMessage.body,
  recordedAt: routeMessage.recordedAt,
  personName: userAccount.fullName,
  driverName: driver.name,
}

type Row = { id: string; projectId: string; routeId: string; author: string; sentBy: string; driverId: string | null; body: string; recordedAt: Date; personName: string | null; driverName: string | null }

const messageOf = (row: Row): RouteMessage => ({
  id: row.id,
  projectId: row.projectId,
  routeId: row.routeId,
  author: row.author as RouteMessageAuthor,
  sentBy: row.sentBy,
  senderName: (row.author === "driver" ? row.driverName : row.personName) ?? "",
  driverId: row.driverId,
  body: row.body,
  recordedAt: row.recordedAt.toISOString(),
})

/** The messages with the names beside them; each read says which, always with the tenant. */
const selectMessages = (tx: Tx) =>
  tx
    .select(columns)
    .from(routeMessage)
    .leftJoin(userAccount, and(eq(userAccount.companyId, routeMessage.companyId), eq(userAccount.id, routeMessage.sentBy)))
    .leftJoin(driver, and(eq(driver.companyId, routeMessage.companyId), eq(driver.id, routeMessage.driverId)))
    .$dynamic()

/** A route's thread, oldest first: its index leads with the route and the id. */
async function threadOf(tx: Tx, companyId: string, routeId: string): Promise<RouteMessage[]> {
  const rows = await selectMessages(tx)
    .where(and(eq(routeMessage.companyId, companyId), eq(routeMessage.routeId, routeId)))
    .orderBy(asc(routeMessage.id))
  return rows.map(messageOf)
}

async function messageById(tx: Tx, companyId: string, id: string): Promise<RouteMessage | undefined> {
  const [row] = await selectMessages(tx)
    .where(and(eq(routeMessage.companyId, companyId), eq(routeMessage.id, id)))
    .limit(1)
  return row === undefined ? undefined : messageOf(row)
}

/** Appends one message to the route's thread and answers it as the thread reads it. */
async function append(tx: Tx, principal: Principal, route: RouteRow, message: { id: string; author: RouteMessageAuthor; driverId: string | null; body: string }): Promise<RouteMessage> {
  await tx.insert(routeMessage).values({ id: message.id, companyId: principal.companyId, projectId: route.projectId, routeId: route.id, author: message.author, sentBy: principal.user.id, driverId: message.driverId, body: message.body })
  const written = await messageById(tx, principal.companyId, message.id)
  if (written === undefined) throw new Error(`route message ${message.id} written and then not there`)
  return written
}

const describeAppended = (description: string) => ({ description, content: { "application/json": { schema: resolver(RouteMessage) } } })

export function routeMessageRoutes(deps: RouteDeps) {
  return routes(deps)
    .get(
      "/routes/:id/messages",
      {
        operationId: "listRouteMessages",
        summary: "A route's messages with its driver",
        description: "The route's thread, oldest first: every message the office and the route's driver wrote about it, each with its author, the account that sent it, the name the thread shows and when it was written. Read whatever the route's status.",
        module: OFFICE_MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The route's messages.", RouteMessages),
          404: describeProblem("No route with that id in the projects this account works in."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const route = await findRoute(tx, principal, id)
        if (route === undefined) throw noSuchRoute(id)
        return c.json(await threadOf(tx, principal.companyId, id))
      },
    )
    .post(
      "/routes/:id/messages",
      {
        operationId: "sendRouteMessage",
        summary: "Write to a route's driver",
        description: "Appends the office's message to the route's thread, which its driver reads on the route's screen. Plain text, trimmed, 1 to 1000 characters. A message is never edited or taken back. Answers 201 with the message and no `Location`: a thread is read whole. The server mints the id.",
        module: OFFICE_MODULE,
        action: "edit",
        params: IdParam,
        body: RouteMessageCreate,
        invalid: ["the body is empty, too long, or carries a member the command does not take"],
        responses: {
          201: describeAppended("The message as the thread reads it."),
          404: describeProblem("No route with that id in the projects this account works in."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const { body } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const route = await findRoute(tx, principal, id)
        if (route === undefined) throw noSuchRoute(id)
        return c.json(await append(tx, principal, route, { id: newId(), author: "office", driverId: null, body }), 201)
      },
    )
    .get(
      "/driver/routes/:id/messages",
      {
        operationId: "listDriverRouteMessages",
        summary: "The messages of one of the driver's routes",
        description: "The thread of a route assigned to the caller's driver profile, oldest first: what the office wrote and what the driver wrote. A route not assigned to this driver, of another company, or not there at all is answered the same way (404, `No route <id> assigned to this driver`).",
        module: DRIVER_MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The route's messages.", RouteMessages),
          403: describeProblem(`No active account here, the caller's role does not allow \`view\` on \`${DRIVER_MODULE}\`, or no active driver profile is bound to this login.`),
          404: describeProblem("No route with that id is assigned to this driver."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const profile = await resolveDriver(tx, principal)
        const route = await findAssignedRoute(tx, principal, profile, id)
        if (route === undefined) throw noSuchAssignedRoute(id)
        return c.json(await threadOf(tx, principal.companyId, id))
      },
    )
    .post(
      "/driver/routes/:id/messages",
      {
        operationId: "sendDriverRouteMessage",
        summary: "Write to the office about one of the driver's routes",
        description: `Appends the driver's message to the thread of a route assigned to them, under the id their device minted. Plain text, trimmed, 1 to 1000 characters. Sent again under the same id — an answer lost on the way — it answers 200 with the message already written and writes nothing; an id another message holds is refused (409, \`${MESSAGE_ID_TAKEN}\`). Answers 201 with the message and no \`Location\`.`,
        module: DRIVER_MODULE,
        action: "edit",
        params: IdParam,
        body: DriverRouteMessageCreate,
        invalid: ["the body has no id, an empty or too long body, or a member the command does not take"],
        responses: {
          200: describeJson("The message already written under that id.", RouteMessage),
          201: describeAppended("The message as the thread reads it."),
          403: describeProblem(`No active account here, the caller's role does not allow \`edit\` on \`${DRIVER_MODULE}\`, or no active driver profile is bound to this login.`),
          404: describeProblem("No route with that id is assigned to this driver."),
          409: describeProblem("The id names another message."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const profile = await resolveDriver(tx, principal)
        const route = await findAssignedRoute(tx, principal, profile, id)
        if (route === undefined) throw noSuchAssignedRoute(id)
        // The message already written under this id: this driver's on this route is the send tried again; any other is another message's id.
        const sameMessage = async () => {
          const written = await messageById(tx, principal.companyId, body.id)
          if (written === undefined) return undefined
          if (written.routeId !== id || written.driverId !== profile.id || written.body !== body.body) throw problem(409, { detail: MESSAGE_ID_TAKEN })
          return written
        }
        const before = await sameMessage()
        if (before !== undefined) return c.json(before, 200)
        // In a savepoint, so a send racing its own retry meets the key and reads the winner's row rather than aborting the request.
        const message = await replayed(["route_message_pkey"], () => tx.transaction((savepoint) => append(savepoint, principal, route, { id: body.id, author: "driver", driverId: profile.id, body: body.body })), sameMessage, async () => {
          // Another company's message holds it: the id is taken, whoever's it is.
          throw problem(409, { detail: MESSAGE_ID_TAKEN })
        })
        return c.json(message, 201)
      },
    )
}
