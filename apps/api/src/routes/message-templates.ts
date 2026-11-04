// A project's message templates (#291 C15): what the office sends, written in
// Settings › Message templates. `GET /message-templates` lists them across
// the caller's projects (or one, `?projectId=`), `POST` writes one, and
// `GET`/`PATCH /message-templates/:id` read and change one. There is no
// delete: a template a message was rendered from is kept, and `inactive` is
// what "retire it" means. A name is one template's in its project.
//
// The contracts hold a create to its channel's shape and every text to the
// placeholders a message fills; a patch is judged here as the template will
// stand, since a channel moved alone changes what the subject must be (the
// table's check is the backstop). The grant is `configure.templates`, Tickets
// & communication's module, which the Ticket SLA is configured under too.
import { MessageTemplate, MessageTemplateCreate, MessageTemplateListQuery, MessageTemplatePatch, type MessageChannel, type MessageTemplatePurpose, type MessageTemplateStatus } from "@waste/contracts/messaging"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { messageTemplate } from "@waste/db/schema/messaging"
import { channelShapeIssue } from "@waste/domain/messaging/template"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseDuplicate, stampsOf, strengthFor } from "./shared"

const MODULE = "configure.templates"
const TemplatePage = Page(MessageTemplate)

/** `UNIQUE (company_id, project_id, name)`. */
const NAME_TAKEN = "message_template_project_id_name_key"
export const nameTaken = (name: string) => `This project already has a message template named ${name}`

const noSuchTemplate = (id: string) => problem(404, { detail: `No message template ${id} in the projects this account works in` })

const columns = {
  id: messageTemplate.id,
  projectId: messageTemplate.projectId,
  name: messageTemplate.name,
  purpose: messageTemplate.purpose,
  channel: messageTemplate.channel,
  subject: messageTemplate.subject,
  body: messageTemplate.body,
  status: messageTemplate.status,
  createdAt: messageTemplate.createdAt,
  updatedAt: messageTemplate.updatedAt,
}

type Row = Pick<typeof messageTemplate.$inferSelect, keyof typeof columns>

const templateOf = (row: Row): MessageTemplate => ({
  id: row.id,
  projectId: row.projectId,
  name: row.name,
  purpose: row.purpose as MessageTemplatePurpose,
  channel: row.channel as MessageChannel,
  subject: row.subject,
  body: row.body,
  status: row.status as MessageTemplateStatus,
  ...stampsOf(row),
})

const scope = (principal: Principal) => and(eq(messageTemplate.companyId, principal.companyId), inProjects(messageTemplate.projectId, principal))

async function findTemplate(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx.select(columns).from(messageTemplate).where(and(scope(principal), eq(messageTemplate.id, id))).limit(1)
  return row
}

export function messageTemplateRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/message-templates",
      describeRoute({
        operationId: "listMessageTemplates",
        summary: "The message templates",
        description: "One page of the message templates of the caller's projects, or of one (`projectId`), oldest first, active and inactive alike.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of message templates.", TemplatePage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, or the project is not one the caller works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.templates`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", MessageTemplateListQuery),
      async (c) => {
        const { limit, cursor, projectId } = c.req.valid("query")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const after = afterCursor(cursor)
        const rows = await c
          .get("tx")
          .select(columns)
          .from(messageTemplate)
          .where(and(scope(principal), projectId === undefined ? undefined : eq(messageTemplate.projectId, projectId), after === undefined ? undefined : gt(messageTemplate.id, after)))
          .orderBy(asc(messageTemplate.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(templateOf), limit))
      },
    )
    .post(
      "/message-templates",
      describeRoute({
        operationId: "createMessageTemplate",
        summary: "Write a message template",
        description:
          "Writes a template in a project the caller works in: its name, one template's in the project; what it is for (`service`, which the customer's consent governs, or `billing`, which it does not); its channel; a subject for an e-mail and none for a text message; and its body. A text names its values as `{{recipientName}}`, `{{customerName}}` and `{{companyName}}`, and any other placeholder is refused. Active unless the body says otherwise. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The template as it was written.", MessageTemplate),
          400: describeProblem("The body is missing a field, breaks its channel's shape, names a placeholder no message fills, holds a value of the wrong shape, names one the server owns, or names a project the caller does not work in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `configure.templates`."),
          409: describeProblem("The project already has a template of that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", MessageTemplateCreate),
      async (c) => {
        const principal = c.get("principal")
        const values = c.req.valid("json")
        requireProject(principal, values.projectId)
        const [row] = await refuseDuplicate({ [NAME_TAKEN]: nameTaken(values.name) }, () =>
          c
            .get("tx")
            .insert(messageTemplate)
            .values({ ...values, subject: values.subject ?? null, id: newId(), companyId: principal.companyId })
            .returning(columns),
        )
        return created(c, "/message-templates", templateOf(row))
      },
    )
    .get(
      "/message-templates/:id",
      describeRoute({
        operationId: "getMessageTemplate",
        summary: "One message template",
        description: "One message template of a project the caller works in.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The template.", MessageTemplate),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.templates`."),
          404: describeProblem("No template with that id in the projects the caller works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findTemplate(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchTemplate(id)
        return c.json(templateOf(row))
      },
    )
    .patch(
      "/message-templates/:id",
      describeRoute({
        operationId: "patchMessageTemplate",
        summary: "Change a message template",
        description:
          "Changes one template; every field is optional and at least one must be given, and the project is the template's for good. The template as it will stand is held to its channel's shape: a channel moved to e-mail needs a subject, and one moved to text messages a null subject. A message already queued keeps the text it was rendered with.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The template as it now stands.", MessageTemplate),
          400: describeProblem("The path does not hold an id, or the patch is empty, would break the channel's shape, names a placeholder no message fills, names a field the caller does not own, or holds a value of the wrong shape."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.templates`."),
          404: describeProblem("No template with that id in the projects the caller works in."),
          409: describeProblem("The project already has another template of that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", MessageTemplatePatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const patch = c.req.valid("json")
        if ((await findTemplate(tx, principal, id)) === undefined) throw noSuchTemplate(id)
        await lockRow(tx, messageTemplate, { companyId: principal.companyId, id }, strengthFor(messageTemplate, patch))
        const current = await findTemplate(tx, principal, id)
        if (current === undefined) throw noSuchTemplate(id)
        const issue = channelShapeIssue({
          channel: (patch.channel ?? current.channel) as MessageChannel,
          subject: patch.subject === undefined ? current.subject : patch.subject,
          body: patch.body ?? current.body,
        })
        if (issue !== undefined) throw invalidRequest("body", [issue])
        const [row] = await refuseDuplicate(patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }, () =>
          tx.update(messageTemplate).set(patch).where(and(scope(principal), eq(messageTemplate.id, id))).returning(columns),
        )
        return c.json(templateOf(row))
      },
    )
}
