import assert from "node:assert/strict"

import { Product } from "@waste/contracts/catalogue"
import { IndexResult } from "@waste/contracts/finance"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { seedProducts, seedServiceArea, type ProductFixtures, type SeededServiceArea } from "./finance-fixtures"
import { readProblem } from "./read-problem"
import { dropTenant, seedTenant, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

// Apply index over many prices (#291 C8) is three files over this one setup:
// a customer list's rows (price-indexation.test.ts), a list larger than one
// statement takes (price-indexation-batches.test.ts), and a provider's or an
// award's prices (provider-price-indexation.test.ts). Node's test timeout
// bounds a whole file, and the one file of them all crossed it on CI.

export const JANUARY = "2026-01-01"
export const JUNE = "2026-06-01"
export const JULY = "2026-07-01"
export const NEW_YEAR = "2027-01-01"
export const MARCH_NEXT = "2027-03-01"
export const LATER = "2028-01-01"

export type IndexationSuite = {
  pool: Database
  a: Tenant
  b: Tenant
  products: ProductFixtures
  retired: Product
  olivia: Call
  other: Call
  ungranted: Call
  nordren: SeededServiceArea
  cityhaul: SeededServiceArea
}

type Schema<T> = { parse: (value: unknown) => T }

export const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>, at?: `/${string}`): Promise<T> =>
  created(call, path, await call(path, { method: "POST", body: values }), schema, at)

export const answered = async (response: Response, status: number): Promise<IndexResult> => {
  assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
  assert.equal(response.headers.get("Location"), null, "many rows were made, none named")
  return IndexResult.parse(await response.json())
}

export const refused = async (response: Response, status: number) => {
  assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
  return await readProblem(response)
}

export const send = (call: Call, path: string, body: unknown) => call(path, { method: "POST", body })

/** Two tenants, the first with its products, a retired one, and two awarded service areas, and the calls the suites make. */
export async function setUpIndexation(databaseUrl: string): Promise<IndexationSuite> {
  const pool = createDb(databaseUrl, { max: 4 })
  const keys = await signingKeys()
  const a = await seedTenant(pool)
  const b = await seedTenant(pool)
  const products = await seedProducts(pool, a)
  const nordren = await seedServiceArea(pool, a, { code: "CA-IDX-1", validFrom: JANUARY, validTo: null, assignment: { serviceProviderId: a.serviceProviders.nordren.id } })
  const cityhaul = await seedServiceArea(pool, a, { code: "CA-IDX-2", validFrom: JANUARY, validTo: null, assignment: { serviceProviderId: a.serviceProviders.cityhaul.id } })
  const app = createApp({ probe: pool, pool, verifier: keys.verifier })
  const olivia = callingAs(app, keys, a.users.olivia, a.companyId)
  const other = callingAs(app, keys, b.users.olivia, b.companyId)
  const ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
  const retired = await create(olivia, "/products", { projectId: a.projects.copenhagen.id, name: "Retired service", kind: "additional-service", unit: "job", status: "active", vatPercent: 25 }, Product)
  return { pool, a, b, products, retired, olivia, other, ungranted, nordren, cityhaul }
}

export async function tearDownIndexation(suite: IndexationSuite | undefined): Promise<void> {
  if (!suite) return
  await dropTenant(suite.pool, suite.a.companyId)
  await dropTenant(suite.pool, suite.b.companyId)
  await suite.pool.close()
}
