import type { APIRequestContext, Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { uniqueName } from "./env"
import { projectNamed, TESTER_PROJECT } from "./tester"

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
type ServiceProvider = { id: string; legalName: string; registrationNumber: string; country: string; contactName: string; contactEmail: string }
type Customer = { id: string; kind: "person" | "organisation"; name: string; registrationNumber: string | null; email: string | null; status: string }
type Agreement = { id: string; projectId: string; number: string; customerId: string; payerCustomerId: string; status: string; billingCadence: string; currency: string; notes: string | null; validFrom: string; validTo: string | null }
type Subscription = { id: string; agreementId: string; productId: string; propertyId: string | null; sharedCollectionPointId: string | null; quantity: number; validFrom: string; validTo: string | null }
type Product = { id: string; name: string; status: string }
type Property = { id: string; name: string }

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

/** A property of the project a subscription is delivered at; the Properties module is not switched yet (slice 9b), so the form takes its id. */
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

/** Add subscription from the open agreement's sheet: the product and the place as the API's ids, the period prefilled from the agreement's own. */
async function addSubscription(page: Page, agreementId: string, values: { productId: string; propertyId: string; quantity: string }) {
  await page.getByRole("dialog").getByRole("button", { name: "Add subscription" }).click()
  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Add subscription" }) })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel("Product").fill(values.productId)
  await dialog.getByLabel("Property", { exact: true }).fill(values.propertyId)
  await dialog.getByLabel("Quantity").fill(values.quantity)
  await expect(dialog.getByLabel("Valid from")).toHaveValue("2026-10-01")
  await expect(dialog.getByLabel("Valid to")).toHaveValue("2026-12-31")
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

  // A subscription under it: the product and the property by the API's ids, since their modules are not switched yet; two of the product for the agreement's period.
  const subscribed = await addSubscription(page, agreement.id, { productId: product.id, propertyId: property.id, quantity: "2" })
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
  const refusedProduct = await addSubscription(page, agreement.id, { productId: draftProduct.id, propertyId: property.id, quantity: "1" })
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
