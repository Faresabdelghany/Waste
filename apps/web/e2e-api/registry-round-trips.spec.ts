import type { APIRequestContext, Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { uniqueName } from "./env"

// Scenario 4, the two switched modules whose product surfaces write to the
// API — Service Providers and Contacts & Companies, through the generic
// workspace and its form dialog: the create is made in the browser and its
// `Location` read off the API's answer, the row is read back there under the
// browser's own token, it is changed, and a create the API refuses is shown
// to the person in the API's sentence (business-record-store.tsx,
// `reportProblem`) and gone from the list.
//
// The refusal is a stale list's: the form checks a registration number
// against the rows the browser holds, so the duplicate it cannot see is one
// another person made after the page loaded — here, through the API, between
// the page's load and the form's submit. The API is the one that knows.
type ServiceProvider = { id: string; legalName: string; registrationNumber: string; country: string; contactName: string; contactEmail: string }
type Customer = { id: string; kind: "person" | "organisation"; name: string; registrationNumber: string | null; email: string | null; status: string }

/** Eight digits no earlier run used, since a registration number is unique within the company. */
const registrationNumber = () => `${Date.now() % 100_000_000}`.padStart(8, "0")

/** The browser's API call the form submit makes: the answer of the request path `path`, method `method`. */
const answerOf = (page: Page, method: string, path: string) =>
  page.waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname.startsWith(`/waste-api${path}`))

/**
 * Opens a workspace page and waits for the switched module's rows to arrive
 * from the API: the record store loads the modules after the page renders
 * its fixtures, and a dialog opened before that lands is rebuilt under the
 * person's hands.
 */
async function openLoaded(page: Page, url: string, listPath: string) {
  const loaded = answerOf(page, "GET", listPath)
  await page.goto(url)
  expect((await loaded).status()).toBe(200)
}

/**
 * The row's opener, after narrowing the list to the name through the
 * module's own search: the lists page at twenty-five rows and a developer's
 * stack accumulates rows across runs, so a row's presence is asked of the
 * whole list and not of its first page.
 */
async function rowNamed(page: Page, name: string) {
  await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill(name)
  return page.getByRole("button", { name: `Open ${name}` })
}

async function addServiceProvider(page: Page, values: { legalName: string; registrationNumber: string; contactName: string; contactEmail: string }) {
  await page.getByRole("button", { name: "Add service provider" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "Add service provider" })).toBeVisible()
  await dialog.getByLabel("Legal company name").fill(values.legalName)
  await dialog.getByLabel("Registration number").fill(values.registrationNumber)
  await dialog.getByLabel("Primary contact").fill(values.contactName)
  await dialog.getByLabel("Contact email").fill(values.contactEmail)
  await dialog.getByLabel("Relationship starts").fill("2026-10-01")
  const [response] = await Promise.all([answerOf(page, "POST", "/service-providers"), dialog.getByRole("button", { name: "Add service provider" }).click()])
  return response
}

async function serviceProviderThroughApi(api: APIRequestContext, registration: string) {
  const response = await api.post("/service-providers", {
    data: { legalName: uniqueName("E2E Elsewhere Provider"), registrationNumber: registration, country: "DK", contactName: "Elsewhere", contactEmail: "elsewhere@waste-e2e.example" },
  })
  expect(response.status()).toBe(201)
  return (await response.json()) as ServiceProvider
}

test("Service Providers: created in the browser with Location, read back, changed, and a registration taken meanwhile refused by sentence", async ({ page, api }) => {
  const legalName = uniqueName("E2E Provider")
  const registration = registrationNumber()
  await openLoaded(page, "/service-providers", "/service-providers")

  const created = await addServiceProvider(page, { legalName, registrationNumber: registration, contactName: "E2E Contact", contactEmail: "provider@waste-e2e.example" })
  expect(created.status()).toBe(201)
  const body = (await created.json()) as ServiceProvider
  const location = created.headers()["location"]
  expect(location).toBe(`/service-providers/${body.id}`)
  expect(body).toMatchObject({ legalName, registrationNumber: registration, country: "DK", contactName: "E2E Contact", contactEmail: "provider@waste-e2e.example" })
  // The workspace opened the new provider's page.
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(legalName)
  await expect(page.getByRole("definition").filter({ hasText: registration })).toBeVisible()

  const read = await api.get(location)
  expect(read.status()).toBe(200)
  expect(await read.json()).toEqual(body)

  // The provider's page offers no edit form yet, so the change goes through the API under the browser's token; the page then shows the server's row.
  const edited = await api.patch(location, { data: { contactName: "E2E Contact, renamed" } })
  expect(edited.status()).toBe(200)
  expect(await edited.json()).toMatchObject({ id: body.id, contactName: "E2E Contact, renamed" })
  await openLoaded(page, "/service-providers", "/service-providers")
  await (await rowNamed(page, legalName)).click()
  await expect(page.getByRole("definition").filter({ hasText: "E2E Contact, renamed" })).toBeVisible()

  // A registration number somebody else takes after this page loaded: the form cannot know, the API's 409 is told in its sentence, and the row is gone.
  await openLoaded(page, "/service-providers", "/service-providers")
  const taken = registrationNumber()
  const elsewhere = await serviceProviderThroughApi(api, taken)
  const otherName = uniqueName("E2E Duplicate")
  const refused = await addServiceProvider(page, { legalName: otherName, registrationNumber: taken, contactName: "Somebody", contactEmail: "somebody@waste-e2e.example" })
  expect(refused.status()).toBe(409)
  await expect(page.getByText(`${otherName} was not saved`)).toBeVisible()
  await expect(page.getByText(`This company already has a service provider with the registration number ${taken} in DK`)).toBeVisible()
  await openLoaded(page, "/service-providers", "/service-providers")
  await expect(await rowNamed(page, legalName)).toBeVisible()
  await expect(await rowNamed(page, elsewhere.legalName)).toBeVisible()
  await expect(await rowNamed(page, otherName)).toHaveCount(0)
})

