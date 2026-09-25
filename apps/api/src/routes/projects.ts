// The company's Projects: the operating scopes (a municipality, a contract, a
// region) everything else is planned inside. `GET /projects` lists them a
// page at a time, `POST /projects` adds one, `GET /projects/:id` reads one
// and `PATCH /projects/:id` changes one. There is no delete: a project that
// has run has routes and pickups behind it, and retiring one is a status, not
// a row disappearing (the statuses grow when the product needs them to).
//
// This is the first route that writes, so it is the first that mints an id
// (ids.ts, ADR-0004): the server owns identity, the body may not carry an
// `id`, and the id is on the row before the insert. And it is the first that
// pages: ordered by id, which for a version 7 id is the order the projects
// were made in, with the cursor of pagination.ts.
//
// Every statement carries `company_id = the caller's` beside the fence, as
// the principal lookup does (auth/principal.ts): the API is the authority and
// RLS the backstop (ADR-0001). A row of another company is therefore a row
// that does not exist here — 404, not 403, which would tell the caller it is
// out there somewhere.
//
// The grant is `configure.organization`, the same as the company's: Settings
// → Company & Projects is one surface.
import { Project, ProjectCreate, ProjectPatch, type ProjectStatus } from "@waste/contracts/organisation"
import { Page, PageRequest } from "@waste/contracts/pagination"
import { project } from "@waste/db/schema/organisation"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { created, describeCreated, describeJson, IdParam, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "configure.organization"
const ProjectPage = Page(Project)

const columns = {
  id: project.id,
  name: project.name,
  kind: project.kind,
  language: project.language,
  currency: project.currency,
  timezone: project.timezone,
  status: project.status,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
}

type Row = Pick<typeof project.$inferSelect, keyof typeof columns>

/** The row on the wire. `status` is text with a CHECK in the database and this enum here; packages/db holds the two lists in lockstep. */
function projectOf(row: Row): Project {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    language: row.language,
    currency: row.currency,
    timezone: row.timezone,
    status: row.status as ProjectStatus,
    ...stampsOf(row),
  }
}

/** `unique (company_id, name)`: a name is one project's inside a company, and free in the next. */
const NAME_TAKEN = "project_name_key"
const nameTaken = (name: string) => `This company already has a project called ${JSON.stringify(name)}`

const noSuchProject = (id: string) => problem(404, { detail: `No project ${id} in this company` })

export function projectRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/projects",
      describeRoute({
        operationId: "listProjects",
        summary: "The company's projects",
        description:
          "One page of the company's projects, oldest first (ids are time-ordered). Hand `nextCursor` back as `cursor` for the next page; `nextCursor` is null on the last one.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of projects.", ProjectPage),
          400: describeProblem("The page size is outside 1..200, or the cursor is not one this API wrote."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.organization`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", PageRequest),
      async (c) => {
        const { limit, cursor } = c.req.valid("query")
        const after = afterCursor(cursor)
        const rows = await c
          .get("tx")
          .select(columns)
          .from(project)
          .where(and(eq(project.companyId, c.get("principal").companyId), after === undefined ? undefined : gt(project.id, after)))
          .orderBy(asc(project.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(projectOf), limit))
      },
    )
    .post(
      "/projects",
      describeRoute({
        operationId: "createProject",
        summary: "Add a project",
        description: "Creates a project in the caller's company. The server mints the id; a body that carries one is refused.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The project as it was written.", Project),
          400: describeProblem("The body is missing a field, holds a value of the wrong shape, or names one the server owns."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `configure.organization`."),
          409: describeProblem("The company already has a project with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", ProjectCreate),
      async (c) => {
        const values = c.req.valid("json")
        const [row] = await refuseDuplicate({ [NAME_TAKEN]: nameTaken(values.name) }, () =>
          c
            .get("tx")
            .insert(project)
            // The body first, the server's own last: a member the strict
            // schema would have refused still could not take the id or the
            // tenant from the two that decide them.
            .values({ ...values, id: newId(), companyId: c.get("principal").companyId })
            .returning(columns),
        )
        return created(c, "/projects", projectOf(row))
      },
    )
    .get(
      "/projects/:id",
      describeRoute({
        operationId: "getProject",
        summary: "One project",
        description: "One project of the caller's company. Another company's project is a project that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The project.", Project),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.organization`."),
          404: describeProblem("No project with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const [row] = await c
          .get("tx")
          .select(columns)
          .from(project)
          .where(and(eq(project.companyId, c.get("principal").companyId), eq(project.id, id)))
          .limit(1)
        if (row === undefined) throw noSuchProject(id)
        return c.json(projectOf(row))
      },
    )
    .patch(
      "/projects/:id",
      describeRoute({
        operationId: "patchProject",
        summary: "Change a project",
        description: "Changes one project of the caller's company; every field is optional and at least one must be given.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The project as it now stands.", Project),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own, or holds a value of the wrong shape."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.organization`."),
          404: describeProblem("No project with that id in this company."),
          409: describeProblem("The company already has another project with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ProjectPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
        const [row] = await refuseDuplicate(sentences, () =>
          c
            .get("tx")
            .update(project)
            .set(patch)
            .where(and(eq(project.companyId, c.get("principal").companyId), eq(project.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchProject(id)
        return c.json(projectOf(row))
      },
    )
}
