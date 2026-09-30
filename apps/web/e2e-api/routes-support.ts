// The routes the office's specs move (Issue #179): generated from a Route
// Scheme made for the run through the API — uniquely named and never cleaned
// up — so a spec moves routes of its own and never one the Driver App's flow
// (dispatched-route.ts) or another run stands on. The scheme is validated
// with one rule group, Residual inside Indre By Operations on weekdays, in
// force from tomorrow on Copenhagen's clock, and names neither a vehicle nor
// a driver: a route it generates is planned and unassigned, with the seeded
// containers the rule matches as its stops.
import type { APIRequestContext, Page } from "@playwright/test"

import { addDays, dayIn, generate, type Pickup, type Route } from "./dispatched-route"
import { expect } from "./fixtures"
import { listAll, projectNamed } from "./tester"

type Named = { id: string; name: string }

/** A route and a stop as these specs read them: dispatched-route.ts's shapes, with what the office's surfaces show. */
export type ApiPickup = Pickup & { containerId: string; reason: string | null; note: string | null }
export type ApiRoute = Route & { note: string | null; plannedStartTime: string | null; progress: { planned: number; total: number } }
export type ApiRouteDetail = ApiRoute & { pickups: ApiPickup[]; activePlan: { solver: string } | null; session: unknown; sessions: { endedAt: string | null }[] }
export type Scheme = { id: string; name: string; projectId: string; editPolicy: string; plannedStartTime: string | null; status: string }

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"] as const

/** A scheme made for the run and its routes, generated over `days` from tomorrow, in the order they run. */
export async function schemeWithRoutes(api: APIRequestContext, name: string, days = 14): Promise<{ scheme: Scheme; routes: ApiRoute[] }> {
  const project = await projectNamed(api, "Copenhagen Central")
  const area = (await listAll<Named>(api, "/planning-areas")).find((row) => row.name === "Indre By Operations")
  const residual = (await listAll<Named>(api, "/waste-fractions")).find((row) => row.name === "Residual")
  expect(area && residual, "the seed holds Indre By Operations and Residual").toBeTruthy()
  const from = addDays(dayIn("Europe/Copenhagen"), 1)
  const created = await api.post("/route-schemes", {
    data: {
      projectId: project.id,
      name,
      planningAreaId: area?.id,
      serviceType: "container-collection",
      frequency: "weekly",
      serviceDays: WEEKDAYS,
      plannedStartTime: "06:30",
      status: "validated",
      validFrom: from,
      collectionGroups: [{ name, days: WEEKDAYS, stopSource: "rule", rule: { wasteFractionIds: [residual?.id], containerTypeIds: [], vehicleTypeId: null } }],
    },
  })
  expect(created.status(), await created.text()).toBe(201)
  const scheme = (await created.json()) as Scheme
  await generate(api, scheme.id, { from, to: addDays(from, days - 1) })
  const routes = (await listAll<ApiRoute>(api, "/routes", { routeSchemeId: scheme.id })).sort((a, b) => a.operatingDate.localeCompare(b.operatingDate) || a.number - b.number)
  expect(routes.length, `${name} generated routes`).toBeGreaterThan(0)
  return { scheme, routes }
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
