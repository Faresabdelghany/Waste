import type { APIRequestContext, Locator, Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { uniqueName } from "./env"

// Slice 10 (#185, for #148): the Price Engine's customer-money chain on the
// API, against the seeded tenant — a product made in Settings › Commercial
// with its invoice fields; a price added to Copenhagen's default list and
// edited, and Explain price showing why Østerbro Housing's negotiated row
// wins; a manual billable event blocked for want of a price row, repriced
// once the row is there, explained on its own question (#259) and cancelled;
// an event under an agreement billed to another party naming its customer
// and its payer each (#256); a billing run previewed, run, its
// invoice read with the event's line and partially credited. Nothing here is
// a fixture scenario ported: no fixture spec covered the Commercial modules.
// Records are uniquely named and never cleaned up; a run is over a day of
// its own, so the ready events it invoices are this run's.
type Project = { id: string; name: string }
type Product = { id: string; name: string; projectId: string; status: string; kind: string; unit: string; invoiceCode: string | null; vatPercent: number | null }
type PriceList = { id: string; code: string; projectId: string; isDefault: boolean }
type Agreement = { id: string; number: string; projectId: string; customerId: string }
type BillableEvent = { id: string; status: string; blockReason: string | null; netMinor: number | null; invoiceLineId: string | null; cancelReason: string | null }
type InvoiceLine = { id: string; position: number; billableEventId: string | null; creditsLineId: string | null; quantity: number; description: string }
type InvoiceDetail = { id: string; label: string; kind: string; lines: InvoiceLine[]; creditNotes: { id: string; label: string }[] }
type ListPage<T> = { items: T[]; nextCursor: string | null }

/** The browser's API call the page makes: the answer of `method` on a path under `path`. */
const answerOf = (page: Page, method: string, path: RegExp) =>
  page.waitForResponse((response) => response.request().method() === method && path.test(new URL(response.url()).pathname.replace(/^\/waste-api/, "")))

/** Picks an option of a select field in a dialog by its label and the start of the option's (a picker shows a row's status beside its name). */
async function pick(dialog: Locator, page: Page, field: RegExp, option: RegExp) {
  await dialog.getByRole("combobox", { name: field }).click()
  await page.getByRole("option", { name: option }).first().click()
}

/** A dialog by its heading: the details sheet and a form dialog may both be open. */
const dialogTitled = (page: Page, title: string) => page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: title, exact: true }) })

async function itemsOf<T>(api: APIRequestContext, path: string): Promise<T[]> {
  const response = await api.get(path)
  expect(response.status(), path).toBe(200)
  return ((await response.json()) as ListPage<T>).items
}

async function copenhagen(api: APIRequestContext): Promise<Project> {
  const project = (await itemsOf<Project>(api, "/projects?limit=200")).find((candidate) => candidate.name === "Copenhagen Central")
  if (project === undefined) throw new Error("the seed has no Copenhagen Central")
  return project
}

async function defaultList(api: APIRequestContext, project: Project): Promise<PriceList> {
  const [list] = await itemsOf<PriceList>(api, `/price-lists?limit=200&projectId=${project.id}&isDefault=true`)
  if (list === undefined) throw new Error(`${project.name} has no default price list`)
  return list
}

/** A seeded agreement by its number: AGR-2408, Østerbro Housing's own; AGR-2603, DEAS Ejendomme's, billed to Københavns Kommune. */
async function agreementNumbered(api: APIRequestContext, number: string): Promise<Agreement> {
  const agreement = (await itemsOf<Agreement>(api, "/agreements?limit=200")).find((candidate) => candidate.number === number)
  if (agreement === undefined) throw new Error(`the seed has no ${number}`)
  return agreement
}

