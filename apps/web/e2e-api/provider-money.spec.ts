import type { APIRequestContext, Locator, Page } from "@playwright/test"
import { ID_RANDOM_BYTES, mintId } from "@waste/domain/ids"

import { accessTokenOf, apiAs, expect, freshContext, signIn, test } from "./fixtures"
import { dispatchedRouteFor, SEEDED_DRIVER } from "./dispatched-route"
import { E2E, uniqueName } from "./env"
import { listAll } from "./tester"

// Slice 11 (#186, for #148): the Price Engine's provider-money chain on the
// API, against the seeded tenant — an award edited in its details and moved
// to another provider by ending its assignment and adding the next; a
// provider price added under an assignment and indexed, the chain's first
// row ended the day before; a settlement opened over an assignment's ended
// period, calculated, closed once asked (#257) and reopened with the reason
// its history keeps, and one whose period has not ended calculated but not
// closed, one not begun offered nothing (#260); an
// unload the office captured on a running route, reviewed from the weights
// desk's queue — approved, rejected with why, corrected. The map's Create
// service area is e2e-api/map-planning.spec.ts'. The seed holds no award, so
// each test makes its own through the API; records are uniquely named and
// never cleaned up.
type Project = { id: string; name: string }
type Named = { id: string; name: string }
type ServiceProvider = { id: string; legalName: string }
type PlanningArea = { id: string; name: string; projectId: string }
type ServiceAreaAssignment = { id: string; serviceAreaId: string; serviceProviderId: string; validFrom: string; validTo: string | null }
type ServiceArea = { id: string; code: string; name: string; planningAreaIds: string[]; wasteFractionIds: string[]; validFrom: string; validTo: string | null }
type ServiceAreaCreated = ServiceArea & { assignment: ServiceAreaAssignment | null }
type Product = { id: string; name: string }
type ProviderPrice = { id: string; bidMinor: number; unitPriceMinor: number; indexedFromId: string | null; validFrom: string; validTo: string | null }
type Settlement = { id: string; status: string; validFrom: string; validTo: string; lineCount: number }
type SettlementEvent = { kind: string; status: string; reason: string | null }
type Unload = { id: string; netKg: number; weightReview: { status: string; correctionUnloadId: string | null } }

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

async function copenhagen(api: APIRequestContext): Promise<Project> {
  const project = (await listAll<Project>(api, "/projects")).find((candidate) => candidate.name === "Copenhagen Central")
  if (project === undefined) throw new Error("the seed has no Copenhagen Central")
  return project
}

async function providerNamed(api: APIRequestContext, prefix: string): Promise<ServiceProvider> {
  const provider = (await listAll<ServiceProvider>(api, "/service-providers")).find((candidate) => candidate.legalName.startsWith(prefix))
  if (provider === undefined) throw new Error(`the seed has no service provider ${prefix}`)
  return provider
}

/** `day` moved by `days`. */
const plus = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

/** Eight days of this run's own, centuries ahead: a planning area is awarded once at a time, and the tenant keeps every earlier run's awards. */
function weekOfItsOwn(): string {
  return new Date(Date.UTC(2400, 0, 1) + (Math.floor(Date.now() / 1000) % 25_000) * 8 * 86_400_000).toISOString().slice(0, 10)
}

/** An award of the project made through the API with its first assignment: over planning areas only where a test edits it, since one with none never meets the one-award rule. */
async function newAward(api: APIRequestContext, project: Project, provider: ServiceProvider, period: { validFrom: string; validTo: string }, planningAreaIds: string[] = []): Promise<ServiceAreaCreated> {
  const code = `E2E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`.toUpperCase()
  const response = await api.post("/service-areas", { data: { projectId: project.id, code, name: uniqueName("E2E award"), boundaryText: "As the e2e contract draws it", planningAreaIds, wasteFractionIds: [], ...period, assignment: { serviceProviderId: provider.id } } })
  expect(response.status(), "POST /service-areas").toBe(201)
  return (await response.json()) as ServiceAreaCreated
}

