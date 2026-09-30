import { dispatchedRouteFor, driverNamed, SEEDED_DRIVER } from "./dispatched-route"
import { E2E, uniqueName } from "./env"
import { expect, freshContext, signIn, test } from "./fixtures"
import { answerOf, onCopenhagenClock, openRoute, pick, routeRead, schemeWithRoutes, toasts } from "./routes-support"
import { ensureTester, listAll, roleNamed } from "./tester"

// Route Studio's routes, stops and Live board on the API (Issue #179, slice
// 6 of #81). A generated route is the API's row under the server's id, its
// details the generic view with its commands; the dispatcher's five
// commands go out as the contracts' bodies and a refusal is the API's own
// sentence; a stop is removed or its outcome corrected; the Live board reads
// what the driver's device reports, and the office's cancel ends the
// driver's session. The routes are a scheme's made for the run
// (routes-support.ts), or the Driver App's dispatched route for today.

type Container = { id: string; label: string }
type Pickup = { id: string; status: string; reason: string | null; note: string | null }
type LiveRoute = { id: string }

/** Where the driver's phone stands, so every located command says it stood there. */
const POSITION = { latitude: 55.6867, longitude: 12.5701, accuracy: 12 }

const labels = async (api: Parameters<typeof listAll>[0]) => new Map((await listAll<Container>(api, "/containers")).map((container) => [container.id, container.label]))

test("a generated route is the API's row: listed under its label, opened under the server's id, its stops in their sequence", async ({ api, page }) => {
  const { scheme, routes } = await schemeWithRoutes(api, uniqueName("E2E Routes"))
  const [route] = routes
  const [detail, label] = await Promise.all([routeRead(api, route.id), labels(api)])

  const listed = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/waste-api/routes")
  await page.goto("/route-studio?module=routes")
  expect((await listed).status()).toBe(200)
  // Generation writes a route: the Pilot offers no create.
  await expect(page.getByRole("button", { name: "Create route" })).toHaveCount(0)
  await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill(route.label)
  await page.getByRole("main").getByText(route.label, { exact: true }).first().click()
  await expect(page).toHaveURL(new RegExp(`record=route-${route.id}`))

  const details = page.getByRole("dialog", { name: route.label })
  await expect(details).toContainText(scheme.name)
  await expect(details).toContainText("Indre By Operations")
  await expect(details).toContainText("06:30")
  const stops = details.getByTestId("route-stops").locator("li")
  await expect(stops).toHaveCount(detail.pickups.length)
  await expect(stops.first()).toContainText(`1. ${label.get(detail.pickups[0].containerId)} · Planned`)
  await expect(details.getByTestId("route-sessions")).toHaveCount(0)
  await expect(details).toContainText("Not started: no driver has started this route.")

  // The scheme's page lists its routes, the API's, once read; a row opens the same details.
  await page.goto(`/route-studio?module=schemes&record=scheme-${scheme.id}`)
  await page.getByRole("tab", { name: "Routes" }).click()
  await page.getByRole("button", { name: `Open ${route.label}` }).click()
  await expect(page).toHaveURL(new RegExp(`module=routes&record=route-${route.id}`))
  await expect(page.getByRole("dialog", { name: route.label })).toBeVisible()
})

