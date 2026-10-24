import type { APIRequestContext, Locator, Page } from "@playwright/test"

import { dayIn, driverNamed, generate, SEEDED_DRIVER } from "./dispatched-route"
import { E2E, uniqueName } from "./env"
import { chainLanded, expect, freshContext, signIn, test } from "./fixtures"
import { answerOf, openRoute, pick, routeRead, schemeWithRoutes, toasts, type ApiRoute } from "./routes-support"
import { listAll, projectNamed, type Project } from "./tester"

// The office's own routes and stops on the API (Issue #111, its web half).
// New route makes an ad-hoc route — no scheme — on a project's day; Add stop
// puts a stop on a route that has not started, at a container or at an
// address with the fraction collected there; the route is dispatched and its
// driver reads the address-only stop by its address and its fraction. A stop
// the office added to a generated route stands through the next Generate,
// and a ticket's re-collection names it: complete · recollected picks the
// route, then its stop. Every body is the one the contracts take, read off
// the browser's own request; the properties are made for the run, uniquely
// named and never cleaned up.

type Named = { id: string; name: string }
type Property = Named & { address: string }
type Container = { id: string; label: string }
type Placement = { containerId: string; projectId: string; wasteFractionId: string }
type AddedPickup = { id: string; routeId: string; position: number; sequence?: number; status: string; origin: string; containerId: string | null; propertyId: string | null; sharedCollectionPointId: string | null; wasteFractionId: string; note: string | null }
type ApiTicket = { id: string; label: string; recollectionRouteId: string | null; recollectionPickupId: string | null }

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Picks the option whose name matches `option` in the select whose label starts with `label`. */
async function pickMatching(within: Locator, page: Page, label: string, option: RegExp) {
  await within.getByRole("combobox", { name: new RegExp(`^${label}`) }).click()
  await page.getByRole("option", { name: option }).click()
}

/** A property of the project made for the run, active, and so served as a subscription's place would be. */
async function propertyFor(api: APIRequestContext, project: Project, prefix: string): Promise<Property> {
  const placed = await api.post("/properties", { data: { projectId: project.id, name: uniqueName(prefix), address: "Parkvej 18, 2100 København Ø", kind: "residential" } })
  expect(placed.status(), await placed.text()).toBe(201)
  return (await placed.json()) as Property
}

async function residualOf(api: APIRequestContext): Promise<Named> {
  const residual = (await listAll<Named>(api, "/waste-fractions")).find((row) => row.name === "Residual")
  expect(residual, "the seed holds Residual").toBeTruthy()
  return residual as Named
}

