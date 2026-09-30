import type { Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { uniqueName } from "./env"

// Slice 5b (#181): Resources › Containers and Fleet › Vehicle Planning on the
// API, through their command surfaces (components/waste/commands). A
// container is registered in the browser, received into a seeded warehouse,
// refused a second receipt in the API's own sentence, moved into
// maintenance and decommissioned, its ledger read back in its details and,
// without a reload, in Resources › Inventory, which the store reads again
// after each command (#198); an allocation is made over a window of its own,
// confirmed and released, its history read back. Records are uniquely named and never cleaned up; the
// released allocation frees its window, and each run picks another.
//
// The map's Containers list test stays in e2e/tests/map-planning.spec.ts: a
// server container has no location until a placement's property gives it
// one, which is #184's port (the plan on #81; #181's review).
type Container = { id: string; label: string; assetState: { status: string } | null }
type Allocation = { id: string; status: string; vehicleId: string }

/** The browser's API call the page makes: the answer of `method` on a path under `path`. */
const answerOf = (page: Page, method: string, path: RegExp) =>
  page.waitForResponse((response) => response.request().method() === method && path.test(new URL(response.url()).pathname.replace(/^\/waste-api/, "")))

/** Opens a workspace module and waits for its rows to arrive from the API. */
async function openLoaded(page: Page, url: string, listPath: RegExp) {
  const loaded = answerOf(page, "GET", listPath)
  await page.goto(url)
  expect((await loaded).status()).toBe(200)
}

/** Picks an option of a select field in the open dialog by the start of its label (a picker shows a row's status beside its name). */
async function pick(page: Page, field: string, option: RegExp) {
  await page.getByRole("dialog").getByRole("combobox", { name: new RegExp(`^${field}`) }).click()
  await page.getByRole("option", { name: option }).first().click()
}

/** Runs one of the details' commands through its dialog and answers the API's response. */
async function runCommand(page: Page, button: string, path: RegExp, fill: () => Promise<void> = async () => {}) {
  await page.getByTestId(/-commands$/).getByRole("button", { name: button, exact: true }).click()
  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: button }) })
  await expect(dialog).toBeVisible()
  await fill()
  const [response] = await Promise.all([answerOf(page, "POST", path), dialog.getByRole("button", { name: button, exact: true }).click()])
  return response
}

test("Containers: registered, received, refused a second receipt by sentence, moved to maintenance and decommissioned, the ledger read back", async ({ page, api }) => {
  const label = uniqueName("E2E-BIN").replace(/\s+/g, "-")
  // The ledger's reads: its first page each time, whatever the ledger's length on a long-lived stack.
  let ledgerReads = 0
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (request.method() === "GET" && url.pathname === "/waste-api/stock-movements" && !url.searchParams.has("cursor")) ledgerReads += 1
  })
  await openLoaded(page, "/resources?module=containers", /^\/containers$/)

  await page.getByRole("button", { name: "Add container" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "Add container" })).toBeVisible()
  await pick(page, "Operating project", /^Copenhagen Central/)
  await dialog.getByLabel("Container ID").fill(label)
  await pick(page, "Container type", /^Two-wheel bin · 240 L/)
  const [created] = await Promise.all([answerOf(page, "POST", /^\/containers$/), dialog.getByRole("button", { name: "Add container" }).click()])
  expect(created.status()).toBe(201)
  const container = (await created.json()) as Container
  expect(container).toMatchObject({ label, assetState: null })
  expect(created.headers()["location"]).toBe(`/containers/${container.id}`)

  // The new container's details open on the API's answer, as the generic create opens what it made.
  const details = page.getByRole("dialog").filter({ has: page.getByTestId("container-commands") })
  await expect(details.getByRole("heading", { name: label })).toBeVisible()
  await expect(details.getByText("No stock record").first()).toBeVisible()
  await expect(details.getByText("No stock movement yet.")).toBeVisible()

  const received = await runCommand(page, "Receive", new RegExp(`^/containers/${container.id}/receive$`), () => pick(page, "Warehouse", /^Nordhavn Warehouse/))
  expect(received.status()).toBe(201)
  await expect(details.getByText("In warehouse").first()).toBeVisible()

  // A second receipt of a container that has a stock record: the API's 409, told in its own words.
  const again = await runCommand(page, "Receive", new RegExp(`^/containers/${container.id}/receive$`), () => pick(page, "Warehouse", /^Warehouse West/))
  expect(again.status()).toBe(409)
  const refusal = (await again.json()) as { detail?: string }
  await expect(page.getByText(`${label} was not received`)).toBeVisible()
  await expect(page.getByText(refusal.detail ?? "")).toBeVisible()
  await page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Receive" }) }).getByRole("button", { name: "Cancel" }).click()

  const transferred = await runCommand(page, "Transfer", new RegExp(`^/containers/${container.id}/transfer$`), async () => {
    await pick(page, "Warehouse", /^Nordhavn Warehouse/)
    await pick(page, "Arrives in", /^Maintenance/)
  })
  expect(transferred.status()).toBe(201)
  await expect(details.getByText("In maintenance").first()).toBeVisible()

  const decommissioned = await runCommand(page, "Decommission", new RegExp(`^/containers/${container.id}/decommission$`), () =>
    page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Decommission" }) }).getByLabel("Reason").fill("E2E: burnt out"),
  )
  expect(decommissioned.status()).toBe(201)
  await expect(details.getByText("Retired").first()).toBeVisible()
  await expect(details.getByTestId("container-ledger").getByRole("listitem")).toHaveCount(3)

  const read = await api.get(`/containers/${container.id}`)
  expect(((await read.json()) as Container).assetState?.status).toBe("retired")

  // The ledger across containers holds the three movements in this session, its tab reached with no reload: the sign-in's read, and one again after each command the API took.
  await page.keyboard.press("Escape")
  await expect(details).toBeHidden()
  await page.getByRole("tab", { name: "Inventory" }).click()
  await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill(label)
  await expect(page.getByRole("button", { name: new RegExp(`^Open .+ · ${label}$`) })).toHaveCount(3)
  expect(ledgerReads).toBe(4)
})

