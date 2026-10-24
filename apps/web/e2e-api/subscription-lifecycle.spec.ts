import type { APIRequestContext, Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { uniqueName } from "./env"
import { projectNamed, TESTER_PROJECT } from "./tester"

// A subscription's and an agreement's lifecycle on the Pilot (#291, slice
// 10c), through the agreements' row surface: a subscription paused over a
// week and the pause cancelled before it begins, its service changed from a
// day — the old one ending there and the replacement taking over — and the
// agreement terminated on its last day of service. Each is the request the
// API takes, sent from the dialog's days (a pause's and a termination's last
// day in, the wire's end the day after), and read back from the API. The
// days are counted from today, since a pause begins today or later on the
// project's clock.
type Agreement = { id: string; number: string; validFrom: string; validTo: string | null }
type Subscription = { id: string; agreementId: string; productId: string; quantity: number; validFrom: string; validTo: string | null }
type Product = { id: string; name: string }
type Property = { id: string; name: string }
type Pause = { id: string; subscriptionId: string; validFrom: string; validTo: string | null }

/** A day `offset` days from today, `YYYY-MM-DD` on the UTC calendar: a week out is today or later on any clock the tests run under. */
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

/** The browser's API call a dialog's submit makes: the answer of the request path `path`, method `method`. */
const answerOf = (page: Page, method: string, path: string) =>
  page.waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname === `/waste-api${path}`)

async function made<T>(api: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await api.post(path, { data })
  expect(response.status(), `POST ${path}`).toBe(201)
  return (await response.json()) as T
}

/** An agreement running from a month ago to four months on, its one subscription from the same day: what the lifecycle moves. */
async function subscribedThroughApi(api: APIRequestContext) {
  const project = await projectNamed(api, TESTER_PROJECT)
  const customer = await made<{ id: string; name: string }>(api, "/customers", { kind: "organisation", name: uniqueName("E2E Lifecycle") })
  const product = await made<Product>(api, "/products", { projectId: project.id, name: uniqueName("E2E Lifecycle product"), kind: "container-collection", unit: "pickup", status: "active" })
  const property = await made<Property>(api, "/properties", { projectId: project.id, name: uniqueName("E2E Lifecycle property"), address: "Parkvej 18, 2100 København Ø", kind: "residential" })
  const number = uniqueName("E2E-LIFE").replace(/\s+/g, "-").toUpperCase()
  const agreement = await made<Agreement>(api, "/agreements", { projectId: project.id, number, customerId: customer.id, payerCustomerId: customer.id, status: "active", billingCadence: "monthly", currency: "DKK", validFrom: day(-30), validTo: day(120) })
  const subscription = await made<Subscription>(api, `/agreements/${agreement.id}/subscriptions`, { productId: product.id, propertyId: property.id, validFrom: day(-30), validTo: day(120) })
  return { agreement, subscription, product, customer }
}

/** Opens Agreements once the switched module is the server's, then the row named, through the module's own search. */
async function openRow(page: Page, name: string) {
  await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill(name)
  await page.getByRole("button", { name: `Open ${name}` }).click()
  await expect(page.getByRole("dialog").getByRole("heading", { name })).toBeVisible()
}

