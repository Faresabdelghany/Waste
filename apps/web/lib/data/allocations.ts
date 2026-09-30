// The vehicle allocation's forms on the Pilot (Issue #181, slice 5b of #81):
// what Fleet › Vehicle Planning offers once it reads the API — allocate, the
// change a planner makes with its reason, and the release's reason — for the
// command surfaces (components/waste/commands/allocation-surfaces.tsx) to
// render. Fixture mode keeps the registry's "Allocate fleet resources" action
// form untouched.
//
// Every field id is a key the adapter reads (lib/api/records/allocations.ts);
// lib/data/__tests__/allocation-forms.test.ts holds the two together through
// the adapter itself. The window is a wall-clock time on the project's clock,
// the shape the scheme-save conflict check reads. A status is never a field of
// a change: confirm and release are the row's commands.
import { FIXTURE_COMPANY_ID, type BusinessRecord, type ModuleLocation } from "./business-modules"
import type { BusinessFormField, BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import { MASTER_DATA_MODULE } from "./master-data"

const ORGANISATION: ModuleLocation = { workspaceId: "configure", moduleId: "organization" }
const VEHICLES: ModuleLocation = { workspaceId: "fleet", moduleId: "vehicles" }
const DRIVERS: ModuleLocation = { workspaceId: "fleet", moduleId: "drivers" }
const DEPOTS: ModuleLocation = { workspaceId: "resources", moduleId: "depots" }

const RESERVATION_FIELDS: readonly BusinessFormField[] = [
  { id: "projectId", label: "Project", type: "select", required: true, relation: ORGANISATION },
  { id: "vehicleId", label: "Vehicle", type: "select", required: true, relation: VEHICLES },
  { id: "driverId", label: "Driver", type: "select", relation: DRIVERS },
  { id: "trailerId", label: "Trailer", type: "select", relation: VEHICLES },
  { id: "depotId", label: "Depot", type: "select", relation: DEPOTS },
  { id: "plannedFraction", label: "Waste fraction", type: "select", relation: MASTER_DATA_MODULE },
  { id: "requiredCapacity", label: "Required capacity", type: "number", min: 1, unit: "kg" },
  { id: "plannedStart", label: "Planned start", type: "datetime", required: true, description: "On the project's clock." },
  { id: "plannedEnd", label: "Planned end", type: "datetime", required: true },
]
const NOTE: BusinessFormField = { id: "note", label: "Note", type: "textarea", description: "What it is for: an allocation names no route." }

/** Allocate: the reservation, planned or confirmed straight away. */
export const ALLOCATE_FORM: BusinessFormSchema = {
  key: "fleet.vehicle-planning",
  mode: "create",
  recordKind: "Vehicle allocation",
  title: "Allocate a vehicle",
  description: "Reserve a vehicle, and where it applies a driver, over a window. The API refuses a vehicle or a driver already reserved then.",
  submitLabel: "Allocate",
  nameField: "vehicleId",
  sections: [
    {
      id: "reservation",
      title: "Reservation",
      fields: [
        ...RESERVATION_FIELDS,
        {
          id: "allocationStatus",
          label: "Status",
          type: "select",
          defaultValue: "planned",
          options: [
            { value: "planned", label: "Planned" },
            { value: "confirmed", label: "Confirmed" },
          ],
          description: "A confirmed allocation blocks another planner's check; a planned one warns.",
        },
        NOTE,
      ],
    },
  ],
  execution: { kind: "create-record", completionMessage: "The vehicle was allocated." },
}

/** Change: what the allocation reserves, its project held, and the reason, which is the event's. */
export function allocationChangeForm(record: BusinessRecord): BusinessFormSchema {
  return {
    ...ALLOCATE_FORM,
    mode: "action",
    title: "Change allocation",
    description: `Change what ${record.name} reserves. The reason goes on its history.`,
    submitLabel: "Change",
    sections: [
      {
        id: "reservation",
        title: "Reservation",
        fields: [
          ...RESERVATION_FIELDS.map((field) => (field.id === "projectId" ? { ...field, readOnly: true } : field)),
          NOTE,
          { id: "changeReason", label: "Reason", type: "textarea", required: true },
        ],
      },
    ],
  }
}

/** Release: the reason the window is freed. */
export const RELEASE_FORM: BusinessFormSchema = {
  key: "fleet.vehicle-planning",
  mode: "action",
  recordKind: "Vehicle allocation",
  title: "Release allocation",
  description: "Free the window: the vehicle and the driver may be allocated over it again. A released allocation does not change.",
  submitLabel: "Release",
  sections: [{ id: "release", title: "Release", fields: [{ id: "reason", label: "Reason", type: "textarea", required: true }] }],
  execution: { kind: "append-event", completionMessage: "The allocation was released." },
}

/** The values the change form opens with: the record's typed values for its fields, the reason blank. */
export function allocationFormValues(record: BusinessRecord): BusinessFormValues {
  const fieldIds = new Set(allocationChangeForm(record).sections.flatMap((section) => section.fields.map((field) => field.id)))
  return { ...Object.fromEntries(Object.entries(record.submittedValues ?? {}).filter(([key, value]) => fieldIds.has(key) && typeof value === "string")), changeReason: "" }
}

/** An allocation the allocate form made: the generic create path's id and kind, so the adapter owns it until the API's answer replaces it. */
export function createAllocationRecord(values: BusinessFormValues, { now }: { now: number }): BusinessRecord {
  const projectId = typeof values.projectId === "string" ? values.projectId : ""
  return {
    id: `vehicle-planning-vehicle-allocation-${now}`,
    name: "New allocation",
    context: "",
    status: values.allocationStatus === "confirmed" ? "Confirmed" : "Planned",
    owner: "",
    value: "",
    updated: "Now",
    description: "",
    facts: {},
    related: [],
    source: "Waste API",
    freshness: "Now",
    companyId: FIXTURE_COMPANY_ID,
    projectIds: projectId === "" ? [] : [projectId],
    recordKind: "Vehicle allocation",
    submittedValues: values,
  }
}

/** A changed allocation: its identity and status kept, the form's values over its typed ones. */
export function changedAllocationRecord(record: BusinessRecord, values: BusinessFormValues): BusinessRecord {
  return { ...record, submittedValues: { ...record.submittedValues, ...values } }
}
