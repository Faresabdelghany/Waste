// Shared Playwright helpers for the Route Scheme guided-setup E2E suite
// (2026-09-16 redesign). Locators follow the real DOM:
//
// - The wizard is a shadcn Dialog titled "New route scheme"; the step
//   heading is the pane's <h2>. Every field is a <Label htmlFor> bound to its
//   control, so getByLabel reaches inputs and Radix Select triggers alike.
// - Radix Select: getByLabel(label) → click → role=option (portaled).
// - Service day / container type pills are ToggleGroup items: buttons named
//   by their aria-label ("Monday", "Two-wheel bin · 240 L") with aria-pressed.
// - The group editor is a nested Dialog titled "Add collection group" /
//   "Edit collection group".
// - Toasts are sonner, inside region "Notifications alt+T".

import { expect, type Locator, type Page } from "@playwright/test"

export type DayLong =
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday"
  | "Saturday"
  | "Sunday"

/* ---------------------------------- entry --------------------------------- */

/** The mode chooser overlay (plain fixed div — no dialog role). */
export function chooserRoot(page: Page): Locator {
  return page.locator(".fixed.inset-0").filter({ hasText: "Guided Setup" })
}

export async function openChooser(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Create route scheme" }).click()
  await expect(chooserRoot(page)).toBeVisible()
}

