// A company's Decommission Reasons (O30 of #290, row 9.6): why a container
// is scrapped, the company's own list under `configure.master` beside its
// contaminant codes, which `POST /containers/:id/decommission` names. Every
// company starts with eight (@waste/domain/resources/decommission-reasons);
// the office adds, renames and retires its own. A reason is retired by its
// status, never deleted: a decommission names the reason it was given, and a
// status gates a new decommission, never an existing one (routes/statuses.ts).
import { Page } from "@waste/contracts/pagination"
import { DecommissionReason, DecommissionReasonCreate, DecommissionReasonListQuery, DecommissionReasonPatch, type DecommissionReasonStatus } from "@waste/contracts/stock"
import type { Tx } from "@waste/db/client"
import { decommissionReason } from "@waste/db/schema/stock"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { created, describeCreated, describeJson, IdParam, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "configure.master"

const DecommissionReasonPage = Page(DecommissionReason)

const columns = {
  id: decommissionReason.id,
  code: decommissionReason.code,
  name: decommissionReason.name,
  status: decommissionReason.status,
  createdAt: decommissionReason.createdAt,
  updatedAt: decommissionReason.updatedAt,
}

type Row = Pick<typeof decommissionReason.$inferSelect, keyof typeof columns>

const reasonOf = (row: Row): DecommissionReason => ({ id: row.id, code: row.code, name: row.name, status: row.status as DecommissionReasonStatus, ...stampsOf(row) })

/** `unique (company_id, code)` and `unique (company_id, name)`: each is one reason's inside a company. */
const CODE_TAKEN = "decommission_reason_code_key"
const NAME_TAKEN = "decommission_reason_name_key"
const codeTaken = (code: string) => `This company already has a decommission reason ${JSON.stringify(code)}`
const nameTaken = (name: string) => `This company already has a decommission reason called ${JSON.stringify(name)}`

const noSuchReason = (id: string) => problem(404, { detail: `No decommission reason ${id} in this company` })

async function findReason(tx: Tx, companyId: string, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(decommissionReason)
    .where(and(eq(decommissionReason.companyId, companyId), eq(decommissionReason.id, id)))
    .limit(1)
  return row
}

const commonProblems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

export function decommissionReasonRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/decommission-reasons",
      describeRoute({
        operationId: "listDecommissionReasons",
        summary: "The company's decommission reasons",
        description:
          "One page of the reasons the company scraps a container for, oldest first (ids are time-ordered). `status` narrows the page to the active or the retired. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of decommission reasons.", DecommissionReasonPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, or the status is not one of the two."),
          ...commonProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", DecommissionReasonListQuery),
      async (c) => {
        const { limit, cursor, status } = c.req.valid("query")
        const after = afterCursor(cursor)
        const { companyId } = c.get("principal")
        const rows = await c
          .get("tx")
          .select(columns)
          .from(decommissionReason)
          .where(and(eq(decommissionReason.companyId, companyId), status === undefined ? undefined : eq(decommissionReason.status, status), after === undefined ? undefined : gt(decommissionReason.id, after)))
          .orderBy(asc(decommissionReason.id))
          .limit(fetchLimit(limit))
        const page = pageOf(rows, limit)
        return c.json({ ...page, items: page.items.map(reasonOf) })
      },
    )
    .post(
      "/decommission-reasons",
      describeRoute({
        operationId: "createDecommissionReason",
        summary: "Add a decommission reason",
        description:
          "Adds a reason to the company's own list. `code` is the stable slug a report quotes, set once and lowercase; `name` is what a person reads; both are unique inside the company. `status` is `active` unless said. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The decommission reason as it was written.", DecommissionReason),
          400: describeProblem("The body is missing a field, holds a value of the wrong shape, or names a member the server owns."),
          ...commonProblems("create"),
          409: describeProblem("The company already has a decommission reason with that code, or with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", DecommissionReasonCreate),
      async (c) => {
        const values = c.req.valid("json")
        const { companyId } = c.get("principal")
        const [row] = await refuseDuplicate({ [CODE_TAKEN]: codeTaken(values.code), [NAME_TAKEN]: nameTaken(values.name) }, () =>
          c
            .get("tx")
            .insert(decommissionReason)
            .values({ ...values, id: newId(), companyId })
            .returning(columns),
        )
        return created(c, "/decommission-reasons", reasonOf(row))
      },
    )
    .get(
      "/decommission-reasons/:id",
      describeRoute({
        operationId: "getDecommissionReason",
        summary: "One decommission reason",
        description: "One reason of the caller's company. Another company's reason is a reason that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The decommission reason.", DecommissionReason),
          400: describeProblem("The path does not hold an id."),
          ...commonProblems("view"),
          404: describeProblem("No decommission reason with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findReason(c.get("tx"), c.get("principal").companyId, id)
        if (row === undefined) throw noSuchReason(id)
        return c.json(reasonOf(row))
      },
    )
    .patch(
      "/decommission-reasons/:id",
      describeRoute({
        operationId: "patchDecommissionReason",
        summary: "Rename or retire a decommission reason",
        description:
          "Changes the name a person reads, or the status: `inactive` retires the reason from new decommissions while every decommission given it keeps it, and `active` offers it again. The code is not patchable: it is the slug a report quotes, and a reason that needs another one is another reason.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The decommission reason as it now stands.", DecommissionReason),
          400: describeProblem("The path does not hold an id, or the patch is empty or names a field the caller does not own, the code included."),
          ...commonProblems("edit"),
          404: describeProblem("No decommission reason with that id in this company."),
          409: describeProblem("The company already has another decommission reason with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", DecommissionReasonPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const { companyId } = c.get("principal")
        const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
        const [row] = await refuseDuplicate(sentences, () =>
          c
            .get("tx")
            .update(decommissionReason)
            .set(patch)
            .where(and(eq(decommissionReason.companyId, companyId), eq(decommissionReason.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchReason(id)
        return c.json(reasonOf(row))
      },
    )
}
