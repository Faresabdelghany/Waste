// The scale house on the web (M16a of #293): a walk-in weighed in at the
// window of one of our own sites in Operate › Scale house, weighed out at a
// second pass with the load split into two lines by fraction and origin, and
// the ticket read back through the API as the window wrote it. The site is
// this run's own, made through the API, so the shared stack's seeded stations
// are left as they are.
import type { Locator, Page } from "@playwright/test"

import { uniqueName } from "./env"
import { expect, test } from "./fixtures"
import { listAll } from "./tester"

type Named = { id: string; name: string }

const fail = (why: string): never => {
  throw new Error(why)
}

/** The browser's API call the page makes: the answer of `method` on a path under `path`. */
const answerOf = (page: Page, method: string, path: RegExp) =>
  page.waitForResponse((response) => response.request().method() === method && path.test(new URL(response.url()).pathname.replace(/^\/waste-api/, "")))

/** Picks an option of a select field in a dialog by its label and the start of the option's. */
async function pick(dialog: Locator, page: Page, field: RegExp, option: RegExp) {
  await dialog.getByRole("combobox", { name: field }).click()
  await page.getByRole("option", { name: option }).first().click()
}

const dialogTitled = (page: Page, title: string) => page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: title, exact: true }) })

test("a walk-in weighed in and out at the window, the load split into lines by fraction and origin (M16a of #293)", async ({ page, api }) => {
  test.setTimeout(120_000)
  const fractions = await listAll<Named & { key: string }>(api, "/waste-fractions")
  const residual = fractions.find((fraction) => fraction.key === "residual") ?? fail("the seed has no residual fraction")
  const mixed = fractions.find((fraction) => fraction.key === "mixed") ?? fail("the seed has no mixed fraction")
  const suffix = Date.now().toString(36).toUpperCase()
  const siteName = uniqueName("E2E scale house")
  const opened = await api.post("/unloading-stations", {
    data: { code: `E2E-SH-${suffix}`, name: siteName, address: "Sundkrogsgade 30\n2100 København Ø", location: { type: "Point", coordinates: [12.59, 55.71] }, ownership: "company", weighbridge: true, wasteFractionIds: [residual.id, mixed.id] },
  })
  expect(opened.status(), await opened.text()).toBe(201)
  const site = (await opened.json()) as Named
  const plate = `E2E ${suffix}`

  const loaded = answerOf(page, "GET", /^\/scale-tickets$/)
  await page.goto("/operate?module=scale-house")
  expect((await loaded).status()).toBe(200)

  // Weigh in: a walk-in at the site's gross.
  await page.getByRole("button", { name: "Weigh in" }).click()
  const weighIn = dialogTitled(page, "Weigh in")
  await pick(weighIn, page, /^Project/, /^Copenhagen Central/)
  await pick(weighIn, page, /^Site/, new RegExp(`^${siteName}`))
  await weighIn.getByLabel(/^Plate/).fill(plate)
  await weighIn.getByLabel(/^Gross \(kg\)/).fill("3400")
  await weighIn.getByLabel(/^Visitor's name/).fill("Lars")
  const [created] = await Promise.all([answerOf(page, "POST", /^\/scale-tickets$/), weighIn.getByRole("button", { name: "Weigh in" }).click()])
  expect(created.status(), await created.text()).toBe(201)
  const ticket = (await created.json()) as { id: string; number: number; status: string; unloadingStationId: string; party: string }
  expect([ticket.status, ticket.unloadingStationId, ticket.party]).toEqual(["open", site.id, "cash"])
  await expect(weighIn).toBeHidden()

  // Weigh out: a second pass, and the load split into two lines.
  const details = page.getByRole("dialog").filter({ has: page.getByTestId("scale-house-commands") })
  await details.getByTestId("scale-house-commands").getByRole("button", { name: "Weigh out" }).click()
  const weighOut = dialogTitled(page, "Weigh out")
  await weighOut.getByLabel(/^Tare \(kg\)/).fill("2500")
  await pick(weighOut, page, /^Fraction 1/, new RegExp(`^${residual.name}$`))
  await weighOut.getByLabel(/^Origin municipality 1/).fill("0101")
  await weighOut.getByLabel(/^Net 1 \(kg\)/).fill("500")
  await pick(weighOut, page, /^Fraction 2/, new RegExp(`^${mixed.name}$`))
  await weighOut.getByLabel(/^Net 2 \(kg\)/).fill("400")
  const [completed] = await Promise.all([answerOf(page, "POST", new RegExp(`^/scale-tickets/${ticket.id}/complete$`)), weighOut.getByRole("button", { name: "Weigh out" }).click()])
  expect(completed.status(), await completed.text()).toBe(200)
  expect(completed.request().postDataJSON()).toEqual({
    tare: { source: "weighed", tareKg: 2500 },
    lines: [
      { wasteFractionId: residual.id, netKg: 500, originMunicipality: "0101" },
      { wasteFractionId: mixed.id, netKg: 400 },
    ],
  })
  await expect(details.getByTestId("scale-house-commands").getByRole("button", { name: "Weigh out" })).toHaveCount(0)
  await expect(details).toContainText(`ST-${ticket.number}`)

  const read = (await (await api.get(`/scale-tickets/${ticket.id}`)).json()) as { status: string; netKg: number; lines: { netKg: number; originMunicipality: string | null }[] }
  expect([read.status, read.netKg]).toEqual(["completed", 900])
  expect(read.lines.map((line) => [line.originMunicipality, line.netKg])).toEqual([
    ["0101", 500],
    [null, 400],
  ])
})

test("a walk-in's load sold by the tonne at the window: weighed out with its product, and what it comes to read in its details (M16b of #293)", async ({ page, api }) => {
  test.setTimeout(120_000)
  const project = (await listAll<Named>(api, "/projects")).find((candidate) => candidate.name === "Copenhagen Central") ?? fail("the seed has no Copenhagen Central")
  const residual = (await listAll<Named & { key: string }>(api, "/waste-fractions")).find((fraction) => fraction.key === "residual") ?? fail("the seed has no residual fraction")
  const suffix = Date.now().toString(36).toUpperCase()
  const siteName = uniqueName("E2E window prices")
  const opened = await api.post("/unloading-stations", {
    data: { code: `E2E-WP-${suffix}`, name: siteName, address: "Sundkrogsgade 32\n2100 København Ø", location: { type: "Point", coordinates: [12.59, 55.71] }, ownership: "company", weighbridge: true, wasteFractionIds: [residual.id] },
  })
  expect(opened.status(), await opened.text()).toBe(201)
  const productName = uniqueName("E2E residual by the tonne")
  const made = await api.post("/products", { data: { projectId: project.id, name: productName, kind: "additional-service", status: "active", unit: "tonne", vatPercent: 25 } })
  expect(made.status(), await made.text()).toBe(201)
  const productId = ((await made.json()) as { id: string }).id
  const today = new Date().toISOString().slice(0, 10)
  const [list] = (await listAll<{ id: string; isDefault: boolean; validFrom: string }>(api, "/price-lists", { projectId: project.id })).filter((candidate) => candidate.isDefault && candidate.validFrom <= today)
  if (list === undefined) throw new Error(`${project.name} has no default price list in force today`)
  const base = await api.post(`/price-lists/${list.id}/rows`, { data: { productId, unitPriceMinor: 60_000, validFrom: list.validFrom } })
  expect(base.status(), await base.text()).toBe(201)
  const tier = await api.post(`/price-lists/${list.id}/rows`, { data: { productId, unitPriceMinor: 50_000, fromQuantity: 2, validFrom: list.validFrom } })
  expect(tier.status(), await tier.text()).toBe(201)

  const loaded = answerOf(page, "GET", /^\/scale-tickets$/)
  await page.goto("/operate?module=scale-house")
  expect((await loaded).status()).toBe(200)
  await page.getByRole("button", { name: "Weigh in" }).click()
  const weighIn = dialogTitled(page, "Weigh in")
  await pick(weighIn, page, /^Project/, /^Copenhagen Central/)
  await pick(weighIn, page, /^Site/, new RegExp(`^${siteName}`))
  await weighIn.getByLabel(/^Plate/).fill(`E2E ${suffix}`)
  await weighIn.getByLabel(/^Gross \(kg\)/).fill("4500")
  const [created] = await Promise.all([answerOf(page, "POST", /^\/scale-tickets$/), weighIn.getByRole("button", { name: "Weigh in" }).click()])
  expect(created.status(), await created.text()).toBe(201)
  const ticket = (await created.json()) as { id: string }

  const details = page.getByRole("dialog").filter({ has: page.getByTestId("scale-house-commands") })
  await details.getByTestId("scale-house-commands").getByRole("button", { name: "Weigh out" }).click()
  const weighOut = dialogTitled(page, "Weigh out")
  await weighOut.getByLabel(/^Tare \(kg\)/).fill("2000")
  await pick(weighOut, page, /^Fraction 1/, new RegExp(`^${residual.name}$`))
  await weighOut.getByLabel(/^Net 1 \(kg\)/).fill("2500")
  await pick(weighOut, page, /^Sold as 1/, new RegExp(`^${productName}`))
  const [completed] = await Promise.all([answerOf(page, "POST", new RegExp(`^/scale-tickets/${ticket.id}/complete$`)), weighOut.getByRole("button", { name: "Weigh out" }).click()])
  expect(completed.status(), await completed.text()).toBe(200)
  expect((completed.request().postDataJSON() as { lines: unknown[] }).lines).toEqual([{ wasteFractionId: residual.id, netKg: 2500, productId }])

  // 2.5 tonnes meet the tier from 2: 500.00 a tonne, 1,250.00 net and 1,562.50 with VAT.
  const amount = details.getByTestId("scale-ticket-amount-due")
  const [due] = await Promise.all([answerOf(page, "GET", new RegExp(`^/scale-tickets/${ticket.id}/amount-due$`)), amount.getByRole("button", { name: "Amount due" }).click()])
  expect(due.status(), await due.text()).toBe(200)
  expect(((await due.json()) as { totalMinor: number; complete: boolean })).toMatchObject({ totalMinor: 156_250, complete: true })
  await expect(amount).toContainText("Total")
})
