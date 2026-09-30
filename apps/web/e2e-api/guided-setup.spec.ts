import type { APIRequestContext, Locator, Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { uniqueName } from "./env"
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
// it — the routes it wrote are read with slice 6 (#179). Step 4's road
// geometry stays in the fixture suite (e2e/wizard-preview-geometry.spec.ts,
// #173's). Schemes the tests make are uniquely named and never cleaned up.
type Named = { id: string; name: string }
type Scheme = { id: string; name: string; status: string; collectionGroups: { name: string; rule: { wasteFractionIds: string[]; containerTypeIds: string[] } | null; vehicleId: string | null; driverId: string | null }[] }
type GenerationRun = { id: string; status: string; routeSchemeId: string; trigger: string; windowFrom: string; windowTo: string; routesCreated: number }

/** The browser's API call a click makes: the answer of `method` on the path `path`. */
const answerOf = (page: Page, method: string, path: string) =>
  page.waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname === `/waste-api${path}`)

const toasts = (page: Page) => page.getByRole("region", { name: "Notifications alt+T" })

/** A day `days` from today, as the date inputs take it. */
const dayFromToday = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

/** Opens Route Studio's schemes once every switched module the wizard reads has landed: its pickers offer nothing before. */
async function openSchemes(page: Page) {
  const loaded = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/waste-api/route-schemes")
  await page.goto("/route-studio?module=schemes")
  expect((await loaded).status()).toBe(200)
}

const wizard = (page: Page) => page.getByRole("dialog", { name: "New route scheme" })
const stepHeading = (page: Page) => wizard(page).locator("section h2")
const nextButton = (page: Page) => wizard(page).getByRole("button", { name: "Next", exact: true })

/** Create route scheme → Guided Setup → Continue; resolves on step 1. */
async function startGuided(page: Page) {
  await page.getByRole("button", { name: "Create route scheme" }).click()
  await page.getByText("Guided Setup", { exact: true }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(stepHeading(page)).toHaveText("Which scope does this scheme plan for?")
}

/** Picks `option` (a name or a pattern) in the select labelled `label` inside `within`. */
async function pick(page: Page, within: Locator, label: string, option: string | RegExp) {
  const trigger = within.getByLabel(label, { exact: true })
  await trigger.click()
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click()
}

/** The option texts of the select labelled `label`, closed again after. */
async function optionTexts(page: Page, within: Locator, label: string): Promise<string[]> {
  await within.getByLabel(label, { exact: true }).click()
  await expect(page.getByRole("listbox")).toBeVisible()
  const texts = (await page.getByRole("option").allInnerTexts()).map((text) => text.trim())
  await page.keyboard.press("Escape")
  return texts
}

/** Step 1 on the seeded project and area, Residual, kerbside collection. */
async function fillScope(page: Page, name: string) {
  const root = wizard(page)
  await root.getByLabel("Route scheme name").fill(name)
  await pick(page, root, "Project", "Copenhagen Central")
  await pick(page, root, "Operational planning area", "Indre By Operations")
  await pick(page, root, "Waste fraction", "Residual")
  await pick(page, root, "Service type", "Kerbside collection")
}

/** Steps 1 and 2: the scope, then Mondays from the day given. */
async function toGroups(page: Page, name: string, effectiveFrom = dayFromToday(7)) {
  await startGuided(page)
  await fillScope(page, name)
  await nextButton(page).click()
  await expect(stepHeading(page)).toHaveText("When does this scheme collect?")
  await wizard(page).getByLabel("Effective from").fill(effectiveFrom)
  await wizard(page).getByRole("button", { name: "Monday", exact: true }).click()
  await nextButton(page).click()
  await expect(stepHeading(page)).toHaveText("Who collects what on which service days?")
}

/** Opens step 3's group editor. */
async function openGroupEditor(page: Page): Promise<Locator> {
  await wizard(page).getByRole("button", { name: "Add collection group" }).first().click()
  const editor = page.getByRole("dialog", { name: "Add collection group" })
  await expect(editor).toBeVisible()
  return editor
}

/** A group on Mondays with WH-31 and Freja Nielsen, who hold what the other schemes do not, emptying 240 L bins. */
async function addGroup(page: Page) {
  const editor = await openGroupEditor(page)
  await editor.getByLabel("Group name").fill("Residual · bins")
  await editor.getByRole("button", { name: "Monday", exact: true }).click()
  await pick(page, editor, "Vehicle", /^WH-31/)
  await pick(page, editor, "Default driver", /^Freja Nielsen/)
  await editor.getByRole("button", { name: "Two-wheel bin · 240 L", exact: true }).click()
  await editor.getByRole("button", { name: /^(Add|Save) group$/ }).click()
  await expect(editor).toBeHidden()
}

/** A validated scheme with one rule group, made through the API: Residual inside Indre By Operations on Mondays, from tomorrow. */
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

test("step 3's group names the API's fleet, and a driver whose licence ran out before the scheme starts is listed but cannot be picked", async ({ page }) => {
  await openSchemes(page)
  await toGroups(page, uniqueName("E2E Licence"))
  const editor = await openGroupEditor(page)
  await expect(editor.getByLabel("Default driver", { exact: true })).toBeDisabled()
  await pick(page, editor, "Vehicle", /^WH-31/)
  await editor.getByLabel("Default driver", { exact: true }).click()
  // The API's own sentence (the rule it refuses a group's driver by), judged on the scheme's first day.
  const lars = page.getByRole("option", { name: /^Lars Møller/ })
  await expect(lars).toContainText("Lars Møller's licence expires on 2026-09-05, before the scheme starts")
  await expect(lars).toHaveAttribute("aria-disabled", "true")
  await expect(page.getByRole("option", { name: /^Jonas Lind/ })).toHaveAttribute("aria-disabled", "true")
  const freja = page.getByRole("option", { name: /^Freja Nielsen/ })
  await expect(freja).not.toHaveAttribute("aria-disabled", "true")
  await freja.click()
  await expect(editor.getByLabel("Default driver", { exact: true })).toContainText("Freja Nielsen")
})

test("the scheme is created at step 5 in one POST the API takes, a validated scheme of the API's rows", async ({ api, page }) => {
  const name = uniqueName("E2E Guided")
  await openSchemes(page)
  await toGroups(page, name)
  await addGroup(page)
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
  const [residual, bin240, vehicle, driver] = await Promise.all([
    listAll<Named>(api, "/waste-fractions").then((rows) => rows.find((row) => row.name === "Residual")),
    listAll<Named>(api, "/container-types").then((rows) => rows.find((row) => row.name === "Two-wheel bin · 240 L")),
    listAll<{ id: string; callsign: string }>(api, "/vehicles").then((rows) => rows.find((row) => row.callsign === "WH-31")),
    listAll<{ id: string; name: string }>(api, "/drivers").then((rows) => rows.find((row) => row.name === "Freja Nielsen")),
  ])
  expect(stored.status).toBe("validated")
  expect(stored.collectionGroups.map((group) => ({ name: group.name, rule: group.rule, vehicleId: group.vehicleId, driverId: group.driverId }))).toEqual([
    { name, rule: { wasteFractionIds: [residual?.id], containerTypeIds: [bin240?.id], vehicleTypeId: null }, vehicleId: vehicle?.id, driverId: driver?.id },
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
