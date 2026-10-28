import { uniqueName } from "./env"
import { chainLanded, expect, test } from "./fixtures"
import { answerOf, pick } from "./routes-support"
import { listAll, projectNamed, TESTER_PROJECT } from "./tester"

// Recycling-centre visits on the Pilot (#393 M4a), by API calls alone: the
// pages are M4b's. The office registers a recycling centre, a product sold
// per visit priced on the project's default list, a Visit Rule charging a
// business's visit at it, and a business's plate under one of the seeded
// agreements. The attendant's check-in admits the plate and answers what the
// visit costs; an unknown plate is turned away and still recorded. The
// worker's Finance consumer charges the admitted visit as a `visit` event at
// the product, and the visit's void cancels it.
//
// The stack lives across runs and one Visit Rule is in force per project at
// a time, so the rule holds one day alone, one no rule of an earlier run
// covers, inside the agreement's period; the product, the plate and the
// centre are this run's. The day lies in the past, which a check-in's
// instant may.

type Rule = { id: string; validFrom: string; validTo: string | null }
type Agreement = { id: string; customerId: string; status: string; priceListId: string | null; validFrom: string; validTo: string | null }
type Visit = { id: string; outcome: string; refusalReason: string | null; customerId: string | null; agreementId: string | null; voidedAt: string | null }
type CheckIn = { visit: Visit; charge: { basis: string; productId: string | null; price: { netMinor: number; currency: string } | null } | null }
type Event = { id: string; kind: string; status: string; cancelReason: string | null; netMinor: number | null; links: { visitId: string | null } }

const dayAfter = (day: string, days = 1) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