test("Vehicle Planning: allocated over a window of its own, confirmed and released, the history read back", async ({ page, api }) => {
  // A day far enough ahead, and apart per run, that no live allocation of an earlier run holds the vehicle then.
  // A run that died between allocate and release leaves its day reserved; the next run drawing that day
  // (about 1 in 3,000) meets the API's overlap 409 at "Allocate" — a leftover of the stack, not a defect.
  const day = new Date(Date.UTC(2031 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28)))
  const date = day.toISOString().slice(0, 10)
  const note = uniqueName("E2E allocation")
  await openLoaded(page, "/fleet?module=vehicle-planning", /^\/vehicle-allocations$/)

  await page.getByRole("button", { name: "Plan allocation" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "Allocate a vehicle" })).toBeVisible()
  await pick(page, "Project", /^Copenhagen Central/)
  await pick(page, "Vehicle", /^WH-31/)
  await dialog.getByLabel("Planned start").fill(`${date}T06:00`)
  await dialog.getByLabel("Planned end").fill(`${date}T14:00`)
  await dialog.getByLabel("Note").fill(note)
  const [created] = await Promise.all([answerOf(page, "POST", /^\/vehicle-allocations$/), dialog.getByRole("button", { name: "Allocate" }).click()])
  expect(created.status()).toBe(201)
  const allocation = (await created.json()) as Allocation
  expect(allocation.status).toBe("planned")

  // The new allocation's details open on the API's answer: its day and its vehicle, its window on the project's clock.
  const details = page.getByRole("dialog").filter({ has: page.getByTestId("allocation-commands") })
  await expect(details.getByRole("heading", { name: new RegExp(`^${day.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} · WH-31`) })).toBeVisible()
  await expect(details.getByText(`${date} 06:00 – ${date} 14:00`)).toBeVisible()

  const [confirmed] = await Promise.all([answerOf(page, "POST", new RegExp(`^/vehicle-allocations/${allocation.id}/confirm$`)), details.getByRole("button", { name: "Confirm", exact: true }).click()])
  expect(confirmed.status()).toBe(200)
  await expect(details.getByText("Confirmed").first()).toBeVisible()

  const released = await runCommand(page, "Release", new RegExp(`^/vehicle-allocations/${allocation.id}/release$`), () =>
    page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Release allocation" }) }).getByLabel("Reason").fill("E2E: the run is over"),
  )
  expect(released.status()).toBe(200)
  await expect(details.getByText("Released").first()).toBeVisible()
  await expect(details.getByTestId("allocation-history").getByRole("listitem")).toHaveCount(3)

  const events = await api.get(`/vehicle-allocations/${allocation.id}/events`)
  expect(((await events.json()) as { items: { action: string }[] }).items.map((event) => event.action)).toEqual(["allocate", "confirm", "release"])
})
