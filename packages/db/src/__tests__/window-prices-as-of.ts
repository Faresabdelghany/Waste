// What the window prices' migration (M16b of #293) grew, as the weight
// charges' migration (O28 of #290) left it: the product's units before `m3`,
// the billable event's kinds before `scale-ticket` and its cancel reasons
// before `scale-ticket-voided`, the fourth, and the event's kind shape before
// the window line's clause. The outbox's vocabulary is in outbox-as-of.ts.
// Every rendering test that pins a migration from before the window prices'
// spells these, since an applied file is never edited and the domain and the
// schema module spell each as it is today.
import assert from "node:assert/strict"

import { BILLABLE_EVENT_KINDS, CANCEL_REASONS } from "@waste/domain/finance/vocabulary"
import { PRODUCT_UNITS } from "@waste/domain/registry/vocabulary"

import { billableEvent } from "../schema/finance"
import { checksOf, ref } from "./rendering"

/** The product's units as of the weight charges': everything until a scale-house line's cubic metre. */
export const PRODUCT_UNITS_AS_OF_WEIGHT_CHARGES = PRODUCT_UNITS.filter((unit) => unit !== "m3")

/** The billable event's kinds as of the weight charges': everything until a window line's charge. */
export const BILLABLE_EVENT_KINDS_AS_OF_WEIGHT_CHARGES = BILLABLE_EVENT_KINDS.filter((kind) => kind !== "scale-ticket")

/** The billable event's cancel reasons as of the weight charges': everything until a voided Scale Ticket's. */
export const CANCEL_REASONS_AS_OF_WEIGHT_CHARGES = CANCEL_REASONS.filter((reason) => reason !== "scale-ticket-voided")

/** The clause the window prices' migration added to the event's kind shape, last before its `else`: a window line's charge names its line and nothing of a stop's, a ticket's or a reversal's. */
export const SCALE_TICKET_CLAUSE = ` when 'scale-ticket' then ${ref("billable_event", "scale_ticket_line_id")} is not null and ${ref("billable_event", "pickup_id")} is null and ${ref("billable_event", "ticket_id")} is null and ${ref("billable_event", "reverses_event_id")} is null`

/** The event's kind shape as the weight charges' migration spelled it: today's, read from the schema, less the window line's clause. */
export const kindShapeAsOfWeightCharges = (): string => {
  const today = checksOf(billableEvent).get("billable_event_kind_shape") ?? ""
  assert.ok(today.includes(SCALE_TICKET_CLAUSE), "today's kind shape carries the window line's clause")
  return today.replace(SCALE_TICKET_CLAUSE, "")
}
