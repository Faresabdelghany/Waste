import type { Page } from "@playwright/test"
import type { EmissionsReport } from "@waste/contracts/emissions"
import { FUEL_TYPES } from "@waste/domain/resources/vocabulary"

import { plannedSentence } from "../lib/insight/emissions"
import { addDays, dispatchedRouteFor } from "./dispatched-route"
import { expect, test } from "./fixtures"
import { answerOf, routeRead, toasts } from "./routes-support"
import { listAll } from "./tester"

// The fleet's emissions on the Pilot (#293 M10). The office types what the
// seeded rear loader burns of diesel in Settings › Master data — refused at
// the field where the wire would refuse it, then put whole through the
// type's own route, its HVO kept — and adds an electric factor in Settings ›
// Operations › Emission factors, then ends it through its edit. A route
// generated on a seeded scheme and dispatched (dispatched-route.ts) is
// measured once the Plan Optimise asks for it is; the Dashboard's
// Performance tab then reads the last 7 days' planned emissions for its
// project — the total the API answers, the routes it could not measure, and
// the vehicle beside it — and asks the report without the window's
// interval, which its strict query refuses. Every body is the one the contracts take, read off the browser's
// own request. The rear loader's consumption is put back as the seed had it;
// the factor's period is a year of its own far ahead, so a run never meets
// an earlier run's on a long-lived stack.

type Consumption = { fuel: string; milliUnitsPerKm: number }
type VehicleType = { id: string; key: string; name: string; consumption: (Consumption & { unit: string })[] }

/** A set in the vocabulary's fuel order, the order the form sends it in. */
const inFuelOrder = (set: readonly Consumption[]) => [...set].sort((a, b) => FUEL_TYPES.indexOf(a.fuel as never) - FUEL_TYPES.indexOf(b.fuel as never))

