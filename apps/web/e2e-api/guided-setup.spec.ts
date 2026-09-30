import type { APIRequestContext, Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { uniqueName } from "./env"
import { addGroup, answerOf, dayFromToday, fillScope, fleetOfItsOwn, nextButton, openGroupEditor, openSchemes, optionTexts, pick, startGuided, stepHeading, toasts, toGroups, wizard } from "./guided-setup"
import { listAll, projectNamed } from "./tester"

// Slice 4 of #81 (Issue #178): the guided setup on the API, and the
// generation trigger. The wizard's fixture specs (step1-scope-and-gate,
// step2-holidays, step3-groups, step4-step5-create, retired with this slice)
// port by behaviour, one test each: step 1 is a labelled dialog offering the
// API's rows and gating on the scope; step 2 applies the project's holidays
// as the API holds them; step 3's group names the API's fleet and judges a
// licence on the day the API judges it on (Lars Møller's ran out on
// 2026-09-05); step 5 creates the scheme in one POST. The fifth is the
// generation scenario as far as the run: Generate on the scheme's page asks
// the API for a run, and the page watches it until the worker has finished
// it — the routes it wrote are read with slice 6 (#179). The last two are
// step 4's preview through the API (#173's pair, added here since #173 merged
// first); its fixture-mode reading is e2e/wizard-preview-geometry.spec.ts.
// Schemes the tests make are uniquely named and never cleaned up.
type Named = { id: string; name: string }
type Scheme = { id: string; name: string; status: string; collectionGroups: { name: string; rule: { wasteFractionIds: string[]; containerTypeIds: string[] } | null; vehicleId: string | null; driverId: string | null }[] }
type GenerationRun = { id: string; status: string; routeSchemeId: string; trigger: string; windowFrom: string; windowTo: string; routesCreated: number }

/** A validated scheme with one rule group, made through the API: Residual inside Indre By Operations on Mondays and Thursdays, from tomorrow. */
async function schemeThroughApi(api: APIRequestContext, name: string): Promise<Scheme> {
  const project = await projectNamed(api, "Copenhagen Central")
  const area = (await listAll<Named>(api, "/planning-areas")).find((row) => row.name === "Indre By Operations")
  const residual = (await listAll<Named>(api, "/waste-fractions")).find((row) => row.name === "Residual")
  expect(area && residual, "the seed holds Indre By Operations and Residual").toBeTruthy()
  const response = await api.post("/route-schemes", {
    data: {
      projectId: project.id,
      name,
      planningAreaId: area?.id,
      serviceType: "container-collection",
      frequency: "weekly",
      serviceDays: ["monday", "thursday"],
      plannedStartTime: "06:30",
      status: "validated",
      validFrom: dayFromToday(1),
      collectionGroups: [{ name, days: ["monday", "thursday"], stopSource: "rule", rule: { wasteFractionIds: [residual?.id], containerTypeIds: [], vehicleTypeId: null } }],
    },
  })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()) as Scheme
}

test("the wizard is a labelled dialog whose first step offers the API's rows and gates on the scope", async ({ api, page }) => {
  await openSchemes(page)
  await startGuided(page)
  const root = wizard(page)
  await expect(root).toHaveAccessibleName("New route scheme")
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true)
  await page.keyboard.press("Tab")
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true)

  // The fractions are the master data's, every one and nothing else.
  const fractions = (await listAll<Named>(api, "/waste-fractions")).map((row) => row.name)
  expect((await optionTexts(page, root, "Waste fraction")).sort()).toEqual([...fractions].sort())
  expect(await optionTexts(page, root, "Service type")).toEqual(["Container collection", "Underground collection", "Kerbside collection", "Crane collection", "Tank emptying"])

  await expect(nextButton(page)).toBeDisabled()
  await root.getByLabel("Route scheme name").fill(uniqueName("E2E Gate"))
  await pick(page, root, "Project", "Copenhagen Central")
  await pick(page, root, "Operational planning area", "Indre By Operations")
  await expect(nextButton(page)).toBeDisabled()
  await pick(page, root, "Waste fraction", "Residual")
  await expect(nextButton(page)).toBeDisabled()
  await pick(page, root, "Service type", "Kerbside collection")
  await expect(nextButton(page)).toBeEnabled()

  await page.keyboard.press("Escape")
  await expect(root).toBeHidden()
})

test("step 2 reads the project's holiday list from the API, and the next dates apply it per policy", async ({ page }) => {
  await openSchemes(page)
  await startGuided(page)
  await fillScope(page, uniqueName("E2E Holidays"))
  await nextButton(page).click()
  const root = wizard(page)
  await expect(root.getByTestId("project-calendar")).toContainText("Danish public holidays · Sat–Sun weekend")
  await root.getByLabel("Effective from").fill("2026-12-21")
  await root.getByLabel("Effective to (optional)").fill("2026-12-31")
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) await root.getByRole("button", { name: day, exact: true }).click()
  await pick(page, root, "On a public holiday", "Shift to the next working day")
  const rows = root.getByRole("row").filter({ has: page.locator("td") })
  // Fri 25 Dec, the seeded calendar's Christmas Day: Sat 26 is a holiday and a weekend, Sun 27 a weekend — Mon 28 Dec.
  const shifted = rows.filter({ hasText: "Shifted from Fri 25 Dec · Christmas Day" })
  await expect(shifted).toHaveCount(1)
  await expect(shifted).toContainText("28 Dec 2026")
  await pick(page, root, "On a public holiday", "Skip the collection")
  await expect(rows.filter({ hasText: "Skipped · Christmas Day" })).toContainText("25 Dec 2026")
})

