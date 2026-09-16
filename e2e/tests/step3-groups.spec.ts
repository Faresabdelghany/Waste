import { expect, test } from "../fixtures"
import {
  CLEAN_DRIVER,
  CLEAN_VEHICLE,
  buildBaselineScheme,
  fillRecurrence,
  fillScope,
  nextStep,
  openGroupEditor,
  pickOption,
  startGuided,
  stepHeading,
  wizard,
} from "../helpers/route-schemes"

test("the group editor shows the inherited fraction read-only with a Change link back to step 1", async ({
  page,
}) => {
  await startGuided(page)
  await fillScope(page, {
    name: "Inherited fraction",
    project: "Copenhagen Central",
    area: "Indre By Operations",
    fraction: "Organic",
  })
  await nextStep(page)
  await fillRecurrence(page, { days: ["Tuesday"] })
  await nextStep(page)
  const editor = await openGroupEditor(page)
  await expect(editor.getByTestId("group-fraction")).toHaveText("Organic")
  await expect(editor.getByRole("combobox", { name: "Waste fraction" })).toHaveCount(0)
  await expect(editor.getByText("Manual adjustments")).toHaveCount(0)
  await editor.getByRole("button", { name: "Change" }).click()
  await expect(editor).toBeHidden()
  await expect(stepHeading(page)).toHaveText("Which scope does this scheme plan for?")
  await expect(wizard(page).getByLabel("Waste fraction", { exact: true })).toContainText("Organic")
})

test("a driver without a licence on record is listed but cannot be selected", async ({ page }) => {
  await startGuided(page)
  await fillScope(page, {
    name: "Licence gate",
    project: "Copenhagen Central",
    area: "Indre By Operations",
    fraction: "Residual",
  })
  await nextStep(page)
  await fillRecurrence(page, { days: ["Monday"] })
  await nextStep(page)
  const editor = await openGroupEditor(page)
  await expect(editor.getByLabel("Default driver", { exact: true })).toBeDisabled()
  await pickOption(page, editor, "Vehicle", CLEAN_VEHICLE)
  await editor.getByLabel("Default driver", { exact: true }).click()
  const unlicensed = page.getByRole("option", { name: /Jonas Lind · No licence on record/ })
  await expect(unlicensed).toBeVisible()
  await expect(unlicensed).toHaveAttribute("aria-disabled", "true")
  await expect(page.getByRole("option", { name: CLEAN_DRIVER })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  )
  await page.getByRole("option", { name: CLEAN_DRIVER }).click()
  await expect(editor.getByLabel("Default driver", { exact: true })).toContainText("Freja Nielsen")
})

test("a complete group clears step 3 and the Containers cell carries no +/− counters", async ({
  page,
}) => {
  await buildBaselineScheme(page, "Baseline groups")
  const root = wizard(page)
  await expect(root.getByRole("row").filter({ hasText: "Residual · bins" })).toBeVisible()
  await expect(root.getByText(/\+\d+ \/ −\d+/)).toHaveCount(0)
  await expect(root.getByText("Estimate", { exact: true })).toBeVisible()
  await expect(root.getByRole("alert")).toHaveCount(0)
  await nextStep(page)
  await expect(stepHeading(page)).toHaveText("How do the generated routes look?")
})
