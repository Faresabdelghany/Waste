// The master data a service is described in (Issue #78): the waste fractions
// a company collects, the container types it owns, and the cadences a project
// offers. Three resources in one module because they are one surface —
// Settings → Master Data — and one grant, `configure.master`: a company that
// may name its fractions may name its container types.
//
// Each is list, create, read, change, in the shape projects.ts settled: paged
// by id, the server minting it, every statement carrying `company_id = the
// caller's` beside the fence (ADR-0001), another company's row a 404 and not
// a 403. There is no delete: a fraction a container was classified by and a
// type a container was bought as are quoted by rows that outlive them, and
// what "remove" means for master data is a question the product has not asked
// yet.
//
// A waste fraction has two names and they are not interchangeable. `key` is
// the slug the rest of the system quotes and it is set once: a patch takes
// the name alone, because a report, an import or a fixture that quotes the
// old key would go on quoting it, and a fraction that needs another key is
// another fraction. Both are unique per company, and each collision has its
// own sentence, since "that key is taken" and "that name is taken" are two
// different things to fix.
//
// Service frequencies are the first project-scoped resource on the wire, so
// they are the first to carry the second fence: `inProjects` (auth/projects.ts)
// beside the tenant, on every statement. A caller sees the cadences of the
// projects it works in and no others; a create names its project in the body
// and the id must be one of those (400 on `projectId`, not 404 on a row that
// was never made); a patch never names one, because a record does not move
// between projects.
//
// The cadence rule — an interval needs a rate to belong to, and `weeksBetween`
// and `daysBetween` are two ways of saying the same thing — is the contracts'
// `serviceFrequencyShape` and the table's `service_frequency_shape` check. A
// create body carries the whole picture, so the schema settles it; a patch
// carries a part of it, so only this route can, holding the patch against the
// row it is patching before the update goes out. Without that the check
// constraint would answer, and a rule a client can fix would arrive as a 500.
import {
  ContainerType,
  ContainerTypeCreate,
  ContainerTypePatch,
  ServiceFrequency,
  ServiceFrequencyCreate,
  ServiceFrequencyPatch,
  serviceFrequencyShape,
  WasteFraction,
  WasteFractionCreate,
  WasteFractionPatch,
} from "@waste/contracts/catalogue"
import { Page, PageRequest } from "@waste/contracts/pagination"
import { ProjectScopedListQuery } from "@waste/contracts/queries"
import type { Tx } from "@waste/db/client"
import { containerType, serviceFrequency, wasteFraction } from "@waste/db/schema/catalogue"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { describeJson, IdParam, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "configure.master"

const WasteFractionPage = Page(WasteFraction)
const ContainerTypePage = Page(ContainerType)
const ServiceFrequencyPage = Page(ServiceFrequency)

const fractionColumns = {
  id: wasteFraction.id,
  key: wasteFraction.key,
  name: wasteFraction.name,
  createdAt: wasteFraction.createdAt,
  updatedAt: wasteFraction.updatedAt,
}

type FractionRow = Pick<typeof wasteFraction.$inferSelect, keyof typeof fractionColumns>

function fractionOf(row: FractionRow): WasteFraction {
  return { id: row.id, key: row.key, name: row.name, ...stampsOf(row) }
}

/** `unique (company_id, key)` and `unique (company_id, name)`: each is one fraction's inside a company, and free in the next. */
const FRACTION_KEY_TAKEN = "waste_fraction_key_key"
const FRACTION_NAME_TAKEN = "waste_fraction_name_key"
const fractionKeyTaken = (key: string) => `This company already has a waste fraction with the key ${JSON.stringify(key)}`
const fractionNameTaken = (name: string) => `This company already has a waste fraction called ${JSON.stringify(name)}`

const noSuchFraction = (id: string) => problem(404, { detail: `No waste fraction ${id} in this company` })

const typeColumns = {
  id: containerType.id,
  name: containerType.name,
  volumeLitres: containerType.volumeLitres,
  createdAt: containerType.createdAt,
  updatedAt: containerType.updatedAt,
}

type TypeRow = Pick<typeof containerType.$inferSelect, keyof typeof typeColumns>

function typeOf(row: TypeRow): ContainerType {
  return { id: row.id, name: row.name, volumeLitres: row.volumeLitres, ...stampsOf(row) }
}

/** `unique (company_id, name)`: a container type's name is one type's inside a company. */
const TYPE_NAME_TAKEN = "container_type_name_key"
const typeNameTaken = (name: string) => `This company already has a container type called ${JSON.stringify(name)}`

const noSuchType = (id: string) => problem(404, { detail: `No container type ${id} in this company` })

const frequencyColumns = {
  id: serviceFrequency.id,
  projectId: serviceFrequency.projectId,
  name: serviceFrequency.name,
  description: serviceFrequency.description,
  collectionsPerWeek: serviceFrequency.collectionsPerWeek,
  weeksBetween: serviceFrequency.weeksBetween,
  daysBetween: serviceFrequency.daysBetween,
  createdAt: serviceFrequency.createdAt,
  updatedAt: serviceFrequency.updatedAt,
}

type FrequencyRow = Pick<typeof serviceFrequency.$inferSelect, keyof typeof frequencyColumns>

function frequencyOf(row: FrequencyRow): ServiceFrequency {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    collectionsPerWeek: row.collectionsPerWeek,
    weeksBetween: row.weeksBetween,
    daysBetween: row.daysBetween,
    ...stampsOf(row),
  }
}

