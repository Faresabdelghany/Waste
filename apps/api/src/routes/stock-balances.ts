// A warehouse's stock (O30 of #290, row 9.8): how many containers of each
// type stand in a warehouse, and the office's Stock Minimum for the type.
//
// `GET /stock-balances` counts, never stores: each container's latest Stock
// Movement (the Container Asset State, @waste/db/query/asset-state) is where
// it stands, so a container counts at a warehouse where its latest movement
// arrived there, in stock or in maintenance. The count is joined with the
// minimums by @waste/domain/resources/stock-balance, so a type the office
// wants and has none of still reads, as zero and below its minimum. The
// answer is one list, not a page: it is bounded by the warehouses and the
// types, and a page cursor over a count has nothing to stand on. It reads
// under `resources.inventory`, the ledger's module.
//
// `GET`/`PUT /warehouses/:id/stock-minimums` read and replace a warehouse's
// minimums, a set under the warehouse's own module, `resources.warehouses`,
// whole as every set of this API is: the warehouse first (404), under its row
// lock so two replacements of one set queue, then each type the company's
// (400 at the entry), then the rows deleted and the body's written.
import type { StockBalance } from "@waste/contracts/stock"
import { StockBalanceQuery, StockBalances, StockMinimums, StockMinimumsSet } from "@waste/contracts/stock"
import type { Tx } from "@waste/db/client"
import { assetStateOf } from "@waste/db/query/asset-state"
import { containerType } from "@waste/db/schema/catalogue"
import { container } from "@waste/db/schema/containers"
import { warehouse } from "@waste/db/schema/places"
import { stockMinimum } from "@waste/db/schema/stock"
import { stockBalances } from "@waste/domain/resources/stock-balance"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, projectIdsOf, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { describeProblem, problem, validate } from "../problem"
import { requireContainerType, requireWarehouse } from "./references"
import { eachPresent } from "./sets"
import { describeJson, IdParam, lockRow } from "./shared"

const INVENTORY = "resources.inventory"
const WAREHOUSES = "resources.warehouses"

const noSuchWarehouse = (id: string) => problem(404, { detail: `No warehouse ${id} in the projects this account works in` })

/** One warehouse of this company by id, inside the caller's projects: its project, or undefined. */
async function findWarehouse(tx: Tx, principal: Principal, id: string): Promise<{ id: string; projectId: string } | undefined> {
  const [row] = await tx
    .select({ id: warehouse.id, projectId: warehouse.projectId })
    .from(warehouse)
    .where(and(eq(warehouse.companyId, principal.companyId), inProjects(warehouse.projectId, principal), eq(warehouse.id, id)))
    .limit(1)
  return row
}

/** A warehouse's minimums as they stand, in the order they were written. */
async function minimumsOf(tx: Tx, companyId: string, warehouseId: string): Promise<StockMinimums> {
  const rows = await tx
    .select({ containerTypeId: stockMinimum.containerTypeId, minimum: stockMinimum.minimum })
    .from(stockMinimum)
    .where(and(eq(stockMinimum.companyId, companyId), eq(stockMinimum.warehouseId, warehouseId)))
    .orderBy(asc(stockMinimum.id))
  return { warehouseId, minimums: rows }
}

