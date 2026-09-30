import type { APIRequestContext, Locator, Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { uniqueName } from "./env"
import { listAll, projectNamed, TESTER_PROJECT } from "./tester"

// Scenario 4, the switched Registry modules whose product surfaces write to
// the API — Service Providers, Contacts & Companies and, since slice 9a of
// #81 (Issue #183), Agreements and Subscriptions — through the generic
// workspace and its form dialog: the create is made in the browser and its
// `Location` read off the API's answer, the row is read back there under the
// browser's own token, it is changed, and a create the API refuses is shown
// to the person in the API's sentence (business-record-store.tsx,
// `reportProblem`) and gone from the list.
//
// The refusal is a stale list's: the form checks a registration number
// against the rows the browser holds, so the duplicate it cannot see is one
// another person made after the page loaded — here, through the API, between
// the page's load and the form's submit. The API is the one that knows. The
// agreements' refusal is #79's gate: a picker hides no customer by status,
// and the API's 409 says why the inactive one cannot take a new agreement.
//
// Since slice 9b (Issue #184), Properties, Property Groups and Shared Points
// too, through their own forms (components/waste/commands/place-surfaces.tsx):
// each set — a property's parties, a group's or a point's members — is
// replaced whole by its one PUT, and #79's gates on a place are shown as they
// come: a subscription at an inactive property, a placement at a closed point.
type ServiceProvider = { id: string; legalName: string; registrationNumber: string; country: string; contactName: string; contactEmail: string }
type Customer = { id: string; kind: "person" | "organisation"; name: string; registrationNumber: string | null; email: string | null; status: string }
type Agreement = { id: string; projectId: string; number: string; customerId: string; payerCustomerId: string; status: string; billingCadence: string; currency: string; notes: string | null; validFrom: string; validTo: string | null }
type Subscription = { id: string; agreementId: string; productId: string; propertyId: string | null; sharedCollectionPointId: string | null; quantity: number; validFrom: string; validTo: string | null }
type Product = { id: string; name: string; status: string }
type Party = { customerId: string; role: string }
type Member = { propertyId: string; role: string }
type Property = { id: string; projectId: string; name: string; address: string; kind: string; status: string; location: { type: "Point"; coordinates: [number, number] } | null; parties: Party[] }
type PropertyGroup = { id: string; projectId: string; name: string; purpose: string; status: string; members: Member[] }
type SharedCollectionPoint = { id: string; projectId: string; name: string; kind: string; status: string; location: { type: "Point"; coordinates: [number, number] }; members: Member[] }
type Container = { id: string; label: string }

/**
 * Eight digits for a registration number, which is unique within the
 * company: four of the clock, which tells two calls in one run apart, and
 * four at random, so a number is not a function of the clock alone — the
 * clock modulo 1e8 hands out the same number to two calls a cycle apart.
 * A stack that outlives many runs still holds its rows, and a collision is
 * the API's 409 in the test's log, not a silent pass.
 */
const registrationNumber = () => `${Date.now() % 10_000}`.padStart(4, "0") + `${Math.floor(Math.random() * 10_000)}`.padStart(4, "0")

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

/** A customer the agreement form will offer: made before the page loads, so the switched contacts module lists it; `inactive` for the one #79 refuses. */
async function customerThroughApi(api: APIRequestContext, name: string, status: "active" | "inactive" = "active") {
  const response = await api.post("/customers", { data: { kind: "organisation", name, registrationNumber: registrationNumber(), status } })
  expect(response.status(), `POST /customers ${name}`).toBe(201)
  return (await response.json()) as Customer
}

/** A product of the project a subscription can name — active, or draft for the product the API refuses. */
async function productThroughApi(api: APIRequestContext, projectId: string, status: "active" | "draft") {
  const response = await api.post("/products", { data: { projectId, name: uniqueName(`E2E ${status} product`), kind: "container-collection", unit: "pickup", status } })
  expect(response.status(), "POST /products").toBe(201)
  return (await response.json()) as Product
}

/** A property of the project, made before the page loads so the switched properties module lists it for the pickers. */
async function propertyThroughApi(api: APIRequestContext, projectId: string) {
  const response = await api.post("/properties", { data: { projectId, name: uniqueName("E2E Property"), address: "Parkvej 18, 2100 København Ø", kind: "residential" } })
  expect(response.status(), "POST /properties").toBe(201)
  return (await response.json()) as Property
}

/**
 * Opens the Agreements module and waits until the switched module is the
 * server's: a seeded agreement no fixture carries (AGR-2188 is the seed's
 * alone) is listed only once every agreement and its subscriptions are here,
 * and a write made before that would go to the browser's bucket instead of
 * the API.
 */
async function openAgreementsLoaded(page: Page) {
  await openLoaded(page, "/customers?module=agreements", "/agreements")
  await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill("AGR-2188")
  // The agreement's row and its subscription's are both named after the number; either says the module is here.
  await expect(page.getByRole("button", { name: /^Open AGR-2188 · / }).first()).toBeVisible({ timeout: 15_000 })
}

async function createAgreement(page: Page, values: { number: string; customer: string; payer: string }) {
  // The header's create button carries the form's submit label, as every module's does.
  await page.getByRole("main").getByRole("button", { name: "Create draft agreement" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "Create agreement" })).toBeVisible()
  await dialog.getByLabel("Agreement number").fill(values.number)
  await dialog.getByRole("combobox", { name: /^Customer/ }).click()
  await page.getByRole("option", { name: values.customer, exact: true }).click()
  await dialog.getByRole("combobox", { name: /^Payer/ }).click()
  await page.getByRole("option", { name: values.payer, exact: true }).click()
  await dialog.getByLabel("Effective from").fill("2026-10-01")
  await dialog.getByLabel("Effective to").fill("2026-12-31")
  await dialog.getByRole("combobox", { name: /^Billing cadence/ }).click()
  await page.getByRole("option", { name: "Monthly" }).click()
  const [response] = await Promise.all([answerOf(page, "POST", "/agreements"), dialog.getByRole("button", { name: "Create draft agreement" }).click()])
  return response
}

