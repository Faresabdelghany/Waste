// The provider-money chain's forms on the Pilot (Issue #186, slice 11 of #81,
// for #148): what Service Areas, Service Provider Prices, Settlements and
// Weight Control offer once they read the API — the award with its planning
// areas, fractions and first assignment; an assignment and its end; a price
// under an assignment and Apply index; a settlement's period and the reason
// it is reopened; the three weight reviews — for the command surfaces
// (components/waste/commands/provider-money-surfaces.tsx) and, for the award
// and the price, the map's and the provider page's doors (`schemaOverride` in
// business-workspace.tsx). Fixture mode keeps the registry's forms.
//
// Every field id is a key the adapters read (lib/api/records/
// service-areas.ts, provider-money.ts, weights.ts);
// lib/data/__tests__/provider-money-forms.test.ts holds the two together
// through the adapters themselves. The award's fields keep the ids the map's
// seed lands in (`SERVICE_AREA_SEED_FIELDS`: projectId, zoneIds, boundary), so
// a selection opens the form with its planning areas picked; the drawn
// polygon the seed carries beside them is dropped, never persisted (#127).
import { INDEX_BASES } from "@waste/domain/finance/vocabulary"
import type { ServiceAreaSeed } from "@waste/domain/map-planning/service-areas"

import type { WeightReviewCommand } from "@/lib/api/records/weights"