/** A product of the project made through the API, active and with a VAT rate: what a test prices or bills. */
async function newProduct(api: APIRequestContext, project: Project, prefix: string): Promise<Product> {
  const name = uniqueName(prefix)
  const response = await api.post("/products", { data: { projectId: project.id, name, kind: "additional-service", status: "active", unit: "job", invoiceName: name, invoiceCode: `E2E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase(), vatPercent: 25 } })
  expect(response.status()).toBe(201)
  return (await response.json()) as Product
}

async function addRow(api: APIRequestContext, list: PriceList, product: Product, unitPriceMinor: number) {
  const response = await api.post(`/price-lists/${list.id}/rows`, { data: { productId: product.id, unitPriceMinor, validFrom: "2026-01-01" } })
  expect(response.status()).toBe(201)
}

/** A service date of this run's own, in the past — a run is for a closed period — and inside the seeded agreement's and the default list's open periods; the specs that bill keep months of their own. */
function dayOfItsOwn(): string {
  const offset = Math.floor(Date.now() / 1000) % 60
  return new Date(Date.UTC(2026, 2, 1) + offset * 86_400_000).toISOString().slice(0, 10)
}

/** A fact of a record's details, the row its label heads (`StatRow`). */
const factOf = (details: Locator, label: string) => details.getByText(label, { exact: true }).locator("xpath=../..")

/** Opens a Price Engine module and waits for its list read. */
async function openModule(page: Page, moduleId: string, listPath: RegExp) {
  const loaded = answerOf(page, "GET", listPath)
  await page.goto(`/commercial?module=${moduleId}`)
  expect((await loaded).status()).toBe(200)
}

test("Settings › Commercial › Products: a product made on the API with its invoice fields, then withdrawn and its VAT rate cleared", async ({ page, api }) => {
  const name = uniqueName("E2E Garden waste")
  const code = `E2E-${Date.now().toString(36)}`.toUpperCase()
  const loaded = answerOf(page, "GET", /^\/products$/)
  await page.goto("/settings?pane=commercial-products")
  expect((await loaded).status()).toBe(200)
  await expect(page.getByTestId("products-on-api").getByText("Residual waste · 240L bin").first()).toBeVisible()

  await page.getByRole("button", { name: "New product" }).click()
  const dialog = dialogTitled(page, "New product")
  await expect(dialog).toBeVisible()
  await pick(dialog, page, /^Project/, /^Copenhagen Central/)
  await dialog.getByLabel(/^Product name/).fill(name)
  await pick(dialog, page, /^Type/, /^Container collection/)
  await pick(dialog, page, /^Status/, /^Active/)
  await pick(dialog, page, /^Waste fraction/, /^Residual/)
  await dialog.getByLabel(/^Invoice name/).fill(`${name} collection`)
  await dialog.getByLabel(/^Invoice code/).fill(code)
  await dialog.getByLabel(/^VAT rate/).fill("25")
  const [created] = await Promise.all([answerOf(page, "POST", /^\/products$/), dialog.getByRole("button", { name: "Create product" }).click()])
  expect(created.status()).toBe(201)
  const product = (await created.json()) as Product
  expect(product).toMatchObject({ name, kind: "container-collection", status: "active", unit: "pickup", invoiceCode: code, vatPercent: 25 })
  await expect(dialog).toBeHidden()

  await page.getByRole("button", { name: `Edit ${name}` }).click()
  const edit = dialogTitled(page, "Edit product")
  await expect(edit.getByRole("combobox", { name: /^Project/ })).toBeDisabled()
  await pick(edit, page, /^Status/, /^Inactive/)
  await edit.getByLabel(/^VAT rate/).fill("")
  const [patched] = await Promise.all([answerOf(page, "PATCH", new RegExp(`^/products/${product.id}$`)), edit.getByRole("button", { name: "Save changes" }).click()])
  expect(patched.status()).toBe(200)
  expect(patched.request().postDataJSON()).toEqual({ status: "inactive", vatPercent: null })
  const read = (await (await api.get(`/products/${product.id}`)).json()) as Product
  expect(read).toMatchObject({ status: "inactive", vatPercent: null })
})

test("Price rows: a price added to Copenhagen's default list and edited, the table listing rows and never the lists, and Explain price showing why the negotiated row wins", async ({ page, api }) => {
  const project = await copenhagen(api)
  const list = await defaultList(api, project)
  const product = await newProduct(api, project, "E2E Skip hire")
  await openModule(page, "price-rows", /^\/price-lists$/)
  // The lists are the module's first kind and never one of its table's rows.
  await expect(page.getByText("Annual tariff for Copenhagen municipal collection.")).toHaveCount(0)

  await page.getByRole("button", { name: "Add price" }).click()
  const dialog = dialogTitled(page, "Add price")
  await pick(dialog, page, /^Price list/, new RegExp(`^${list.code}`))
  await pick(dialog, page, /^Product/, new RegExp(`^${product.name}`))
  await dialog.getByLabel(/^Amount/).fill("12.50")
  await dialog.getByLabel(/^Effective from/).fill("2026-01-01")
  const [created] = await Promise.all([answerOf(page, "POST", new RegExp(`^/price-lists/${list.id}/rows$`)), dialog.getByRole("button", { name: "Add price" }).click()])
  expect(created.status()).toBe(201)
  expect(created.request().postDataJSON()).toEqual({ productId: product.id, unitPriceMinor: 1250, validFrom: "2026-01-01" })
  const row = (await created.json()) as { id: string }

  // The new row's details open on the API's answer: its amount in the list's currency, per the product's unit.
  const details = page.getByRole("dialog").filter({ has: page.getByTestId("price-row-commands") })
  await expect(details.getByText("12.50", { exact: true })).toBeVisible()
  await expect(details.getByText("job", { exact: true })).toBeVisible()
  await details.getByRole("button", { name: "Edit price" }).click()
  const edit = dialogTitled(page, "Edit price")
  await expect(edit.getByRole("combobox", { name: /^Product/ })).toBeDisabled()
  await edit.getByLabel(/^Amount/).fill("13.75")
  await edit.getByLabel(/^Effective to/).fill("2027-12-31")
  const [patched] = await Promise.all([answerOf(page, "PATCH", new RegExp(`^/price-list-rows/${row.id}$`)), edit.getByRole("button", { name: "Save changes" }).click()])
  expect(patched.status()).toBe(200)
  expect(patched.request().postDataJSON()).toEqual({ unitPriceMinor: 1375, validTo: "2028-01-01" })
  await page.keyboard.press("Escape")

  await page.getByRole("button", { name: "Explain price" }).click()
  const question = dialogTitled(page, "Explain price")
  await pick(question, page, /^Price list/, new RegExp(`^${list.code}`))
  await pick(question, page, /^Product/, /^Residual waste · 240L bin/)
  await question.getByLabel(/^On/).fill("2026-10-01")
  await pick(question, page, /^Customer type/, /^Organisation/)
  await pick(question, page, /^Customer$/, /^Østerbro Housing/)
  const [resolved] = await Promise.all([answerOf(page, "GET", new RegExp(`^/price-lists/${list.id}/resolve$`)), question.getByRole("button", { name: "Explain" }).click()])
  expect(resolved.status()).toBe(200)
  const answer = page.getByTestId("explain-price")
  await expect(answer.getByText(/^Østerbro Housing \(negotiated\) wins at DKK/)).toBeVisible()
  await expect(answer.locator("[data-verdict=Won]")).toContainText("Østerbro Housing (negotiated)")
  await expect(answer.locator("[data-verdict=Eligible]").filter({ hasText: "Organisation" })).toHaveCount(1)
  await expect(answer.getByText(/^The row matching the most conditions wins/)).toBeVisible()
})

test("Billable events: open on the blocked and the ready; a manual event blocked for want of a price row, repriced once the row is there, then cancelled", async ({ page, api }) => {
  const project = await copenhagen(api)
  const list = await defaultList(api, project)
  const product = await newProduct(api, project, "E2E Late collection")
  await openModule(page, "events", /^\/billable-events$/)
  await expect(page.getByText("Status: Blocked")).toBeVisible()
  await expect(page.getByText("Status: Ready")).toBeVisible()

  await page.getByRole("button", { name: "Add manual event" }).click()
  const dialog = dialogTitled(page, "Add manual event")
  await pick(dialog, page, /^Agreement/, /^AGR-2408/)
  await pick(dialog, page, /^Product/, new RegExp(`^${product.name}`))
  await dialog.getByLabel(/^Service date/).fill("2026-10-05")
  await dialog.getByLabel(/^Note/).fill("Collected after hours")
  const [created] = await Promise.all([answerOf(page, "POST", /^\/billable-events$/), dialog.getByRole("button", { name: "Add manual event" }).click()])
  expect(created.status()).toBe(201)
  const event = (await created.json()) as BillableEvent
  expect(event).toMatchObject({ status: "blocked", blockReason: "no-price-row", netMinor: null })

  const details = page.getByRole("dialog").filter({ has: page.getByTestId("event-commands") })
  await expect(details.getByText("No price row").first()).toBeVisible()
  await addRow(api, list, product, 7500)
  await details.getByRole("button", { name: "Reprice" }).click()
  const reprice = dialogTitled(page, "Reprice")
  const [repriced] = await Promise.all([answerOf(page, "POST", new RegExp(`^/billable-events/${event.id}/reprice$`)), reprice.getByRole("button", { name: "Reprice" }).click()])
  expect(repriced.status()).toBe(200)
  expect((await repriced.json()) as BillableEvent).toMatchObject({ status: "ready", blockReason: null, netMinor: 7500 })
  await expect(details.getByText("DKK 75.00").first()).toBeVisible()
  // A priced event is not repriced: its details offer only what the API moves a ready one by (#281).
  await expect(details.getByRole("button", { name: "Reprice" })).toHaveCount(0)
  // AGR-2408's customer pays for itself: one party under both its facts (#256).
  await expect(factOf(details, "Customer")).toContainText("Østerbro Housing")
  await expect(factOf(details, "Payer")).toContainText("Østerbro Housing")

  // Why it costs DKK 75.00: Explain price, the price rows' own dialog, opened on the event's question (#259).
  const agreement = await agreementNumbered(api, "AGR-2408")
  await details.getByRole("button", { name: "Explain price" }).click()
  const question = dialogTitled(page, "Explain price")
  await expect(question.getByRole("combobox", { name: /^Price list/ })).toContainText(list.code)
  await expect(question.getByRole("combobox", { name: /^Product/ })).toContainText(product.name)
  await expect(question.getByLabel(/^On/)).toHaveValue("2026-10-05")
  await expect(question.getByRole("combobox", { name: /^Customer type/ })).toContainText("Organisation")
  await expect(question.getByRole("combobox", { name: /^Customer$/ })).toContainText("Østerbro Housing")
  const [resolved] = await Promise.all([answerOf(page, "GET", new RegExp(`^/price-lists/${list.id}/resolve$`)), question.getByRole("button", { name: "Explain" }).click()])
  expect(resolved.status()).toBe(200)
  const asked = new URL(resolved.url()).searchParams
  expect([asked.get("productId"), asked.get("on"), asked.get("customerKind"), asked.get("customerId")]).toEqual([product.id, "2026-10-05", "organisation", agreement.customerId])
  const answer = page.getByTestId("explain-price")
  await expect(answer.getByText(/wins at DKK 75\.00/)).toBeVisible()
  await answer.getByRole("button", { name: "Done" }).click()

  await details.getByRole("button", { name: "Cancel event" }).click()
  const cancel = dialogTitled(page, "Cancel event")
  await pick(cancel, page, /^Reason/, /^Duplicate/)
  const [cancelled] = await Promise.all([answerOf(page, "POST", new RegExp(`^/billable-events/${event.id}/cancel$`)), cancel.getByRole("button", { name: "Cancel event" }).click()])
  expect(cancelled.status()).toBe(200)
  expect(cancelled.request().postDataJSON()).toEqual({ reason: "duplicate" })
  expect((await cancelled.json()) as BillableEvent).toMatchObject({ status: "cancelled", cancelReason: "duplicate" })
  // A cancelled event has nothing left to do: no command is offered (#281).
  await expect(details.getByRole("button", { name: "Cancel event" })).toHaveCount(0)
  await expect(details.getByRole("button", { name: "Reprice" })).toHaveCount(0)
})

test("Billable events: an event under an agreement billed to another party names its customer and its payer, each by its own fact (#256)", async ({ page, api }) => {
  const project = await copenhagen(api)
  const agreement = await agreementNumbered(api, "AGR-2603")
  const product = await newProduct(api, project, "E2E Bin wash")
  // Blocked for want of a price row, as the manual event above is before its row: what is asked here is whom it names.
  const created = await api.post("/billable-events", { data: { projectId: project.id, agreementId: agreement.id, productId: product.id, quantity: 1, serviceDate: "2026-10-06" } })
  expect(created.status(), await created.text()).toBe(201)
  const event = (await created.json()) as BillableEvent

  const loaded = answerOf(page, "GET", /^\/billable-events$/)
  await page.goto(`/commercial?module=events&record=event-${event.id}`)
  expect((await loaded).status()).toBe(200)
  const details = page.getByRole("dialog").filter({ has: page.getByTestId("event-commands") })
  await expect(factOf(details, "Customer")).toContainText("DEAS Ejendomme")
  await expect(factOf(details, "Payer")).toContainText("Københavns Kommune")
  await expect(factOf(details, "Agreement")).toContainText("AGR-2603")
})

test("Billing Runs: a run previewed, then run over a day of its own; its invoice read with the event's line and partially credited", async ({ page, api }) => {
  const project = await copenhagen(api)
  const agreement = await agreementNumbered(api, "AGR-2408")
  const bulky = (await itemsOf<Product>(api, `/products?limit=200&projectId=${project.id}`)).find((candidate) => candidate.name === "Bulky waste pickup")
  if (bulky === undefined) throw new Error("the seed has no Bulky waste pickup in Copenhagen")
  const day = dayOfItsOwn()
  const made = await api.post("/billable-events", { data: { projectId: project.id, agreementId: agreement.id, productId: bulky.id, quantity: 2, serviceDate: day, note: "Two sofas" } })
  expect(made.status()).toBe(201)
  const event = (await made.json()) as BillableEvent
  expect(event).toMatchObject({ status: "ready", netMinor: 9000 })

  await openModule(page, "billing", /^\/billing-runs$/)
  await page.getByRole("button", { name: "Run billing" }).click()
  const period = dialogTitled(page, "Run billing")
  await pick(period, page, /^Project/, /^Copenhagen Central/)
  await period.getByLabel(/^First day/).fill(day)
  await period.getByLabel(/^Last day/).fill(day)
  const [previewed] = await Promise.all([answerOf(page, "POST", /^\/billing-runs\/preview$/), period.getByRole("button", { name: "Preview" }).click()])
  expect(previewed.status()).toBe(200)
  const preview = page.getByTestId("billing-preview")
  await expect(preview.getByTestId("preview-events")).not.toHaveText("0")
  await expect(preview.getByText(/^Total in DKK/)).toBeVisible()
  // The preview wrote nothing: the event is still ready.
  expect(((await (await api.get(`/billable-events/${event.id}`)).json()) as BillableEvent).status).toBe("ready")

  const [run] = await Promise.all([answerOf(page, "POST", /^\/billing-runs$/), preview.getByRole("button", { name: "Run billing" }).click()])
  expect(run.status()).toBe(201)
  const detail = (await run.json()) as { id: string; status: string; invoiceIds: string[] }
  expect(detail.status).toBe("completed")
  const billed = (await (await api.get(`/billable-events/${event.id}`)).json()) as BillableEvent
  expect(billed.status).toBe("invoiced")
  let invoice: InvoiceDetail | undefined
  for (const id of detail.invoiceIds) {
    const read = (await (await api.get(`/invoices/${id}`)).json()) as InvoiceDetail
    if (read.lines.some((line) => line.billableEventId === event.id)) invoice = read
  }
  if (invoice === undefined) throw new Error("the run issued no invoice with the event's line")
  const line = invoice.lines.find((candidate) => candidate.billableEventId === event.id)!

  // The run's details list the invoice it issued; it opens in Invoices with its lines.
  const runDetails = page.getByTestId("billing-run-commands")
  await expect(runDetails.getByTestId("run-invoices").getByText(new RegExp(`^${invoice.label} · `))).toBeVisible()
  await runDetails.getByTestId("run-invoices").getByText(new RegExp(`^${invoice.label} · `)).click()
  await page.waitForURL(/module=invoices/)
  const invoiceDetails = page.getByTestId("invoice-commands")
  await expect(invoiceDetails.getByTestId("invoice-lines").getByText(line.description)).toBeVisible()

  await invoiceDetails.getByRole("button", { name: "New credit note" }).click()
  const credit = dialogTitled(page, "New credit note")
  await pick(credit, page, /^Reason/, /^Quantity correction/)
  await pick(credit, page, /^What it credits/, /^The lines I name/)
  await credit.getByLabel(new RegExp(`^Line ${line.position} · `)).fill("1")
  const [issued] = await Promise.all([answerOf(page, "POST", new RegExp(`^/invoices/${invoice.id}/credit-notes$`)), credit.getByRole("button", { name: "Issue credit note" }).click()])
  expect(issued.status()).toBe(201)
  expect(issued.request().postDataJSON()).toEqual({ reason: "quantity-correction", lines: [{ lineId: line.id, quantity: 1 }] })
  const note = (await issued.json()) as InvoiceDetail
  expect(note.kind).toBe("credit-note")
  expect(note.lines).toEqual([expect.objectContaining({ creditsLineId: line.id, quantity: 1 })])
  await expect(invoiceDetails.getByTestId("invoice-credit-notes").getByText(new RegExp(`^${note.label} · `))).toBeVisible()
  const reread = (await (await api.get(`/invoices/${invoice.id}`)).json()) as InvoiceDetail
  expect(reread.creditNotes.map((candidate) => candidate.id)).toContain(note.id)
})