test("New route makes the office's own route on a project's day with no scheme; a stop at a property is added with its fraction, the route is dispatched, and its driver reads the stop by its address and fraction", async ({ api, browser, page }) => {
  test.setTimeout(150_000)
  const [project, driver, residual] = await Promise.all([projectNamed(api, "Copenhagen Central"), driverNamed(api, SEEDED_DRIVER.name), residualOf(api)])
  const property = await propertyFor(api, project, "E2E Ad-hoc property")
  const today = dayIn("Europe/Copenhagen")
  const note = uniqueName("E2E Bulky collection")

  const listed = answerOf(page, "GET", "/routes")
  await page.goto("/route-studio?module=routes")
  expect((await listed).status()).toBe(200)
  await chainLanded(page)
  const newRoute = page.getByRole("button", { name: "New route" })
  await expect(newRoute).toBeEnabled({ timeout: 30_000 })
  await newRoute.click()
  const form = page.getByRole("dialog", { name: "New route" })
  await pick(form, page, "Project", project.name)
  await form.getByRole("textbox", { name: /^Operating date/ }).fill(today)
  await pick(form, page, "Driver", "Mads Jensen · Active")
  await form.getByRole("textbox", { name: /^Note/ }).fill(note)
  const [created] = await Promise.all([answerOf(page, "POST", "/routes"), form.getByRole("button", { name: "Create route" }).click()])
  expect(created.status(), await created.text()).toBe(201)
  expect(created.request().postDataJSON()).toEqual({ projectId: project.id, operatingDate: today, driverId: driver.id, note })
  const route = (await created.json()) as Omit<ApiRoute, "routeSchemeId"> & { routeSchemeId: string | null }
  expect({ scheme: route.routeSchemeId, status: route.status, serviceDate: route.serviceDate }).toEqual({ scheme: null, status: "planned", serviceDate: today })
  await expect(toasts(page)).toContainText("Route created")

  // The route made opens in its details: the office's own, a fact rather than a scheme's placeholder, its note under its own name, with no stop yet.
  const details = page.getByRole("dialog", { name: route.label })
  await expect(details).toContainText("OriginMade by the office")
  await expect(details).toContainText(`Note${note}`)
  await expect(details).not.toContainText("Deviation")
  await expect(details).toContainText("Mads Jensen")
  await expect(details).toContainText("No stop yet: add the route's stops.")
  const stops = details.getByTestId("route-stops")

  const commands = details.getByTestId("route-commands")
  const addStop = commands.getByRole("button", { name: "Add stop" })
  await expect(addStop).toBeEnabled({ timeout: 30_000 })
  await addStop.click()
  const dialog = page.getByRole("dialog", { name: "Add stop" })
  await pick(dialog, page, "Collect", "A property")
  await pick(dialog, page, "Property", property.name)
  await pick(dialog, page, "Waste fraction", "Residual")
  await dialog.getByRole("textbox", { name: /^Note for the driver/ }).fill("Three sofas by the gate")
  const [added] = await Promise.all([answerOf(page, "POST", `/routes/${route.id}/pickups`), dialog.getByRole("button", { name: "Add stop" }).click()])
  expect(added.status(), await added.text()).toBe(201)
  expect(added.request().postDataJSON()).toEqual({ propertyId: property.id, wasteFractionId: residual.id, note: "Three sofas by the gate" })
  await expect(dialog).toBeHidden()
  await expect(toasts(page)).toContainText(`A stop was added to ${route.label}`)
  await expect(stops.locator("li")).toHaveCount(1)
  await expect(stops.locator("li").first()).toContainText(`1. ${property.name} · Planned · added by the office`)

  const [dispatched] = await Promise.all([answerOf(page, "POST", `/routes/${route.id}/dispatch`), commands.getByRole("button", { name: "Dispatch" }).click()])
  expect(dispatched.status()).toBe(200)
  await expect(details).toContainText("Dispatched at")

  const read = (await routeRead(api, route.id)) as unknown as { status: string; routeSchemeId: string | null; pickups: AddedPickup[] }
  expect(read.status).toBe("ready")
  expect(read.routeSchemeId).toBeNull()
  expect(read.pickups.map(({ origin, status, containerId, propertyId, wasteFractionId, note: stopNote }) => ({ origin, status, containerId, propertyId, wasteFractionId, note: stopNote }))).toEqual([
    { origin: "office", status: "planned", containerId: null, propertyId: property.id, wasteFractionId: residual.id, note: "Three sofas by the gate" },
  ])

  // The driver's phone: the stop is its address and its fraction, with no container to name.
  const phone = await freshContext(browser, { viewport: { width: 390, height: 844 } })
  try {
    const driverPage = await phone.newPage()
    await signIn(driverPage, SEEDED_DRIVER.email, E2E.loginPassword)
    const card = driverPage.getByRole("article", { name: `Route ${route.label}` })
    await expect(card.getByText("Ready", { exact: true })).toBeVisible()
    await card.getByRole("link", { name: "Open route" }).click()
    await expect(driverPage).toHaveURL(new RegExp(`/driver/routes/${route.id}$`))
    const stop = driverPage.getByRole("article", { name: "Stop 1", exact: true })
    await expect(stop.getByRole("heading", { name: property.address })).toBeVisible()
    await expect(stop.getByText("Residual", { exact: true })).toBeVisible()
    await expect(stop.getByText(/^ · |^null · /)).toHaveCount(0)
  } finally {
    await phone.close()
  }
})

