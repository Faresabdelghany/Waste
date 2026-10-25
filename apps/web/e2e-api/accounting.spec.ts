// The accounting export on the web (#291 C7w), against the seeded tenant:
// Settings › Commercial › Accounting maps Copenhagen Central onto a chart of
// six accounts and a code per VAT rate, the whole mapping saved in one PUT;
// then Commercial › Accounting export previews today's period — the vouchers
// it would book, no gap — exports it, and the export's details save its file,
// the API's CSV byte for byte, holding the invoice this test billed today.
// The mapping is cleared first, since a developer's stack is shared across
// runs; an export books every row no export took yet, so a stack run again
// books only what arrived since.
import { readFile } from "node:fs/promises"

import type { APIRequestContext, Locator, Page } from "@playwright/test"

import { expect, test } from "./fixtures"

type Project = { id: string; name: string }
type Product = { id: string; name: string }
type Agreement = { id: string; number: string }
type Invoice = { id: string; label: string; lines: { billableEventId: string | null }[] }
type ListPage<T> = { items: T[] }

const fail = (why: string): never => {
  throw new Error(why)
}

const answerOf = (page: Page, method: string, path: RegExp) =>
  page.waitForResponse((response) => response.request().method() === method && path.test(new URL(response.url()).pathname.replace(/^\/waste-api/, "")))

async function pick(scope: Locator | Page, page: Page, field: string | RegExp, option: RegExp) {
  await scope.getByRole("combobox", { name: field, exact: typeof field === "string" }).click()
  await page.getByRole("option", { name: option }).first().click()
}

async function itemsOf<T>(api: APIRequestContext, path: string): Promise<T[]> {
  const response = await api.get(path)
  expect(response.status(), path).toBe(200)
  return ((await response.json()) as ListPage<T>).items
}

/** Today on Copenhagen's clock: the day a run issues its invoice on, and the export's period. */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Copenhagen" })

/** A service date of this run's own, in the past and inside the seeded agreement's and the default list's open periods. */
function dayOfItsOwn(): string {
  const offset = Math.floor(Date.now() / 1000) % 60
  return new Date(Date.UTC(2026, 6, 1) + offset * 86_400_000).toISOString().slice(0, 10)
}

/** Østerbro Housing's own invoice for one Bulky waste pickup, issued today by a run over a day of its own. */
async function invoiceOfItsOwn(api: APIRequestContext, project: Project): Promise<Invoice> {
  const agreement = (await itemsOf<Agreement>(api, "/agreements?limit=200")).find((candidate) => candidate.number === "AGR-2408") ?? fail("the seed has no AGR-2408")
  const bulky = (await itemsOf<Product>(api, `/products?limit=200&projectId=${project.id}`)).find((candidate) => candidate.name === "Bulky waste pickup") ?? fail("the seed has no Bulky waste pickup")
  const day = dayOfItsOwn()
  const event = await api.post("/billable-events", { data: { projectId: project.id, agreementId: agreement.id, productId: bulky.id, quantity: 1, serviceDate: day } })
  expect(event.status(), await event.text()).toBe(201)
  const eventId = ((await event.json()) as { id: string }).id
  const run = await api.post("/billing-runs", { data: { projectId: project.id, periodFrom: day, periodTo: day } })
  expect(run.status(), await run.text()).toBe(201)
  for (const id of ((await run.json()) as { invoiceIds: string[] }).invoiceIds) {
    const invoice = (await (await api.get(`/invoices/${id}`)).json()) as Invoice
    if (invoice.lines.some((line) => line.billableEventId === eventId)) return invoice
  }
  return fail("the run issued no invoice with the event's line")
}

const CHART = [
  { number: "1010", name: "Salg af tømning", standard: "1010" },
  { number: "5600", name: "Debitorer", standard: "5600" },
  { number: "5820", name: "Bank", standard: "5820" },
  { number: "5850", name: "Ubehandlede indbetalinger", standard: "" },
  { number: "6800", name: "Salgsmoms", standard: "6800" },
  { number: "6810", name: "Momsfritaget salg", standard: "" },
]

