import { notInService } from "@waste/domain/execution/commands"
import { ID_RANDOM_BYTES, mintId } from "@waste/domain/ids"

import { apiAs, accessTokenOf, chainLanded, expect, freshContext, signIn, test } from "./fixtures"
import { dispatchedRouteFor, SEEDED_DRIVER } from "./dispatched-route"
import { E2E } from "./env"
import { answerOf, pick, toasts } from "./routes-support"
import { listAll } from "./tester"

// Pre-trip inspection (O13 of #290): the office sets a vehicle type's
// checklist in Settings › Pre-trip checklists — two items, one critical — and
// the seeded driver, on a phone, checks the vehicle before the day against
// it: a minor defect first, which leaves the vehicle on the road and opens the
// office a ticket, then a critical one, which takes it to maintenance, so the
// start on it is refused in the API's sentence. The office then reads the
// defects and the checks in the vehicle's details in Fleet and resolves one.
// The vehicle is NR-08 (AB 51 912), an Organic sealed truck of Copenhagen
// Central that no other flow starts a route on; its type's checklist, its
// status and its open defects are put back as they were, since the stack is
// shared.

type VehicleType = { id: string; name: string; checklist: { id: string; label: string; critical: boolean }[] }
type Vehicle = { id: string; callsign: string | null; registration: string; status: string; vehicleTypeId: string }
type Defect = { id: string; label: string; critical: boolean; note: string | null; status: string; ticketId: string | null; preTripCheckId: string }
type Check = { id: string; defectCount: number; odometerKm: number | null }
type Ticket = { id: string; kind: string; priority: string; subject: string }

