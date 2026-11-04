// A weighbridge's tickets on the web (O27 of #290): a batch sent through the
// ingest — one ticket of the running route's truck, which matches itself and
// is written as the route's unload, one of a plate nobody drives, which waits
// — the waiting one matched by hand in Route Studio › Weighbridge, and the
// weighbridge's unload and the office's of the same load told as possible
// duplicates on the weights desk. The station is this run's own, made through
// the API, so the shared stack's seeded one is left as it is; the route is a
// dispatched one the seeded driver starts, ended again afterwards.
import type { Browser, Locator, Page } from "@playwright/test"
import { ID_RANDOM_BYTES, mintId } from "@waste/domain/ids"

import { dispatchedRouteFor, SEEDED_DRIVER } from "./dispatched-route"
import { E2E, uniqueName } from "./env"
import { accessTokenOf, apiAs, expect, freshContext, signIn, test } from "./fixtures"
import { listAll } from "./tester"

type Named = { id: string; name: string }
type Outcome = { outcome: string; ticketId?: string; unloadId?: string; reason?: string }

const fail = (why: string): never => {
  throw new Error(why)
}

/** The browser's API call the page makes: the answer of `method` on a path under `path`. */
const answerOf = (page: Page, method: string, path: RegExp) =>
  page.waitForResponse((response) => response.request().method() === method && path.test(new URL(response.url()).pathname.replace(/^\/waste-api/, "")))

/** Picks an option of a select field in a dialog by its label and the start of the option's. */
async function pick(dialog: Locator, page: Page, field: RegExp, option: RegExp) {
  await dialog.getByRole("combobox", { name: field }).click()
  await page.getByRole("option", { name: option }).first().click()
}

/** The seeded driver starts the dispatched route, so its truck has a session the weighbridge's instant falls in. */
async function startedByTheDriver(browser: Browser, route: { id: string; planned: { vehicleId: string | null } }) {
  const vehicleId = route.planned.vehicleId ?? fail(`route ${route.id} was dispatched with no vehicle`)
  const context = await freshContext(browser)
  try {
    const driverPage = await context.newPage()
    await signIn(driverPage, SEEDED_DRIVER.email, E2E.loginPassword)
    const asDriver = await apiAs((await accessTokenOf(context)) ?? fail("the driver's browser holds no API session"))
    try {
      const started = await asDriver.post("/driver/commands", { data: { commands: [{ id: mintId(Date.now(), crypto.getRandomValues(new Uint8Array(ID_RANDOM_BYTES))), kind: "start-route", routeId: route.id, occurredAt: new Date().toISOString(), deviceId: "e2e-weighbridge", body: { vehicleId } }] } })
      expect(started.status()).toBe(200)
      expect(((await started.json()) as { outcomes: { outcome: string }[] }).outcomes.map((outcome) => outcome.outcome)).toEqual(["applied"])
    } finally {
      await asDriver.dispose()
    }
  } finally {
    await context.close()
  }
}

