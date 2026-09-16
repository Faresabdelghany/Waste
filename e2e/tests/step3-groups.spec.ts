import { expect, test } from "../fixtures"
import {
  BASELINE_SERVICE_TYPE,
  CLEAN_DRIVER,
  CLEAN_VEHICLE,
  buildBaselineScheme,
  fillGroup,
  fillRecurrence,
  fillScope,
  groupEditor,
  nextStep,
  openGroupEditor,
  pickOption,
  pill,
  saveGroup,
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
    serviceType: BASELINE_SERVICE_TYPE,
  })
  await nextStep(page)
  await fillRecurrence(page, { days: ["Tuesday"] })
  await nextStep(page)
  // Step 3 carries the scope in one muted line with its own Change link.
  await expect(wizard(page).getByText(`Organic · ${BASELINE_SERVICE_TYPE}`)).toBeVisible()
  const editor = await openGroupEditor(page)
  await expect(editor.getByTestId("group-fraction")).toHaveText("Organic")
  await expect(editor.getByText("Inherited", { exact: true })).toBeVisible()
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
    serviceType: BASELINE_SERVICE_TYPE,
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
  const row = root.getByRole("row").filter({ hasText: "Residual · bins" })
  await expect(row).toBeVisible()
  await expect(root.getByText(/\+\d+ \/ −\d+/)).toHaveCount(0)
  // No column-level estimate qualifier on step 3; the flag is per row — the
  // baseline's 140 L bins have no catalogue weight, so this row carries it.
  await expect(root.getByText("Estimate", { exact: true })).toHaveCount(0)
  await expect(row.getByText("Fallback weight")).toBeVisible()
  await row.getByRole("button", { name: "Edit Residual · bins" }).click()
  const editor = groupEditor(page)
  await expect(editor.getByText("Fallback weight")).toBeVisible()
  await editor.getByRole("button", { name: "Cancel" }).click()
  await expect(root.getByRole("alert")).toHaveCount(0)
  await nextStep(page)
  await expect(stepHeading(page)).toHaveText("How do the generated routes look?")
})

test("a group whose container types all have catalogue weights carries no Fallback weight badge", async ({
  page,
}) => {
  await startGuided(page)
  // Østerbro Zone 2 is the fixture area whose Residual bins are 240 L — the
  // one bin the asset catalogue weighs for Residual.
  await fillScope(page, {
    name: "Catalogue weights",
    project: "Copenhagen Central",
    area: "Østerbro Zone 2",
    fraction: "Residual",
    serviceType: BASELINE_SERVICE_TYPE,
  })
  await nextStep(page)
  await fillRecurrence(page, { days: ["Monday"] })
  await nextStep(page)
  const editor = await openGroupEditor(page)
  await fillGroup(page, {
    name: "Residual · 240 L",
    days: ["Monday"],
    vehicle: CLEAN_VEHICLE,
    driver: CLEAN_DRIVER,
    containerTypes: ["Two-wheel bin · 240 L"],
  })
  await expect(editor.getByText("Matching containers")).toBeVisible()
  await expect(editor.getByText("Fallback weight")).toHaveCount(0)
  await saveGroup(page)
  const row = wizard(page).getByRole("row").filter({ hasText: "Residual · 240 L" })
  await expect(row).toBeVisible()
  await expect(row.getByText("Fallback weight")).toHaveCount(0)
})

test("the group editor offers only the container types of the scheme's service type", async ({
  page,
}) => {
  await startGuided(page)
  await fillScope(page, {
    name: "Type restriction",
    project: "Copenhagen Central",
    area: "Indre By Operations",
    fraction: "Residual",
    serviceType: "Underground collection",
  })
  await nextStep(page)
  await fillRecurrence(page, { days: ["Monday"] })
  await nextStep(page)
  const editor = await openGroupEditor(page)
  await expect(pill(editor, "Underground · 5,000 L")).toBeVisible()
  await expect(pill(editor, "Two-wheel bin · 240 L")).toHaveCount(0)
  await expect(pill(editor, "Four-wheel bin · 660 L")).toHaveCount(0)
})

test("changing the service type on step 1 leaves an out-of-scope group as a blocking issue", async ({
  page,
}) => {
  await startGuided(page)
  // Amager Zone 1 is the fixture area whose seeded containers include
  // Residual 660 L bins, so the group resolves stops and only the
  // service-type issue remains after the switch.
  await fillScope(page, {
    name: "Kerbside switch",
    project: "Copenhagen Central",
    area: "Amager Zone 1",
    fraction: "Residual",
    serviceType: "Container collection",
  })
  await nextStep(page)
  await fillRecurrence(page, { days: ["Monday"] })
  await nextStep(page)
  await openGroupEditor(page)
  await fillGroup(page, {
    name: "Residual · medium bins",
    days: ["Monday"],
    vehicle: CLEAN_VEHICLE,
    driver: CLEAN_DRIVER,
    containerTypes: ["Four-wheel bin · 660 L"],
  })
  await saveGroup(page)
  const root = wizard(page)
  await expect(root.getByRole("alert")).toHaveCount(0)

  await root.getByRole("button", { name: "Change", exact: true }).click()
  await expect(stepHeading(page)).toHaveText("Which scope does this scheme plan for?")
  await fillScope(page, { serviceType: "Kerbside collection" })
  await nextStep(page)
  await nextStep(page)
  await expect(stepHeading(page)).toHaveText("Who collects what on which service days?")
  const message = "Residual · medium bins has container types outside Kerbside collection: 660 L"
  await expect(root.getByRole("alert")).toContainText(message)
  await root.getByRole("button", { name: "Next", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "1 issue blocks route generation" })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(message)
  await dialog.getByRole("button", { name: "Review groups" }).click()
  await expect(dialog).toBeHidden()
  // Steps 4–5 stay out of reach from the rail while the issue exists.
  await expect(root.getByRole("button", { name: /Route map/ })).toBeDisabled()
})