test("the attendant's check-in admits a business's plate and answers its charge, the worker charges the visit, and its void cancels the charge", async ({ api }) => {
  test.setTimeout(120_000)
  const project = await projectNamed(api, TESTER_PROJECT)
  const today = new Date().toISOString().slice(0, 10)

  // A day inside the period of an active agreement priced under the project's default list, two days back at the least, that no Visit Rule of the project covers.
  const agreements = (await listAll<Agreement>(api, "/agreements", { projectId: project.id })).filter((agreement) => agreement.status === "active" && agreement.priceListId === null)
  const rules = await listAll<Rule>(api, "/visit-rules", { projectId: project.id })
  const covered = (day: string) => rules.some((rule) => rule.validFrom <= day && (rule.validTo === null || day < rule.validTo))
  let chosen: { agreement: Agreement; day: string } | undefined
  for (const agreement of agreements) {
    for (let back = 2; back < 400 && chosen === undefined; back += 1) {
      const day = dayAfter(today, -back - Math.floor(Math.random() * 3))
      if (day >= agreement.validFrom && (agreement.validTo === null || dayAfter(day) < agreement.validTo) && !covered(day)) chosen = { agreement, day }
    }
    if (chosen !== undefined) break
  }
  if (chosen === undefined) throw new Error(`no day of an active agreement of ${project.name} is free of a Visit Rule`)
  const { agreement, day } = chosen

  const [fraction] = await listAll<{ id: string }>(api, "/waste-fractions")
  if (fraction === undefined) throw new Error("the seed holds no waste fraction")
  const centre = await api.post("/drop-off-points", {
    data: {
      projectId: project.id,
      code: uniqueName("GS-E2E").replaceAll(" ", "-"),
      name: uniqueName("E2E Recycling Centre"),
      kind: "recycling-centre",
      address: "Kraftværksvej 31, 2300 København S",
      location: { type: "Point", coordinates: [12.6105, 55.6521] },
      status: "active",
      wasteFractionIds: [fraction.id],
    },
  })
  expect(centre.status(), await centre.text()).toBe(201)
  const siteId = ((await centre.json()) as { id: string }).id

  const made = await api.post("/products", { data: { projectId: project.id, name: uniqueName("E2E Business visit"), kind: "additional-service", status: "active", unit: "visit", vatPercent: 25 } })
  expect(made.status(), await made.text()).toBe(201)
  const productId = ((await made.json()) as { id: string }).id
  const [list] = (await listAll<{ id: string; isDefault: boolean; validFrom: string }>(api, "/price-lists", { projectId: project.id })).filter((candidate) => candidate.isDefault && candidate.validFrom <= day)
  if (list === undefined) throw new Error(`${project.name} has no default price list in force on ${day}`)
  const row = await api.post(`/price-lists/${list.id}/rows`, { data: { productId, unitPriceMinor: 15_000, validFrom: list.validFrom } })
  expect(row.status(), await row.text()).toBe(201)

  const rule = await api.post("/visit-rules", { data: { projectId: project.id, validFrom: day, validTo: dayAfter(day), businessVisitProductId: productId } })
  expect(rule.status(), await rule.text()).toBe(201)

  const plate = `E2E-${Date.now().toString(36).toUpperCase()}`
  const credential = await api.post("/access-credentials", { data: { projectId: project.id, kind: "plate", value: plate, customerId: agreement.customerId, agreementId: agreement.id, validFrom: day, validTo: dayAfter(day) } })
  expect(credential.status(), await credential.text()).toBe(201)

  const checkIn = async (value: string) => {
    const response = await api.post("/site-visits", { data: { siteId, identifier: { kind: "plate", value }, wasteFractionIds: [fraction.id], occurredAt: `${day}T11:00:00.000Z` } })
    expect(response.status(), await response.text()).toBe(201)
    return (await response.json()) as CheckIn
  }
  const admitted = await checkIn(plate.toLowerCase())
  expect(admitted.visit).toMatchObject({ outcome: "admitted", customerId: agreement.customerId, agreementId: agreement.id })
  expect(admitted.charge).toMatchObject({ basis: "per-visit", productId, price: { netMinor: 15_000 } })
  const unknown = await checkIn(`${plate}X`)
  expect(unknown.visit).toMatchObject({ outcome: "refused", refusalReason: "unknown-identifier" })
  expect(unknown.charge).toBeNull()

  // The worker's relay and Finance consumer turn the recording into the visit's charge.
  const chargeOf = async (): Promise<Event | undefined> => (await listAll<Event>(api, "/billable-events", { projectId: project.id, productId })).find((event) => event.links.visitId === admitted.visit.id)
  await expect.poll(async () => (await chargeOf())?.status, { timeout: 60_000 }).toBe("ready")
  expect(await chargeOf()).toMatchObject({ kind: "visit", netMinor: 15_000 })

  const voided = await api.post(`/site-visits/${admitted.visit.id}/void`, { data: { reason: "Checked in at the wrong site" } })
  expect(voided.status(), await voided.text()).toBe(200)
  expect(((await voided.json()) as Visit).voidedAt).not.toBeNull()
  await expect.poll(async () => (await chargeOf())?.status, { timeout: 60_000 }).toBe("cancelled")
  expect((await chargeOf())?.cancelReason).toBe("visit-voided")
})

// The office's pages and the attendant's (#393 M4b). Settings › Commercial ›
// Recycling-centre charges adds a Visit Rule through its dialog — on one past
// day no rule of an earlier run covers, so the stack's next run finds today
// free too — with one free visit a year, a step at the run's product sold per
// visit and a likely-trade threshold. Customers › Site access registers a
// business's plate through its own dialog under a customer and agreement made
// for the run. The phone-first check-in admits the plate typed as a person
// types it, with a fraction chip of the site's, and turns an unknown plate
// away, the site remembered on the device across a reload. The ledger's
// details void the visit with why, and Likely trades reads the project's.
// Every body is the one the contracts take, read off the browser's own
// request.

type Named = { id: string; name: string }

const made = async <T>(api: import("@playwright/test").APIRequestContext, path: string, data: unknown): Promise<T> => {
  const response = await api.post(path, { data })
  expect(response.status(), `POST ${path}: ${await response.text()}`).toBe(201)
  return (await response.json()) as T
}

