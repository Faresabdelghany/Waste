import type { APIRequestContext, Locator, Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { uniqueName } from "./env"

// Payments on the web (#291 slice 6, #292 C6w), against the seeded tenant:
// an invoice of a run of its own, paid in part by a payment registered by
// hand; a bank statement's two lines previewed — one paying the rest by the
// invoice's label, one matching nothing — and imported; the bank's match
// undone and the unmatched payment matched instead; each step read back as
// the invoice's standing through the API. Then Østerbro Housing's statement
// for the day. Records are uniquely named and never cleaned up; a bank line
// carries a unique text, so a developer's stack never takes it for one
// imported before.
type Project = { id: string; name: string }
type Product = { id: string; name: string }
type Agreement = { id: string; number: string; customerId: string }
type Invoice = { id: string; label: string; grossMinor: number; paidMinor: number; outstandingMinor: number; paymentStatus: string | null; lines: { billableEventId: string | null }[] }
type Payment = { id: string; source: string; amountMinor: number; allocatedMinor: number; unallocatedMinor: number; allocations?: { id: string; invoiceId: string; amountMinor: number }[] }
type ListPage<T> = { items: T[]; nextCursor: string | null }

const answerOf = (page: Page, method: string, path: RegExp) =>
  page.waitForResponse((response) => response.request().method() === method && path.test(new URL(response.url()).pathname.replace(/^\/waste-api/, "")))

async function pick(dialog: Locator, page: Page, field: RegExp, option: RegExp) {
  await dialog.getByRole("combobox", { name: field }).click()
  await page.getByRole("option", { name: option }).first().click()
}

const dialogTitled = (page: Page, title: string) => page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: title, exact: true }) })

async function itemsOf<T>(api: APIRequestContext, path: string): Promise<T[]> {
  const response = await api.get(path)
  expect(response.status(), path).toBe(200)
  return ((await response.json()) as ListPage<T>).items
}

/** Today on Copenhagen's clock: the day a run issues its invoice on, and the payments' day. */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Copenhagen" })

/** A service date of this run's own, in the past — a run is for a closed period — and inside the seeded agreement's and the default list's open periods; the specs that bill keep months of their own. */
function dayOfItsOwn(): string {
  const offset = Math.floor(Date.now() / 1000) % 60
  return new Date(Date.UTC(2026, 6, 1) + offset * 86_400_000).toISOString().slice(0, 10)
}

/** An amount as the bank file spells it: `36,25`. */
const filed = (minor: number) => `${Math.floor(minor / 100)},${String(minor % 100).padStart(2, "0")}`

const invoiceRead = async (api: APIRequestContext, id: string) => (await (await api.get(`/invoices/${id}`)).json()) as Invoice

/** Østerbro Housing's own invoice for one Bulky waste pickup, issued today by a run over a day of its own. */
async function invoiceOfItsOwn(api: APIRequestContext): Promise<{ project: Project; agreement: Agreement; invoice: Invoice }> {
  const project = (await itemsOf<Project>(api, "/projects?limit=200")).find((candidate) => candidate.name === "Copenhagen Central")
  const agreement = (await itemsOf<Agreement>(api, "/agreements?limit=200")).find((candidate) => candidate.number === "AGR-2408")
  if (project === undefined || agreement === undefined) throw new Error("the seed has no Copenhagen Central or AGR-2408")
  const bulky = (await itemsOf<Product>(api, `/products?limit=200&projectId=${project.id}`)).find((candidate) => candidate.name === "Bulky waste pickup")
  if (bulky === undefined) throw new Error("the seed has no Bulky waste pickup in Copenhagen")
  const day = dayOfItsOwn()
  const event = await api.post("/billable-events", { data: { projectId: project.id, agreementId: agreement.id, productId: bulky.id, quantity: 1, serviceDate: day } })
  expect(event.status(), await event.text()).toBe(201)
  const eventId = ((await event.json()) as { id: string }).id
  const run = await api.post("/billing-runs", { data: { projectId: project.id, periodFrom: day, periodTo: day } })
  expect(run.status(), await run.text()).toBe(201)
  for (const id of ((await run.json()) as { invoiceIds: string[] }).invoiceIds) {
    const invoice = await invoiceRead(api, id)
    if (invoice.lines.some((line) => line.billableEventId === eventId)) return { project, agreement, invoice }
  }
  throw new Error("the run issued no invoice with the event's line")
}

