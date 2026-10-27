// The register of Access Credentials (Issue #393, M4 of #293), under
// `customers.site-access`: the plates and cards a project's recycling centres
// admit by. A business's credential names its Customer and the Agreement its
// visits are charged to, which is the Customer's (400 at `agreementId`); a
// household's names a Property of the project. A value is stored as the
// domain normalises it (upper case, no spaces), and one credential of a kind
// and value is in force at a time (`access_credential_no_overlap`, a 409).
//
// A credential is effective-dated (ADR-0005): a patch moves its label and its
// end alone, under its row lock; the kind, the value and the holder are what
// it is. `block` turns its visits away with a reason, `unblock` lets them in
// again; nothing is deleted, since the ledger names the credential each visit
// was read by.
import {
  AccessCredential,
  AccessCredentialBlock,
  AccessCredentialCreate,
  AccessCredentialListQuery,
  AccessCredentialPatch,
  type AccessCredentialKind,
} from "@waste/contracts/site-visits"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { agreement } from "@waste/db/schema/agreements"
import { validOn } from "@waste/db/query/valid-on"
import { accessCredential } from "@waste/db/schema/site-visits"
import { normaliseCredentialValue } from "@waste/domain/visits/charges"
import { and, asc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { periodAfter, periodOf, requireOrdered, requireWithin, type Period } from "./periods"
import { NOT_AN_AGREEMENT, requireCustomer, requireProperty } from "./references"
import { created, describeCreated, describeJson, IdParam, instantOf, lockRow, refuseOverlap, stampsOf } from "./shared"

const MODULE = "customers.site-access"

const CredentialPage = Page(AccessCredential)

const columns = {
  id: accessCredential.id,
  projectId: accessCredential.projectId,
  kind: accessCredential.kind,
  value: accessCredential.value,
  label: accessCredential.label,
  customerId: accessCredential.customerId,
  agreementId: accessCredential.agreementId,
  propertyId: accessCredential.propertyId,
  blockedAt: accessCredential.blockedAt,
  blockedReason: accessCredential.blockedReason,
  validFrom: accessCredential.validFrom,
  validTo: accessCredential.validTo,
  createdAt: accessCredential.createdAt,
  updatedAt: accessCredential.updatedAt,
}

type Row = Pick<typeof accessCredential.$inferSelect, keyof typeof columns>

function credentialOf(row: Row): AccessCredential {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as AccessCredentialKind,
    value: row.value,
    label: row.label,
    customerId: row.customerId,
    agreementId: row.agreementId,
    propertyId: row.propertyId,
    blockedAt: instantOf(row.blockedAt),
    blockedReason: row.blockedReason,
    validFrom: row.validFrom,
    validTo: row.validTo,
    ...stampsOf(row),
  }
}

const RUNNING = "access_credential_no_overlap"
const RUNNING_SENTENCE = "A credential of this kind and number is already in force over part of that period; end it first or register this one after it"

/** What a business credential naming another customer's agreement is told. */
export const NOT_THE_CUSTOMERS_AGREEMENT = "A business's credential is charged to one of its own agreements"
/** What a block of a blocked credential is told. */
export const ALREADY_BLOCKED = "The credential is already blocked; unblock it first to block it for another reason"
/** What an unblock of a credential not blocked is told. */
export const NOT_BLOCKED = "The credential is not blocked"

const noSuchCredential = (id: string) => problem(404, { detail: `No access credential ${id} in the projects this account works in` })

const credentialScope = (principal: Principal) => and(eq(accessCredential.companyId, principal.companyId), inProjects(accessCredential.projectId, principal))

async function findCredential(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(accessCredential)
    .where(and(credentialScope(principal), eq(accessCredential.id, id)))
    .limit(1)
  return row
}

/** What a credential running outside its business's Agreement is told, at the bound. */
export const WITHIN_THE_AGREEMENT = "A business's credential is in force only while the agreement its visits are charged to is"
/** What a credential naming an inactive customer is told. */
export const INACTIVE_HOLDER = "The customer is inactive; a credential needs an active customer"
/** What a credential naming an Agreement that pays for nothing is told. */
export const agreementPaysNothing = (status: string): string => `The agreement is ${status}; a credential's visits are charged to a signed agreement`