/** Add subscription from the open agreement's sheet: the product as the API's id until its module is switched, the property picked by name, the period prefilled from the agreement's own. */
async function addSubscription(page: Page, agreementId: string, values: { productId: string; property: string; quantity: string }, period = { validFrom: "2026-10-01", validTo: "2026-12-31" }) {
  await page.getByRole("dialog").getByRole("button", { name: "Add subscription" }).click()
  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Add subscription" }) })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel("Product").fill(values.productId)
  await dialog.getByRole("combobox", { name: /^Property/ }).click()
  await page.getByRole("option", { name: values.property, exact: true }).click()
  await dialog.getByLabel("Quantity").fill(values.quantity)
  await expect(dialog.getByLabel("Valid from")).toHaveValue(period.validFrom)
  await expect(dialog.getByLabel("Valid to")).toHaveValue(period.validTo)
  const [response] = await Promise.all([answerOf(page, "POST", `/agreements/${agreementId}/subscriptions`), dialog.getByRole("button", { name: "Add subscription" }).click()])
  return response
}

test("Agreements: created in the browser with Location, signed, its subscription added and changed, and the customer and the product the API refuses told in its sentence", async ({ page, api }) => {
  const project = await projectNamed(api, TESTER_PROJECT)
  const customer = await customerThroughApi(api, uniqueName("E2E Housing"))
  const inactive = await customerThroughApi(api, uniqueName("E2E Former customer"), "inactive")
  const product = await productThroughApi(api, project.id, "active")
  const draftProduct = await productThroughApi(api, project.id, "draft")
  const property = await propertyThroughApi(api, project.id)
  const number = uniqueName("E2E-AGR").replace(/\s+/g, "-").toUpperCase()
  await openAgreementsLoaded(page)

  // The agreement, a draft in the pinned project, its customer and payer picked by name from the switched contacts module.
  const created = await createAgreement(page, { number, customer: customer.name, payer: customer.name })
  expect(created.status()).toBe(201)
  const agreement = (await created.json()) as Agreement
  const location = created.headers()["location"]
  expect(location).toBe(`/agreements/${agreement.id}`)
  expect(agreement).toMatchObject({ projectId: project.id, number, customerId: customer.id, payerCustomerId: customer.id, status: "draft", billingCadence: "monthly", currency: "DKK", validFrom: "2026-10-01", validTo: "2027-01-01" })
  const read = await api.get(location)
  expect(read.status()).toBe(200)
  expect(await read.json()).toEqual(agreement)

  // Its sheet opened on the new row; Active is the lifecycle move the wire spells from a draft, behind the governed dialog.
  const sheet = page.getByRole("dialog")
  await expect(sheet.getByRole("heading", { name: new RegExp(`^${number}`) })).toBeVisible()
  await sheet.getByRole("button", { name: "Active", exact: true }).click()
  const governed = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Active" }) })
  await governed.getByLabel("Decision or action reason").fill("E2E: the agreement is signed")
  const [signed] = await Promise.all([answerOf(page, "PATCH", location), governed.getByRole("button", { name: "Confirm active" }).click()])
  expect(signed.status()).toBe(200)
  expect(await signed.json()).toMatchObject({ id: agreement.id, status: "active" })

  // A subscription under it: the product by the API's id, since its module is not switched yet, the property picked by name (#184); two of the product for the agreement's period.
  const subscribed = await addSubscription(page, agreement.id, { productId: product.id, property: property.name, quantity: "2" })
  expect(subscribed.status()).toBe(201)
  const subscription = (await subscribed.json()) as Subscription
  expect(subscribed.headers()["location"]).toBe(`/subscriptions/${subscription.id}`)
  expect(subscription).toMatchObject({ agreementId: agreement.id, productId: product.id, propertyId: property.id, sharedCollectionPointId: null, quantity: 2, validFrom: "2026-10-01", validTo: "2027-01-01" })

  // The sheet moved to the subscription; its edit changes the quantity alone, the product and the place held read-only.
  await expect(page.getByRole("dialog").getByRole("heading", { name: new RegExp(`^${number} · `) })).toBeVisible()
  await page.getByRole("dialog").getByRole("button", { name: "Edit subscription" }).click()
  const edit = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Edit subscription" }) })
  await expect(edit.getByLabel("Product")).toHaveJSProperty("readOnly", true)
  await expect(edit.getByLabel("Product")).toHaveValue(`product-${product.id}`)
  await edit.getByLabel("Quantity").fill("3")
  const [changed] = await Promise.all([answerOf(page, "PATCH", `/subscriptions/${subscription.id}`), edit.getByRole("button", { name: "Save changes" }).click()])
  expect(changed.status()).toBe(200)
  expect(await changed.json()).toMatchObject({ id: subscription.id, quantity: 3, productId: product.id })
  expect((await (await api.get(`/subscriptions/${subscription.id}`)).json()) as Subscription).toMatchObject({ quantity: 3 })

  // #79 on a subscription: a draft product cannot be subscribed to, and the API's sentence is shown.
  await openAgreementsLoaded(page)
  await (await rowNamed(page, `${number} · ${customer.name}`)).click()
  const refusedProduct = await addSubscription(page, agreement.id, { productId: draftProduct.id, property: property.name, quantity: "1" })
  expect(refusedProduct.status()).toBe(409)
  await expect(page.getByText("The product is draft; only an active product can be subscribed to")).toBeVisible()

  // Cancelled is the wire's third status, offered from a running agreement and patched like the first move; the subscription under it stands (#79: a status gates a new reference, never an existing one).
  await openAgreementsLoaded(page)
  await (await rowNamed(page, `${number} · ${customer.name}`)).click()
  await page.getByRole("dialog").getByRole("button", { name: "Cancelled", exact: true }).click()
  const cancelling = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Cancelled" }) })
  await cancelling.getByLabel("Decision or action reason").fill("E2E: the customer withdrew")
  const [cancelled] = await Promise.all([answerOf(page, "PATCH", location), cancelling.getByRole("button", { name: "Confirm cancelled" }).click()])
  expect(cancelled.status()).toBe(200)
  expect(await cancelled.json()).toMatchObject({ id: agreement.id, status: "cancelled" })
  expect((await (await api.get(`/subscriptions/${subscription.id}`)).json()) as Subscription).toMatchObject({ id: subscription.id, quantity: 3 })

  // #79 on an agreement: the picker offers the inactive customer, its status beside its name, and the API refuses the new reference in its own sentence; the row is gone.
  await openAgreementsLoaded(page)
  const otherNumber = uniqueName("E2E-AGR").replace(/\s+/g, "-").toUpperCase()
  const refused = await createAgreement(page, { number: otherNumber, customer: `${inactive.name} · Inactive`, payer: customer.name })
  expect(refused.status()).toBe(409)
  await expect(page.getByText(`${otherNumber} was not saved`)).toBeVisible()
  await expect(page.getByText("The customer is inactive; an agreement needs an active customer")).toBeVisible()
  await openAgreementsLoaded(page)
  await expect(await rowNamed(page, `${number} · ${customer.name}`)).toBeVisible()
  await expect(await rowNamed(page, otherNumber)).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Properties, property groups and shared collection points (slice 9b, #184)
// ---------------------------------------------------------------------------

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const byProperty = (a: Member, b: Member) => a.propertyId.localeCompare(b.propertyId)
const byParty = (a: Party, b: Party) => `${a.customerId} ${a.role}`.localeCompare(`${b.customerId} ${b.role}`)

/** Picks one option of a select in `dialog`, by the start of its label. */
async function pickOne(page: Page, dialog: Locator, field: string, option: RegExp) {
  await dialog.getByRole("combobox", { name: new RegExp(`^${field}`) }).click()
  await page.getByRole("option", { name: option }).first().click()
}

/** Ticks (or unticks) rows of a multiselect in `dialog`, each found through the picker's own search, then closes the picker. */
async function pickMany(page: Page, dialog: Locator, field: string, names: readonly string[]) {
  await dialog.getByRole("combobox", { name: new RegExp(`^${field}`) }).click()
  for (const name of names) {
    await page.getByPlaceholder(`Search ${field.toLowerCase()}`).fill(name)
    await page.getByRole("option", { name, exact: true }).click()
  }
  await page.keyboard.press("Escape")
}

/** The browser's `PUT` of a set, by its path. */
const setReplaced = (page: Page, path: string) => page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === `/waste-api${path}`)

/** A running agreement of the project a subscription can be added under, from 2026-10-01 to the year's end. */
async function agreementThroughApi(api: APIRequestContext, projectId: string, customerId: string) {
  const number = uniqueName("E2E-AGR").replace(/\s+/g, "-").toUpperCase()
  const response = await api.post("/agreements", { data: { projectId, number, customerId, payerCustomerId: customerId, status: "active", billingCadence: "monthly", currency: "DKK", validFrom: "2026-10-01", validTo: "2027-01-01" } })
  expect(response.status(), "POST /agreements").toBe(201)
  return (await response.json()) as Agreement
}

/** A container of the project received into one of its warehouses: in stock, so the door into service is open to it. */
async function receivedContainerThroughApi(api: APIRequestContext, projectId: string) {
  const [types, warehouses] = await Promise.all([listAll<{ id: string }>(api, "/container-types"), listAll<{ id: string; projectId: string; status: string }>(api, "/warehouses")])
  const warehouse = warehouses.find((candidate) => candidate.projectId === projectId && candidate.status === "active")
  if (warehouse === undefined || types.length === 0) throw new Error("the seeded tenant has no container type or no active warehouse in the project")
  const created = await api.post("/containers", { data: { projectId, label: uniqueName("E2E-BIN").replace(/\s+/g, "-"), containerTypeId: types[0].id } })
  expect(created.status(), "POST /containers").toBe(201)
  const container = (await created.json()) as Container
  const received = await api.post(`/containers/${container.id}/receive`, { data: { warehouseId: warehouse.id } })
  expect(received.status(), "POST /containers/:id/receive").toBe(201)
  return container
}

test("Properties: created in the browser with its owner and its point, read back, its parties replaced whole beside a rename, set Inactive, and a subscription there refused in #79's sentence", async ({ page, api }) => {
  const project = await projectNamed(api, TESTER_PROJECT)
  const owner = await customerThroughApi(api, uniqueName("E2E Owner"))
  const tenant = await customerThroughApi(api, uniqueName("E2E Tenant"))
  const product = await productThroughApi(api, project.id, "active")
  const agreement = await agreementThroughApi(api, project.id, owner.id)
  const name = uniqueName("E2E Property")
  await openLoaded(page, "/customers?module=properties", "/properties")

  // The header's action is the module's own create form: the address, its point, and the owner picked from the switched customers.
  await page.getByRole("main").getByRole("button", { name: "New property" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "Create property" })).toBeVisible()
  await pickOne(page, dialog, "Operating project", /^Copenhagen Central/)
  await dialog.getByLabel("Property name").fill(name)
  await dialog.getByLabel("Service address").fill("Blegdamsvej 40, 2100 København Ø")
  await pickOne(page, dialog, "Property type", /^Residential/)
  await dialog.getByLabel("Latitude").fill("55.6975")
  await dialog.getByLabel("Longitude").fill("12.5731")
  await pickMany(page, dialog, "Owners", [owner.name])
  const [created] = await Promise.all([answerOf(page, "POST", "/properties"), dialog.getByRole("button", { name: "Create property" }).click()])
  expect(created.status()).toBe(201)
  const property = (await created.json()) as Property
  expect(created.headers()["location"]).toBe(`/properties/${property.id}`)
  expect(property).toMatchObject({ projectId: project.id, name, address: "Blegdamsvej 40, 2100 København Ø", kind: "residential", status: "active", location: { type: "Point", coordinates: [12.5731, 55.6975] }, parties: [{ customerId: owner.id, role: "owner" }] })
  expect(await (await api.get(`/properties/${property.id}`)).json()).toEqual(property)

  // Its details opened on the new row; the edit renames it and replaces the parties whole, a tenant beside the owner: the patch, then the set's own PUT.
  const sheet = page.getByRole("dialog").filter({ has: page.getByTestId("place-commands") })
  await expect(sheet.getByRole("heading", { name })).toBeVisible()
  await sheet.getByRole("button", { name: "Edit property" }).click()
  const edit = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Edit property" }) })
  await expect(edit).toBeVisible()
  await edit.getByLabel("Property name").fill(`${name} B`)
  await pickMany(page, edit, "Tenants", [tenant.name])
  const renamed = answerOf(page, "PATCH", `/properties/${property.id}`)
  const replaced = setReplaced(page, `/properties/${property.id}/parties`)
  await edit.getByRole("button", { name: "Save changes" }).click()
  expect((await renamed).status()).toBe(200)
  const put = await replaced
  expect(put.status()).toBe(200)
  expect(JSON.parse(put.request().postData() ?? "{}")).toEqual({ parties: [{ customerId: owner.id, role: "owner" }, { customerId: tenant.id, role: "tenant" }] })
  const read = (await (await api.get(`/properties/${property.id}`)).json()) as Property
  expect(read.name).toBe(`${name} B`)
  expect([...read.parties].sort(byParty)).toEqual([{ customerId: owner.id, role: "owner" }, { customerId: tenant.id, role: "tenant" }].sort(byParty))

  // Inactive is the lifecycle's move the wire spells, behind the governed dialog.
  await sheet.getByRole("button", { name: "Inactive", exact: true }).click()
  const governed = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Inactive" }) })
  await governed.getByLabel("Decision or action reason").fill("E2E: the property is no longer served")
  const [deactivated] = await Promise.all([answerOf(page, "PATCH", `/properties/${property.id}`), governed.getByRole("button", { name: "Confirm inactive" }).click()])
  expect(deactivated.status()).toBe(200)
  expect(await deactivated.json()).toMatchObject({ id: property.id, status: "inactive" })

  // #79 on a subscription: the property picker offers the inactive property, and the API refuses the new reference in its own sentence.
  await openAgreementsLoaded(page)
  await (await rowNamed(page, `${agreement.number} · ${owner.name}`)).click()
  const refused = await addSubscription(page, agreement.id, { productId: product.id, property: `${name} B`, quantity: "1" })
  expect(refused.status()).toBe(409)
  await expect(page.getByText("The property is inactive; a subscription needs an active property")).toBeVisible()
})

test("Property groups: gathered in the browser with a member, read back, and a member added in another role while the first keeps its own", async ({ page, api }) => {
  const project = await projectNamed(api, TESTER_PROJECT)
  const first = await propertyThroughApi(api, project.id)
  const second = await propertyThroughApi(api, project.id)
  const name = uniqueName("E2E Group")
  await openLoaded(page, "/customers?module=groups", "/property-groups")

  await page.getByRole("main").getByRole("button", { name: "New group" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "Create property group" })).toBeVisible()
  await pickOne(page, dialog, "Operating project", /^Copenhagen Central/)
  await dialog.getByLabel("Group name").fill(name)
  await pickOne(page, dialog, "Group purpose", /^Reporting only/)
  await pickMany(page, dialog, "Member properties", [first.name])
  const [created] = await Promise.all([answerOf(page, "POST", "/property-groups"), dialog.getByRole("button", { name: "Create property group" }).click()])
  expect(created.status()).toBe(201)
  const group = (await created.json()) as PropertyGroup
  expect(created.headers()["location"]).toBe(`/property-groups/${group.id}`)
  expect(group).toMatchObject({ projectId: project.id, name, purpose: "reporting", status: "draft", members: [{ propertyId: first.id, role: "member" }] })
  expect(await (await api.get(`/property-groups/${group.id}`)).json()).toEqual(group)

  // The edit adds a property in the role new members join as; the member already there keeps its own, and the set goes out whole.
  const sheet = page.getByRole("dialog").filter({ has: page.getByTestId("place-commands") })
  await expect(sheet.getByRole("heading", { name })).toBeVisible()
  await sheet.getByRole("button", { name: "Edit property group" }).click()
  const edit = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Edit property group" }) })
  await expect(edit).toBeVisible()
  await pickMany(page, edit, "Member properties", [second.name])
  await pickOne(page, edit, "Role for new members", /^Payer$/)
  const [replaced] = await Promise.all([setReplaced(page, `/property-groups/${group.id}/members`), edit.getByRole("button", { name: "Save changes" }).click()])
  expect(replaced.status()).toBe(200)
  expect(JSON.parse(replaced.request().postData() ?? "{}")).toEqual({ members: [{ propertyId: first.id, role: "member" }, { propertyId: second.id, role: "payer" }] })
  const read = (await (await api.get(`/property-groups/${group.id}`)).json()) as PropertyGroup
  expect([...read.members].sort(byProperty)).toEqual([{ propertyId: first.id, role: "member" }, { propertyId: second.id, role: "payer" }].sort(byProperty))
})