test("Payments: a payment registered against an invoice, a bank statement previewed and imported, a wrong match undone and the unmatched one matched; and the payer's statement", async ({ page, api }) => {
  const { project, invoice } = await invoiceOfItsOwn(api)
  expect(invoice.paymentStatus).toBe("open")
  const day = today()

  // Register payment: part of the invoice, paid at the counter.
  const loaded = answerOf(page, "GET", /^\/payments$/)
  await page.goto("/commercial?module=payments")
  expect((await loaded).status()).toBe(200)
  await page.getByRole("button", { name: "Register payment" }).click()
  const register = dialogTitled(page, "Register payment")
  await pick(register, page, /^Project/, /^Copenhagen Central/)
  await pick(register, page, /^Invoice/, new RegExp(`^${invoice.label}`))
  await register.getByLabel(/^Amount/).fill("20")
  await register.getByLabel(/^Paid on/).fill(day)
  await register.getByLabel(/^Payer's reference/).fill("Counter")
  const [registered] = await Promise.all([answerOf(page, "POST", /^\/payments$/), register.getByRole("button", { name: "Register payment" }).click()])
  expect(registered.status(), await registered.text()).toBe(201)
  expect(registered.request().postDataJSON()).toEqual({ projectId: project.id, invoiceId: invoice.id, amountMinor: 2000, currency: "DKK", paidOn: day, reference: "Counter" })
  expect((await registered.json()) as Payment).toMatchObject({ source: "manual", allocatedMinor: 2000, unallocatedMinor: 0 })
  expect(await invoiceRead(api, invoice.id)).toMatchObject({ paymentStatus: "partially-paid", paidMinor: 2000 })
  // The new payment opens in its details, allocated to the invoice; closed, the toolbar is the module's again.
  await expect(page.getByTestId("payment-allocations").getByText(new RegExp(`^${invoice.label} · DKK 20\\.00`))).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("payment-commands")).toBeHidden()

  // Import bank statement: the rest by the invoice's label, and a line nobody's.
  const rest = invoice.grossMinor - 2000
  const unique = uniqueName("E2E bank")
  const csv = ["booked_on;amount;currency;reference;text", `${day};${filed(rest)};DKK;;Betaling ${invoice.label} ${unique}`, `${day};12,34;DKK;;${unique} unknown payer`].join("\n")
  await page.getByRole("button", { name: "Import bank statement" }).click()
  const ask = dialogTitled(page, "Import bank statement")
  await pick(ask, page, /^Project/, /^Copenhagen Central/)
  await ask.getByRole("button", { name: "Choose the file" }).click()
  const importer = page.getByTestId("bank-import")
  const [dry] = await Promise.all([answerOf(page, "POST", /^\/payments\/bank-lines$/), importer.getByLabel("Bank statement file").setInputFiles({ name: "statement.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") })])
  expect(dry.status(), await dry.text()).toBe(200)
  expect(dry.request().postDataJSON()).toMatchObject({ projectId: project.id, dryRun: true, lines: [{ row: 2, amountMinor: rest, occurrence: 0 }, { row: 3, amountMinor: 1234 }] })
  await expect(importer.getByTestId("bank-import-summary")).toContainText("2 incoming lines, 0 outgoing skipped, 0 not read")
  const preview = importer.getByTestId("bank-import-lines")
  await expect(preview.getByText(`${invoice.label} by its label, DKK ${filed(rest).replace(",", ".")}`)).toBeVisible()
  await expect(preview.getByText("Unmatched: the office matches it")).toBeVisible()
  expect((await invoiceRead(api, invoice.id)).paidMinor, "a dry run writes nothing").toBe(2000)
  const [imported] = await Promise.all([answerOf(page, "POST", /^\/payments\/bank-lines$/), importer.getByRole("button", { name: "Import" }).click()])
  expect(imported.status(), await imported.text()).toBe(201)
  const outcome = (await imported.json()) as { lines: { outcome: string; paymentId: string | null }[] }
  expect(outcome.lines.map((line) => line.outcome)).toEqual(["matched", "unmatched"])
  await expect(page.getByText("1 matched, 1 unmatched, 0 imported already.")).toBeVisible()
  expect(await invoiceRead(api, invoice.id)).toMatchObject({ paymentStatus: "paid", outstandingMinor: 0 })

  // The bank's match undone in its payment's details: the invoice owes the rest again.
  const bankPaymentId = outcome.lines[0].paymentId!
  const looseId = outcome.lines[1].paymentId!
  const bankRead = answerOf(page, "GET", new RegExp(`^/payments/${bankPaymentId}$`))
  await page.goto(`/commercial?module=payments&record=payment-${bankPaymentId}`)
  expect((await bankRead).status()).toBe(200)
  const bankDetails = page.getByTestId("payment-commands")
  await expect(bankDetails.getByTestId("payment-allocations").getByText(new RegExp(`^${invoice.label} · `))).toBeVisible()
  const [undone] = await Promise.all([answerOf(page, "POST", /^\/payment-allocations\/[^/]+\/reverse$/), bankDetails.getByRole("button", { name: "Undo match" }).click()])
  expect(undone.status(), await undone.text()).toBe(201)
  await expect(bankDetails.getByText(/· undoes a match$/)).toBeVisible()
  expect(await invoiceRead(api, invoice.id)).toMatchObject({ paymentStatus: "partially-paid", outstandingMinor: rest })

  // The unmatched payment matched to the invoice instead, all that remains of it.
  const looseRead = answerOf(page, "GET", new RegExp(`^/payments/${looseId}$`))
  await page.goto(`/commercial?module=payments&record=payment-${looseId}`)
  expect((await looseRead).status()).toBe(200)
  const looseDetails = page.getByTestId("payment-commands")
  await expect(looseDetails.getByText("Matched to no invoice yet.")).toBeVisible()
  await looseDetails.getByRole("button", { name: "Match to invoice" }).click()
  const match = dialogTitled(page, "Match to invoice")
  await pick(match, page, /^Invoice/, new RegExp(`^${invoice.label}`))
  const [matched] = await Promise.all([answerOf(page, "POST", new RegExp(`^/payments/${looseId}/allocations$`)), match.getByRole("button", { name: "Match" }).click()])
  expect(matched.status(), await matched.text()).toBe(201)
  expect(matched.request().postDataJSON()).toEqual({ invoiceId: invoice.id, amountMinor: 1234 })
  expect(await invoiceRead(api, invoice.id)).toMatchObject({ paidMinor: 2000 + 1234 })

  // The invoice's details say where it stands and list its payments.
  const invoiceLoaded = answerOf(page, "GET", /^\/invoices$/)
  await page.goto(`/commercial?module=invoices&record=invoice-${invoice.id}`)
  expect((await invoiceLoaded).status()).toBe(200)
  await expect(page.getByTestId("invoice-payment-standing")).toContainText("Partially paid")
  await expect(page.getByTestId("invoice-payments").getByRole("button")).toHaveCount(3)

  // Østerbro Housing's statement for the day: the invoice raises the balance and the payments lower it.
  const customers = answerOf(page, "GET", /^\/customers$/)
  await page.goto("/customers?module=contacts")
  expect((await customers).status()).toBe(200)
  await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill("Østerbro Housing")
  await page.getByRole("button", { name: "Open Østerbro Housing" }).first().click()
  await page.getByTestId("customer-statement").getByRole("button", { name: "Statement" }).click()
  const window = dialogTitled(page, "Statement")
  await window.getByLabel(/^First day/).fill(day)
  await window.getByLabel(/^Last day/).fill(day)
  const [read] = await Promise.all([answerOf(page, "GET", /^\/customers\/[^/]+\/statement$/), window.getByRole("button", { name: "Show statement" }).click()])
  expect(read.status(), await read.text()).toBe(200)
  expect(Object.fromEntries(new URL(read.url()).searchParams)).toEqual({ currency: "DKK", from: day, to: day })
  const statement = page.getByTestId("statement")
  await expect(statement.getByTestId("statement-lines").getByText(`Invoice ${invoice.label}`)).toBeVisible()
  await expect(statement.getByTestId("statement-closing")).toBeVisible()
})
