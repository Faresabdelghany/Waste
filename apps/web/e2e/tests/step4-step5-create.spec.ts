import { expect, test } from "../fixtures"
import {
  buildBaselineScheme,
  createButton,
  nextStep,
  optionTexts,
  pickOption,
  schemeRow,
  stepHeading,
  toasts,
  wizard,
} from "../helpers/route-schemes"

test("step 4 has no edited-route switch, labels the numbers as an estimate, and regenerates", async ({
  page,
}) => {
  await buildBaselineScheme(page, "Route map check")
  await nextStep(page)
  await expect(stepHeading(page)).toHaveText("How do the generated routes look?")
  const root = wizard(page)
  await expect(root.getByRole("switch")).toHaveCount(0)
  await expect(root.getByText("Keep manually edited routes")).toHaveCount(0)
  await expect(root.getByText("Edited")).toHaveCount(0)
  await expect(root.getByText("Estimate", { exact: true })).toBeVisible()
  await root.getByRole("button", { name: "Regenerate" }).click()
  await expect(root.getByText(/^Estimate · Regenerated \d{2}:\d{2}$/)).toBeVisible()
  // Verdict badges are information only — Next is never blocked by them.
  await expect(root.getByRole("button", { name: "Next", exact: true })).toBeEnabled()
})

test("step 5 offers the running-scheme edit policy, asking by default, and creates the scheme onto the list", async ({
  page,
}) => {
  const name = `Guided create ${Date.now().toString(36)}`
  await buildBaselineScheme(page, name)
  await nextStep(page)
  await nextStep(page)
  await expect(stepHeading(page)).toHaveText("Ready to create this scheme?")
  const root = wizard(page)
  await expect(root.getByLabel("Create as", { exact: true })).toBeVisible()
  // "Changes to a running scheme" (issue #38): the three policies in the
  // vocabulary's order, "Ask each time" the default; picking another one
  // changes what the field says it does.
  const editPolicy = root.getByLabel("Changes to a running scheme", { exact: true })
  await expect(editPolicy).toContainText("Ask each time")
  expect(await optionTexts(page, root, "Changes to a running scheme")).toEqual([
    "Ask each time",
    "Apply to future collections",
    "This collection only",
  ])
  await pickOption(page, root, "Changes to a running scheme", "This collection only")
  await expect(root.getByText("applies to the next collection only", { exact: false })).toBeVisible()
  await expect(root.getByText("Danish public holidays")).toBeVisible()
  await expect(root.getByText("Waste fraction")).toBeVisible()
  await expect(root.getByText("Service type")).toBeVisible()
  await expect(root.getByText("Kerbside collection", { exact: true })).toBeVisible()
  await createButton(page).click()
  await expect(root).toBeHidden()
  await expect(toasts(page)).toContainText(`Route scheme created as Validated — ${name}`)
  // The list scans by fraction: the Holiday list column gave way to Waste fraction.
  await expect(page.getByRole("columnheader", { name: "Waste fraction" })).toBeVisible()
  await expect(page.getByRole("columnheader", { name: "Holiday list" })).toHaveCount(0)
  const row = schemeRow(page, name)
  await expect(row).toBeVisible()
  await expect(row).toContainText("Residual")
})