import type { BusinessFormField, BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import type { BusinessRecord, WorkspaceId } from "./business-modules"
import { PRODUCTS_MODULE } from "./commercial"
import { blankNone, editableOnly, editedRecord, text } from "./commercial-forms"
import { mintedRecord, ORGANISATION_MODULE } from "./containers"
import { MASTER_DATA_MODULE } from "./master-data"
import { PLANNING_AREAS_MODULE } from "./planning-areas"
import {
  ASSIGNMENT_RECORD_KIND,
  INDEXED_PRICE_RECORD_KIND,
  isAssignmentRecord,
  PROVIDER_PRICE_RECORD_KIND,
  PROVIDER_PRICES_MODULE,
  SERVICE_AREA_RECORD_KIND,
  SERVICE_AREAS_MODULE,
  SERVICE_PROVIDERS_MODULE,
  SETTLEMENT_RECORD_KIND,
} from "./provider-money"
import { serviceAreaFormValues } from "./service-areas"

const assignment: BusinessFormField = { id: "serviceAreaAssignmentId", label: "Service area assignment", type: "select", required: true, relation: SERVICE_AREAS_MODULE, description: "The provider and the area at once." }
const lastDayIn = (label: string, description: string): BusinessFormField => ({ id: "validTo", label, type: "date", description })

// ---------------------------------------------------------------------------
// Service areas and assignments
// ---------------------------------------------------------------------------

export const SERVICE_AREA_FORM: BusinessFormSchema = {
  key: "service-providers.service-areas",
  mode: "create",
  recordKind: SERVICE_AREA_RECORD_KIND,
  title: "Create service area",
  description: "Award a service area: the planning areas it covers and the waste fractions it is for, over a period, to a provider now or later. A drawn selection only picks the planning areas; the award is them.",
  submitLabel: "Create service area",
  nameField: "areaName",
  sections: [
    {
      id: "award",
      title: "Service area",
      fields: [
        { id: "areaName", label: "Service area name", type: "text", required: true },
        { id: "areaCode", label: "Area code", type: "text", required: true, placeholder: "CA-Ø-2", description: "As the contract spells it; set once." },
        { id: "projectId", label: "Project", type: "select", required: true, relation: ORGANISATION_MODULE },
        { id: "serviceProviderId", label: "Service provider", type: "select", relation: SERVICE_PROVIDERS_MODULE, description: "The first assignment, holding the award over its period. Blank awards it later." },
      ],
    },
    {
      id: "scope",
      title: "Scope and period",
      fields: [
        { id: "boundary", label: "Geographic boundary", type: "textarea", required: true, description: "The contract's own words for the boundary." },
        { id: "zoneIds", label: "Planning areas", type: "multiselect", required: true, relation: PLANNING_AREAS_MODULE, description: "What the award covers: the routes in them are the provider's." },
        { id: "wasteFractionIds", label: "Waste fractions", type: "multiselect", relation: MASTER_DATA_MODULE, description: "What the award is for." },
        { id: "notes", label: "Notes", type: "textarea" },
        { id: "validFrom", label: "Starts", type: "date", required: true },
        lastDayIn("Ends", "The last day in force; open when blank."),
      ],
    },
  ],
  validationRules: [{ type: "date-order", startField: "validFrom", endField: "validTo", message: "The award ends on or after the day it starts", allowSame: true }],
  execution: { kind: "create-record", completionMessage: "The service area was created." },
}

/** What the map's Create service area is told of a selection that touches no planning area, before any form opens. */
export const NO_PLANNING_AREA_SELECTED = "The selection touches no planning area, and a service area is the planning areas it covers: select containers inside one"

/** The map's door on the Pilot: the award's form on the selection's planning areas and boundary, the drawn polygon dropped (#127); a selection of none refused. */
export function pilotServiceAreaCreate(seed: ServiceAreaSeed): { refused: string } | { initialValues: BusinessFormValues; schemaOverride: BusinessFormSchema } {
  if (seed.planningAreaIds.length === 0) return { refused: NO_PLANNING_AREA_SELECTED }
  return { initialValues: serviceAreaFormValues(seed).initialValues, schemaOverride: SERVICE_AREA_FORM }
}

/**
 * The provider page's doors on the Pilot: an award to the provider, or a
 * price under one of its assignments — the service areas module's
 * `serviceAreas`, of which the price's picker offers the provider's alone,
 * its one assignment picked where it has one.
 */
export function pilotProviderCreate(
  target: "service-area" | "service-provider-price",
  serviceProviderId: string,
  today: string,
  serviceAreas: readonly BusinessRecord[],
): { workspaceId: WorkspaceId; moduleId: string; initialValues: BusinessFormValues; schemaOverride: BusinessFormSchema } {
  if (target === "service-area") return { workspaceId: SERVICE_AREAS_MODULE.workspaceId, moduleId: SERVICE_AREAS_MODULE.moduleId, initialValues: { serviceProviderId, validFrom: today }, schemaOverride: SERVICE_AREA_FORM }
  const held = serviceAreas.filter((record) => isAssignmentRecord(record) && record.submittedValues?.serviceProviderId === serviceProviderId).map((record) => record.id)
  const schemaOverride: BusinessFormSchema = {
    ...PROVIDER_PRICE_FORM,
    sections: PROVIDER_PRICE_FORM.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => (field.id === "serviceAreaAssignmentId" && field.relation !== undefined ? { ...field, relation: { ...field.relation, allowedRecordIds: held } } : field)),
    })),
  }
  return { workspaceId: PROVIDER_PRICES_MODULE.workspaceId, moduleId: PROVIDER_PRICES_MODULE.moduleId, initialValues: { validFrom: today, ...(held.length === 1 ? { serviceAreaAssignmentId: held[0] } : {}) }, schemaOverride }
}

/** An award's edit: its name, text, sets, notes and period; its code and project held, its holders in the assignments. */
export const serviceAreaEditForm = (record: BusinessRecord): BusinessFormSchema => {
  const editable = editableOnly(SERVICE_AREA_FORM, ["areaName", "boundary", "zoneIds", "wasteFractionIds", "notes", "validFrom", "validTo"], {
    title: "Edit service area",
    description: `Correct ${record.name}. Its code and project stay; who holds it is its assignments'.`,
    submitLabel: "Save changes",
  })
  return { ...editable, sections: editable.sections.map((section) => ({ ...section, fields: section.fields.filter((field) => field.id !== "serviceProviderId") })) }
}

/** An award the form made, minted for the session. */
export const createServiceAreaRecord = (values: BusinessFormValues, now: number): BusinessRecord =>
  mintedRecord({ id: `service-areas-service-area-${now}`, name: text(values, "areaName"), status: "Active", recordKind: SERVICE_AREA_RECORD_KIND, values: blankNone(values) })

/** An edited award, its name as the form says it. */
export const updateServiceAreaRecord = (record: BusinessRecord, values: BusinessFormValues): BusinessRecord => editedRecord(record, values, { name: text(values, "areaName") || record.name })

