import type { WasteFraction } from "@waste/contracts/catalogue"
import type { Customer } from "@waste/contracts/customers"
import type { SustainabilityReport, WasteFractionEmissionFactor } from "@waste/contracts/sustainability"

import { expect, test } from "./fixtures"
import { answerOf, toasts } from "./routes-support"
import { listAll } from "./tester"

// A Customer's sustainability report on the Pilot (#293 M13). The office
// sets a waste fraction's treatment in Settings › Master data — the edit's
// body names it, and the seed's is put back — and adds a waste fraction's
// emission factor in Settings › Operations › Emission factors for a year of
// its own far ahead, then ends it through its edit. A customer's details then
// read its Sustainability section, asked for, over a window the person
// spells: the report asked with the customer's server id and the two days, the file the
// API writes, and the printable page in a tab of its own, headed by the
// window. A fresh stack has no completed collection, so the section says so;
// a long-lived one shows the report.

test("the office sets a fraction's treatment and a waste factor, and reads a customer's sustainability report, its file and its printable page", async ({ api, page }) => {
  test.setTimeout(180_000)
  const glass = (await listAll<WasteFraction>(api, "/waste-fractions")).find((fraction) => fraction.key === "glass")
  if (glass === undefined) throw new Error("the seed holds no glass fraction")
  try {
    // Master data: Glass becomes disposal, and the patch names the treatment alone.
    await page.goto("/settings?pane=master-data&kind=waste-fraction")
    await page.getByPlaceholder("Search waste fractions").fill(glass.name)
    await page.getByRole("button", { name: `Edit ${glass.name}`, exact: true }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox", { name: /^Treatment/ }).click()
    await page.getByRole("option", { name: "Disposal", exact: true }).click()
    const [patched] = await Promise.all([answerOf(page, "PATCH", `/waste-fractions/${glass.id}`), dialog.getByRole("button", { name: "Save changes" }).click()])
    expect(patched.status(), await patched.text()).toBe(200)
    expect(patched.request().postDataJSON()).toEqual({ treatment: "disposal" })
    expect(((await (await api.get(`/waste-fractions/${glass.id}`)).json()) as WasteFraction).treatment).toBe("disposal")
    await expect(dialog).toBeHidden()

    // Emission factors: Glass's factor for a year of its own, added and then ended.
    const year = 2100 + Math.floor(Math.random() * 800)
    const source = `E2E demo value ${Date.now().toString(36)}`
    const read = answerOf(page, "GET", "/waste-fraction-emission-factors")
    await page.goto("/settings?pane=emission-factors")
    expect((await read).status()).toBe(200)
    const section = page.getByTestId("waste-factors")
    await section.getByRole("button", { name: "Add waste factor" }).click()
    const add = page.getByRole("dialog", { name: "Add waste factor" })
    await add.getByRole("combobox", { name: "Waste fraction" }).click()
    await page.getByRole("option", { name: glass.name, exact: true }).click()
    await add.getByLabel("kg CO₂e per t").fill("30")
    await add.getByLabel("kg CO₂e avoided per t").fill("400")
    await add.getByLabel("Source").fill(source)
    await add.getByLabel("First day in force").fill(`${year}-01-01`)
    await add.getByLabel("Last day in force").fill(`${year}-12-31`)
    const [created] = await Promise.all([answerOf(page, "POST", "/waste-fraction-emission-factors"), add.getByRole("button", { name: "Add waste factor" }).click()])
    expect(created.status(), await created.text()).toBe(201)
    expect(created.request().postDataJSON()).toEqual({ wasteFractionId: glass.id, footprintKgPerTonne: 30, avoidedKgPerTonne: 400, source, validFrom: `${year}-01-01`, validTo: `${year + 1}-01-01` })
    const factor = (await created.json()) as WasteFractionEmissionFactor
    await expect(toasts(page)).toContainText(`${glass.name}: 30 kg CO₂e per t, 400 kg avoided, ${year}-01-01 to ${year}-12-31.`)
    await section.getByRole("button", { name: `Edit ${glass.name} from ${year}-01-01` }).click()
    const edit = page.getByRole("dialog", { name: "Edit waste factor" })
    await expect(edit.getByLabel("kg CO₂e per t")).toBeDisabled()
    await edit.getByLabel("Last day in force").fill(`${year}-06-30`)
    const [ended] = await Promise.all([answerOf(page, "PATCH", `/waste-fraction-emission-factors/${factor.id}`), edit.getByRole("button", { name: "Save factor" }).click()])
    expect(ended.status(), await ended.text()).toBe(200)
    expect(ended.request().postDataJSON()).toEqual({ validTo: `${year}-07-01` })
    await expect(section.getByRole("row", { name: `${glass.name} from ${year}-01-01` })).toContainText(`${year}-01-01 to ${year}-06-30`)
  } finally {
    expect((await api.patch(`/waste-fractions/${glass.id}`, { data: { treatment: glass.treatment } })).status()).toBe(200)
  }

  // A customer's Sustainability section, over a window the person spells.
  const housing = (await listAll<Customer>(api, "/customers")).find((customer) => customer.name.startsWith("Østerbro Housing"))
  if (housing === undefined) throw new Error("the seed holds no Østerbro Housing")
  const customers = answerOf(page, "GET", "/customers")
  await page.goto("/customers?module=contacts")
  expect((await customers).status()).toBe(200)
  await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill("Østerbro Housing")
  await page.getByRole("button", { name: "Open Østerbro Housing" }).first().click()
  const sustainability = page.getByTestId("customer-sustainability")
  // Asked for, never read on every customer opened.
  await sustainability.getByTestId("sustainability-show").click()
  await sustainability.getByRole("combobox", { name: "Report period" }).click()
  await page.getByRole("option", { name: "Custom period" }).click()
  await sustainability.getByLabel("First day").fill("2026-01-01")
  const [asked] = await Promise.all([answerOf(page, "GET", "/reports/sustainability"), sustainability.getByLabel("Last day").fill("2026-12-31")])
  expect(asked.status(), await asked.text()).toBe(200)
  expect(Object.fromEntries(new URL(asked.url()).searchParams)).toEqual({ customerId: housing.id, from: "2026-01-01", to: "2026-12-31" })
  const report = (await asked.json()) as SustainabilityReport
  if (report.sites.length === 0) await expect(sustainability.getByText("No collection of this customer's was completed in this window.")).toBeVisible()
  else await expect(sustainability.getByTestId("sustainability-report")).toBeVisible()

  // The file as the API writes it, and the printable page headed by the window.
  const [download, file] = await Promise.all([page.waitForEvent("download"), answerOf(page, "GET", "/reports/sustainability.csv"), sustainability.getByTestId("sustainability-download").click()])
  expect(file.status()).toBe(200)
  expect(download.suggestedFilename()).toMatch(/\.csv$/)
  const [printable] = await Promise.all([page.waitForEvent("popup"), sustainability.getByTestId("sustainability-print").click()])
  await expect(printable.getByRole("heading", { name: "Sustainability report, Jan 1 – Dec 31 2026" })).toBeVisible({ timeout: 30_000 })
  await expect(printable.getByTestId("sustainability-print")).toContainText(housing.name)
})
