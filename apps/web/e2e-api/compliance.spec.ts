import { readFile } from "node:fs/promises"

import type { APIRequestContext, Page } from "@playwright/test"
import { ID_RANDOM_BYTES, mintId } from "@waste/domain/ids"

import { accessTokenOf, apiAs, expect, freshContext, signIn, test } from "./fixtures"
import { dispatchedRouteFor, SEEDED_DRIVER } from "./dispatched-route"
import { E2E } from "./env"
import { listAll } from "./tester"

// The waste-data report on the API (#291 slice 29). A generated route of the
// seeded tenant is started by the seeded driver through the driver door, and
// the office captures three weighbridge tickets on it, at a station made for
// the run that takes both fractions: residual waste,
// approved; a fraction made for the run with no waste code, approved; and
// more residual nobody reviews. The Dashboard's Compliance tab then files the
// approved ones by municipality, station and fraction, as the API's report
// reads them, warns of the uncoded fraction and the unreviewed load before
// filing, and downloads the API's own file, byte-order mark and separator
// as asked. Settings › Master data sets the fraction's code as the list
// prints it, and the tab files it under that code with no warning left.

type Named = { id: string; name: string }
type Fraction = Named & { key: string; wasteCode: string | null }
type WasteDataRow = { municipality: string; unloadingStationName: string; wasteFractionId: string; wasteFractionName: string; wasteCode: string | null; netKg: number }
type WasteDataReport = { window: { from: string; to: string }; rows: WasteDataRow[]; warnings: { kind: string; sentence: string; wasteFractionId?: string }[] }

/** The file's columns (`WASTE_DATA_COLUMNS`, @waste/domain/insight/waste-data). */
const COLUMNS = ["period_from", "period_to", "municipality", "unloading_station", "fraction", "waste_code", "kg", "warning"]

const count = (value: number) => new Intl.NumberFormat("en").format(value)

/** One command as the Driver App queues it. */
const commandOf = (kind: string, routeId: string, body: Record<string, unknown>, at: Date) => ({
  id: mintId(at.getTime(), crypto.getRandomValues(new Uint8Array(ID_RANDOM_BYTES))),
  kind,
  routeId,
  occurredAt: at.toISOString(),
  deviceId: "e2e-compliance",
  body,
})

async function ok(response: Awaited<ReturnType<APIRequestContext["get"]>>, status: number, what: string): Promise<unknown> {
  expect(response.status(), `${what}: ${await response.text()}`).toBe(status)
  return response.json()
}

