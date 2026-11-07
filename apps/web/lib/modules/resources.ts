import { workspaceSpec } from "./spec"

export const RESOURCES = workspaceSpec("resources", {
  label: "Assets & Inventory",
  description: "Manage the office asset registry, container groups, stock, and warehouse movements.",
  path: "/resources",
  modules: {
    containers: {
      shown: "tab",
      label: "Containers",
      title: "Containers",
      description: "Office-facing registry for physical containers, their service configuration, sensor pairing, agreements, and lifecycle history.",
      entityLabel: "Container",
      contextLabel: "Location",
      valueLabel: "Fill level",
      primaryAction: "Add container",
      lifecycle: ["Available", "On hold", "Future", "Ended", "Defect", "In storage", "In transit"],
      rules: [
        "Available, Future, Ended, and On hold are synchronized from the linked agreement and are display-only.",
        "In storage requires a storage depot; a decommissioned Ended container is terminal.",
        "Container identity, ordered waste fractions, location, routing inputs, sensor pairing, and audit history remain distinct.",
      ],
    },
    inventory: {
      shown: "tab",
      label: "Inventory",
      title: "Inventory and Stock Control",
      description: "Calculated physical, available, reserved, and in-transit balances from an append-only ledger.",
      entityLabel: "Stock item",
      contextLabel: "Warehouse · item",
      valueLabel: "Available",
      primaryAction: "New movement",
      lifecycle: ["OK", "Low", "Out of stock", "Not monitored"],
      rules: [
        "Balances are calculated from append-only movements and never edited directly.",
        "Transfers have origin, destination, and an explicit in-transit state.",
        "Low-stock alerts deduplicate until the condition is resolved.",
      ],
    },
    warehouses: {
      shown: "tab",
      label: "Warehouses",
      title: "Warehouses and Movement Ledger",
      description: "Balances, individual units, reservations, transfers, thresholds, and append-only stock movements.",
      entityLabel: "Warehouse",
      contextLabel: "Project · address",
      valueLabel: "Stock position",
      primaryAction: "New warehouse",
      lifecycle: ["Draft", "Active", "Restricted", "Closed"],
      rules: [
        "A warehouse controls stock; a depot controls route resources.",
        "Corrections are adjustment movements referencing the original.",
        "Individual units and fungible stock remain distinguishable.",
      ],
    },
    depots: {
      shown: "tab",
      label: "Depots & Unloading",
      title: "Depots and Unloading Stations",
      description: "Route bases, operating windows, vehicle facilities, disposal destinations, and compatibility.",
      entityLabel: "Location",
      contextLabel: "Type · project",
      valueLabel: "Operating status",
      primaryAction: "New location",
      lifecycle: ["Draft", "Active", "Seasonal", "Closed"],
      rules: [
        "Depots and warehouses are distinct even when colocated.",
        "Unloading compatibility includes accepted fraction, hours, capacity, and commercial rules.",
        "Historic route destinations remain unchanged when a location is edited.",
      ],
    },
    "drop-off-points": {
      shown: "more",
      // The Drop-off Points (#293 M3c): the office keeps their hours and
      // exceptions current, so they join the rich view for its row Edit; a point
      // is closed, never deleted, which the API holds.
      view: { seededFactColumns: ["Kind", "Opening", "Takes"], excludedColumnFacts: new Set(["Project"]) },
      // The Drop-off Points (Issue #293, M3): on the API only, so no fixture records; the office's pane and the public map are M3b's.
      label: "Drop-off Points",
      title: "Drop-off Points",
      description: "The recycling centres and bring banks residents bring waste to themselves: the fractions each takes, its weekly hours and exceptions, on the project's public map.",
      entityLabel: "Drop-off point",
      contextLabel: "Kind · project",
      valueLabel: "Opening",
      primaryAction: "New drop-off point",
      lifecycle: ["Draft", "Active", "Closed"],
      rules: [
        "Only an active point of a published project reaches the public map.",
        "A point is closed, never deleted.",
      ],
    },
    sensors: {
      shown: "more",
      // The fill-level Sensors (O26 of #290, row 9.10): on the API only, so no fixture records (lib/api/records/sensors.ts); a sensor's pairing and readings are its details' (components/waste/commands/sensor-surfaces.tsx). The containers' fixture facts (Sensor, Fill level) are the prototype's.
      label: "Sensors",
      title: "Fill-level Sensors",
      description: "The fill-level sensors on the company's containers: the container each measures over a period at its full threshold, and the readings a vendor's integration sends.",
      entityLabel: "Sensor",
      contextLabel: "Network · project",
      valueLabel: "Fill level",
      primaryAction: "New sensor",
      lifecycle: ["Active", "Retired"],
      rules: [
        "A sensor measures one container at a time, and a container is measured by one sensor at a time.",
        "A container read at or past its pairing's threshold raises an alert.",
        "A sensor is retired, never deleted.",
      ],
    },
  },
})