test("step 3's group names the API's fleet, and a driver whose licence ran out before the scheme starts is listed but cannot be picked", async ({ api, page }) => {
  const fleet = await fleetOfItsOwn(api)
  await openSchemes(page)
  await toGroups(page, uniqueName("E2E Licence"))
  const editor = await openGroupEditor(page)
  await expect(editor.getByLabel("Default driver", { exact: true })).toBeDisabled()
  await pick(page, editor, "Vehicle", new RegExp(`^${fleet.vehicle.callsign}`))
  await editor.getByLabel("Default driver", { exact: true }).click()
  // The seeded Lars Møller, in the API's own sentence (the rule it refuses a group's driver by), judged on the scheme's first day.
  const lars = page.getByRole("option", { name: /^Lars Møller/ })
  await expect(lars).toContainText("Lars Møller's licence expires on 2026-09-05, before the scheme starts")
  await expect(lars).toHaveAttribute("aria-disabled", "true")
  await expect(page.getByRole("option", { name: /^Jonas Lind/ })).toContainText("No licence on record")
  await expect(page.getByRole("option", { name: /^Jonas Lind/ })).toHaveAttribute("aria-disabled", "true")
  const own = page.getByRole("option", { name: new RegExp(`^${fleet.driver.name}`) })
  await expect(own).not.toHaveAttribute("aria-disabled", "true")
  await own.click()
  await expect(editor.getByLabel("Default driver", { exact: true })).toContainText(fleet.driver.name)
})

test("the scheme is created at step 5 in one POST the API takes, a validated scheme of the API's rows", async ({ api, page }) => {
  const name = uniqueName("E2E Guided")
  const fleet = await fleetOfItsOwn(api)
  await openSchemes(page)
  await toGroups(page, name)
  await addGroup(page, fleet)
  // The preview's matcher cannot place the API's containers yet: said, and not an issue that blocks.
  await expect(wizard(page).getByText("The API matches containers when it generates routes; this preview cannot place them yet.")).toBeVisible()
  await nextButton(page).click()
  await expect(stepHeading(page)).toHaveText("How do the generated routes look?")
  await nextButton(page).click()
  await expect(stepHeading(page)).toHaveText("Ready to create this scheme?")

  const [created] = await Promise.all([answerOf(page, "POST", "/route-schemes"), wizard(page).getByRole("button", { name: "Create route scheme" }).click()])
  expect(created.status(), await created.text()).toBe(201)
  await expect(wizard(page)).toBeHidden()
  await expect(toasts(page)).toContainText(`Route scheme created — ${name}`)

  const body = (await created.json()) as Scheme
  const stored = (await (await api.get(`/route-schemes/${body.id}`)).json()) as Scheme
  const [residual, bin240] = await Promise.all([
    listAll<Named>(api, "/waste-fractions").then((rows) => rows.find((row) => row.name === "Residual")),
    listAll<Named>(api, "/container-types").then((rows) => rows.find((row) => row.name === "Two-wheel bin · 240 L")),
  ])
  expect(stored.status).toBe("validated")
  expect(stored.collectionGroups.map((group) => ({ name: group.name, rule: group.rule, vehicleId: group.vehicleId, driverId: group.driverId }))).toEqual([
    { name, rule: { wasteFractionIds: [residual?.id], containerTypeIds: [bin240?.id], vehicleTypeId: null }, vehicleId: fleet.vehicle.id, driverId: fleet.driver.id },
  ])
})

