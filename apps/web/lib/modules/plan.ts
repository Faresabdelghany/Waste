// Plan is Map Planning alone (2026-09-16): its list modules moved out —
// Vehicle planning to Fleet, Route Schemes to Route Studio, and Collection
// Calendars to Settings (configure.calendars).
import { workspaceSpec } from "./spec"

export const PLAN = workspaceSpec("plan", {
  label: "Map Planning",
  description: "Plan service on the map: the container and property registry as clustered markers, filtered by fraction, type, area, and collection window, selected spatially and handed to Route Scheme creation. Route Schemes own recurrence and live in Route Studio; planning geography and collection calendars are managed in Settings.",
  path: "/plan",
  modules: {
    // Map Planning (2026-09-16) replaced the Plan workspace's list modules:
    // a read-and-select surface over the container and property registry
    // with no records of its own — the module registers for navigation,
    // permissions, and links; components/waste/map-planning renders it.
    "map-planning": {
      shown: "tab",
      layout: "map-planning",
      label: "Map Planning",
      title: "Map Planning",
      description:
        "Containers and properties on the map, clustered by location and coloured by waste fraction. Filter the registry, pick a collection window, draw a rectangle or polygon, and create a route scheme from the selection.",
      entityLabel: "Container",
      contextLabel: "Location",
      valueLabel: "Selection",
      primaryAction: "Create route scheme",
      records: [],
      lifecycle: [],
      rules: [
        "Marker positions follow the container's property address; containers at one address share one spot.",
        "A selection never changes a record — it seeds a Route Scheme in Route Studio.",
        "The collection window reads generated routes first and the container's next collection second.",
      ],
    },
  },
})
