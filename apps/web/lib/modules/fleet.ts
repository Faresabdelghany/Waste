import type { BusinessRecord } from "@/lib/prototype/prototype-record"

import { workspaceSpec } from "./spec"

/**
 * Whether a fleet row is a trailer: its typed kind, which the server's rows
 * and the fixture form carry (`resourceKind`), else the fixture id's
 * `trailer-` prefix. The Vehicle pickers offer the rest, the Trailer pickers
 * these alone (#179): the vehicles' `offers`, the reservations' pickers and a
 * vehicle's compartments all read it.
 */
export function isTrailerRecord(record: BusinessRecord): boolean {
  const kind = record.submittedValues?.resourceKind
  return typeof kind === "string" && kind !== "" ? kind === "trailer" : record.id.startsWith("trailer-")
}

export const FLEET = workspaceSpec("fleet", {
  label: "Fleet",
  description: "Manage vehicles, drivers, availability, compatibility, and planned allocation.",
  path: "/fleet",
  modules: {
    vehicles: {
      shown: "tab",
      providerOperated: true,
      picked: {
        // A trailer is a vehicle of the fleet: a trailer field offers the trailers alone, a vehicle field the rest.
        offers: (fieldId, record) => (fieldId === "trailerId" ? isTrailerRecord(record) : fieldId === "vehicleId" ? !isTrailerRecord(record) : true),
        // A vehicle's name carries its registration plate; its facts show the callsign.
        named: (record) => record.name.split(" · ")[0],
      },
      providerPage: "fleet",
      // The rich view for its edit and delete paths: a service provider manager keeps its own fleet.
      view: { seededFactColumns: ["Ownership", "Capacity", "Fractions", "Fuel"] },
      label: "Vehicles",
      title: "Vehicles and Fleet",
      description: "Capacity, compatibility, ownership, live status, assignment, utilization, and history.",
      entityLabel: "Vehicle",
      contextLabel: "Type · depot",
      valueLabel: "Current state",
      primaryAction: "Register vehicle",
      lifecycle: ["Active", "Unavailable", "Maintenance", "Retired"],
      rules: [
        "Compatibility includes fraction, capacity, compartment, dimensions, and route constraints.",
        "Service provider ownership controls visibility and structural editing.",
        "Current location exposes freshness and permitted access purpose.",
      ],
    },
    drivers: {
      shown: "tab",
      providerOperated: true,
      providerPage: "fleet",
      // The rich view for its edit and delete paths: a service provider manager keeps its own fleet.
      view: { seededFactColumns: ["Licence", "AppAccess", "Employer"] },
      label: "Drivers",
      title: "Drivers and Workforce Capacity",
      description: "Skills, licences, app access, availability, absence, actual assignment, and field performance.",
      entityLabel: "Driver",
      contextLabel: "Employer · skills",
      valueLabel: "Availability",
      primaryAction: "Add driver",
      lifecycle: ["Invited", "Active", "Absent", "Suspended", "Inactive"],
      rules: [
        "Driver access is limited to assigned work and necessary customer information.",
        "Skills and licences participate in route compatibility checks.",
        "Location tracking follows configured lawful purpose, notice, and retention.",
      ],
    },
    "vehicle-planning": {
      shown: "tab",
      layout: "allocations",
      label: "Vehicle Planning",
      title: "Vehicle and Workforce Planning",
      description: "Time-based allocation, capacity, compatibility, availability, and absence planning.",
      entityLabel: "Allocation",
      contextLabel: "Vehicle · driver",
      valueLabel: "Capacity",
      primaryAction: "Plan allocation",
      lifecycle: ["Draft", "Allocated", "Confirmed", "Released"],
      rules: [
        "Compatibility checks include fraction, capacity, compartment, skills, and availability.",
        "Planned allocation does not overwrite actual execution assignment.",
        "Service provider-owned resources expose ownership and permitted visibility.",
      ],
    },
  },
})