/** `unique (company_id, project_id, name)`: a cadence's name is one frequency's inside a project, and free in the next. */
const FREQUENCY_NAME_TAKEN = "service_frequency_project_id_name_key"
const frequencyNameTaken = (name: string) => `This project already has a service frequency called ${JSON.stringify(name)}`

const noSuchFrequency = (id: string) => problem(404, { detail: `No service frequency ${id} in the projects this account works in` })

/** The contracts' own words for the cadence rule, said again where only the stored row can prove it broken. */
const ONE_CADENCE = "Give collectionsPerWeek with at most one of weeksBetween and daysBetween, or none of the three (on demand)"

/** The rows of this company, in the projects the caller works in: what every service frequency statement is bounded by. */
const frequencyScope = (principal: Principal) =>
  and(eq(serviceFrequency.companyId, principal.companyId), inProjects(serviceFrequency.projectId, principal))

/** One frequency of this company by id, inside the caller's projects; undefined when it is neither. */
async function findFrequency(tx: Tx, principal: Principal, id: string): Promise<FrequencyRow | undefined> {
  const [row] = await tx
    .select(frequencyColumns)
    .from(serviceFrequency)
    .where(and(frequencyScope(principal), eq(serviceFrequency.id, id)))
    .limit(1)
  return row
}

