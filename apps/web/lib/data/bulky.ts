// Bulky-waste booking on the web (O11 of #290): the words and the bodies the
// office's surfaces speak. Settings › Operations › Bulky schedules writes an
// area's schedule (`/bulky-schedules`); Operate › Bulky Bookings books a
// customer's items onto a day the place's schedule offers, routes a booking
// onto a route of its day, and cancels one still booked
// (`/bulky-bookings`). The pure half lives here, so a test spells it; the
// panes are components/settings/bulky-schedules-settings.tsx and
// components/waste/commands/bulky-surfaces.tsx, the adapter
// lib/api/records/bulky-bookings.ts.
import type { BulkyAvailableDay, BulkySchedule, BulkyScheduleCreate, BulkySchedulePatch } from "@waste/contracts/bulky"
import type { BulkyBookingStatus } from "@waste/domain/execution/vocabulary"
import type { HolidayPolicy, RecurrenceFrequency, ServiceDay, WeekRotation } from "@waste/domain/planning/vocabulary"
import { HOLIDAY_POLICY_LABELS } from "@waste/domain/route-schemes/occurrences"
import { addDays, OFFERED_RECURRENCE_FREQUENCIES, RECURRENCE_FREQUENCY_LABELS, SERVICE_DAY_LABELS, SERVICE_DAY_SHORT_LABELS, SERVICE_DAYS, serviceDayOf } from "@waste/domain/route-schemes/recurrence"

import type { BusinessRecord, ModuleLocation } from "@/lib/data/business-modules"
import { mintedRecord } from "@/lib/data/containers"

import { allows, type Grants } from "../api/grants"
import { itemsSentence } from "./pickup-services"

/** Where the bookings are: Operate › Bulky Bookings. */
export const BULKY_BOOKINGS_MODULE = { workspaceId: "operate", moduleId: "bulky-bookings" } as const satisfies ModuleLocation

/** Settings › Operations › Bulky schedules. */
export const BULKY_SCHEDULES_SETTINGS_PANE_ID = "operations-bulky-schedules"

/** The record's keys the surfaces read beside the facts. */
export const BULKY_SERVER_ID_KEY = "bulkyServerId"
export const BULKY_STATUS_KEY = "bulkyStatus"
export const BULKY_DAY_KEY = "day"
export const BULKY_ITEMS_KEY = "items"

/** A booking's status as a person reads it. */
export const BULKY_STATUS_LABELS: Readonly<Record<BulkyBookingStatus, string>> = { booked: "Booked", routed: "Routed", collected: "Collected", cancelled: "Cancelled" }

/** The bookings at most one dialog lists items for; the API's own cap. */
export const ITEMS_MAX = 20

/** One item as the dialog edits it: the count a string, as an input holds it. */
export type ItemRow = { description: string; quantity: string }

/** The items a dialog holds, as the wire takes them, or the sentence that refuses them. */
export function itemsOf(rows: readonly ItemRow[]): { description: string; quantity: number }[] | string {
  const listed = rows.filter((row) => row.description.trim() !== "" || row.quantity.trim() !== "")
  if (listed.length === 0) return "List an item at least"
  if (listed.length > ITEMS_MAX) return `List ${ITEMS_MAX} items at most`
  const items: { description: string; quantity: number }[] = []
  for (const row of listed) {
    const quantity = Number(row.quantity)
    if (row.description.trim() === "") return "Say what each item is"
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) return "Give each item a count from 1 to 100"
    items.push({ description: row.description.trim(), quantity })
  }
  return items
}

export { itemsSentence }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "Tue 9 Mar": a day as a picker shows it. */
export function shortDay(day: string): string {
  const [, month, date] = day.split("-").map(Number)
  return `${SERVICE_DAY_SHORT_LABELS[serviceDayOf(day)]} ${date} ${MONTHS[month - 1]}`
}

