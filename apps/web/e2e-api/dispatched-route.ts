// A route dispatched to a driver for today, reached the way the office
// reaches one and through the API alone (Issue #145): there is no manual
// route create in the pilot, so the helper triggers generation on a seeded
// scheme (`POST /route-schemes/:id/generate`, which the worker runs), takes a
// planned route of today's out of the run, and moves it with the office's
// route commands — assign the driver, reschedule it onto today where the day
// has none (a weekend, a holiday, or a developer stack whose earlier runs
// used today's up), dispatch. The Driver App's flow (driver-app.spec.ts)
// reads it; the office's Routes module (#179) and the e2e lane's generation
// scenario are meant to as well, so it names nothing of the Driver App.
//
// On the seeded tenant `RS-Central · Week A` runs every weekday in
// Copenhagen Central with WH-24 and Mads Jensen (packages/db/src/seed/
// planning.ts), whose Login every local plan holds; generation writes its
// routes `planned` with both. Idempotent over a developer stack that
// outlives a run, as ensureTester is (tester.ts): a route of the driver's
// left `active` by a run that stopped midway is cancelled by the office
// first, since a driver holds one open session at a time and the next start
// would be refused; CI's database is new every run, so there it finds none.
import type { APIRequestContext } from "@playwright/test"

import { expect } from "./fixtures"
import { listAll } from "./tester"

/** The seeded scheme and driver the Driver App is demonstrated on (#143). */
export const DRIVER_SCHEME = "RS-Central · Week A"
export const SEEDED_DRIVER = { name: "Mads Jensen", email: "mads.jensen@kystbyen.example" } as const

export type RouteScheme = { id: string; name: string; projectId: string; status: string }
export type Driver = { id: string; name: string; status: string }
export type Pickup = { id: string; position: number; sequence?: number; status: string }
export type Route = {
  id: string
  label: string
  number: number
  status: string
  projectId: string
  operatingDate: string
  serviceDate: string
  planned: { driverId: string | null; vehicleId: string | null; trailerId: string | null }
}
export type RouteDetail = Route & { pickups: Pickup[] }
export type GenerationRun = { id: string; status: string; routesCreated: number; routesRefreshed: number; error: string | null }

/** How far ahead the helper generates: four weeks is twenty weekday routes, room for a developer stack's reruns. */
const WINDOW_DAYS = 28

/** The calendar day it is now in a timezone, `YYYY-MM-DD`. */
export function dayIn(timezone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

export async function schemeNamed(api: APIRequestContext, name: string): Promise<RouteScheme> {
  const scheme = (await listAll<RouteScheme>(api, "/route-schemes")).find((candidate) => candidate.name === name)
  if (scheme === undefined) throw new Error(`the seed holds no route scheme named ${name}`)
  return scheme
}

export async function driverNamed(api: APIRequestContext, name: string): Promise<Driver> {
  const driver = (await listAll<Driver>(api, "/drivers")).find((candidate) => candidate.name === name)
  if (driver === undefined) throw new Error(`the seed holds no driver named ${name}`)
  return driver
}

/** Generates a scheme over a window and waits for the worker to finish the run; a run already in flight for the scheme is waited on instead. */
export async function generate(api: APIRequestContext, schemeId: string, window: { from: string; to: string }): Promise<GenerationRun> {
  const started = await api.post(`/route-schemes/${schemeId}/generate`, { data: window })
  expect([200, 202], `POST /route-schemes/${schemeId}/generate: ${await started.text()}`).toContain(started.status())
  const { id } = (await started.json()) as GenerationRun
  let run: GenerationRun | undefined
  await expect
    .poll(
      async () => {
        run = (await listAll<GenerationRun>(api, `/route-schemes/${schemeId}/generation-runs`)).find((candidate) => candidate.id === id)
        return run?.status
      },
      { message: `generation run ${id} of scheme ${schemeId}`, timeout: 60_000 },
    )
    .toMatch(/^(succeeded|failed)$/)
  expect(run?.error ?? null, `generation run ${id}`).toBeNull()
  expect(run?.status).toBe("succeeded")
  return run as GenerationRun
}

async function command(api: APIRequestContext, path: string, data?: unknown): Promise<RouteDetail> {
  const response = await api.post(path, data === undefined ? {} : { data })
  expect(response.status(), `POST ${path}: ${await response.text()}`).toBe(200)
  return (await response.json()) as RouteDetail
}

/**
 * A route of the scheme, dispatched to the driver on today's operating date
 * in the scheme's project, as the office's commands leave it — `ready`, its
 * Planned Assignment the driver and the vehicle generation gave it — read
 * back with its pickups.
 */
export async function dispatchedRouteFor(api: APIRequestContext, { schemeName = DRIVER_SCHEME, driverName = SEEDED_DRIVER.name }: { schemeName?: string; driverName?: string } = {}): Promise<{ route: RouteDetail; scheme: RouteScheme; driver: Driver; today: string }> {
  const [scheme, driver] = await Promise.all([schemeNamed(api, schemeName), driverNamed(api, driverName)])
  const projectResponse = await api.get(`/projects/${scheme.projectId}`)
  expect(projectResponse.status(), `GET /projects/${scheme.projectId}`).toBe(200)
  const { timezone } = (await projectResponse.json()) as { timezone: string }
  const today = dayIn(timezone)
  const window = { from: today, to: addDays(today, WINDOW_DAYS - 1) }

  // A run that stopped midway left the driver on a route; the office ends that before handing them another.
  for (const stale of await listAll<Route>(api, "/routes", { plannedDriverId: driver.id, status: "active" })) {
    await command(api, `/routes/${stale.id}/cancel`, { reason: "Left active by an interrupted end-to-end run" })
  }

  await generate(api, scheme.id, window)
  const planned = (await listAll<Route>(api, "/routes", { routeSchemeId: scheme.id, from: window.from, to: window.to, status: "planned" })).sort((a, b) => a.operatingDate.localeCompare(b.operatingDate) || a.number - b.number)
  const chosen = planned.find((candidate) => candidate.operatingDate === today) ?? planned[0]
  if (chosen === undefined) throw new Error(`${schemeName} has no planned route left between ${window.from} and ${window.to}: earlier runs dispatched them all; reset the stack`)

  await command(api, `/routes/${chosen.id}/assign`, { driverId: driver.id })
  if (chosen.operatingDate !== today) await command(api, `/routes/${chosen.id}/reschedule`, { operatingDate: today })
  const route = await command(api, `/routes/${chosen.id}/dispatch`)
  expect(route.status).toBe("ready")
  expect(route.operatingDate).toBe(today)
  return { route, scheme, driver, today }
}