export function stockBalanceRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/stock-balances",
      describeRoute({
        operationId: "listStockBalances",
        summary: "What stands in the warehouses, by container type, against the minimums",
        description:
          "For every warehouse and container type of the projects the caller works in that holds a container or has a Stock Minimum: the containers there by the ledger's projection — in stock, and in maintenance there — the minimum or null, and whether the stock is below it. A container in maintenance is not stock the office can issue, so it does not count towards the minimum. `projectId` narrows it to one of those projects, `warehouseId` to one warehouse; naming another is refused. Ordered by warehouse, then type; one answer, no page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The balances.", StockBalances),
          400: describeProblem("The query names a member it does not carry, `projectId` is not a project this account works in, or `warehouseId` is not a warehouse of one."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `resources.inventory`."),
        },
      }),
      guard,
      requireGrant(INVENTORY, "view"),
      validate("query", StockBalanceQuery),
      async (c) => {
        const { projectId, warehouseId } = c.req.valid("query")
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        if (warehouseId !== undefined) {
          await requireWarehouse(tx, { companyId: principal.companyId, projectId: projectId ?? projectIdsOf(principal) }, warehouseId, "warehouseId", "query")
        }
        const state = assetStateOf(tx, principal.companyId, container.id)
        const counts = await tx
          .select({
            projectId: container.projectId,
            warehouseId: sql<string>`${state.toWarehouseId}`,
            containerTypeId: container.containerTypeId,
            inWarehouse: sql<number>`(count(*) filter (where ${state.toKind} = 'warehouse'))::int`,
            inMaintenance: sql<number>`(count(*) filter (where ${state.toKind} = 'maintenance'))::int`,
          })
          .from(container)
          .leftJoinLateral(state, sql`true`)
          .where(
            and(
              eq(container.companyId, principal.companyId),
              inProjects(container.projectId, principal),
              projectId === undefined ? undefined : eq(container.projectId, projectId),
              inArray(state.toKind, ["warehouse", "maintenance"]),
              warehouseId === undefined ? undefined : eq(state.toWarehouseId, warehouseId),
            ),
          )
          .groupBy(container.projectId, state.toWarehouseId, container.containerTypeId)
        const minimums = await tx
          .select({ projectId: stockMinimum.projectId, warehouseId: stockMinimum.warehouseId, containerTypeId: stockMinimum.containerTypeId, minimum: stockMinimum.minimum })
          .from(stockMinimum)
          .where(
            and(
              eq(stockMinimum.companyId, principal.companyId),
              inProjects(stockMinimum.projectId, principal),
              projectId === undefined ? undefined : eq(stockMinimum.projectId, projectId),
              warehouseId === undefined ? undefined : eq(stockMinimum.warehouseId, warehouseId),
            ),
          )
        const items: StockBalance[] = stockBalances(counts, minimums)
        return c.json({ items })
      },
    )
    .get(
      "/warehouses/:id/stock-minimums",
      describeRoute({
        operationId: "getWarehouseStockMinimums",
        summary: "A warehouse's stock minimums",
        description: "The fewest containers of each type the office wants the warehouse to hold in stock, in the order they were written. A type with no minimum is not listed.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The warehouse's minimums.", StockMinimums),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `resources.warehouses`."),
          404: describeProblem("No warehouse with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(WAREHOUSES, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        if ((await findWarehouse(tx, principal, id)) === undefined) throw noSuchWarehouse(id)
        return c.json(await minimumsOf(tx, principal.companyId, id))
      },
    )
    .put(
      "/warehouses/:id/stock-minimums",
      describeRoute({
        operationId: "putWarehouseStockMinimums",
        summary: "Replace a warehouse's stock minimums",
        description:
          "Replaces the whole set of minimums with the one in the body: a type the body leaves out has no minimum afterwards, and an empty list clears them all. Each entry names a container type of this company (400 at `minimums.N.containerTypeId` otherwise), once (400 on `minimums`), with a positive count; no minimum is no entry, never a zero. Nothing is alerted or ordered from it: `GET /stock-balances` reads the stock against it.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The warehouse's minimums as they now stand.", StockMinimums),
          400: describeProblem("The path does not hold an id, or the body is missing `minimums`, names a member it does not own, names a type twice or one that is not this company's, or gives a count that is not a positive whole number."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `resources.warehouses`."),
          404: describeProblem("No warehouse with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(WAREHOUSES, "edit"),
      validate("param", IdParam),
      validate("json", StockMinimumsSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { minimums } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        // The parent's lock queues two replacements of one set; an id nobody minted locks nothing and is the 404 below.
        await lockRow(tx, warehouse, { companyId: principal.companyId, id })
        const found = await findWarehouse(tx, principal, id)
        if (found === undefined) throw noSuchWarehouse(id)
        await eachPresent(
          tx,
          containerType,
          containerType.id,
          principal.companyId,
          minimums.map((entry, n) => ({ path: `minimums.${n}.containerTypeId`, id: entry.containerTypeId })),
          (entry) => requireContainerType(tx, principal.companyId, entry.id, entry.path),
        )
        await tx.delete(stockMinimum).where(and(eq(stockMinimum.companyId, principal.companyId), eq(stockMinimum.warehouseId, id)))
        if (minimums.length > 0) {
          // Ids minted here in the body's order, which a read answers the set in.
          await tx.insert(stockMinimum).values(minimums.map((entry) => ({ id: newId(), companyId: principal.companyId, projectId: found.projectId, warehouseId: id, ...entry })))
        }
        return c.json(await minimumsOf(tx, principal.companyId, id))
      },
    )
}