test("Shared points: planned in the browser open with its members, read back, its members replaced whole, closed, and a placement there refused in #79's sentence", async ({ page, api }) => {
  const project = await projectNamed(api, TESTER_PROJECT)
  const first = await propertyThroughApi(api, project.id)
  const second = await propertyThroughApi(api, project.id)
  const customer = await customerThroughApi(api, uniqueName("E2E Point customer"))
  const product = await productThroughApi(api, project.id, "active")
  const agreement = await agreementThroughApi(api, project.id, customer.id)
  const container = await receivedContainerThroughApi(api, project.id)
  const name = uniqueName("E2E Point")
  await openLoaded(page, "/customers?module=shared", "/shared-collection-points")

  await page.getByRole("main").getByRole("button", { name: "New shared point" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "Create shared collection point" })).toBeVisible()
  await pickOne(page, dialog, "Operating project", /^Copenhagen Central/)
  await dialog.getByLabel("Shared-point name").fill(name)
  await pickOne(page, dialog, "Collection-point type", /^Underground system/)
  await pickOne(page, dialog, "Initial state", /^Open$/)
  await dialog.getByLabel("Location address").fill("Kongens Nytorv, 1050 København K")
  await dialog.getByLabel("Latitude").fill("55.6806")
  await dialog.getByLabel("Longitude").fill("12.5857")
  await pickOne(page, dialog, "Operating model", /^Municipal shared service/)
  await pickOne(page, dialog, "Access mode", /^Open access/)
  await pickOne(page, dialog, "Billing responsibility", /^Project or municipality/)
  await pickMany(page, dialog, "Participating properties", [first.name, second.name])
  const [created] = await Promise.all([answerOf(page, "POST", "/shared-collection-points"), dialog.getByRole("button", { name: "Create shared point" }).click()])
  expect(created.status()).toBe(201)
  const point = (await created.json()) as SharedCollectionPoint
  expect(created.headers()["location"]).toBe(`/shared-collection-points/${point.id}`)
  expect(point).toMatchObject({ projectId: project.id, name, kind: "underground", status: "open", location: { type: "Point", coordinates: [12.5857, 55.6806] } })
  expect([...point.members].sort(byProperty)).toEqual([{ propertyId: first.id, role: "service-member" }, { propertyId: second.id, role: "service-member" }].sort(byProperty))
  expect(await (await api.get(`/shared-collection-points/${point.id}`)).json()).toEqual(point)

  // The edit replaces the members whole: the second property unticked, one member left.
  const sheet = page.getByRole("dialog").filter({ has: page.getByTestId("place-commands") })
  await expect(sheet.getByRole("heading", { name })).toBeVisible()
  await sheet.getByRole("button", { name: "Edit shared point" }).click()
  const edit = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Edit shared collection point" }) })
  await expect(edit).toBeVisible()
  await pickMany(page, edit, "Participating properties", [second.name])
  const [replaced] = await Promise.all([setReplaced(page, `/shared-collection-points/${point.id}/members`), edit.getByRole("button", { name: "Save changes" }).click()])
  expect(replaced.status()).toBe(200)
  expect(JSON.parse(replaced.request().postData() ?? "{}")).toEqual({ members: [{ propertyId: first.id, role: "service-member" }] })

  // A subscription at the point, made through the API while it is open, which #79 lets it take; then Closed, the lifecycle's move.
  const subscribed = await api.post(`/agreements/${agreement.id}/subscriptions`, { data: { productId: product.id, sharedCollectionPointId: point.id, validFrom: "2026-10-01", validTo: "2027-01-01" } })
  expect(subscribed.status(), "POST /agreements/:id/subscriptions").toBe(201)
  await sheet.getByRole("button", { name: "Closed", exact: true }).click()
  const governed = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Closed" }) })
  await governed.getByLabel("Decision or action reason").fill("E2E: the point is taken away")
  const [closed] = await Promise.all([answerOf(page, "PATCH", `/shared-collection-points/${point.id}`), governed.getByRole("button", { name: "Confirm closed" }).click()])
  expect(closed.status()).toBe(200)
  expect(await closed.json()).toMatchObject({ id: point.id, status: "closed" })

  // #79 on a placement: the container is issued under the subscription, picked by the place it is delivered at, and the API refuses a placement at a closed point in its own sentence.
  await openLoaded(page, "/resources?module=containers", "/containers")
  await (await rowNamed(page, container.label)).click()
  await page.getByTestId("container-commands").getByRole("button", { name: "Issue into service", exact: true }).click()
  const issue = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Issue into service" }) })
  await expect(issue).toBeVisible()
  await pickOne(page, issue, "Subscription", new RegExp(escapeRegExp(name)))
  await pickOne(page, issue, "Waste fraction", /^Residual/)
  await issue.getByLabel("First day in service").fill("2026-10-01")
  const [refused] = await Promise.all([answerOf(page, "POST", `/containers/${container.id}/placements`), issue.getByRole("button", { name: "Issue into service", exact: true }).click()])
  expect(refused.status()).toBe(409)
  await expect(page.getByText(`${container.label} was not issued into service`)).toBeVisible()
  await expect(page.getByText("The subscription's shared collection point is closed; a placement needs an open or restricted point")).toBeVisible()
})