test("a stop the office adds at a container to a generated route stands through a later Generate, neither moved nor skipped", async ({ api, page }) => {
  test.setTimeout(150_000)
  const { scheme, routes } = await schemeWithRoutes(api, uniqueName("E2E Added stop"), 7)
  const [route] = routes
  const [before, residual, containers, placements] = await Promise.all([
    routeRead(api, route.id),
    residualOf(api),
    listAll<Container>(api, "/containers"),
    listAll<Placement>(api, "/placements", { validOn: route.serviceDate }),
  ])
  // A container placed in the route's project on its service date that the scheme's rule does not match: not Residual, so not a stop of it already.
  const onRoute = new Set(before.pickups.map((pickup) => pickup.containerId))
  const placement = placements.find((candidate) => candidate.projectId === route.projectId && candidate.wasteFractionId !== residual.id && !onRoute.has(candidate.containerId))
  const container = containers.find((candidate) => candidate.id === placement?.containerId)
  if (placement === undefined || container === undefined) throw new Error(`the seed places no container of another fraction in Copenhagen Central on ${route.serviceDate}`)

  const details = await openRoute(page, route)
  const commands = details.getByTestId("route-commands")
  const addStop = commands.getByRole("button", { name: "Add stop" })
  await expect(addStop).toBeEnabled({ timeout: 30_000 })
  await addStop.click()
  const dialog = page.getByRole("dialog", { name: "Add stop" })
  // A container is what a stop collects at unless the office says otherwise.
  await expect(dialog.getByRole("combobox", { name: /^Collect/ })).toContainText("A container")
  await expect(dialog.getByRole("combobox", { name: /^Waste fraction/ })).toHaveCount(0)
  await pickMatching(dialog, page, "Container", new RegExp(`^${escaped(container.label)}( · |$)`))
  const [added] = await Promise.all([answerOf(page, "POST", `/routes/${route.id}/pickups`), dialog.getByRole("button", { name: "Add stop" }).click()])
  expect(added.status(), await added.text()).toBe(201)
  expect(added.request().postDataJSON()).toEqual({ containerId: container.id })
  const stop = (await added.json()) as AddedPickup
  // Its place and fraction are its placement's; it goes after the route's last stop.
  expect({ origin: stop.origin, status: stop.status, containerId: stop.containerId, wasteFractionId: stop.wasteFractionId, position: stop.position }).toEqual({
    origin: "office",
    status: "planned",
    containerId: container.id,
    wasteFractionId: placement.wasteFractionId,
    position: Math.max(0, ...before.pickups.map((pickup) => pickup.position)) + 1,
  })
  await expect(details.getByTestId("route-stops")).toContainText(`${container.label} · Planned · added by the office`)

  // The scheme is generated again over the route's day: the route is refreshed in place, and the office's stop stands as it was added.
  await generate(api, scheme.id, { from: route.serviceDate, to: route.serviceDate })
  const sameDay = await listAll<{ id: string }>(api, "/routes", { routeSchemeId: scheme.id, from: route.serviceDate, to: route.serviceDate })
  expect(sameDay.map((row) => row.id)).toEqual([route.id])
  const after = (await routeRead(api, route.id)) as unknown as { status: string; pickups: AddedPickup[] }
  expect(after.status).toBe("planned")
  const kept = after.pickups.find((pickup) => pickup.id === stop.id)
  expect(kept && { origin: kept.origin, status: kept.status, containerId: kept.containerId, position: kept.position }).toEqual({ origin: "office", status: "planned", containerId: container.id, position: stop.position })
  // Generation's own stops are what its rule still matches, and the added container is not planned a second time.
  expect(after.pickups.filter((pickup) => pickup.origin !== "office").map((pickup) => pickup.containerId).sort()).toEqual(before.pickups.map((pickup) => pickup.containerId).sort())
  expect(after.pickups.filter((pickup) => pickup.containerId === container.id)).toHaveLength(1)

  // Read again, the details still name it the office's.
  const again = await openRoute(page, route)
  await expect(again.getByTestId("route-stops")).toContainText(`${container.label} · Planned · added by the office`)
})