/** A day the place may be booked on, as the dialog offers it: its slots left, a full one said so and not offered. */
export function dayOption(day: BulkyAvailableDay): { value: string; label: string; disabled: boolean } {
  return { value: day.day, label: `${shortDay(day.day)} · ${day.left === 0 ? "full" : `${day.left} of ${day.slots} left`}`, disabled: day.left === 0 }
}

/** The window an availability read asks for: from the project's today, four weeks ahead. */
export const availabilityWindow = (today: string): { from: string; to: string } => ({ from: today, to: addDays(today, 27) })

/** What the booking dialog holds once filled in: every id the web's, the place one of the two. */
export type BookingDraft = {
  projectId: string
  customerId: string
  agreementId: string
  propertyId: string
  sharedCollectionPointId: string
  wasteFractionId: string
  day: string
  items: readonly { description: string; quantity: number }[]
  note: string
}

/** The row the booking dialog makes, minted for the session: the adapter's `toCreateBody` reads its values (lib/api/records/bulky-bookings.ts). */
export function bookingRecordOf(draft: BookingDraft, placeName: string, now: number): BusinessRecord {
  return mintedRecord({
    id: `bulky-bookings-bulky-booking-${now}`,
    name: `Bulky collection · ${placeName} · ${shortDay(draft.day)}`,
    status: BULKY_STATUS_LABELS.booked,
    recordKind: "Bulky booking",
    values: {
      projectId: draft.projectId,
      customerId: draft.customerId,
      agreementId: draft.agreementId,
      propertyId: draft.propertyId,
      sharedCollectionPointId: draft.sharedCollectionPointId,
      wasteFractionId: draft.wasteFractionId,
      [BULKY_DAY_KEY]: draft.day,
      [BULKY_ITEMS_KEY]: JSON.stringify(draft.items),
      ...(draft.note.trim() === "" ? {} : { note: draft.note.trim() }),
    },
  })
}

/** A row's typed value by key, empty where it has none. */
const valueOf = (record: BusinessRecord, key: string): string => {
  const value = record.submittedValues?.[key]
  return typeof value === "string" ? value : ""
}

/** The agreements a customer's booking may be charged to: the customer's own, signed. */
export function agreementsOfCustomer<T extends BusinessRecord>(agreements: readonly T[], customerId: string): T[] {
  return agreements.filter((record) => customerId !== "" && valueOf(record, "customerId") === customerId && record.status === "Active")
}

/** The places a booking under an agreement may be at: those its subscriptions serve, not ended — the property's or the shared point's web id. The API judges the day. */
export function placesOfAgreement(subscriptions: readonly BusinessRecord[], agreementId: string): ReadonlySet<string> {
  const places = new Set<string>()
  for (const subscription of subscriptions) {
    if (agreementId === "" || valueOf(subscription, "agreementId") !== agreementId || subscription.status === "Expired") continue
    const place = valueOf(subscription, "propertyId") || valueOf(subscription, "sharedPointId")
    if (place !== "") places.add(place)
  }
  return places
}

/** The routes a booking may be put on: its project's, running on its day, not started. */
export function routesForBooking<T extends BusinessRecord>(routes: readonly T[], booking: BusinessRecord): T[] {
  const projectId = valueOf(booking, "projectId")
  const day = valueOf(booking, BULKY_DAY_KEY)
  return routes.filter((route) => valueOf(route, "projectId") === projectId && valueOf(route, "operatingDate") === day && ["planned", "ready"].includes(valueOf(route, "status")))
}

/** The bookings a route's Add stop may collect: booked ones of its project for the day it runs, as the picker offers them. */
export function bookingsForRoute(bookings: readonly BusinessRecord[], route: BusinessRecord): { value: string; label: string }[] {
  const projectId = valueOf(route, "projectId")
  const day = valueOf(route, "operatingDate")
  return bookings.filter((booking) => bookingMoves(booking) && valueOf(booking, "projectId") === projectId && valueOf(booking, BULKY_DAY_KEY) === day).map((booking) => ({ value: booking.id, label: `${booking.context} · ${booking.description}` }))
}

