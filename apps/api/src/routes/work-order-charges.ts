// A project's work order charges (M14 of #293): the product each of the
// office's work orders — a delivery, a removal, a swap, a repair, a wash — is
// charged at when the driver completes it, read and replaced whole as the
// project's set under the Products module, as its ticket charges are (#291
// C3, ticket-charges.ts). The Finance consumer reads it when a completed work
// order's event arrives (apps/worker/src/jobs/finance-facts.ts) and records a
// `job` event at the product; a service the set names none for is charged
// nothing, and a work order booked to answer a ticket never is (O3c of #290).
// It is not effective-dated, so an event already recorded keeps its product.
//
// A product the set names is a product of the project (400 at its path) sold
// by the job (400) and offered (409, the #79 gate) — on a new or a changed
// entry alone, since a status gates a new reference and never an existing one
// (routes/statuses.ts). `reprice` holds the product a blocked job's body
// names to the same rules (`requireJobProduct`).
import { WorkOrderCharges, WorkOrderChargesQuery, WorkOrderChargesSet, type WorkOrderCharge } from "@waste/contracts/work-order-charges"
import type { Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { workOrderProduct } from "@waste/db/schema/finance"
import { project } from "@waste/db/schema/organisation"
import { WORK_ORDER_SERVICES, type WorkOrderService } from "@waste/domain/execution/vocabulary"
import type { ProductStatus } from "@waste/domain/registry/vocabulary"
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

/** A work order's job is charged at a product sold by the job (M14 of #293). */
export const A_JOB_IS_SOLD_BY_THE_JOB = "A work order's job is charged at a product sold by the job"

/**
 * A product a work order is charged at, as a body names it: a product of the
 * project (400) sold by the job (400). Answers its status, which the caller
 * gates with `refuseUnofferedProduct` once every 400 is asked.
 */
export async function requireJobProduct(tx: Tx, scope: Scope, id: string, path = "productId"): Promise<ProductStatus> {
  const [found] = await tx
    .select({ status: product.status, unit: product.unit })
    .from(product)
    .where(and(eq(product.companyId, scope.companyId), eq(product.projectId, scope.projectId), eq(product.id, id)))
    .limit(1)
  if (found === undefined) throw invalidRequest("body", [{ path, message: NOT_A_PRODUCT }])
  if (found.unit !== "job") throw invalidRequest("body", [{ path, message: A_JOB_IS_SOLD_BY_THE_JOB }])
  return found.status as ProductStatus
}

/** A project's work order charges, in the services' order. */
async function chargesOf(tx: Tx, scope: Scope): Promise<WorkOrderCharges> {
  const rows = await tx
    .select({ service: workOrderProduct.service, productId: workOrderProduct.productId })
    .from(workOrderProduct)
    .where(and(eq(workOrderProduct.companyId, scope.companyId), eq(workOrderProduct.projectId, scope.projectId)))
  const order = (service: string) => WORK_ORDER_SERVICES.indexOf(service as WorkOrderService)
  const charges: WorkOrderCharge[] = rows.map((row) => ({ service: row.service as WorkOrderService, productId: row.productId })).sort((a, b) => order(a.service) - order(b.service))
  return { projectId: scope.projectId, charges }
}

const problems = (action: "view" | "edit") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

export function workOrderProductRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/work-order-charges",
      describeRoute({
        operationId: "getWorkOrderCharges",
        summary: "A project's work order charges",
        description:
          "The product each office work order's service is charged at when the driver completes it (M14 of #293), a service at most once, in the services' order: what the Finance consumer prices a completed work order's `job` event at, while the product is sold by the job and offered. A service not listed is charged nothing, and a work order booked to answer a ticket never is: the ticket's charge is the one. `projectId` is a project the caller works in (400 on the query otherwise).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The project's work order charges.", WorkOrderCharges),
          400: describeProblem("`projectId` is missing, malformed, or not a project this account works in."),
          ...problems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", WorkOrderChargesQuery),
      async (c) => {
        const { projectId } = c.req.valid("query")
        const principal = c.get("principal")
        requireProject(principal, projectId, "projectId", "query")
        return c.json(await chargesOf(c.get("tx"), { companyId: principal.companyId, projectId }))
      },
    )
    .put(
      "/work-order-charges",
      describeRoute({
        operationId: "putWorkOrderCharges",
        summary: "Replace a project's work order charges",
        description:
          "Replaces the project's whole set with the body's: a service the body leaves out is charged nothing afterwards, and an empty list charges no work order. Each service once (400 on `products`); each product a product of the project (400 at `products.N.productId`, `Not a product of this project`), sold by the job (400, `A work order's job is charged at a product sold by the job`), and offered (409, `The product is inactive; …`) on an entry that is new or names another product than it did; an entry restated as it stands is no new reference and is not gated. Under the project's row lock, so two replacements take turns. Events already recorded keep their product. Every row written is audited under the request's principal, a set of its project.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The project's work order charges as they now stand.", WorkOrderCharges),
          400: describeProblem("The body names a member the command does not take, a service twice, a project this account does not work in, a product that is not the project's, or a product not sold by the job."),
          ...problems("edit"),
          409: describeProblem("A new or changed entry names a product that is not offered."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("json", WorkOrderChargesSet),
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, body.projectId)
        const scope: Scope = { companyId: principal.companyId, projectId: body.projectId }
        await lockRow(tx, project, { companyId: scope.companyId, id: scope.projectId })
        const current = new Map((await chargesOf(tx, scope)).charges.map((entry) => [entry.service, entry.productId]))
        // The 400s in body order, then the gate on what is new or changed.
        const statuses = new Map<string, ProductStatus>()
        for (const [index, entry] of body.charges.entries()) statuses.set(entry.service, await requireJobProduct(tx, scope, entry.productId, `charges.${index}.productId`))
        for (const entry of body.charges) if (current.get(entry.service) !== entry.productId) refuseUnofferedProduct(statuses.get(entry.service))

        const named = new Set(body.charges.map((entry) => entry.service as string))
        const leftOut = [...current.keys()].filter((service) => !named.has(service))
        const fenced = and(eq(workOrderProduct.companyId, scope.companyId), eq(workOrderProduct.projectId, scope.projectId))
        if (leftOut.length > 0) await tx.delete(workOrderProduct).where(and(fenced, inArray(workOrderProduct.service, leftOut)))
        for (const entry of body.charges) {
          const before = current.get(entry.service)
          if (before === entry.productId) continue
          if (before === undefined) await tx.insert(workOrderProduct).values({ id: newId(), ...scope, service: entry.service, productId: entry.productId })
          else await tx.update(workOrderProduct).set({ productId: entry.productId }).where(and(fenced, eq(workOrderProduct.service, entry.service)))
        }
        return c.json(await chargesOf(tx, scope))
      },
    )
}
