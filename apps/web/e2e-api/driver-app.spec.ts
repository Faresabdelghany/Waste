import { apiAs, accessTokenOf, expect, freshContext, signIn, test } from "./fixtures"
import { dispatchedRouteFor, SEEDED_DRIVER, type RouteDetail } from "./dispatched-route"
import { E2E } from "./env"
import { openRoute } from "./routes-support"
import { listAll } from "./tester"

// The Driver App (Issue #145) on a phone-sized browser against the real door:
// the seeded driver signs in, sees the route the office dispatched, starts it
// on the planned vehicle, hands the next stops to Maps, arrives at a stop,
// adds a note, a weight and a signature (O2 and O1 of #290), completes,
// skips and fails stops with reasons, a photo with the failure,
// reports a problem, pauses and resumes, records an unload, loses the
// connection for two stops and ends the route. Then, through the API: one
// receipt per command and none twice, the Live board's position, and the
// tickets the Resolution consumer opened for the failed stop and the
// reported problem; and the office reads the photo and the signature back
// from Storage, through the URLs the API signs. The route comes from generation and the office's
// commands (dispatched-route.ts), never from a fixture.

type Receipt = { id: string; kind: string; outcome: string; routeId: string | null }
type LiveRoute = { id: string; status: string; lastLocation: unknown }
type Ticket = { id: string; links: { routeId: string | null; pickupId: string | null } }
type ProofObjectLinks = { items: { proofId: string; objectKey: string; url: string | null }[] }

/** A photo as the phone's camera would hand one over, which the Driver App draws again as JPEG. */
const PHOTO = "public/avatar-profile.jpg"

/** Where the phone stands, and so where every located command says it stood. */
const POSITION = { latitude: 55.6867, longitude: 12.5701, accuracy: 12 }

const ordered = (route: RouteDetail) => [...route.pickups].sort((a, b) => (a.sequence ?? a.position) - (b.sequence ?? b.position))

test("an office login on /driver is told the door does not take it, and sees no stop", async ({ page }) => {
  await page.goto("/driver")
  await expect(page.getByRole("alert").filter({ hasText: "This login does not drive" })).toContainText("This account is not an active driver's login")
  await expect(page.getByRole("article")).toHaveCount(0)
})