/** A business credential's Agreement, read once under the project's fence: the project's (400), its customer's (400), its period, and its status. */
async function customersAgreement(tx: Tx, scope: { companyId: string; projectId: string }, customerId: string, agreementId: string): Promise<{ status: string; period: Period }> {
  const [found] = await tx
    .select({ customerId: agreement.customerId, status: agreement.status, validFrom: agreement.validFrom, validTo: agreement.validTo })
    .from(agreement)
    .where(and(eq(agreement.companyId, scope.companyId), eq(agreement.projectId, scope.projectId), eq(agreement.id, agreementId)))
    .limit(1)
  if (found === undefined) throw invalidRequest("body", [{ path: "agreementId", message: NOT_AN_AGREEMENT }])
  if (found.customerId !== customerId) throw invalidRequest("body", [{ path: "agreementId", message: NOT_THE_CUSTOMERS_AGREEMENT }])
  return { status: found.status, period: { validFrom: found.validFrom, validTo: found.validTo } }
}

const problems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

export function accessCredentialRoutes(guard: MiddlewareHandler<AuthEnv>) {
  const command = (path: "block" | "unblock", summary: string, description: string, conflict: string) =>
    describeRoute({
      operationId: `${path}AccessCredential`,
      summary,
      description,
      security: BEARER_SECURITY,
      responses: {
        200: describeJson("The credential as it now stands.", AccessCredential),
        400: describeProblem(path === "block" ? "The path does not hold an id, or the body gives no reason." : "The path does not hold an id."),
        ...problems("edit"),
        404: describeProblem("No credential with that id in the projects this account works in."),
        409: describeProblem(conflict),
      },
    })

  return new Hono<AuthEnv>()
    .get(
      "/access-credentials",
      describeRoute({
        operationId: "listAccessCredentials",
        summary: "The register of plates and cards",
        description:
          "One page of the Access Credentials a project's recycling centres admit by, oldest first, from the projects the caller works in. `projectId`, `kind`, `customerId` and `propertyId` narrow it; `value` finds a plate or a card as it is stored, spaces dropped and letters upper case; `validOn` asks for those in force on a day; `blocked` for the blocked or the unblocked. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of credentials.", CredentialPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, or `projectId` is not a project this account works in."),
          ...problems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", AccessCredentialListQuery),
      async (c) => {
        const { limit, cursor, projectId, kind, value, customerId, propertyId, validOn: day, blocked } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(columns)
          .from(accessCredential)
          .where(
            and(
              credentialScope(principal),
              projectId === undefined ? undefined : eq(accessCredential.projectId, projectId),
              kind === undefined ? undefined : eq(accessCredential.kind, kind),
              value === undefined ? undefined : eq(accessCredential.value, normaliseCredentialValue(value)),
              customerId === undefined ? undefined : eq(accessCredential.customerId, customerId),
              propertyId === undefined ? undefined : eq(accessCredential.propertyId, propertyId),
              day === undefined ? undefined : validOn(accessCredential, day),
              blocked === undefined ? undefined : blocked ? isNotNull(accessCredential.blockedAt) : isNull(accessCredential.blockedAt),
              after === undefined ? undefined : gt(accessCredential.id, after),
            ),
          )
          .orderBy(asc(accessCredential.id))
          .limit(fetchLimit(limit))
        const page = pageOf(rows, limit)
        return c.json({ ...page, items: page.items.map(credentialOf) })
      },
    )
    .post(
      "/access-credentials",
      describeRoute({
        operationId: "createAccessCredential",
        summary: "Register a plate or a card",
        description:
          "Registers a plate or a card for a project the caller works in (400 at `projectId` otherwise), from a day and to an end or none. Its holder is a business — its Customer, and the Agreement its visits are charged to, one of the Customer's own (400 at `agreementId`) — or a household's Property of the project (400 at `propertyId`), exactly one. The value is stored upper case with no spaces; one credential of a kind and value is in force at a time (409).",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The credential as it was written.", AccessCredential),
          400: describeProblem("The body is missing a field, names a member the server owns, a value that is not a plate or a card number, no holder or two, a period ending on or before it starts, a project this account does not work in, or a customer, agreement or property that is not the project's — or an agreement that is not the customer's."),
          ...problems("create"),
          409: describeProblem("A credential of this kind and value is in force over part of the period."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", AccessCredentialCreate),
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, body.projectId)
        const scope = { companyId: principal.companyId, projectId: body.projectId }
        if (body.propertyId != null) await requireProperty(tx, scope, body.propertyId)
        else if (body.customerId != null && body.agreementId != null) {
          // The body's 400s first — the customer, its agreement, the period inside it — then the two states a new reference is gated on.
          const customerStatus = await requireCustomer(tx, principal.companyId, body.customerId)
          const charged = await customersAgreement(tx, scope, body.customerId, body.agreementId)
          requireWithin(charged.period, periodOf(body), WITHIN_THE_AGREEMENT)
          if (customerStatus !== undefined && customerStatus !== "active") throw problem(409, { detail: INACTIVE_HOLDER })
          if (charged.status !== "active") throw problem(409, { detail: agreementPaysNothing(charged.status) })
        }
        const [row] = await refuseOverlap({ [RUNNING]: RUNNING_SENTENCE }, () =>
          tx
            .insert(accessCredential)
            .values({
              id: newId(),
              companyId: principal.companyId,
              projectId: body.projectId,
              kind: body.kind,
              value: normaliseCredentialValue(body.value),
              label: body.label ?? null,
              customerId: body.customerId ?? null,
              agreementId: body.agreementId ?? null,
              propertyId: body.propertyId ?? null,
              validFrom: body.validFrom,
              validTo: body.validTo ?? null,
            })
            .returning(columns),
        )
        return created(c, "/access-credentials", credentialOf(row))
      },
    )
    .get(
      "/access-credentials/:id",
      describeRoute({
        operationId: "getAccessCredential",
        summary: "One plate or card",
        description: "One credential of a project the caller works in. A credential of another company, or of a project this account does not work in, is one that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The credential.", AccessCredential),
          400: describeProblem("The path does not hold an id."),
          ...problems("view"),
          404: describeProblem("No credential with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findCredential(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchCredential(id)
        return c.json(credentialOf(row))
      },
    )
    .patch(
      "/access-credentials/:id",
      describeRoute({
        operationId: "patchAccessCredential",
        summary: "Amend or end a plate or a card",
        description:
          "Changes the label or the end of one credential, under its row lock; every field is optional and at least one must be given. The kind, the value, the holder and the start are what the credential is, so another plate, another holder or another start is another credential, and this one is ended on the day the other starts. The end still comes after the start (400 on `validTo`), and the credential still overlaps no other of its kind and value (409).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The credential as it now stands.", AccessCredential),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own, or ends on or before the day the credential starts."),
          ...problems("edit"),
          404: describeProblem("No credential with that id in the projects this account works in."),
          409: describeProblem("A credential of this kind and value is in force over part of the new period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", AccessCredentialPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const fields = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockRow(tx, accessCredential, { companyId: principal.companyId, id })
        const current = await findCredential(tx, principal, id)
        if (current === undefined) throw noSuchCredential(id)
        const period = periodAfter(current, fields)
        requireOrdered(period)
        // A business's credential stays inside its Agreement's period, which an end moved past it would leave.
        if (current.customerId !== null && current.agreementId !== null && fields.validTo !== undefined) {
          requireWithin((await customersAgreement(tx, { companyId: principal.companyId, projectId: current.projectId }, current.customerId, current.agreementId)).period, period, WITHIN_THE_AGREEMENT)
        }
        const [row] = await refuseOverlap({ [RUNNING]: RUNNING_SENTENCE }, () =>
          tx
            .update(accessCredential)
            .set(fields)
            .where(and(credentialScope(principal), eq(accessCredential.id, id)))
            .returning(columns),
        )
        return c.json(credentialOf(row))
      },
    )
    .post(
      "/access-credentials/:id/block",
      command("block", "Block a plate or a card", "Blocks one credential with the reason the office will read: its visits are turned away as `credential-blocked` and still recorded. A blocked credential is unblocked before it is blocked for another reason (409).", "The credential is already blocked."),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", AccessCredentialBlock),
      async (c) => {
        const { id } = c.req.valid("param")
        const { reason } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockRow(tx, accessCredential, { companyId: principal.companyId, id })
        const current = await findCredential(tx, principal, id)
        if (current === undefined) throw noSuchCredential(id)
        if (current.blockedAt !== null) throw problem(409, { detail: ALREADY_BLOCKED })
        const [row] = await tx
          .update(accessCredential)
          .set({ blockedAt: sql`now()`, blockedReason: reason })
          .where(and(credentialScope(principal), eq(accessCredential.id, id)))
          .returning(columns)
        return c.json(credentialOf(row))
      },
    )
    .post(
      "/access-credentials/:id/unblock",
      command("unblock", "Unblock a plate or a card", "Lets one blocked credential's visits in again; the block's reason stays in the credential's history (409 where it is not blocked).", "The credential is not blocked."),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockRow(tx, accessCredential, { companyId: principal.companyId, id })
        const current = await findCredential(tx, principal, id)
        if (current === undefined) throw noSuchCredential(id)
        if (current.blockedAt === null) throw problem(409, { detail: NOT_BLOCKED })
        const [row] = await tx
          .update(accessCredential)
          .set({ blockedAt: null, blockedReason: null })
          .where(and(credentialScope(principal), eq(accessCredential.id, id)))
          .returning(columns)
        return c.json(credentialOf(row))
      },
    )
}
