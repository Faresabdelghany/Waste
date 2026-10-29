// The delivery log (#291 C15): every message sent from a template, and the
// office's request to send one. `GET /messages` reads the log newest first,
// narrowed to a customer, a project or a status; `GET /messages/:id` reads
// one; `POST /messages` queues a template to a customer, or to one of its
// contact persons, through `queueMessage` (@waste/db/commands/messaging) —
// the row written `queued` with what was rendered and to whom, and the
// worker's `messaging.send` job sent in the same transaction. The worker
// judges the customer's consent at the send and moves the row to `sent`,
// `failed` or `withheld`; a client reads the row again to learn which.
//
// Every write a message makes is the worker's from here on, so the log has
// no patch and no delete. The grant is the customer's own module,
// `customers.contacts`: `view` to read the log, `create` to send. A
// message's template is one of the caller's projects', and so is the
// message, which takes its template's project.
import { Message, MessageCreate, MessageListQuery, type MessageChannel, type MessagePurpose, type MessageStatus } from "@waste/contracts/messaging"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { queueMessage, SEND_MESSAGE_QUEUE } from "@waste/db/commands/messaging"
import { QueueMissing, type JobSender } from "@waste/db/jobs"
import { customer } from "@waste/db/schema/customers"
import { message, messageTemplate } from "@waste/db/schema/messaging"
import { and, desc, eq, lt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { WORKER_QUEUE_MISSING } from "./generation"
import { created, describeCreated, describeJson, IdParam, instantOf, stampsOf } from "./shared"

const MODULE = "customers.contacts"
const MessagePage = Page(Message)

export const PICK_A_TEMPLATE = "Pick a message template of a project you work in"
export const PICK_A_CUSTOMER = "Pick a customer the company has"

const noSuchMessage = (id: string) => problem(404, { detail: `No message ${id} in the projects this account works in` })

const columns = {
  id: message.id,
  projectId: message.projectId,
  templateId: message.templateId,
  customerId: message.customerId,
  contactId: message.contactId,
  channel: message.channel,
  purpose: message.purpose,
  recipient: message.recipient,
  subject: message.subject,
  body: message.body,
  status: message.status,
  attempts: message.attempts,
  provider: message.provider,
  providerMessageId: message.providerMessageId,
  reason: message.reason,
  sentAt: message.sentAt,
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
}

type Row = Pick<typeof message.$inferSelect, keyof typeof columns>

const messageOf = (row: Row): Message => ({
  id: row.id,
  projectId: row.projectId,
  templateId: row.templateId,
  customerId: row.customerId,
  contactId: row.contactId,
  channel: row.channel as MessageChannel,
  purpose: row.purpose as MessagePurpose,
  recipient: row.recipient,
  subject: row.subject,
  body: row.body,
  status: row.status as MessageStatus,
  attempts: row.attempts,
  provider: row.provider,
  providerMessageId: row.providerMessageId,
  reason: row.reason,
  sentAt: instantOf(row.sentAt),
  ...stampsOf(row),
})

const scope = (principal: Principal) => and(eq(message.companyId, principal.companyId), inProjects(message.projectId, principal))

async function findMessage(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx.select(columns).from(message).where(and(scope(principal), eq(message.id, id))).limit(1)
  return row
}

export function messageRoutes(guard: MiddlewareHandler<AuthEnv>, { jobs }: { jobs: JobSender }) {
  return new Hono<AuthEnv>()
    .get(
      "/messages",
      describeRoute({
        operationId: "listMessages",
        summary: "The delivery log",
        description:
          "One page of the messages of the caller's projects, newest first, narrowed to a customer (`customerId`), a project (`projectId`) or a status (`status`). Each says what was rendered, the address it went to, and how its sending stands: `queued` for the worker, `sent`, `failed` past its attempts, or `withheld` because the customer allows no service messages.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of messages.", MessagePage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter will not do, or the project is not one the caller works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.contacts`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", MessageListQuery),
      async (c) => {
        const { limit, cursor, projectId, customerId, status } = c.req.valid("query")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const after = afterCursor(cursor)
        const rows = await c
          .get("tx")
          .select(columns)
          .from(message)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(message.projectId, projectId),
              customerId === undefined ? undefined : eq(message.customerId, customerId),
              status === undefined ? undefined : eq(message.status, status),
              after === undefined ? undefined : lt(message.id, after),
            ),
          )
          .orderBy(desc(message.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(messageOf), limit))
      },
    )
    .post(
      "/messages",
      describeRoute({
        operationId: "createMessage",
        summary: "Send a message from a template",
        description:
          "Queues a template to a customer, or to one of its active contact persons, on the template's channel: the address is the contact's where one is named and the customer's own otherwise, and the subject and body are rendered now and kept as sent. The message is answered `queued`; the worker sends it through the deployment's provider — a log-only sender until a card-free provider is verified — and judges the customer's consent to service messages at the send. Read it again to learn how it stands. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The message as it was queued.", Message),
          400: describeProblem("The body is missing a field, holds a value of the wrong shape or names one the server owns, or names a template outside the caller's projects, a customer the company does not have, or a contact person not the customer's."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `customers.contacts`."),
          409: describeProblem("The template is inactive, the contact person is inactive, or the recipient has no address on the template's channel."),
          503: describeProblem(`No worker has started on this database yet, so the send queue is not there (${JSON.stringify(WORKER_QUEUE_MISSING)}); nothing was written.`),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", MessageCreate),
      async (c) => {
        const tx = c.get("tx")
        const principal = c.get("principal")
        const body = c.req.valid("json")
        const [template] = await tx
          .select({ id: messageTemplate.id })
          .from(messageTemplate)
          .where(and(eq(messageTemplate.companyId, principal.companyId), inProjects(messageTemplate.projectId, principal), eq(messageTemplate.id, body.templateId)))
          .limit(1)
        if (template === undefined) throw invalidRequest("body", [{ path: "templateId", message: PICK_A_TEMPLATE }])
        const [holder] = await tx.select({ id: customer.id }).from(customer).where(and(eq(customer.companyId, principal.companyId), eq(customer.id, body.customerId))).limit(1)
        if (holder === undefined) throw invalidRequest("body", [{ path: "customerId", message: PICK_A_CUSTOMER }])
        let queued
        try {
          queued = await queueMessage(tx, jobs.send, { id: newId(), companyId: principal.companyId, templateId: body.templateId, customerId: body.customerId, contactId: body.contactId ?? null })
        } catch (error) {
          if (error instanceof QueueMissing && error.queue === SEND_MESSAGE_QUEUE) throw problem(503, { detail: WORKER_QUEUE_MISSING })
          throw error
        }
        const row = await findMessage(tx, principal, queued.id)
        if (row === undefined) throw noSuchMessage(queued.id)
        return created(c, "/messages", messageOf(row))
      },
    )
    .get(
      "/messages/:id",
      describeRoute({
        operationId: "getMessage",
        summary: "One message",
        description: "One message of the delivery log, in a project the caller works in, as its sending now stands.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The message.", Message),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.contacts`."),
          404: describeProblem("No message with that id in the projects the caller works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findMessage(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchMessage(id)
        return c.json(messageOf(row))
      },
    )
}
