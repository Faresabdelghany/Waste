import type { APIRequestContext, Page } from "@playwright/test"

import { chainLanded, expect, test } from "./fixtures"
import { uniqueName } from "./env"
import { createScheme, openEdit, pick, toasts } from "./routes-support"
import { listAll } from "./tester"

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
  serviceDays: string[]
  collectionGroups: { id: string; name: string; days: string[]; rule: { wasteFractionIds: string[] } | null }[]
}
type Named = { id: string; name: string }

/** The browser's API call a click makes: the answer of `method` on the path `path`. */
const answerOf = (page: Page, method: string, path: string) =>
  page.waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname === `/waste-api${path}`)

/**
 * Opens Route Studio's schemes and waits for the API's rows — the list shows its fixtures until they land — and for the
 * page's whole chain: a scheme's form names its fraction and container types through the master data, read in the same
 * burst, and a master-data read asked again after a failure on the way lands after the schemes'.
 */
async function openSchemes(page: Page) {
  const loaded = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/waste-api/route-schemes")
  await page.goto("/route-studio?module=schemes")
  expect((await loaded).status()).toBe(200)
  await chainLanded(page)
}

/** Opens a scheme's page from the list, narrowed to its name first: a developer's stack accumulates schemes across runs. */
async function openScheme(page: Page, name: string) {
  await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill(name)
  await page.getByRole("button", { name: `Open ${name}` }).click()
  await expect(page.getByRole("tab", { name: "Details" })).toBeVisible()
}

/** A day a week ahead, which the forms accept as a first day in force. */
const nextWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)

/** A validated scheme with one rule group, made through the API (routes-support.ts): Residual inside Indre By Operations, Mondays and Thursdays from next week. */
function schemeThroughApi(api: APIRequestContext, name: string) {
  return createScheme(api, name, { serviceDays: ["monday", "thursday"], validFrom: nextWeek() })
}

test("the seeded schemes are the API's: listed under their derived status, opened under the server's id, their next collections read from the API", async ({ api, page }) => {
  const seeded = await listAll<Scheme>(api, "/route-schemes")
  const osterbro = seeded.find((scheme) => scheme.name === "RS-Østerbro · Organic B")
  expect(osterbro, "the seed holds RS-Østerbro").toBeDefined()

  await openSchemes(page)
  await expect(page.getByRole("button", { name: "Open RS-Central · Week A" })).toBeVisible()
  // The scope column starts every row with its project, then the area where the scheme has one (#254).
  await expect(page.getByRole("columnheader", { name: "Project · area · service days" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Open RS-Central · Week A" })).toContainText("Copenhagen Central · Indre By Operations · Mon–Fri")
  await expect(page.getByRole("button", { name: "Open RS-Østerbro · Organic B" })).toContainText("Copenhagen Central · Tue/Thu")
  const occurrences = page.waitForResponse((response) => new URL(response.url()).pathname === `/waste-api/route-schemes/${osterbro?.id}/occurrences`)
  await openScheme(page, "RS-Østerbro · Organic B")
  // No fixture lends a scheme its id: the page is the server's row.
  await expect(page).toHaveURL(new RegExp(`record=scheme-${osterbro?.id}`))
  // Seeded without a driver (Lars Møller's licence ran out); its vehicle is named as the fleet module has it (slice 5a), not an id chip.
  await expect(page.getByText("Not assigned", { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/^NR-08/).first()).toBeVisible()
  await expect(page.getByText(/^vehicle-[0-9a-f]{8}-/)).toHaveCount(0)

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
  // The fleet is read from the API (slice 5a): the driver picker offers the API's drivers, and none is picked here.
  await dialog.getByRole("combobox", { name: /^Planned driver/ }).click()
  await expect(page.getByRole("option", { name: /Mads Jensen/ })).toBeVisible()
  await page.keyboard.press("Escape")

  const [created] = await Promise.all([answerOf(page, "POST", "/route-schemes"), dialog.getByRole("button", { name: "Create route scheme" }).click()])
  expect(created.status()).toBe(201)
  const body = (await created.json()) as Scheme
  expect(created.headers()["location"]).toBe(`/route-schemes/${body.id}`)
  await expect(dialog).toBeHidden()
  // No vehicle or driver was picked, so the web's validation asks for a draft.
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
  await quickCreateTaken(page, api)
})

test("a master-data read lost on the way is asked again, so the scheme form still names its fraction and the create reaches the API", async ({ api, page }) => {
  // CI's flake of the test above (run 40042976572): the proxy answered one of the page's forty reads 500 (ECONNRESET), the
  // master data stayed failed for the session, and the form refused locally — no fraction named "Residual" — before any POST.
  let lost = 0
  await page.route("**/waste-api/vehicle-types**", async (route) => {
    if (lost === 0) {
      lost += 1
      await route.fulfill({ status: 500, contentType: "text/plain", body: "Internal Server Error" })
      return
    }
    await route.continue()
  })
  await quickCreateTaken(page, api)
  expect(lost, "the first read was lost").toBe(1)
})

/** Quick create of a name taken after the page loaded: the POST the API refuses, its sentence over the dialog, which stays open on what was typed. */
async function quickCreateTaken(page: Page, api: APIRequestContext) {
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
}

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

test("a service day added to a validated scheme is one PATCH of the days and the group that serves them, and the scheme stays validated (#205)", async ({ api, page }) => {
  const name = uniqueName("E2E Saturday")
  const scheme = await schemeThroughApi(api, name)
  const [group] = ((await (await api.get(`/route-schemes/${scheme.id}`)).json()) as Scheme).collectionGroups
  await openSchemes(page)
  await openScheme(page, name)

  const dialog = await openEdit(page)
  await dialog.getByRole("combobox", { name: /^Service days/ }).click()
  await page.getByRole("option", { name: "Saturday", exact: true }).click()
  await page.keyboard.press("Escape")
  // The writes a scheme edit could be made of: the scheme's and its groups' own routes.
  const patches: string[] = []
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() !== "GET" && /^\/waste-api\/(route-schemes|collection-groups)\//.test(path)) patches.push(`${request.method()} ${path}`)
  })
  const [patched] = await Promise.all([answerOf(page, "PATCH", `/route-schemes/${scheme.id}`), dialog.getByRole("button", { name: "Save changes" }).click()])
  expect(patched.status(), await patched.text()).toBe(200)
  expect(patched.request().postDataJSON()).toEqual({
    serviceDays: ["monday", "thursday", "saturday"],
    collectionGroups: [{ id: group.id, name: group.name, days: ["monday", "thursday", "saturday"], stopSource: "rule", rule: group.rule, containerIds: null, serviceProviderId: null, vehicleId: null, driverId: null }],
  })
  await expect(dialog).toBeHidden()
  // One request for the whole edit: no draft first, no group of its own, no second patch.
  expect(patches).toEqual([`PATCH /waste-api/route-schemes/${scheme.id}`])
  const read = (await (await api.get(`/route-schemes/${scheme.id}`)).json()) as Scheme
  expect({ status: read.status, serviceDays: read.serviceDays, groupDays: read.collectionGroups.map((row) => row.days) }).toEqual({ status: "validated", serviceDays: ["monday", "thursday", "saturday"], groupDays: [["monday", "thursday", "saturday"]] })
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
