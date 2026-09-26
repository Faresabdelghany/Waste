import { PREVIEW_HORIZON_MONTHS } from "@waste/domain/route-schemes/occurrences"
import { todayIso } from "@waste/domain/route-schemes/recurrence"

import { expect, test } from "../fixtures"
import {
  BASELINE_SERVICE_TYPE,
  backStep,
  buildBaselineScheme,
  fillRecurrence,
  fillScope,
  nextDatesRows,
  nextStep,
  pickOption,
  startGuided,
  stepHeading,
  wizard,
} from "../helpers/route-schemes"

// Issue #40 — the three screens the 2026-09-16 prototype sketched and the
// shipped wizard lacked: View all (step 2), Simulate next N occurrences
// (step 2), What changed (step 5).

async function toDecemberStep2(page: Parameters<typeof startGuided>[0]) {
  await startGuided(page)
  await fillScope(page, {
    name: "Issue 40",
    project: "Copenhagen Central",
    area: "Indre By Operations",
    fraction: "Residual",
    serviceType: BASELINE_SERVICE_TYPE,
  })
  await nextStep(page)
  await expect(stepHeading(page)).toHaveText("When does this scheme collect?")
  // Mon–Fri from Mon 21 Dec 2026, open-ended, holidays skipped (the default).
  await fillRecurrence(page, {
    effectiveFrom: "2026-12-21",
    days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
  })
}

test("View all opens every next date in its own dialog, beyond the table's first rows", async ({
  page,
}) => {
  await toDecemberStep2(page)
  const root = wizard(page)
  // The table shows eight; the preview holds a year of weekdays.
  await expect(nextDatesRows(page)).toHaveCount(8)
  await expect(root.getByText(/^Showing 1–8 of \d{3}$/)).toBeVisible()
  await root.getByRole("button", { name: "View all", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "All next dates" })
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByText(
      new RegExp(`^\\d{3} collections · the next ${PREVIEW_HORIZON_MONTHS} months · \\d+ skipped holidays$`),
    ),
  ).toBeVisible()
  const rows = dialog.getByRole("row").filter({ has: page.locator("td") })
  expect(await rows.count()).toBeGreaterThan(200)
  // The rows are the preview's rows: the first is Mon 21 Dec, and the
  // fixture's Christmas Day (Fri 25 Dec) is skipped.
  await expect(rows.first()).toContainText("21 Dec 2026")
  await expect(rows.filter({ hasText: "Skipped · Christmas Day" })).toHaveCount(1)
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click()
  await expect(dialog).toBeHidden()
})

