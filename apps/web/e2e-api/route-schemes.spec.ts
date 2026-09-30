import type { APIRequestContext, Locator, Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { uniqueName } from "./env"
import { listAll, projectNamed } from "./tester"

// Slice 3 of #81 (Issue #177): Route Studio's schemes read and written
// through the API. The fixture suite's quick create and running-scheme edit
// policy (dialog-and-quick.spec.ts, edit-policy.spec.ts, retired with this
// slice) port by behaviour: the seeded schemes are the API's rows under the
// server's ids, a quick create is a POST the API answers with its Location,
// and an edit is the scheme's PATCH — the stored policy lands and is read
// back, a shaping edit and a rename save without a question (on the Pilot
// the question over future routes waits for the routes on the API, slice 6),
// and a refusal is the API's sentence over the dialog, still holding what
// was typed. Schemes the tests make are uniquely named and never cleaned up.
type Scheme = {
  id: string
  name: string
  status: string
  editPolicy: string
  plannedStartTime: string | null
  collectionGroups: { rule: { wasteFractionIds: string[] } | null }[]
}
type Named = { id: string; name: string }

/** The browser's API call a click makes: the answer of `method` on the path `path`. */
const answerOf = (page: Page, method: string, path: string) =>
  page.waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname === `/waste-api${path}`)

/** Opens Route Studio's schemes and waits for the API's rows: the list shows its fixtures until they land. */
async function openSchemes(page: Page) {
  const loaded = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/waste-api/route-schemes")
  await page.goto("/route-studio?module=schemes")
  expect((await loaded).status()).toBe(200)
}

/** Opens a scheme's page from the list, narrowed to its name first: a developer's stack accumulates schemes across runs. */
async function openScheme(page: Page, name: string) {
  await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill(name)
  await page.getByRole("button", { name: `Open ${name}` }).click()
  await expect(page.getByRole("tab", { name: "Details" })).toBeVisible()
}

/** Picks `option` in the select whose label starts with `label`. */
async function pick(within: Locator, page: Page, label: string, option: string) {
  await within.getByRole("combobox", { name: new RegExp(`^${label}`) }).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

async function openEdit(page: Page) {
  await page.getByRole("button", { name: "Actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Edit scheme" }).click()
  const dialog = page.getByRole("dialog", { name: "Edit route scheme" })
  await expect(dialog).toBeVisible()
  return dialog
}

const toasts = (page: Page) => page.getByRole("region", { name: "Notifications alt+T" })

/** A day a week ahead, which the forms accept as a first day in force. */
const nextWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)

/** A validated scheme with one rule group, made through the API: Residual inside Indre By Operations, Mondays and Thursdays. */
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
      validFrom: nextWeek(),
      collectionGroups: [{ name, days: ["monday", "thursday"], stopSource: "rule", rule: { wasteFractionIds: [residual?.id], containerTypeIds: [], vehicleTypeId: null } }],
    },
  })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()) as Scheme
}

test("the seeded schemes are the API's: listed under their derived status, opened under the server's id, their next collections read from the API", async ({ api, page }) => {
  const seeded = await listAll<Scheme>(api, "/route-schemes")
  const osterbro = seeded.find((scheme) => scheme.name === "RS-Østerbro · Organic B")
  expect(osterbro, "the seed holds RS-Østerbro").toBeDefined()

  await openSchemes(page)
  await expect(page.getByRole("button", { name: "Open RS-Central · Week A" })).toBeVisible()
  const occurrences = page.waitForResponse((response) => new URL(response.url()).pathname === `/waste-api/route-schemes/${osterbro?.id}/occurrences`)
  await openScheme(page, "RS-Østerbro · Organic B")
  // No fixture lends a scheme its id: the page is the server's row.
  await expect(page).toHaveURL(new RegExp(`record=scheme-${osterbro?.id}`))
  // Seeded without a driver (Lars Møller's licence ran out); the fleet is named by id until it is read from the API.
  await expect(page.getByText("Not assigned", { exact: true }).first()).toBeVisible()

  await page.getByRole("tab", { name: "Routes" }).click()
  expect((await occurrences).status()).toBe(200)
  const next = page.getByRole("region", { name: "Next collections" })
  await expect(next.getByRole("row").nth(1)).toContainText(/Planned|Skipped|Shifted|On a holiday/)
})

