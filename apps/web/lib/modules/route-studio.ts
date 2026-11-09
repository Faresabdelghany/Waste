import { workspaceSpec } from "./spec"

export const ROUTE_STUDIO = workspaceSpec("route-studio", {
  label: "Route Studio",
  description:
    "Monitor live service, design recurring routes, manage route days and their generated Pickups, and control route weights.",
  path: "/route-studio",
  alsoAt: ["/routes"],
  modules: {
    live: {
      shown: "tab",
      label: "Live Operations",
      title: "Live Operations",
      description:
        "Monitor active routes, vehicle freshness, current stops, exceptions, and dispatcher actions alongside Route Studio master data.",
      entityLabel: "Active route",
      contextLabel: "Actual assignment",
      valueLabel: "Progress",
      primaryAction: "Dispatch action",
      lifecycle: ["Planned", "Ready", "Active", "Paused", "Completed", "Cancelled"],
      rules: [
        "Stale vehicle positions never appear as live.",
        "Planned and actual assignments remain distinct.",
        "Reassignment shows compatibility, service impact, and an audit outcome.",
      ],
    },
    schemes: {
      shown: "tab",
      layout: "schemes",
      details: "scheme-page",
      writes: "scheme",
      deletes:
        "Deleting a route scheme stops Plan Ahead and future generation and cancels its future planned routes (kept as records). Executed, active and completed routes and their stops are preserved as operational history.",
      // The five artboard-1 columns (issue #30, D15): Recurrence and Holiday
      // list render as derived cells, so no fact columns are seeded; a person
      // can still add others through the view options.
      view: {
        seededFactColumns: [],
        // Offering the stored display facts beside the derived columns would put
        // a stale duplicate next to the derived truth.
        excludedColumnFacts: new Set(["Recurrence", "Holiday list", "Collection calendar", "Planning area"]),
      },
      label: "Route Schemes",
      title: "Route Schemes",
      description: "Effective-dated recurring templates for generating executable routes.",
      entityLabel: "Route scheme",
      // Rendered as the derived "project · area · service days" context (issue
      // #30, D15; #254) — see lib/prototype/route-schemes/scheme-list.
      contextLabel: "Project · area · service days",
      valueLabel: "Demand",
      primaryAction: "New route scheme",
      lifecycle: ["Draft", "Validated", "Scheduled", "Effective", "Expired"],
      rules: [
        "Scheme changes have an effective date and retain version history.",
        "Executed routes are unchanged when a scheme is edited.",
        "Service provider changes to protected master data become proposals.",
      ],
    },
    routes: {
      shown: "tab",
      layout: "routes",
      details: "route-page",
      writes: "route",
      providerOperated: true,
      providerPage: "routes",
      view: {
        seededFactColumns: ["Vehicle", "Driver", "Distance", "Duration"],
        // Project and Area are dedicated table columns.
        excludedColumnFacts: new Set(["Project", "Area"]),
        groupBy: ["Project", "Area"],
      },
      label: "Routes",
      title: "Routes",
      description: "Prepare, assign, sequence, execute, review, and close the daily workload.",
      entityLabel: "Route",
      contextLabel: "Project · area",
      valueLabel: "Stops",
      primaryAction: "Create route",
      lifecycle: ["Draft", "Planned", "Ready", "Active", "Completed", "Cancelled"],
      rules: [
        "Route generation preserves the effective route-scheme version.",
        "Stop status changes retain actor, time, source, and evidence.",
        "Reopening completed work requires permission and a recorded reason.",
      ],
    },
    pickups: {
      shown: "tab",
      providerPage: "routes",
      view: { seededFactColumns: ["Address", "Container ID", "Container Type", "Waste fraction", "Weight"], columnsShown: "display" },
      label: "Pickups",
      title: "Pickups",
      description: "Every stop generated for a dated Route, from planned service through outcome and proof.",
      entityLabel: "Pickup",
      contextLabel: "Route · stop",
      valueLabel: "Service",
      primaryAction: "Export pickups",
      lifecycle: ["Planned", "Next", "Attention", "Completed", "Skipped", "Failed", "Rescheduled"],
      rules: [
        "Route generation creates one Pickup for every generated stop.",
        "Execution updates the Pickup status and appends actor, time, source, and available proof.",
        "Corrections preserve the original outcome and evidence instead of creating a duplicate Pickup.",
      ],
    },
    weights: {
      shown: "tab",
      view: { seededFactColumns: ["Gross", "Tare", "Difference"] },
      label: "Weight Control",
      title: "Weight Control",
      description: "Reconcile route load, weighbridge records, disposal evidence, and collection approval.",
      entityLabel: "Weight record",
      contextLabel: "Route · station",
      valueLabel: "Net weight",
      primaryAction: "Add weight",
      lifecycle: ["Captured", "Needs review", "Approved", "Rejected", "Corrected"],
      rules: [
        "Manual corrections create a new adjustment; they do not overwrite the original.",
        "Approval connects weight evidence to collection and billable-event readiness.",
        "Discrepancy thresholds remain explainable and project-configured.",
      ],
    },
    // A weighbridge's tickets (O27 of #290): read from the API alone, so it holds no fixture records.
    weighbridge: {
      shown: "more",
      label: "Weighbridge",
      title: "Weighbridge Tickets",
      description: "Tickets a station's weighbridge sent, matched to the routes their vehicles ran and written as their unloads, or waiting for the office.",
      entityLabel: "Weighbridge ticket",
      contextLabel: "Station · route",
      valueLabel: "Net weight",
      primaryAction: "Match ticket",
      lifecycle: ["Unmatched", "Matched", "Dismissed"],
      rules: [
        "A ticket is the weighbridge's: the office matches it to a route or dismisses it, and never edits it.",
        "A matched ticket is its route's unload, reviewed in Weight Control like any other.",
        "Where the driver recorded the same load, both unloads read as possible duplicates until one is rejected.",
      ],
    },
  },
})
