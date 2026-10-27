import type { APIRequestContext } from "@playwright/test"

import { dayIn, driverNamed, SEEDED_DRIVER } from "./dispatched-route"
import { E2E, uniqueName } from "./env"
import { accessTokenOf, apiAs, expect, freshContext, problemOf, signIn, test } from "./fixtures"
import { listAll, projectNamed, TESTER_PROJECT } from "./tester"

// Bulky-waste booking on the API (O11 of #290), driven by API calls alone:
// the office's form and the Driver App's card are O11b's. A planning area is
// drawn for the run somewhere no other run's area is, with a property inside
// it served under a customer's agreement; the area gets a Bulky Schedule of
// one slot a day, charged at a product sold by the job. The property's days
// come from the availability read, a booking takes the first one, and the day
// then answers none left and refuses a second booking. The office routes the
// booking as a stop on an ad-hoc route of its day, assigned to the seeded
// driver and dispatched, and the driver's read of the route lists the stop at
// the property with the booking's items. The charge of a completed bulky stop
// is the worker's, held by its own suite: the route runs on a day after today.
// Everything is made for the run, uniquely named, and never cleaned up.

type Named = { id: string; name: string }
type Day = { day: string; slots: number; booked: number; left: number; planningAreaId: string; scheduleId: string }
type Booking = { id: string; status: string; day: string; items: { description: string; quantity: number }[]; stop: { pickupId: string; routeId: string; status: string } | null; scheduleId: string; productId: string }
type DriverStop = { id: string; service: string; containerId: string | null; propertyId: string | null; bulkyBookingId: string | null; bulkyItems: { description: string; quantity: number }[] }

const made = async <T>(api: APIRequestContext, path: string, data: unknown): Promise<T> => {
  const response = await api.post(path, { data })
  expect(response.status(), `POST ${path}: ${await response.text()}`).toBe(201)
  return (await response.json()) as T
}

/** A square of about a hundred metres at a spot drawn for the run, far from the seed's areas and, with odds of millions to one, from any earlier run's. */
function spot(): { centre: [number, number]; square: { type: "Polygon"; coordinates: [number, number][][] } } {
  const [lon, lat] = [9 + Math.random() * 1.5, 56 + Math.random() * 1.2].map((value) => Math.round(value * 10_000) / 10_000)
  const d = 0.001
  return {
    centre: [lon, lat],
    square: { type: "Polygon", coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] },
  }
}

