import type { Page } from "@playwright/test"

import { expect, freshContext, test } from "./fixtures"
import { uniqueName } from "./env"

// The Sorting Guide end to end (Issue #293, M1, ADR-0010). The administrator
// makes a project of its own through the API, then does the office's part in
// Settings › Sorting guide: publishes the project under the address the pane
// suggests, and adds a published item, a published item with no fraction and
// a draft. A visitor with no session at all then reads `/p/<slug>/sorting`
// in a fresh context: the sign-in gate lets the page through, the search
// finds the published items by synonym and through a typo, and never the
// draft. Unpublished from the pane, the same address is the not-found page.
// The shared tenant keeps the project, unpublished.

type Named = { id: string; name: string }

/** Picks an option of a labelled select in the pane or its dialog. */
async function choose(page: Page, label: string, option: string) {
  await page.getByLabel(label, { exact: true }).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

async function addItem(page: Page, values: { name: string; synonyms?: string; fraction?: string; instructions?: string; status?: string }) {
  await page.getByRole("button", { name: "New item" }).click()
  const dialog = page.getByRole("dialog", { name: "New item" })
  await dialog.getByLabel("Name").fill(values.name)
  if (values.synonyms !== undefined) await dialog.getByLabel("Also known as").fill(values.synonyms)
  if (values.fraction !== undefined) await choose(page, "Fraction", values.fraction)
  if (values.instructions !== undefined) await dialog.getByLabel("How to hand it in").fill(values.instructions)
  if (values.status !== undefined) await choose(page, "Status", values.status)
  await dialog.getByRole("button", { name: "Add item" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("row", { name: new RegExp(values.name) })).toBeVisible()
}

test("the office publishes a project's sorting guide from Settings, a visitor with no account searches it, and unpublished it is not found", async ({ api, page, browser }) => {
  const created = await api.post("/projects", { data: { name: uniqueName("E2E guide"), kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen" } })
  expect(created.status()).toBe(201)
  const project = (await created.json()) as Named

  await page.goto("/settings?pane=sorting-guide")
  await expect(page.getByRole("heading", { name: "Sorting guide" }).first()).toBeVisible()
  await choose(page, "Project", project.name)

  const address = page.getByLabel("Public address")
  await expect(address).toHaveValue(/^e2e-guide-/)
  const slug = await address.inputValue()
  await page.getByRole("button", { name: "Publish" }).click()
  const publicPath = `/p/${slug}/sorting`
  await expect(page.getByRole("link", { name: publicPath })).toBeVisible()

  await addItem(page, { name: "Glasflaske", synonyms: "vinflaske, syltetøjsglas", fraction: "Glass", instructions: "Skyl den. Låget i metal.", status: "Published" })
  await addItem(page, { name: "Batterier", synonyms: "knapcelle", status: "Published" })
  await addItem(page, { name: "Plastikpose" })
  await expect(page.getByRole("row", { name: /Plastikpose/ })).toContainText("Draft")

  const visitor = await freshContext(browser)
  try {
    const reader = await visitor.newPage()
    await reader.goto(publicPath)
    await expect(reader.getByRole("heading", { level: 1, name: "Sorting guide" })).toBeVisible()
    await expect(reader.getByText(project.name)).toBeVisible()
    await expect(reader.getByRole("main")).toHaveAttribute("lang", "da")

    const search = reader.getByRole("searchbox", { name: "What do you want to throw away?" })
    await search.fill("vinflaske")
    await search.press("Enter")
    await expect(reader).toHaveURL(new RegExp(`${publicPath}\\?q=vinflaske$`))
    const results = reader.getByRole("listitem")
    await expect(results).toHaveCount(1)
    await expect(results.first().getByRole("heading", { name: "Glasflaske" })).toBeVisible()
    await expect(results.first()).toContainText("Glass")
    await expect(results.first()).toContainText("Skyl den. Låget i metal.")
    await expect(results.first()).toContainText("Matched “vinflaske”")

    await reader.goto(`${publicPath}?q=batteir`)
    await expect(reader.getByRole("listitem").getByRole("heading", { name: "Batterier" })).toBeVisible()
    await expect(reader.getByRole("listitem")).toContainText("Not for a bin at home")

    await reader.goto(`${publicPath}?q=plastikpose`)
    await expect(reader.getByText("Nothing in the guide matches “plastikpose”")).toBeVisible()

    await page.getByRole("button", { name: "Unpublish" }).click()
    await expect(page.getByRole("button", { name: "Publish" })).toBeVisible()
    await reader.goto(publicPath)
    await expect(reader.getByText("This page could not be found.")).toBeVisible()
    await expect(reader.getByRole("heading", { name: "Sorting guide" })).toHaveCount(0)
  } finally {
    await visitor.close()
  }
})
