import type { APIRequestContext, Page } from "@playwright/test"
import { periodPhrase } from "@waste/domain/resources/availability"
import { addDays } from "@waste/domain/route-schemes/recurrence"

import { chainLanded, expect, problemOf, test } from "./fixtures"
import { listAll, projectNamed, TESTER_PROJECT } from "./tester"

// O6 of #290: a driver's absence and a vehicle's time out of use, recorded in
// the row's details in Fleet, listed there by the last day away, and removed
// there; meanwhile the commands that name them on those days are refused in
// the API's sentence — an allocation naming the driver, made in the browser,
// and an ad-hoc route naming the vehicle. The seeded rows named are Freja
// Nielsen, whose licence holds until 30 June 2027, and NR-12 (CK 74 305). Each
// run takes a week before then and first removes, through the API, whatever
// period of theirs a run that died before its own removal left on it.
type Driver = { id: string; name: string }
type Vehicle = { id: string; callsign: string | null; registration: string }
type Period = { id: string; validFrom: string; validTo: string | null; reason: string }

/** The browser's API call the page makes: the answer of `method` on a path under `path`. */
const answerOf = (page: Page, method: string, path: RegExp) =>
  page.waitForResponse((response) => response.request().method() === method && path.test(new URL(response.url()).pathname.replace(/^\/waste-api/, "")))

/** Opens a workspace module, waits for its rows to arrive from the API, then for the store's whole chain to land. */
async function openLoaded(page: Page, url: string, listPath: RegExp) {
  const loaded = answerOf(page, "GET", listPath)
  await page.goto(url)
  expect((await loaded).status()).toBe(200)
  await chainLanded(page)
}

/** The row's opener, after narrowing the list to the name through the module's own search. */
async function openRow(page: Page, name: string) {
  await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill(name)
  await page.getByRole("button", { name: `Open ${name}` }).click()
}

/** Picks an option of a select field in the open dialog by the start of its label. */
async function pick(page: Page, field: string, option: RegExp) {
  await page.getByRole("dialog").getByRole("combobox", { name: new RegExp(`^${field}`) }).click()
  await page.getByRole("option", { name: option }).first().click()
}

/** A Monday of the first half of 2027, apart per run. */
const aMonday = () => addDays("2027-01-04", 7 * Math.floor(Math.random() * 21))

/** Removes, through the API, the owner's periods touching the week from `monday`: a leftover of a run that died before its removal. */
async function clearWeek(api: APIRequestContext, family: "driver-absences" | "vehicle-unavailability", owner: Record<string, string>, monday: string) {
  for (const leftover of await listAll<Period>(api, `/${family}`, { ...owner, from: monday, to: addDays(monday, 6) })) {
    expect((await api.delete(`/${family}/${leftover.id}`)).status()).toBe(204)
  }
}

