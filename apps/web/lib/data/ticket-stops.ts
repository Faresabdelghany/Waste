// Book a stop on a ticket (O3c of #290): a container request answered by a
// delivery, an overflow by an emptying, a defective container by a repair or a
// swap. The dialog is Add stop's (`ROUTE_COMMAND_FORMS["add-stop"]`) with the
// route first — a planned or ready route of the ticket's project — and only
// the services the ticket's kind answers (`servicesAnswering`), opened on what
// the ticket is about; the input goes to the route picked as its Add stop,
// naming the ticket, and the API holds the ticket to the stop.
import { isStopTicketKind, servicesAnswering, type StopTicketKind } from "@waste/domain/execution/ticket-stops"
import { OPEN_TICKET_STATUSES, type TicketKind } from "@waste/domain/resolution/vocabulary"

import type { BusinessFormField, BusinessFormOption, BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import type { BusinessRecord } from "./business-modules"
import { ROUTE_COMMAND_FORMS, STOP_AT_BULKY_BOOKING, STOP_AT_CONTAINER, STOP_AT_POINT, STOP_AT_PROPERTY } from "./routes"

/** Whether a ticket of this kind and status offers Book a stop: an open one a stop answers. */
export const offersBookAStop = (kind: string, status: string): boolean => (OPEN_TICKET_STATUSES as readonly string[]).includes(status) && isStopTicketKind(kind as TicketKind)

/** The route the stop goes on, picked from the ticket's project's routes that have not started. */
const routeField = (options: readonly BusinessFormOption[]): BusinessFormField => ({
  id: "routeId",
  label: "Route",
  type: "select",
  required: true,
  options,
  description: options.length === 0 ? NO_ROUTE_TO_BOOK_ON : "A planned or ready route of the ticket's project; the stop goes after its last one.",
})

/** What Book a stop says where the ticket's project has no route a stop may still be added to. */
export const NO_ROUTE_TO_BOOK_ON = "No route of the ticket's project is planned or ready: make one in Route Studio, then book the stop."

/** Why Book a stop is not offered yet: the routes are being read, or the person's role reads none; undefined once they are read. */
export function bookAStopWaits(routes: { status: string } | null | undefined): string | undefined {
  if (routes === null || routes === undefined || routes.status === "not-granted") return "Your role does not see the routes a stop is booked on."
  return routes.status === "ready" ? undefined : "Reading the routes a stop may be booked on…"
}

/** Book a stop's dialog: the route, then Add stop's fields with only the services the ticket's kind answers; a work order is of a container, and a ticket's stop is never a bulky booking's. */
export function bookStopForm(kind: StopTicketKind, routes: readonly BusinessFormOption[]): BusinessFormSchema {
  const addStop = ROUTE_COMMAND_FORMS["add-stop"]
  const answers: readonly string[] = servicesAnswering(kind)
  const fields = addStop.sections.flatMap((section) => section.fields).filter((field) => field.id !== "bulkyBookingId").map((field): BusinessFormField => {
    if (field.id === "service") return { ...field, defaultValue: answers[0], options: field.options?.filter((option) => answers.includes(String(option.value))) }
    if (field.id === "stopAt") return { ...field, options: field.options?.filter((option) => answers.includes("empty") ? option.value !== STOP_AT_BULKY_BOOKING : option.value === STOP_AT_CONTAINER) }
    return field
  })
  return {
    ...addStop,
    title: "Book a stop",
    description: "A stop on a route that has not started, booked to answer this ticket: the ticket names it, and its completion services the ticket.",
    submitLabel: "Book stop",
    sections: [{ id: "command", title: "Book a stop", fields: [routeField(routes), ...fields] }],
    execution: { kind: "append-event", completionMessage: "The stop was booked." },
  }
}

const valueOf = (record: Pick<BusinessRecord, "submittedValues">, key: string) => {
  const value = record.submittedValues?.[key]
  return typeof value === "string" && value !== "" ? value : undefined
}

/** What Book a stop opens on: the first service the kind answers, and what the ticket is about — a defect's or an overflow's container, else an overflow's place; a request's container is the one delivered, picked from stock. */
export function bookStopValues(ticket: Pick<BusinessRecord, "submittedValues">): BusinessFormValues {
  const kind = (valueOf(ticket, "kind") ?? "") as TicketKind
  const values: BusinessFormValues = { service: servicesAnswering(kind)[0] ?? "empty", stopAt: STOP_AT_CONTAINER }
  if (kind === "container-request") return values
  const containerId = valueOf(ticket, "containerId")
  if (containerId !== undefined) return { ...values, containerId }
  if (kind !== "overflow") return values
  const propertyId = valueOf(ticket, "propertyId")
  if (propertyId !== undefined) return { ...values, stopAt: STOP_AT_PROPERTY, propertyId }
  const sharedCollectionPointId = valueOf(ticket, "sharedCollectionPointId")
  return sharedCollectionPointId === undefined ? values : { ...values, stopAt: STOP_AT_POINT, sharedCollectionPointId }
}

/** The route picked and Add stop's input for it, naming the ticket by its web id. */
export function bookStopInput(values: BusinessFormValues, ticketWebId: string): { routeId: string | undefined; input: BusinessFormValues } {
  const { routeId, ...input } = values
  return { routeId: typeof routeId === "string" && routeId !== "" ? routeId : undefined, input: { ...input, ticketId: ticketWebId } }
}

/** The ticket's project's routes a stop may still be added to — planned or ready — by label and day, the soonest first. */
export function bookableRoutes(routes: readonly BusinessRecord[], projectWebId: string | undefined): BusinessFormOption[] {
  const day = (route: BusinessRecord) => valueOf(route, "operatingDate") ?? ""
  return routes
    .filter((route) => (route.status === "Planned" || route.status === "Ready") && (projectWebId === undefined || (route.projectIds ?? []).includes(projectWebId)))
    .toSorted((a, b) => day(a).localeCompare(day(b)) || a.name.localeCompare(b.name))
    .map((route) => ({ value: route.id, label: `${route.name} · ${day(route)}` }))
}
