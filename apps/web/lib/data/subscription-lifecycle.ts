// A subscription's and an agreement's lifecycle on the Pilot (#291, slice
// 10c): the dialogs of a change of service, a pause and a termination, and
// the readings their answers are told in. The dialogs spell the office's
// days as every effective-dated form here does — a change by the first day
// of the new service, a pause and a termination by their last day in — and
// the adapter's actions turn them into the wire's, whose ends are the first
// day out (lib/api/records/agreements.ts). What a pause offers and how it
// reads is judged on the project's day, the day the API's own clock rules
// are judged on.
import type { StopToRemove, SubscriptionPause } from "@waste/contracts/agreements"
import { lastDayIn, periodOn, type PeriodStanding } from "@waste/domain/periods"
import { count } from "@waste/domain/text"

import type { BusinessFormField, BusinessFormOption, BusinessFormSchema } from "./business-form-types"

const dialog = (recordKind: string, title: string, description: string, submitLabel: string, fields: readonly BusinessFormField[], warning?: string): BusinessFormSchema => ({
  key: "customers.agreements",
  mode: "action",
  recordKind,
  title,
  description,
  ...(warning === undefined ? {} : { warning }),
  submitLabel,
  sections: [{ id: "command", title, fields }],
  // The form dialog shows no dialog without an execution: what it does is append to the row's lifecycle.
  execution: { kind: "append-event", completionMessage: `${title} recorded.` },
})

/** Change service: the replacement's first day, and the product or the quantity it takes — what is left blank stays as it is. The products are the subscription's project's. */
export const CHANGE_SERVICE_FORM = (products: readonly BusinessFormOption[]): BusinessFormSchema =>
  dialog("Subscription", "Change service", "The subscription ends the day before and a new one begins with the product or the quantity given, at the same place; its bins go on serving it, with nothing moved.", "Change service", [
    { id: "from", label: "New service from", type: "date", required: true, description: "The first day of the new service." },
    { id: "productId", label: "Product", type: "select", options: products, description: "Blank keeps the product." },
    { id: "quantity", label: "Quantity", type: "number", min: 1, description: "Blank keeps the quantity." },
  ], "The subscription ends the day before the new service begins.")

export const PAUSE_FORM: BusinessFormSchema = dialog("Subscription pause", "Pause", "No collection is planned for the subscription's bins while it is paused; a stop already dispatched is named for removal by hand.", "Pause", [
  { id: "from", label: "Paused from", type: "date", required: true, description: "Today or later." },
  { id: "lastDay", label: "Last day paused", type: "date", description: "Blank pauses it until it is resumed." },
])

export const TERMINATE_FORM: BusinessFormSchema = dialog("Agreement", "Terminate", "The agreement, its subscriptions and their placements end after this day; the bins stay in service until they are collected.", "Terminate", [
  { id: "lastDay", label: "Last day of service", type: "date", required: true },
], "The agreement, its subscriptions and their placements end after this day.")

export function pauseOffers(pause: Pick<SubscriptionPause, "validFrom" | "validTo">, today: string): "cancel" | "resume" | null {
  return PAUSE_OFFERS[periodOn(pause, today)]
}

const PAUSE_OFFERS: Record<PeriodStanding, "cancel" | "resume" | null> = { upcoming: "cancel", "in-force": "resume", ended: null }

export function pauseLine(pause: Pick<SubscriptionPause, "validFrom" | "validTo">, today: string): string {
  const span = pause.validTo === null ? `from ${pause.validFrom} until resumed` : `${pause.validFrom} – ${lastDayIn(pause.validTo)}`
  const offers = pauseOffers(pause, today)
  return `Paused ${span} · ${offers === "cancel" ? "planned" : offers === "resume" ? "running" : "ended"}`
}

const NAMED = 3

/** The sentence the stops a command left standing are told in, by route and day; null where it left none. */
export function stopsToRemoveSentence(stops: readonly StopToRemove[]): string | null {
  if (stops.length === 0) return null
  const named = stops.slice(0, NAMED).map((stop) => `${stop.routeLabel} on ${stop.operatingDate}`)
  const rest = stops.length > NAMED ? ` and ${stops.length - NAMED} more` : ""
  return `${count(stops.length, "stop")} to remove by hand: ${named.join(", ")}${rest}`
}
