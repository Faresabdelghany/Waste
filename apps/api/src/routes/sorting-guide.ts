// The Sorting Guide's items (Issue #293, M1), the office's side: what a
// project's guide tells a resident about a thing — its name, the other words
// it is known by, the fraction it goes in and how to present it.
// `GET /sorting-guide-items` lists them, `POST` adds one, `GET`/`PATCH
// /sorting-guide-items/:id` read and change one. No delete: `withdrawn` takes
// an item off the public door and keeps the row, as every status here does.
//
// The shape is every project-scoped family's (warehouses.ts): the tenant and
// `inProjects` on every statement, a create naming a project the caller works
// in, an item that never moves between projects, and a name unique per
// project. The fraction is the company's catalogue's (400 on
// `wasteFractionId` otherwise). What a resident reads is public.ts's, through
// the public door and its own role (ADR-0010); nothing here is anonymous. The
// grant is `configure.portals`: the guide is content the citizen-facing pages
// publish, beside their branding.
import { Page } from "@waste/contracts/pagination"
import { SortingGuideItem, SortingGuideItemCreate, SortingGuideItemListQuery, SortingGuideItemPatch, type SortingGuideItemStatus } from "@waste/contracts/sorting-guide"
import type { Tx } from "@waste/db/client"
import { sortingGuideItem } from "@waste/db/schema/sorting-guide"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { requireWasteFraction } from "./references"
import { created, describeCreated, describeJson, IdParam, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "configure.portals"
const SortingGuideItemPage = Page(SortingGuideItem)

const columns = {
  id: sortingGuideItem.id,
  projectId: sortingGuideItem.projectId,
  name: sortingGuideItem.name,
  synonyms: sortingGuideItem.synonyms,
  wasteFractionId: sortingGuideItem.wasteFractionId,
  instructions: sortingGuideItem.instructions,
  status: sortingGuideItem.status,
  createdAt: sortingGuideItem.createdAt,
  updatedAt: sortingGuideItem.updatedAt,
}

type Row = Pick<typeof sortingGuideItem.$inferSelect, keyof typeof columns>

/** The row on the wire; `status` is text with a CHECK in the database and an enum here, both read off the guide's vocabulary. */
function itemOf(row: Row): SortingGuideItem {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    synonyms: row.synonyms,
    wasteFractionId: row.wasteFractionId,
    instructions: row.instructions,
    status: row.status as SortingGuideItemStatus,
    ...stampsOf(row),
  }
}

/** `unique (company_id, project_id, name)`: a name is one item's inside a project's guide, and free in the next. */
const NAME_TAKEN = "sorting_guide_item_project_id_name_key"
const nameTaken = (name: string) => `This project's sorting guide already has an item called ${JSON.stringify(name)}`

const noSuchItem = (id: string) => problem(404, { detail: `No sorting guide item ${id} in the projects this account works in` })

/** The rows of this company, in the projects the caller works in. */
const scope = (principal: Principal) => and(eq(sortingGuideItem.companyId, principal.companyId), inProjects(sortingGuideItem.projectId, principal))

async function findItem(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(sortingGuideItem)
    .where(and(scope(principal), eq(sortingGuideItem.id, id)))
    .limit(1)
  return row
}

export function sortingGuideRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/sorting-guide-items",
      describeRoute({
        operationId: "listSortingGuideItems",
        summary: "The sorting guide items of the caller's projects",
        description:
          "One page of sorting guide items, oldest first (ids are time-ordered), from the projects the caller works in. `projectId` narrows it to one of those projects; naming another is refused. `status` narrows it to the items in that state. What a resident's search finds is `GET /public/:slug/sorting-guide`. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of sorting guide items.", SortingGuideItemPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `status` is not one of the three, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.portals`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", SortingGuideItemListQuery),
      async (c) => {
        const { limit, cursor, projectId, status } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(columns)
          .from(sortingGuideItem)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(sortingGuideItem.projectId, projectId),
              status === undefined ? undefined : eq(sortingGuideItem.status, status),
              after === undefined ? undefined : gt(sortingGuideItem.id, after),
            ),
          )
          .orderBy(asc(sortingGuideItem.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(itemOf), limit))
      },
    )
    .post(
      "/sorting-guide-items",
      describeRoute({
        operationId: "createSortingGuideItem",
        summary: "Add an item to a project's sorting guide",
        description:
          "Adds an item to the sorting guide of one project, which must be a project the caller works in. The name is unique inside the project's guide; the synonyms are the other words it is searched by, each once. `wasteFractionId`, where given, is a fraction of the company's catalogue; null or absent is an item no collected fraction takes. The status defaults to `draft`: only a `published` item of a project that publishes itself reaches the public door. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The item as it was written.", SortingGuideItem),
          400: describeProblem("The body is missing a field, names a member the server owns, names a project this account does not work in, names a synonym twice, or names a fraction that is not this company's."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `configure.portals`."),
          409: describeProblem("The project's guide already has an item with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", SortingGuideItemCreate),
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        await requireWasteFraction(tx, principal.companyId, values.wasteFractionId)
        const [row] = await refuseDuplicate({ [NAME_TAKEN]: nameTaken(values.name) }, () =>
          tx
            .insert(sortingGuideItem)
            .values({ ...values, id: newId(), companyId: principal.companyId })
            .returning(columns),
        )
        return created(c, "/sorting-guide-items", itemOf(row))
      },
    )
    .get(
      "/sorting-guide-items/:id",
      describeRoute({
        operationId: "getSortingGuideItem",
        summary: "One sorting guide item",
        description: "One sorting guide item of a project the caller works in. An item of another company, or of a project this account does not work in, is an item that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The item.", SortingGuideItem),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.portals`."),
          404: describeProblem("No sorting guide item with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findItem(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchItem(id)
        return c.json(itemOf(row))
      },
    )
    .patch(
      "/sorting-guide-items/:id",
      describeRoute({
        operationId: "patchSortingGuideItem",
        summary: "Change a sorting guide item",
        description:
          "Changes one sorting guide item of a project the caller works in; every field is optional and at least one must be given. `synonyms` replaces the list whole. A null clears the fraction or the instructions. `status: withdrawn` takes the item off the public door and keeps it, since there is no delete. The project is not patchable, since a record does not move between projects.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The item as it now stands.", SortingGuideItem),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own (the project included), names a synonym twice, or names a fraction that is not this company's."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.portals`."),
          404: describeProblem("No sorting guide item with that id in the projects this account works in."),
          409: describeProblem("The project's guide already has another item with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", SortingGuideItemPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The row first, then what the patch points at, as warehouses.ts judges.
        const current = await findItem(tx, principal, id)
        if (current === undefined) throw noSuchItem(id)
        await requireWasteFraction(tx, principal.companyId, patch.wasteFractionId)

        const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
        const [row] = await refuseDuplicate(sentences, () =>
          tx
            .update(sortingGuideItem)
            .set(patch)
            .where(and(scope(principal), eq(sortingGuideItem.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchItem(id)
        return c.json(itemOf(row))
      },
    )
}