export const ASSIGNMENT_FORM: BusinessFormSchema = {
  key: "service-providers.service-areas",
  mode: "create",
  recordKind: ASSIGNMENT_RECORD_KIND,
  title: "Assign the service area",
  description: "Who holds the award over a period inside its own. A transfer is the current assignment ended and this one added.",
  submitLabel: "Add assignment",
  sections: [
    {
      id: "assignment",
      title: "Assignment",
      fields: [
        { id: "serviceAreaId", label: "Service area", type: "select", required: true, readOnly: true, relation: SERVICE_AREAS_MODULE },
        { id: "serviceProviderId", label: "Service provider", type: "select", required: true, relation: SERVICE_PROVIDERS_MODULE },
        { id: "notes", label: "Notes", type: "textarea" },
        { id: "validFrom", label: "Holds from", type: "date", required: true },
        lastDayIn("Holds until", "The last day it holds the area. Leave blank to end with the service area."),
      ],
    },
  ],
  execution: { kind: "create-record", completionMessage: "The area was assigned." },
}

/** An assignment's end: its notes and its last day alone. */
export const assignmentEndForm = (record: BusinessRecord): BusinessFormSchema =>
  editableOnly(ASSIGNMENT_FORM, ["notes", "validTo"], { title: "End or note the assignment", description: `${record.name}: give the last day it holds the area, or correct its notes.`, submitLabel: "Save" })

/** An assignment the form made under an award, minted for the session. */
export const createAssignmentRecord = (values: BusinessFormValues, now: number): BusinessRecord =>
  mintedRecord({ id: `service-areas-assignment-${now}`, name: "New assignment", status: "Active", recordKind: ASSIGNMENT_RECORD_KIND, values: blankNone(values) })

// ---------------------------------------------------------------------------
// Service provider prices
// ---------------------------------------------------------------------------

export const PROVIDER_PRICE_FORM: BusinessFormSchema = {
  key: "commercial.service-provider-prices",
  mode: "create",
  recordKind: PROVIDER_PRICE_RECORD_KIND,
  title: "New service provider price",
  description: "What the provider holding an award is paid per unit of a product, in the project's currency. The bid is the tender's and locked; the fee starts at it and moves by Apply index alone.",
  submitLabel: "Add price",
  sections: [
    {
      id: "price",
      title: "Price",
      fields: [
        assignment,
        { id: "productId", label: "Product", type: "select", required: true, relation: PRODUCTS_MODULE },
        { id: "bid", label: "Bid", type: "number", required: true, min: 0, description: "Per the product's unit: 11.20." },
        { id: "fee", label: "Current fee", type: "number", min: 0, description: "The bid when blank." },
        { id: "notes", label: "Notes", type: "textarea" },
        { id: "validFrom", label: "Valid from", type: "date", required: true },
        lastDayIn("Valid until", "The last day it holds. Leave blank to end with the assignment."),
      ],
    },
  ],
  execution: { kind: "create-record", completionMessage: "The price was added." },
}

/** A price's edit: its notes and its end alone. */
export const providerPriceEditForm = (record: BusinessRecord): BusinessFormSchema =>
  editableOnly(PROVIDER_PRICE_FORM, ["notes", "validTo"], { title: "Edit price", description: `${record.name}: the fee moves by Apply index and the bid never; here, the notes and the end.`, submitLabel: "Save changes" })

/** A price the form made, minted for the session. */
export const createProviderPriceRecord = (values: BusinessFormValues, now: number): BusinessRecord =>
  mintedRecord({ id: `service-provider-prices-service-provider-price-${now}`, name: "New price", status: "Active", recordKind: PROVIDER_PRICE_RECORD_KIND, values: blankNone(values) })

