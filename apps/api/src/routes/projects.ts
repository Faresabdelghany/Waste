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
// → Company & Projects is one surface. A project's privacy policy (#291 C19)
// is read with the project and written whole through its own route,
// `PUT /projects/:id/privacy-policy`, under `configure.privacy`: who may say
// how long personal data is kept is the privacy module's grant, not the
// project editor's. A project's branding on its public pages (M22 of #293)
// is read with the project and written whole through its own route,
// `PUT /projects/:id/branding`, under `configure.portals`: Settings ›
// Portals & branding is that module's surface.
import type { PaymentReferenceScheme } from "@waste/contracts/finance"
import { type GpsPurpose, PrivacyPolicy, Project, ProjectBranding, ProjectBrandingReplace, ProjectCreate, ProjectPatch, type ProjectStatus } from "@waste/contracts/organisation"
import { Page, PageRequest } from "@waste/contracts/pagination"
import type { ServiceDay } from "@waste/contracts/planning"
import type { Tx } from "@waste/db/client"
import { company, project } from "@waste/db/schema/organisation"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { projectCalendarOf, releaseHolidayHolds } from "./route-holds"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseDuplicate, stampsOf } from "./shared"

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
  weekend: project.weekend,
  holidayList: project.holidayList,
  publicSlug: project.publicSlug,
  paymentTermsDays: project.paymentTermsDays,
  paymentReferenceScheme: project.paymentReferenceScheme,
  weightTolerancePercent: project.weightTolerancePercent,
  holdForReview: project.holdForReview,
  positionRetentionDays: project.positionRetentionDays,
  proofRetentionDays: project.proofRetentionDays,
  gpsPurpose: project.gpsPurpose,
  brandColor: project.brandColor,
  logoUrl: project.logoUrl,
  accessibilityStatementUrl: project.accessibilityStatementUrl,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
}

type Row = Pick<typeof project.$inferSelect, keyof typeof columns>

/** The row on the wire. `status` is text with a CHECK in the database and this enum here; packages/db holds the two lists in lockstep. `weekend` is a `text[]` held to the seven by the same tuple the enum reads. */
function projectOf(row: Row): Project {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    language: row.language,
    currency: row.currency,
    timezone: row.timezone,
    status: row.status as ProjectStatus,
    weekend: row.weekend as ServiceDay[],
    holidayList: row.holidayList,
    publicSlug: row.publicSlug,
    paymentTermsDays: row.paymentTermsDays,
    paymentReferenceScheme: row.paymentReferenceScheme as PaymentReferenceScheme,
    weightTolerancePercent: row.weightTolerancePercent,
    holdForReview: row.holdForReview,
    privacyPolicy: privacyPolicyOf(row),
    branding: brandingOf(row),
    ...stampsOf(row),
  }
}

/** The policy's four columns on the wire; null each is no policy of its own. */
function privacyPolicyOf(row: Pick<Row, "positionRetentionDays" | "proofRetentionDays" | "gpsPurpose">): PrivacyPolicy {
  return {
    positionRetentionDays: row.positionRetentionDays,
    proofRetentionDays: row.proofRetentionDays,
    gpsPurpose: row.gpsPurpose as GpsPurpose | null,
  }
}

/** The module whose `edit` writes a project's privacy policy (#291 C19). */
const PRIVACY_MODULE = "configure.privacy"

/** The branding's three columns on the wire; null each is none. */
const brandingOf = (row: Pick<Row, "brandColor" | "logoUrl" | "accessibilityStatementUrl">): ProjectBranding => ({
  brandColor: row.brandColor,
  logoUrl: row.logoUrl,
  accessibilityStatementUrl: row.accessibilityStatementUrl,
})

/** The module whose `edit` writes a project's branding (M22 of #293). */
const PORTALS_MODULE = "configure.portals"

/** What a project moved to a FI card's scheme is told while its company has no creditor number (#291 C4). */
export const NO_FIK_CREDITOR = "Set the company's FIK creditor number first: a FI card names it"

