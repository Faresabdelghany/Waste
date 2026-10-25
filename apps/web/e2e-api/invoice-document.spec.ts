// An invoice's document on the web (#291 C5w): Settings › Finance & invoicing
// sets the postal address the documents print, and an invoice's details save
// its PDF — the API's file, byte for byte, under the invoice's label. The
// invoice is a run's over a day of this run's own, so its one event is this
// test's; the address is cleared again afterwards, since a developer's stack
// is shared across runs.
import { readFile } from "node:fs/promises"

import type { APIRequestContext, Page } from "@playwright/test"

import { uniqueName } from "./env"
import { expect, test } from "./fixtures"

type Project = { id: string; name: string }
type Agreement = { id: string; number: string }
type Product = { id: string }
type InvoiceDetail = { id: string; label: string; lines: { billableEventId: string | null }[] }
type ListPage<T> = { items: T[] }

const fail = (why: string): never => {
  throw new Error(why)
}

const answerOf = (page: Page, method: string, path: RegExp) =>
  page.waitForResponse((response) => response.request().method() === method && path.test(new URL(response.url()).pathname.replace(/^\/waste-api/, "")))

async function itemsOf<T>(api: APIRequestContext, path: string): Promise<T[]> {
  const response = await api.get(path)
  expect(response.status(), path).toBe(200)
  return ((await response.json()) as ListPage<T>).items
}

/** A service date of this run's own, in the past — a run is for a closed period — and inside the seeded agreement's and the default list's open periods; the specs that bill keep months of their own. */
function dayOfItsOwn(): string {
  const offset = Math.floor(Date.now() / 1000) % 60
  return new Date(Date.UTC(2026, 4, 1) + offset * 86_400_000).toISOString().slice(0, 10)
}

/** Østerbro Housing invoiced for one job on a day of this run's own: the run's document that carries the job's event. */
async function invoiced(api: APIRequestContext): Promise<InvoiceDetail> {
  const project = (await itemsOf<Project>(api, "/projects?limit=200")).find((candidate) => candidate.name === "Copenhagen Central") ?? fail("the seed has no Copenhagen Central")
  const agreement = (await itemsOf<Agreement>(api, "/agreements?limit=200")).find((candidate) => candidate.number === "AGR-2408") ?? fail("the seed has no AGR-2408")
  const name = uniqueName("E2E PDF job")
  const madeProduct = await api.post("/products", { data: { projectId: project.id, name, kind: "additional-service", status: "active", unit: "job", invoiceName: name, invoiceCode: `E2E-${Date.now().toString(36)}`.toUpperCase(), vatPercent: 25 } })
  expect(madeProduct.status(), await madeProduct.text()).toBe(201)
  const product = (await madeProduct.json()) as Product
  const day = dayOfItsOwn()
  const event = await api.post("/billable-events", { data: { projectId: project.id, agreementId: agreement.id, productId: product.id, quantity: 1, serviceDate: day, unitPriceMinor: 40_000, overrideReason: "Agreed by phone" } })
  expect(event.status(), await event.text()).toBe(201)
  const eventId = ((await event.json()) as { id: string }).id
  const run = await api.post("/billing-runs", { data: { projectId: project.id, periodFrom: day, periodTo: day } })
  expect(run.status(), await run.text()).toBe(201)
  for (const id of ((await run.json()) as { invoiceIds: string[] }).invoiceIds) {
    const detail = (await (await api.get(`/invoices/${id}`)).json()) as InvoiceDetail
    if (detail.lines.some((line) => line.billableEventId === eventId)) return detail
  }
  return fail("the run invoiced the job")
}

test.describe("an invoice's document (#291 C5)", () => {
  test.afterEach(async ({ api }) => {
    const cleared = await api.patch("/company", { data: { postalAddress: null } })
    expect(cleared.status(), await cleared.text()).toBe(200)
  })

  test("the postal address is set in Settings › Finance & invoicing, and an invoice's details save its PDF, the API's file under its label", async ({ api, page }) => {
    await page.goto("/settings?pane=finance-invoicing")
    await page.getByLabel("Postal address", { exact: true }).fill("Havnegade 4\n2100 København Ø")
    const [saved] = await Promise.all([answerOf(page, "PATCH", /^\/company$/), page.getByRole("button", { name: "Save identity" }).click()])
    expect(saved.status(), await saved.text()).toBe(200)
    expect(saved.request().postDataJSON()).toMatchObject({ postalAddress: "Havnegade 4\n2100 København Ø" })

    const invoice = await invoiced(api)
    const loaded = answerOf(page, "GET", /^\/invoices$/)
    await page.goto(`/commercial?module=invoices&record=invoice-${invoice.id}`)
    expect((await loaded).status()).toBe(200)
    const details = page.getByTestId("invoice-commands")
    const [download] = await Promise.all([page.waitForEvent("download"), details.getByRole("button", { name: "Download PDF" }).click()])
    expect(download.suggestedFilename()).toBe(`${invoice.label}.pdf`)
    const file = await readFile((await download.path()) ?? fail("the download was saved"))
    expect(file.subarray(0, 8).toString("latin1")).toBe("%PDF-1.7")
    const direct = await api.get(`/invoices/${invoice.id}/document`)
    expect(direct.headers()["content-type"]).toBe("application/pdf")
    expect((await direct.body()).equals(Uint8Array.from(file)), "the saved file is the API's, byte for byte").toBe(true)
  })
})