/** The award's first assignment, which every test makes it with. */
function assignmentOf(award: ServiceAreaCreated): ServiceAreaAssignment {
  if (award.assignment === null) throw new Error(`${award.code} was made without its assignment`)
  return award.assignment
}

test("Service areas: an award's details edit it and move it to another provider, its assignment ended and the next added; the table lists the awards alone", async ({ page, api }) => {
  const project = await copenhagen(api)
  const [nordren, cityhaul] = await Promise.all([providerNamed(api, "NordRen"), providerNamed(api, "CityHaul")])
  const [planningArea] = await listAll<PlanningArea>(api, "/planning-areas", { projectId: project.id })
  if (planningArea === undefined) throw new Error("the seed has no planning area in Copenhagen Central")
  const start = weekOfItsOwn()
  const award = await newAward(api, project, nordren, { validFrom: start, validTo: plus(start, 2) }, [planningArea.id])
  const held = assignmentOf(award)

  const loaded = answerOf(page, "GET", /^\/service-area-assignments$/)
  await page.goto(`/service-providers?module=service-areas&record=service-area-${award.id}`)
  expect((await loaded).status()).toBe(200)
  const details = page.getByRole("dialog").filter({ has: page.getByTestId("service-area-commands") })
  const assignments = details.getByTestId("service-area-assignments")
  await expect(assignments.getByRole("listitem")).toHaveCount(1)
  await expect(assignments).toContainText("NordRen")

  // The edit holds the code and the project, and offers no provider: who holds it is its assignments'.
  await details.getByRole("button", { name: "Edit service area" }).click()
  const edit = dialogTitled(page, "Edit service area")
  await expect(edit.getByLabel("Area code")).toHaveAttribute("readonly", "")
  await expect(edit.getByRole("combobox", { name: /^Service provider/ })).toHaveCount(0)
  const renamed = uniqueName("E2E award renamed")
  await edit.getByLabel("Service area name").fill(renamed)
  const [patched] = await Promise.all([answerOf(page, "PATCH", new RegExp(`^/service-areas/${award.id}$`)), edit.getByRole("button", { name: "Save changes" }).click()])
  expect(patched.status(), await patched.text()).toBe(200)
  expect(patched.request().postDataJSON()).toEqual({ name: renamed })
  await expect(edit).toBeHidden()

  // A transfer: the current assignment ended on its first day, the next provider from the day after.
  await assignments.getByRole("button", { name: "End or note" }).click()
  const end = dialogTitled(page, "End or note the assignment")
  await expect(end.getByRole("combobox", { name: /^Service provider/ })).toBeDisabled()
  await end.getByLabel(/^Holds until/).fill(start)
  const [ended] = await Promise.all([answerOf(page, "PATCH", new RegExp(`^/service-area-assignments/${held.id}$`)), end.getByRole("button", { name: "Save" }).click()])
  expect(ended.status(), await ended.text()).toBe(200)
  expect(ended.request().postDataJSON()).toEqual({ validTo: plus(start, 1) })
  await expect(end).toBeHidden()

  await details.getByRole("button", { name: "Add assignment" }).click()
  const add = dialogTitled(page, "Assign the service area")
  await pick(add, page, /^Service provider/, /^CityHaul/)
  await add.getByLabel(/^Holds from/).fill(plus(start, 1))
  const [added] = await Promise.all([answerOf(page, "POST", new RegExp(`^/service-areas/${award.id}/assignments$`)), add.getByRole("button", { name: "Add assignment" }).click()])
  expect(added.status(), await added.text()).toBe(201)
  // Left open, it ends with the award, as the field's hint says.
  expect(added.request().postDataJSON()).toEqual({ serviceProviderId: cityhaul.id, validFrom: plus(start, 1), validTo: plus(start, 2) })
  await expect(add).toBeHidden()
  await expect(assignments.getByRole("listitem")).toHaveCount(2)
  await expect(assignments.getByRole("listitem").nth(1)).toContainText("CityHaul")

  const read = await listAll<ServiceAreaAssignment>(api, "/service-area-assignments", { serviceAreaId: award.id })
  expect(read.map(({ serviceProviderId, validFrom, validTo }) => ({ serviceProviderId, validFrom, validTo })).sort((a, b) => a.validFrom.localeCompare(b.validFrom))).toEqual([
    { serviceProviderId: nordren.id, validFrom: start, validTo: plus(start, 1) },
    { serviceProviderId: cityhaul.id, validFrom: plus(start, 1), validTo: plus(start, 2) },
  ])

  // The table lists the awards, never their assignments, which are the same module's second kind.
  await page.keyboard.press("Escape")
  // Searched, since the tenant keeps every run's awards and the table pages.
  await page.getByPlaceholder("Search service areas").fill(award.code)
  const table = page.getByRole("table")
  await expect(table.getByText(renamed)).toBeVisible()
  await expect(table.getByText(`${award.code} · NordRen`)).toHaveCount(0)
})