/** Chooser → Guided Setup → Continue; resolves on step 1. */
export async function startGuided(page: Page): Promise<void> {
  await openChooser(page)
  await page.getByText("Guided Setup", { exact: true }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(stepHeading(page)).toHaveText("Which scope does this scheme plan for?")
}

/** Chooser → Quick create → Continue; resolves on the quick dialog. */
export async function startQuick(page: Page): Promise<Locator> {
  await openChooser(page)
  await page.getByText("Quick create", { exact: true }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  const dialog = page.getByRole("dialog", { name: "Create route scheme" })
  await expect(dialog).toBeVisible()
  return dialog
}

/* ---------------------------------- wizard -------------------------------- */

export function wizard(page: Page): Locator {
  return page.getByRole("dialog", { name: "New route scheme" })
}

/** The step pane's question heading. */
export function stepHeading(page: Page): Locator {
  return wizard(page).locator("section h2")
}

export function nextButton(page: Page): Locator {
  return wizard(page).getByRole("button", { name: "Next", exact: true })
}

export async function nextStep(page: Page): Promise<void> {
  await nextButton(page).click()
}

export async function backStep(page: Page): Promise<void> {
  await wizard(page).getByRole("button", { name: "Back", exact: true }).click()
}

export function createButton(page: Page): Locator {
  return wizard(page).getByRole("button", { name: "Create route scheme" })
}

/** Opens the Select bound to `label` inside `within` and picks `option` (exact). */
export async function pickOption(
  page: Page,
  within: Locator,
  label: string,
  option: string,
): Promise<void> {
  const trigger = within.getByLabel(label, { exact: true })
  await trigger.click()
  await page.getByRole("option", { name: option, exact: true }).click()
  await expect(trigger).toContainText(option)
}

/** Opens the Select bound to `label` and returns the visible option texts (closes it after). */
export async function optionTexts(page: Page, within: Locator, label: string): Promise<string[]> {
  await within.getByLabel(label, { exact: true }).click()
  const listbox = page.getByRole("listbox")
  await expect(listbox).toBeVisible()
  const texts = await page.getByRole("option").allInnerTexts()
  await page.keyboard.press("Escape")
  await expect(listbox).toBeHidden()
  return texts.map((text) => text.trim())
}

/** A pill (ToggleGroup item) named by its aria-label. */
export function pill(within: Locator, name: string): Locator {
  return within.getByRole("button", { name, exact: true })
}

export type ScopeInput = {
  name?: string
  project?: string
  area?: string
  fraction?: string
  serviceType?: string
  depot?: string
  station?: string
}

/** Step 1 — fills only the given fields. */
export async function fillScope(page: Page, input: ScopeInput): Promise<void> {
  const root = wizard(page)
  if (input.name !== undefined) await root.getByLabel("Route scheme name").fill(input.name)
  if (input.project) await pickOption(page, root, "Project", input.project)
  if (input.area) await pickOption(page, root, "Operational planning area", input.area)
  if (input.fraction) await pickOption(page, root, "Waste fraction", input.fraction)
  if (input.serviceType) await pickOption(page, root, "Service type", input.serviceType)
  if (input.depot) await pickOption(page, root, "Departure depot", input.depot)
  if (input.station) await pickOption(page, root, "Unloading station", input.station)
}

export type RecurrenceInput = {
  effectiveFrom?: string
  effectiveTo?: string
  frequency?: "Daily" | "Every week" | "Every 2 weeks" | "Every 3 weeks" | "Once a month"
  startTime?: string
  /** Pills to toggle on (the draft starts with none). */
  days?: readonly DayLong[]
  holidayPolicy?:
    | "Shift to the next working day"
    | "Shift to the previous working day"
    | "Skip the collection"
    | "Collect as planned"
}

/** Step 2 — fills only the given fields. */
export async function fillRecurrence(page: Page, input: RecurrenceInput): Promise<void> {
  const root = wizard(page)
  if (input.effectiveFrom !== undefined) {
    await root.getByLabel("Effective from").fill(input.effectiveFrom)
  }
  if (input.effectiveTo !== undefined) {
    await root.getByLabel("Effective to (optional)").fill(input.effectiveTo)
  }
  if (input.frequency) await pickOption(page, root, "Collection frequency", input.frequency)
  if (input.startTime !== undefined) {
    await root.getByLabel("Planned start time").fill(input.startTime)
  }
  for (const day of input.days ?? []) await pill(root, day).click()
  if (input.holidayPolicy) await pickOption(page, root, "On a public holiday", input.holidayPolicy)
}

/** The muted / amber holiday-source line beside the holiday policy select. */
export function holidaySourceLine(page: Page): Locator {
  return wizard(page).getByTestId("holiday-source")
}

/** The next-dates table rows (the preview). */
export function nextDatesRows(page: Page): Locator {
  return wizard(page).getByRole("row").filter({ has: page.locator("td") })
}

/* ---------------------------------- groups -------------------------------- */

export function groupEditor(page: Page): Locator {
  return page.getByRole("dialog", { name: /(Add|Edit) collection group/ })
}

export async function openGroupEditor(page: Page): Promise<Locator> {
  await wizard(page).getByRole("button", { name: "Add collection group" }).first().click()
  const editor = groupEditor(page)
  await expect(editor).toBeVisible()
  return editor
}

export type GroupInput = {
  name?: string
  days?: readonly DayLong[]
  vehicle?: string
  driver?: string
  containerTypes?: readonly string[]
}

/** Fills the open group editor; does not save. */
export async function fillGroup(page: Page, input: GroupInput): Promise<void> {
  const editor = groupEditor(page)
  if (input.name !== undefined) await editor.getByLabel("Group name").fill(input.name)
  for (const day of input.days ?? []) await pill(editor, day).click()
  if (input.vehicle) await pickOption(page, editor, "Vehicle", input.vehicle)
  if (input.driver) await pickOption(page, editor, "Default driver", input.driver)
  for (const type of input.containerTypes ?? []) await pill(editor, type).click()
}

export async function saveGroup(page: Page): Promise<void> {
  const editor = groupEditor(page)
  await editor.getByRole("button", { name: /^(Add|Save) group$/ }).click()
  await expect(editor).toBeHidden()
}

/* ----------------------------------- list ---------------------------------- */

export function toasts(page: Page): Locator {
  return page.getByRole("region", { name: "Notifications alt+T" })
}

/** The schemes list row naming the scheme (the row is exposed as an "Open …" button). */
export function schemeRow(page: Page, name: string): Locator {
  return page.locator("tr").filter({ hasText: name })
}

/* ------------------------------- baseline data ------------------------------ */

/** Fixture crew no fixture scheme plans (RS-Central holds WH-24 + Mads Mon–Fri). */
export const CLEAN_VEHICLE = "WH-31 · Glass crane · 16 t"
export const CLEAN_DRIVER = "Freja Nielsen · C, CE"

/** A complete, issue-free scheme through step 3 (one Monday group). */
export async function buildBaselineScheme(page: Page, name: string): Promise<void> {
  await startGuided(page)
  await fillScope(page, {
    name,
    project: "Copenhagen Central",
    area: "Indre By Operations",
    fraction: "Residual",
    serviceType: "Collection",
  })
  await nextStep(page)
  await expect(stepHeading(page)).toHaveText("When does this scheme collect?")
  await fillRecurrence(page, { days: ["Monday"] })
  await nextStep(page)
  await expect(stepHeading(page)).toHaveText("Who collects what on which service days?")
  await openGroupEditor(page)
  await fillGroup(page, {
    name: "Residual · bins",
    days: ["Monday"],
    vehicle: CLEAN_VEHICLE,
    driver: CLEAN_DRIVER,
    containerTypes: ["Two-wheel bin · 240 L", "Two-wheel bin · 140 L"],
  })
  await saveGroup(page)
}