test("Generate on the scheme's page asks the API for a run, and the page watches it until the worker has finished it", async ({ api, page }) => {
  const name = uniqueName("E2E Generate")
  const scheme = await schemeThroughApi(api, name)
  await openSchemes(page)
  await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill(name)
  await page.getByRole("button", { name: `Open ${name}` }).click()
  await page.getByRole("tab", { name: "Routes" }).click()
  const runs = page.getByRole("region", { name: "Generation runs" })
  await expect(runs).toContainText("No generation run yet")

  await page.getByRole("button", { name: "Generate routes" }).click()
  const dialog = page.getByRole("dialog", { name: "Generate routes" })
  await expect(dialog.getByLabel("From")).toHaveValue(dayFromToday(1))
  await expect(dialog.getByLabel("To")).toHaveValue(dayFromToday(7))
  const [started] = await Promise.all([answerOf(page, "POST", `/route-schemes/${scheme.id}/generate`), dialog.getByRole("button", { name: "Generate", exact: true }).click()])
  expect(started.status()).toBe(202)
  expect(started.request().postDataJSON()).toEqual({ from: dayFromToday(1), to: dayFromToday(7) })
  const run = (await started.json()) as GenerationRun
  await expect(dialog).toBeHidden()

  // The page reads the run again while it is open, and the scheme once it has finished.
  const reread = page.waitForResponse((response) => new URL(response.url()).pathname === `/waste-api/route-schemes/${scheme.id}` && response.request().method() === "GET", { timeout: 90_000 })
  const row = runs.locator(`tr[data-run-status]`).first()
  await expect(row).toContainText("Generate routes")
  await expect(row).toHaveAttribute("data-run-status", "succeeded", { timeout: 90_000 })
  await expect(row).toContainText("Succeeded")
  expect((await reread).status()).toBe(200)
  await expect(toasts(page)).toContainText(`Routes generated — ${name}`)

  const finished = (await (await api.get(`/generation-runs/${run.id}`)).json()) as GenerationRun
  expect({ status: finished.status, trigger: finished.trigger, routeSchemeId: finished.routeSchemeId }).toEqual({ status: "succeeded", trigger: "on-demand", routeSchemeId: scheme.id })
})

// Step 4's browser pair (#173, from its pull request, for whichever of #173 and #178 merged second): the preview's road
// through the API over the fake provider, and the estimate the spent quota leaves with the routing banner.

/** Steps 1–3 with the seeded depot and station, a group of the run's own; resolves on step 4. The crew is made before the page loads, which reads the fleet once. */
async function toRouteMap(page: Page, api: APIRequestContext, name: string) {
  const fleet = await fleetOfItsOwn(api)
  await openSchemes(page)
  await startGuided(page)
  await fillScope(page, name)
  await pick(page, wizard(page), "Departure depot", "Nordhavn Depot")
  await pick(page, wizard(page), "Unloading station", "ARC Amager")
  await nextButton(page).click()
  await expect(stepHeading(page)).toHaveText("When does this scheme collect?")
  await wizard(page).getByLabel("Effective from").fill(dayFromToday(7))
  await wizard(page).getByRole("button", { name: "Monday", exact: true }).click()
  await nextButton(page).click()
  await addGroup(page, fleet)
  await nextButton(page).click()
  await expect(stepHeading(page)).toHaveText("How do the generated routes look?")
}

test("step 4 draws the drafted route along the preview's road over the fake and labels the numbers as the road's (#173)", async ({ api, page }) => {
  const preview = page.waitForResponse((response) => response.url().endsWith("/waste-api/routing/preview") && response.request().method() === "POST")
  await toRouteMap(page, api, uniqueName("Preview road"))
  expect((await preview).status()).toBe(200)
  const root = wizard(page)
  const line = root.locator("[data-wizard-route]").first()
  await expect(line).toHaveAttribute("data-route-geometry", "road")
  await expect(line.locator("[data-wizard-road]")).toHaveCount(1)
  const card = root.locator("[data-route-basis]").first()
  await expect(card).toHaveAttribute("data-route-basis", "road")
  await expect(card.getByTestId("route-basis")).toHaveText("Road")
  await expect(root.getByTestId("route-map-basis")).toContainText("Road · Stops in generation order, not optimised")
  // The fake's straight legs are nobody's data: no attribution is owed.
  await expect(root.getByTestId("routing-attribution")).toHaveCount(0)
})

test("step 4 with the directions quota spent draws the stops straight and dashed, says when the road resumes and shows the routing banner (#173)", async ({ api, page }) => {
  const resumesAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  await page.route("**/waste-api/routing/preview", (route) => route.fulfill({ json: { basis: "estimate", provider: "openrouteservice", resumesAt, reason: "the routing provider's directions quota is spent" } }))
  await page.route("**/waste-api/routing/quota", (route) =>
    route.fulfill({ json: { provider: "openrouteservice", families: [{ family: "directions", remaining: 0, limit: 2000, resetAt: resumesAt, exhaustedAt: new Date().toISOString(), keyRefusedAt: null, updatedAt: new Date().toISOString() }] } }),
  )
  await toRouteMap(page, api, uniqueName("Preview estimate"))
  const root = wizard(page)
  const line = root.locator("[data-wizard-route]").first()
  await expect(line).toHaveAttribute("data-route-geometry", "straight")
  await expect(line.locator("polyline").first()).toHaveAttribute("stroke-dasharray", "6 6")
  await expect(line.locator("[data-wizard-road]")).toHaveCount(0)
  const card = root.locator("[data-route-basis]").first()
  await expect(card).toHaveAttribute("data-route-basis", "estimate")
  await expect(card.getByTestId("route-basis")).toHaveText(/^Estimate · resumes (at|tomorrow at) \d{2}:\d{2}$/)
  await expect(root.getByTestId("routing-quota-banner")).toHaveText(/^Waiting for routing quota: road measurements resume (at|tomorrow at) \d{2}:\d{2}$/)
})
