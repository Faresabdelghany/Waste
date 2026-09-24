import { expect, test } from "../fixtures"
import {
  BASELINE_SERVICE_TYPE,
  fillRecurrence,
  fillScope,
  projectCalendarField,
  nextDatesRows,
  nextStep,
  optionTexts,
  startGuided,
  stepHeading,
  wizard,
} from "../helpers/route-schemes"

// Settings › Operations › Holiday lists, opened on the scheme's project
// (lib/data/business-links.ts, holidaySettingsHref).
const holidaySettingsHref = (projectId: string) =>
  `/settings?pane=holiday-lists&project=${projectId}`

const AREA_BY_PROJECT: Record<string, string> = {
  "Copenhagen Central": "Indre By Operations",
  "Harbor Commercial": "Nordhavn Harbor Area",
  "Cairo Operations": "Nasr City Operations",
}

async function toStep2(page: Parameters<typeof startGuided>[0], project: string) {
  await startGuided(page)
  await fillScope(page, {
    name: `Holidays · ${project}`,
    project,
    area: AREA_BY_PROJECT[project],
    fraction: "Residual",
    serviceType: BASELINE_SERVICE_TYPE,
  })
  await nextStep(page)
  await expect(stepHeading(page)).toHaveText("When does this scheme collect?")
}

test("the holiday list and working week are one read-only field beside the policy, linking to Settings", async ({
  page,
}) => {
  await toStep2(page, "Copenhagen Central")
  const root = wizard(page)
  await expect(root.getByText("Holiday list · working week", { exact: true })).toBeVisible()
  const field = projectCalendarField(page)
  await expect(field).toContainText("Danish public holidays · Sat–Sun weekend")
  await expect(field).not.toHaveClass(/amber/)
  await expect(field.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute(
    "href",
    holidaySettingsHref("project-copenhagen"),
  )
  // No "from project" wording, no holiday picker anywhere in the wizard.
  await expect(root.getByText(/from project/)).toHaveCount(0)
  await expect(root.getByText("Collection calendar")).toHaveCount(0)
})

test("a project without a holiday list shows the amber field and treats every weekday as working", async ({
  page,
}) => {
  await toStep2(page, "Harbor Commercial")
  const field = projectCalendarField(page)
  await expect(field).toContainText("None on this project · Sat–Sun weekend")
  await expect(field).toHaveClass(/amber/)
  await expect(field.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute(
    "href",
    holidaySettingsHref("project-harbor"),
  )
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

test("Cairo: a Thursday holiday shifts to Sunday under the project's Fri–Sat weekend", async ({
  page,
}) => {
  await toStep2(page, "Cairo Operations")
  await expect(projectCalendarField(page)).toContainText("Egyptian public holidays · Fri–Sat weekend")
  await fillRecurrence(page, {
    effectiveFrom: "2027-01-03",
    effectiveTo: "2027-01-14",
    days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"],
    holidayPolicy: "Shift to the next working day",
  })
  // Thu 7 Jan 2027 (Coptic Christmas) → Fri 8 and Sat 9 are the weekend → Sun 10 Jan.
  const shifted = nextDatesRows(page).filter({ hasText: "Shifted from Thu 7 Jan · Coptic Christmas" })
  await expect(shifted).toHaveCount(1)
  await expect(shifted).toContainText("10 Jan 2027")
  await expect(shifted).toContainText("Sunday")
  await expect(wizard(page).getByText("10 collections")).toBeVisible()
})
