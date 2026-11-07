// Operate › Scale house (M16a of #293): the window of one of our own sites
// with a weighbridge — the tickets weighed there, `scale-ticket-<uuid>`, and
// the register of tares they may be completed on, `vehicle-tare-<uuid>`,
// read from `GET /scale-tickets` and `GET /vehicle-tares`
// (lib/api/records/scale-house.ts). A ticket is weighed in at its gross for
// an account customer under one of its agreements or a walk-in, weighed out
// at its tare — a second pass or the registered tare — with its load split
// into lines by fraction and origin municipality, and voided with its reason,
// never deleted. The window splits a load into up to three lines; the API
// takes twenty. A line may name the window's product it is sold by, per tonne
// or per cubic metre with its volume, and a completed ticket shows what it
// comes to (M16b of #293); nothing here takes a payment. The words a person
// reads, and the forms, are here.
import type { ScaleTicketParty, ScaleTicketStatus, ScaleTicketVoidReason, TareSource, VehicleTareStatus } from "@waste/domain/scale-house/vocabulary"

import { moduleAt } from "@/lib/modules/manifest"
import type { BusinessFormSchema } from "@/lib/data/business-form-types"
import type { ModuleLocation } from "@/lib/data/business-modules"

export const SCALE_HOUSE_MODULE = moduleAt("operate.scale-house") satisfies ModuleLocation
export const SCALE_TICKET_PREFIX = "scale-ticket"
export const SCALE_TICKET_RECORD_KIND = "Scale ticket"
export const VEHICLE_TARE_PREFIX = "vehicle-tare"
export const VEHICLE_TARE_RECORD_KIND = "Registered tare"

/** The lines the window's Weigh out form splits a load into. */
export const WINDOW_LINES = 3

/** A ticket's status as the window reads it. */
export const SCALE_TICKET_STATUS_LABELS: Readonly<Record<ScaleTicketStatus, string>> = { open: "Weighed in", completed: "Completed", voided: "Voided" }

/** A registered tare's status. */
export const VEHICLE_TARE_STATUS_LABELS: Readonly<Record<VehicleTareStatus, string>> = { active: "Active", retired: "Retired" }

/** Whom a ticket is for. */
export const PARTY_LABELS: Readonly<Record<ScaleTicketParty, string>> = { account: "Account customer", cash: "Walk-in" }

/** Where a ticket's tare came from. */
export const TARE_SOURCE_LABELS: Readonly<Record<TareSource, string>> = { weighed: "Second pass", registered: "Registered tare" }

/** Why a ticket was voided. */
export const VOID_REASON_LABELS: Readonly<Record<ScaleTicketVoidReason, string>> = {
  "entered-in-error": "Entered in error",
  duplicate: "Duplicate of another ticket",
  "visitor-left": "Visitor left before the second pass",
  other: "Another reason (say why)",
}

const projectRelation = { workspaceId: "configure", moduleId: "organization" } as const
const customerRelation = { workspaceId: "customers", moduleId: "contacts" } as const
const agreementRelation = { workspaceId: "customers", moduleId: "agreements" } as const
/** The places module holds the depots and the stations; the window offers our own stations with a weighbridge alone. */
const stationRelation = { workspaceId: "resources", moduleId: "depots" } as const
const masterRelation = { workspaceId: "configure", moduleId: "master" } as const

/** Weigh in: the first pass, at the gross. The site's options are the surface's: our own stations with a weighbridge. */
export const WEIGH_IN_FORM: BusinessFormSchema = {
  key: "operate.scale-house",
  mode: "create",
  recordKind: SCALE_TICKET_RECORD_KIND,
  title: "Weigh in",
  description: "The first pass over the scale: the vehicle at its gross, for an account customer under one of its agreements or a walk-in. The ticket is numbered when the API takes it.",
  submitLabel: "Weigh in",
  nameField: "vehiclePlate",
  sections: [
    {
      id: "vehicle",
      title: "Vehicle",
      fields: [
        { id: "projectId", label: "Project", type: "select", required: true, relation: projectRelation },
        { id: "unloadingStationId", label: "Site", type: "select", required: true, relation: stationRelation, description: "One of our own stations with a weighbridge." },
        { id: "vehiclePlate", label: "Plate", type: "text", required: true },
        { id: "trailerPlate", label: "Trailer plate", type: "text" },
        { id: "containerRef", label: "Container", type: "text", description: "The skip or container it carries, where its tare is registered with it." },
        { id: "grossKg", label: "Gross (kg)", type: "number", required: true },
      ],
    },
    {
      id: "party",
      title: "For",
      fields: [
        {
          id: "party",
          label: "Customer",
          type: "select",
          required: true,
          defaultValue: "cash",
          options: [
            { value: "cash", label: PARTY_LABELS.cash },
            { value: "account", label: PARTY_LABELS.account },
          ],
        },
        { id: "customerId", label: "Account customer", type: "select", relation: customerRelation, visibleWhen: { fieldId: "party", equals: "account" } },
        { id: "agreementId", label: "Agreement", type: "select", relation: agreementRelation, visibleWhen: { fieldId: "party", equals: "account" } },
        { id: "visitorName", label: "Visitor's name", type: "text", visibleWhen: { fieldId: "party", equals: "cash" } },
        { id: "note", label: "Note", type: "textarea" },
      ],
    },
  ],
  execution: { kind: "create-record", initialStatus: "Weighed in", completionMessage: "Weighed in." },
}