test("Simulate next N occurrences shows the delta of a candidate change and applies it", async ({
  page,
}) => {
  await toDecemberStep2(page)
  const root = wizard(page)
  await root.getByRole("button", { name: "Simulate next 10 occurrences" }).click()
  const panel = root.getByTestId("simulation-panel")
  await expect(panel).toBeVisible()
  await expect(panel.getByText("Change something above to compare")).toBeVisible()
  await expect(panel.getByTestId("simulation-summary")).toHaveText(/10 collections10 collections/)

  // A candidate keeps step 2's bounds: its start may not be before today. The
  // simulation still shows what such a change would do, but Apply refuses
  // and says why; Reset drops the candidate and the reason with it.
  const candidateFrom = panel.getByLabel("Effective from", { exact: true })
  await expect(candidateFrom).toHaveAttribute("min", todayIso())
  await candidateFrom.fill("2020-01-06")
  await expect(panel.getByTestId("simulation-issue")).toHaveText("Effective from cannot be before today")
  await expect(candidateFrom).toHaveAttribute("aria-invalid", "true")
  await expect(panel.getByRole("button", { name: "Apply to draft" })).toBeDisabled()
  await panel.getByRole("button", { name: "Reset to draft" }).click()
  await expect(panel.getByTestId("simulation-issue")).toHaveCount(0)
  await expect(candidateFrom).toHaveValue("2026-12-21")

  // Skip → shift-next: the fixture list holds Christmas Day (Fri 25 Dec) and
  // New Year's Day (Fri 1 Jan) inside the first ten collections; both become
  // collections again, on the next working day.
  await pickOption(page, panel, "On a public holiday", "Shift to the next working day")
  await expect(panel.getByTestId("simulation-summary")).toContainText("12 collections")
  await expect(panel.getByText("2 added")).toBeVisible()
  const rows = panel.getByRole("row").filter({ has: page.locator("td") })
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText("Fri 25 Dec")
  await expect(rows.first()).toContainText("Skipped")
  await expect(rows.first()).toContainText("28 Dec 2026")
  await expect(rows.first()).toContainText("Added")
  await expect(panel.getByText("2 changed dates of 12")).toBeVisible()

  // Every date, then back to the changes.
  await panel.getByRole("button", { name: "Show every date" }).click()
  await expect(rows).toHaveCount(12)
  await panel.getByRole("button", { name: "Show changes only" }).click()
  await expect(rows).toHaveCount(2)

  // A wider horizon widens the span.
  await pickOption(page, panel, "Next", "20 occurrences")
  await expect(panel.getByRole("heading", { name: "Simulate next 20 occurrences" })).toBeVisible()

  // Apply writes the candidate into the draft: the table above follows, and
  // the simulation has nothing left to compare.
  await panel.getByRole("button", { name: "Apply to draft" }).click()
  await expect(root.getByLabel("On a public holiday", { exact: true }).first()).toContainText(
    "Shift to the next working day",
  )
  await expect(nextDatesRows(page).filter({ hasText: "Shifted from Fri 25 Dec · Christmas Day" })).toHaveCount(1)
  await expect(panel.getByText("Change something above to compare")).toBeVisible()
  await panel.getByRole("button", { name: "Close simulation" }).click()
  await expect(panel).toBeHidden()
})

test("What changed reads the draft against the start, then against the last review", async ({
  page,
}) => {
  await buildBaselineScheme(page, "What changed check")
  await nextStep(page)
  await nextStep(page)
  await expect(stepHeading(page)).toHaveText("Ready to create this scheme?")
  const root = wizard(page)
  const section = root.getByTestId("what-changed")
  await expect(section).toBeVisible()
  // Against the blank draft the wizard opened with: every filled field is a change.
  await expect(section.getByText("Since you started", { exact: false })).toBeVisible()
  await expect(section.getByRole("group", { name: "Compare against" })).toHaveCount(0)
  const nameRow = section.locator("dt", { hasText: "Name" }).locator("..")
  await expect(nameRow).toContainText("—")
  await expect(nameRow).toContainText("What changed check")
  await expect(section.locator("dt", { hasText: "Residual · bins" }).locator("..")).toContainText("Added")

  // Leave the review, change the holiday policy on step 2, come back: the
  // diff compares against this review by default and shows the one change.
  await backStep(page)
  await backStep(page)
  await backStep(page)
  await expect(stepHeading(page)).toHaveText("When does this scheme collect?")
  await fillRecurrence(page, { holidayPolicy: "Collect as planned" })
  await nextStep(page)
  await nextStep(page)
  await nextStep(page)
  await expect(stepHeading(page)).toHaveText("Ready to create this scheme?")
  await expect(section.getByRole("button", { name: "Since last review" })).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await expect(section.getByText("1 change", { exact: true })).toBeVisible()
  const policyRow = section.locator("dt", { hasText: "On a public holiday" }).locator("..")
  await expect(policyRow).toContainText("Skip the collection")
  await expect(policyRow).toContainText("Collect as planned")
  await expect(section.locator("dt", { hasText: "Name" })).toHaveCount(0)

  // Against the start again on request.
  await section.getByRole("button", { name: "Since you started" }).click()
  await expect(section.locator("dt", { hasText: "Name" })).toHaveCount(1)
})
