import { readFile } from "node:fs/promises"

import type { APIRequestContext, Download, Page } from "@playwright/test"
import { ID_RANDOM_BYTES, mintId } from "@waste/domain/ids"

import { accessTokenOf, apiAs, expect, freshContext, signIn, test } from "./fixtures"
import { addDays, dispatchedRouteFor, SEEDED_DRIVER } from "./dispatched-route"
import { E2E } from "./env"
import { listAll } from "./tester"

// Insight on the API (#292, #291 slices 26–28, #290 O12). The Dashboard
// shows the seeded tenant's numbers: a route generated on a seeded scheme
// and dispatched (dispatched-route.ts) is run by the seeded driver through
// the driver door — started, its first stop collected, its second failed,
// the day ended with the rest closed — and an office unload is captured on
// it; the service and tonnage reports move by exactly that, and /performance
// shows the reports' own numbers for the route's project over the last 7
// days, the tonnage report downloading as the rows it shows. And the
// workspace's Export downloads a module's rows as the table shows them —
// every page of them, under the table's headers.

type ServiceReport = { routes: { started: number }; pickups: { completed: number; missed: number }; rates: { collection: number | null; missed: number | null } }
type TonnageRow = { wasteFractionName: string; netKg: number }
type TonnageReport = { totals: { netKg: number }; unloads: TonnageRow[] }
type Named = { id: string; name: string }

/** The tiles' spelling of a rate, a count and a weight (lib/insight/dashboard.ts). */
const percent = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`)
const count = (value: number) => new Intl.NumberFormat("en").format(value)
const weight = (kg: number) => (kg >= 1000 ? `${new Intl.NumberFormat("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(kg / 1000)} t` : `${count(kg)} kg`)

async function report<Report>(api: APIRequestContext, path: string, query: Record<string, string>): Promise<Report> {
  const response = await api.get(path, { params: query })
  expect(response.status(), `GET ${path}: ${await response.text()}`).toBe(200)
  return (await response.json()) as Report
}

/** One command as the Driver App queues it: an id the device mints, the route, the instant, the device. */
const commandOf = (kind: string, routeId: string, body: Record<string, unknown>, at: Date) => ({
  id: mintId(at.getTime(), crypto.getRandomValues(new Uint8Array(ID_RANDOM_BYTES))),
  kind,
  routeId,
  occurredAt: at.toISOString(),
  deviceId: "e2e-insight",
  body,
})

/** A CSV text read back as rows of fields: RFC 4180's quotes, CRLF records, the byte-order mark dropped. */
function csvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  const body = text.replace(/^﻿/, "")
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ",") {
      row.push(field)
      field = ""
    } else if (char === "\r" && body[index + 1] === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
      index += 1
    } else field += char
  }
  if (field !== "" || row.length > 0) rows.push([...row, field])
  return rows
}

async function downloaded(download: Download): Promise<string[][]> {
  const path = await download.path()
  return csvRows(await readFile(path, "utf8"))
}