test("the dispatcher's commands: an unassigned dispatch is the API's 409, assign names the driver and the vehicle, reschedule moves the start, dispatch makes it Ready, and cancel's reason is its deviation", async ({ api, page }) => {
  const { routes } = await schemeWithRoutes(api, uniqueName("E2E Dispatch"))
  const [route] = routes
  const driver = await driverNamed(api, SEEDED_DRIVER.name)
  const vehicle = (await listAll<{ id: string; callsign: string | null }>(api, "/vehicles")).find((row) => row.callsign === "WH-24")
  const details = await openRoute(page, route)
  const commands = details.getByTestId("route-commands")

  const [refused] = await Promise.all([answerOf(page, "POST", `/routes/${route.id}/dispatch`), commands.getByRole("button", { name: "Dispatch" }).click()])
  expect(refused.status()).toBe(409)
  await expect(toasts(page)).toContainText(`${route.label} was not dispatched`)
  await expect(toasts(page)).toContainText(`Route ${route.label} has no planned driver; assign one first`)

  await commands.getByRole("button", { name: "Assign" }).click()
  const assign = page.getByRole("dialog", { name: "Assign" })
  await pick(assign, page, "Vehicle", "WH-24 · CN 42 018 · Active")
  await pick(assign, page, "Driver", "Mads Jensen · Active")
  const [assigned] = await Promise.all([answerOf(page, "POST", `/routes/${route.id}/assign`), assign.getByRole("button", { name: "Assign" }).click()])
  expect(assigned.status()).toBe(200)
  expect(assigned.request().postDataJSON()).toEqual({ vehicleId: vehicle?.id, driverId: driver.id })
  await expect(assign).toBeHidden()
  await expect(details).toContainText("Mads Jensen")

  await commands.getByRole("button", { name: "Reschedule" }).click()
  const reschedule = page.getByRole("dialog", { name: "Reschedule" })
  await expect(reschedule.getByRole("textbox", { name: /^Operating date/ })).toHaveValue(route.operatingDate)
  await reschedule.getByRole("textbox", { name: /^Planned start/ }).fill("07:15")
  const [moved] = await Promise.all([answerOf(page, "POST", `/routes/${route.id}/reschedule`), reschedule.getByRole("button", { name: "Reschedule" }).click()])
  expect(moved.status()).toBe(200)
  expect(moved.request().postDataJSON()).toEqual({ plannedStartTime: "07:15" })
  await expect(details).toContainText("07:15")

  const [dispatched] = await Promise.all([answerOf(page, "POST", `/routes/${route.id}/dispatch`), commands.getByRole("button", { name: "Dispatch" }).click()])
  expect(dispatched.status()).toBe(200)
  await expect(toasts(page)).toContainText(`${route.label} dispatched`)
  await expect(details).toContainText("Dispatched at")

  await commands.getByRole("button", { name: "Cancel route" }).click()
  const cancel = page.getByRole("dialog", { name: "Cancel route" })
  const reason = uniqueName("Road closed")
  await cancel.getByRole("textbox", { name: /^Reason/ }).fill(reason)
  const [cancelled] = await Promise.all([answerOf(page, "POST", `/routes/${route.id}/cancel`), cancel.getByRole("button", { name: "Cancel route" }).click()])
  expect(cancelled.status()).toBe(200)
  expect(cancelled.request().postDataJSON()).toEqual({ reason })
  await expect(details).toContainText(reason)
  await expect(details.getByTestId("route-stops")).toContainText("Skipped · Route cancelled")

  const read = await routeRead(api, route.id)
  expect({ status: read.status, note: read.note, plannedStartTime: read.plannedStartTime, driverId: read.planned.driverId, vehicleId: read.planned.vehicleId }).toEqual({
    status: "cancelled",
    note: reason,
    plannedStartTime: "07:15",
    driverId: driver.id,
    vehicleId: vehicle?.id,
  })
  expect(read.pickups.every((pickup) => pickup.status === "skipped")).toBe(true)
})

test("reorder stops: the open stops are PUT whole in their new order, which the route then reads as its manual Plan", async ({ api, page }) => {
  const { routes } = await schemeWithRoutes(api, uniqueName("E2E Reorder"))
  const route = routes.find((candidate) => candidate.progress.total >= 2)
  if (route === undefined) throw new Error("the run's scheme generated no route of two stops")
  const [before, label] = await Promise.all([routeRead(api, route.id), labels(api)])
  const [first, second, ...rest] = before.pickups
  const reordered = [second.id, first.id, ...rest.map((pickup) => pickup.id)]

  const details = await openRoute(page, route)
  await details.getByTestId("route-commands").getByRole("button", { name: "Reorder stops" }).click()
  const dialog = page.getByRole("dialog", { name: "Reorder stops" })
  await dialog.getByRole("button", { name: `Move ${label.get(second.containerId)} up` }).click()
  const [put] = await Promise.all([answerOf(page, "PUT", `/routes/${route.id}/pickup-order`), dialog.getByRole("button", { name: "Save order" }).click()])
  expect(put.status()).toBe(200)
  expect(put.request().postDataJSON()).toEqual({ pickupIds: reordered })
  await expect(dialog).toBeHidden()
  await expect(details.getByTestId("route-stops").locator("li").first()).toContainText(`1. ${label.get(second.containerId)}`)

  const after = await routeRead(api, route.id)
  expect(after.activePlan?.solver).toBe("manual")
  expect(after.pickups.map((pickup) => pickup.id)).toEqual(reordered)
})