/** A booking's place by web id, and which of the two it is; undefined where the row names none. */
export function bookingPlaceOf(booking: BusinessRecord): { kind: "property" | "point"; webId: string } | undefined {
  const property = valueOf(booking, "propertyId")
  if (property !== "") return { kind: "property", webId: property }
  const point = valueOf(booking, "sharedCollectionPointId")
  return point === "" ? undefined : { kind: "point", webId: point }
}

/** The booking moved to another day: the row the store patches, its day alone changed. */
export const withBookingDay = (booking: BusinessRecord, day: string): BusinessRecord => ({ ...booking, value: day, submittedValues: { ...booking.submittedValues, [BULKY_DAY_KEY]: day } })

/** Whether a booking's details offer Route, Change day and Cancel: only a booked one moves. */
export const bookingMoves = (record: BusinessRecord): boolean => valueOf(record, BULKY_STATUS_KEY) === "booked"

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/** What the person's role lets them do with the schedules — the route schemes' module, the API's grant for them — and whether it reads the areas and the products they name. */
export const scheduleAccessOf = (grants: Grants | undefined) => ({
  view: allows(grants, "route-studio.schemes", "view"),
  create: allows(grants, "route-studio.schemes", "create"),
  edit: allows(grants, "route-studio.schemes", "edit"),
  areas: allows(grants, "configure.areas", "view"),
  products: allows(grants, "commercial.products", "view"),
})

/** A schedule as its dialog edits it: every value a string, as the inputs hold them; the last day in force where the wire's `validTo` is the first day out. */
export type ScheduleForm = {
  planningAreaId: string
  frequency: RecurrenceFrequency
  serviceDays: ServiceDay[]
  weekRotation: WeekRotation | ""
  holidayPolicy: HolidayPolicy
  slotsPerDay: string
  productId: string
  validFrom: string
  lastDay: string
}

/** What a schedule's dialog refuses, at the field it names. */
export type ScheduleRefusal = { field: keyof ScheduleForm; message: string }

export const isScheduleRefusal = (value: unknown): value is ScheduleRefusal => typeof value === "object" && value !== null && "field" in value && "message" in value

export const FREQUENCY_OPTIONS = OFFERED_RECURRENCE_FREQUENCIES.map((value) => ({ value, label: RECURRENCE_FREQUENCY_LABELS[value] }))
export const HOLIDAY_POLICY_OPTIONS = (Object.keys(HOLIDAY_POLICY_LABELS) as HolidayPolicy[]).map((value) => ({ value, label: HOLIDAY_POLICY_LABELS[value] }))
export const SERVICE_DAY_OPTIONS = SERVICE_DAYS.map((value) => ({ value, label: SERVICE_DAY_LABELS[value] }))

export const newScheduleForm = (today: string): ScheduleForm => ({ planningAreaId: "", frequency: "weekly", serviceDays: [], weekRotation: "", holidayPolicy: "skip", slotsPerDay: "", productId: "", validFrom: today, lastDay: "" })

export const scheduleFormOf = (schedule: BulkySchedule): ScheduleForm => ({
  planningAreaId: schedule.planningAreaId,
  frequency: schedule.frequency,
  serviceDays: [...schedule.serviceDays],
  weekRotation: schedule.weekRotation ?? "",
  holidayPolicy: schedule.holidayPolicy,
  slotsPerDay: String(schedule.slotsPerDay),
  productId: schedule.productId,
  validFrom: schedule.validFrom,
  lastDay: schedule.validTo === null ? "" : addDays(schedule.validTo, -1),
})

const slotsOf = (form: ScheduleForm): number | ScheduleRefusal => {
  const slots = Number(form.slotsPerDay)
  return Number.isInteger(slots) && slots >= 1 && slots <= 1000 ? slots : { field: "slotsPerDay", message: "Give the slots a day as a whole number from 1 to 1000" }
}

/** The end a form names, as the wire's first day out, or a refusal where it does not come after the start. */
const endOf = (form: ScheduleForm): string | null | ScheduleRefusal => {
  if (form.lastDay === "") return null
  return form.lastDay < form.validFrom ? { field: "lastDay", message: "The last day in force comes on or after the first" } : addDays(form.lastDay, 1)
}