test("the office sets a Visit Rule in Settings and registers a business's plate in Site access; the attendant's check-in admits it and turns an unknown plate away; the ledger voids the visit and reads the likely trades", async ({ api, page }) => {
  test.setTimeout(150_000)
  const project = await projectNamed(api, TESTER_PROJECT)
  const today = new Date().toISOString().slice(0, 10)
  const rules = await listAll<Rule>(api, "/visit-rules", { projectId: project.id })
  const covered = (day: string) => rules.some((rule) => rule.validFrom <= day && (rule.validTo === null || day < rule.validTo))
  let ruleDay: string | undefined
  for (let back = 30; back < 4000 && ruleDay === undefined; back += 1 + Math.floor(Math.random() * 3)) if (!covered(dayAfter(today, -back))) ruleDay = dayAfter(today, -back)
  if (ruleDay === undefined) throw new Error(`no past day of ${project.name} is free of a Visit Rule`)

  const fraction = (await listAll<Named>(api, "/waste-fractions")).find((row) => row.name === "Residual")
  if (fraction === undefined) throw new Error("the seed holds no Residual fraction")
  const centre = await made<Named>(api, "/drop-off-points", {
    projectId: project.id,
    code: uniqueName("GS-WEB").replaceAll(" ", "-"),
    name: uniqueName("E2E Web Recycling Centre"),
    kind: "recycling-centre",
    address: "Kraftværksvej 31, 2300 København S",
    location: { type: "Point", coordinates: [12.6105, 55.6521] },
    status: "active",
    wasteFractionIds: [fraction.id],
  })
  const step = await made<Named>(api, "/products", { projectId: project.id, name: uniqueName("E2E Household visit"), kind: "additional-service", status: "active", unit: "visit", vatPercent: 25 })
  const customer = await made<Named>(api, "/customers", { kind: "organisation", name: uniqueName("E2E Site business") })
  const agreement = await made<{ id: string; number: string }>(api, "/agreements", { projectId: project.id, number: uniqueName("E2E-GS").replace(/\s+/g, "-").toUpperCase(), customerId: customer.id, payerCustomerId: customer.id, status: "active", billingCadence: "monthly", currency: "DKK", validFrom: ruleDay, validTo: null })

  // The Visit Rule, through Settings.
  const read = answerOf(page, "GET", "/visit-rules")
  await page.goto("/settings?pane=commercial-visit-rules")
  const pane = page.locator("body")
  await pick(pane, page, "Project", project.name)
  expect((await read).status()).toBe(200)
  await pane.getByRole("button", { name: "Add rule" }).click()
  const add = page.getByRole("dialog", { name: "Add Visit Rule" })
  await add.getByLabel("First day in force").fill(ruleDay)
  await add.getByLabel("Last day in force").fill(ruleDay)
  await add.getByLabel("Free visits a year").fill("1")
  await add.getByRole("button", { name: "Add step" }).click()
  await pick(add, page, "Step 1", step.name)
  await add.getByLabel("Counted visits").fill("3")
  await add.getByLabel("In a window of days").fill("30")
  const [ruled] = await Promise.all([answerOf(page, "POST", "/visit-rules"), add.getByRole("button", { name: "Add rule" }).click()])
  expect(ruled.status(), await ruled.text()).toBe(201)
  expect(ruled.request().postDataJSON()).toEqual({ projectId: project.id, validFrom: ruleDay, validTo: dayAfter(ruleDay), freeVisits: 1, ladder: [step.id], freeFractionIds: [], businessVisitProductId: null, annualAccessProductId: null, tradeThreshold: 3, tradeWindowDays: 30 })
  await expect(pane.getByRole("row", { name: `Visit Rule ${ruleDay} to ${ruleDay}` })).toContainText(`1 free visit a year, then ${step.name} for each visit after`)

  // The plate, through Site access's own dialog.
  const plate = `WEB${Date.now().toString(36).toUpperCase()}`
  const listed = answerOf(page, "GET", "/access-credentials")
  await page.goto("/customers?module=site-access")
  expect((await listed).status()).toBe(200)
  await chainLanded(page)
  const register = page.getByRole("button", { name: "Register a plate or card" })
  await expect(register).toBeEnabled({ timeout: 30_000 })
  await register.click()
  const dialog = page.getByRole("dialog", { name: "Register a plate or card" })
  await dialog.getByLabel("Plate", { exact: true }).fill(`${plate.slice(0, 3).toLowerCase()} ${plate.slice(3)}`)
  await dialog.getByLabel("Label").fill("Van 1")
  await pick(dialog, page, "Holder", "A business, by its customer and agreement")
  await pick(dialog, page, "Customer", customer.name)
  await pick(dialog, page, "Agreement", `${agreement.number} · ${customer.name}`)
  await dialog.getByLabel("First day in force").fill(today)
  const [registered] = await Promise.all([answerOf(page, "POST", "/access-credentials"), dialog.getByRole("button", { name: "Register", exact: true }).click()])
  expect(registered.status(), await registered.text()).toBe(201)
  expect(registered.request().postDataJSON()).toEqual({ projectId: project.id, kind: "plate", value: plate, customerId: customer.id, agreementId: agreement.id, label: "Van 1", validFrom: today, validTo: null })

  // The attendant's check-in: the site, the plate as typed and a fraction chip; then an unknown plate.
  const sites = answerOf(page, "GET", "/site-visits/sites")
  await page.goto("/check-in")
  expect((await sites).status()).toBe(200)
  const projectSelect = page.getByLabel("Project")
  if (await projectSelect.count()) {
    const again = answerOf(page, "GET", "/site-visits/sites")
    await projectSelect.selectOption({ label: project.name })
    await again.catch(() => undefined)
  }
  await page.getByLabel("Recycling centre").selectOption({ label: centre.name })
  await page.getByLabel("Plate", { exact: true }).fill(`${plate.slice(0, 3).toLowerCase()}-${plate.slice(3)}`)
  await page.getByRole("button", { name: fraction.name }).click()
  const [checked] = await Promise.all([answerOf(page, "POST", "/site-visits"), page.getByRole("button", { name: "Check in", exact: true }).click()])
  expect(checked.status(), await checked.text()).toBe(201)
  expect(checked.request().postDataJSON()).toEqual({ siteId: centre.id, identifier: { kind: "plate", value: plate }, wasteFractionIds: [fraction.id] })
  const visit = ((await checked.json()) as CheckIn).visit
  const answer = page.getByRole("region", { name: "Check-in answer" })
  await expect(answer).toContainText("Admitted")
  await expect(answer).toContainText(plate)
  await answer.getByRole("button", { name: "Next visitor" }).click()
  await page.getByLabel("Plate", { exact: true }).fill(`${plate}X`)
  const [refused] = await Promise.all([answerOf(page, "POST", "/site-visits"), page.getByRole("button", { name: "Check in", exact: true }).click()])
  expect(refused.status(), await refused.text()).toBe(201)
  await expect(answer).toContainText("Turned away: not registered")

  // The site is the device's own across a reload.
  await page.reload()
  await expect(page.getByLabel("Recycling centre")).toHaveValue(centre.id, { timeout: 30_000 })

  // The ledger: the visit's details void it with why.
  const ledger = answerOf(page, "GET", "/site-visits")
  await page.goto(`/operate?module=site-visits&record=site-visit-${visit.id}`)
  expect((await ledger).status()).toBe(200)
  const commands = page.getByTestId("site-visit-commands")
  await expect(commands.getByRole("button", { name: "Void visit" })).toBeEnabled({ timeout: 30_000 })
  await commands.getByRole("button", { name: "Void visit" }).click()
  const voiding = page.getByRole("dialog", { name: "Void visit" })
  await voiding.getByLabel("Why").fill("Checked in twice")
  const [voided] = await Promise.all([answerOf(page, "POST", `/site-visits/${visit.id}/void`), voiding.getByRole("button", { name: "Void visit" }).click()])
  expect(voided.status(), await voided.text()).toBe(200)
  expect(voided.request().postDataJSON()).toEqual({ reason: "Checked in twice" })
  await expect(commands).toContainText("Voided")

  // Likely trades: the project's, read from the API.
  await page.goto("/operate?module=site-visits")
  await chainLanded(page)
  const [opened] = await Promise.all([answerOf(page, "GET", "/site-visits/frequent"), page.getByRole("button", { name: "Likely trades" }).click()])
  expect(opened.status(), await opened.text()).toBe(200)
  const trades = page.getByRole("dialog", { name: "Likely trades" })
  if (!(await trades.getByRole("combobox", { name: "Project" }).textContent())?.includes(project.name)) {
    const [frequent] = await Promise.all([answerOf(page, "GET", "/site-visits/frequent"), pick(trades, page, "Project", project.name)])
    expect(frequent.status(), await frequent.text()).toBe(200)
  }
  await expect(trades).toContainText(/No Visit Rule is in force|flags no likely trade|Flagged at/)
})