test("a stop's details: a correction on a route that has not run is the API's 409, and remove takes the stop off, skipped by the dispatcher", async ({ api, page }) => {
  const { routes } = await schemeWithRoutes(api, uniqueName("E2E Stops"))
  const [route] = routes
  const { pickups } = await routeRead(api, route.id)
  const stop = pickups[0]

  const details = await openRoute(page, route)
  await details.getByTestId("route-stops").getByRole("button", { name: "Open stop" }).first().click()
  await expect(page).toHaveURL(new RegExp(`module=pickups&record=pickup-${stop.id}`))
  const stopDetails = page.getByRole("dialog", { name: /^Stop 1 · / })
  const commands = stopDetails.getByTestId("pickup-commands")
  await expect(commands.getByRole("button", { name: "Remove stop" })).toBeEnabled({ timeout: 30_000 })

  await commands.getByRole("button", { name: "Correct outcome" }).click()
  const correct = page.getByRole("dialog", { name: "Correct outcome" })
  await pick(correct, page, "Outcome", "Failed")
  await pick(correct, page, "Reason", "Inaccessible")
  await correct.getByRole("textbox", { name: /^Why it is corrected/ }).fill("Gate locked")
  const [refused] = await Promise.all([answerOf(page, "POST", `/pickups/${stop.id}/correct-outcome`), correct.getByRole("button", { name: "Correct outcome" }).click()])
  expect(refused.status()).toBe(409)
  expect(refused.request().postDataJSON()).toEqual({ outcome: "failed", reason: "inaccessible", note: "Gate locked" })
  await expect(toasts(page)).toContainText(`Route ${route.label} has not run`)
  await expect(correct).toBeVisible()
  await correct.getByRole("button", { name: "Cancel" }).click()

  await commands.getByRole("button", { name: "Remove stop" }).click()
  const remove = page.getByRole("dialog", { name: "Remove stop" })
  const reason = uniqueName("Blocked by roadworks")
  await remove.getByRole("textbox", { name: /^Reason/ }).fill(reason)
  const [removed] = await Promise.all([answerOf(page, "POST", `/pickups/${stop.id}/remove`), remove.getByRole("button", { name: "Remove stop" }).click()])
  expect(removed.status()).toBe(200)
  expect(removed.request().postDataJSON()).toEqual({ reason })
  await expect(stopDetails).toContainText("Removed by dispatcher")
  await expect(stopDetails).toContainText(reason)
  const read = (await (await api.get(`/pickups/${stop.id}`)).json()) as Pickup
  expect({ status: read.status, reason: read.reason, note: read.note }).toEqual({ status: "skipped", reason: "removed-by-dispatcher", note: reason })
})

