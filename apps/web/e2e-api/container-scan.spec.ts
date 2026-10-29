import { expect, freshContext, signIn, test } from "./fixtures"
import { dispatchedRouteFor, SEEDED_DRIVER } from "./dispatched-route"
import { E2E } from "./env"
import { listAll } from "./tester"

// Container identification (O19 of #290) on a phone-sized browser against the
// real door: the office gives the first stop's container a barcode and looks
// it up by that code, then the seeded driver starts the dispatched route,
// scans the stop — typed, since a headless browser has no BarcodeDetector —
// is told a neighbouring stop's code is not this stop's container, then
// enters the bin's own barcode, which the door judges and the stop reads back
// as confirmed. Through the API: the arrival's receipt carries the code.

type Container = { id: string; label: string; barcode: string | null }
type RouteStop = { id: string; position: number; sequence?: number; containerId: string | null }
type Receipt = { id: string; kind: string; outcome: string; pickupId: string | null; body: { identification?: { code: string; method: string } } }

test("a driver confirms a stop's container by its code, after the code of another stop's is refused", async ({ api, browser }) => {
  test.setTimeout(120_000)
  const { route } = await dispatchedRouteFor(api)
  const detail = (await (await api.get(`/routes/${route.id}`)).json()) as { pickups: RouteStop[] }
  const stops = [...detail.pickups].sort((a, b) => (a.sequence ?? a.position) - (b.sequence ?? b.position))
  const [first, second] = stops
  if (first?.containerId == null || second?.containerId == null) throw new Error(`${route.label}'s first two stops need containers`)

  // The office tags the bin with a barcode of this run's own, and finds it again by that code, spaces and case as a reader leaves them.
  const barcode = `E2E${Date.now()}`
  const tagged = await api.patch(`/containers/${first.containerId}`, { data: { barcode } })
  expect(tagged.status(), await tagged.text()).toBe(200)
  const found = await listAll<Container>(api, "/containers", { identifier: ` ${barcode.toLowerCase()} ` })
  expect(found.map((container) => container.id)).toEqual([first.containerId])
  const neighbour = (await (await api.get(`/containers/${second.containerId}`)).json()) as Container

  const context = await freshContext(browser, { viewport: { width: 390, height: 844 } })
  try {
    const page = await context.newPage()
    await signIn(page, SEEDED_DRIVER.email, E2E.loginPassword)
    await expect(page).toHaveURL(/\/driver$/)
    const card = page.getByRole("article", { name: `Route ${route.label}` })
    await card.getByRole("button", { name: "Start route" }).click()
    await expect(card.getByText("Active", { exact: true })).toBeVisible()
    await card.getByRole("link", { name: "Open route" }).click()

    const stop = page.getByRole("article", { name: "Stop 1", exact: true })
    const dialog = page.getByRole("dialog")
    await expect(stop.getByText("Container confirmed")).toHaveCount(0)
    await stop.getByRole("button", { name: "Scan container" }).click()
    await expect(dialog.getByRole("button", { name: "Scan with camera" })).toHaveCount(0)

    // Another stop's bin: the door names it, and nothing is sent.
    await dialog.getByLabel("Barcode, tag or label").fill(neighbour.label)
    await dialog.getByRole("button", { name: "Check code" }).click()
    await expect(dialog.getByRole("status")).toHaveText(`${neighbour.label} is stop 2's container, not this one`)

    // The bin's own barcode: the arrival goes with it, and the stop reads back confirmed and arrived.
    await dialog.getByLabel("Barcode, tag or label").fill(barcode.toLowerCase())
    await dialog.getByRole("button", { name: "Check code" }).click()
    await expect(dialog).toBeHidden()
    await expect(stop.getByText("Container confirmed")).toBeVisible()
    await expect(stop.locator('[data-slot="badge"]', { hasText: /^Arrived$/ })).toBeVisible()

    const receipts = await listAll<Receipt>(api, `/routes/${route.id}/commands`)
    const arrivals = receipts.filter((receipt) => receipt.kind === "arrive" && receipt.pickupId === first.id)
    expect(arrivals.map((receipt) => [receipt.outcome, receipt.body.identification])).toEqual([["applied", { code: barcode.toLowerCase(), method: "typed" }]])
  } finally {
    await context.close()
    await api.patch(`/containers/${first.containerId}`, { data: { barcode: null } })
    await api.post(`/routes/${route.id}/cancel`, { data: { reasonCode: "other", reason: "Container scan scenario done" } })
  }
})