test("Create service area in the module: the new award's details list the first assignment the server made, and stay open through its end", async ({ page, api }) => {
  const project = await copenhagen(api)
  const [planningArea] = await listAll<PlanningArea>(api, "/planning-areas", { projectId: project.id })
  if (planningArea === undefined) throw new Error("the seed has no planning area in Copenhagen Central")
  // The second half of this run's own days: the first test's award holds the planning area over the first.
  const start = plus(weekOfItsOwn(), 4)
  const loaded = answerOf(page, "GET", /^\/service-area-assignments$/)
  await page.goto("/service-providers?module=service-areas")
  expect((await loaded).status()).toBe(200)

  await page.getByRole("button", { name: "Create service area" }).click()
  const dialog = dialogTitled(page, "Create service area")
  const name = uniqueName("E2E module award")
  await dialog.getByLabel("Service area name").fill(name)
  await dialog.getByLabel("Area code").fill(`E2E-${Date.now().toString(36)}`.toUpperCase())
  await pick(dialog, page, /^Project/, /^Copenhagen Central/)
  await pick(dialog, page, /^Service provider/, /^NordRen/)
  await dialog.getByLabel("Geographic boundary").fill("As the e2e contract draws it")
  await dialog.getByRole("combobox", { name: /^Planning areas/ }).click()
  await page.getByRole("option", { name: new RegExp(`^${planningArea.name}`) }).click()
  await page.keyboard.press("Escape")
  await dialog.getByLabel(/^Starts/).fill(start)
  await dialog.getByLabel(/^Ends/).fill(plus(start, 1))
  const [created] = await Promise.all([answerOf(page, "POST", /^\/service-areas$/), dialog.getByRole("button", { name: "Create service area" }).click()])
  expect(created.status(), await created.text()).toBe(201)
  const award = (await created.json()) as ServiceAreaCreated
  const held = assignmentOf(award)
  await expect(dialog).toBeHidden()

  // The first assignment is the server's: the module is read again and the award reopened on it.
  const details = page.getByRole("dialog").filter({ has: page.getByTestId("service-area-commands") })
  const assignments = details.getByTestId("service-area-assignments")
  await expect(assignments.getByRole("listitem")).toHaveCount(1)
  await expect(assignments).toContainText("NordRen")

  await assignments.getByRole("button", { name: "End or note" }).click()
  const end = dialogTitled(page, "End or note the assignment")
  await end.getByLabel(/^Holds until/).fill(start)
  const [ended] = await Promise.all([answerOf(page, "PATCH", new RegExp(`^/service-area-assignments/${held.id}$`)), end.getByRole("button", { name: "Save" }).click()])
  expect(ended.status(), await ended.text()).toBe(200)
  // The assignment's row read back: the details stay on the award.
  await expect(end).toBeHidden()
  await expect(details.getByTestId("service-area-commands")).toBeVisible()
  await expect(assignments).toContainText(`${start} – ${start}`)
})

