// A company's Decommission Reasons (O30 of #290, row 9.6): why a container
// is scrapped, the company's own list under `configure.master` beside its
// contaminant codes, which `POST /containers/:id/decommission` names. Every
// company starts with eight (@waste/domain/resources/decommission-reasons);
// the office adds, renames and retires its own. A reason is retired by its
// status, never deleted: a decommission names the reason it was given, and a
// status gates a new decommission, never an existing one (@waste/domain/status-gates).
import { Page } from "@waste/contracts/pagination"
import { DecommissionReason, DecommissionReasonCreate, DecommissionReasonListQuery, DecommissionReasonPatch } from "@waste/contracts/stock"
import { decommissionReason } from "@waste/db/schema/stock"
import { and, eq } from "drizzle-orm"
import { newId } from "@waste/db/ids"
import { refuseDuplicate } from "@waste/db/commands/shared"
import { stampsOf } from "@waste/db/shapes/times"
import type { RouteDeps } from "../deps"
import { created, describeCreated, describeJson, IdParam, routes } from "../operation"
import { pageAt } from "../pagination"
import { describeProblem } from "../problem"
import { scoped } from "../scoped"

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

const reasonOf = (row: Row): DecommissionReason => ({ id: row.id, code: row.code, name: row.name, status: row.status, ...stampsOf(row) })

/** `unique (company_id, code)` and `unique (company_id, name)`: each is one reason's inside a company. */
const CODE_TAKEN = "decommission_reason_code_key"
const NAME_TAKEN = "decommission_reason_name_key"
const codeTaken = (code: string) => `This company already has a decommission reason ${JSON.stringify(code)}`
const nameTaken = (name: string) => `This company already has a decommission reason called ${JSON.stringify(name)}`

const { noSuch: noSuchReason, get: getReason, list: listReasons } = scoped(decommissionReason, { noun: "decommission reason", reach: "company", columns })

export function decommissionReasonRoutes(deps: RouteDeps) {
  return routes(deps)
    .get(
      "/decommission-reasons",
      {
        operationId: "listDecommissionReasons",
        summary: "The company's decommission reasons",
        description:
          "One page of the reasons the company scraps a container for, oldest first (ids are time-ordered). `status` narrows the page to the active or the retired. Hand `nextCursor` back as `cursor` for the next page.",
        module: MODULE,
        action: "view",
        query: DecommissionReasonListQuery,
        invalid: ["the status is not one of the two"],
        responses: {
          200: describeJson("One page of decommission reasons.", DecommissionReasonPage),
        },
      },
      async (c) => {
        const { limit, cursor, status } = c.req.valid("query")
        const at = pageAt({ cursor, limit })
        const page = await listReasons(c.get("tx"), c.get("principal"), at, status === undefined ? undefined : eq(decommissionReason.status, status))
        return c.json({ ...page, items: page.items.map(reasonOf) })
      },
    )
    .post(
      "/decommission-reasons",
      {
        operationId: "createDecommissionReason",
        summary: "Add a decommission reason",
        description:
          "Adds a reason to the company's own list. `code` is the stable slug a report quotes, set once and lowercase; `name` is what a person reads; both are unique inside the company. `status` is `active` unless said. The server mints the id.",
        module: MODULE,
        action: "create",
        body: DecommissionReasonCreate,
        invalid: ["the body is missing a field, holds a value of the wrong shape, or names a member the server owns"],
        responses: {
          201: describeCreated("The decommission reason as it was written.", DecommissionReason),
          409: describeProblem("The company already has a decommission reason with that code, or with that name."),
        },
      },
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
      {
        operationId: "getDecommissionReason",
        summary: "One decommission reason",
        description: "One reason of the caller's company. Another company's reason is a reason that does not exist here.",
        module: MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The decommission reason.", DecommissionReason),
          404: describeProblem("No decommission reason with that id in this company."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await getReason(c.get("tx"), c.get("principal"), id)
        return c.json(reasonOf(row))
      },
    )
    .patch(
      "/decommission-reasons/:id",
      {
        operationId: "patchDecommissionReason",
        summary: "Rename or retire a decommission reason",
        description:
          "Changes the name a person reads, or the status: `inactive` retires the reason from new decommissions while every decommission given it keeps it, and `active` offers it again. The code is not patchable: it is the slug a report quotes, and a reason that needs another one is another reason.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: DecommissionReasonPatch,
        invalid: ["the patch is empty or names a field the caller does not own, the code included"],
        responses: {
          200: describeJson("The decommission reason as it now stands.", DecommissionReason),
          404: describeProblem("No decommission reason with that id in this company."),
          409: describeProblem("The company already has another decommission reason with that name."),
        },
      },
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