/** Picks an option of one of the Dashboard's filters by its label. */
async function choose(page: Page, filter: string, option: string) {
  await page.getByLabel(filter, { exact: true }).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

test("the Dashboard shows the tenant's numbers after a generated route is run, and the tonnage report downloads as it is shown", async ({ page, api, browser }) => {
  test.setTimeout(180_000)
  const { route, today } = await dispatchedRouteFor(api)
  if (route.planned.vehicleId === null) throw new Error(`${route.label} was dispatched with no vehicle`)
  const stops = [...route.pickups].sort((a, b) => (a.sequence ?? a.position) - (b.sequence ?? b.position))
  expect(stops.length, `${route.label} needs two stops`).toBeGreaterThanOrEqual(2)
  const window = { projectId: route.projectId, from: addDays(today, -6), to: today, interval: "day" }
  const before = await report<ServiceReport>(api, "/reports/service", window)

  // The driver runs the route: starts it, collects the first stop, fails the second, ends the day.
  const context = await freshContext(browser)
  try {
    const driverPage = await context.newPage()
    await signIn(driverPage, SEEDED_DRIVER.email, E2E.loginPassword)
    const token = await accessTokenOf(context)
    if (token === null) throw new Error("the driver's browser holds no API session")
    const asDriver = await apiAs(token)
    try {
      const start = Date.now() - 60_000
      const commands = [
        commandOf("start-route", route.id, { vehicleId: route.planned.vehicleId }, new Date(start)),
        commandOf("complete-pickup", route.id, { pickupId: stops[0].id }, new Date(start + 1_000)),
        commandOf("fail-pickup", route.id, { pickupId: stops[1].id, reason: "not-presented" }, new Date(start + 2_000)),
        commandOf("end-route", route.id, {}, new Date(start + 3_000)),
      ]
      const sent = await asDriver.post("/driver/commands", { data: { commands } })
      expect(sent.status(), await sent.text()).toBe(200)
      expect(((await sent.json()) as { outcomes: { outcome: string }[] }).outcomes.map((outcome) => outcome.outcome)).toEqual(["applied", "applied", "applied", "applied"])
    } finally {
      await asDriver.dispose()
    }
  } finally {
    await context.close()
  }

  // The service report moves by exactly that route: one collected, the rest missed — the failed stop and the ones closed by the day's end.
  const after = await report<ServiceReport>(api, "/reports/service", window)
  expect(after.pickups.completed).toBe(before.pickups.completed + 1)
  expect(after.pickups.missed).toBe(before.pickups.missed + stops.length - 1)
  expect(after.routes.started).toBe(before.routes.started + 1)

  // The office captures the weighbridge ticket on it.
  const [station] = await listAll<Named>(api, "/unloading-stations")
  const residual = (await listAll<Named & { key: string }>(api, "/waste-fractions")).find((fraction) => fraction.key === "residual")
  if (station === undefined || residual === undefined) throw new Error("the seed has no station or no residual fraction")
  const captured = await api.post(`/routes/${route.id}/unloads`, { data: { unloadingStationId: station.id, wasteFractionId: residual.id, netKg: 6_400, occurredAt: new Date(Date.now() - 30_000).toISOString() } })
  expect(captured.status(), await captured.text()).toBe(201)
  const tonnage = await report<TonnageReport>(api, "/reports/tonnage", window)
  expect(tonnage.totals.netKg).toBeGreaterThanOrEqual(6_400)

  const projectResponse = await api.get(`/projects/${route.projectId}`)
  const { name: projectName } = (await projectResponse.json()) as Named

  await page.goto("/performance")
  await expect(page.getByTestId("dashboard-on-api")).toBeVisible()
  await choose(page, "Period", "Last 7 days")
  await choose(page, "Project", projectName)
  await expect(page.getByTestId("dashboard-window")).toContainText(today.slice(0, 4))
  await expect(page.getByTestId("kpi-collection-rate-value")).toHaveText(percent(after.rates.collection))
  await expect(page.getByTestId("kpi-missed-value")).toHaveText(count(after.pickups.missed))
  await expect(page.getByTestId("route-schemes").getByText("RS-Central · Week A")).toBeVisible()

  await page.getByRole("tab", { name: "Analytics" }).click()
  await expect(page.getByTestId("kpi-net-tonnage-value")).toHaveText(weight(tonnage.totals.netKg))
  const residualKg = tonnage.unloads.filter((row) => row.wasteFractionName === residual.name).reduce((sum, row) => sum + row.netKg, 0)
  const download = page.waitForEvent("download")
  await page.getByTestId("tonnage").getByRole("button", { name: "CSV" }).click()
  const csv = await downloaded(await download)
  expect(csv[0]).toEqual(["Waste fraction", "Net kg", "Approved kg", "Not reviewed kg", "Unloads", "Rejected kg", "Rejected unloads"])
  expect(csv.find((row) => row[0] === residual.name)?.[1]).toBe(String(residualKg))
})

test("the workspace's Export downloads a module's rows as the table shows them, every page of them, under its headers", async ({ page }) => {
  const loaded = page.waitForResponse((response) => response.request().method() === "GET" && /^\/properties$/.test(new URL(response.url()).pathname.replace(/^\/waste-api/, "")))
  await page.goto("/customers?module=properties")
  expect((await loaded).status()).toBe(200)
  const table = page.getByRole("table")
  await expect(table.locator("tbody tr").first()).toBeVisible()
  await expect(page.getByText(/^Showing 1–\d+ of \d+$/)).toBeVisible()
  const total = Number((await page.getByText(/^Showing 1–\d+ of \d+$/).innerText()).replace(/^.* of /, ""))
  const headers = (await table.getByRole("columnheader").allInnerTexts()).map((text) => text.trim()).filter((text) => text !== "" && text !== "Actions")
  const names = await table.locator("tbody tr td:first-child p.font-medium").allInnerTexts()

  const download = page.waitForEvent("download")
  await page.getByRole("button", { name: "Export" }).click()
  const csv = await downloaded(await download)
  // The description is drawn under the name in the name's cell; the file gives it a column of its own beside the name.
  expect(csv[0]).toEqual([headers[0], "Description", ...headers.slice(1)])
  expect(csv.length - 1, "every row the filters leave, not the page").toBe(total)
  expect(csv.slice(1, names.length + 1).map((row) => row[0])).toEqual(names)
  await expect(page.getByText(`Exported ${total} rows`)).toBeVisible()
})
