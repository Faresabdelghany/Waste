import { expect, freshContext, test } from "./fixtures"
import { uniqueName } from "./env"

// The public Drop-off Points end to end (Issue #293, M3b, ADR-0010). The
// administrator makes a project of its own through the API, publishes it, and
// registers three points there: an active recycling centre taking glass and
// metal, an active bring bank taking glass and open always, and a draft
// taking glass. A published guide item sorted as glass links to the map. A
// visitor with no session then looks the item up, follows "Where to hand it
// in" to the points taking glass — the centre and the bank, never the draft —
// opens every point, and finds the map not found once the project is
// unpublished. The shared tenant keeps the project, unpublished.

type Named = { id: string; name: string }
type Fraction = { id: string; key: string; name: string }

test("a visitor with no account follows the sorting guide to the drop-off points that take an item's fraction, and unpublished the map is not found", async ({ api, browser }) => {
  const created = await api.post("/projects", { data: { name: uniqueName("E2E drop-off"), kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen" } })
  expect(created.status()).toBe(201)
  const project = (await created.json()) as Named
  const slug = `e2e-drop-off-${Date.now().toString(36)}`
  expect((await api.patch(`/projects/${project.id}`, { data: { publicSlug: slug } })).status()).toBe(200)

  const fractions = ((await (await api.get("/waste-fractions", { params: { limit: 200 } })).json()) as { items: Fraction[] }).items
  const glass = fractions.find((fraction) => fraction.key === "glass")
  const metal = fractions.find((fraction) => fraction.key === "metal")
  expect(glass, "the seed holds glass").toBeDefined()
  expect(metal, "the seed holds metal").toBeDefined()

  const point = async (code: string, values: Record<string, unknown>) => {
    const response = await api.post("/drop-off-points", {
      data: { projectId: project.id, code, kind: "recycling-centre", address: `${code}, Kraftværksvej 31, 2300 København S`, location: { type: "Point", coordinates: [12.6105, 55.6521] }, ...values },
    })
    expect(response.status(), JSON.stringify(await response.json())).toBe(201)
  }
  await point("GS-E2E", {
    name: "Genbrugsstation E2E",
    status: "active",
    publicNote: "Husk ID.",
    wasteFractionIds: [glass!.id, metal!.id],
    hours: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((weekday) => ({ weekday, opensAt: "10:00", closesAt: "17:00" })),
  })
  await point("BB-E2E", { name: "Glascontainer E2E", kind: "bring-bank", status: "active", openAlways: true, wasteFractionIds: [glass!.id] })
  await point("GS-DRAFT", { name: "Kladde E2E", wasteFractionIds: [glass!.id] })
  const item = await api.post("/sorting-guide-items", { data: { projectId: project.id, name: "Syltetøjsglas", wasteFractionId: glass!.id, status: "published" } })
  expect(item.status()).toBe(201)

  const visitor = await freshContext(browser)
  try {
    const reader = await visitor.newPage()
    await reader.goto(`/p/${slug}/sorting?q=syltetøjsglas`)
    await reader.getByRole("link", { name: "Where to hand it in" }).click()
    await expect(reader).toHaveURL(new RegExp(`/p/${slug}/drop-off\\?fraction=glass$`))
    await expect(reader.getByRole("heading", { level: 1, name: "Drop-off points" })).toBeVisible()
    await expect(reader.getByText(`Points that take ${glass!.name}`)).toBeVisible()
    const cards = reader.getByRole("listitem")
    await expect(cards).toHaveCount(2)
    const centre = cards.filter({ has: reader.getByRole("heading", { name: "Genbrugsstation E2E" }) })
    await expect(centre).toContainText("Recycling centre")
    await expect(centre).toContainText("Today: 10:00–17:00")
    await expect(centre).toContainText("Husk ID.")
    await expect(centre.getByText(metal!.name)).toBeVisible()
    await expect(cards.filter({ has: reader.getByRole("heading", { name: "Glascontainer E2E" }) })).toContainText("Today: Open all day")
    await expect(reader.getByRole("heading", { name: "Kladde E2E" })).toHaveCount(0)
    await expect(reader.getByRole("region", { name: "Map of the drop-off points" })).toBeVisible()

    await reader.getByRole("link", { name: "Show every point" }).click()
    await expect(reader).toHaveURL(new RegExp(`/p/${slug}/drop-off$`))
    await expect(reader.getByRole("listitem")).toHaveCount(2)

    await reader.goto(`/p/${slug}/drop-off?fraction=metal`)
    await expect(reader.getByRole("listitem")).toHaveCount(1)

    await reader.goto(`/p/${slug}/drop-off?fraction=no-such-fraction`)
    await expect(reader.getByText("names no fraction this project knows. Here is every point.")).toBeVisible()
    await expect(reader.getByRole("listitem")).toHaveCount(2)

    expect((await api.patch(`/projects/${project.id}`, { data: { publicSlug: null } })).status()).toBe(200)
    await reader.goto(`/p/${slug}/drop-off`)
    await expect(reader.getByText("This page could not be found.")).toBeVisible()
  } finally {
    await visitor.close()
    await api.patch(`/projects/${project.id}`, { data: { publicSlug: null } })
  }
})
