// Operate: the office's tickets and alerts, and the desks of the sites; the
// Driver App is a surface of its own. Its page is /tickets since the live
// service, the routes, their stops and their weights moved to Route Studio.
import { record } from "./fixture-records"
import { workspaceSpec } from "./spec"

export const OPERATE = workspaceSpec("operate", {
  label: "Tickets",
  description:
    "Manage customer and operational tickets, then triage the exceptions and alerts that require resolution work.",
  path: "/tickets",
  alsoAt: ["/operate"],
  modules: {
    tickets: {
      shown: "tab",
      details: "ticket-dialog",
      filters: "tickets",
      // A provider's manager raises a ticket on its own work for the office to
      // resolve, so the office's fields go: Project and Source are known from the
      // account; the response SLAs, a parent ticket and the customer/internal
      // split are the office's to manage; Category comes from the Ticket type;
      // and evidence is uploaded rather than referenced.
      providerForm: {
        description:
          "Raise a scoped case on your own work for the office to resolve. Assignment and resolution history remain separate parts of the Ticket.",
        hides: ["projectId", "responseDueAt", "occurredAt", "parentTicketId", "internalComment", "customerMessage", "source", "category"],
        uploads: "attachmentReferences",
      },
      providerPage: "tickets",
      // The rich record table for every persona — the operator's queue list
      // was retired so /tickets matches the service provider workspace. Tickets
      // are worked through lifecycle transitions and the ticket details view,
      // so no generic row Edit/Delete. A column shows only where a row carries
      // its fact, so the fixtures' Type and Team and the API's number, route,
      // container, kind, assignee, source and time (#147) are seeded side by
      // side, each mode showing its own. The API's label is its Number, since
      // the title column is already headed Ticket, and its route and container
      // are columns of their own beside the Customer · property the context
      // holds (#253).
      view: {
        seededFactColumns: ["Number", "Route", "Container", "Type", "Kind", "Priority", "Team", "Assignee", "Opened via", "Occurred"],
        // Form fields that duplicate the title/description cell or hold long free text.
        excludedColumnFacts: new Set([
          "Subject",
          "Case description",
          "Attachments",
          "Attachment references",
          "All linked records and content visibility were checked",
        ]),
        rowActions: false,
      },
      label: "Tickets",
      title: "Tickets and Case Management",
      description: "Customer requests, complaints, deviations, internal work, communication, and resolution history.",
      entityLabel: "Ticket",
      contextLabel: "Customer · property",
      valueLabel: "Response target",
      primaryAction: "New ticket",
      lifecycle: ["Created", "Open", "Pending", "On hold", "In progress", "Completed", "Rejected"],
      rules: [
        "Status changes follow the configured ticket lifecycle.",
        "Customer-visible messages and internal comments remain separate.",
        "Ticket actions validate access to every linked customer and project record.",
      ],
    },
    "bulky-bookings": {
      shown: "more",
      // Bulky Bookings (O11 of #290): on the API only, so no fixture records; the module's surfaces are O11b's.
      label: "Bulky Bookings",
      title: "Bulky Bookings",
      description: "A customer's bulky items booked onto a collection day of their planning area, a slot of the day's capacity each, routed by the office as a stop and charged once collected.",
      entityLabel: "Bulky booking",
      contextLabel: "Customer · place",
      valueLabel: "Day",
      primaryAction: "Book bulky collection",
      lifecycle: ["Booked", "Routed", "Collected", "Cancelled"],
      rules: [
        "A booking takes one slot of its day; a full day is not offered.",
        "The office routes a booking onto a route running on its day, as a stop at the booking's address.",
        "A collected booking is charged at its schedule's product to the agreement it names.",
      ],
    },
    exceptions: {
      shown: "tab",
      view: "queue",
      label: "Exceptions & Alerts",
      title: "Exceptions and Alerts",
      description: "Attention conditions, operational deviations, acknowledgements, and linked resolution work.",
      entityLabel: "Exception",
      contextLabel: "Related service",
      valueLabel: "SLA",
      primaryAction: "Create alert",
      lifecycle: ["New", "Acknowledged", "Linked to ticket", "Resolved"],
      rules: [
        "An alert is an attention condition; a ticket owns resolution.",
        "Rule-based and intelligence-generated alerts expose their source.",
        "Acknowledgement does not silently resolve the underlying condition.",
      ],
    },
    // Retained as a data contract for route evidence and existing schemas, but
    // omitted from office navigation and public routing: the Driver App is /driver.
    "driver-app": {
      shown: "app",
      label: "Driver App",
      title: "Driver and Navigation App",
      description: "A narrow, role-gated field experience for assigned routes, navigation, stop outcomes, proof, messages, and reliable offline synchronization.",
      entityLabel: "Driver session",
      contextLabel: "Assigned route · vehicle",
      valueLabel: "Sync and evidence",
      primaryAction: "Open driver session",
      deepLink: "/driver",
      lifecycle: ["Assigned", "Downloaded", "Active", "On break", "Awaiting sync", "Completed"],
      rules: [
        "Drivers see only assigned routes and the minimum customer and access information needed to perform the work.",
        "Offline and stale state are explicit, every action gives immediate feedback, and synchronization prevents duplicate completion.",
        "Location transmission requires a visible lawful purpose; billing and unrelated routes remain hidden.",
      ],
      records: [
        record(
          "driver-session-1042",
          "Mads Jensen · RC-1042",
          "Central Residual · WH-24",
          "Active",
          "Mads Jensen",
          "Live · proof complete",
          "2 min ago",
          "Authenticated driver session navigating to stop 35 with all completed-stop evidence synchronized.",
          {
            "Next stop": "Borgergade 41 · stop 35 of 42",
            "Device state": "Online · battery 68%",
            "Queued actions": "0",
            "Location purpose": "Live dispatch + proof · visible",
            "Customer data": "Access instructions only",
          },
          ["Actual assignment RC-1042", "Vehicle WH-24", "34 completed stops", "2 operational messages"],
          "Driver app + vehicle GPS",
          "2 minutes",
          ["On break", "Report problem", "Complete route"],
        ),
        record(
          "driver-session-1039",
          "Sofie Eriksen · RC-1039",
          "Vesterbro Paper · WH-07",
          "Awaiting sync",
          "Sofie Eriksen",
          "2 actions queued",
          "18 min ago",
          "The device completed one stop and captured a photo while offline; both actions are safely queued once.",
          {
            "Next stop": "Enghavevej 4 · stop 31 of 32",
            "Device state": "Offline since 12:41",
            "Queued actions": "1 completion · 1 photo",
            "Location purpose": "Last lawful position shown as stale",
            "Customer data": "Access instructions only",
          },
          ["Actual assignment RC-1039", "Pickup RC-1039 · Stop 30", "Vehicle WH-07", "Evidence bundle pending"],
          "Driver app · offline cache",
          "18 minutes · stale",
          ["Retry sync", "Continue offline"],
        ),
        record(
          "driver-session-1048",
          "Jonas Holm · RC-1048",
          "Østerbro Organic · WH-18",
          "On break",
          "Jonas Holm",
          "Live · issue reported",
          "5 min ago",
          "Driver recorded a blocked-access problem with photo proof and is on an authorized break.",
          {
            "Next stop": "Viborggade 7 · stop 23 of 33",
            "Device state": "Online · battery 54%",
            "Queued actions": "0",
            "Location purpose": "Paused during authorized break",
            "Customer data": "Gate instructions only",
          },
          ["Actual assignment RC-1048", "Ticket T-8831", "Exception EX-2221", "1 customer-visible photo"],
          "Driver app",
          "5 minutes",
          ["Active", "End route"],
        ),
      ],
    },
    "site-visits": {
      shown: "more",
      // Recycling-centre visits (M4 of #293): on the API only, so no fixture records; the ledger with its Likely trades and Void, and the attendant's phone-first /check-in (components/waste/commands/site-visit-surfaces.tsx, components/waste/check-in/).
      label: "Site visits",
      title: "Recycling-centre visits",
      description: "Every arrival at a recycling centre: who it was for, the fractions brought, admitted or turned away, and what the project's Visit Rule charges for it.",
      entityLabel: "Site visit",
      contextLabel: "Site · identifier",
      valueLabel: "Charge",
      primaryAction: "Check in a visitor",
      lifecycle: ["Admitted", "Refused", "Voided"],
      rules: [
        "A refused visit is still recorded: the ledger says who was turned away.",
        "A mistake is voided, never deleted: the ledger is the evidence for its charge.",
      ],
    },
    "scale-house": {
      shown: "more",
      // The scale house (M16a of #293): on the API only, so no fixture records; weighed in, out and voided, and its tares registered, through components/waste/commands/scale-house-surfaces.tsx.
      label: "Scale house",
      title: "Scale house",
      description: "The window of our own sites with a weighbridge: each vehicle weighed in at its gross and out at its tare, its load split by fraction and the municipality it came from, and the register of tares it may be weighed out on.",
      entityLabel: "Scale ticket",
      contextLabel: "Site · customer",
      valueLabel: "Net weight",
      primaryAction: "Weigh in",
      lifecycle: ["Weighed in", "Completed", "Voided"],
      rules: [
        "A ticket's lines sum to its net: the split is how much of what came from where.",
        "One of our own vehicles' ticket is its route's unload, reviewed in Weight Control like any other.",
        "A ticket is voided with its reason, never deleted: it is what the customer was handed.",
      ],
    },
    inspections: {
      shown: "more",
      // Field inspections (M23 of #293): on the API only, so no fixture records; recorded through the module's form, its photos and Close in its details (components/waste/commands/inspection-surfaces.tsx).
      label: "Inspections",
      title: "Field inspections",
      description: "An inspector's visits to containers and properties: what each came to, what was found, and the photos taken there.",
      entityLabel: "Field inspection",
      contextLabel: "Verdict",
      valueLabel: "Findings",
      primaryAction: "Record an inspection",
      lifecycle: ["Open", "Closed"],
      rules: [
        "An inspection is of a container or of a property, never both.",
        "A compliant visit names no findings; a minor or a major one names what was found.",
        "A closed inspection changes no more.",
      ],
    },
  },
})
