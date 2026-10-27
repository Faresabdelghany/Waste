// Operate › Bulky Bookings on the API (O11 of #290): a customer's bulky items
// booked onto a day of their area's Bulky Schedule, `bulky-booking-<uuid>`
// from the start. The record names the customer, the place, the agreement and
// the fraction through the store's resolver, its items as one line, its day,
// and the stop that routes it; its status — booked, routed, collected,
// cancelled — is the API's reading and moves by command alone: `route` puts
// it on a route of its day as a stop (`POST /routes/:id/pickups`, which the
// routes and the stops are read again after), `cancel` stamps it with why.
// A patch moves a booked one's day, items or note; the customer, the place,
// the agreement and the fraction stay — cancel it and book again. The words
// are lib/data/bulky.ts'; the routes apps/api/src/routes/bulky-bookings.ts.
import type { BulkyAvailability, BulkyAvailableDay, BulkyBooking, BulkyBookingCreate, BulkyBookingPatch, BulkyItem } from "@waste/contracts/bulky"

import { BULKY_BOOKINGS_MODULE, BULKY_DAY_KEY, BULKY_ITEMS_KEY, BULKY_SERVER_ID_KEY, BULKY_STATUS_KEY, BULKY_STATUS_LABELS, itemsSentence, shortDay } from "@/lib/data/bulky"
import { AGREEMENT_PREFIX, isAgreementRecord, PROPERTY_PREFIX, SHARED_POINT_PREFIX } from "@/lib/data/agreements"
import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { isPropertyRecord, isSharedPointRecord } from "@/lib/data/properties"

import { command, create, get, listAll, patch, post, type ApiClient } from "../client"
import { inheritedPresentation, isLocalRefusal, ofKind, stampFacts, typed, webIdOf, type CommandInput, type LocalRefusal, type MappingContext, type RecordCommand, type ResourceAdapter, type ServerModule } from "./adapter"
import { projectMoved, refusal } from "./places"
import { nameVia, typedReference, webIdVia } from "./references"
import { customerAdapter } from "./registry"

export const BULKY_BOOKING_PREFIX = "bulky-booking"
export const BULKY_BOOKING_RECORD_KIND = "Bulky booking"
const CUSTOMER_PREFIX = "customer"
const FRACTION_PREFIX = "fraction"
const ROUTE_PREFIX = "route"

const kept = "A booking stays with its customer, place, agreement and fraction: cancel it and book again"

/** The items a record holds as JSON, as the wire spells them; none where the value is not a list of them. */
export function itemsOfRecord(record: BusinessRecord): BulkyItem[] {
  const raw = typed(record, BULKY_ITEMS_KEY)
  if (raw === undefined) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is BulkyItem => typeof item?.description === "string" && typeof item?.quantity === "number") : []
  } catch {
    return []
  }
}