test("Service provider prices: Add price under an assignment, then Apply index — the chain's next row, the first ended the day before", async ({ page, api }) => {
  const project = await copenhagen(api)
  const nordren = await providerNamed(api, "NordRen")
  const award = await newAward(api, project, nordren, { validFrom: "2027-01-01", validTo: "2028-01-01" })
  const assignment = assignmentOf(award)
  const productName = uniqueName("E2E Container wash")
  const productResponse = await api.post("/products", { data: { projectId: project.id, name: productName, kind: "additional-service", status: "active", unit: "job", invoiceName: productName, invoiceCode: `E2E-${Date.now().toString(36)}`.toUpperCase(), vatPercent: 25 } })
  expect(productResponse.status()).toBe(201)
  const product = (await productResponse.json()) as Product

  const loaded = answerOf(page, "GET", /^\/service-provider-prices$/)
  await page.goto("/commercial?module=service-provider-prices")
  expect((await loaded).status()).toBe(200)
  await page.getByRole("button", { name: "Add price" }).click()
  const dialog = dialogTitled(page, "New service provider price")
  await pick(dialog, page, /^Service area assignment/, new RegExp(`^${award.code} · NordRen`))
  await pick(dialog, page, /^Product/, new RegExp(`^${productName}`))
  await dialog.getByLabel(/^Bid/).fill("11.20")
  await dialog.getByLabel(/^Valid from/).fill("2027-01-01")
  const [created] = await Promise.all([answerOf(page, "POST", /^\/service-provider-prices$/), dialog.getByRole("button", { name: "Add price" }).click()])
  expect(created.status(), await created.text()).toBe(201)
  // Left open, it ends with the assignment, as the field's hint says.
  expect(created.request().postDataJSON()).toEqual({ serviceAreaAssignmentId: assignment.id, productId: product.id, bidMinor: 1120, validFrom: "2027-01-01", validTo: "2028-01-01" })
  const price = (await created.json()) as ProviderPrice
  expect(price).toMatchObject({ bidMinor: 1120, unitPriceMinor: 1120, validTo: "2028-01-01" })
  await expect(dialog).toBeHidden()

  // The new row's details: Apply index on the bid from the first of March.
  const details = page.getByRole("dialog").filter({ has: page.getByTestId("provider-price-commands") })
  await details.getByRole("button", { name: "Apply index" }).click()
  const index = dialogTitled(page, "Apply index")
  await index.getByLabel(/^Index/).fill("CPI")
  await index.getByLabel(/^Change/).fill("5")
  await index.getByLabel(/^From/).fill("2027-03-01")
  const [indexed] = await Promise.all([answerOf(page, "POST", new RegExp(`^/service-provider-prices/${price.id}/index$`)), index.getByRole("button", { name: "Apply index" }).click()])
  expect(indexed.status(), await indexed.text()).toBe(201)
  expect(indexed.request().postDataJSON()).toEqual({ label: "CPI", basisPoints: 500, base: "bid", appliedFrom: "2027-03-01" })
  const next = (await indexed.json()) as ProviderPrice
  expect(next).toMatchObject({ indexedFromId: price.id, bidMinor: 1120, unitPriceMinor: 1176, validFrom: "2027-03-01" })
  await expect(index).toBeHidden()

  const first = (await (await api.get(`/service-provider-prices/${price.id}`)).json()) as ProviderPrice
  expect(first.validTo).toBe("2027-03-01")
  // The price was read back, its details still open on it: it ends the day before the next row starts.
  await expect(details).toContainText("2027-02-28")
  // The chain's next row is listed beside the first.
  await page.keyboard.press("Escape")
  await page.getByPlaceholder("Search service provider prices").fill(productName)
  await expect(page.getByRole("table").locator("tr", { hasText: productName }).filter({ hasText: "11.76" })).toHaveCount(1)
})