test("the office sets a type's checklist, the driver's checks find a minor and a critical defect, the start on the grounded vehicle is refused, and the office resolves a defect", async ({ api, browser, page: office }) => {
  test.setTimeout(180_000)
  const nr08 = (await listAll<Vehicle>(api, "/vehicles")).find((vehicle) => vehicle.callsign === "NR-08")
  if (nr08 === undefined) throw new Error("the seed holds no vehicle NR-08")
  const type = (await (await api.get(`/vehicle-types/${nr08.vehicleTypeId}`)).json()) as VehicleType
  const before = type.checklist.map(({ label, critical }) => ({ label, critical }))
  /** Mends what a run left behind, before and after: every open defect of NR-08 resolved, NR-08 in service. */
  const mended = async () => {
    for (const defect of await listAll<Defect>(api, "/vehicle-defects", { vehicleId: nr08.id, status: "open" })) {
      expect((await api.post(`/vehicle-defects/${defect.id}/resolve`, { data: { note: "Mended by the e2e suite" } })).status()).toBe(200)
    }
    const now = (await (await api.get(`/vehicles/${nr08.id}`)).json()) as Vehicle
    if (now.status !== "active") expect((await api.patch(`/vehicles/${nr08.id}`, { data: { status: "active" } })).status()).toBe(200)
  }
  await mended()

  const { route } = await dispatchedRouteFor(api)
  const context = await freshContext(browser, { viewport: { width: 390, height: 844 } })
  try {
    // The office sets the type's checklist in Settings: Brakes, critical, then Lights, not.
    const read = answerOf(office, "GET", "/vehicle-types")
    await office.goto("/settings?pane=pre-trip-checklists")
    expect((await read).status()).toBe(200)
    const pane = office.locator("body")
    await pick(pane, office, "Vehicle type", type.name)
    for (let count = type.checklist.length; count > 0; count -= 1) await pane.getByRole("button", { name: "Remove item 1" }).click()
    await pane.getByRole("button", { name: "Add item" }).click()
    await pane.getByRole("row", { name: "Item 1" }).getByRole("textbox", { name: "What the driver checks" }).fill("Brakes")
    await pane.getByRole("button", { name: "Add item" }).click()
    await pane.getByRole("row", { name: "Item 2" }).getByRole("textbox", { name: "What the driver checks" }).fill("Lights")
    await pane.getByRole("checkbox", { name: "Item 2 is critical" }).click()
    const [saved] = await Promise.all([answerOf(office, "PUT", `/vehicle-types/${type.id}/checklist`), pane.getByRole("button", { name: "Save checklist" }).click()])
    expect(saved.status(), await saved.text()).toBe(200)
    expect(saved.request().postDataJSON()).toEqual({
      items: [
        { label: "Brakes", critical: true },
        { label: "Lights", critical: false },
      ],
    })
    await expect(toasts(office)).toContainText(`${type.name} has 2 items.`)

    // The driver checks NR-08 before the day: Lights fail, a minor defect.
    const page = await context.newPage()
    await signIn(page, SEEDED_DRIVER.email, E2E.loginPassword)
    await expect(page).toHaveURL(/\/driver$/)
    const card = page.getByRole("article", { name: `Route ${route.label}` })
    await card.getByLabel("Vehicle").selectOption(nr08.id)
    const check = async (defects: string[], odometer: string) => {
      await card.getByRole("button", { name: "Check NR-08" }).click()
      const dialog = page.getByRole("dialog", { name: "Pre-trip check of NR-08" })
      for (const label of defects) {
        await dialog.getByRole("checkbox", { name: label }).check()
        await dialog.getByRole("textbox", { name: `What is wrong with ${label}` }).fill(`${label} not working`)
      }
      await dialog.getByLabel("Odometer (km)").fill(odometer)
      const [sent] = await Promise.all([answerOf(page, "POST", "/driver/commands"), dialog.getByRole("button", { name: "Record check" }).click()])
      expect(sent.status()).toBe(200)
      const { outcomes } = (await sent.json()) as { outcomes: { outcome: string; result?: { resource: string; value: Check } }[] }
      expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["applied"])
      return outcomes[0].result?.value as Check
    }
    const minor = await check(["Lights"], "182400")
    expect(minor.defectCount).toBe(1)
    expect(minor.odometerKm).toBe(182_400)
    expect(((await (await api.get(`/vehicles/${nr08.id}`)).json()) as Vehicle).status).toBe("active")
    const [lights] = (await listAll<Defect>(api, "/vehicle-defects", { vehicleId: nr08.id, status: "open" })).filter((defect) => defect.preTripCheckId === minor.id)
    expect(lights).toMatchObject({ label: "Lights", critical: false, note: "Lights not working" })
    const ticket = (await (await api.get(`/tickets/${lights.ticketId}`)).json()) as Ticket
    expect(ticket).toMatchObject({ kind: "vehicle-defect", priority: "medium", subject: "Pre-trip check found a defect on NR-08" })

    // Then Brakes fail too: critical, and NR-08 goes to maintenance, so the start on it is refused in the API's sentence.
    const critical = await check(["Brakes", "Lights"], "182405")
    expect(critical.defectCount).toBe(2)
    expect(((await (await api.get(`/vehicles/${nr08.id}`)).json()) as Vehicle).status).toBe("maintenance")
    const token = await accessTokenOf(context)
    if (token === null) throw new Error("the driver's session holds no token")
    const driver = await apiAs(token)
    try {
      const me = (await (await driver.get("/driver/me")).json()) as { vehicles: { id: string }[] }
      expect(me.vehicles.some((vehicle) => vehicle.id === nr08.id), "a vehicle in maintenance is not offered to a start").toBe(false)
      // A device that still holds NR-08 from before is told why, in the API's sentence, and the route stays ready.
      const start = { id: mintId(Date.now(), crypto.getRandomValues(new Uint8Array(ID_RANDOM_BYTES))), kind: "start-route", routeId: route.id, occurredAt: new Date().toISOString(), deviceId: "e2e-pre-trip", body: { vehicleId: nr08.id } }
      const answered = await driver.post("/driver/commands", { data: { commands: [start] } })
      expect(answered.status()).toBe(200)
      const { outcomes } = (await answered.json()) as { outcomes: { outcome: string; problem?: { detail?: string } }[] }
      expect(outcomes[0]).toMatchObject({ outcome: "rejected", problem: { detail: notInService("NR-08", "maintenance", "vehicle") } })
    } finally {
      await driver.dispose()
    }

    // The office reads the defects and the checks in NR-08's details, and resolves the critical one.
    await office.goto("/fleet?module=vehicles")
    await chainLanded(office)
    await office.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill("NR-08")
    await office.getByRole("button", { name: "Open NR-08 · AB 51 912" }).click()
    const details = office.getByRole("dialog").filter({ has: office.getByTestId("vehicle-defects") })
    const defects = details.getByTestId("vehicle-defects-list")
    await expect(defects.getByText("Brakes · critical · Brakes not working")).toBeVisible()
    await expect(details.getByTestId("vehicle-checks-list").getByText("2 defects · 182,405 km")).toBeVisible()
    const [brakes] = (await listAll<Defect>(api, "/vehicle-defects", { vehicleId: nr08.id, status: "open" })).filter((defect) => defect.preTripCheckId === critical.id && defect.label === "Brakes")
    await defects.getByRole("listitem").filter({ hasText: "Brakes · critical · Brakes not working" }).getByRole("button", { name: "Resolve" }).click()
    const resolveDialog = office.getByRole("dialog", { name: "Resolve Brakes" })
    await resolveDialog.getByLabel("What was done (optional)").fill("Pads replaced")
    const [resolved] = await Promise.all([answerOf(office, "POST", `/vehicle-defects/${brakes.id}/resolve`), resolveDialog.getByRole("button", { name: "Resolve defect" }).click()])
    expect(resolved.status(), await resolved.text()).toBe(200)
    expect(resolved.request().postDataJSON()).toEqual({ note: "Pads replaced" })
    await expect(toasts(office)).toContainText("Defect resolved")
    expect(((await (await api.get(`/vehicles/${nr08.id}`)).json()) as Vehicle).status, "resolving leaves the status to the vehicle's own edit").toBe("maintenance")
  } finally {
    // A test that timed out has closed the context already; its own error is the one to read.
    await context.close().catch(() => undefined)
    await mended()
    expect((await api.put(`/vehicle-types/${type.id}/checklist`, { data: { items: before } })).status()).toBe(200)
  }
})