test("a ticket's re-collection names the stop the office added for it: complete · recollected picks the route, then its stop", async ({ api, page }) => {
  test.setTimeout(150_000)
  const { routes } = await schemeWithRoutes(api, uniqueName("E2E Re-collection stop"), 7)
  const [about] = routes
  const recollection = routes[1] ?? about
  const [project, residual, aboutRead] = await Promise.all([projectNamed(api, "Copenhagen Central"), residualOf(api), routeRead(api, about.id)])
  const property = await propertyFor(api, project, "E2E Re-collection property")

  // The office adds the re-collection to a later route of the scheme, at the address, with the fraction missed.
  const addedResponse = await api.post(`/routes/${recollection.id}/pickups`, { data: { propertyId: property.id, wasteFractionId: residual.id, note: "Re-collection of a missed bin" } })
  expect(addedResponse.status(), await addedResponse.text()).toBe(201)
  const added = (await addedResponse.json()) as AddedPickup
  const subject = uniqueName("E2E missed bin")
  const opened = await api.post("/tickets", { data: { projectId: project.id, subject, description: "The bin was not emptied", kind: "missed-collection", links: { routeId: about.id, pickupId: aboutRead.pickups[0]?.id, propertyId: property.id } } })
  expect(opened.status(), await opened.text()).toBe(201)
  const ticket = (await opened.json()) as ApiTicket

  await page.goto(`/tickets?module=tickets&record=ticket-${ticket.id}`)
  const details = page.getByRole("dialog", { name: subject })
  const complete = details.getByTestId("ticket-commands").getByRole("button", { name: "Complete" })
  await expect(complete).toBeEnabled({ timeout: 30_000 })
  await complete.click()
  const dialog = page.getByRole("dialog", { name: "Complete" })
  await pick(dialog, page, "Resolution", "Recollected")
  await pick(dialog, page, "Re-collection route", `${recollection.label} · ${recollection.operatingDate} · Planned`)
  // The route's stops still to collect or collected, after None — the route alone. Complete does not wait on the stops' read, the stop being optional; the option shows once it lands.
  await dialog.getByRole("combobox", { name: /^Re-collection stop/ }).click()
  await expect(page.getByRole("option", { name: "None: the route alone", exact: true })).toBeVisible()
  await page.getByRole("option", { name: new RegExp(`^Stop \\d+ · ${escaped(property.name)}$`) }).click()
  await dialog.getByRole("textbox", { name: /^How it was resolved/ }).fill(`On ${recollection.label}, the office's stop`)
  const [completed] = await Promise.all([answerOf(page, "POST", `/tickets/${ticket.id}/complete`), dialog.getByRole("button", { name: "Complete" }).click()])
  expect(completed.status(), await completed.text()).toBe(200)
  expect(completed.request().postDataJSON()).toEqual({ resolution: "recollected", note: `On ${recollection.label}, the office's stop`, recollectionRouteId: recollection.id, recollectionPickupId: added.id })
  await expect(details).toContainText(`Re-collection route${recollection.label}`)
  await expect(details).toContainText(new RegExp(`Re-collection stopStop \\d+ · ${escaped(property.name)}`))

  const stored = (await (await api.get(`/tickets/${ticket.id}`)).json()) as ApiTicket
  expect({ route: stored.recollectionRouteId, stop: stored.recollectionPickupId }).toEqual({ route: recollection.id, stop: added.id })
})
