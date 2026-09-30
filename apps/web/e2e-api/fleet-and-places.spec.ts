import type { APIRequestContext, Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { uniqueName } from "./env"

// Slice 5a of #81 (Issue #180): the fleet and the places read from and
// written to the API through the generic workspace. No fixture spec covers
// these panes, so what is said here is what a browser behaviour warrants: the
// seeded catalogue is the API's rows spelled as the fixtures spelled them,
// with Lars Møller's expired licence kept literal for the licence rule to
// judge; a warehouse is created in the browser with its `Location`, read
// back under the browser's own token, and a code taken meanwhile is refused
// in the API's sentence; an unloading station's accepted fractions are picked
// from the master module by id and land on the wire as the set.
type Project = { id: string; name: string }
type Warehouse = { id: string; projectId: string; code: string; name: string; address: string; depotId: string | null; status: string }
type UnloadingStation = { id: string; code: string; name: string; ownership: string; weighbridge: boolean; wasteFractionIds: string[] }
type WasteFraction = { id: string; key: string; name: string }

/** The browser's API call the form submit makes: the answer of the request path `path`, method `method`. */
const answerOf = (page: Page, method: string, path: string) =>
  page.waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname.startsWith(`/waste-api${path}`))

/** Opens a workspace page and waits for the switched module's rows to arrive from the API. */
async function openLoaded(page: Page, url: string, listPath: string) {
  const loaded = answerOf(page, "GET", listPath)
  await page.goto(url)
  expect((await loaded).status()).toBe(200)
}

/** The row's opener, after narrowing the list to the name through the module's own search. */
async function rowNamed(page: Page, name: string) {
  await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill(name)
  return page.getByRole("button", { name: `Open ${name}` })
}

