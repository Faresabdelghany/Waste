// The container's lifecycle as commands (Issue #101, ADR-0003): the Stock
// Movement ledger's doors and the two reads over it. A container is received
// from a supplier into a warehouse, issued into service (which is
// `POST /containers/:id/placements`, the Registry's route in containers.ts —
// one action, one command), returned into stock or into maintenance,
// transferred between the two, decommissioned to scrap, or adjusted when the
// ledger is wrong. The commands' statements and rules are the ledger's,
// `move` in `@waste/db/commands/stock-ledger`, which a work order's completion
// runs too; a route finds the container under the caller's scope (its 404),
// validates the body, and answers what `move` appended, or the problem its
// refusal names.
//
// The reads: `GET /containers/:id/movements` is one container's ledger and
// `GET /stock-movements` the ledger across containers, both oldest first — a
// cursor over `id` is a cursor over recording order, the one rule every list
// of this API pages by (pagination.ts), and a ledger read newest first would
// be the one list paging the other way. The cross-container list is
// `resources.inventory`'s: what stands where and what moved is the
// inventory's question, while a command on a container is
// `resources.containers`'.
import { Page, PageRequest } from "@waste/contracts/pagination"
import { Adjust, Decommission, Receive, Return, StockMovement, StockMovementListQuery, Transfer } from "@waste/contracts/stock"
import type { Tx } from "@waste/db/client"
import { move, type ContainerRef } from "@waste/db/commands/stock-ledger"
import { container } from "@waste/db/schema/containers"
import { stockMovement } from "@waste/db/schema/stock"
import { stockMovementColumns, stockMovementOf } from "@waste/db/shapes/stock-movements"
import { and, eq, gte, lte, or } from "drizzle-orm"

import { actorOf, type Principal } from "../auth/principal"
import { projectIdsOf, requireProject } from "../auth/projects"
import type { RouteDeps } from "../deps"
import { describeJson, IdParam, routes } from "../operation"
import { mapPage, pageAt } from "../pagination"
import { describeProblem } from "../problem"
import { scoped } from "../scoped"
import { containerScope, noSuchContainer } from "./container-writes"
import { requireWarehouse } from "./references"

const MODULE = "resources.containers"
const INVENTORY = "resources.inventory"
const MovementPage = Page(StockMovement)

async function findContainerRef(tx: Tx, principal: Principal, id: string): Promise<ContainerRef | undefined> {
  const [row] = await tx
    .select({ id: container.id, projectId: container.projectId, label: container.label })
    .from(container)
    .where(and(containerScope(principal), eq(container.id, id)))
    .limit(1)
  return row
}

const { list: listMovements } = scoped(stockMovement, { noun: "stock movement", reach: "projects", columns: stockMovementColumns })

const commandProblems = {
  404: describeProblem("No container with that id in the projects this account works in."),
}