export function toBulkyBookingRecord(booking: BulkyBooking, context: MappingContext): BusinessRecord {
  const project = context.resolve.byServerId(booking.projectId)
  const projectWebId = project?.id ?? webIdVia(context, "project", booking.projectId)
  const customer = nameVia(context, CUSTOMER_PREFIX, booking.customerId)
  const place = booking.propertyId !== null ? nameVia(context, PROPERTY_PREFIX, booking.propertyId) : nameVia(context, SHARED_POINT_PREFIX, booking.sharedCollectionPointId ?? "")
  const route = booking.stop === null ? undefined : nameVia(context, ROUTE_PREFIX, booking.stop.routeId)
  const items = itemsSentence(booking.items)
  const facts: Record<string, string> = {
    Customer: customer,
    Place: place,
    Day: booking.day,
    Items: items,
    Agreement: nameVia(context, AGREEMENT_PREFIX, booking.agreementId),
    "Waste fraction": nameVia(context, FRACTION_PREFIX, booking.wasteFractionId),
    ...(route === undefined ? {} : { Route: route }),
    ...(booking.note === null ? {} : { Note: booking.note }),
    ...(booking.cancelReason === null ? {} : { "Cancelled because": booking.cancelReason }),
    ...(project?.name === undefined ? {} : { Project: project.name }),
  }
  const reference = (prefix: string, serverId: string | null) => (serverId === null ? "" : webIdVia(context, prefix, serverId))
  return {
    id: webIdOf(BULKY_BOOKING_PREFIX, booking.id),
    name: `Bulky collection · ${place} · ${shortDay(booking.day)}`,
    context: `${customer} · ${place}`,
    status: BULKY_STATUS_LABELS[booking.status],
    ...inheritedPresentation(undefined),
    ...stampFacts(booking, context.now),
    value: booking.day,
    description: items,
    facts,
    companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
    projectIds: [projectWebId],
    recordKind: BULKY_BOOKING_RECORD_KIND,
    submittedValues: {
      projectId: projectWebId,
      customerId: reference(CUSTOMER_PREFIX, booking.customerId),
      agreementId: reference(AGREEMENT_PREFIX, booking.agreementId),
      propertyId: reference(PROPERTY_PREFIX, booking.propertyId),
      sharedCollectionPointId: reference(SHARED_POINT_PREFIX, booking.sharedCollectionPointId),
      wasteFractionId: reference(FRACTION_PREFIX, booking.wasteFractionId),
      [BULKY_DAY_KEY]: booking.day,
      [BULKY_ITEMS_KEY]: JSON.stringify(booking.items),
      note: booking.note ?? "",
      stopRouteId: booking.stop === null ? "" : reference(ROUTE_PREFIX, booking.stop.routeId),
      [BULKY_STATUS_KEY]: booking.status,
      [BULKY_SERVER_ID_KEY]: booking.id,
    },
  }
}

/** `POST /bulky-bookings` from a record the dialog made: every id by the server's, the items as listed. */
export function toBulkyBookingCreateBody(record: BusinessRecord, context: MappingContext): BulkyBookingCreate | LocalRefusal {
  const customerId = typedReference(record, "customerId", CUSTOMER_PREFIX, context, "Pick a customer the API holds", { owns: customerAdapter.owns })
  if (isLocalRefusal(customerId)) return customerId
  if (customerId === undefined) return refusal("customerId", "Pick the customer who books")
  const agreementId = typedReference(record, "agreementId", AGREEMENT_PREFIX, context, "Pick an agreement the API holds", { owns: isAgreementRecord })
  if (isLocalRefusal(agreementId)) return agreementId
  if (agreementId === undefined) return refusal("agreementId", "Pick the agreement the collection is charged to")
  const propertyId = typedReference(record, "propertyId", PROPERTY_PREFIX, context, "Pick a property the API holds", { owns: isPropertyRecord })
  if (isLocalRefusal(propertyId)) return propertyId
  const sharedCollectionPointId = typedReference(record, "sharedCollectionPointId", SHARED_POINT_PREFIX, context, "Pick a shared point the API holds", { owns: isSharedPointRecord })
  if (isLocalRefusal(sharedCollectionPointId)) return sharedCollectionPointId
  if ((propertyId === undefined) === (sharedCollectionPointId === undefined)) return refusal("propertyId", "Pick the property or the shared point, one of the two")
  const wasteFractionId = typedReference(record, "wasteFractionId", FRACTION_PREFIX, context, "Pick a waste fraction the API holds")
  if (isLocalRefusal(wasteFractionId)) return wasteFractionId
  if (wasteFractionId === undefined) return refusal("wasteFractionId", "Pick the waste fraction collected")
  const day = typed(record, BULKY_DAY_KEY)
  if (day === undefined) return refusal("day", "Pick the day the bulky waste is collected")
  const items = itemsOfRecord(record)
  if (items.length === 0) return refusal("items", "List an item at least")
  const note = typed(record, "note")
  return {
    customerId,
    agreementId,
    ...(propertyId === undefined ? {} : { propertyId }),
    ...(sharedCollectionPointId === undefined ? {} : { sharedCollectionPointId }),
    wasteFractionId,
    day,
    items,
    ...(note === undefined ? {} : { note }),
  }
}

