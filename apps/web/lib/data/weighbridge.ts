// Route Studio › Weighbridge (O27 of #290): the tickets a station's
// weighbridge sent, `weighbridge-ticket-<uuid>` from the start, read from
// `GET /weighbridge-tickets` (lib/api/records/weighbridge.ts). The office
// never makes one — the weighbridge does — so the module has no create; an
// unmatched ticket's details offer Match, to a route that ran and a fraction,
// and Dismiss, with why. The words a person reads for a status and for the
// reason a ticket waited are here, beside the two forms.
import type { WeighbridgeTicketStatus, WeighbridgeUnmatchedReason } from "@waste/domain/execution/vocabulary"

import type { BusinessFormSchema } from "@/lib/data/business-form-types"
import type { ModuleLocation } from "@/lib/data/business-modules"

export const WEIGHBRIDGE_MODULE: ModuleLocation = { workspaceId: "route-studio", moduleId: "weighbridge" }
export const WEIGHBRIDGE_PREFIX = "weighbridge-ticket"
export const WEIGHBRIDGE_RECORD_KIND = "Weighbridge ticket"

/** A ticket's status as the queue reads it. */
export const TICKET_STATUS_LABELS: Readonly<Record<WeighbridgeTicketStatus, string>> = { unmatched: "Unmatched", matched: "Matched", dismissed: "Dismissed" }

/** Why a ticket found no route, in the office's words. */
export const UNMATCHED_LABELS: Readonly<Record<WeighbridgeUnmatchedReason, string>> = {
  "unknown-vehicle": "No vehicle has this plate",
  "no-route": "The vehicle ran no route then",
  "several-routes": "The vehicle ran several routes that day",
  "unknown-fraction": "No fraction matches the product",
  "fraction-not-accepted": "The station does not take the fraction",
}

/** Match: the route the load came off and its fraction; the options are the surface's, from the routes that ran and the master data's fractions. */
export const MATCH_FORM: BusinessFormSchema = {
  key: "route-studio.weighbridge",
  mode: "action",
  recordKind: WEIGHBRIDGE_RECORD_KIND,
  title: "Match ticket",
  description: "The route the weighed load came off, and what it was. The ticket is written as the route's unload, from the weighbridge, and waits in Weight Control for its review.",
  submitLabel: "Match",
  sections: [
    {
      id: "match",
      title: "Match ticket",
      fields: [
        { id: "routeId", label: "Route", type: "select", required: true, description: "A route that ran: active or completed." },
        { id: "wasteFractionId", label: "Waste fraction", type: "select", required: true, description: "One the station takes." },
      ],
    },
  ],
  execution: { kind: "append-event", completionMessage: "Ticket matched." },
}

/** Dismiss: why no route of ours carried the load. */
export const DISMISS_FORM: BusinessFormSchema = {
  key: "route-studio.weighbridge",
  mode: "action",
  recordKind: WEIGHBRIDGE_RECORD_KIND,
  title: "Dismiss ticket",
  description: "A ticket no route of ours carried — a visitor's trailer, a test weighing. Nothing is written as an unload.",
  submitLabel: "Dismiss",
  sections: [{ id: "dismiss", title: "Dismiss ticket", fields: [{ id: "note", label: "Why", type: "textarea", required: true }] }],
  execution: { kind: "append-event", completionMessage: "Ticket dismissed." },
}
