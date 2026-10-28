import type { APIRequestContext } from "@playwright/test"

import { addDays, dayIn, driverNamed, generate, SEEDED_DRIVER } from "./dispatched-route"
import { uniqueName } from "./env"
import { chainLanded, expect, test } from "./fixtures"
import { answerOf, createScheme, openRoute, pick, routeRead, schemeWithRoutes, toasts, type ApiRoute } from "./routes-support"
import { listAll, projectNamed } from "./tester"

// The dispatch day's tooling on the API (O5 of #290). Dispatch day beside
// New route sends a project's planned routes of a day, or the ones left
// ticked, in one request, and says what became of each: a route with a
// planned driver is dispatched, one without is refused in its own dispatch's
// words, one left unticked stays planned. A route's details ask the
// optimiser for a Plan, read its distance and duration once the worker has
// measured it, and list its Plans with the active one marked. Reschedule onto
// a day the project rests on is refused in the domain's sentence until the
// dialog says it is meant; Assign names the service provider; Cancel gives a
// reason code beside the free reason. Every body is the one the contracts
// take, read off the browser's own request; the schemes are made for the
// run, uniquely named and never cleaned up.

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const

const weekdayOf = (day: string) => WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]

/** A working weekday ten weeks out, past every other spec's window: a day whose planned routes are this run's alone. */
function farWeekday(): string {
  let day = addDays(dayIn("Europe/Copenhagen"), 70)
  while (weekdayOf(day) === "saturday" || weekdayOf(day) === "sunday") day = addDays(day, 1)
  return day
}

/** The next Saturday after a day. */
function saturdayAfter(day: string): string {
  let next = addDays(day, 1)
  while (weekdayOf(next) !== "saturday") next = addDays(next, 1)
  return next
}

/** A scheme made for the run that runs on `day` alone, and the one route its generation over that day wrote. */
async function routeOfDay(api: APIRequestContext, name: string, day: string): Promise<ApiRoute> {
  const scheme = await createScheme(api, name, { serviceDays: [weekdayOf(day)], validFrom: day })
  await generate(api, scheme.id, { from: day, to: day })
  const [route, ...more] = await listAll<ApiRoute>(api, "/routes", { routeSchemeId: scheme.id })
  expect(more, `${name} generated one route`).toHaveLength(0)
  expect(route?.status).toBe("planned")
  return route
}