test("a subscription paused and the pause cancelled, its service changed from a day, and its agreement terminated, each the API's own request", async ({ page, api }) => {
  const { agreement, subscription, product, customer } = await subscribedThroughApi(api)
  const loaded = answerOf(page, "GET", "/subscriptions")
  await page.goto("/customers?module=agreements")
  expect((await loaded).status()).toBe(200)

  // The subscription's sheet: its lifecycle, no pause yet.
  const subscriptionName = `${agreement.number} · ${product.name}`
  await openRow(page, subscriptionName)
  const sheet = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: subscriptionName }) })
  const lifecycle = sheet.getByTestId("subscription-lifecycle")
  await expect(lifecycle.getByText("No pause.")).toBeVisible()

  // Paused for a week from a week on: the dialog's last day in, the wire's end the day after.
  await lifecycle.getByRole("button", { name: "Pause", exact: true }).click()
  const pausing = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Pause" }) })
  await pausing.getByLabel("Paused from").fill(day(7))
  await pausing.getByLabel("Last day paused").fill(day(13))
  const [paused] = await Promise.all([answerOf(page, "POST", `/subscriptions/${subscription.id}/pauses`), pausing.getByRole("button", { name: "Pause", exact: true }).click()])
  expect(paused.status()).toBe(201)
  expect(paused.request().postDataJSON()).toEqual({ validFrom: day(7), validTo: day(14) })
  const pause = ((await paused.json()) as { pause: Pause }).pause
  const pauses = lifecycle.getByTestId("subscription-pauses")
  await expect(pauses.getByRole("listitem")).toHaveText([new RegExp(`^Paused ${day(7)} – ${day(13)} · planned`)])

  // Cancelled before it begins: gone from the API and from the list.
  const [cancelled] = await Promise.all([answerOf(page, "POST", `/subscription-pauses/${pause.id}/cancel`), pauses.getByRole("button", { name: "Cancel pause" }).click()])
  expect(cancelled.status()).toBe(200)
  await expect(lifecycle.getByText("No pause.")).toBeVisible()
  expect((await api.get(`/subscription-pauses/${pause.id}`)).status()).toBe(404)

  // The service changed from a week on: two of the product, the old one ending there and the replacement from then.
  await lifecycle.getByRole("button", { name: "Change service" }).click()
  const changing = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Change service" }) })
  await changing.getByLabel("New service from").fill(day(7))
  await changing.getByLabel("Quantity").fill("2")
  const [changed] = await Promise.all([answerOf(page, "POST", `/subscriptions/${subscription.id}/change`), changing.getByRole("button", { name: "Change service" }).click()])
  expect(changed.status()).toBe(201)
  expect(changed.request().postDataJSON()).toEqual({ on: day(7), quantity: 2 })
  const replacement = (await changed.json()) as Subscription
  expect(replacement).toMatchObject({ agreementId: agreement.id, productId: product.id, quantity: 2, validFrom: day(7), validTo: day(120) })
  expect(((await (await api.get(`/subscriptions/${subscription.id}`)).json()) as Subscription).validTo).toBe(day(7))
  await expect(page.getByRole("region", { name: /^Notifications/ }).getByText("Service changed", { exact: true })).toBeVisible()

  // The agreement terminated on its last day of service, two months on: the wire's day the one after.
  await page.keyboard.press("Escape")
  const agreementName = `${agreement.number} · ${customer.name}`
  await openRow(page, agreementName)
  const agreementSheet = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: agreementName }) })
  await agreementSheet.getByTestId("agreement-lifecycle").getByRole("button", { name: "Terminate" }).click()
  const terminating = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Terminate" }) })
  await terminating.getByLabel("Last day of service").fill(day(60))
  const [terminated] = await Promise.all([answerOf(page, "POST", `/agreements/${agreement.id}/terminate`), terminating.getByRole("button", { name: "Terminate" }).click()])
  expect(terminated.status()).toBe(200)
  expect(terminated.request().postDataJSON()).toEqual({ on: day(61) })
  expect(((await terminated.json()) as { agreement: Agreement; stopsToRemove: unknown[] }).stopsToRemove).toEqual([])
  expect(((await (await api.get(`/agreements/${agreement.id}`)).json()) as Agreement).validTo).toBe(day(61))
  expect(((await (await api.get(`/subscriptions/${replacement.id}`)).json()) as Subscription).validTo, "its subscriptions end with it").toBe(day(61))
  await expect(page.getByRole("region", { name: /^Notifications/ }).getByText("Agreement terminated", { exact: true })).toBeVisible()
})
