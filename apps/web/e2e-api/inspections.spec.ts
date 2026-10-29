// Field inspections and the driver's fill estimate on the web (M23a of #293).
// The office records an inspection of a property through Operate ›
// Inspections' own form — a minor finding, what was found — adds a photo in
// its details, which is signed, put to Storage and appended, and shown back,
// and closes it, after which nothing is offered. Then the seeded driver
// starts a dispatched route and records how full a stop's container was; the
// office reads it on the stop's details in Route Studio. The property is one
// the seed holds, picked by a name no other property shares; the route is
// ended again afterwards.
import type { Locator, Page } from "@playwright/test"
import { ID_RANDOM_BYTES, mintId } from "@waste/domain/ids"

import { dispatchedRouteFor, SEEDED_DRIVER } from "./dispatched-route"
import { E2E } from "./env"
import { accessTokenOf, apiAs, expect, freshContext, signIn, test } from "./fixtures"
import { answerOf, pick, toasts } from "./routes-support"
import { listAll } from "./tester"

type Property = { id: string; name: string }
type Inspection = { id: string; status: string; outcome: string; findings: string[]; photos: { objectKey: string }[] }

const fail = (why: string): never => {
  throw new Error(why)
}
const commandId = () => mintId(Date.now(), crypto.getRandomValues(new Uint8Array(ID_RANDOM_BYTES)))

/** Ticks the options of a multiselect in `dialog`, then closes its picker. */
async function pickMany(page: Page, dialog: Locator, field: string, options: readonly string[]) {
  await dialog.getByRole("combobox", { name: new RegExp(`^${field}`) }).click()
  for (const option of options) await page.getByRole("option", { name: option, exact: true }).click()
  await page.keyboard.press("Escape")
}

/** A one-pixel PNG: what the photo picker is handed, made a JPEG by the page as the Driver App makes its own. */
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")

test("an inspection of a property: recorded with its findings, photographed and closed in its details (M23a of #293)", async ({ page, api }) => {
  test.setTimeout(120_000)
  const properties = await listAll<Property>(api, "/properties")
  const counted = new Map<string, number>()
  for (const property of properties) counted.set(property.name, (counted.get(property.name) ?? 0) + 1)
  const property = properties.find((candidate) => counted.get(candidate.name) === 1) ?? fail("the seed has no property of a name its own")

  const loaded = answerOf(page, "GET", "/field-inspections")
  await page.goto("/operate?module=inspections")
  expect((await loaded).status()).toBe(200)
  await page.getByRole("button", { name: "Record inspection" }).click()
  const dialog = page.getByRole("dialog", { name: "Record an inspection" })
  await pick(dialog, page, "Property", property.name)
  await pick(dialog, page, "Verdict", "Minor finding")
  await pickMany(page, dialog, "Findings", ["Contamination", "Blocked access"])
  await dialog.getByRole("textbox", { name: /^Note/ }).fill("Garden waste in the residual; bins behind a parked car")
  const [created] = await Promise.all([answerOf(page, "POST", "/field-inspections"), dialog.getByRole("button", { name: "Record inspection" }).click()])
  expect(created.status(), await created.text()).toBe(201)
  expect(created.request().postDataJSON()).toEqual({ propertyId: property.id, outcome: "minor", findings: ["contamination", "blocked-access"], note: "Garden waste in the residual; bins behind a parked car" })
  const inspection = (await created.json()) as Inspection
  await expect(dialog).toBeHidden()

  await page.goto(`/operate?module=inspections&record=field-inspection-${inspection.id}`)
  const details = page.getByRole("dialog").filter({ has: page.getByTestId("inspection-commands") })
  const commands = details.getByTestId("inspection-commands")
  await expect(details).toContainText("Minor finding")
  await expect(commands.getByRole("button", { name: "Add photo" })).toBeEnabled({ timeout: 30_000 })
  const [appended] = await Promise.all([
    answerOf(page, "POST", `/field-inspections/${inspection.id}/photos`),
    commands.getByTestId("inspection-photo-file").setInputFiles({ name: "bin.png", mimeType: "image/png", buffer: PIXEL }),
  ])
  expect(appended.status(), await appended.text()).toBe(201)
  await expect(toasts(page)).toContainText("Photo added")
  await expect(commands.getByRole("img", { name: "Inspection photo" })).toBeVisible({ timeout: 30_000 })

  const [closed] = await Promise.all([answerOf(page, "POST", `/field-inspections/${inspection.id}/close`), commands.getByRole("button", { name: "Close" }).click()])
  expect(closed.status(), await closed.text()).toBe(200)
  await expect(commands).toContainText("Closed: the inspection changes no more.")
  await expect(commands.getByRole("button")).toHaveCount(0)
  const read = (await (await api.get(`/field-inspections/${inspection.id}`)).json()) as Inspection
  expect([read.status, read.photos.length]).toEqual(["closed", 1])
})

test("a stop's fill estimate: the driver records how full the container was, and the office reads it on the stop (M23a of #293)", async ({ page, api, browser }) => {
  test.setTimeout(120_000)
  const { route } = await dispatchedRouteFor(api)
  const vehicleId = route.planned.vehicleId ?? fail(`${route.label} has no vehicle`)
  const stop = route.pickups[0] ?? fail(`${route.label} has no stop`)
  const context = await freshContext(browser)
  try {
    const driverPage = await context.newPage()
    await signIn(driverPage, SEEDED_DRIVER.email, E2E.loginPassword)
    const asDriver = await apiAs((await accessTokenOf(context)) ?? fail("the driver's browser holds no API session"))
    try {
      const started = new Date().toISOString()
      const envelope = (kind: string, body: unknown, occurredAt: string) => ({ id: commandId(), kind, routeId: route.id, occurredAt, deviceId: "e2e-inspections", body })
      const sent = await asDriver.post("/driver/commands", {
        data: { commands: [envelope("start-route", { vehicleId }, started), envelope("record-fill", { pickupId: stop.id, fill: "overflowing" }, new Date(Date.parse(started) + 1_000).toISOString())] },
      })
      expect(sent.status()).toBe(200)
      expect(((await sent.json()) as { outcomes: { outcome: string }[] }).outcomes.map((outcome) => outcome.outcome)).toEqual(["applied", "applied"])
    } finally {
      await asDriver.dispose()
    }
  } finally {
    await context.close()
  }
  try {
    await page.goto(`/route-studio?module=pickups&record=pickup-${stop.id}`)
    const details = page.getByRole("dialog").filter({ has: page.getByTestId("pickup-commands") })
    await expect(details).toContainText("Fill estimate", { timeout: 30_000 })
    await expect(details).toContainText("Overflowing")
  } finally {
    // The driver holds one open session at a time: the office ends this route for the next test.
    await api.post(`/routes/${route.id}/cancel`, { data: { reasonCode: "other", reason: "Ended by the inspections end-to-end test" } })
  }
})
