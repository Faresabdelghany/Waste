// The forms a vehicle's maintenance is worked with on the Pilot (O20 of
// #290), from the vehicle's details in Fleet: a plan added — what the service
// is, its intervals by days, kilometres or engine hours, and the last service
// they count from — an order opened, of one of the active plans or a one-off
// with its own title, and an order completed with the day and the readings
// then. lib/api/records/maintenance.ts maps the values to the wire and holds
// a plan to the domain's rule in its words.
import type { MaintenancePlan } from "@waste/contracts/maintenance"
import { MAINTENANCE_INTERVAL_MAX } from "@waste/domain/resources/maintenance"

import type { BusinessFormSchema } from "./business-form-types"

/** Add plan, from a vehicle's details. */
export const PLAN_FORM: BusinessFormSchema = {
  key: "fleet.vehicles",
  mode: "action",
  recordKind: "Maintenance plan",
  title: "Add maintenance plan",
  description: "A service at intervals: by days, kilometres or engine hours, whichever comes first, counted from the last service. The plan is due soon two weeks, 1,000 km or 50 h ahead of a limit, and the office is alerted.",
  submitLabel: "Add plan",
  sections: [
    {
      id: "plan",
      title: "Plan",
      fields: [
        { id: "name", label: "Service", type: "text", required: true, placeholder: "Annual service" },
        { id: "intervalDays", label: "Every (days)", type: "number", min: 1, max: MAINTENANCE_INTERVAL_MAX.days },
        { id: "intervalKm", label: "Every (km)", type: "number", min: 1, max: MAINTENANCE_INTERVAL_MAX.km },
        { id: "intervalHours", label: "Every (engine hours)", type: "number", min: 1, max: MAINTENANCE_INTERVAL_MAX.hours },
      ],
    },
    {
      id: "last-service",
      title: "Last service",
      description: "The intervals count from it. A distance interval needs the odometer then, an hours interval the engine hours.",
      fields: [
        { id: "lastDoneOn", label: "Last done on", type: "date", required: true },
        { id: "lastDoneKm", label: "Odometer then (km)", type: "number", min: 0 },
        { id: "lastDoneHours", label: "Engine hours then", type: "number", min: 0 },
      ],
    },
  ],
  execution: { kind: "append-event", completionMessage: "The plan was added." },
}

/** Open order, from a vehicle's details: its active plans offered by name, or none for a one-off. */
export function orderFormOf(plans: readonly Pick<MaintenancePlan, "id" | "name" | "status">[]): BusinessFormSchema {
  return {
    key: "fleet.vehicles",
    mode: "action",
    recordKind: "Maintenance order",
    title: "Open maintenance order",
    description: "Work to do on the vehicle: a plan's service, which moves the plan's last service once completed, or a one-off — a repair, a defect mended.",
    submitLabel: "Open order",
    sections: [
      {
        id: "order",
        title: "Order",
        fields: [
          {
            id: "planId",
            label: "Plan",
            type: "select",
            description: "Leave blank for a one-off.",
            options: plans.filter((plan) => plan.status === "active").map((plan) => ({ value: plan.id, label: plan.name })),
          },
          { id: "title", label: "What it is for", type: "text", description: "The plan's name where blank.", requiredWhen: { fieldId: "planId", hasValue: false } },
          { id: "dueOn", label: "Planned for", type: "date" },
          { id: "note", label: "Note", type: "textarea" },
        ],
      },
    ],
    execution: { kind: "append-event", completionMessage: "The order was opened." },
  }
}

/** Complete, from an open order in a vehicle's details. */
export const COMPLETE_FORM: BusinessFormSchema = {
  key: "fleet.vehicles",
  mode: "action",
  recordKind: "Maintenance order",
  title: "Complete maintenance order",
  description: "The day the work was done and the readings then. A plan's order is its service: the plan counts from it, and a plan by kilometres or engine hours needs its reading.",
  submitLabel: "Complete order",
  sections: [
    {
      id: "completion",
      title: "Completion",
      fields: [
        { id: "completedOn", label: "Done on", type: "date", required: true },
        { id: "odometerKm", label: "Odometer (km)", type: "number", min: 0 },
        { id: "engineHours", label: "Engine hours", type: "number", min: 0 },
        { id: "note", label: "What was done", type: "textarea" },
      ],
    },
  ],
  execution: { kind: "append-event", completionMessage: "The order was completed." },
}