test("quick create lands as a server row: a POST the API answers with its Location, the rule's fraction by the master data's id", async ({ api, page }) => {
  const name = uniqueName("E2E Scheme")
  await openSchemes(page)
  await page.getByRole("button", { name: "Create route scheme" }).click()
  await page.getByText("Quick create", { exact: true }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  const dialog = page.getByRole("dialog", { name: "Create route scheme" })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("textbox", { name: /^Route scheme name/ }).fill(name)
  await pick(dialog, page, "Operational planning area", "Indre By Operations")
  await pick(dialog, page, "Waste fraction", "Residual")
  await pick(dialog, page, "Service type", "Container collection")
  await dialog.getByRole("textbox", { name: /^Effective from/ }).fill(nextWeek())
  await pick(dialog, page, "Collection frequency", "Every week")
  await dialog.getByRole("combobox", { name: /^Service days/ }).click()
  await page.getByRole("option", { name: "Monday", exact: true }).click()
  await page.keyboard.press("Escape")
  await pick(dialog, page, "Vehicle type", "Rear loader")
  // The fleet is not read from the API yet (slice 5a): the pickers offer nothing rather than a fixture the API does not hold.
  await dialog.getByRole("combobox", { name: /^Planned driver/ }).click()
  await expect(page.getByRole("option")).toHaveCount(0)
  await page.keyboard.press("Escape")

  const [created] = await Promise.all([answerOf(page, "POST", "/route-schemes"), dialog.getByRole("button", { name: "Create route scheme" }).click()])
  expect(created.status()).toBe(201)
  const body = (await created.json()) as Scheme
  expect(created.headers()["location"]).toBe(`/route-schemes/${body.id}`)
  await expect(dialog).toBeHidden()
  // No vehicle or driver can be named yet, so the web's validation asks for a draft.
  await expect(toasts(page)).toContainText(`Route scheme created as Draft — ${name}`)

  const read = await api.get(`/route-schemes/${body.id}`)
  expect(read.status()).toBe(200)
  const stored = (await read.json()) as Scheme
  const residual = (await listAll<Named>(api, "/waste-fractions")).find((row) => row.name === "Residual")
  expect(stored.name).toBe(name)
  expect(stored.status).toBe("draft")
  expect(stored.collectionGroups.map((group) => group.rule?.wasteFractionIds)).toEqual([[residual?.id]])
})

test("a quick create the API refuses is its sentence over the dialog, which stays open on what was typed", async ({ api, page }) => {
  await openSchemes(page)
  await page.getByRole("button", { name: "Create route scheme" }).click()
  await page.getByText("Quick create", { exact: true }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  const dialog = page.getByRole("dialog", { name: "Create route scheme" })
  await expect(dialog).toBeVisible()
  // Taken after the page loaded, so the form's own check cannot see it.
  const taken = uniqueName("E2E Taken")
  await schemeThroughApi(api, taken)
  await dialog.getByRole("textbox", { name: /^Route scheme name/ }).fill(taken)
  await pick(dialog, page, "Operational planning area", "Indre By Operations")
  await pick(dialog, page, "Waste fraction", "Residual")
  await pick(dialog, page, "Service type", "Container collection")
  await dialog.getByRole("textbox", { name: /^Effective from/ }).fill(nextWeek())
  await pick(dialog, page, "Collection frequency", "Every week")
  await dialog.getByRole("combobox", { name: /^Service days/ }).click()
  await page.getByRole("option", { name: "Monday", exact: true }).click()
  await page.keyboard.press("Escape")
  const [refused] = await Promise.all([answerOf(page, "POST", "/route-schemes"), dialog.getByRole("button", { name: "Create route scheme" }).click()])
  expect(refused.status()).toBe(409)
  await expect(toasts(page)).toContainText(`${taken} was not saved`)
  await expect(toasts(page)).toContainText("A route scheme of this name is already in force over that period")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("textbox", { name: /^Route scheme name/ })).toHaveValue(taken)
})

test("an edit is the scheme's PATCH: the stored policy and a shaping change land without a question, a rename too, and read back from the API", async ({ api, page }) => {
  const name = uniqueName("E2E Policy")
  const scheme = await schemeThroughApi(api, name)
  await openSchemes(page)
  await openScheme(page, name)

  let dialog = await openEdit(page)
  await expect(dialog.getByRole("combobox", { name: /^Changes to a running scheme/ })).toContainText("Ask each time")
  await pick(dialog, page, "Changes to a running scheme", "Apply to future collections")
  await dialog.getByRole("textbox", { name: "Planned start time" }).fill("08:15")
  const [patched] = await Promise.all([answerOf(page, "PATCH", `/route-schemes/${scheme.id}`), dialog.getByRole("button", { name: "Save changes" }).click()])
  expect(patched.status()).toBe(200)
  expect(patched.request().postDataJSON()).toEqual({ editPolicy: "future", plannedStartTime: "08:15" })
  await expect(page.getByRole("dialog", { name: "How should this change apply?" })).toHaveCount(0)
  await expect(dialog).toBeHidden()
  await expect(toasts(page)).toContainText(`${name} updated`)
  const read = (await (await api.get(`/route-schemes/${scheme.id}`)).json()) as Scheme
  expect({ editPolicy: read.editPolicy, plannedStartTime: read.plannedStartTime, status: read.status }).toEqual({ editPolicy: "future", plannedStartTime: "08:15", status: "validated" })

  // Read back after a reload: the policy is the API's, not the browser's.
  await openSchemes(page)
  await openScheme(page, name)
  await expect(page.getByText("Apply to future collections", { exact: true })).toBeVisible()
  await expect(page.getByText("08:15", { exact: true }).first()).toBeVisible()

  dialog = await openEdit(page)
  await dialog.getByRole("textbox", { name: /^Route scheme name/ }).fill(`${name} renamed`)
  const [renamed] = await Promise.all([answerOf(page, "PATCH", `/route-schemes/${scheme.id}`), dialog.getByRole("button", { name: "Save changes" }).click()])
  expect(renamed.status()).toBe(200)
  expect(renamed.request().postDataJSON()).toEqual({ name: `${name} renamed` })
  await expect(toasts(page)).toContainText(`${name} renamed updated`)
})

test("a rename the API refuses is its sentence over the dialog, which keeps what was typed", async ({ api, page }) => {
  const name = uniqueName("E2E Rename")
  const scheme = await schemeThroughApi(api, name)
  await openSchemes(page)
  await openScheme(page, name)
  const dialog = await openEdit(page)
  // Made after the page loaded, so the form's own check cannot see it: the API is the one that knows.
  const taken = uniqueName("E2E Taken")
  await schemeThroughApi(api, taken)
  await dialog.getByRole("textbox", { name: /^Route scheme name/ }).fill(taken)
  const [refused] = await Promise.all([answerOf(page, "PATCH", `/route-schemes/${scheme.id}`), dialog.getByRole("button", { name: "Save changes" }).click()])
  expect(refused.status()).toBe(409)
  await expect(toasts(page)).toContainText(`${taken} was not saved`)
  await expect(toasts(page)).toContainText("A route scheme of this name is already in force over that period")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("textbox", { name: /^Route scheme name/ })).toHaveValue(taken)
})
