import { expect, test } from "../fixtures"
import {
  fillRecurrence,
  fillScope,
  holidaySourceLine,
  nextDatesRows,
  nextStep,
  optionTexts,
  startGuided,
  stepHeading,
  wizard,
} from "../helpers/route-schemes"

const HOLIDAY_SETTINGS_HREF = "/settings?pane=operations-setup"

async function toStep2(page: Parameters<typeof startGuided>[0], project: string) {
  await startGuided(page)
  await fillScope(page, {
    name: `Holidays · ${project}`,
    project,
    area: project === "Copenhagen Central" ? "Indre By Operations" : "Nordhavn Harbor Area",
    fraction: "Residual",
  })
  await nextStep(page)
  await expect(stepHeading(page)).toHaveText("When does this scheme collect?")
}

test("the holiday source follows the project and links to Settings", async ({ page }) => {
  await toStep2(page, "Copenhagen Central")
  const line = holidaySourceLine(page)
  await expect(line).toContainText("Danish public holidays · from project Copenhagen Central")
  await expect(line).not.toHaveClass(/text-amber/)
  await expect(line.getByRole("link", { name: "View in Settings" })).toHaveAttribute(
    "href",
    HOLIDAY_SETTINGS_HREF,
  )
  // No holiday picker anywhere in the wizard.
  await expect(wizard(page).getByText("Collection calendar")).toHaveCount(0)
})

test("a project without a holiday list says so in amber and treats every date as working", async ({
  page,
}) => {
  await toStep2(page, "Harbor Commercial")
  const line = holidaySourceLine(page)
  await expect(line).toContainText("No holiday list on this project")
  await expect(line).toHaveClass(/text-amber/)
  await expect(line.getByRole("link", { name: "View in Settings" })).toBeVisible()
  await fillRecurrence(page, {
    effectiveFrom: "2026-12-21",
    effectiveTo: "2026-12-31",
    days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    holidayPolicy: "Shift to the next working day",
  })
  // Fri 25 Dec is a holiday only on a list; Harbor has none, so it stays planned.
  const christmas = nextDatesRows(page).filter({ hasText: "25 Dec 2026" })
  await expect(christmas).toHaveCount(1)
  await expect(christmas).toContainText("Planned")
})

test("the holiday policy offers only the four policies generation implements", async ({ page }) => {
  await toStep2(page, "Copenhagen Central")
  expect(await optionTexts(page, wizard(page), "On a public holiday")).toEqual([
    "Shift to the next working day",
    "Shift to the previous working day",
    "Skip the collection",
    "Collect as planned",
  ])
})

test("the next-dates preview applies the project's holidays per policy", async ({ page }) => {
  await toStep2(page, "Copenhagen Central")
  await fillRecurrence(page, {
    effectiveFrom: "2026-12-21",
    effectiveTo: "2026-12-31",
    days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    holidayPolicy: "Shift to the next working day",
  })
  // Fri 25 Dec (Christmas Day) → Sat 26 is a holiday and a weekend, Sun 27 a
  // weekend → Mon 28 Dec. The preview shows the shifted date and the note.
  const shifted = nextDatesRows(page).filter({ hasText: "Shifted from Fri 25 Dec · Christmas Day" })
  await expect(shifted).toHaveCount(1)
  await expect(shifted).toContainText("28 Dec 2026")
  await expect(wizard(page).getByText("9 collections")).toBeVisible()

  await fillRecurrence(page, { holidayPolicy: "Skip the collection" })
  const skipped = nextDatesRows(page).filter({ hasText: "Skipped · Christmas Day" })
  await expect(skipped).toHaveCount(1)
  await expect(skipped).toContainText("25 Dec 2026")
  await expect(wizard(page).getByText("8 collections")).toBeVisible()

  await fillRecurrence(page, { holidayPolicy: "Collect as planned" })
  await expect(nextDatesRows(page).filter({ hasText: "Holiday · Christmas Day" })).toContainText(
    "25 Dec 2026",
  )
  await expect(wizard(page).getByText("9 collections")).toBeVisible()
})
