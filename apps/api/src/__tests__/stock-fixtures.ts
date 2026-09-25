// What the ledger's suites need of stock beyond their own routes (Issue #101,
// review round A): a warehouse of a project, written directly through `tx` as
// `wms_api` the way tenant.ts seeds its company, and a container received into
// one through the ledger's own command — in stock, the state most commands
// start from and the one the issue command wants. lifecycle.test.ts,
// containers.test.ts and agreements.test.ts each spelled both; they are here
// once. `dropTenant` drops the warehouse with the rest of the company, and the
// receipt is the owner's to sweep (#101 §6.24), so a suite that stocks a
// container hands `dropTenant` an owner pool.
import assert from "node:assert/strict"

import { Container } from "@waste/contracts/containers"
import { StockMovement } from "@waste/contracts/stock"
import type { Database } from "@waste/db/client"
import { warehouse } from "@waste/db/schema/places"
import { withCompany } from "@waste/db/tenant"
import type { WarehouseStatus } from "@waste/domain/resources/vocabulary"

import type { Call } from "./calls"
import { testId } from "./tenant"

/** A warehouse of a project, named `Warehouse <code>`, active unless a test says otherwise (a closed or draft one takes no stock); answers its id. */
export async function warehouseIn(pool: Database, companyId: string, projectId: string, code: string, status: WarehouseStatus = "active"): Promise<string> {
  const id = testId()
  await withCompany(pool.db, companyId, async (tx) => {
    await tx.insert(warehouse).values({ id, companyId, projectId, code, name: `Warehouse ${code}`, address: "Sundkrogsgade 1", status })
  })
  return id
}

/** What a container is registered with: the fields `POST /containers` needs, and whatever else a test adds. */
export type ContainerBody = { projectId: string; label: string; containerTypeId: string } & Record<string, unknown>

/** Registers a container through its route and receives it into the warehouse through the ledger's command, as the caller: in stock, the state the issue command wants. */
export async function stocked(call: Call, body: ContainerBody, warehouseId: string): Promise<Container> {
  const into = await created(call, "/containers", body, Container)
  await created(call, `/containers/${into.id}/receive`, { warehouseId }, StockMovement)
  return into
}

/** One 201 and its body parsed; the suites keep their own `create`, and this is the fixture's, so it depends on none of them. */
async function created<T>(call: Call, path: string, values: unknown, schema: { parse: (value: unknown) => T }): Promise<T> {
  const response = await call(path, { method: "POST", body: values })
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
  return schema.parse(await response.json())
}
