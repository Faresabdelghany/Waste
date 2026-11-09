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
//
// The log is the customers': a staff notice (O16 of #290), the same table's
// row to one of the company's own user accounts, is left out of both reads
// here and read by its recipient alone, at `GET /me/notices`
// (routes/notifications.ts).
import { Message, MessageCreate, MessageListQuery } from "@waste/contracts/messaging"
import { Page } from "@waste/contracts/pagination"
import { queueMessage } from "@waste/db/commands/messaging"
import { customer } from "@waste/db/schema/customers"
import { message, messageTemplate } from "@waste/db/schema/messaging"
import { Refused } from "@waste/domain/refusal"
import { and, eq, isNotNull } from "drizzle-orm"
import { newId } from "@waste/db/ids"
import { instantOf, stampsOf } from "@waste/db/shapes/times"
import { inProjects, requireProject } from "../auth/projects"
import type { RouteDeps } from "../deps"
import { created, describeCreated, describeJson, IdParam, routes } from "../operation"
import { mapPage, pageAt } from "../pagination"
import { describeProblem, invalidRequest, WORKER_QUEUE_MISSING } from "../problem"
import { scoped } from "../scoped"

const MODULE = "customers.contacts"
const MessagePage = Page(Message)

export const PICK_A_TEMPLATE = "Pick a message template of a project you work in"
export const PICK_A_CUSTOMER = "Pick a customer the company has"

export const messageColumns = {
  id: message.id,
  projectId: message.projectId,
  templateId: message.templateId,
  customerId: message.customerId,
  contactId: message.contactId,
  userAccountId: message.userAccountId,
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

type Row = Pick<typeof message.$inferSelect, keyof typeof messageColumns>

export const messageOf = (row: Row): Message => ({
  id: row.id,
  projectId: row.projectId,
  templateId: row.templateId,
  customerId: row.customerId,
  contactId: row.contactId,
  userAccountId: row.userAccountId,
  channel: row.channel,
  purpose: row.purpose,
  recipient: row.recipient,
  subject: row.subject,
  body: row.body,
  status: row.status,
  attempts: row.attempts,
  provider: row.provider,
  providerMessageId: row.providerMessageId,
  reason: row.reason,
  sentAt: instantOf(row.sentAt),
  ...stampsOf(row),
})

const { get: getMessage, list: listMessages } = scoped(message, { noun: "message", reach: "projects", columns: messageColumns, also: isNotNull(message.customerId), order: "desc" })

export function messageRoutes(deps: RouteDeps) {
  const { jobs } = deps
  return routes(deps)
    .get(
      "/messages",
      {
        operationId: "listMessages",
        summary: "The delivery log",
        description:
          "One page of the customers' messages of the caller's projects, newest first (a staff notice is its recipient's, at `GET /me/notices`), narrowed to a customer (`customerId`), a project (`projectId`) or a status (`status`). Each says what was rendered, the address it went to, and how its sending stands: `queued` for the worker, `sent`, `failed` past its attempts, or `withheld` because the customer allows no service messages.",
        module: MODULE,
        action: "view",
        query: MessageListQuery,
        invalid: ["a filter will not do", "the project is not one the caller works in"],
        responses: {
          200: describeJson("One page of messages.", MessagePage),
        },
      },
      async (c) => {
        const { limit, cursor, projectId, customerId, status } = c.req.valid("query")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const at = pageAt({ cursor, limit })
        const page = await listMessages(c.get("tx"), principal, at, projectId === undefined ? undefined : eq(message.projectId, projectId), customerId === undefined ? undefined : eq(message.customerId, customerId), status === undefined ? undefined : eq(message.status, status))
        return c.json(mapPage(page, messageOf))
      },
    )
    .post(
      "/messages",
      {
        operationId: "createMessage",
        summary: "Send a message from a template",
        description:
          "Queues a template to a customer, or to one of its active contact persons, on the template's channel: the address is the contact's where one is named and the customer's own otherwise, and the subject and body are rendered now and kept as sent. The message is answered `queued`; the worker sends it through the deployment's provider — a log-only sender until a card-free provider is verified — and judges the customer's consent to service messages at the send. Read it again to learn how it stands. The server mints the id.",
        module: MODULE,
        action: "create",
        body: MessageCreate,
        invalid: ["the body is missing a field, holds a value of the wrong shape or names one the server owns, or names a template outside the caller's projects, a customer the company does not have, or a contact person not the customer's"],
        responses: {
          201: describeCreated("The message as it was queued.", Message),
          409: describeProblem("The template is inactive, the contact person is inactive, or the recipient has no address on the template's channel."),
          503: describeProblem(`No worker has started on this database yet, so the send queue is not there (${JSON.stringify(WORKER_QUEUE_MISSING)}); nothing was written.`),
        },
      },
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
        const queued = await queueMessage(tx, jobs.send, { id: newId(), companyId: principal.companyId, templateId: body.templateId, customerId: body.customerId, contactId: body.contactId ?? null })
        if (queued.kind === "refused") throw new Refused(queued.refusal)
        const row = await getMessage(tx, principal, queued.message.id)
        return created(c, "/messages", messageOf(row))
      },
    )
    .get(
      "/messages/:id",
      {
        operationId: "getMessage",
        summary: "One message",
        description: "One customer's message of the delivery log, in a project the caller works in, as its sending now stands; a staff notice is its recipient's, at `GET /me/notices`.",
        module: MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The message.", Message),
          404: describeProblem("No message with that id in the projects the caller works in."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await getMessage(c.get("tx"), c.get("principal"), id)
        return c.json(messageOf(row))
      },
    )
}
