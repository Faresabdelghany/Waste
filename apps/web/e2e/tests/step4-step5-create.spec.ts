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

// Step 4's map is e2e/wizard-preview-geometry.spec.ts's (#173): in fixture
// mode no road is asked for, and the preview's road and the quota's
// estimate are the API's readings, in e2e-api.

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
  // The Scheme & scope section lists the fraction and the service type; the
  // What changed section below lists them too (they were blank at the
  // start), so read the review section's own rows.
  const scope = root.getByRole("heading", { name: "Scheme & scope" }).locator("xpath=ancestor::section[1]")
  await expect(scope.getByText("Waste fraction")).toBeVisible()
  await expect(scope.getByText("Service type")).toBeVisible()
  await expect(scope.getByText("Kerbside collection", { exact: true })).toBeVisible()
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