async function choose(page: Page, filter: string, option: string) {
  await page.getByLabel(filter, { exact: true }).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

test("the office types a vehicle type's consumption and a fuel's factor, and the Dashboard reads the period's planned emissions", async ({ api, page }) => {
  test.setTimeout(180_000)
  const rearLoader = (await listAll<VehicleType>(api, "/vehicle-types")).find((type) => type.key === "rear-loader")
  if (rearLoader === undefined) throw new Error("the seed holds no rear loader")
  const seeded: Consumption[] = rearLoader.consumption.map(({ fuel, milliUnitsPerKm }) => ({ fuel, milliUnitsPerKm }))
  try {
    // Master data: the rear loader's diesel, refused at the field, then put whole beside its HVO.
    await page.goto("/settings?pane=master-data&kind=vehicle-type")
    await page.getByPlaceholder("Search vehicle types").fill(rearLoader.name)
    await page.getByRole("button", { name: `Edit ${rearLoader.name}` }).click()
    const dialog = page.getByRole("dialog")
    const writes: string[] = []
    page.on("request", (request) => {
      if (["PUT", "PATCH"].includes(request.method()) && request.url().includes("/vehicle-types/")) writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
    })
    await dialog.getByLabel("Diesel · l per 100 km").fill("0")
    await dialog.getByRole("button", { name: "Save changes" }).click()
    await expect(dialog.getByText("Give what it burns per 100 km as a number from 0.1 to 1,000, to one decimal place")).toBeVisible()
    expect(writes, "a consumption the wire would refuse never leaves the browser").toEqual([])
    await dialog.getByLabel("Diesel · l per 100 km").fill("41,5")
    const [put] = await Promise.all([answerOf(page, "PUT", `/vehicle-types/${rearLoader.id}/consumption`), dialog.getByRole("button", { name: "Save changes" }).click()])
    expect(put.status(), await put.text()).toBe(200)
    expect(put.request().postDataJSON()).toEqual({ consumption: inFuelOrder([{ fuel: "diesel", milliUnitsPerKm: 415 }, ...seeded.filter((entry) => entry.fuel !== "diesel")]) })
    expect(writes, "the consumption alone moved: no patch of the type").toEqual([`PUT /waste-api/vehicle-types/${rearLoader.id}/consumption`])
    await expect(dialog).toBeHidden()

    // Emission factors: the seeded diesel listed, an electric factor added for a year of its own, then ended through its edit.
    const year = 2100 + Math.floor(Math.random() * 800)
    const source = `E2E demo value ${Date.now().toString(36)}`
    const read = answerOf(page, "GET", "/fuel-emission-factors")
    await page.goto("/settings?pane=emission-factors")
    expect((await read).status()).toBe(200)
    const pane = page.locator("body")
    await expect(pane.getByRole("row", { name: "Diesel from 2025-01-01" })).toContainText("2,658 g CO₂e per l")
    await pane.getByRole("button", { name: "Add factor" }).click()
    const add = page.getByRole("dialog", { name: "Add factor" })
    await add.getByRole("combobox", { name: "Fuel" }).click()
    await page.getByRole("option", { name: "Electric", exact: true }).click()
    await add.getByLabel("g CO₂e per kWh").fill("120")
    await add.getByLabel("Source").fill(source)
    await add.getByLabel("First day in force").fill(`${year}-01-01`)
    await add.getByLabel("Last day in force").fill(`${year}-12-31`)
    const [created] = await Promise.all([answerOf(page, "POST", "/fuel-emission-factors"), add.getByRole("button", { name: "Add factor" }).click()])
    expect(created.status(), await created.text()).toBe(201)
    expect(created.request().postDataJSON()).toEqual({ fuel: "electric", gramsPerUnit: 120, source, validFrom: `${year}-01-01`, validTo: `${year + 1}-01-01` })
    const factor = (await created.json()) as { id: string; unit: string }
    expect(factor.unit).toBe("kwh")
    await expect(toasts(page)).toContainText(`Electric: 120 g CO₂e per kWh, ${year}-01-01 to ${year}-12-31.`)
    await pane.getByRole("button", { name: `Edit Electric from ${year}-01-01` }).click()
    const edit = page.getByRole("dialog", { name: "Edit factor" })
    await expect(edit.getByLabel("g CO₂e per kWh")).toBeDisabled()
    await edit.getByLabel("Last day in force").fill(`${year}-06-30`)
    const [ended] = await Promise.all([answerOf(page, "PATCH", `/fuel-emission-factors/${factor.id}`), edit.getByRole("button", { name: "Save factor" }).click()])
    expect(ended.status(), await ended.text()).toBe(200)
    expect(ended.request().postDataJSON()).toEqual({ validTo: `${year}-07-01` })
    await expect(pane.getByRole("row", { name: `Electric from ${year}-01-01` })).toContainText(`${year}-01-01 to ${year}-06-30`)

    // The Dashboard: a dispatched route, measured once its Plan is, and the card the report's own answer.
    const { route, today } = await dispatchedRouteFor(api)
    // Today is outside Plan Ahead's window (tomorrow on), so generation asked no Plan for today's route and dispatch asks none: the office's Optimise asks it, as dispatch-day.spec.ts does, and the fake provider measures it on the worker.
    const optimised = await api.post(`/routes/${route.id}/optimise`)
    expect([200, 202], await optimised.text()).toContain(optimised.status())
    await expect.poll(async () => (await routeRead(api, route.id)).activePlan?.status ?? "none", { timeout: 60_000, message: "the dispatched route's Plan is measured" }).toBe("ready")
    const window = { projectId: route.projectId, from: addDays(today, -6), to: today }
    const answer = await api.get("/reports/emissions", { params: window })
    expect(answer.status(), await answer.text()).toBe(200)
    const report = (await answer.json()) as EmissionsReport
    expect(report.planned.routes, "the dispatched route on WH-24 is measured: a rear loader on HVO").toBeGreaterThan(0)
    const project = (await (await api.get(`/projects/${route.projectId}`)).json()) as { name: string }

    const asked: string[] = []
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/waste-api/reports/emissions") asked.push(new URL(request.url()).search)
    })
    await page.goto("/performance")
    await expect(page.getByTestId("dashboard-on-api")).toBeVisible()
    await choose(page, "Period", "Last 7 days")
    await choose(page, "Project", project.name)
    const card = page.getByTestId("emissions")
    // The card's own sentence over the API's answer: the card says what the API answered.
    await expect(card.getByTestId("emissions-planned")).toHaveText(plannedSentence(report))
    await expect(card).toContainText("By fraction · split by stops")
    await expect(card).toContainText("WH-24 · HVO")
    expect(asked.length).toBeGreaterThan(0)
    for (const search of asked) expect(search, "the report is asked without the window's interval").not.toContain("interval")
  } finally {
    expect((await api.put(`/vehicle-types/${rearLoader.id}/consumption`, { data: { consumption: seeded } })).status()).toBe(200)
  }
})