test("Dispatch day sends a project's planned routes of a day, the ones left ticked, in one request: each dispatched, or refused in its own dispatch's words", async ({ api, page }) => {
  test.setTimeout(180_000)
  const day = farWeekday()
  const [project, driver] = await Promise.all([projectNamed(api, "Copenhagen Central"), driverNamed(api, SEEDED_DRIVER.name)])
  const crewed = await routeOfDay(api, uniqueName("E2E Dispatch day crewed"), day)
  const uncrewed = await routeOfDay(api, uniqueName("E2E Dispatch day uncrewed"), day)
  const leftOut = await routeOfDay(api, uniqueName("E2E Dispatch day left out"), day)
  for (const route of [crewed, leftOut]) {
    const assigned = await api.post(`/routes/${route.id}/assign`, { data: { driverId: driver.id, acceptSameDay: true } })
    expect(assigned.status(), await assigned.text()).toBe(200)
  }

  const listed = answerOf(page, "GET", "/routes")
  await page.goto("/route-studio?module=routes")
  expect((await listed).status()).toBe(200)
  await chainLanded(page)
  const open = page.getByRole("button", { name: "Dispatch day" })
  await expect(open).toBeEnabled({ timeout: 30_000 })
  await open.click()
  const form = page.getByRole("dialog", { name: "Dispatch day" })
  await pick(form, page, "Project", project.name)
  await form.getByRole("textbox", { name: /^Operating date/ }).fill(day)
  await form.getByRole("button", { name: "Show the routes" }).click()

  // The day's planned routes, each ticked: this run's three — and, on a developer's stack, anything else planned that day, left out here.
  const dialog = page.getByTestId("dispatch-day")
  const routesOfDay = dialog.getByTestId("dispatch-day-routes")
  for (const route of [crewed, uncrewed, leftOut]) await expect(routesOfDay.getByRole("checkbox", { name: new RegExp(`^${route.label} `) })).toBeChecked()
  await expect(routesOfDay).toContainText(`${uncrewed.label} · No planned driver`)
  const ours = new Set([crewed.label, uncrewed.label])
  for (const label of (await routesOfDay.locator("li").allTextContents()).map((text) => text.split(" · ")[0])) {
    if (!ours.has(label)) await routesOfDay.getByRole("checkbox", { name: new RegExp(`^${label} `) }).click()
  }
  await expect(routesOfDay.getByRole("checkbox", { name: new RegExp(`^${leftOut.label} `) })).not.toBeChecked()

  const [sent] = await Promise.all([answerOf(page, "POST", "/routes/dispatch"), dialog.getByRole("button", { name: "Dispatch 2 routes" }).click()])
  expect(sent.status(), await sent.text()).toBe(200)
  expect(new Set((sent.request().postDataJSON() as { routeIds: string[] }).routeIds)).toEqual(new Set([crewed.id, uncrewed.id]))
  const results = dialog.getByTestId("dispatch-day-results")
  await expect(results).toContainText(`${crewed.label} · Dispatched`)
  await expect(results).toContainText(`${uncrewed.label} · Not dispatched: Route ${uncrewed.label} has no planned driver; assign one first`)
  await expect(toasts(page)).toContainText("1 of 2 routes dispatched")

  const [dispatched, refused, untouched] = await Promise.all([crewed, uncrewed, leftOut].map((route) => routeRead(api, route.id)))
  expect([dispatched.status, refused.status, untouched.status]).toEqual(["ready", "planned", "planned"])
})

test("Optimise from a route's details asks for a Plan; once the worker has measured it, the route says its distance and duration, and its Plans mark the active one", async ({ api, page }) => {
  test.setTimeout(150_000)
  const { routes } = await schemeWithRoutes(api, uniqueName("E2E Optimise"), 7, { depot: "Nordhavn Depot" })
  const route = routes.find((candidate) => candidate.progress.total >= 2) ?? routes[0]
  const details = await openRoute(page, route)
  const optimise = details.getByTestId("route-commands").getByRole("button", { name: "Optimise" })
  await expect(optimise).toBeEnabled({ timeout: 30_000 })
  const [asked] = await Promise.all([answerOf(page, "POST", `/routes/${route.id}/optimise`), optimise.click()])
  // 202 for a Plan this request made, 200 for the identical one generation already asked for.
  expect([200, 202], await asked.text()).toContain(asked.status())
  const answer = (await asked.json()) as { id: string; solver: string; fallback: string | null }
  expect([answer.solver, answer.fallback]).toEqual(["optimiser", null])
  await expect(toasts(page)).toContainText(`A Plan was asked for ${route.label}`)
  await expect(details.getByTestId("route-plans")).toContainText("Optimised")

  // The fake provider answers on the worker: the route's active Plan is the optimiser's, measured.
  await expect.poll(async () => (await routeRead(api, route.id)).activePlan?.status, { timeout: 60_000 }).toBe("ready")
  expect((await routeRead(api, route.id)).activePlan?.solver).toBe("optimiser")

  // Read again, the details carry the measure and the history marks the Plan the route runs by.
  const again = await openRoute(page, route)
  await expect(again).toContainText(/Distance\d[\d,.]* k?m/)
  await expect(again).toContainText(/Duration\d+ (min|h \d{2} min)/)
  await expect(again.getByTestId("route-plans")).toContainText(/Optimised · Ready · .* · Active/)
  await page.goto("/route-studio?module=routes")
  await expect(page.getByRole("main").getByRole("columnheader", { name: "Distance", exact: true })).toBeVisible()
})

