// The routes the office's specs move (Issue #179): generated from a Route
// Scheme made for the run through the API — uniquely named and never cleaned
// up — so a spec moves routes of its own and never one the Driver App's flow
// (dispatched-route.ts) or another run stands on. The scheme is validated
// with one rule group, Residual inside Indre By Operations on weekdays, in
// force from tomorrow on Copenhagen's clock, and names neither a vehicle nor
// a driver: a route it generates is planned and unassigned, with the seeded
// containers the rule matches as its stops.
import type { APIRequestContext, Locator, Page } from "@playwright/test"

import { addDays, dayIn, generate, type Pickup, type Route } from "./dispatched-route"
import { chainLanded, expect } from "./fixtures"
import { listAll, projectNamed } from "./tester"

type Named = { id: string; name: string }

/** A route and a stop as these specs read them: dispatched-route.ts's shapes, with what the office's surfaces show. */
export type ApiPickup = Pickup & { containerId: string; reason: string | null; note: string | null }
export type ApiRoute = Route & { routeSchemeId: string; note: string | null; plannedStartTime: string | null; cancelledAt: string | null; progress: { planned: number; total: number } }
export type ApiRouteDetail = ApiRoute & { pickups: ApiPickup[]; activePlan: { solver: string } | null; session: { startedAt: string } | null; sessions: { startedAt: string; endedAt: string | null }[] }

/** An instant on Copenhagen's clock as the office's surfaces show it: "2026-10-01 06:31". */
export const onCopenhagenClock = (instant: string) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(instant))
export type Scheme = { id: string; name: string; projectId: string; editPolicy: string; plannedStartTime: string | null; status: string }

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"] as const

/** A validated scheme made through the API for the run, uniquely named and never cleaned up: one rule group, Residual inside Indre By Operations, on `serviceDays` from `validFrom`. */
export async function createScheme(api: APIRequestContext, name: string, { serviceDays, validFrom }: { serviceDays: readonly string[]; validFrom: string }): Promise<Scheme> {
  const project = await projectNamed(api, "Copenhagen Central")
  const area = (await listAll<Named>(api, "/planning-areas")).find((row) => row.name === "Indre By Operations")
  const residual = (await listAll<Named>(api, "/waste-fractions")).find((row) => row.name === "Residual")
  expect(area && residual, "the seed holds Indre By Operations and Residual").toBeTruthy()
  const created = await api.post("/route-schemes", {
    data: {
      projectId: project.id,
      name,
      planningAreaId: area?.id,
      serviceType: "container-collection",
      frequency: "weekly",
      serviceDays,
      plannedStartTime: "06:30",
      status: "validated",
      validFrom,
      collectionGroups: [{ name, days: serviceDays, stopSource: "rule", rule: { wasteFractionIds: [residual?.id], containerTypeIds: [], vehicleTypeId: null } }],
    },
  })
  expect(created.status(), await created.text()).toBe(201)
  return (await created.json()) as Scheme
}

/** A scheme made for the run and its routes, generated over `days` from tomorrow, in the order they run: every one planned, unassigned, the scheme's own. */
export async function schemeWithRoutes(api: APIRequestContext, name: string, days = 14): Promise<{ scheme: Scheme; routes: ApiRoute[] }> {
  const from = addDays(dayIn("Europe/Copenhagen"), 1)
  const scheme = await createScheme(api, name, { serviceDays: WEEKDAYS, validFrom: from })
  await generate(api, scheme.id, { from, to: addDays(from, days - 1) })
  const routes = (await listAll<ApiRoute>(api, "/routes", { routeSchemeId: scheme.id })).sort((a, b) => a.operatingDate.localeCompare(b.operatingDate) || a.number - b.number)
  expect(routes.length, `${name} generated routes`).toBeGreaterThan(0)
  expect(routes.map((route) => [route.status, route.routeSchemeId, route.planned.driverId])).toEqual(routes.map(() => ["planned", scheme.id, null]))
  return { scheme, routes }
}

/** Picks `option` in the select whose label starts with `label`. */
export async function pick(within: Locator, page: Page, label: string, option: string) {
  await within.getByRole("combobox", { name: new RegExp(`^${label}`) }).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

/** Opens a scheme's page from Route Studio's list once every switched module's rows have landed (a scheme's question counts the routes, read after the schemes), narrowed to its name first: a developer's stack accumulates schemes across runs. */
export async function openScheme(page: Page, name: string) {
  const loaded = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/waste-api/route-schemes")
  await page.goto("/route-studio?module=schemes")
  expect((await loaded).status()).toBe(200)
  await chainLanded(page)
  await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill(name)
  await page.getByRole("button", { name: `Open ${name}` }).click()
  await expect(page.getByRole("tab", { name: "Details" })).toBeVisible()
}

/** The scheme page's Edit scheme dialog, from its Actions menu. */
export async function openEdit(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Edit scheme" }).click()
  const dialog = page.getByRole("dialog", { name: "Edit route scheme" })
  await expect(dialog).toBeVisible()
  return dialog
}

/** A route as its own read gives it: its pickups in sequence. */
export async function routeRead(api: APIRequestContext, id: string): Promise<ApiRouteDetail> {
  const response = await api.get(`/routes/${id}`)
  expect(response.status(), `GET /routes/${id}`).toBe(200)
  return (await response.json()) as ApiRouteDetail
}

/** The browser's API call a click makes: the answer of `method` on `path`. */
export const answerOf = (page: Page, method: string, path: string) =>
  page.waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname === `/waste-api${path}`)

export const toasts = (page: Page) => page.getByRole("region", { name: "Notifications alt+T" })

/** The route's details on the Pilot: the generic details with the route's commands, once the routes module reads the API. */
export async function openRoute(page: Page, route: Pick<Route, "id" | "label">) {
  await page.goto(`/route-studio?module=routes&record=route-${route.id}`)
  const details = page.getByRole("dialog", { name: route.label })
  await expect(details.getByTestId("route-commands").getByRole("button", { name: "Dispatch" })).toBeEnabled({ timeout: 30_000 })
  return details
}