export function lifecycleRoutes(deps: RouteDeps) {
  const { now } = deps
  return routes(deps)
    .post(
      "/containers/:id/receive",
      {
        operationId: "receiveContainer",
        summary: "Receive a container into a warehouse",
        description:
          "Appends the container's first Stock Movement: from a supplier into a warehouse of its project. Only a container with no stock record yet can be received — one already in stock (409 naming the warehouse), in service (409: return it first) or retired (409: a scrapped container does not come back; register a new one) is refused, and a wrong first record is repaired through `adjust`. The warehouse takes stock: a closed or draft one is refused (409 naming the status), while what already stands in it stands. `occurredAt` is when it happened, on the caller's word, the request's clock when absent, and at most five minutes ahead of it, a device's clock being a device's (400 beyond); `reference` is the delivery note. The server mints the id and records who asked.",
        module: MODULE,
        action: "create",
        params: IdParam,
        body: Receive,
        invalid: ["the body is missing the warehouse, names a member the ledger owns, names a warehouse that is not this container's project's, or dates the receipt more than five minutes after the request"],
        responses: {
          201: describeJson("The receipt as it was appended.", StockMovement),
          ...commandProblems,
          409: describeProblem("The container already has a stock record — it is in stock, in service or retired — or the warehouse is closed or a draft and takes no stock."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const { warehouseId, ...says } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const subject = await findContainerRef(tx, principal, id)
        if (subject === undefined) throw noSuchContainer(id)
        return c.json(await move(tx, actorOf(principal), subject, { kind: "receipt", to: { kind: "warehouse", warehouseId }, ...says, at: now() }), 201)
      },
    )
    .post(
      "/containers/:id/return",
      {
        operationId: "returnContainer",
        summary: "Take a container out of service into stock",
        description:
          "Ends the container's placement in force on `validTo` — the first day it no longer serves, held inside the subscription's period (400 naming the bound) — and appends the return in the same transaction: from that placement into a warehouse of its project, or into maintenance at one when `toKind` says so. Either both change or neither. The placement is the Registry's, the container's latest to begin before `validTo`, whichever the issue named (#291): after a subscription's change it is the replacement's; one that already ended on or before `validTo` — a terminated agreement's, whose bin stayed until collected, or an import's — ends nothing more, and the return records it. A container that is not in service is refused (409), and so is a warehouse that is closed or a draft (409 naming the status), and a container placed again from a later day, a change planned for then, whose placement would stand after the bin had left (409 naming the day). `occurredAt` and `reference` are the movement's, the instant at most five minutes ahead of the request's clock; `reason` says why it came back.",
        module: MODULE,
        action: "create",
        params: IdParam,
        body: Return,
        invalid: ["the body is missing the warehouse or `validTo`, names a member the ledger owns, names a warehouse that is not this container's project's, ends the placement on or before the day it started or outside the subscription's period, or dates the return more than five minutes after the request"],
        responses: {
          201: describeJson("The return as it was appended; the placement now ends on `validTo`.", StockMovement),
          ...commandProblems,
          409: describeProblem("The container is not in service, the warehouse is closed or a draft and takes no stock, or the container is placed again from a later day."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const { warehouseId, toKind, validTo, ...says } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const subject = await findContainerRef(tx, principal, id)
        if (subject === undefined) throw noSuchContainer(id)
        return c.json(await move(tx, actorOf(principal), subject, { kind: "return", to: { kind: toKind, warehouseId }, validTo, ...says, at: now() }), 201)
      },
    )
    .post(
      "/containers/:id/transfer",
      {
        operationId: "transferContainer",
        summary: "Move a container between places in stock",
        description:
          "Appends a transfer from where the container stands — a warehouse, or maintenance at one — to another warehouse of its project, or into or out of maintenance, recorded on arrival: a container on a truck between two warehouses reads as still in the first until the second records it. The same place and the same kind is refused (400 on `warehouseId`: already there), and a warehouse that is closed or a draft takes nothing (409 naming the status; a transfer out of one is the way to empty it). A container with no stock record, in service or retired is refused (409).",
        module: MODULE,
        action: "create",
        params: IdParam,
        body: Transfer,
        invalid: ["the body is missing the warehouse, names a member the ledger owns, names a warehouse that is not this container's project's, names the place the container already stands in, or dates the transfer more than five minutes after the request"],
        responses: {
          201: describeJson("The transfer as it was appended.", StockMovement),
          ...commandProblems,
          409: describeProblem("The container is not in stock — it has no record, is in service or is retired — or the warehouse is closed or a draft and takes no stock."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const { warehouseId, toKind, ...says } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const subject = await findContainerRef(tx, principal, id)
        if (subject === undefined) throw noSuchContainer(id)
        return c.json(await move(tx, actorOf(principal), subject, { kind: "transfer", to: { kind: toKind, warehouseId }, ...says, at: now() }), 201)
      },
    )
    .post(
      "/containers/:id/decommission",
      {
        operationId: "decommissionContainer",
        summary: "Scrap a container",
        description:
          "Appends the decommission: from wherever the container stands to scrap, with its reason, one of the company's active Decommission Reasons (`decommissionReasonId`; 400 for one that is not the company's, 409 for a retired one, judged after the container's own state), and a note beside it if `reason` says more. In service, `validTo` is required (400) and ends the container's placement in force in the same transaction, as a return does — one that already ended on or before it ends nothing more, and one placed again from a later day is refused (409 naming the day); out of service, `validTo` is refused (400), since there is no placement to end. A container with no stock record (409) or already retired (409) is refused. A retired container never comes back through `receive`; a wrong decommission is corrected through `adjust`.",
        module: MODULE,
        action: "create",
        params: IdParam,
        body: Decommission,
        invalid: ["the body is missing the reason, names a reason that is not this company's, names a member the ledger owns, gives `validTo` out of service or withholds it in service, ends the placement on or before the day it started or outside the subscription's period, or dates the decommission more than five minutes after the request"],
        responses: {
          201: describeJson("The decommission as it was appended; a placement it ended now ends on `validTo`.", StockMovement),
          ...commandProblems,
          409: describeProblem("The container has no stock record, is already retired, or is placed again from a later day than the placement's new end, or the reason is retired."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const { validTo, decommissionReasonId, ...says } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const subject = await findContainerRef(tx, principal, id)
        if (subject === undefined) throw noSuchContainer(id)
        return c.json(await move(tx, actorOf(principal), subject, { kind: "decommission", decommissionReasonId, ...(validTo === undefined ? {} : { validTo }), ...says, at: now() }), 201)
      },
    )
    .post(
      "/containers/:id/adjust",
      {
        operationId: "adjustContainer",
        summary: "Correct the ledger's reading of a container",
        description:
          "The correction door: appends an adjustment from wherever the ledger says the container is — a supplier when it has no record, which is how an import that skipped the receipt is repaired — to a warehouse of its project, to maintenance at one, or to scrap, with the reason and, where it corrects one, the movement it corrects, which must be this container's (400). Neither side may be service: a container in service is refused (409) and is returned or decommissioned instead, since an adjustment does not touch a placement. A warehouse that is closed or a draft takes nothing (409 naming the status). `edit` on `resources.containers`, not `create`: this rewrites what the ledger says rather than recording what happened.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: Adjust,
        invalid: ["the body is missing the reason or the target, names a member the ledger owns, names a warehouse with scrap or none with a place in stock, names a warehouse that is not this container's project's, names a movement that is not this container's, or dates the adjustment more than five minutes after the request"],
        responses: {
          201: describeJson("The adjustment as it was appended.", StockMovement),
          ...commandProblems,
          409: describeProblem("The container is in service (return or decommission it), or the warehouse is closed or a draft and takes no stock."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const { toKind, warehouseId, correctsMovementId, ...says } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const subject = await findContainerRef(tx, principal, id)
        if (subject === undefined) throw noSuchContainer(id)
        return c.json(
          await move(tx, actorOf(principal), subject, {
            kind: "adjustment",
            to: { kind: toKind, warehouseId: warehouseId ?? null },
            ...(correctsMovementId === undefined ? {} : { correctsMovementId }),
            ...says,
            at: now(),
          }),
          201,
        )
      },
    )
    .get(
      "/containers/:id/movements",
      {
        operationId: "listContainerMovements",
        summary: "One container's ledger",
        description:
          "One page of the container's Stock Movements, oldest first: ids are time-ordered, so a cursor over them is a cursor over recording order, and the last item of the last page is the movement `assetState` reads. `occurredAt` is when each happened, on the caller's word; `recordedAt` is when it was appended. A container of another company, or of a project this account does not work in, is a container that does not exist here. Hand `nextCursor` back as `cursor` for the next page.",
        module: MODULE,
        action: "view",
        params: IdParam,
        query: PageRequest,
        responses: {
          200: describeJson("One page of the container's movements.", MovementPage),
          404: describeProblem("No container with that id in the projects this account works in."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit, cursor } = c.req.valid("query")
        const at = pageAt({ cursor, limit })
        const tx = c.get("tx")
        const principal = c.get("principal")
        if ((await findContainerRef(tx, principal, id)) === undefined) throw noSuchContainer(id)
        const page = await listMovements(tx, principal, at, eq(stockMovement.containerId, id))
        return c.json(mapPage(page, stockMovementOf))
      },
    )
    .get(
      "/stock-movements",
      {
        operationId: "listStockMovements",
        summary: "The ledger across containers",
        description:
          "One page of Stock Movements, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `containerId` is one container's ledger, `warehouseId` every movement that left from or arrived at that warehouse (a warehouse outside the projects this account works in is refused), `kind` one kind, and `from`/`to` the window over `occurredAt`, both inclusive. What stands in a warehouse today is `GET /containers?warehouseId=`, the projection; this is what moved. Hand `nextCursor` back as `cursor` for the next page.",
        module: INVENTORY,
        action: "view",
        query: StockMovementListQuery,
        invalid: ["the window runs backwards", "`projectId` is not a project this account works in", "`warehouseId` is not a warehouse of one"],
        responses: {
          200: describeJson("One page of movements.", MovementPage),
        },
      },
      async (c) => {
        const { limit, cursor, projectId, containerId, warehouseId, kind, from, to } = c.req.valid("query")
        const at = pageAt({ cursor, limit })
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        // The warehouse asked about is one the caller may see: the project named, or any the caller works in — the containers list's rule.
        if (warehouseId !== undefined) {
          await requireWarehouse(tx, { companyId: principal.companyId, projectId: projectId ?? projectIdsOf(principal) }, warehouseId, "warehouseId", "query")
        }
        const page = await listMovements(
          tx,
          principal,
          at,
          projectId === undefined ? undefined : eq(stockMovement.projectId, projectId),
          containerId === undefined ? undefined : eq(stockMovement.containerId, containerId),
          warehouseId === undefined ? undefined : or(eq(stockMovement.fromWarehouseId, warehouseId), eq(stockMovement.toWarehouseId, warehouseId)),
          kind === undefined ? undefined : eq(stockMovement.kind, kind),
          from === undefined ? undefined : gte(stockMovement.occurredAt, new Date(from)),
          to === undefined ? undefined : lte(stockMovement.occurredAt, new Date(to)),
        )
        return c.json(mapPage(page, stockMovementOf))
      },
    )
}