test("a reschedule onto the project's weekend is refused in the domain's sentence until the dialog says it is meant; Assign names the service provider; Cancel gives a reason code beside its reason", async ({ api, page }) => {
  test.setTimeout(150_000)
  const { routes } = await schemeWithRoutes(api, uniqueName("E2E Calendar"), 7)
  const [route] = routes
  const saturday = saturdayAfter(route.operatingDate)
  const provider = (await listAll<{ id: string; legalName: string }>(api, "/service-providers")).find((row) => row.legalName === "NordRen ApS")
  expect(provider, "the seed holds NordRen ApS").toBeTruthy()
  const details = await openRoute(page, route)
  const commands = details.getByTestId("route-commands")

  await commands.getByRole("button", { name: "Reschedule" }).click()
  const reschedule = page.getByRole("dialog", { name: "Reschedule" })
  await reschedule.getByRole("textbox", { name: /^Operating date/ }).fill(saturday)
  const [refused] = await Promise.all([answerOf(page, "POST", `/routes/${route.id}/reschedule`), reschedule.getByRole("button", { name: "Reschedule" }).click()])
  expect(refused.status()).toBe(409)
  expect(refused.request().postDataJSON()).toEqual({ operatingDate: saturday })
  await expect(toasts(page)).toContainText(`is a Saturday of the project's weekend; confirm the move to run route ${route.label} on a non-working day`)
  await expect(reschedule).toBeVisible()
  await reschedule.getByRole("checkbox", { name: /^Run it on a non-working day/ }).check()
  const [moved] = await Promise.all([answerOf(page, "POST", `/routes/${route.id}/reschedule`), reschedule.getByRole("button", { name: "Reschedule" }).click()])
  expect(moved.status(), await moved.text()).toBe(200)
  expect(moved.request().postDataJSON()).toEqual({ operatingDate: saturday, acceptNonWorkingDay: true })
  await expect(reschedule).toBeHidden()
  await expect(details).toContainText(`Operating date${saturday}`)

  await commands.getByRole("button", { name: "Assign" }).click()
  const assign = page.getByRole("dialog", { name: "Assign" })
  await pick(assign, page, "Service provider", "NordRen ApS")
  const [assigned] = await Promise.all([answerOf(page, "POST", `/routes/${route.id}/assign`), assign.getByRole("button", { name: "Assign" }).click()])
  expect(assigned.status(), await assigned.text()).toBe(200)
  expect(assigned.request().postDataJSON()).toEqual({ serviceProviderId: provider?.id })
  await expect(details).toContainText("Service providerNordRen ApS")

  await commands.getByRole("button", { name: "Cancel route" }).click()
  const cancel = page.getByRole("dialog", { name: "Cancel route" })
  const reason = uniqueName("Storm warning")
  await pick(cancel, page, "Why", "Weather")
  await cancel.getByRole("textbox", { name: /^Reason/ }).fill(reason)
  const [cancelled] = await Promise.all([answerOf(page, "POST", `/routes/${route.id}/cancel`), cancel.getByRole("button", { name: "Cancel route" }).click()])
  expect(cancelled.status(), await cancelled.text()).toBe(200)
  expect(cancelled.request().postDataJSON()).toEqual({ reasonCode: "weather", reason })
  await expect(details).toContainText("Cancel reasonWeather")

  const read = (await routeRead(api, route.id)) as Awaited<ReturnType<typeof routeRead>> & { cancelReasonCode: string | null; planned: { serviceProviderId: string | null } }
  expect({ operatingDate: read.operatingDate, provider: read.planned.serviceProviderId, status: read.status, code: read.cancelReasonCode, note: read.note }).toEqual({ operatingDate: saturday, provider: provider?.id, status: "cancelled", code: "weather", note: reason })
})
