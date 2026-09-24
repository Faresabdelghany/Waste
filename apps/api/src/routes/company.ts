// The caller's own company: `GET /company` and `PATCH /company`. There is no
// `/companies` and no id in the path, because a request is one company's by
// construction — the token's claim names it and the transaction is set to it
// (auth/principal.ts) — so "the company" is never ambiguous and a caller
// cannot even spell another one's.
//
// A Company is created by the seed or an operator, never through a tenant's
// request (Issue #70, out of scope), so there is no POST here; and its
// `status` is not in the patch, because onboarding to active is the
// operator's act, not the tenant's. What is left is what a Company
// Administrator maintains about their own organisation: its names, its
// registration and its country.
//
// The grant is `configure.organization`, which is Settings → Company &
// Projects: `view` to read, `edit` to change.
import { Company, CompanyPatch, type CompanyStatus } from "@waste/contracts/organisation"
import { company } from "@waste/db/schema/organisation"
import { eq } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { describeProblem, problem, validate } from "../problem"
import { describeJson, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "configure.organization"

/** Every column of the resource and none the wire has no business with; no `select *` reaches a client. */
const columns = {
  id: company.id,
  name: company.name,
  legalName: company.legalName,
  registrationNumber: company.registrationNumber,
  country: company.country,
  status: company.status,
  createdAt: company.createdAt,
  updatedAt: company.updatedAt,
}

type Row = Pick<typeof company.$inferSelect, keyof typeof columns>

/** The row on the wire. `status` is text with a CHECK in the database and this enum here; packages/db holds the two lists in lockstep. */
function companyOf(row: Row): Company {
  return {
    id: row.id,
    name: row.name,
    legalName: row.legalName,
    registrationNumber: row.registrationNumber,
    country: row.country,
    status: row.status as CompanyStatus,
    ...stampsOf(row),
  }
}

/** The registration is unique per country across every company, so the collision may be with a company the caller cannot see. */
const REGISTRATION_TAKEN = "company_country_registration_number_key"

// The principal was resolved by joining this very row (auth/principal.ts), so
// both routes below find it; a company deleted between that join and the
// statement is the only way past, and it answers as a company that is gone.
const GONE = "This company no longer exists"

export function companyRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/company",
      describeRoute({
        operationId: "getCompany",
        summary: "The caller's company",
        description: "The company the request's token names. There is no other company to ask for: a request is one company's, and this is it.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The company.", Company),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.organization`."),
          404: describeProblem("The company was removed between the token being resolved and this statement."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      async (c) => {
        const [row] = await c.get("tx").select(columns).from(company).where(eq(company.id, c.get("principal").companyId)).limit(1)
        if (row === undefined) throw problem(404, { detail: GONE })
        return c.json(companyOf(row))
      },
    )
    .patch(
      "/company",
      describeRoute({
        operationId: "patchCompany",
        summary: "Change the caller's company",
        description:
          "Changes the names, the registration number or the country of the caller's own company; every field is optional and at least one must be given. The status is not here: onboarding to active is an operator's act.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The company as it now stands.", Company),
          400: describeProblem("The patch is empty, names a field the caller does not own, or holds a value of the wrong shape."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.organization`."),
          404: describeProblem("The company was removed between the token being resolved and this statement."),
          409: describeProblem("Another company is already registered with that registration number in that country."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("json", CompanyPatch),
      async (c) => {
        const patch = c.req.valid("json")
        const companyId = c.get("principal").companyId
        const taken =
          patch.registrationNumber === undefined
            ? "Another company already has that registration number in that country"
            : `Another company already has the registration number ${patch.registrationNumber}${patch.country === undefined ? "" : ` in ${patch.country}`}`
        const [row] = await refuseDuplicate({ [REGISTRATION_TAKEN]: taken }, () =>
          c.get("tx").update(company).set(patch).where(eq(company.id, companyId)).returning(columns),
        )
        if (row === undefined) throw problem(404, { detail: GONE })
        return c.json(companyOf(row))
      },
    )
}