/** A code no other run has used: the tenant is shared and nothing is cleaned up. */
const uniqueCode = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1296).toString(36).toUpperCase()}`

async function copenhagen(api: APIRequestContext): Promise<Project> {
  const listed = await api.get("/projects?limit=200")
  expect(listed.status()).toBe(200)
  const { items } = (await listed.json()) as { items: Project[] }
  const project = items.find((candidate) => candidate.name === "Copenhagen Central")
  expect(project).toBeDefined()
  return project as Project
}

test("Fleet: the seeded vehicles and drivers are the API's rows, spelled as the fixtures were, the expired licence kept literal", async ({ page }) => {
  await openLoaded(page, "/fleet?module=vehicles", "/vehicles")
  // The workspace's table rows are the row's opener, a button named after it.
  const wh24 = page.getByRole("button", { name: "Open WH-24 · CN 42 018" })
  await expect(wh24).toContainText("Rear loader 18 t · Nordhavn Depot")
  await expect(wh24).toContainText("Residual · Mixed")
  await expect(wh24).toContainText("HVO")
  await expect(page.getByRole("button", { name: "Open NR-08 · AB 51 912" })).toContainText("NordRen ApS")
  await expect(page.getByRole("button", { name: "Open WH-T12 · TR 12 012" })).toContainText("Closed trailer 18 t · Nordhavn Depot")
  // The row's sheet is the wire's facts; the id is the server's from the start.
  await wh24.click()
  await expect(page).toHaveURL(/record=vehicle-[0-9a-f-]{36}/)
  const sheet = page.getByRole("dialog")
  await expect(sheet.getByText("Required licence class")).toBeVisible()
  await expect(sheet.getByText("Nordhavn Depot")).toBeVisible()
  await page.keyboard.press("Escape")

  await openLoaded(page, "/fleet?module=drivers", "/drivers")
  await (await rowNamed(page, "Lars Møller")).click()
  const lars = page.getByRole("dialog")
  await expect(lars.getByText("C · valid to 2026-09-05")).toBeVisible()
  await expect(lars.getByText("NordRen ApS").first()).toBeVisible()
  await page.keyboard.press("Escape")
  await (await rowNamed(page, "Jonas Lind")).click()
  await expect(page.getByRole("dialog").getByText("Not on record")).toBeVisible()
})

async function createWarehouse(page: Page, values: { name: string; code: string; address: string }) {
  // The toolbar's button carries the form's submit label, as the other workspaces' do.
  await page.getByRole("button", { name: "Create warehouse" }).click()
  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Create warehouse" }) })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel("Warehouse name").fill(values.name)
  await dialog.getByLabel("Warehouse code").fill(values.code)
  await dialog.getByLabel("Address").fill(values.address)
  const [response] = await Promise.all([answerOf(page, "POST", "/warehouses"), dialog.getByRole("button", { name: "Create warehouse" }).click()])
  return response
}

test("Warehouses: created in the browser with Location, read back, and a code taken meanwhile refused by sentence", async ({ page, api }) => {
  const project = await copenhagen(api)
  const name = uniqueName("E2E Warehouse")
  const code = uniqueCode("WH")
  await openLoaded(page, "/resources?module=warehouses", "/warehouses")

  const created = await createWarehouse(page, { name, code, address: "Logistikvej 12, Valby" })
  expect(created.status()).toBe(201)
  const body = (await created.json()) as Warehouse
  expect(created.headers()["location"]).toBe(`/warehouses/${body.id}`)
  expect(body).toMatchObject({ projectId: project.id, code, name, address: "Logistikvej 12, Valby", depotId: null, status: "draft" })
  const read = await api.get(`/warehouses/${body.id}`)
  expect(read.status()).toBe(200)
  expect(await read.json()).toEqual(body)

  // A code somebody else takes after this page loaded: the form cannot know, the API's 409 is told in its sentence, and the row is gone.
  await openLoaded(page, "/resources?module=warehouses", "/warehouses")
  const taken = uniqueCode("WH")
  const elsewhere = await api.post("/warehouses", { data: { projectId: project.id, code: taken, name: uniqueName("E2E Elsewhere Warehouse"), address: "Elsewhere 1" } })
  expect(elsewhere.status()).toBe(201)
  const otherName = uniqueName("E2E Duplicate Warehouse")
  const refused = await createWarehouse(page, { name: otherName, code: taken, address: "Elsewhere 2" })
  expect(refused.status()).toBe(409)
  await expect(page.getByText(`${otherName} was not saved`)).toBeVisible()
  await expect(page.getByText(`This project already has a warehouse coded "${taken}"`)).toBeVisible()
  await openLoaded(page, "/resources?module=warehouses", "/warehouses")
  await expect(await rowNamed(page, name)).toBeVisible()
  await expect(await rowNamed(page, otherName)).toHaveCount(0)
})

test("Depots & Unloading: an unloading station's accepted fractions are picked from the master module and land on the wire as the set", async ({ page, api }) => {
  const fractions = await api.get("/waste-fractions?limit=200")
  expect(fractions.status()).toBe(200)
  const { items } = (await fractions.json()) as { items: WasteFraction[] }
  const byKey = (key: string) => items.find((fraction) => fraction.key === key)
  expect(byKey("glass")).toBeDefined()
  expect(byKey("paper")).toBeDefined()

  await openLoaded(page, "/resources?module=depots", "/unloading-stations")
  await expect(page.getByRole("button", { name: "Open ARC Amager" })).toContainText("Unloading station · external")
  await expect(page.getByRole("button", { name: "Open Nordhavn Depot" })).toContainText("Depot · Copenhagen Central")

  const name = uniqueName("E2E Station")
  const code = uniqueCode("ST")
  await page.getByRole("button", { name: "Create draft location" }).click()
  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Create depot or unloading station" }) })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("combobox", { name: /^Location type/ }).click()
  await page.getByRole("option", { name: "Unloading or disposal station" }).click()
  await dialog.getByLabel("Location name").fill(name)
  await dialog.getByLabel("Location code").fill(code)
  await dialog.getByLabel("Address").fill("Prøvestenen 4")
  await dialog.getByLabel("Latitude").fill("55.6801")
  await dialog.getByLabel("Longitude").fill("12.6302")
  await dialog.getByRole("combobox", { name: /^Ownership/ }).click()
  await page.getByRole("option", { name: "External facility" }).click()
  await dialog.getByLabel("Operating hours").fill("07:00–15:00")
  await dialog.getByRole("combobox", { name: /^Accepted waste fractions/ }).click()
  await page.getByRole("option", { name: "Glass" }).click()
  await page.getByRole("option", { name: "Paper" }).click()
  await page.keyboard.press("Escape")
  const [response] = await Promise.all([answerOf(page, "POST", "/unloading-stations"), dialog.getByRole("button", { name: "Create draft location" }).click()])
  expect(response.status()).toBe(201)
  const station = (await response.json()) as UnloadingStation
  expect(station).toMatchObject({ code, name, ownership: "external", weighbridge: false })
  expect([...station.wasteFractionIds].sort()).toEqual([byKey("glass")?.id, byKey("paper")?.id].sort())
  const read = await api.get(`/unloading-stations/${station.id}`)
  expect(read.status()).toBe(200)
  expect(((await read.json()) as UnloadingStation).wasteFractionIds.length).toBe(2)
})
