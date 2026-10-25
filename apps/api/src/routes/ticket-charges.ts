// A project's ticket charges (#291 C3): the product each ticket kind's work
// is charged at when a completion names none, read and replaced whole as the
// project's set under the Products module, since it is the catalogue's word
// on what the work costs. The Finance consumer reads it when a completed
// ticket's event arrives (apps/worker/src/jobs/finance-facts.ts); it is not
// effective-dated, so an event already recorded keeps its product.
//
// A product a charge names is a product of the project (400 at its path),
// never one sold by the month, which is a recurring charge and not a ticket's
// work (400), and offered (409, the #79 gate) — on a new or a changed charge
// alone, since a status gates a new reference and never an existing one
// (routes/statuses.ts): a set restated with a product retired since is no new
// reference to it. `complete` holds the product its body names to the same
// three rules (`requireTicketWorkProduct`), and `reprice` a ticket's event's.
import { TicketCharges, TicketChargesQuery, TicketChargesSet, type TicketCharge } from "@waste/contracts/tickets"
import type { Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { ticketKindProduct } from "@waste/db/schema/finance"
import { project } from "@waste/db/schema/organisation"
import type { ProductStatus } from "@waste/domain/registry/vocabulary"
import { TICKET_KINDS, type TicketKind } from "@waste/domain/resolution/vocabulary"
import { and, eq, inArray } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { describeProblem, invalidRequest, validate } from "../problem"
import { NOT_A_PRODUCT, type Scope } from "./references"
import { describeJson, lockRow } from "./shared"
import { refuseUnofferedProduct } from "./statuses"

const MODULE = "commercial.products"

/** What a ticket's charge naming a product sold by the month is told. */
export const MONTH_PRODUCT_IS_NOT_TICKET_WORK = "A product sold by the month is a recurring charge; a ticket's work is charged per job or per pickup"

/**
 * A product a ticket's work is charged at, as a body names it: a product of
 * the project (400) not sold by the month (400). Answers its status, which
 * the caller gates with `refuseUnofferedProduct` once every 400 is asked.
 */
export async function requireTicketWorkProduct(tx: Tx, scope: Scope, id: string, path = "productId"): Promise<ProductStatus> {
  const [found] = await tx
    .select({ status: product.status, unit: product.unit })
    .from(product)
    .where(and(eq(product.companyId, scope.companyId), eq(product.projectId, scope.projectId), eq(product.id, id)))
    .limit(1)
  if (found === undefined) throw invalidRequest("body", [{ path, message: NOT_A_PRODUCT }])
  if (found.unit === "month") throw invalidRequest("body", [{ path, message: MONTH_PRODUCT_IS_NOT_TICKET_WORK }])
  return found.status as ProductStatus
}

/** A project's charges, in the kinds' order. */
async function chargesOf(tx: Tx, scope: Scope): Promise<TicketCharges> {
  const rows = await tx
    .select({ kind: ticketKindProduct.ticketKind, productId: ticketKindProduct.productId })
    .from(ticketKindProduct)
    .where(and(eq(ticketKindProduct.companyId, scope.companyId), eq(ticketKindProduct.projectId, scope.projectId)))
  const order = (kind: string) => TICKET_KINDS.indexOf(kind as TicketKind)
  const charges: TicketCharge[] = rows.map((row) => ({ kind: row.kind as TicketKind, productId: row.productId })).sort((a, b) => order(a.kind) - order(b.kind))
  return { projectId: scope.projectId, charges }
}

const problems = (action: "view" | "edit") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

export function ticketChargeRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/ticket-charges",
      describeRoute({
        operationId: "getTicketCharges",
        summary: "A project's ticket charges",
        description:
          "The product each ticket kind's work is charged at when a completion names none (#291 C3), a kind at most once, in the kinds' order: what the Finance consumer prices a completed ticket's event at, `recollected` or `serviced`, while the product is offered. A kind not listed is charged at nothing, and its tickets' events wait `no-product` for the office's product. `projectId` is a project the caller works in (400 on the query otherwise).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The project's charges.", TicketCharges),
          400: describeProblem("`projectId` is missing, malformed, or not a project this account works in."),
          ...problems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", TicketChargesQuery),
      async (c) => {
        const { projectId } = c.req.valid("query")
        const principal = c.get("principal")
        requireProject(principal, projectId, "projectId", "query")
        return c.json(await chargesOf(c.get("tx"), { companyId: principal.companyId, projectId }))
      },
    )
    .put(
      "/ticket-charges",
      describeRoute({
        operationId: "putTicketCharges",
        summary: "Replace a project's ticket charges",
        description:
          "Replaces the project's whole set of charges with the body's: a kind the body leaves out is charged at nothing afterwards, and an empty list charges no kind. Each kind once (400 on `charges`); each product a product of the project (400 at `charges.N.productId`, `Not a product of this project`), never one sold by the month — a recurring charge, not a ticket's work (400, `A product sold by the month is a recurring charge; a ticket's work is charged per job or per pickup`) — and offered (409, `The product is inactive; …`) on a charge that is new or names another product than it did; a charge restated as it stands is no new reference and is not gated. Under the project's row lock, so two replacements take turns. Events already recorded keep their product. Every row written is audited under the request's principal, a set of its project.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The project's charges as they now stand.", TicketCharges),
          400: describeProblem("The body names a member the command does not take, a kind twice, a project this account does not work in, a product that is not the project's, or a product sold by the month."),
          ...problems("edit"),
          409: describeProblem("A new or changed charge names a product that is not offered."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("json", TicketChargesSet),
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, body.projectId)
        const scope: Scope = { companyId: principal.companyId, projectId: body.projectId }
        await lockRow(tx, project, { companyId: scope.companyId, id: scope.projectId })
        const current = new Map((await chargesOf(tx, scope)).charges.map((charge) => [charge.kind, charge.productId]))
        // The 400s in body order, then the gate on what is new or changed.
        const statuses = new Map<string, ProductStatus>()
        for (const [index, charge] of body.charges.entries()) statuses.set(charge.kind, await requireTicketWorkProduct(tx, scope, charge.productId, `charges.${index}.productId`))
        for (const charge of body.charges) if (current.get(charge.kind) !== charge.productId) refuseUnofferedProduct(statuses.get(charge.kind))

        const named = new Set(body.charges.map((charge) => charge.kind as string))
        const leftOut = [...current.keys()].filter((kind) => !named.has(kind))
        const fenced = and(eq(ticketKindProduct.companyId, scope.companyId), eq(ticketKindProduct.projectId, scope.projectId))
        if (leftOut.length > 0) await tx.delete(ticketKindProduct).where(and(fenced, inArray(ticketKindProduct.ticketKind, leftOut)))
        for (const charge of body.charges) {
          const before = current.get(charge.kind)
          if (before === charge.productId) continue
          if (before === undefined) await tx.insert(ticketKindProduct).values({ id: newId(), ...scope, ticketKind: charge.kind, productId: charge.productId })
          else await tx.update(ticketKindProduct).set({ productId: charge.productId }).where(and(fenced, eq(ticketKindProduct.ticketKind, charge.kind)))
        }
        return c.json(await chargesOf(tx, scope))
      },
    )
}