test("Settlements: one opened over an assignment's ended period is calculated, closed once asked and reopened with why, each move offered only where its status and the day move it", async ({ page, api }) => {
  const project = await copenhagen(api)
  const cityhaul = await providerNamed(api, "CityHaul")
  const award = await newAward(api, project, cityhaul, { validFrom: "2026-01-01", validTo: "2028-01-01" })
  const assignment = assignmentOf(award)

  const loaded = answerOf(page, "GET", /^\/settlements$/)
  await page.goto("/commercial?module=settlements")
  expect((await loaded).status()).toBe(200)
  await expect(page.getByRole("heading", { name: "Settlements", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Open settlement" }).click()
  const dialog = dialogTitled(page, "Open settlement")
  await pick(dialog, page, /^Service area assignment/, new RegExp(`^${award.code} · CityHaul`))
  // February 2026, which has ended: it is calculated and closed (#260).
  await dialog.getByLabel(/^First day/).fill("2026-02-01")
  await dialog.getByLabel(/^Last day/).fill("2026-02-28")
  const [created] = await Promise.all([answerOf(page, "POST", /^\/settlements$/), dialog.getByRole("button", { name: "Open settlement" }).click()])
  expect(created.status(), await created.text()).toBe(201)
  expect(created.request().postDataJSON()).toEqual({ serviceAreaAssignmentId: assignment.id, validFrom: "2026-02-01", validTo: "2026-03-01" })
  const settlement = (await created.json()) as Settlement
  await expect(dialog).toBeHidden()

  const details = page.getByRole("dialog").filter({ has: page.getByTestId("settlement-commands") })
  const commands = details.getByTestId("settlement-commands")
  const offered = () => commands.getByRole("button").allInnerTexts()
  await expect.poll(offered).toEqual(["Calculate"])
  await expect(details).toContainText("Not calculated yet")

  const [calculated] = await Promise.all([answerOf(page, "POST", new RegExp(`^/settlements/${settlement.id}/calculate$`)), commands.getByRole("button", { name: "Calculate" }).click()])
  expect(calculated.status(), await calculated.text()).toBe(200)
  // Close settlement, named apart from the drawer's own Close, and asked before it is sent (#257).
  await expect.poll(offered).toEqual(["Calculate", "Close settlement"])
  const closes: string[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/settlements/${settlement.id}/close`)) closes.push(request.url())
  })
  await commands.getByRole("button", { name: "Close settlement" }).click()
  const confirm = dialogTitled(page, "Close settlement")
  await expect(confirm).toContainText("what CityHaul")
  await confirm.getByRole("button", { name: "Cancel" }).click()
  await expect(confirm).toBeHidden()
  expect(closes, "nothing is sent until the close is confirmed").toEqual([])
  await commands.getByRole("button", { name: "Close settlement" }).click()
  const [closed] = await Promise.all([answerOf(page, "POST", new RegExp(`^/settlements/${settlement.id}/close$`)), confirm.getByRole("button", { name: "Close settlement" }).click()])
  expect(closed.status(), await closed.text()).toBe(200)
  await expect(confirm).toBeHidden()
  await expect.poll(offered).toEqual(["Reopen"])

  await commands.getByRole("button", { name: "Reopen" }).click()
  const reopen = dialogTitled(page, "Reopen settlement")
  await reopen.getByLabel(/^Why/).fill("A late event of February")
  const [reopened] = await Promise.all([answerOf(page, "POST", new RegExp(`^/settlements/${settlement.id}/reopen$`)), reopen.getByRole("button", { name: "Reopen" }).click()])
  expect(reopened.status(), await reopened.text()).toBe(200)
  expect(reopened.request().postDataJSON()).toEqual({ reason: "A late event of February" })
  await expect.poll(offered).toEqual(["Calculate"])

  // The history keeps every move and why it was reopened.
  const history = details.getByTestId("settlement-history")
  await expect(history.getByRole("listitem")).toHaveCount(3)
  await expect(history.getByRole("listitem").nth(2)).toContainText("Reopened")
  await expect(history.getByRole("listitem").nth(2)).toContainText("A late event of February")
  const events = await listAll<SettlementEvent>(api, `/settlements/${settlement.id}/events`)
  expect(events.map((event) => event.kind)).toEqual(["calculated", "closed", "reopened"])
  expect(((await (await api.get(`/settlements/${settlement.id}`)).json()) as Settlement).status).toBe("open")

  // A period that has not ended on the project's day is calculated, never closed; one not begun offers nothing, and the API says why in its own words (#260). A day either side of today's UTC date holds on Copenhagen's clock too.
  const today = new Date().toISOString().slice(0, 10)
  const opened = async (validFrom: string, lastDay: string) => {
    const response = await api.post("/settlements", { data: { serviceAreaAssignmentId: assignment.id, validFrom, validTo: plus(lastDay, 1) } })
    expect(response.status(), await response.text()).toBe(201)
    return (await response.json()) as Settlement
  }
  const shown = async (row: Settlement) => {
    await page.goto(`/commercial?module=settlements&record=settlement-${row.id}`)
    // Its history read, so its offers are the record's as the store holds it.
    await expect(details.getByText("Nothing yet: it was opened.")).toBeVisible()
  }
  const running = await opened(plus(today, -1), plus(today, 1))
  await shown(running)
  await expect.poll(offered).toEqual(["Calculate"])
  const [partial] = await Promise.all([answerOf(page, "POST", new RegExp(`^/settlements/${running.id}/calculate$`)), commands.getByRole("button", { name: "Calculate" }).click()])
  expect(partial.status(), await partial.text()).toBe(200)
  await expect(details.getByTestId("settlement-history").getByRole("listitem")).toHaveCount(1)
  await expect.poll(offered).toEqual(["Calculate"])
  await expect(details.getByTestId("settlement-held-back")).toContainText("has not ended; close it after its last day")
  const early = await api.post(`/settlements/${running.id}/close`, { data: {} })
  expect(early.status()).toBe(409)
  expect(((await early.json()) as { detail: string }).detail).toMatch(new RegExp(`^Settlement CityHaul.* · ${plus(today, -1)}–${plus(today, 1)} has not ended; close it after its last day$`))

  const ahead = await opened(plus(today, 40), plus(today, 69))
  await shown(ahead)
  await expect.poll(offered).toEqual([])
  await expect(details.getByTestId("settlement-held-back")).toContainText(`${plus(today, 40)} – ${plus(today, 69)} has not begun; calculate it from its first day`)
  const unbegun = await api.post(`/settlements/${ahead.id}/calculate`, { data: {} })
  expect(unbegun.status()).toBe(409)
  expect(((await unbegun.json()) as { detail: string }).detail).toMatch(new RegExp(`^Settlement CityHaul.* · ${plus(today, 40)}–${plus(today, 69)} has not begun; calculate it from its first day$`))
})

test("Weight review: an unload captured on a running route opens in the desk's queue, is approved, rejected with why and corrected, and the corrected one names the row to review", async ({ page, api, browser }) => {
  test.setTimeout(120_000)
  const { route } = await dispatchedRouteFor(api)
  if (route.planned.vehicleId === null) throw new Error(`${route.label} was dispatched with no vehicle`)

  // The driver starts the route, so the office may capture the weighbridge ticket on it.
  const context = await freshContext(browser)
  try {
    const driverPage = await context.newPage()
    await signIn(driverPage, SEEDED_DRIVER.email, E2E.loginPassword)
    const token = await accessTokenOf(context)
    if (token === null) throw new Error("the driver's browser holds no API session")
    const asDriver = await apiAs(token)
    try {
      const started = await asDriver.post("/driver/commands", { data: { commands: [{ id: mintId(Date.now(), crypto.getRandomValues(new Uint8Array(ID_RANDOM_BYTES))), kind: "start-route", routeId: route.id, occurredAt: new Date().toISOString(), deviceId: "e2e-weights", body: { vehicleId: route.planned.vehicleId } }] } })
      expect(started.status()).toBe(200)
      expect(((await started.json()) as { outcomes: { outcome: string }[] }).outcomes.map((outcome) => outcome.outcome)).toEqual(["applied"])
    } finally {
      await asDriver.dispose()
    }
  } finally {
    await context.close()
  }

  try {
    const [station] = await listAll<Named>(api, "/unloading-stations")
    const residual = (await listAll<Named & { key: string }>(api, "/waste-fractions")).find((fraction) => fraction.key === "residual")
    if (station === undefined || residual === undefined) throw new Error("the seed has no station or no residual fraction")
    const ticket = `WB-E2E-${Date.now().toString(36)}`.toUpperCase()
    const captured = await api.post(`/routes/${route.id}/unloads`, { data: { unloadingStationId: station.id, wasteFractionId: residual.id, netKg: 7200, grossKg: 18400, tareKg: 11200, weighbridgeTicket: ticket, occurredAt: new Date(Date.now() - 60_000).toISOString() } })
    expect(captured.status()).toBe(201)
    const unload = (await captured.json()) as Unload

    // The desk opens on what it has still to review.
    const loaded = answerOf(page, "GET", /^\/unloads$/)
    await page.goto("/route-studio?module=weights")
    expect((await loaded).status()).toBe(200)
    await page.getByPlaceholder("Search weight records").fill(ticket)
    const row = page.getByRole("table").getByText(`${ticket} · Residual`)
    await expect(row).toBeVisible()
    await row.click()
    const details = page.getByRole("dialog").filter({ has: page.getByTestId("weight-review-commands") })
    const commands = details.getByTestId("weight-review-commands")
    const offered = () => commands.getByRole("button").allInnerTexts()
    await expect.poll(offered).toEqual(["Approve", "Reject", "Correct"])

    await commands.getByRole("button", { name: "Approve" }).click()
    const [approved] = await Promise.all([answerOf(page, "POST", new RegExp(`^/unloads/${unload.id}/approve$`)), dialogTitled(page, "Approve weight").getByRole("button", { name: "Approve" }).click()])
    expect(approved.status(), await approved.text()).toBe(201)
    await expect.poll(offered).toEqual(["Reject", "Correct"])

    await commands.getByRole("button", { name: "Reject" }).click()
    const reject = dialogTitled(page, "Reject weight")
    await reject.getByLabel(/^Why/).fill("Weighed on the wrong vehicle")
    const [rejected] = await Promise.all([answerOf(page, "POST", new RegExp(`^/unloads/${unload.id}/reject$`)), reject.getByRole("button", { name: "Reject" }).click()])
    expect(rejected.status(), await rejected.text()).toBe(201)
    expect(rejected.request().postDataJSON()).toEqual({ note: "Weighed on the wrong vehicle" })
    await expect.poll(offered).toEqual(["Approve", "Correct"])

    await commands.getByRole("button", { name: "Correct" }).click()
    const correct = dialogTitled(page, "Correct weight")
    await correct.getByLabel(/^Net/).fill("7100")
    await correct.getByLabel(/^Gross/).fill("18300")
    await correct.getByLabel(/^Tare/).fill("11200")
    await correct.getByLabel(/^What was wrong/).fill("Ticket misread")
    const [corrected] = await Promise.all([answerOf(page, "POST", new RegExp(`^/unloads/${unload.id}/correct$`)), correct.getByRole("button", { name: "Correct" }).click()])
    expect(corrected.status(), await corrected.text()).toBe(201)
    expect(corrected.request().postDataJSON()).toEqual({ netKg: 7100, grossKg: 18300, tareKg: 11200, note: "Ticket misread" })
    await expect.poll(offered).toEqual([])
    await expect(details).toContainText("review that one")

    const read = (await (await api.get(`/unloads/${unload.id}`)).json()) as Unload
    expect(read.weightReview.status).toBe("corrected")
    expect(read.weightReview.correctionUnloadId).not.toBeNull()
  } finally {
    // The driver holds one open session at a time: the office ends this route for the next test.
    await api.post(`/routes/${route.id}/cancel`, { data: { reason: "Ended by the weight review end-to-end test" } })
  }
})