/** Picks an option of one of the Dashboard's selects by its label. */
async function choose(page: Page, label: string, option: string) {
  await page.getByLabel(label, { exact: true }).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

/** The file read back as rows of fields, split on the separator: no field here is quoted. */
const recordsOf = (text: string, separator: string) =>
  text
    .replace(/^﻿/, "")
    .split("\r\n")
    .filter((line) => line !== "")
    .map((line) => line.split(separator))

test("the Compliance tab files the period's approved unloads with their waste codes, warns before filing, and downloads the API's file; Master data sets a fraction's code", async ({ page, api, browser }) => {
  test.setTimeout(180_000)
  const { route, today } = await dispatchedRouteFor(api)
  if (route.planned.vehicleId === null) throw new Error(`${route.label} was dispatched with no vehicle`)

  const suffix = Date.now().toString(36)
  const fraction = (await ok(await api.post("/waste-fractions", { data: { key: `e2e-garden-${suffix}`, name: `E2E garden waste ${suffix}` } }), 201, "POST /waste-fractions")) as Fraction
  expect(fraction.wasteCode).toBeNull()
  const residual = (await listAll<Fraction>(api, "/waste-fractions")).find((candidate) => candidate.key === "residual")
  if (residual === undefined) throw new Error("the seed has no residual fraction")
  expect(residual.wasteCode, "the seed codes residual waste").toBe("200301")
  // A load the station took is of a fraction it takes (O9 of #290), so the run's fraction is tipped at a station of the run's own.
  const station = (await ok(
    await api.post("/unloading-stations", {
      data: {
        code: `E2E-WD-${suffix}`.toUpperCase(),
        name: `E2E waste-data station ${suffix}`,
        address: "Prøvestenen 4",
        location: { type: "Point", coordinates: [12.6302, 55.6801] },
        ownership: "external",
        weighbridge: true,
        wasteFractionIds: [residual.id, fraction.id],
      },
    }),
    201,
    "POST /unloading-stations",
  )) as Named

  // The driver starts the route, the office captures on it while it runs, and the driver ends the day.
  const context = await freshContext(browser)
  try {
    const driverPage = await context.newPage()
    await signIn(driverPage, SEEDED_DRIVER.email, E2E.loginPassword)
    const token = await accessTokenOf(context)
    if (token === null) throw new Error("the driver's browser holds no API session")
    const asDriver = await apiAs(token)
    const send = async (kind: string, body: Record<string, unknown>, at: Date) => {
      const sent = await asDriver.post("/driver/commands", { data: { commands: [commandOf(kind, route.id, body, at)] } })
      expect(sent.status(), await sent.text()).toBe(200)
      expect(((await sent.json()) as { outcomes: { outcome: string }[] }).outcomes.map((outcome) => outcome.outcome), kind).toEqual(["applied"])
    }
    try {
      await send("start-route", { vehicleId: route.planned.vehicleId }, new Date(Date.now() - 120_000))
      const capture = async (wasteFractionId: string, netKg: number) =>
        ((await ok(await api.post(`/routes/${route.id}/unloads`, { data: { unloadingStationId: station.id, wasteFractionId, netKg, occurredAt: new Date(Date.now() - 60_000).toISOString() } }), 201, "POST unload")) as Named).id
      for (const id of [await capture(residual.id, 4_321), await capture(fraction.id, 1_234)]) await ok(await api.post(`/unloads/${id}/approve`, { data: {} }), 201, `POST /unloads/${id}/approve`)
      await capture(residual.id, 555)
      await send("end-route", {}, new Date(Date.now() - 30_000))
    } finally {
      await asDriver.dispose()
    }
  } finally {
    await context.close()
  }

  const projectName = ((await ok(await api.get(`/projects/${route.projectId}`), 200, "GET project")) as Named).name
  const period = { projectId: route.projectId, from: `${today.slice(0, 4)}-01-01`, to: today }
  const report = (await ok(await api.get("/reports/waste-data", { params: period }), 200, "GET /reports/waste-data")) as WasteDataReport
  const ours = report.rows.find((row) => row.wasteFractionId === fraction.id)
  expect(ours).toMatchObject({ municipality: projectName, unloadingStationName: station.name, wasteFractionName: fraction.name, wasteCode: null, netKg: 1_234 })
  const residualRow = report.rows.find((row) => row.wasteFractionId === residual.id && row.unloadingStationName === station.name)
  expect(residualRow?.netKg ?? 0).toBeGreaterThanOrEqual(4_321)
  const noCode = report.warnings.find((warning) => warning.kind === "no-waste-code" && warning.wasteFractionId === fraction.id)
  expect(noCode?.sentence).toBe(`${fraction.name} has no waste code: set it under the fraction in Settings › Master data before the report is filed`)

  // The tab shows the report as the API reads it.
  await page.goto("/performance")
  await expect(page.getByTestId("dashboard-on-api")).toBeVisible()
  await page.getByRole("tab", { name: "Compliance" }).click()
  await expect(page.getByLabel("Period", { exact: true }), "the header's period is Performance's and Analytics'").toBeHidden()
  await choose(page, "Project", projectName)
  await choose(page, "Filing period", "This year so far")
  await expect(page.getByLabel("First day")).toHaveValue(period.from)
  await expect(page.getByLabel("Last day")).toHaveValue(period.to)
  const warnings = page.getByTestId("waste-data-warnings")
  await expect(warnings.getByText(noCode?.sentence ?? "", { exact: true })).toBeVisible()
  await expect(warnings.getByText(/not reviewed and not counted/).first()).toBeVisible()
  const ourRow = page.getByTestId("waste-data-table").getByRole("row").filter({ hasText: fraction.name })
  await expect(ourRow.getByRole("cell")).toHaveText([projectName, station.name, fraction.name, "None", count(1_234), "1"])
  const residualCells = page.getByTestId("waste-data-table").getByRole("row").filter({ hasText: residual.name }).filter({ hasText: station.name }).getByRole("cell")
  await expect(residualCells.nth(3)).toHaveText("200301")
  await expect(residualCells.nth(4)).toHaveText(count(residualRow?.netKg ?? 0))

  // The file is the API's, as asked: semicolons, the byte-order mark, a data row per place and a warning row each.
  await choose(page, "Separator", "Semicolons")
  const download = page.waitForEvent("download")
  await page.getByTestId("waste-data-download").click()
  const file = await download
  expect(file.suggestedFilename()).toBe(`waste-data-${period.from}-${period.to}.csv`)
  const bytes = await readFile(await file.path())
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  const records = recordsOf(bytes.toString("utf8"), ";")
  expect(records[0]).toEqual(COLUMNS)
  expect(records).toContainEqual([period.from, period.to, projectName, station.name, fraction.name, "", "1234", ""])
  expect(records).toContainEqual([period.from, period.to, "", "", fraction.name, "", "", noCode?.sentence])
  expect(records.length, "the header, the report's rows and a row per warning").toBe(1 + report.rows.length + report.warnings.length)

  // Settings › Master data sets the fraction's code, typed as the list prints it.
  await page.goto("/settings?pane=master-data")
  await page.getByPlaceholder("Search waste fractions").fill(fraction.name)
  await page.getByRole("button", { name: `Edit ${fraction.name}` }).click()
  const dialog = page.getByRole("dialog")
  const patches: string[] = []
  page.on("request", (request) => {
    if (request.method() === "PATCH") patches.push(request.url())
  })
  await dialog.getByLabel("Waste code").fill("20 02")
  await dialog.getByRole("button", { name: "Save changes" }).click()
  await expect(dialog.getByText("A waste code is six digits of the European List of Waste, such as 200301, chapter 01 to 20, with an asterisk after a hazardous entry's")).toBeVisible()
  expect(patches, "a code of another shape is refused at the field, before the API").toEqual([])
  await dialog.getByLabel("Waste code").fill("20 02 01")
  const patched = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname.endsWith(`/waste-fractions/${fraction.id}`))
  await dialog.getByRole("button", { name: "Save changes" }).click()
  const answer = await patched
  expect(answer.status()).toBe(200)
  expect(answer.request().postDataJSON()).toEqual({ wasteCode: "200201" })
  await expect(page.getByRole("row").filter({ hasText: fraction.name }).getByText("200201", { exact: true })).toBeVisible()
  expect(((await ok(await api.get(`/waste-fractions/${fraction.id}`), 200, "GET fraction")) as Fraction).wasteCode).toBe("200201")

  // And the tab files it under that code, the warning gone.
  await page.goto("/performance")
  await page.getByRole("tab", { name: "Compliance" }).click()
  await choose(page, "Project", projectName)
  await choose(page, "Filing period", "This year so far")
  await expect(page.getByTestId("waste-data-table").getByRole("row").filter({ hasText: fraction.name }).getByRole("cell").nth(3)).toHaveText("200201")
  await expect(page.getByTestId("waste-data-warnings").getByText(noCode?.sentence ?? "", { exact: true })).toBeHidden()
})