/** `POST /bulky-schedules`: the area, the recurrence, the slots, the product and the period, or the first refusal. */
export function scheduleCreateBodyOf(projectId: string, form: ScheduleForm): BulkyScheduleCreate | ScheduleRefusal {
  if (form.planningAreaId === "") return { field: "planningAreaId", message: "Pick the planning area the days are for" }
  if (form.serviceDays.length === 0 && form.frequency !== "daily") return { field: "serviceDays", message: "Pick a service day at least" }
  const fortnightly = form.frequency === "every-2-weeks"
  if (fortnightly && form.weekRotation === "") return { field: "weekRotation", message: "Pick the weeks an every-2-weeks schedule serves" }
  const slots = slotsOf(form)
  if (typeof slots !== "number") return slots
  if (form.productId === "") return { field: "productId", message: "Pick the product a booking is charged at" }
  if (form.validFrom === "") return { field: "validFrom", message: "Pick the first day in force" }
  const validTo = endOf(form)
  if (isScheduleRefusal(validTo)) return validTo
  return {
    projectId,
    planningAreaId: form.planningAreaId,
    frequency: form.frequency,
    serviceDays: form.serviceDays.length === 0 ? [...SERVICE_DAYS] : [...form.serviceDays],
    weekRotation: fortnightly ? (form.weekRotation as WeekRotation) : null,
    holidayPolicy: form.holidayPolicy,
    slotsPerDay: slots,
    productId: form.productId,
    validFrom: form.validFrom,
    validTo,
  }
}

/** `PATCH /bulky-schedules/:id`: the slots, the product and the end that moved, null where nothing did, or the first refusal. */
export function schedulePatchBodyOf(schedule: BulkySchedule, form: ScheduleForm): BulkySchedulePatch | null | ScheduleRefusal {
  const slots = slotsOf(form)
  if (typeof slots !== "number") return slots
  const validTo = endOf(form)
  if (isScheduleRefusal(validTo)) return validTo
  const patch: BulkySchedulePatch = {}
  if (slots !== schedule.slotsPerDay) patch.slotsPerDay = slots
  if (form.productId !== "" && form.productId !== schedule.productId) patch.productId = form.productId
  if (validTo !== schedule.validTo) patch.validTo = validTo
  return Object.keys(patch).length === 0 ? null : patch
}

/** "Every week on Tuesday", "Every 2 weeks on Monday, odd weeks", "Daily": what a schedule's days are. */
export function recurrenceSentence(schedule: Pick<BulkySchedule, "frequency" | "serviceDays" | "weekRotation">): string {
  if (schedule.frequency === "daily") return RECURRENCE_FREQUENCY_LABELS.daily
  const days = SERVICE_DAYS.filter((day) => schedule.serviceDays.includes(day)).map((day) => SERVICE_DAY_LABELS[day])
  const rotation = schedule.weekRotation === null ? "" : `, ${schedule.weekRotation} weeks`
  return `${RECURRENCE_FREQUENCY_LABELS[schedule.frequency]} on ${days.join(", ")}${rotation}`
}

/** "12 slots a day", "1 slot a day". */
export const slotsSentence = (slots: number): string => `${slots} ${slots === 1 ? "slot" : "slots"} a day`

/** "From 2027-01-01", "2027-01-01 to 2027-06-30": a period by its last day in force. */
export const periodSentence = (period: { validFrom: string; validTo: string | null }): string =>
  period.validTo === null ? `From ${period.validFrom}` : `${period.validFrom} to ${addDays(period.validTo, -1)}`

/** The schedules a project holds, by their area's name then their start. */
export function schedulesInOrder(schedules: readonly BulkySchedule[], areaName: (id: string) => string): BulkySchedule[] {
  return [...schedules].sort((a, b) => areaName(a.planningAreaId).localeCompare(areaName(b.planningAreaId)) || a.validFrom.localeCompare(b.validFrom))
}
