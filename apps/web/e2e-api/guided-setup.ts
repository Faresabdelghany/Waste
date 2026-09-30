// The guided setup driven on the Pilot (Issue #178): Route Studio's schemes
// opened once the API's rows have landed, the wizard's steps filled the way a
// person fills them, and a crew of the run's own made through the API.
// guided-setup.spec.ts drives the wizard with them, and a spec that needs the
// wizard at a later step — step 4's preview (#173) — reaches it the same way.
import type { APIRequestContext, Locator, Page } from "@playwright/test"

import { expect } from "./fixtures"
import { listAll, projectNamed } from "./tester"

type Named = { id: string; name: string }

/** The browser's API call a click makes: the answer of `method` on the path `path`. */
export const answerOf = (page: Page, method: string, path: string) =>
  page.waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname === `/waste-api${path}`)

export const toasts = (page: Page) => page.getByRole("region", { name: "Notifications alt+T" })

/** A day `days` from today, as the date inputs take it. */
export const dayFromToday = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

/** Opens Route Studio's schemes once every switched module the wizard reads has landed: its pickers offer nothing before. */
export async function openSchemes(page: Page) {
  const loaded = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/waste-api/route-schemes")
  await page.goto("/route-studio?module=schemes")
  expect((await loaded).status()).toBe(200)
}

export const wizard = (page: Page) => page.getByRole("dialog", { name: "New route scheme" })
export const stepHeading = (page: Page) => wizard(page).locator("section h2")
export const nextButton = (page: Page) => wizard(page).getByRole("button", { name: "Next", exact: true })

/** Create route scheme → Guided Setup → Continue; resolves on step 1. */
export async function startGuided(page: Page) {
  await page.getByRole("button", { name: "Create route scheme" }).click()
  await page.getByText("Guided Setup", { exact: true }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(stepHeading(page)).toHaveText("Which scope does this scheme plan for?")
}

/** Picks `option` (a name or a pattern) in the select labelled `label` inside `within`. */
export async function pick(page: Page, within: Locator, label: string, option: string | RegExp) {
  const trigger = within.getByLabel(label, { exact: true })
  await trigger.click()
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click()
}

/** The option texts of the select labelled `label`, closed again after. */
export async function optionTexts(page: Page, within: Locator, label: string): Promise<string[]> {
  await within.getByLabel(label, { exact: true }).click()
  await expect(page.getByRole("listbox")).toBeVisible()
  const texts = (await page.getByRole("option").allInnerTexts()).map((text) => text.trim())
  await page.keyboard.press("Escape")
  return texts
}

/** Step 1 on the seeded project and area, Residual, kerbside collection. */
export async function fillScope(page: Page, name: string) {
  const root = wizard(page)
  await root.getByLabel("Route scheme name").fill(name)
  await pick(page, root, "Project", "Copenhagen Central")
  await pick(page, root, "Operational planning area", "Indre By Operations")
  await pick(page, root, "Waste fraction", "Residual")
  await pick(page, root, "Service type", "Kerbside collection")
}

/** Steps 1 and 2: the scope, then Mondays from a week today; resolves on step 3. */
export async function toGroups(page: Page, name: string) {
  await startGuided(page)
  await fillScope(page, name)
  await nextButton(page).click()
  await expect(stepHeading(page)).toHaveText("When does this scheme collect?")
  await wizard(page).getByLabel("Effective from").fill(dayFromToday(7))
  await wizard(page).getByRole("button", { name: "Monday", exact: true }).click()
  await nextButton(page).click()
  await expect(stepHeading(page)).toHaveText("Who collects what on which service days?")
}

/** Opens step 3's group editor. */
export async function openGroupEditor(page: Page): Promise<Locator> {
  await wizard(page).getByRole("button", { name: "Add collection group" }).first().click()
  const editor = page.getByRole("dialog", { name: "Add collection group" })
  await expect(editor).toBeVisible()
  return editor
}

export type Fleet = { vehicle: { id: string; callsign: string }; driver: { id: string; name: string } }

/**
 * A rear loader and a CE driver of the run's own, made through the API: the
 * web's validation refuses a vehicle or a driver already the default on
 * another scheme a shared day, and a developer's stack keeps every earlier
 * run's schemes — the seeded crews are RS-Central's, and a licence the seed
 * dates runs out in time.
 */
export async function fleetOfItsOwn(api: APIRequestContext): Promise<Fleet> {
  const tag = Date.now().toString(36).toUpperCase()
  const project = await projectNamed(api, "Copenhagen Central")
  const [rearLoader, residual] = await Promise.all([
    listAll<{ id: string; key: string }>(api, "/vehicle-types").then((rows) => rows.find((row) => row.key === "rear-loader")),
    listAll<Named>(api, "/waste-fractions").then((rows) => rows.find((row) => row.name === "Residual")),
  ])
  expect(rearLoader && residual, "the seed holds the rear loader and Residual").toBeTruthy()
  const vehicle = await api.post("/vehicles", {
    data: { projectId: project.id, registration: `E2E ${tag}`, callsign: `E2E-${tag}`, kind: "powered-vehicle", vehicleTypeId: rearLoader?.id, capacityKg: 18_000, requiredLicenceClass: "c", compartments: [{ wasteFractionIds: [residual?.id] }] },
  })
  expect(vehicle.status(), await vehicle.text()).toBe(201)
  const driver = await api.post("/drivers", { data: { projectId: project.id, name: `E2E Driver ${tag}`, employment: "employee", licenceClass: "ce" } })
  expect(driver.status(), await driver.text()).toBe(201)
  return { vehicle: (await vehicle.json()) as Fleet["vehicle"], driver: (await driver.json()) as Fleet["driver"] }
}

/** A group on Mondays with the fleet given, emptying 240 L bins; resolves back on step 3. */
export async function addGroup(page: Page, fleet: Fleet) {
  const editor = await openGroupEditor(page)
  await editor.getByLabel("Group name").fill("Residual · bins")
  await editor.getByRole("button", { name: "Monday", exact: true }).click()
  await pick(page, editor, "Vehicle", new RegExp(`^${fleet.vehicle.callsign}`))
  await pick(page, editor, "Default driver", new RegExp(`^${fleet.driver.name}`))
  await editor.getByRole("button", { name: "Two-wheel bin · 240 L", exact: true }).click()
  await editor.getByRole("button", { name: /^(Add|Save) group$/ }).click()
  await expect(editor).toBeHidden()
}