/** The window's products: those sold by the tonne or the cubic metre (M16b of #293). */
const productRelation = { workspaceId: "commercial", moduleId: "products" } as const

/** The fields of one line of the Weigh out form, numbered from 1; the first is required. A line sold by the cubic metre declares its volume. */
const lineFields = (n: number) => [
  { id: `fraction${n}`, label: `Fraction ${n}`, type: "select" as const, required: n === 1, relation: masterRelation },
  { id: `origin${n}`, label: `Origin municipality ${n}`, type: "text" as const, description: n === 1 ? "The kommunekode, four digits: 0101." : undefined },
  { id: `net${n}`, label: `Net ${n} (kg)`, type: "number" as const, required: n === 1 },
  { id: `product${n}`, label: `Sold as ${n}`, type: "select" as const, relation: productRelation, description: n === 1 ? "The window's product, by the tonne or the cubic metre: what an account is charged and a walk-in pays." : undefined },
  { id: `volume${n}`, label: `Volume ${n} (m³)`, type: "number" as const, description: n === 1 ? "For a load sold by the cubic metre: 1.5." : undefined },
]

/** Weigh out: the tare, and the load split into lines that sum to the net. The fractions' options are the surface's. */
export const WEIGH_OUT_FORM: BusinessFormSchema = {
  key: "operate.scale-house",
  mode: "action",
  recordKind: SCALE_TICKET_RECORD_KIND,
  title: "Weigh out",
  description: "The tare from a second pass or the vehicle's registered tare, and the load split by fraction and origin. The lines sum to the net. One of our own vehicles' load is one fraction, written as its route's unload.",
  submitLabel: "Weigh out",
  sections: [
    {
      id: "tare",
      title: "Tare",
      fields: [
        {
          id: "tareSource",
          label: "Tare from",
          type: "select",
          required: true,
          defaultValue: "weighed",
          options: [
            { value: "weighed", label: TARE_SOURCE_LABELS.weighed },
            { value: "registered", label: TARE_SOURCE_LABELS.registered },
          ],
        },
        { id: "tareKg", label: "Tare (kg)", type: "number", visibleWhen: { fieldId: "tareSource", equals: "weighed" } },
      ],
    },
    { id: "lines", title: "Load", fields: Array.from({ length: WINDOW_LINES }, (_, index) => lineFields(index + 1)).flat() },
  ],
  execution: { kind: "append-event", completionMessage: "Ticket completed." },
}

/** Void: why, and more where the reason is another. */
export const VOID_TICKET_FORM: BusinessFormSchema = {
  key: "operate.scale-house",
  mode: "action",
  recordKind: SCALE_TICKET_RECORD_KIND,
  title: "Void ticket",
  description: "The ticket stays, voided with its reason: it is what the customer was handed.",
  warning: "A voided ticket stays voided, with its reason.",
  submitLabel: "Void",
  sections: [
    {
      id: "void",
      title: "Void ticket",
      fields: [
        { id: "reason", label: "Reason", type: "select", required: true, options: Object.entries(VOID_REASON_LABELS).map(([value, label]) => ({ value, label })) },
        { id: "note", label: "Note", type: "textarea" },
      ],
    },
  ],
  execution: { kind: "append-event", completionMessage: "Ticket voided." },
}

/** Register tare: a vehicle's weight empty, by its plate, its trailer's and the container it carries. */
export const TARE_FORM: BusinessFormSchema = {
  key: "operate.scale-house",
  mode: "create",
  recordKind: VEHICLE_TARE_RECORD_KIND,
  title: "Register tare",
  description: "A vehicle's weight empty, found at the window by its plate and, where it is weighed with them, its trailer's plate and its container. One is active per plate, trailer and container.",
  submitLabel: "Register tare",
  nameField: "plate",
  sections: [
    {
      id: "tare",
      title: "Tare",
      fields: [
        { id: "projectId", label: "Project", type: "select", required: true, relation: projectRelation },
        { id: "plate", label: "Plate", type: "text", required: true },
        { id: "trailerPlate", label: "Trailer plate", type: "text" },
        { id: "containerRef", label: "Container", type: "text" },
        { id: "tareKg", label: "Tare (kg)", type: "number", required: true },
        { id: "weighedOn", label: "Weighed on", type: "date", required: true },
        { id: "customerId", label: "Haulier", type: "select", relation: customerRelation },
        { id: "label", label: "Label", type: "text" },
      ],
    },
  ],
  execution: { kind: "create-record", initialStatus: "Active", completionMessage: "Tare registered." },
}

/** Re-weigh: the tare's new weight and its day. */
export const REWEIGH_FORM: BusinessFormSchema = {
  key: "operate.scale-house",
  mode: "action",
  recordKind: VEHICLE_TARE_RECORD_KIND,
  title: "Re-weigh tare",
  description: "The vehicle weighed empty again. Tickets already completed on it keep the tare they were completed at.",
  submitLabel: "Save tare",
  sections: [
    {
      id: "reweigh",
      title: "Re-weigh tare",
      fields: [
        { id: "tareKg", label: "Tare (kg)", type: "number", required: true },
        { id: "weighedOn", label: "Weighed on", type: "date", required: true },
      ],
    },
  ],
  execution: { kind: "append-event", completionMessage: "Tare re-weighed." },
}