export const INDEX_FORM: BusinessFormSchema = {
  key: "commercial.service-provider-prices",
  mode: "action",
  recordKind: INDEXED_PRICE_RECORD_KIND,
  title: "Apply index",
  description: "The fee from a day on, by an index: the chain's next row, this one ended the day before.",
  submitLabel: "Apply index",
  sections: [
    {
      id: "index",
      title: "Index",
      fields: [
        { id: "label", label: "Index", type: "text", required: true, placeholder: "CPI" },
        { id: "percent", label: "Change (%)", type: "text", required: true, placeholder: "5", description: "Two decimals at most; negative for a deflator." },
        { id: "base", label: "Applied to", type: "select", required: true, defaultValue: "bid", options: INDEX_BASES.map((value) => ({ value, label: value === "bid" ? "The bid" : "The current fee" })) },
        { id: "appliedFrom", label: "From", type: "date", required: true },
      ],
    },
  ],
  execution: { kind: "create-record", completionMessage: "The index was applied." },
}

/** The chain's next row Apply index makes from a price: it names the row it indexes. */
export const createIndexedPriceRecord = (price: BusinessRecord, values: BusinessFormValues, now: number): BusinessRecord => ({
  ...mintedRecord({ id: `service-provider-prices-indexed-price-${now}`, name: `${price.name} (indexed)`, status: "Active", recordKind: INDEXED_PRICE_RECORD_KIND, values: { ...blankNone(values), indexesPriceId: price.id } }),
  projectIds: price.projectIds,
})

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

export const SETTLEMENT_FORM: BusinessFormSchema = {
  key: "commercial.settlements",
  mode: "create",
  recordKind: SETTLEMENT_RECORD_KIND,
  title: "Open settlement",
  description: "Settle what an assignment's provider is paid over a period: the provider's events in it, each at the provider price in force on its day. Calculate it, then close it.",
  submitLabel: "Open settlement",
  sections: [
    {
      id: "settlement",
      title: "Settlement",
      fields: [assignment, { id: "validFrom", label: "First day", type: "date", required: true }, { id: "validTo", label: "Last day", type: "date", required: true }],
    },
  ],
  validationRules: [{ type: "date-order", startField: "validFrom", endField: "validTo", message: "The last day comes on or after the first", allowSame: true }],
  execution: { kind: "create-record", completionMessage: "The settlement was opened." },
}

/** A settlement the form opened, minted for the session. */
export const createSettlementRecord = (values: BusinessFormValues, now: number): BusinessRecord =>
  mintedRecord({ id: `settlements-settlement-${now}`, name: "New settlement", status: "Open", recordKind: SETTLEMENT_RECORD_KIND, values: blankNone(values) })

export const REOPEN_FORM: BusinessFormSchema = {
  key: "commercial.settlements",
  mode: "action",
  recordKind: SETTLEMENT_RECORD_KIND,
  title: "Reopen settlement",
  description: "Open a closed settlement again, to calculate it anew. The history keeps why.",
  submitLabel: "Reopen",
  sections: [{ id: "reopen", title: "Reopen", fields: [{ id: "reason", label: "Why", type: "textarea", required: true }] }],
  execution: { kind: "append-event", completionMessage: "The settlement was reopened." },
}

// ---------------------------------------------------------------------------
// Weight review
// ---------------------------------------------------------------------------

const review = (title: string, description: string, submitLabel: string, fields: readonly BusinessFormField[]): BusinessFormSchema => ({
  key: "route-studio.weights",
  mode: "action",
  recordKind: "Weight review",
  title,
  description,
  submitLabel,
  sections: [{ id: "review", title, fields }],
  execution: { kind: "append-event", completionMessage: `${title} recorded.` },
})

export const WEIGHT_REVIEW_FORMS: Readonly<Record<WeightReviewCommand, BusinessFormSchema>> = {
  approve: review("Approve weight", "The weight is right as recorded.", "Approve", [{ id: "note", label: "Note", type: "textarea" }]),
  reject: review("Reject weight", "The weight cannot be used: say why.", "Reject", [{ id: "note", label: "Why", type: "textarea", required: true }]),
  correct: review("Correct weight", "The right weights, recorded as a new unload beside this one.", "Correct", [
    { id: "netKg", label: "Net (kg)", type: "number", required: true, min: 1 },
    { id: "grossKg", label: "Gross (kg)", type: "number", min: 1, description: "With the tare, or neither; net is gross less tare." },
    { id: "tareKg", label: "Tare (kg)", type: "number", min: 1 },
    { id: "weighbridgeTicket", label: "Weighbridge ticket", type: "text" },
    { id: "note", label: "What was wrong", type: "textarea", required: true },
  ]),
}