/** `PATCH /bulky-bookings/:id`: the day, the items and the note that moved; the rest is the booking's own. */
export function toBulkyBookingPatchBody(before: BusinessRecord, after: BusinessRecord): BulkyBookingPatch | null | LocalRefusal {
  if (projectMoved(before, after)) return refusal("projectId", kept)
  for (const key of ["customerId", "agreementId", "propertyId", "sharedCollectionPointId", "wasteFractionId"] as const) {
    if ((typed(after, key) ?? "") !== (typed(before, key) ?? "")) return refusal(key, kept)
  }
  const body: BulkyBookingPatch = {}
  const day = typed(after, BULKY_DAY_KEY)
  if (day !== undefined && day !== typed(before, BULKY_DAY_KEY)) body.day = day
  const items = itemsOfRecord(after)
  if (JSON.stringify(items) !== JSON.stringify(itemsOfRecord(before))) {
    if (items.length === 0) return refusal("items", "List an item at least")
    body.items = items
  }
  const note = typed(after, "note") ?? null
  if (note !== (typed(before, "note") ?? null)) body.note = note
  return Object.keys(body).length === 0 ? null : body
}

/** The commands, each answering the booking as it now stands. */
export const ROUTE_BOOKING = "route"
export const CANCEL_BOOKING = "cancel"

/** The route a Route command names, by the server's id; a refusal where the store holds no such route. */
function routeBodyOf(input: CommandInput, _record: BusinessRecord, context: MappingContext): { routeId: string } | LocalRefusal {
  const webId = typeof input.routeId === "string" ? input.routeId : ""
  const routeId = webId === "" ? undefined : context.resolve.serverIdOf(webId)
  return routeId === undefined ? refusal("routeId", "Pick a route of the booking's day") : { routeId }
}

export const BULKY_BOOKING_COMMANDS: Readonly<Record<string, RecordCommand<BulkyBooking>>> = {
  [ROUTE_BOOKING]: {
    toBody: routeBodyOf,
    run: async (client, serverId, body) => {
      const { routeId } = body as { routeId: string }
      await post(client, `/routes/${routeId}/pickups`, { service: "bulky", bulkyBookingId: serverId })
      return await get<BulkyBooking>(client, `/bulky-bookings/${serverId}`)
    },
    refused: (record) => `${record.name} was not routed`,
    touches: ["route-studio.routes", "route-studio.pickups"],
  },
  [CANCEL_BOOKING]: {
    toBody: (input) => ({ reason: typeof input.reason === "string" ? input.reason : "" }),
    run: (client, serverId, body) => command<BulkyBooking>(client, `/bulky-bookings/${serverId}/cancel`, body),
    refused: (record) => `${record.name} was not cancelled`,
  },
}

/** The days a place may be booked on over a window, as the API reads them. */
export function bulkyAvailability(client: ApiClient, place: { propertyId?: string; sharedCollectionPointId?: string }, window: { from: string; to: string }): Promise<BulkyAvailableDay[]> {
  const query = new URLSearchParams({ ...place, ...window })
  return get<BulkyAvailability>(client, `/bulky-bookings/availability?${query.toString()}`).then((answer) => answer.days)
}

export const bulkyBookingAdapter: ResourceAdapter<BulkyBooking> = {
  prefix: BULKY_BOOKING_PREFIX,
  auditTable: "bulky_booking",
  // A row the dialog has just made is `bulky-bookings-bulky-booking-<clock>` until the server answers: owned by its recordKind.
  owns: ofKind(BULKY_BOOKING_PREFIX, [BULKY_BOOKING_RECORD_KIND]),
  statuses: undefined,
  list: (client) => listAll<BulkyBooking>(client, "/bulky-bookings"),
  toRecord: toBulkyBookingRecord,
  toCreateBody: toBulkyBookingCreateBody,
  toPatchBody: toBulkyBookingPatchBody,
  create: (client, body) => create<BulkyBooking>(client, "/bulky-bookings", body).then((created) => created.body),
  update: (client, serverId, body) => patch<BulkyBooking>(client, `/bulky-bookings/${serverId}`, body),
  read: (client, serverId) => get<BulkyBooking>(client, `/bulky-bookings/${serverId}`),
  commands: BULKY_BOOKING_COMMANDS,
}

/** Operate › Bulky Bookings: read after the customers, the places, the agreements, the fractions and the routes their rows name. */
export const bulkyBookingsModule: ServerModule = {
  workspaceId: BULKY_BOOKINGS_MODULE.workspaceId,
  moduleId: BULKY_BOOKINGS_MODULE.moduleId,
  resources: [bulkyBookingAdapter],
}
