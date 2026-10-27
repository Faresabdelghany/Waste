// Apply index over many prices on the API (#291 C8, C8a): a customer price
// list indexed from a day — the preview first, then the write, each row in
// force ended and its successor on the chain, a row typed in for the day
// left with why — and the same over an award's provider prices. API calls
// alone; the web's Apply index is C8w's. Records are uniquely made in
// Copenhagen Central and never cleaned up, so each test makes its own list,
// product and award.
import type { APIRequestContext } from "@playwright/test"

import { uniqueName } from "./env"
import { expect, test } from "./fixtures"
import { listAll, projectNamed, type Project } from "./tester"

type Product = { id: string }
type PriceList = { id: string }
type PriceListRow = { id: string; unitPriceMinor: number; indexedFromId: string | null; indexLabel: string | null; indexBasisPoints: number | null; validFrom: string; validTo: string | null }
type ProviderPrice = { id: string; bidMinor: number; unitPriceMinor: number; indexedFromId: string | null; validFrom: string; validTo: string | null }
type IndexLine = { id: string; productId: string; fromMinor: number; toMinor: number | null; indexedId: string | null; skipped: string | null }
type IndexResult = { dryRun: boolean; lines: IndexLine[] }
type ServiceProvider = { id: string; legalName: string }

const JANUARY = "2026-01-01"
const NEW_YEAR = "2027-01-01"

async function made<T>(api: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await api.post(path, { data })
  expect(response.status(), `POST ${path}: ${await response.text()}`).toBe(201)
  return (await response.json()) as T
}

async function product(api: APIRequestContext, project: Project): Promise<Product> {
  return made<Product>(api, "/products", { projectId: project.id, name: uniqueName("E2E indexed"), kind: "additional-service", status: "active", unit: "job", vatPercent: 25 })
}

async function indexed(api: APIRequestContext, path: string, data: unknown, status: number): Promise<IndexResult> {
  const response = await api.post(path, { data })
  expect(response.status(), await response.text()).toBe(status)
  return (await response.json()) as IndexResult
}

test.describe("Apply index over many prices (#291 C8)", () => {
  test("a price list: the preview writes nothing, the write ends each row in force and chains its successor, a row typed in for the day stays", async ({ api }) => {
    const project = await projectNamed(api, "Copenhagen Central")
    const [running, typedIn] = await Promise.all([product(api, project), product(api, project)])
    const list = await made<PriceList>(api, "/price-lists", { projectId: project.id, code: `e2e-idx-${Date.now().toString(36)}`, name: uniqueName("E2E index"), validFrom: JANUARY })
    const old = await made<PriceListRow>(api, `/price-lists/${list.id}/rows`, { productId: running.id, unitPriceMinor: 10_050, validFrom: JANUARY })
    const tariff = await made<PriceListRow>(api, `/price-lists/${list.id}/rows`, { productId: typedIn.id, unitPriceMinor: 4_000, validFrom: NEW_YEAR })
    const body = { label: "CPI 2027", basisPoints: 320, appliedFrom: NEW_YEAR }

    const preview = await indexed(api, `/price-lists/${list.id}/index`, { ...body, dryRun: true }, 200)
    expect(preview.lines).toEqual([
      { id: old.id, productId: running.id, fromMinor: 10_050, toMinor: 10_372, indexedId: null, skipped: null },
      { id: tariff.id, productId: typedIn.id, fromMinor: 4_000, toMinor: null, indexedId: null, skipped: "starts-on-index-day" },
    ])
    expect(await listAll<PriceListRow>(api, `/price-lists/${list.id}/rows`)).toHaveLength(2)

    const result = await indexed(api, `/price-lists/${list.id}/index`, body, 201)
    const successorId = result.lines[0].indexedId
    expect(successorId).not.toBeNull()
    const rows = new Map((await listAll<PriceListRow>(api, `/price-lists/${list.id}/rows`)).map((row) => [row.id, row]))
    expect(rows.get(old.id)?.validTo).toBe(NEW_YEAR)
    expect(rows.get(successorId ?? "")).toMatchObject({ unitPriceMinor: 10_372, indexedFromId: old.id, indexLabel: "CPI 2027", indexBasisPoints: 320, validFrom: NEW_YEAR, validTo: null })
    expect(rows.get(tariff.id)).toEqual(tariff)

    const again = await api.post(`/price-lists/${list.id}/index`, { data: body })
    expect(again.status()).toBe(409)
  })

  test("an award's provider prices: indexed over the bid in one request, on the chain the single index writes", async ({ api }) => {
    const project = await projectNamed(api, "Copenhagen Central")
    const provider = (await listAll<ServiceProvider>(api, "/service-providers")).find((candidate) => candidate.legalName.startsWith("NordRen"))
    if (provider === undefined) throw new Error("the seed has no NordRen")
    const code = `E2E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`.toUpperCase()
    const award = await made<{ assignment: { id: string } | null }>(api, "/service-areas", { projectId: project.id, code, name: uniqueName("E2E indexed award"), boundaryText: "As the e2e contract draws it", planningAreaIds: [], wasteFractionIds: [], validFrom: JANUARY, validTo: null, assignment: { serviceProviderId: provider.id } })
    const assignmentId = award.assignment?.id
    if (assignmentId === undefined) throw new Error("the award was made without its assignment")
    const [first, second] = await Promise.all([product(api, project), product(api, project)])
    const a = await made<ProviderPrice>(api, "/service-provider-prices", { serviceAreaAssignmentId: assignmentId, productId: first.id, bidMinor: 3_000, unitPriceMinor: 3_200, validFrom: JANUARY })
    const b = await made<ProviderPrice>(api, "/service-provider-prices", { serviceAreaAssignmentId: assignmentId, productId: second.id, bidMinor: 1_000, validFrom: JANUARY })
    const body = { serviceAreaAssignmentId: assignmentId, label: "CPI", basisPoints: 500, base: "bid", appliedFrom: NEW_YEAR }

    const preview = await indexed(api, "/service-provider-prices/index", { ...body, dryRun: true }, 200)
    expect(preview.lines.map((line) => [line.id, line.fromMinor, line.toMinor])).toEqual([
      [a.id, 3_200, 3_150],
      [b.id, 1_000, 1_050],
    ])
    const result = await indexed(api, "/service-provider-prices/index", body, 201)
    const chain = await listAll<ProviderPrice>(api, "/service-provider-prices", { serviceAreaAssignmentId: assignmentId })
    expect(chain.map((price) => [price.validFrom, price.validTo, price.unitPriceMinor, price.indexedFromId])).toEqual([
      [JANUARY, NEW_YEAR, 3_200, null],
      [JANUARY, NEW_YEAR, 1_000, null],
      [NEW_YEAR, null, 3_150, a.id],
      [NEW_YEAR, null, 1_050, b.id],
    ])
    expect(result.lines.map((line) => line.indexedId)).toEqual([chain[2].id, chain[3].id])
  })
})