test("a place's bulky days come from its area's schedule; a booking takes the day's one slot, the office routes it as a stop of that day, and the driver reads its items", async ({ api, browser }) => {
  test.setTimeout(120_000)
  const [project, driver] = await Promise.all([projectNamed(api, TESTER_PROJECT), driverNamed(api, SEEDED_DRIVER.name)])
  const fraction = (await listAll<Named>(api, "/waste-fractions")).find((row) => row.name === "Residual")
  if (fraction === undefined) throw new Error("the seed holds no Residual fraction")
  const today = dayIn("Europe/Copenhagen")
  const { centre, square } = spot()

  const area = await made<Named>(api, "/planning-areas", { projectId: project.id, code: uniqueName("E2E-BLK").replace(/\s+/g, "-").toUpperCase(), name: uniqueName("E2E Bulky area"), purpose: "service-operations", boundary: { boundary: square, validFrom: today } })
  const property = await made<Named>(api, "/properties", { projectId: project.id, name: uniqueName("E2E Bulky property"), address: "Skovvej 1, 8600 Silkeborg", kind: "residential", location: { type: "Point", coordinates: centre } })
  const customer = await made<Named>(api, "/customers", { kind: "person", name: uniqueName("E2E Bulky customer") })
  const collection = await made<Named>(api, "/products", { projectId: project.id, name: uniqueName("E2E Bulky residual"), kind: "container-collection", unit: "pickup", status: "active" })
  const bulky = await made<Named>(api, "/products", { projectId: project.id, name: uniqueName("E2E Bulky collection"), kind: "additional-service", unit: "job", status: "active" })
  const agreement = await made<{ id: string }>(api, "/agreements", { projectId: project.id, number: uniqueName("E2E-BLK").replace(/\s+/g, "-").toUpperCase(), customerId: customer.id, payerCustomerId: customer.id, status: "active", billingCadence: "monthly", currency: "DKK", validFrom: today, validTo: null })
  await made(api, `/agreements/${agreement.id}/subscriptions`, { productId: collection.id, propertyId: property.id, validFrom: today, validTo: null })

  // One slot a day, every day: the first day after today is bookable.
  const schedule = await made<{ id: string; holidayPolicy: string }>(api, "/bulky-schedules", { projectId: project.id, planningAreaId: area.id, frequency: "daily", serviceDays: ["monday", "tuesday", "wednesday", "thursday", "friday"], holidayPolicy: "collect", slotsPerDay: 1, productId: bulky.id, validFrom: today })
  const window = `propertyId=${property.id}&from=${today}&to=${new Date(Date.parse(`${today}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10)}`
  const read = await api.get(`/bulky-bookings/availability?${window}`)
  expect(read.status(), await read.text()).toBe(200)
  const days = ((await read.json()) as { days: Day[] }).days
  expect(days.length).toBeGreaterThan(0)
  expect(days.every((day) => day.day > today && day.slots === 1 && day.left === 1 && day.scheduleId === schedule.id && day.planningAreaId === area.id)).toBe(true)
  const [first] = days

  const body = { customerId: customer.id, agreementId: agreement.id, propertyId: property.id, wasteFractionId: fraction.id, day: first.day, items: [{ description: "Sofa", quantity: 1 }, { description: "Mattress", quantity: 2 }], note: "By the garage" }
  const booking = await made<Booking>(api, "/bulky-bookings", body)
  expect({ status: booking.status, day: booking.day, items: booking.items, stop: booking.stop, scheduleId: booking.scheduleId, productId: booking.productId }).toEqual({ status: "booked", day: first.day, items: body.items, stop: null, scheduleId: schedule.id, productId: bulky.id })
  const after = ((await (await api.get(`/bulky-bookings/availability?${window}`)).json()) as { days: Day[] }).days.find((day) => day.day === first.day)
  expect(after).toMatchObject({ booked: 1, left: 0 })
  const full = await api.post("/bulky-bookings", { data: body })
  expect(full.status()).toBe(409)
  expect((await problemOf(full)).detail).toBe(`${first.day} is fully booked: every bulky collection slot that day is taken`)

  // The office routes it: an ad-hoc route of its day for the seeded driver, the booking added as its stop, and the route dispatched.
  const route = await made<{ id: string }>(api, "/routes", { projectId: project.id, operatingDate: first.day, driverId: driver.id })
  const stop = await made<{ id: string; service: string; containerId: string | null; propertyId: string | null; bulkyBookingId: string | null }>(api, `/routes/${route.id}/pickups`, { service: "bulky", bulkyBookingId: booking.id })
  expect({ service: stop.service, containerId: stop.containerId, propertyId: stop.propertyId, bulkyBookingId: stop.bulkyBookingId }).toEqual({ service: "bulky", containerId: null, propertyId: property.id, bulkyBookingId: booking.id })
  const routed = (await (await api.get(`/bulky-bookings/${booking.id}`)).json()) as Booking
  expect({ status: routed.status, stop: routed.stop }).toEqual({ status: "routed", stop: { pickupId: stop.id, routeId: route.id, status: "planned" } })
  const cancel = await api.post(`/bulky-bookings/${booking.id}/cancel`, { data: { reason: "Customer called" } })
  expect(cancel.status()).toBe(409)
  const dispatched = await api.post(`/routes/${route.id}/dispatch`)
  expect(dispatched.status(), await dispatched.text()).toBe(200)

  // The driver reads the stop with the booking's items.
  const context = await freshContext(browser)
  try {
    const driverPage = await context.newPage()
    await signIn(driverPage, SEEDED_DRIVER.email, E2E.loginPassword)
    const token = await accessTokenOf(context)
    if (token === null) throw new Error("the driver's browser holds no API session")
    const asDriver = await apiAs(token)
    try {
      const read = await asDriver.get(`/driver/routes/${route.id}`)
      expect(read.status(), await read.text()).toBe(200)
      const pickups = ((await read.json()) as { pickups: DriverStop[] }).pickups
      const card = pickups.find((pickup) => pickup.id === stop.id)
      expect(card).toMatchObject({ service: "bulky", containerId: null, propertyId: property.id, bulkyBookingId: booking.id, bulkyItems: body.items })
    } finally {
      await asDriver.dispose()
    }
  } finally {
    await context.close()
  }
})
