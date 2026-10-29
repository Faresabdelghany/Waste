// Disposal documents on the web (O18 of #290): Settings › Master data marks a
// fraction hazardous under its starred waste code, and an unload's details on
// the weights desk save its waste transfer note — the API's PDF, byte for
// byte — or, for a load the station turned away, say why it has none. The
// fraction and the station that takes it are this run's own, made through the
// API and uniquely named, so the shared stack's seeded station is left as it
// is; the route is a dispatched one the seeded driver starts, ended again
// afterwards.
import { readFile } from "node:fs/promises"

import type { Browser, Page } from "@playwright/test"
import { ID_RANDOM_BYTES, mintId } from "@waste/domain/ids"

import { dispatchedRouteFor, SEEDED_DRIVER } from "./dispatched-route"
import { E2E, uniqueName } from "./env"
import { accessTokenOf, apiAs, expect, freshContext, signIn, test } from "./fixtures"

type Fraction = { id: string; name: string; wasteCode: string | null; hazardous: boolean }
type Station = { id: string; name: string }
type Unload = { id: string }

const fail = (why: string): never => {
  throw new Error(why)
}

/** The browser's API call the page makes: the answer of `method` on a path under `path`. */
const answerOf = (page: Page, method: string, path: RegExp) =>
  page.waitForResponse((response) => response.request().method() === method && path.test(new URL(response.url()).pathname.replace(/^\/waste-api/, "")))

/** The seeded driver starts the dispatched route, so the office may capture a weighbridge ticket on it. */
async function startedByTheDriver(browser: Browser, route: { id: string; planned: { vehicleId: string | null } }) {
  const vehicleId = route.planned.vehicleId ?? fail(`route ${route.id} was dispatched with no vehicle`)
  const context = await freshContext(browser)
  try {
    const driverPage = await context.newPage()
    await signIn(driverPage, SEEDED_DRIVER.email, E2E.loginPassword)
    const asDriver = await apiAs((await accessTokenOf(context)) ?? fail("the driver's browser holds no API session"))
    try {
      const started = await asDriver.post("/driver/commands", { data: { commands: [{ id: mintId(Date.now(), crypto.getRandomValues(new Uint8Array(ID_RANDOM_BYTES))), kind: "start-route", routeId: route.id, occurredAt: new Date().toISOString(), deviceId: "e2e-transfer-note", body: { vehicleId } }] } })
      expect(started.status()).toBe(200)
      expect(((await started.json()) as { outcomes: { outcome: string }[] }).outcomes.map((outcome) => outcome.outcome)).toEqual(["applied"])
    } finally {
      await asDriver.dispose()
    }
  } finally {
    await context.close()
  }
}

test("a hazardous fraction is marked in Master data, and an unload's details save its transfer note, or say why a refused load has none (O18 of #290)", async ({ page, api, browser }) => {
  test.setTimeout(150_000)
  const suffix = Date.now().toString(36)
  const name = uniqueName("E2E batteries")
  const made = await api.post("/waste-fractions", { data: { key: `e2e-batteries-${suffix}`, name } })
  expect(made.status(), await made.text()).toBe(201)
  const fraction = (await made.json()) as Fraction
  expect(fraction.hazardous).toBe(false)

  // Settings › Master data files it under its starred code and ticks it hazardous.
  await page.goto("/settings?pane=master-data")
  await page.getByPlaceholder("Search waste fractions").fill(name)
  await page.getByRole("button", { name: `Edit ${name}` }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Waste code").fill("20 01 33*")
  await dialog.getByLabel("Hazardous waste").check()
  const [patched] = await Promise.all([answerOf(page, "PATCH", new RegExp(`^/waste-fractions/${fraction.id}$`)), dialog.getByRole("button", { name: "Save changes" }).click()])
  expect(patched.status(), await patched.text()).toBe(200)
  expect(patched.request().postDataJSON()).toEqual({ wasteCode: "200133*", hazardous: true })
  await expect(page.getByRole("row").filter({ hasText: name }).getByText("Hazardous", { exact: true })).toBeVisible()
  expect(((await (await api.get(`/waste-fractions/${fraction.id}`)).json()) as Fraction).hazardous).toBe(true)

  // A station of this run's own takes it, so the seeded one is left as it is.
  const opened = await api.post("/unloading-stations", { data: { code: `E2E-WTN-${suffix}`.toUpperCase(), name: uniqueName("E2E hazardous waste depot"), address: "Kraftværksvej 1\n2300 København S", location: { type: "Point", coordinates: [12.61, 55.66] }, ownership: "external", weighbridge: true, wasteFractionIds: [fraction.id] } })
  expect(opened.status(), await opened.text()).toBe(201)
  const station = (await opened.json()) as Station

  const { route } = await dispatchedRouteFor(api)
  await startedByTheDriver(browser, route)
  try {
    const ticket = `WB-E2E-${suffix}`.toUpperCase()
    const captured = await api.post(`/routes/${route.id}/unloads`, { data: { unloadingStationId: station.id, wasteFractionId: fraction.id, netKg: 1250, grossKg: 15_250, tareKg: 14_000, weighbridgeTicket: ticket, occurredAt: new Date(Date.now() - 60_000).toISOString() } })
    expect(captured.status(), await captured.text()).toBe(201)
    const unload = (await captured.json()) as Unload
    const turnedAway = await api.post(`/routes/${route.id}/unloads`, { data: { unloadingStationId: station.id, wasteFractionId: fraction.id, netKg: 300, weighbridgeTicket: `${ticket}-R`, occurredAt: new Date(Date.now() - 30_000).toISOString(), refusal: { reason: "hazardous", note: "Leaking casing" } } })
    expect(turnedAway.status(), await turnedAway.text()).toBe(201)

    const loaded = answerOf(page, "GET", /^\/unloads$/)
    await page.goto("/route-studio?module=weights")
    expect((await loaded).status()).toBe(200)

    // The load the station took saves its note: the API's file, byte for byte.
    await page.getByPlaceholder("Search weight records").fill(ticket)
    await page.getByRole("table").getByText(`${ticket} · ${name}`, { exact: true }).click()
    const note = page.getByRole("dialog").getByTestId("transfer-note")
    const [download] = await Promise.all([page.waitForEvent("download"), note.getByRole("button", { name: "Download PDF" }).click()])
    expect(download.suggestedFilename()).toBe(`transfer-note-${unload.id}.pdf`)
    const file = await readFile((await download.path()) ?? fail("the download was saved"))
    expect(file.subarray(0, 8).toString("latin1")).toBe("%PDF-1.7")
    const direct = await api.get(`/unloads/${unload.id}/transfer-note`)
    expect(direct.headers()["content-type"]).toBe("application/pdf")
    expect((await direct.body()).equals(Uint8Array.from(file)), "the saved file is the API's, byte for byte").toBe(true)
    await page.keyboard.press("Escape")

    // The load it turned away has none, and the details say why.
    await page.getByPlaceholder("Search weight records").fill(`${ticket}-R`)
    await page.getByRole("table").getByText(`${ticket}-R · ${name}`, { exact: true }).click()
    const withheld = page.getByRole("dialog").getByTestId("transfer-note")
    await expect(withheld).toContainText("The station refused this load: it was not transferred and has no transfer note.")
    await expect(withheld.getByRole("button")).toHaveCount(0)
  } finally {
    // The driver holds one open session at a time: the office ends this route for the next test.
    await api.post(`/routes/${route.id}/cancel`, { data: { reasonCode: "other", reason: "Ended by the transfer note end-to-end test" } })
  }
})
