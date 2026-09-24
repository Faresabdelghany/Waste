// The Service Providers a company works with: the external organisation
// itself — legal name, registration, country, and the person to call — not
// what it is assigned to. Which Service Areas a provider serves, on what
// terms and for what price, is Finance & Contracting's (Issue 11); the record
// lives here because a Service Provider Access grants for it (Issue #70).
//
// `GET /service-providers`, `POST`, `GET /:id`, `PATCH /:id`, the same shape
// as projects.ts: paged by id, the server minting the id, another company's
// provider a 404. The grant is the provider surface's own,
// `service-providers.service-providers`, which is why a Service Provider
// Manager can read and change a provider (their charter grants view and
// edit) but cannot add one, while Settings' own role cannot see the surface
// at all.
//
// No delete, as with projects: a provider that has hauled is behind routes,
// pickups and settlements.
import { ServiceProvider, ServiceProviderCreate, ServiceProviderPatch } from "@waste/contracts/organisation"
import { Page, PageRequest } from "@waste/contracts/pagination"
import { serviceProvider } from "@waste/db/schema/organisation"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { created, describeCreated, describeJson, IdParam, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "service-providers.service-providers"
const ServiceProviderPage = Page(ServiceProvider)

const columns = {
  id: serviceProvider.id,
  legalName: serviceProvider.legalName,
  registrationNumber: serviceProvider.registrationNumber,
  country: serviceProvider.country,
  contactName: serviceProvider.contactName,
  contactEmail: serviceProvider.contactEmail,
  createdAt: serviceProvider.createdAt,
  updatedAt: serviceProvider.updatedAt,
}

type Row = Pick<typeof serviceProvider.$inferSelect, keyof typeof columns>

function serviceProviderOf(row: Row): ServiceProvider {
  return {
    id: row.id,
    legalName: row.legalName,
    registrationNumber: row.registrationNumber,
    country: row.country,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    ...stampsOf(row),
  }
}

/** `unique (company_id, country, registration_number)`: two companies may work with the same hauler, and each registers it once. */
const REGISTRATION_TAKEN = "service_provider_country_registration_number_key"
const registrationTaken = (registrationNumber: string | undefined, country: string | undefined) =>
  registrationNumber === undefined
    ? "This company already has a service provider with that registration number in that country"
    : `This company already has a service provider with the registration number ${registrationNumber}${country === undefined ? "" : ` in ${country}`}`

const noSuchProvider = (id: string) => problem(404, { detail: `No service provider ${id} in this company` })

export function serviceProviderRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/service-providers",
      describeRoute({
        operationId: "listServiceProviders",
        summary: "The company's service providers",
        description:
          "One page of the service providers the company works with, oldest first (ids are time-ordered). Hand `nextCursor` back as `cursor` for the next page; `nextCursor` is null on the last one.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of service providers.", ServiceProviderPage),
          400: describeProblem("The page size is outside 1..200, or the cursor is not one this API wrote."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `service-providers.service-providers`."),
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
          .from(serviceProvider)
          .where(
            and(eq(serviceProvider.companyId, c.get("principal").companyId), after === undefined ? undefined : gt(serviceProvider.id, after)),
          )
          .orderBy(asc(serviceProvider.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(serviceProviderOf), limit))
      },
    )
    .post(
      "/service-providers",
      describeRoute({
        operationId: "createServiceProvider",
        summary: "Add a service provider",
        description:
          "Registers a service provider for the caller's company. The contact is required: a provider nobody can call is a provider nobody can dispatch. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The service provider as it was written.", ServiceProvider),
          400: describeProblem("The body is missing a field, holds a value of the wrong shape, or names one the server owns."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `service-providers.service-providers`."),
          409: describeProblem("The company already has a service provider with that registration number in that country."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", ServiceProviderCreate),
      async (c) => {
        const values = c.req.valid("json")
        const [row] = await refuseDuplicate({ [REGISTRATION_TAKEN]: registrationTaken(values.registrationNumber, values.country) }, () =>
          c
            .get("tx")
            .insert(serviceProvider)
            // The body first, the server's own last: a member the strict
            // schema would have refused still could not take the id or the
            // tenant from the two that decide them.
            .values({ ...values, id: newId(), companyId: c.get("principal").companyId })
            .returning(columns),
        )
        return created(c, "/service-providers", serviceProviderOf(row))
      },
    )
    .get(
      "/service-providers/:id",
      describeRoute({
        operationId: "getServiceProvider",
        summary: "One service provider",
        description: "One service provider of the caller's company. Another company's provider is a provider that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The service provider.", ServiceProvider),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `service-providers.service-providers`."),
          404: describeProblem("No service provider with that id in this company."),
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
          .from(serviceProvider)
          .where(and(eq(serviceProvider.companyId, c.get("principal").companyId), eq(serviceProvider.id, id)))
          .limit(1)
        if (row === undefined) throw noSuchProvider(id)
        return c.json(serviceProviderOf(row))
      },
    )
    .patch(
      "/service-providers/:id",
      describeRoute({
        operationId: "patchServiceProvider",
        summary: "Change a service provider",
        description: "Changes one service provider of the caller's company; every field is optional and at least one must be given.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The service provider as it now stands.", ServiceProvider),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own, or holds a value of the wrong shape."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `service-providers.service-providers`."),
          404: describeProblem("No service provider with that id in this company."),
          409: describeProblem("The company already has another service provider with that registration number in that country."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ServiceProviderPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        // The unique is (company, country, registration number), so a patch
        // that names only the country collides just as one that names only
        // the number; the constraint is mapped whichever it names, and the
        // sentence leaves out what the patch did not say.
        const [row] = await refuseDuplicate({ [REGISTRATION_TAKEN]: registrationTaken(patch.registrationNumber, patch.country) }, () =>
          c
            .get("tx")
            .update(serviceProvider)
            .set(patch)
            .where(and(eq(serviceProvider.companyId, c.get("principal").companyId), eq(serviceProvider.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchProvider(id)
        return c.json(serviceProviderOf(row))
      },
    )
}