test("the Live board reads what the driver's device reports, and the office's cancel ends the driver's session", async ({ api, browser, page }) => {
  test.setTimeout(180_000)
  const { route } = await dispatchedRouteFor(api)
  const stops = [...route.pickups].sort((a, b) => (a.sequence ?? a.position) - (b.sequence ?? b.position))

  // The driver starts the route on the planned vehicle and completes its first stop, where the phone stands.
  const phone = await freshContext(browser, { viewport: { width: 390, height: 844 }, geolocation: POSITION, permissions: ["geolocation"] })
  try {
    const driverPage = await phone.newPage()
    await signIn(driverPage, SEEDED_DRIVER.email, E2E.loginPassword)
    const card = driverPage.getByRole("article", { name: `Route ${route.label}` })
    await card.getByRole("button", { name: "Start route" }).click()
    await expect(card.getByText("Active", { exact: true })).toBeVisible()
    await card.getByRole("link", { name: "Open route" }).click()
    const stop = driverPage.getByRole("article", { name: "Stop 1", exact: true })
    await stop.getByRole("button", { name: "Complete" }).click()
    await expect(stop.getByText("Completed", { exact: true })).toBeVisible()
    await expect(driverPage.getByText("Sending")).toHaveCount(0)
  } finally {
    await phone.close()
  }

  // What the device did, as the API stamped it: the session's start on the project's clock is what the board shows.
  const started = onCopenhagenClock((await routeRead(api, route.id)).session?.startedAt ?? "")
  const read = page.waitForResponse((response) => new URL(response.url()).pathname === "/waste-api/routes/live")
  await page.goto("/route-studio?module=live")
  expect((await read).status()).toBe(200)
  const row = page.getByRole("main").getByRole("button", { name: `Open ${route.label}` })
  await expect(row).toContainText("Active")
  await expect(row).toContainText(`1/${stops.length} stops`)
  await expect(row).toContainText("Mads Jensen · WH-24")
  await row.click()
  const live = page.getByRole("dialog", { name: route.label })
  await expect(live).toContainText(`${POSITION.latitude.toFixed(5)}, ${POSITION.longitude.toFixed(5)}`)
  await expect(live).toContainText(started)
  await expect(live.getByTestId("live-sessions").locator("li")).toHaveCount(1)
  await expect(live.getByTestId("live-sessions")).toContainText(`${started} → open · Mads Jensen · WH-24`)

  // The live row is its route: the office reads the device's log there, and its cancel ends the session.
  await live.getByRole("button", { name: "Open route" }).click()
  await expect(page).toHaveURL(new RegExp(`module=routes&record=route-${route.id}`))
  const details = page.getByRole("dialog", { name: route.label })
  const log = details.getByTestId("route-command-log")
  await expect(log).toContainText("Start route · Applied")
  await expect(log).toContainText("Complete pickup · Applied")
  await details.getByTestId("route-commands").getByRole("button", { name: "Cancel route" }).click()
  const cancel = page.getByRole("dialog", { name: "Cancel route" })
  await cancel.getByRole("textbox", { name: /^Reason/ }).fill("Vehicle breakdown on the way to the second stop")
  const [cancelled] = await Promise.all([answerOf(page, "POST", `/routes/${route.id}/cancel`), cancel.getByRole("button", { name: "Cancel route" }).click()])
  expect(cancelled.status()).toBe(200)

  const ended = await routeRead(api, route.id)
  expect(ended.status).toBe("cancelled")
  expect(ended.session).toBeNull()
  // The one session the driver opened, ended at the cancel's own instant.
  expect(ended.sessions.map((session) => session.endedAt)).toEqual([ended.cancelledAt])
  expect((await listAll<LiveRoute>(api, "/routes/live", { projectId: route.projectId })).some((candidate) => candidate.id === route.id)).toBe(false)
})

test("a Dispatcher, who views neither the organisation nor the depots, sees the routes of their project and assigns one (#217)", async ({ api, browser }) => {
  const { routes } = await schemeWithRoutes(api, uniqueName("E2E Dispatcher"))
  const [route] = routes
  const { user } = await ensureTester(api, E2E.testerEmail)
  const dispatcher = await roleNamed(api, "Dispatcher")
  const moved = await api.patch(`/users/${user.id}`, { data: { roleId: dispatcher.id } })
  expect(moved.status(), await moved.text()).toBe(200)
  const driver = await driverNamed(api, SEEDED_DRIVER.name)
  const context = await freshContext(browser)
  try {
    const page = await context.newPage()
    await signIn(page, E2E.testerEmail, E2E.loginPassword)
    const listed = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/waste-api/routes")
    await page.goto("/route-studio?module=routes")
    expect((await listed).status()).toBe(200)
    // The rows name their project through /me's projects, so the pinned scope keeps them.
    await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill(route.label)
    await page.getByRole("main").getByText(route.label, { exact: true }).first().click()
    const details = page.getByRole("dialog", { name: route.label })
    await expect(details).toContainText("Copenhagen Central")
    // The depots are not the Dispatcher's to view: Assign does not wait for them.
    const assign = details.getByTestId("route-commands").getByRole("button", { name: "Assign" })
    await expect(assign).toBeEnabled({ timeout: 30_000 })
    await assign.click()
    const dialog = page.getByRole("dialog", { name: "Assign" })
    await pick(dialog, page, "Driver", "Mads Jensen · Active")
    const [assigned] = await Promise.all([answerOf(page, "POST", `/routes/${route.id}/assign`), dialog.getByRole("button", { name: "Assign" }).click()])
    expect(assigned.status()).toBe(200)
    expect(assigned.request().postDataJSON()).toEqual({ driverId: driver.id })
  } finally {
    await context.close()
    // Back to the tester's own shape, which the other specs stand on.
    await ensureTester(api, E2E.testerEmail)
  }
})