export function catalogueRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/waste-fractions",
      describeRoute({
        operationId: "listWasteFractions",
        summary: "The company's waste fractions",
        description:
          "One page of the fractions the company collects, oldest first (ids are time-ordered). Hand `nextCursor` back as `cursor` for the next page; `nextCursor` is null on the last one.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of waste fractions.", WasteFractionPage),
          400: describeProblem("The page size is outside 1..200, or the cursor is not one this API wrote."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.master`."),
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
          .select(fractionColumns)
          .from(wasteFraction)
          .where(
            and(eq(wasteFraction.companyId, c.get("principal").companyId), after === undefined ? undefined : gt(wasteFraction.id, after)),
          )
          .orderBy(asc(wasteFraction.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(fractionOf), limit))
      },
    )
    .post(
      "/waste-fractions",
      describeRoute({
        operationId: "createWasteFraction",
        summary: "Add a waste fraction",
        description:
          "Adds a fraction to the company's own vocabulary. `key` is the stable slug the rest of the system quotes and is set once; `name` is what a person reads. Both are unique inside the company. The server mints the id; a body that carries one is refused.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The waste fraction as it was written.", WasteFraction),
          400: describeProblem("The body is missing a field, holds a value of the wrong shape, or names one the server owns."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `configure.master`."),
          409: describeProblem("The company already has a waste fraction with that key, or with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", WasteFractionCreate),
      async (c) => {
        const values = c.req.valid("json")
        const sentences = { [FRACTION_KEY_TAKEN]: fractionKeyTaken(values.key), [FRACTION_NAME_TAKEN]: fractionNameTaken(values.name) }
        const [row] = await refuseDuplicate(sentences, () =>
          c
            .get("tx")
            .insert(wasteFraction)
            .values({ ...values, id: newId(), companyId: c.get("principal").companyId })
            .returning(fractionColumns),
        )
        return c.json(fractionOf(row), 201)
      },
    )
    .get(
      "/waste-fractions/:id",
      describeRoute({
        operationId: "getWasteFraction",
        summary: "One waste fraction",
        description: "One fraction of the caller's company. Another company's fraction is a fraction that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The waste fraction.", WasteFraction),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.master`."),
          404: describeProblem("No waste fraction with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const [row] = await c
          .get("tx")
          .select(fractionColumns)
          .from(wasteFraction)
          .where(and(eq(wasteFraction.companyId, c.get("principal").companyId), eq(wasteFraction.id, id)))
          .limit(1)
        if (row === undefined) throw noSuchFraction(id)
        return c.json(fractionOf(row))
      },
    )
    .patch(
      "/waste-fractions/:id",
      describeRoute({
        operationId: "patchWasteFraction",
        summary: "Rename a waste fraction",
        description:
          "Changes the name a person reads. The key is not patchable: it is the slug reports, imports and fixtures quote, and a fraction that needs another key is another fraction.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The waste fraction as it now stands.", WasteFraction),
          400: describeProblem("The path does not hold an id, or the patch is empty or names a field the caller does not own, the key included."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.master`."),
          404: describeProblem("No waste fraction with that id in this company."),
          409: describeProblem("The company already has another waste fraction with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", WasteFractionPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const sentences: Record<string, string> = patch.name === undefined ? {} : { [FRACTION_NAME_TAKEN]: fractionNameTaken(patch.name) }
        const [row] = await refuseDuplicate(sentences, () =>
          c
            .get("tx")
            .update(wasteFraction)
            .set(patch)
            .where(and(eq(wasteFraction.companyId, c.get("principal").companyId), eq(wasteFraction.id, id)))
            .returning(fractionColumns),
        )
        if (row === undefined) throw noSuchFraction(id)
        return c.json(fractionOf(row))
      },
    )
    .get(
      "/container-types",
      describeRoute({
        operationId: "listContainerTypes",
        summary: "The company's container types",
        description:
          "One page of the container types the company owns, oldest first (ids are time-ordered). Hand `nextCursor` back as `cursor` for the next page; `nextCursor` is null on the last one.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of container types.", ContainerTypePage),
          400: describeProblem("The page size is outside 1..200, or the cursor is not one this API wrote."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.master`."),
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
          .select(typeColumns)
          .from(containerType)
          .where(and(eq(containerType.companyId, c.get("principal").companyId), after === undefined ? undefined : gt(containerType.id, after)))
          .orderBy(asc(containerType.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(typeOf), limit))
      },
    )
    .post(
      "/container-types",
      describeRoute({
        operationId: "createContainerType",
        summary: "Add a container type",
        description:
          "Adds a container type to the company's own vocabulary. The name is unique inside the company; `volumeLitres` is optional, and null means nobody recorded one — zero is not a volume. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The container type as it was written.", ContainerType),
          400: describeProblem("The body is missing a field, holds a value of the wrong shape, or names one the server owns."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `configure.master`."),
          409: describeProblem("The company already has a container type with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", ContainerTypeCreate),
      async (c) => {
        const values = c.req.valid("json")
        const [row] = await refuseDuplicate({ [TYPE_NAME_TAKEN]: typeNameTaken(values.name) }, () =>
          c
            .get("tx")
            .insert(containerType)
            .values({ ...values, id: newId(), companyId: c.get("principal").companyId })
            .returning(typeColumns),
        )
        return c.json(typeOf(row), 201)
      },
    )
    .get(
      "/container-types/:id",
      describeRoute({
        operationId: "getContainerType",
        summary: "One container type",
        description: "One container type of the caller's company. Another company's type is a type that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The container type.", ContainerType),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.master`."),
          404: describeProblem("No container type with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const [row] = await c
          .get("tx")
          .select(typeColumns)
          .from(containerType)
          .where(and(eq(containerType.companyId, c.get("principal").companyId), eq(containerType.id, id)))
          .limit(1)
        if (row === undefined) throw noSuchType(id)
        return c.json(typeOf(row))
      },
    )
    .patch(
      "/container-types/:id",
      describeRoute({
        operationId: "patchContainerType",
        summary: "Change a container type",
        description:
          "Changes the name or the volume of one container type; every field is optional and at least one must be given. A null volume is the volume nobody recorded.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The container type as it now stands.", ContainerType),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own, or holds a value of the wrong shape."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.master`."),
          404: describeProblem("No container type with that id in this company."),
          409: describeProblem("The company already has another container type with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ContainerTypePatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const sentences: Record<string, string> = patch.name === undefined ? {} : { [TYPE_NAME_TAKEN]: typeNameTaken(patch.name) }
        const [row] = await refuseDuplicate(sentences, () =>
          c
            .get("tx")
            .update(containerType)
            .set(patch)
            .where(and(eq(containerType.companyId, c.get("principal").companyId), eq(containerType.id, id)))
            .returning(typeColumns),
        )
        if (row === undefined) throw noSuchType(id)
        return c.json(typeOf(row))
      },
    )
    .get(
      "/service-frequencies",
      describeRoute({
        operationId: "listServiceFrequencies",
        summary: "The cadences the caller's projects offer",
        description:
          "One page of service frequencies, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of service frequencies.", ServiceFrequencyPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.master`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", ProjectScopedListQuery),
      async (c) => {
        const { limit, cursor, projectId } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(frequencyColumns)
          .from(serviceFrequency)
          .where(
            and(
              frequencyScope(principal),
              projectId === undefined ? undefined : eq(serviceFrequency.projectId, projectId),
              after === undefined ? undefined : gt(serviceFrequency.id, after),
            ),
          )
          .orderBy(asc(serviceFrequency.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(frequencyOf), limit))
      },
    )
    .post(
      "/service-frequencies",
      describeRoute({
        operationId: "createServiceFrequency",
        summary: "Add a service frequency",
        description:
          "Adds a cadence to one project, which must be a project the caller works in. The name is unique inside the project. A rate nobody gives is on demand; `collectionsPerWeek: 1` with neither interval is monthly, since a month is not a number of weeks; and an interval needs a rate to belong to, `weeksBetween` and `daysBetween` being two ways of saying the same thing. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The service frequency as it was written.", ServiceFrequency),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, gives an interval with no rate or both intervals at once, or names a project this account does not work in.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `configure.master`."),
          409: describeProblem("The project already has a service frequency with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", ServiceFrequencyCreate),
      async (c) => {
        const values = c.req.valid("json")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        const [row] = await refuseDuplicate({ [FREQUENCY_NAME_TAKEN]: frequencyNameTaken(values.name) }, () =>
          c
            .get("tx")
            .insert(serviceFrequency)
            .values({ ...values, id: newId(), companyId: principal.companyId })
            .returning(frequencyColumns),
        )
        return c.json(frequencyOf(row), 201)
      },
    )
    .get(
      "/service-frequencies/:id",
      describeRoute({
        operationId: "getServiceFrequency",
        summary: "One service frequency",
        description:
          "One cadence of a project the caller works in. A frequency of another company, or of a project this account does not work in, is a frequency that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The service frequency.", ServiceFrequency),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.master`."),
          404: describeProblem("No service frequency with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findFrequency(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchFrequency(id)
        return c.json(frequencyOf(row))
      },
    )
    .patch(
      "/service-frequencies/:id",
      describeRoute({
        operationId: "patchServiceFrequency",
        summary: "Change a service frequency",
        description:
          "Changes one cadence of a project the caller works in; every field is optional and at least one must be given. The project is not patchable: a record does not move between projects. The patch is held against the stored row, so a change that would leave it with an interval and no rate, or with both intervals, is refused.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The service frequency as it now stands.", ServiceFrequency),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (the project included), or would leave the row with an interval and no rate or with both intervals.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.master`."),
          404: describeProblem("No service frequency with that id in the projects this account works in."),
          409: describeProblem("The project already has another service frequency with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ServiceFrequencyPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        const current = await findFrequency(tx, principal, id)
        if (current === undefined) throw noSuchFrequency(id)
        const merged = {
          collectionsPerWeek: patch.collectionsPerWeek === undefined ? current.collectionsPerWeek : patch.collectionsPerWeek,
          weeksBetween: patch.weeksBetween === undefined ? current.weeksBetween : patch.weeksBetween,
          daysBetween: patch.daysBetween === undefined ? current.daysBetween : patch.daysBetween,
        }
        if (!serviceFrequencyShape(merged)) throw problem(400, { detail: "The request body is invalid", errors: [{ path: "", message: ONE_CADENCE }] })

        const sentences: Record<string, string> = patch.name === undefined ? {} : { [FREQUENCY_NAME_TAKEN]: frequencyNameTaken(patch.name) }
        const [row] = await refuseDuplicate(sentences, () =>
          tx
            .update(serviceFrequency)
            .set(patch)
            .where(and(frequencyScope(principal), eq(serviceFrequency.id, id)))
            .returning(frequencyColumns),
        )
        if (row === undefined) throw noSuchFrequency(id)
        return c.json(frequencyOf(row))
      },
    )
}
