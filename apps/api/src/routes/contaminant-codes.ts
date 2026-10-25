// A company's contaminant codes (Issue #293, M5a): the names it gives the
// wrong waste in a bin, under `configure.master` like its waste fractions,
// and the fractions each applies to — a set that travels with the record,
// named on the create and replaced whole through `PUT
// /contaminant-codes/:id/fractions`, as a station's fractions are
// (routes/id-sets.ts). An empty set is every fraction. A code is retired by
// its status, never deleted: a stop names the code it was tagged with, and a
// status gates a new tag, never an existing one (routes/statuses.ts).
import { Page } from "@waste/contracts/pagination"
import {
  ContaminantCode,
  ContaminantCodeCreate,
  ContaminantCodeFractionsSet,
  ContaminantCodeListQuery,
  ContaminantCodePatch,
  type ContaminantCodeStatus,
} from "@waste/contracts/pickup-exceptions"
import type { Tx } from "@waste/db/client"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { contaminantCode, contaminantCodeFraction } from "@waste/db/schema/pickup-exceptions"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { asRead, idsFor, idsOf, replaceIdSet, requireEachOf, writeIds, type IdSet } from "./id-sets"
import { requireWasteFraction } from "./references"
import { created, describeCreated, describeJson, IdParam, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "configure.master"

const ContaminantCodePage = Page(ContaminantCode)

const columns = {
  id: contaminantCode.id,
  code: contaminantCode.code,
  name: contaminantCode.name,
  status: contaminantCode.status,
  createdAt: contaminantCode.createdAt,
  updatedAt: contaminantCode.updatedAt,
}

type Row = Pick<typeof contaminantCode.$inferSelect, keyof typeof columns>

/** The fractions a code applies to: the waste fractions of this company, one row per fraction. */
export const codeFractions: IdSet<typeof contaminantCodeFraction> = {
  table: contaminantCodeFraction,
  parentId: contaminantCodeFraction.contaminantCodeId,
  entryId: contaminantCodeFraction.wasteFractionId,
  rowOf: (wasteFractionId, owner) => ({ id: newId(), companyId: owner.companyId, contaminantCodeId: owner.id, wasteFractionId }),
  require: requireEachOf(wasteFraction, "wasteFractionIds", requireWasteFraction),
}

function codeOf(row: Row, wasteFractionIds: readonly string[]): ContaminantCode {
  return { id: row.id, code: row.code, name: row.name, status: row.status as ContaminantCodeStatus, wasteFractionIds: [...wasteFractionIds], ...stampsOf(row) }
}

/** `unique (company_id, code)` and `unique (company_id, name)`: each is one code's inside a company. */
const CODE_TAKEN = "contaminant_code_code_key"
const NAME_TAKEN = "contaminant_code_name_key"
const codeTaken = (code: string) => `This company already has a contaminant code ${JSON.stringify(code)}`
const nameTaken = (name: string) => `This company already has a contaminant code called ${JSON.stringify(name)}`

const noSuchCode = (id: string) => problem(404, { detail: `No contaminant code ${id} in this company` })

async function findCode(tx: Tx, companyId: string, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(contaminantCode)
    .where(and(eq(contaminantCode.companyId, companyId), eq(contaminantCode.id, id)))
    .limit(1)
  return row
}

const commonProblems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

export function contaminantCodeRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/contaminant-codes",
      describeRoute({
        operationId: "listContaminantCodes",
        summary: "The company's contaminant codes",
        description:
          "One page of the codes the company tags the wrong waste in a bin with, oldest first (ids are time-ordered), each with the fractions it applies to — none is every fraction. `status` narrows the page to the active or the retired. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of contaminant codes.", ContaminantCodePage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, or the status is not one of the two."),
          ...commonProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", ContaminantCodeListQuery),
      async (c) => {
        const { limit, cursor, status } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const { companyId } = c.get("principal")
        const rows = await tx
          .select(columns)
          .from(contaminantCode)
          .where(and(eq(contaminantCode.companyId, companyId), status === undefined ? undefined : eq(contaminantCode.status, status), after === undefined ? undefined : gt(contaminantCode.id, after)))
          .orderBy(asc(contaminantCode.id))
          .limit(fetchLimit(limit))
        const page = pageOf(rows, limit)
        const fractions = await idsOf(tx, codeFractions, companyId, page.items.map((row) => row.id))
        return c.json({ ...page, items: page.items.map((row) => codeOf(row, fractions.get(row.id) ?? [])) })
      },
    )
    .post(
      "/contaminant-codes",
      describeRoute({
        operationId: "createContaminantCode",
        summary: "Add a contaminant code",
        description:
          "Adds a code to the company's own list. `code` is the stable slug reports and integrations quote, set once and lowercase; `name` is what a person reads; both are unique inside the company. `status` is `active` unless said. `wasteFractionIds` are the fractions it applies to, each a waste fraction of this company (400 at `wasteFractionIds.N`) named once; none is every fraction. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The contaminant code as it was written.", ContaminantCode),
          400: describeProblem("The body is missing a field, holds a value of the wrong shape, names a member the server owns, names a fraction twice, or names a waste fraction that is not this company's."),
          ...commonProblems("create"),
          409: describeProblem("The company already has a contaminant code with that code, or with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", ContaminantCodeCreate),
      async (c) => {
        const { wasteFractionIds, ...values } = c.req.valid("json")
        const tx = c.get("tx")
        const { companyId } = c.get("principal")
        await codeFractions.require(tx, companyId, wasteFractionIds)
        const [row] = await refuseDuplicate({ [CODE_TAKEN]: codeTaken(values.code), [NAME_TAKEN]: nameTaken(values.name) }, () =>
          tx
            .insert(contaminantCode)
            .values({ ...values, id: newId(), companyId })
            .returning(columns),
        )
        await writeIds(tx, codeFractions, { companyId, id: row.id }, wasteFractionIds)
        return created(c, "/contaminant-codes", codeOf(row, asRead(wasteFractionIds)))
      },
    )
    .get(
      "/contaminant-codes/:id",
      describeRoute({
        operationId: "getContaminantCode",
        summary: "One contaminant code",
        description: "One code of the caller's company, with the fractions it applies to. Another company's code is a code that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The contaminant code.", ContaminantCode),
          400: describeProblem("The path does not hold an id."),
          ...commonProblems("view"),
          404: describeProblem("No contaminant code with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const { companyId } = c.get("principal")
        const row = await findCode(tx, companyId, id)
        if (row === undefined) throw noSuchCode(id)
        return c.json(codeOf(row, await idsFor(tx, codeFractions, companyId, row.id)))
      },
    )
    .patch(
      "/contaminant-codes/:id",
      describeRoute({
        operationId: "patchContaminantCode",
        summary: "Rename or retire a contaminant code",
        description:
          "Changes the name a person reads, or the status: `inactive` retires the code from new tags while every stop tagged with it keeps it. The code is not patchable — it is the slug reports quote, and a code that needs another one is another code — and the fractions are a set, so they are `PUT /contaminant-codes/{id}/fractions`.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The contaminant code as it now stands.", ContaminantCode),
          400: describeProblem("The path does not hold an id, or the patch is empty or names a field the caller does not own, the code and the fractions included."),
          ...commonProblems("edit"),
          404: describeProblem("No contaminant code with that id in this company."),
          409: describeProblem("The company already has another contaminant code with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ContaminantCodePatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const { companyId } = c.get("principal")
        const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
        const [row] = await refuseDuplicate(sentences, () =>
          tx
            .update(contaminantCode)
            .set(patch)
            .where(and(eq(contaminantCode.companyId, companyId), eq(contaminantCode.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchCode(id)
        return c.json(codeOf(row, await idsFor(tx, codeFractions, companyId, row.id)))
      },
    )
    .put(
      "/contaminant-codes/:id/fractions",
      describeRoute({
        operationId: "putContaminantCodeFractions",
        summary: "Replace the fractions a contaminant code applies to",
        description:
          "Replaces the whole set with the one in the body: an empty list is a code for every fraction. Every id is a waste fraction of this company (400 at `wasteFractionIds.N` otherwise), each named once (400 on `wasteFractionIds`). The code's `updatedAt` moves, since the set is part of the code on the wire. A stop already tagged keeps its tag whatever the set now says: the set gates a new tag (`POST /pickups/{id}/correct-outcome`).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The contaminant code with the fractions it now applies to.", ContaminantCode),
          400: describeProblem("The path does not hold an id, or the body is missing `wasteFractionIds`, names a member it does not own, names a fraction twice, or names a waste fraction that is not this company's."),
          ...commonProblems("edit"),
          404: describeProblem("No contaminant code with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ContaminantCodeFractionsSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { wasteFractionIds } = c.req.valid("json")
        const tx = c.get("tx")
        const { companyId } = c.get("principal")
        const row = await replaceIdSet(tx, codeFractions, companyId, wasteFractionIds, (stamped) =>
          tx
            .update(contaminantCode)
            .set(stamped)
            .where(and(eq(contaminantCode.companyId, companyId), eq(contaminantCode.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchCode(id)
        return c.json(codeOf(row, asRead(wasteFractionIds)))
      },
    )
}