/** The line a period reads as in the details: by its last day away, then its reason. */
const lineOf = (period: Period, reason: string) => {
  const phrase = periodPhrase(period)
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)} · ${reason}`
}

/** Records a period through the details' form and answers the API's response to it. */
async function record(page: Page, button: string, first: string, last: string, reason: string, path: RegExp) {
  await page.getByRole("dialog").getByRole("button", { name: button, exact: true }).click()
  const form = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: button }) })
  await expect(form).toBeVisible()
  await form.getByLabel("First day away").fill(first)
  await form.getByLabel("Last day away").fill(last)
  await form.getByRole("combobox", { name: /^Reason/ }).click()
  await page.getByRole("option", { name: reason, exact: true }).click()
  const [response] = await Promise.all([answerOf(page, "POST", path), form.getByRole("button", { name: button, exact: true }).click()])
  return response
}

test("Fleet: a driver's absence recorded in their details is listed by its last day, refuses an allocation naming them on its days in the API's sentence, and is removed", async ({ page, api }) => {
  const freja = (await listAll<Driver>(api, "/drivers")).find((driver) => driver.name === "Freja Nielsen")
  expect(freja).toBeDefined()
  const monday = aMonday()
  const wednesday = addDays(monday, 2)
  await clearWeek(api, "driver-absences", { driverId: freja?.id ?? "" }, monday)

  await openLoaded(page, "/fleet?module=drivers", /^\/drivers$/)
  await openRow(page, "Freja Nielsen")
  const details = page.getByRole("dialog").filter({ has: page.getByTestId("driver-absences") })
  const recorded = await record(page, "Record absence", monday, wednesday, "Holiday", /^\/driver-absences$/)
  expect(recorded.status()).toBe(201)
  const absence = (await recorded.json()) as Period
  expect(absence).toMatchObject({ validFrom: monday, validTo: addDays(wednesday, 1), reason: "holiday" })
  const line = lineOf(absence, "Holiday")
  await expect(details.getByTestId("driver-absences-periods").getByText(line)).toBeVisible()
  await page.keyboard.press("Escape")

  // An allocation naming her on the Tuesday, made in the browser: the API's 409, told in its words.
  await openLoaded(page, "/fleet?module=vehicle-planning", /^\/vehicle-allocations$/)
  await page.getByRole("button", { name: "Plan allocation" }).click()
  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Allocate a vehicle" }) })
  await pick(page, "Project", /^Copenhagen Central/)
  await pick(page, "Vehicle", /^NR-12/)
  await pick(page, "Driver", /^Freja Nielsen/)
  await dialog.getByLabel("Planned start").fill(`${addDays(monday, 1)}T06:00`)
  await dialog.getByLabel("Planned end").fill(`${addDays(monday, 1)}T14:00`)
  const [refused] = await Promise.all([answerOf(page, "POST", /^\/vehicle-allocations$/), dialog.getByRole("button", { name: "Allocate" }).click()])
  expect(refused.status()).toBe(409)
  const sentence = `Freja Nielsen is absent ${periodPhrase(absence)} (holiday); a vehicle allocation needs a driver who is there`
  expect(((await refused.json()) as { detail?: string }).detail).toBe(sentence)
  await expect(page.getByText(sentence)).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel" }).click()

  // Removed in her details: the API answers 204 and lists none of hers over the week.
  await openLoaded(page, "/fleet?module=drivers", /^\/drivers$/)
  await openRow(page, "Freja Nielsen")
  const periods = page.getByRole("dialog").getByTestId("driver-absences-periods")
  const [removed] = await Promise.all([answerOf(page, "DELETE", new RegExp(`^/driver-absences/${absence.id}$`)), periods.getByRole("listitem").filter({ hasText: line }).getByRole("button", { name: "Remove" }).click()])
  expect(removed.status()).toBe(204)
  await expect(periods.getByText(line)).toHaveCount(0)
  expect(await listAll<Period>(api, "/driver-absences", { driverId: freja?.id ?? "", from: monday, to: wednesday })).toEqual([])
})

test("Fleet: a vehicle's time out of use recorded in its details refuses an ad-hoc route naming it that day, a second period over one of its days is refused in the browser, and it is removed", async ({ page, api }) => {
  const project = await projectNamed(api, TESTER_PROJECT)
  const nr12 = (await listAll<Vehicle>(api, "/vehicles")).find((vehicle) => vehicle.callsign === "NR-12")
  expect(nr12).toBeDefined()
  const monday = aMonday()
  await clearWeek(api, "vehicle-unavailability", { vehicleId: nr12?.id ?? "" }, monday)

  await openLoaded(page, "/fleet?module=vehicles", /^\/vehicles$/)
  await openRow(page, "NR-12 · CK 74 305")
  const details = page.getByRole("dialog").filter({ has: page.getByTestId("vehicle-unavailability") })
  const recorded = await record(page, "Record out of use", monday, monday, "Inspection", /^\/vehicle-unavailability$/)
  expect(recorded.status()).toBe(201)
  const period = (await recorded.json()) as Period
  expect(period).toMatchObject({ validFrom: monday, validTo: addDays(monday, 1), reason: "inspection" })
  const line = lineOf(period, "Inspection")
  await expect(details.getByTestId("vehicle-unavailability-periods").getByText(line)).toBeVisible()

  // A second over the same day: refused in the API's sentence, the dialog left open on it.
  const again = await record(page, "Record out of use", monday, addDays(monday, 2), "Repair", /^\/vehicle-unavailability$/)
  expect(again.status()).toBe(409)
  const already = `NR-12 is already unavailable ${periodPhrase(period)} (inspection); one period covers a day`
  await expect(page.getByText(already)).toBeVisible()
  await page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Record out of use" }) }).getByRole("button", { name: "Cancel" }).click()

  // An ad-hoc route naming NR-12 that Monday.
  const route = await api.post("/routes", { data: { projectId: project.id, operatingDate: monday, vehicleId: nr12?.id } })
  expect(route.status()).toBe(409)
  expect((await problemOf(route)).detail).toBe(`NR-12 is unavailable ${periodPhrase(period)} (inspection); a route needs a vehicle that is there`)

  const periods = details.getByTestId("vehicle-unavailability-periods")
  const [removed] = await Promise.all([answerOf(page, "DELETE", new RegExp(`^/vehicle-unavailability/${period.id}$`)), periods.getByRole("listitem").filter({ hasText: line }).getByRole("button", { name: "Remove" }).click()])
  expect(removed.status()).toBe(204)
  await expect(details.getByText(line)).toHaveCount(0)
})