test("a weighbridge's batch: one ticket matches its truck's route, one waits and is matched by hand, and the weights desk tells the duplicate (O27 of #290)", async ({ page, api, browser }) => {
  test.setTimeout(150_000)
  const suffix = Date.now().toString(36).toUpperCase()
  const residual = (await listAll<Named & { key: string }>(api, "/waste-fractions")).find((fraction) => fraction.key === "residual") ?? fail("the seed has no residual fraction")
  const stationCode = `E2E-WB-${suffix}`
  const opened = await api.post("/unloading-stations", { data: { code: stationCode, name: uniqueName("E2E weighbridge station"), address: "Kraftværksvej 1\n2300 København S", location: { type: "Point", coordinates: [12.61, 55.66] }, ownership: "external", weighbridge: true, wasteFractionIds: [residual.id] } })
  expect(opened.status(), await opened.text()).toBe(201)

  const { route } = await dispatchedRouteFor(api)
  const vehicleId = route.planned.vehicleId ?? fail(`${route.label} has no vehicle`)
  const plate = ((await (await api.get(`/vehicles/${vehicleId}`)).json()) as { registration: string }).registration
  await startedByTheDriver(browser, route)
  try {
    // The office records the load itself too, before the weighbridge's batch arrives.
    const byHand = await api.post(`/routes/${route.id}/unloads`, { data: { unloadingStationId: ((await opened.json()) as Named).id, wasteFractionId: residual.id, netKg: 4200, occurredAt: new Date().toISOString() } })
    expect(byHand.status(), await byHand.text()).toBe(201)

    const matchedNumber = `WB-${suffix}-1`
    const waitingNumber = `WB-${suffix}-2`
    // Weighed after this route's session began, so no earlier spec's session on the same truck spans the instant.
    const weighed = new Date(Date.now() + 1_000).toISOString()
    const sent = await api.post("/weighbridge-tickets", {
      data: {
        tickets: [
          { stationCode, ticketNumber: matchedNumber, vehicleRegistration: plate.toLowerCase(), weighedAt: weighed, netKg: 4200, grossKg: 16_200, tareKg: 12_000, fractionKey: "residual" },
          { stationCode, ticketNumber: waitingNumber, vehicleRegistration: `E2E ${suffix}`, weighedAt: weighed, netKg: 900, wasteCode: "200301" },
        ],
      },
    })
    expect(sent.status(), await sent.text()).toBe(200)
    const [matched, waiting] = ((await sent.json()) as { outcomes: Outcome[] }).outcomes
    expect(matched.outcome).toBe("matched")
    expect([waiting.outcome, waiting.reason]).toEqual(["unmatched", "unknown-vehicle"])

    // The waiting ticket is matched by hand in Route Studio › Weighbridge.
    const loaded = answerOf(page, "GET", /^\/weighbridge-tickets$/)
    await page.goto("/route-studio?module=weighbridge")
    expect((await loaded).status()).toBe(200)
    await page.getByPlaceholder("Search weighbridge tickets").fill(waitingNumber)
    await page.getByRole("table").getByText(`${waitingNumber} · E2E ${suffix}`, { exact: true }).click()
    const details = page.getByRole("dialog").filter({ has: page.getByTestId("weighbridge-ticket-commands") })
    await expect(details).toContainText("No vehicle has this plate")
    await details.getByTestId("weighbridge-ticket-commands").getByRole("button", { name: "Match" }).click()
    const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Match ticket" }) })
    await pick(dialog, page, /^Route/, new RegExp(`^${route.label}`))
    await pick(dialog, page, /^Waste fraction/, new RegExp(`^${residual.name}$`))
    const [answered] = await Promise.all([answerOf(page, "POST", new RegExp(`^/weighbridge-tickets/${waiting.ticketId}/match$`)), dialog.getByRole("button", { name: "Match" }).click()])
    expect(answered.status(), await answered.text()).toBe(200)
    expect(answered.request().postDataJSON()).toEqual({ routeId: route.id, wasteFractionId: residual.id })
    await expect(details.getByTestId("weighbridge-ticket-commands").getByRole("button")).toHaveCount(0)

    // The weighbridge's unload and the office's of the same load are told as possible duplicates.
    const weights = answerOf(page, "GET", /^\/unloads$/)
    await page.goto("/route-studio?module=weights")
    expect((await weights).status()).toBe(200)
    await page.getByPlaceholder("Search weight records").fill(matchedNumber)
    await page.getByRole("table").getByText(`${matchedNumber} · ${residual.name}`, { exact: true }).click()
    await expect(page.getByRole("dialog").getByTestId("possible-duplicate")).toContainText("Possible duplicate of")
    const read = (await (await api.get(`/unloads/${matched.unloadId}`)).json()) as { source: string; possibleDuplicates: string[] }
    expect(read.source).toBe("integration")
    expect(read.possibleDuplicates).toContain(((await byHand.json()) as Named).id)
  } finally {
    // The driver holds one open session at a time: the office ends this route for the next test.
    await api.post(`/routes/${route.id}/cancel`, { data: { reasonCode: "other", reason: "Ended by the weighbridge end-to-end test" } })
  }
})