test("Accounting: Settings maps a project onto the office's chart, and Commercial exports today's period, previewed first, its file the API's CSV byte for byte", async ({ page, api }) => {
  const project = (await itemsOf<Project>(api, "/projects?limit=200")).find((candidate) => candidate.name === "Copenhagen Central") ?? fail("the seed has no Copenhagen Central")
  const cleared = await api.put("/accounting-settings", { data: { projectId: project.id, accounts: [], receivable: null, bank: null, suspense: null, revenue: null, exportsFrom: null, vatCodes: [], productAccounts: [] } })
  expect(cleared.status(), await cleared.text()).toBe(200)
  const invoice = await invoiceOfItsOwn(api, project)

  // Settings › Commercial › Accounting: the chart, the four defaults and a code for 25 % and for 0 %.
  const read = answerOf(page, "GET", /^\/accounting-settings$/)
  await page.goto("/settings?pane=commercial-accounting")
  await expect(page.getByRole("heading", { name: "Accounting" }).first()).toBeVisible()
  expect((await read).status()).toBe(200)
  const mapping = page.getByTestId("accounting-mapping")
  for (const [index, account] of CHART.entries()) {
    await mapping.getByRole("button", { name: "Add account" }).click()
    await mapping.getByLabel(`Account ${index + 1} number`, { exact: true }).fill(account.number)
    await mapping.getByLabel(`Account ${index + 1} name`, { exact: true }).fill(account.name)
    if (account.standard !== "") await mapping.getByLabel(`Account ${index + 1} standard chart`, { exact: true }).fill(account.standard)
  }
  await pick(mapping, page, "Receivables", /^5600/)
  await pick(mapping, page, "Bank", /^5820/)
  await pick(mapping, page, "Unmatched payments", /^5850/)
  await pick(mapping, page, "Revenue", /^1010/)
  for (const [index, [rate, code, standard, account]] of ([["25", "U25", "S1", /^6800/], ["0", "U0", "", /^6810/]] as const).entries()) {
    await mapping.getByRole("button", { name: "Add rate" }).click()
    await mapping.getByLabel(`Rate ${index + 1}`, { exact: true }).fill(rate)
    await mapping.getByLabel(`Code ${index + 1}`, { exact: true }).fill(code)
    if (standard !== "") await mapping.getByLabel(`Standard code ${index + 1}`, { exact: true }).fill(standard)
    await pick(mapping, page, `VAT account ${index + 1}`, account)
  }
  const [saved] = await Promise.all([answerOf(page, "PUT", /^\/accounting-settings$/), page.getByRole("button", { name: "Save mapping" }).click()])
  expect(saved.status(), await saved.text()).toBe(200)
  expect(saved.request().postDataJSON()).toMatchObject({
    projectId: project.id,
    receivable: "5600",
    bank: "5820",
    suspense: "5850",
    revenue: "1010",
    vatCodes: [{ vatPercent: 25, code: "U25", account: "6800", standardTaxCode: "S1" }, { vatPercent: 0, code: "U0", account: "6810", standardTaxCode: null }],
  })
  expect((saved.request().postDataJSON() as { accounts: { number: string; standardAccount: string | null }[] }).accounts.map((account) => [account.number, account.standardAccount])).toEqual(CHART.map((account) => [account.number, account.standard === "" ? null : account.standard]))
  await expect(page.getByRole("button", { name: "Save mapping" })).toBeDisabled()

  // Commercial › Accounting export: today's period previewed, then exported.
  const loaded = answerOf(page, "GET", /^\/accounting-exports$/)
  await page.goto("/commercial?module=accounting")
  expect((await loaded).status()).toBe(200)
  await page.getByRole("button", { name: "Export period" }).click()
  const ask = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Export period", exact: true }) })
  await pick(ask, page, /^Project/, /^Copenhagen Central/)
  await ask.getByLabel(/^First day/).fill(today())
  await ask.getByLabel(/^Last day/).fill(today())
  const [previewed] = await Promise.all([answerOf(page, "POST", /^\/accounting-exports\/preview$/), ask.getByRole("button", { name: "Preview" }).click()])
  expect(previewed.status(), await previewed.text()).toBe(200)
  const answer = (await previewed.json()) as { voucherCount: number; gaps: unknown[] }
  expect(answer.gaps, "every row books to the chart").toEqual([])
  expect(answer.voucherCount).toBeGreaterThan(0)
  const preview = page.getByTestId("accounting-preview")
  await expect(preview.getByTestId("preview-vouchers")).toHaveText(String(answer.voucherCount))
  const [exported] = await Promise.all([answerOf(page, "POST", /^\/accounting-exports$/), preview.getByRole("button", { name: "Export" }).click()])
  expect(exported.status(), await exported.text()).toBe(201)
  const made = (await exported.json()) as { id: string; voucherCount: number }
  expect(made.voucherCount).toBe(answer.voucherCount)

  // The new export opens in its details: its file, the API's CSV byte for byte, holding today's invoice.
  const details = page.getByTestId("accounting-export-commands")
  const [download] = await Promise.all([page.waitForEvent("download"), details.getByRole("button", { name: "Download CSV" }).click()])
  expect(download.suggestedFilename()).toMatch(/^accounting-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}-\d+-\d+\.csv$/)
  const file = await readFile((await download.path()) ?? fail("the download was saved"))
  expect([...file.subarray(0, 3)], "a byte-order mark").toEqual([0xef, 0xbb, 0xbf])
  const direct = await api.get(`/accounting-exports/${made.id}/file`)
  expect(direct.headers()["content-type"]).toBe("text/csv; charset=utf-8")
  expect((await direct.body()).equals(Uint8Array.from(file)), "the saved file is the API's, byte for byte").toBe(true)
  const rows = file.subarray(3).toString("utf8").split("\r\n")
  expect(rows[0]).toBe("voucher;date;account;account_name;text;amount;vat_code;currency;customer;document;source;source_id")
  expect(rows.filter((row) => row.endsWith(`;invoice;${invoice.id}`)).map((row) => row.split(";")[2])).toEqual(["5600", "1010", "6800"])

  // SAF-T: the API's file saved as it came, or, while the company's identity or the mapping lacks what it needs, the API's sentence told.
  const saft = await api.get(`/accounting-exports/${made.id}/file?format=saf-t`)
  if (saft.status() === 409) {
    const { detail } = (await saft.json()) as { detail: string }
    await details.getByRole("button", { name: "Download SAF-T" }).click()
    await expect(page.getByText(detail).first()).toBeVisible()
  } else {
    expect(saft.status(), await saft.text()).toBe(200)
    const [saved] = await Promise.all([page.waitForEvent("download"), details.getByRole("button", { name: "Download SAF-T" }).click()])
    expect(saved.suggestedFilename()).toMatch(/^accounting-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}-\d+-\d+-saf-t\.xml$/)
    const xml = (await readFile((await saved.path()) ?? fail("the download was saved"))).toString("utf8")
    expect(xml).toContain('<AuditFile xmlns="urn:StandardAuditFile-Taxation-Financial:DK">')
    expect(xml).toContain("<TaxCode>U25</TaxCode>")
  }
})
