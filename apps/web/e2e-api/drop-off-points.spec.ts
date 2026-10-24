import type { Page } from "@playwright/test"

import { E2E, uniqueName } from "./env"
import { chainLanded, expect, test } from "./fixtures"

// Resources › Drop-off Points on the API (Issue #293, M3c). The office
// registers a recycling centre through the generic form — what it takes from
// the master module, its weekly hours and an exception typed as text — and it
// lands on the wire as the point and its three sets. A line the domain refuses
// is told in the domain's words, the dialog kept open. An edit of the hours alone is
// that set's own PUT and nothing else. Published, the project's map answers
// the point by the fraction a Sorting Guide answer names. The shared tenant
// keeps the point, closed, and the project as it found it.

type WasteFraction = { id: string; key: string; name: string }
type DropOffPoint = { id: string; projectId: string; code: string; name: string; status: string; closedOnHolidays: boolean; wasteFractionIds: string[]; hours: { weekday: string; opensAt: string; closesAt: string }[]; exceptions: { date: string; note: string | null }[] }

const answerOf = (page: Page, method: string, path: string) =>
  page.waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname.startsWith(`/waste-api${path}`))

const uniqueCode = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1296).toString(36).toUpperCase()}`

test("the office registers a drop-off point with what it takes, its hours and an exception, edits its hours alone, and the published map finds it by fraction", async ({ page, api }) => {
  const { items } = (await (await api.get("/waste-fractions?limit=200")).json()) as { items: WasteFraction[] }
  const glass = items.find((fraction) => fraction.key === "glass")
  const metal = items.find((fraction) => fraction.key === "metal")
  expect(glass && metal, "the seed holds glass and metal").toBeTruthy()

  const loaded = answerOf(page, "GET", "/drop-off-points")
  await page.goto("/resources?module=drop-off-points")
  expect((await loaded).status()).toBe(200)
  await chainLanded(page)

  const name = uniqueName("E2E Genbrugsstation")
  const code = uniqueCode("GS")
  await page.getByRole("button", { name: "Save drop-off point" }).click()
  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "New drop-off point" }) })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("textbox", { name: /^Name\*?$/ }).fill(name)
  await dialog.getByRole("textbox", { name: /^Code\*?$/ }).fill(code)
  await dialog.getByRole("combobox", { name: /^Status/ }).click()
  await page.getByRole("option", { name: "Active — on the public map" }).click()
  await dialog.getByLabel("Address").fill("Kraftværksvej 31, 2300 København S")
  await dialog.getByLabel("Latitude").fill("55.6521")
  await dialog.getByLabel("Longitude").fill("12.6105")
  await dialog.getByRole("combobox", { name: /^Takes/ }).click()
  await page.getByRole("option", { name: glass!.name }).click()
  await page.getByRole("option", { name: metal!.name }).click()
  await page.keyboard.press("Escape")
  await dialog.getByLabel("Closed on the project's holidays").check()
  await dialog.getByLabel("Note on the public map").fill("Husk ID.")

  // A line the domain refuses is told in the form, in its words, and nothing is sent.
  await dialog.getByLabel("Weekly hours").fill("Mon 18:00–10:00")
  await dialog.getByRole("button", { name: "Save drop-off point" }).click()
  await expect(page.getByText(`${name} was not saved`)).toBeVisible()
  await expect(page.getByText("Monday: a window must open before it closes (18:00–10:00)")).toBeVisible()
  await expect(dialog, "the dialog stays open on a refusal").toBeVisible()

  await dialog.getByLabel("Weekly hours").fill("Mon–Fri 10:00–18:00\nSat 09:00–12:00, 13:00–17:00")
  await dialog.getByLabel("Exceptions").fill("2099-12-24 09:00–12:00 Juleaften")
  const [created] = await Promise.all([answerOf(page, "POST", "/drop-off-points"), dialog.getByRole("button", { name: "Save drop-off point" }).click()])
  expect(created.status()).toBe(201)
  const point = (await created.json()) as DropOffPoint
  expect(point).toMatchObject({ code, name, status: "active", closedOnHolidays: true })
  expect([...point.wasteFractionIds].sort()).toEqual([glass!.id, metal!.id].sort())
  expect(point.hours).toHaveLength(7)
  expect(point.exceptions).toEqual([{ date: "2099-12-24", opensAt: "09:00", closesAt: "12:00", note: "Juleaften" }])

  try {
    // The hours alone: their own PUT and nothing else. The saved point opens in its sheet.
    const sheet = page.getByRole("dialog").filter({ hasText: name })
    await expect(sheet.getByText("Glass · Metal")).toBeVisible()
    await sheet.getByRole("button", { name: `Actions for ${name}` }).click()
    await page.getByRole("menuitem", { name: /^Edit/ }).click()
    const edit = page.getByRole("dialog").filter({ has: page.getByLabel("Weekly hours") })
    await edit.getByLabel("Weekly hours").fill("Mon–Fri 10:00–17:00")
    const requests: string[] = []
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/waste-api/drop-off-points") && request.method() !== "GET") requests.push(`${request.method()} ${new URL(request.url()).pathname.replace("/waste-api", "")}`)
    })
    const [rehoured] = await Promise.all([answerOf(page, "PUT", `/drop-off-points/${point.id}/hours`), edit.getByRole("button", { name: /^Save/ }).click()])
    expect(rehoured.status()).toBe(200)
    expect(((await rehoured.json()) as DropOffPoint).hours).toHaveLength(5)
    expect(requests).toEqual([`PUT /drop-off-points/${point.id}/hours`])

    // Published, the map answers it by the guide's fraction key; the project's own slug is put back after.
    const before = ((await (await api.get(`/projects/${point.projectId}`)).json()) as { publicSlug: string | null }).publicSlug
    const slug = before ?? `e2e-drop-off-office-${Date.now().toString(36)}`
    try {
      if (before === null) expect((await api.patch(`/projects/${point.projectId}`, { data: { publicSlug: slug } })).status()).toBe(200)
      const map = (await (await api.get(`${E2E.apiUrl}/public/${slug}/drop-off-points?fraction=metal`)).json()) as { points: { id: string; publicNote: string | null }[] }
      expect(map.points.find((entry) => entry.id === point.id)?.publicNote).toBe("Husk ID.")
    } finally {
      if (before === null) await api.patch(`/projects/${point.projectId}`, { data: { publicSlug: null } })
    }
  } finally {
    await api.patch(`/drop-off-points/${point.id}`, { data: { status: "closed" } })
  }
})