/** A FI card's scheme names the company's creditor number (#291 C4): asked under the company's row lock, which clearing the number takes too, so the two take turns. */
async function requireFikCreditor(tx: Tx, companyId: string, scheme: PaymentReferenceScheme | undefined): Promise<void> {
  if (scheme === undefined || scheme === "none") return
  await lockRow(tx, company, { companyId, id: companyId })
  const [found] = await tx.select({ creditor: company.fikCreditorNumber }).from(company).where(eq(company.id, companyId)).limit(1)
  if (found === undefined || found.creditor === null) throw problem(409, { detail: NO_FIK_CREDITOR })
}

/** `unique (company_id, name)`: a name is one project's inside a company, and free in the next. */
const NAME_TAKEN = "project_name_key"
const nameTaken = (name: string) => `This company already has a project called ${JSON.stringify(name)}`

/** `unique (public_slug)`, across every company (ADR-0010): one public address names one project. The sentence names no other company, since the slug is the one thing about that project anyone may know. */
const SLUG_TAKEN = "project_public_slug_key"
const slugTaken = (slug: string) => `Another project already publishes itself as ${JSON.stringify(slug)}; choose another slug`

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
        description:
          "Creates a project in the caller's company. The server mints the id; a body that carries one is refused. `weekend` is the days the project rests on, each named once — Saturday and Sunday unless the body says otherwise, Friday and Saturday for a project in Cairo — and `holidayList` the name its holidays are looked up under (`Danish public holidays`); null or absent is no list, and a project without one rests on its weekend only, whatever collection calendars it has. `paymentTermsDays` is the days after issue its invoices are due, 0 to 365, 30 unless the body says otherwise, a customer's own terms standing in for theirs, and `paymentReferenceScheme` how they are referenced for payment, `none` unless said: a FI card's (`fik-71`, `fik-75`) needs the company's creditor number (409, `Set the company's FIK creditor number first: a FI card names it`) (#291 C4).",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The project as it was written.", Project),
          400: describeProblem("The body is missing a field, holds a value of the wrong shape, or names one the server owns."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `configure.organization`."),
          409: describeProblem("The company already has a project with that name, or a FI card's scheme is named while the company has no creditor number."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", ProjectCreate),
      async (c) => {
        const values = c.req.valid("json")
        await requireFikCreditor(c.get("tx"), c.get("principal").companyId, values.paymentReferenceScheme)
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
        description:
          "Changes one project of the caller's company; every field is optional and at least one must be given. `weekend` replaces the days the project rests on with the list given, each of the seven named at most once; `holidayList` renames the list its holidays are looked up under, or as null takes it away, and a project without one rests on its weekend only, whatever collection calendars it has. A change of `weekend`, or a `holidayList` set or taken away (a rename changes no day), releases in the same transaction the hold on each route the office moved by hand (`heldAt`) that the change re-decides — one standing where its scheme put the collection, when the change moves or skips that collection, and one the office moved to a day the change makes a holiday its scheme moves collections off — so the next generation run plans them with their neighbours (#226). `publicSlug` publishes the project on the public door under that name (`GET /public/<slug>`, ADR-0010), unique across every company; null unpublishes it: its public pages answer 404 from the next request, and an answer someone cached before (they may keep one for a minute) runs out within that minute. `paymentTermsDays` and `paymentReferenceScheme` (#291 C4) date and reference the invoices its next run issues — an issued invoice keeps its own — and a FI card's scheme needs the company's creditor number (409, `Set the company's FIK creditor number first: a FI card names it`), under the company's row lock; `weightTolerancePercent` is how far a weighbridge's net may differ from what the stops weighed on board before an unload reads as above tolerance, in whole percent from 1 to 100 (5 when a project is made without one).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The project as it now stands.", Project),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own, holds a value of the wrong shape, or names a weekend day outside the seven or twice."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.organization`."),
          404: describeProblem("No project with that id in this company."),
          409: describeProblem("The company already has another project with that name, another project already publishes itself under that slug, or a FI card's scheme is named while the company has no creditor number."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ProjectPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const companyId = c.get("principal").companyId
        if (patch.paymentReferenceScheme !== undefined && patch.paymentReferenceScheme !== "none") {
          // The path's row first (404), then the 409 the body's scheme needs.
          const [found] = await tx.select({ id: project.id }).from(project).where(and(eq(project.companyId, companyId), eq(project.id, id))).limit(1)
          if (found === undefined) throw noSuchProject(id)
          await requireFikCreditor(tx, companyId, patch.paymentReferenceScheme)
        }
        const sentences: Record<string, string> = {
          ...(patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }),
          ...(patch.publicSlug == null ? {} : { [SLUG_TAKEN]: slugTaken(patch.publicSlug) }),
        }
        // The holiday inputs as they stand before the patch, where it changes them (#226): `holidayList` matters by whether it is set.
        const holidayInputs = patch.weekend !== undefined || patch.holidayList !== undefined ? await projectCalendarOf(tx, companyId, id) : undefined
        const [row] = await refuseDuplicate(sentences, () =>
          c
            .get("tx")
            .update(project)
            .set(patch)
            .where(and(eq(project.companyId, c.get("principal").companyId), eq(project.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchProject(id)
        // The held routes the new weekend or list re-decides go back to their schemes (routes/route-holds.ts).
        if (holidayInputs !== undefined) await releaseHolidayHolds(tx, companyId, id, { before: holidayInputs, after: await projectCalendarOf(tx, companyId, id) })
        return c.json(projectOf(row))
      },
    )
    .put(
      "/projects/:id/privacy-policy",
      describeRoute({
        operationId: "replaceProjectPrivacyPolicy",
        summary: "Set a project's privacy policy",
        description:
          "Replaces one project's privacy policy whole (#291 C19): the days its drivers' positions (1 to 30) and its stops' photos and signatures (1 to 3650) are kept, and the purpose its vehicles' positions are recorded for (`dispatch`, `dispatch-and-proof`). A null is no policy of the project's own for that kind: the deployment's setting stands, as before policies (`POSITION_RETENTION_DAYS`, `PROOF_RETENTION_DAYS`), and a photo with neither is kept for good. The worker's nightly purges read the days project by project, so a shorter period takes effect the next night. Read back as the project's `privacyPolicy`; every change is in the project's audit history.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The policy as it now stands.", PrivacyPolicy),
          400: describeProblem("The path does not hold an id, or the body is missing a field, names one the server does not take, or holds days outside a kind's bounds or a purpose outside the vocabulary."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`edit\` on \`${PRIVACY_MODULE}\`.`),
          404: describeProblem("No project with that id in this company."),
        },
      }),
      guard,
      requireGrant(PRIVACY_MODULE, "edit"),
      validate("param", IdParam),
      validate("json", PrivacyPolicy),
      async (c) => {
        const { id } = c.req.valid("param")
        const policy = c.req.valid("json")
        const companyId = c.get("principal").companyId
        const [row] = await c
          .get("tx")
          .update(project)
          .set(policy)
          .where(and(eq(project.companyId, companyId), eq(project.id, id)))
          .returning(columns)
        if (row === undefined) throw noSuchProject(id)
        return c.json(privacyPolicyOf(row))
      },
    )
    .put(
      "/projects/:id/branding",
      describeRoute({
        operationId: "replaceProjectBranding",
        summary: "Set a project's branding",
        description:
          "Replaces one project's branding on its public pages whole (M22 of #293): `brandColor`, a colour as `#RRGGBB` drawn behind white text, refused unless white text on it meets WCAG 2.1 AA's contrast for normal text (4.5 to 1); `logoUrl`, an image the project serves itself; and `accessibilityStatementUrl`, the statement it publishes (in Denmark, through Digitaliseringsstyrelsen's WAS tool) — each address https. A null is none: the public pages look as they do unbranded, and name no statement. Read back as the project's `branding`; every change is in the project's audit history.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The branding as it now stands.", ProjectBranding),
          400: describeProblem("The path does not hold an id, or the body is missing a field, names one the server does not take, holds a colour that is not `#RRGGBB` or that white text cannot be read on at WCAG 2.1 AA, or an address that is not https."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`edit\` on \`${PORTALS_MODULE}\`.`),
          404: describeProblem("No project with that id in this company."),
        },
      }),
      guard,
      requireGrant(PORTALS_MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ProjectBrandingReplace),
      async (c) => {
        const { id } = c.req.valid("param")
        const branding = c.req.valid("json")
        const companyId = c.get("principal").companyId
        const [row] = await c
          .get("tx")
          .update(project)
          .set(branding)
          .where(and(eq(project.companyId, companyId), eq(project.id, id)))
          .returning(columns)
        if (row === undefined) throw noSuchProject(id)
        return c.json(brandingOf(row))
      },
    )
}
