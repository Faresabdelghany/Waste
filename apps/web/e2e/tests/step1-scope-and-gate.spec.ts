import { expect, test } from "../fixtures"
import { fillScope, nextButton, optionTexts, startGuided, wizard } from "../helpers/route-schemes"

test("step 1 asks for the real scope and has no Collection calendar", async ({ page }) => {
  await startGuided(page)
  const root = wizard(page)
  for (const label of [
    "Route scheme name",
    "Project",
    "Operational planning area",
    "Waste fraction",
    "Service type",
    "Departure depot",
    "Unloading station",
  ]) {
    await expect(root.getByLabel(label, { exact: true }), label).toBeVisible()
  }
  await expect(root.getByText("Operational defaults (optional)")).toBeVisible()
  await expect(root.getByText("Collection calendar")).toHaveCount(0)
})

test("step 1 gates on name, project, planning area, waste fraction, and service type", async ({
  page,
}) => {
  await startGuided(page)
  await expect(nextButton(page)).toBeDisabled()
  await fillScope(page, { name: "Gate check" })
  await expect(nextButton(page)).toBeDisabled()
  await fillScope(page, { project: "Copenhagen Central" })
  await expect(nextButton(page)).toBeDisabled()
  await fillScope(page, { area: "Indre By Operations" })
  await expect(nextButton(page)).toBeDisabled()
  await fillScope(page, { fraction: "Residual" })
  await expect(nextButton(page)).toBeDisabled()
  await fillScope(page, { serviceType: "Container collection" })
  await expect(nextButton(page)).toBeEnabled()
})

test("the service type offers the three collection types, nothing else", async ({ page }) => {
  await startGuided(page)
  expect(await optionTexts(page, wizard(page), "Service type")).toEqual([
    "Container collection",
    "Underground collection",
    "Kerbside collection",
  ])
})