async function createOrganisation(page: Page, values: { name: string; registrationNumber: string; email: string }) {
  await page.getByRole("button", { name: "Create party" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "Create contact or company" })).toBeVisible()
  await dialog.getByRole("combobox", { name: /^Party type/ }).click()
  await page.getByRole("option", { name: "Company or organization" }).click()
  await dialog.getByLabel("Display or legal name").fill(values.name)
  await dialog.getByLabel("Organization identifier").fill(values.registrationNumber)
  await dialog.getByLabel("Email", { exact: true }).fill(values.email)
  await dialog.getByRole("combobox", { name: /^Role/ }).click()
  await page.getByRole("option", { name: "Customer", exact: true }).click()
  await dialog.getByLabel("Relationship effective from").fill("2026-10-01")
  const [response] = await Promise.all([answerOf(page, "POST", "/customers"), dialog.getByRole("button", { name: "Create party" }).click()])
  return response
}

async function organisationThroughApi(api: APIRequestContext, registration: string) {
  const response = await api.post("/customers", { data: { kind: "organisation", name: uniqueName("E2E Elsewhere Organisation"), registrationNumber: registration } })
  expect(response.status()).toBe(201)
  return (await response.json()) as Customer
}

test("Contacts & Companies: created in the browser with Location, read back, moved to Inactive, and a registration taken meanwhile refused by sentence", async ({ page, api }) => {
  const name = uniqueName("E2E Organisation")
  const registration = registrationNumber()
  await openLoaded(page, "/customers?module=contacts", "/customers")

  const created = await createOrganisation(page, { name, registrationNumber: registration, email: "org@waste-e2e.example" })
  expect(created.status()).toBe(201)
  const body = (await created.json()) as Customer
  const location = created.headers()["location"]
  expect(location).toBe(`/customers/${body.id}`)
  expect(body).toMatchObject({ kind: "organisation", name, registrationNumber: registration, email: "org@waste-e2e.example", status: "active" })

  const read = await api.get(location)
  expect(read.status()).toBe(200)
  expect(await read.json()).toEqual(body)

  // The record's sheet opened on the new row; its lifecycle action is the
  // module's edit, a status patch, behind the governed-action dialog that
  // wants a reason before it confirms.
  const sheet = page.getByRole("dialog")
  await expect(sheet.getByRole("heading", { name })).toBeVisible()
  await sheet.getByRole("button", { name: "Inactive" }).click()
  const governed = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Inactive" }) })
  await governed.getByLabel("Decision or action reason").fill("E2E: the organisation is no longer served")
  const [patched] = await Promise.all([answerOf(page, "PATCH", location), governed.getByRole("button", { name: "Confirm inactive" }).click()])
  expect(patched.status()).toBe(200)
  expect(await patched.json()).toMatchObject({ id: body.id, status: "inactive" })
  expect((await (await api.get(location)).json()) as Customer).toMatchObject({ status: "inactive" })

  // A registration number somebody else takes after this page loaded: refused by the API, said in its sentence, and not in the list.
  await openLoaded(page, "/customers?module=contacts", "/customers")
  const taken = registrationNumber()
  const elsewhere = await organisationThroughApi(api, taken)
  const otherName = uniqueName("E2E Duplicate organisation")
  const refused = await createOrganisation(page, { name: otherName, registrationNumber: taken, email: "other@waste-e2e.example" })
  expect(refused.status()).toBe(409)
  await expect(page.getByText(`${otherName} was not saved`)).toBeVisible()
  await expect(page.getByText(`This company already has a customer with registration number ${taken}`)).toBeVisible()
  await openLoaded(page, "/customers?module=contacts", "/customers")
  await expect(await rowNamed(page, name)).toBeVisible()
  await expect(await rowNamed(page, elsewhere.name)).toBeVisible()
  await expect(await rowNamed(page, otherName)).toHaveCount(0)
})