test("a driver works a dispatched route on a phone, through an outage, and every action is one receipt", async ({ api, browser, page: office }) => {
  test.setTimeout(180_000)
  const { route } = await dispatchedRouteFor(api)
  const stops = ordered(route)
  expect(stops.length, `${route.label} needs six stops for this flow`).toBeGreaterThanOrEqual(6)

  const context = await freshContext(browser, { viewport: { width: 390, height: 844 }, geolocation: POSITION, permissions: ["geolocation"] })
  try {
    const page = await context.newPage()
    await signIn(page, SEEDED_DRIVER.email, E2E.loginPassword)
    // A bound driver lands on the Driver App (lib/api/landing.ts).
    await expect(page).toHaveURL(/\/driver$/)

    const card = page.getByRole("article", { name: `Route ${route.label}` })
    await expect(card.getByText("Ready", { exact: true })).toBeVisible()
    await expect(card.getByLabel("Vehicle")).toHaveValue(route.planned.vehicleId ?? "")
    await card.getByRole("button", { name: "Start route" }).click()
    await expect(card.getByText("Active", { exact: true })).toBeVisible()
    await card.getByRole("link", { name: "Open route" }).click()
    await expect(page).toHaveURL(new RegExp(`/driver/routes/${route.id}$`))

    const stop = (index: number) => page.getByRole("article", { name: `Stop ${index + 1}`, exact: true })
    const dialog = page.getByRole("dialog")

    // The next places still to do go to Maps in one link, in the order driven, from wherever the phone is.
    const navigate = new URL((await page.getByRole("link", { name: "Navigate the next stops in Maps" }).getAttribute("href")) ?? "")
    expect([navigate.pathname, navigate.searchParams.get("travelmode")]).toEqual(["/maps/dir/", "driving"])
    expect(navigate.searchParams.get("destination")).toMatch(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)

    // Arrived once: the badge comes from the server's arrival, and the button does not come back.
    await stop(0).getByRole("button", { name: "Arrived" }).click()
    await expect(stop(0).locator('[data-slot="badge"]', { hasText: /^Arrived$/ })).toBeVisible()
    await expect(stop(0).getByRole("button", { name: "Arrived" })).toHaveCount(0)

    await stop(0).getByRole("button", { name: "Complete" }).click()
    await expect(stop(0).getByText("Completed", { exact: true })).toBeVisible()
    // A weight and a note after the outcome: the stop's record grows, its outcome stands.
    await stop(0).getByRole("button", { name: "Weight" }).click()
    await dialog.getByLabel("Weight kg").fill("212")
    await dialog.getByRole("button", { name: "Record weight" }).click()
    await expect(stop(0).getByText("Sending")).toBeHidden()
    await stop(0).getByRole("button", { name: "Note" }).click()
    await dialog.getByLabel("Note").fill("Lid cracked, still closes")
    await dialog.getByRole("button", { name: "Add note" }).click()
    await expect(stop(0).getByText("Sending")).toBeHidden()
    // A signature, drawn on the pad: its bytes go to Storage before its command.
    await stop(0).getByRole("button", { name: "Signature" }).click()
    const pad = dialog.getByLabel("Signature pad")
    await pad.hover()
    const box = await pad.boundingBox()
    if (box === null) throw new Error("the signature pad is not drawn")
    await page.mouse.move(box.x + 24, box.y + box.height * 0.7)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3, { steps: 8 })
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.6, { steps: 8 })
    await page.mouse.up()
    await dialog.getByRole("button", { name: "Save signature" }).click()
    await expect(dialog).toBeHidden()
    await expect(stop(0).getByText("Sending")).toBeHidden()

    await stop(1).getByRole("button", { name: "Skip" }).click()
    await dialog.getByLabel("Reason").selectOption("not-presented")
    await dialog.getByRole("button", { name: "Skip stop" }).click()
    await expect(stop(1).getByText("Skipped · Not presented")).toBeVisible()

    await stop(2).getByRole("button", { name: "Fail" }).click()
    await dialog.getByLabel("Reason").selectOption("inaccessible")
    await dialog.getByLabel("Note (optional)").fill("Gate locked, no answer at the door")
    await dialog.getByLabel("Photo (optional)").setInputFiles(PHOTO)
    await expect(dialog.getByRole("img", { name: "The photo to send" })).toBeVisible()
    await dialog.getByRole("button", { name: "Fail stop" }).click()
    await expect(stop(2).getByText("Failed · Inaccessible")).toBeVisible()
    await expect(stop(2).getByText("Sending")).toBeHidden()

    await stop(3).getByRole("button", { name: "Problem" }).click()
    await dialog.getByLabel("Reason").selectOption("safety")
    await dialog.getByLabel("What happened").fill("Bin lid hanging off its hinge")
    await dialog.getByRole("button", { name: "Report problem" }).click()
    await expect(stop(3).getByText("Sending")).toBeHidden()
    await expect(stop(3).getByRole("button", { name: "Complete" })).toBeEnabled()

    // The office's Live board has the route active, with the position the driver's actions carried.
    await expect
      .poll(async () => (await listAll<LiveRoute>(api, "/routes/live", { projectId: route.projectId })).find((candidate) => candidate.id === route.id), { timeout: 15_000 })
      .toMatchObject({ status: "active", lastLocation: { type: "Point" } })

    await page.getByRole("button", { name: "Pause" }).click()
    await expect(page.getByText("Paused", { exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Resume" }).click()
    await expect(page.getByRole("button", { name: "Pause" })).toBeEnabled()
    await expect(page.getByText("Paused", { exact: true })).toBeHidden()

    await page.getByRole("button", { name: "Record unload" }).click()
    await dialog.getByLabel("Net kg").fill("1180")
    await dialog.getByRole("button", { name: "Record unload" }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText("Sending")).toHaveCount(0)

    // Airplane mode, on the loaded page: taps still queue, the last read stays, and the banner counts what waits.
    await context.setOffline(true)
    await stop(3).getByRole("button", { name: "Complete" }).click()
    await stop(4).getByRole("button", { name: "Complete" }).click()
    await expect(page.getByText("Can't reach the server · 2 actions waiting")).toBeVisible()
    await expect(stop(3).getByText("Sending")).toBeVisible()
    await expect(stop(0).getByText("Completed", { exact: true })).toBeVisible()

    await context.setOffline(false)
    await expect(page.getByText(/Can't reach the server/)).toBeHidden({ timeout: 15_000 })
    await expect(stop(3).getByText("Completed", { exact: true })).toBeVisible()
    await expect(stop(4).getByText("Completed", { exact: true })).toBeVisible()

    const left = stops.length - 5
    await page.getByRole("button", { name: "End route" }).click()
    await expect(dialog).toContainText(`${left} ${left === 1 ? "stop" : "stops"} not done will be marked skipped`)
    await dialog.getByRole("button", { name: "End route" }).click()
    await expect(page.getByRole("region", { name: `Route ${route.label}` }).getByText("Completed", { exact: true })).toBeVisible()

    // One receipt per command and none twice: the start, an arrival, three outcomes, a weight, a note, a signature, a photo, a problem, pause, resume, an unload, two queued outcomes and the end.
    const token = await accessTokenOf(context)
    if (token === null) throw new Error("the driver's browser holds no API session")
    const asDriver = await apiAs(token)
    try {
      const receipts = await listAll<Receipt>(asDriver, "/driver/commands", { routeId: route.id })
      expect(receipts.map((receipt) => receipt.kind).sort()).toEqual(
        ["add-note", "add-photo", "add-signature", "add-weight", "arrive", "complete-pickup", "complete-pickup", "complete-pickup", "end-route", "fail-pickup", "pause", "record-unload", "report-problem", "resume", "skip-pickup", "start-route"].sort(),
      )
      expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(receipts.length)
      expect(receipts.every((receipt) => receipt.outcome === "applied")).toBe(true)
    } finally {
      await asDriver.dispose()
    }

    const done = await api.get(`/routes/${route.id}`)
    const ended = (await done.json()) as RouteDetail
    expect(ended.status).toBe("completed")
    // The stops as the driver worked them: the order the route reads in now, its Plan's, which can land after the first read above re-sequenced the stops.
    const worked = ordered(ended)
    expect(Object.fromEntries(worked.slice(0, 5).map((pickup, index) => [index, pickup.status]))).toEqual({ 0: "completed", 1: "skipped", 2: "failed", 3: "completed", 4: "completed" })
    expect(worked[0].arrivedAt, "the first stop's arrival").not.toBeNull()
    // The first stop's proofs carry the arrival, the weight and the note, as the office's details list them.
    const proofs = ((await (await api.get(`/pickups/${worked[0].id}`)).json()) as { proofs: { kind: string; weightKg: number | null; note: string | null }[] }).proofs
    expect(proofs.map((proof) => [proof.kind, proof.weightKg, proof.note])).toEqual(expect.arrayContaining([["arrival", null, null], ["weight", 212, null], ["note", null, "Lid cracked, still closes"], ["signature", null, null]]))

    // The office reads the signature and the failed stop's photo back from the private bucket, through URLs the API signs.
    for (const [index, type] of [
      [0, "image/png"],
      [2, "image/jpeg"],
    ] as const) {
      const links = (await (await api.get(`/pickups/${worked[index].id}/proof-objects`)).json()) as ProofObjectLinks
      expect(links.items, `stop ${index + 1}'s objects`).toHaveLength(1)
      const url = links.items[0].url
      if (url === null) throw new Error(`Storage holds no object for stop ${index + 1}`)
      const object = await fetch(url)
      expect([object.status, object.headers.get("content-type")]).toEqual([200, type])
    }
    // And sees the photo in the failed stop's details.
    const details = await openRoute(office, route)
    await details.getByTestId("route-stops").getByRole("button", { name: "Open stop" }).nth(2).click()
    const photo = office.getByRole("dialog", { name: /^Stop 3 · / }).getByTestId("pickup-commands").getByRole("img", { name: "The photo recorded at this stop" })
    await expect(photo).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)

    // Resolution heard of the failed stop and the reported problem, each a ticket on its stop.
    await expect
      .poll(async () => (await listAll<Ticket>(api, "/tickets", { routeId: route.id })).map((ticket) => ticket.links.pickupId), { timeout: 30_000 })
      .toEqual(expect.arrayContaining([worked[2].id, worked[3].id]))
  } finally {
    await context.close()
  }
})
