import { RESOLUTION_RULE } from "@waste/domain/finance/pricing"
import type { BusinessRecord } from "@/lib/prototype/prototype-record"

// The registry of workspaces and modules, and the fixture records of the
// modules still on the browser's path. A switched module (SERVER_MODULES,
// lib/api/records/modules.ts) has no fixtures: its rows are the API's alone.
//
// The prototype record model lives in @waste/domain (src/prototype-record.ts)
// so the domain package needs nothing from this registry. Re-exported here so
// the web imports of the name did not have to change.
export type { BusinessRecord }

export type WorkspaceId =
  | "operate"
  | "plan"
  | "route-studio"
  | "fleet"
  | "customers"
  | "resources"
  | "service-providers"
  | "commercial"
  | "improve"
  | "configure"
  | "control-center"

export const FIXTURE_PROJECT_IDS = {
  copenhagen: "project-copenhagen",
  harbor: "project-harbor",
  cairo: "project-cairo",
} as const

export const FIXTURE_SERVICE_PROVIDER_IDS = {
  nordren: "service-provider-nordren",
  cityhaul: "service-provider-cityhaul",
} as const

type FixtureProjectId =
  (typeof FIXTURE_PROJECT_IDS)[keyof typeof FIXTURE_PROJECT_IDS]

const copenhagenFixtureRecordIds = [
  "driver-session-1042",
  "driver-session-1039",
  "driver-session-1048",
  "portal-activity-parkvej",
  "portal-request-8826",
  "insight-441",
  "dashboard-ops",
  "dashboard-service-provider",
  "flow-14",
  "flow-09",
  "suggestion-881",
  "import-771",
  "export-8801",
  "import-779",
  "scorecard-central",
  "finance-defaults",
  "billing-schedule-cph-monthly",
  "routing-organic",
  "integration-gps",
  "integration-digitalpost",
  "portal-copenhagen",
  "subscription-route-studio",
] as const

const harborFixtureRecordIds = [
  "portal-request-container",
  "portal-harbor",
  "offer-2044",
  "subscription-harbor",
  "marketplace-order-2908",
] as const

const companyWideFixtureRecordIds = [
  "report-ads-july",
  "metric-route-cost",
  "compliance-gps",
  "report-mgmt-july",
  "metric-proof",
  "integration-navision",
  "sales-lead-greenloop",
] as const

/** The projects each fixture record is filed under, by id. */
const fixtureProjectsById: Readonly<Record<string, readonly FixtureProjectId[]>> = Object.freeze(
  Object.fromEntries([
    ...copenhagenFixtureRecordIds.map((id) => [id, [FIXTURE_PROJECT_IDS.copenhagen]] as const),
    ...harborFixtureRecordIds.map((id) => [id, [FIXTURE_PROJECT_IDS.harbor]] as const),
    ...companyWideFixtureRecordIds.map((id) => [id, [FIXTURE_PROJECT_IDS.copenhagen, FIXTURE_PROJECT_IDS.harbor]] as const),
  ]),
)

export type ModuleDefinition = {
  id: string
  label: string
  title: string
  description: string
  entityLabel: string
  contextLabel: string
  valueLabel: string
  primaryAction: string
  deepLink?: string
  /** The fixture records of a module still on the browser's path; a switched module has none. */
  records?: BusinessRecord[]
  lifecycle: string[]
  rules: string[]
}

export type WorkspaceDefinition = {
  id: WorkspaceId
  label: string
  description: string
  modules: ModuleDefinition[]
}

/** Where a module lives: the `${workspaceId}.${moduleId}` pair every store, link, and relation uses. */
export type ModuleLocation = {
  workspaceId: WorkspaceId
  moduleId: string
}

function record(
  id: string,
  name: string,
  context: string,
  status: string,
  owner: string,
  value: string,
  updated: string,
  description: string,
  facts: Record<string, string>,
  related: string[],
  source = "Kystbyen",
  freshness = "Live",
  allowedTransitions?: string[],
): BusinessRecord {
  const projectIds = fixtureProjectsById[id]
  if (!projectIds) {
    throw new Error(`Missing explicit fixture scope for ${id}`)
  }
  return {
    id,
    name,
    context,
    status,
    owner,
    value,
    updated,
    description,
    facts,
    related,
    source,
    freshness,
    allowedTransitions,
    projectIds: [...projectIds],
  }
}

const operate: WorkspaceDefinition = {
  id: "operate",
  label: "Operate",
  description: "Run today’s service, recover exceptions, and preserve trustworthy execution evidence.",
  modules: [
    {
      id: "live",
      label: "Live Operations",
      title: "Live Operations",
      description: "Active routes, vehicle freshness, current stops, exceptions, and dispatcher actions.",
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
    {
      id: "routes",
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
    {
      id: "exceptions",
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
    {
      id: "tickets",
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
    {
      // Bulky Bookings (O11 of #290): on the API only, so no fixture records; the module's surfaces are O11b's.
      id: "bulky-bookings",
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
    {
      id: "pickups",
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
    {
      id: "weights",
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
    {
      id: "driver-app",
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
    {
      // Recycling-centre visits (M4 of #293): on the API only, so no fixture records; the ledger with its Likely trades and Void, and the attendant's phone-first /check-in (components/waste/commands/site-visit-surfaces.tsx, components/waste/check-in/).
      id: "site-visits",
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
    {
      // The scale house (M16a of #293): on the API only, so no fixture records; weighed in, out and voided, and its tares registered, through components/waste/commands/scale-house-surfaces.tsx.
      id: "scale-house",
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
    {
      // Field inspections (M23 of #293): on the API only, so no fixture records; recorded through the module's form, its photos and Close in its details (components/waste/commands/inspection-surfaces.tsx).
      id: "inspections",
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
  ],
}

const plan: WorkspaceDefinition = {
  id: "plan",
  label: "Map Planning",
  description: "Plan service on the map: the container and property registry as clustered markers, filtered by fraction, type, area, and collection window, selected spatially and handed to Route Scheme creation. Route Schemes own recurrence and live in Route Studio; planning geography and collection calendars are managed in Settings.",
  modules: [
    // Map Planning (2026-09-16) replaced the Plan workspace's list modules:
    // a read-and-select surface over the container and property registry
    // with no records of its own — the module registers for navigation,
    // permissions, and links; components/waste/map-planning renders it.
    {
      id: "map-planning",
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
    {
      id: "schemes",
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
    {
      id: "calendars",
      label: "Collection Calendars",
      title: "Collection Calendars",
      description: "Validity periods, maintained per project and year; a project's holidays are the days of the company's holiday list it names.",
      entityLabel: "Calendar",
      // Calendars are project-scoped (D22) — there is no customer or service
      // scoping in the model, so the list never claims one.
      contextLabel: "Project",
      valueLabel: "Validity",
      primaryAction: "New calendar",
      lifecycle: ["Draft", "Active", "Superseded", "Archived"],
      rules: [
        "The project's holiday list and the validity period decide whether a planned date is valid; the working week is a project attribute.",
        "Each scheme's holiday policy decides whether a collection on a holiday shifts to a working day, skips, or goes ahead.",
        "Time zone is display information; generation is day-granular.",
      ],
    },
    {
      id: "vehicle-planning",
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
  ],
}

const customers: WorkspaceDefinition = {
  id: "customers",
  label: "Customers",
  description: "See the complete service picture across customers, properties, payers, agreements, assets, and communication.",
  modules: [
    {
      id: "properties",
      label: "Properties",
      title: "Customer and Property CRM",
      description: "Properties, service addresses, responsible parties, payer relationships, and contextual service history.",
      entityLabel: "Property",
      contextLabel: "Customer · payer",
      valueLabel: "Services",
      primaryAction: "New property",
      lifecycle: ["Prospect", "Active", "On hold", "Inactive", "Archived"],
      rules: [
        "Customer, property, payer, owner, tenant, and administrator can be different parties.",
        "Internal notes never appear in the customer portal.",
        "The customer workspace links specialized records without duplicating their truth.",
      ],
    },
    {
      id: "groups",
      label: "Property Groups",
      title: "Property Groups",
      description: "Administrative and service groupings that do not collapse individual property identity.",
      entityLabel: "Property group",
      contextLabel: "Purpose · customer",
      valueLabel: "Members",
      primaryAction: "New group",
      lifecycle: ["Draft", "Active", "Inactive", "Archived"],
      rules: [
        "Group membership does not replace property identity or authorization.",
        "A property may belong to multiple groups for different purposes.",
        "Service effects are explicit; reporting-only groups do not change service.",
      ],
    },
    {
      id: "shared",
      label: "Shared Points",
      title: "Shared Collection Points",
      description: "Locations, containers, memberships, access, billing responsibility, and shared-service history.",
      entityLabel: "Shared point",
      contextLabel: "Operating model",
      valueLabel: "Members",
      primaryAction: "New shared point",
      lifecycle: ["Draft", "Open", "Restricted", "Closed"],
      rules: [
        "Membership, service use, and billing responsibility are visible separately.",
        "Distance and eligibility warnings require review before membership.",
        "A shared point is not a property group or warehouse.",
      ],
    },
    {
      id: "contacts",
      label: "Contacts & Companies",
      title: "Contacts, Companies, and Relationships",
      description: "People and organizations connected to properties through explicit customer roles.",
      entityLabel: "Contact or company",
      contextLabel: "Role · properties",
      valueLabel: "Communication",
      primaryAction: "New contact",
      lifecycle: ["Active", "Inactive", "Merged", "Archived"],
      rules: [
        "A contact can relate to multiple properties with different roles.",
        "Communication preference and legal authorization are separate.",
        "Merges retain relationship and history provenance.",
      ],
    },
    {
      id: "agreements",
      label: "Agreements",
      title: "Agreements and Subscriptions",
      description: "Effective-dated entitlements, recurring services, payers, products, prices, and history.",
      entityLabel: "Agreement",
      contextLabel: "Customer · payer",
      valueLabel: "Effective period",
      primaryAction: "New agreement",
      // Cancelled is the wire's third status (slice 9a of #81): a signed agreement withdrawn, where Terminated is a period ended by its `validTo`.
      lifecycle: ["Draft", "Pending", "Active", "Expiring", "Expired", "Terminated", "Cancelled"],
      rules: [
        "Agreements, subscriptions, products, and invoices retain effective-dated historical meaning.",
        "Customer, service address, and payer may be different parties.",
        "Activation validates required product fields, price, payer, and responsibility.",
      ],
    },
    {
      // Applications and the office's Decisions (Issue #293, M7): on the API only, so no fixture records; the module's surfaces are M7b's.
      id: "applications",
      label: "Applications",
      title: "Applications",
      description: "A customer's written requests to change how they are served or billed — an exemption, a pause, a longer interval, home composting, a shared bin, assisted collection, a fee put right — and the office's decision on each.",
      entityLabel: "Application",
      contextLabel: "Kind · customer",
      valueLabel: "Decision",
      primaryAction: "Record application",
      lifecycle: ["Received", "In review", "Decided", "Withdrawn"],
      rules: [
        "A decision is appended and never rewritten: an appeal reopens the application and the next decision follows the last.",
        "A grant is in force from its first day; whether it has expired is read from its period, never set by hand.",
        "Anything less than a grant in full tells the customer how to appeal it.",
      ],
    },
    {
      id: "citizen-portal",
      label: "Citizen Portal",
      title: "Citizen and Customer Portal",
      description: "Project-branded, accessible self-service for authorized properties, collection calendars, service history, messages, documents, and supported requests.",
      entityLabel: "Portal activity",
      contextLabel: "Authorized property · service",
      valueLabel: "Service timeline",
      primaryAction: "Preview citizen portal",
      deepLink: "/portal",
      lifecycle: ["Available", "Draft", "Submitted", "In progress", "Waiting for citizen", "Resolved"],
      rules: [
        "A portal user sees only properties they are authorized to represent and never sees other customers, service provider data, or operational-only fields.",
        "Internal comments and confidential financial data never appear; invoices and documents are shown only when the project enables them.",
        "Every self-service action explains its expected response and service timeline in accessible, localized plain language.",
      ],
      records: [
        record(
          "portal-activity-parkvej",
          "Parkvej 18 service overview",
          "Østerbro Housing · authorized property",
          "Available",
          "Property administrator",
          "Next collection 30 Jul",
          "Today",
          "Authorized overview of organic, paper, and residual services.",
          {
            Authorization: "Property administrator · verified",
            "Upcoming service": "Organic · Thursday 30 Jul",
            Containers: "3 assigned",
            Language: "Danish",
          },
          ["Agreement AGR-2408", "3 subscriptions", "3 containers"],
          "Citizen portal",
          "Today",
          ["Create request", "Update preferences"],
        ),
        record(
          "portal-request-8826",
          "Glass overflow request",
          "Sundbyvej 91 · authorized resident",
          "In progress",
          "Customer Service Team",
          "Response due in 1 h 26 min",
          "45 min ago",
          "Citizen submitted an overflow photo and can follow the promised response and service timeline.",
          {
            Authorization: "Resident · property matched",
            RequestType: "Overflow",
            CustomerMessage: "Received · visible",
            InternalComments: "Hidden",
            ExpectedService: "Assessment today",
          },
          ["Ticket T-8826", "Container BIN-44831", "Conversation 1898", "1 citizen-visible attachment"],
          "Citizen portal",
          "45 minutes",
          ["Waiting for citizen", "Resolved"],
        ),
        record(
          "portal-request-container",
          "Request larger cardboard container",
          "Harbor Offices · authorized administrator",
          "Draft",
          "Harbor Offices administrator",
          "Not yet submitted",
          "8 min ago",
          "Commercial property administrator is reviewing the enabled container-change service and its expected lead time.",
          {
            Authorization: "Property administrator · verified",
            RequestType: "Container change",
            CurrentContainer: "660 L cardboard",
            RequestedContainer: "1,100 L cardboard",
            ExpectedService: "Decision within 3 working days",
          },
          ["Property Harbor Offices", "Draft agreement AGR-2512", "Container BIN-77104"],
          "Citizen portal",
          "8 minutes",
          ["Submitted", "Discard"],
        ),
      ],
    },
    {
      // The register of plates and cards (M4 of #293): on the API only, so no fixture records; registered, edited and blocked through components/waste/commands/site-visit-surfaces.tsx.
      id: "site-access",
      label: "Site access",
      title: "Recycling-centre access",
      description: "The vehicle plates and access cards a project's recycling centres admit by: a business's under its customer and the agreement its visits are charged to, a household's under its property.",
      entityLabel: "Access credential",
      contextLabel: "Kind · holder",
      valueLabel: "In force",
      primaryAction: "Register a plate or card",
      lifecycle: ["In force", "Blocked", "Ended"],
      rules: [
        "One credential of a plate or card number is in force at a time.",
        "A credential is ended or blocked, never deleted.",
      ],
    },
    {
      // Right-sizing (M23b of #293): on the API only, so no fixture records; proposals from the drivers' fill estimates, approved or dismissed in their details (components/waste/commands/right-sizing-surfaces.tsx).
      id: "right-sizing",
      label: "Right-sizing",
      title: "Right-sizing proposals",
      description: "Containers the drivers routinely empty half-empty, or overflowing: a size down or up, or fewer or more collections, which the office approves into the subscription's change or dismisses.",
      entityLabel: "Right-sizing proposal",
      contextLabel: "Proposed",
      valueLabel: "Estimates",
      primaryAction: "Propose now",
      lifecycle: ["Open", "Approved", "Dismissed"],
      rules: [
        "A proposal changes nothing: the office approves it into the subscription's change, the price following the product.",
        "A subscription changed since the proposal was made refuses its approve.",
      ],
    },
  ],
}

const resources: WorkspaceDefinition = {
  id: "resources",
  label: "Assets & Inventory",
  description: "Manage the office asset registry, container groups, stock, and warehouse movements.",
  modules: [
    {
      id: "containers",
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
    {
      id: "inventory",
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
    {
      id: "warehouses",
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
    {
      id: "vehicles",
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
    {
      id: "drivers",
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
    {
      id: "depots",
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
    {
      // The Drop-off Points (Issue #293, M3): on the API only, so no fixture records; the office's pane and the public map are M3b's.
      id: "drop-off-points",
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
    {
      // The fill-level Sensors (O26 of #290, row 9.10): on the API only, so no fixture records (lib/api/records/sensors.ts); a sensor's pairing and readings are its details' (components/waste/commands/sensor-surfaces.tsx). The containers' fixture facts (Sensor, Fill level) are the prototype's.
      id: "sensors",
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
  ],
}

function requireWorkspaceModule(
  workspace: WorkspaceDefinition,
  moduleId: string,
): ModuleDefinition {
  const module = workspace.modules.find((candidate) => candidate.id === moduleId)
  if (!module) {
    throw new Error(`Missing ${moduleId} module in ${workspace.id}`)
  }
  return module
}

const fleet: WorkspaceDefinition = {
  id: "fleet",
  label: "Fleet",
  description: "Manage vehicles, drivers, availability, compatibility, and planned allocation.",
  modules: [
    requireWorkspaceModule(resources, "vehicles"),
    requireWorkspaceModule(resources, "drivers"),
    requireWorkspaceModule(plan, "vehicle-planning"),
  ],
}

// Plan's list modules moved out: Vehicle planning to Fleet, Route Schemes to
// Route Studio, and Collection Calendars to Settings (configure.calendars,
// 2026-09-16) — Plan is Map Planning alone.
const planWithoutFleet: WorkspaceDefinition = {
  ...plan,
  modules: plan.modules.filter(
    (module) =>
      module.id !== "vehicle-planning" &&
      module.id !== "schemes" &&
      module.id !== "calendars",
  ),
}

const resourcesWithoutFleet: WorkspaceDefinition = {
  ...resources,
  modules: resources.modules.filter(
    (module) => module.id !== "vehicles" && module.id !== "drivers",
  ),
}

const routeStudioLiveSource = requireWorkspaceModule(operate, "live")
const routeStudioLiveModule: ModuleDefinition = {
  ...routeStudioLiveSource,
  description:
    "Monitor active routes, vehicle freshness, current stops, exceptions, and dispatcher actions alongside Route Studio master data.",
}

/** A weighbridge's tickets (O27 of #290): read from the API alone, so it holds no fixture records. */
const routeStudioWeighbridgeModule: ModuleDefinition = {
  id: "weighbridge",
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
}

const routeStudio: WorkspaceDefinition = {
  id: "route-studio",
  label: "Route Studio",
  description:
    "Monitor live service, design recurring routes, manage route days and their generated Pickups, and control route weights.",
  modules: [
    routeStudioLiveModule,
    requireWorkspaceModule(plan, "schemes"),
    requireWorkspaceModule(operate, "routes"),
    requireWorkspaceModule(operate, "pickups"),
    requireWorkspaceModule(operate, "weights"),
    routeStudioWeighbridgeModule,
  ],
}

const operateWithoutRouteStudio: WorkspaceDefinition = {
  ...operate,
  label: "Tickets",
  description:
    "Manage customer and operational tickets, then triage the exceptions and alerts that require resolution work.",
  modules: [
    requireWorkspaceModule(operate, "tickets"),
    requireWorkspaceModule(operate, "bulky-bookings"),
    requireWorkspaceModule(operate, "exceptions"),
    // Retained as a data contract for route evidence and existing schemas,
    // but omitted from office navigation and public routing.
    requireWorkspaceModule(operate, "driver-app"),
    // Recycling-centre visits (M4 of #293): the ledger, beside the attendant's own /check-in.
    requireWorkspaceModule(operate, "site-visits"),
    // The scale house (M16a of #293): the window's tickets and its tare register.
    requireWorkspaceModule(operate, "scale-house"),
    // Field inspections (M23 of #293): an inspector's visits, their findings and photos.
    requireWorkspaceModule(operate, "inspections"),
  ],
}

const commercial: WorkspaceDefinition = {
  id: "commercial",
  label: "Price Engine",
  description:
    "Price the sellable catalogue, manage service provider prices and settlement, and convert delivered work into auditable money flows.",
  modules: [
    {
      id: "products",
      label: "Products",
      title: "Products & Prices",
      description:
        "The sellable catalogue as the price list: the default price reads from each product's no-conditions row. Products are added and edited in Settings → Commercial → Products.",
      entityLabel: "Product",
      contextLabel: "Type · unit",
      valueLabel: "Default price",
      primaryAction: "Add price",
      lifecycle: ["Draft", "Active", "Inactive"],
      rules: [
        RESOLUTION_RULE,
        "The default price is the price row with no conditions — Add price creates it for a product from Settings.",
        "Prices are effective-dated and selection is explainable.",
      ],
    },
    {
      id: "price-rows",
      label: "Price rows",
      title: "Price Rows",
      description:
        "Every sellable price is a row — default, variation, or negotiated deal — with conditions, effective dates and a price-list tag. Add price creates defaults, variations and negotiated deals alike.",
      entityLabel: "Price row",
      contextLabel: "Product",
      valueLabel: "Amount",
      primaryAction: "Add price",
      lifecycle: ["Scheduled", "Active", "Expired"],
      rules: [
        RESOLUTION_RULE,
        "One price model: the Products table's default price reads the no-conditions row.",
        "Schedule a change by editing a row's scheduled fields; the amount switches on the scheduled date.",
      ],
    },
    {
      id: "events",
      label: "Billable Events",
      title: "Billable Events",
      description: "Traceable service occurrences that can become invoice lines after responsibility and pricing validation.",
      entityLabel: "Billable event",
      contextLabel: "Customer · origin",
      valueLabel: "Amount",
      primaryAction: "Add manual event",
      lifecycle: ["In progress", "Ready", "Invoiced", "Blocked", "Cancelled"],
      rules: [
        "Every blocked event has a specific actionable reason.",
        "Event origin, pricing inputs, selected price, and line decomposition remain traceable.",
        "Cancellation preserves the original event and its history.",
      ],
    },
    {
      id: "billing",
      label: "Billing Runs",
      title: "Billing Runs",
      description: "Reproducible selection, bundling, included, skipped, blocked, failed, and generated invoice results.",
      entityLabel: "Billing run",
      contextLabel: "Scope · period",
      valueLabel: "Result",
      primaryAction: "Run billing",
      lifecycle: ["Scheduled", "Running", "Completed", "Failed"],
      rules: [
        "No customer is silently skipped; every exclusion has a result reason.",
        "Run inputs, selection, bundling, counts, errors, and output are retained.",
        "Failed runs preserve partial work and require an explicit retry strategy.",
      ],
    },
    {
      id: "invoices",
      label: "Invoices & Credits",
      title: "Invoices and Credit Notes",
      description: "Immutable issued documents, delivery state, accounting rows, and explicit correction paths.",
      entityLabel: "Financial document",
      contextLabel: "Customer · period",
      valueLabel: "Amount",
      primaryAction: "New credit note",
      lifecycle: ["Unsent", "Sent", "Partially credited", "Credited", "Cancelled"],
      rules: [
        "Invoice number and original issued content are immutable.",
        "Corrections use cancellation or full or partial credit notes.",
        "Delivery and accounting-export failures remain visible and retryable.",
      ],
    },
    {
      id: "payments",
      label: "Payments",
      title: "Payments",
      description: "Money as it arrived, registered by hand or read from a bank statement, and the invoices it pays.",
      entityLabel: "Payment",
      contextLabel: "Payer · paid on",
      valueLabel: "Amount",
      primaryAction: "Register payment",
      lifecycle: ["Unmatched", "Partially allocated", "Allocated"],
      rules: [
        "A payment is never rewritten; a wrong match is undone by its reversal.",
        "A payment pays an invoice what it owes at most; the rest is a credit on the payer's balance.",
        "A bank statement imported twice adds nothing.",
      ],
    },
    {
      id: "service-provider-prices",
      label: "Service Provider Prices",
      title: "Service Provider Prices",
      description:
        "What we pay per service provider × product × service area: the contractually locked bid and the indexed current fee.",
      entityLabel: "Service provider price",
      contextLabel: "Service area · validity",
      valueLabel: "Current fee",
      primaryAction: "New service provider price",
      lifecycle: ["Upcoming", "Active", "Expiring", "Expired"],
      rules: [
        "The bid is contractually immutable; indexation changes only the current fee.",
        "Customer and service provider prices are separate confidential records.",
        "Each Apply index run appends to the service provider price's indexation history.",
      ],
    },
    {
      id: "service-providers",
      label: "Service Providers",
      title: "Service Providers and Service Areas",
      description: "External haulers, awarded responsibility, protected proposals, compliance, workload, and performance.",
      entityLabel: "Service provider",
      contextLabel: "Service area · period",
      valueLabel: "Service state",
      primaryAction: "New service provider",
      lifecycle: ["Draft", "Upcoming", "Active", "Expiring", "Expired", "Terminated"],
      rules: [
        "Service providers see only their own users, fleet, routes, proposals, performance, and permitted money.",
        "Protected master-data changes are proposals and never auto-apply.",
        "Service area responsibility is effective-dated and checked for gaps or overlaps.",
      ],
    },
    {
      id: "service-provider-workspace",
      label: "Service Provider Workspace",
      title: "Users",
      description: "Service provider-scoped company, fleet, users, route lists, proposals, performance, complaints, and manager-only commercial views.",
      entityLabel: "User",
      contextLabel: "Service provider · role · scope",
      valueLabel: "Visible workspace",
      primaryAction: "Add user",
      deepLink: "/service-provider-workspace",
      lifecycle: ["Invited", "Active", "Deactive"],
      rules: [
        "Every service provider user is isolated to their own service provider, permitted projects, users, vehicles, routes, proposals, performance, and complaints.",
        "Prices and settlement are visible only to service provider managers; foremen and drivers cannot see money or structural proposal controls.",
        "Protected master-data changes remain proposals until an authorized Waste office user approves or rejects them.",
      ],
    },
    {
      id: "settlements",
      label: "Settlements",
      title: "Settlements",
      description: "Confidential service provider compensation, period calculation, provisional inputs, and frozen closeout.",
      entityLabel: "Settlement",
      contextLabel: "Service provider · period",
      valueLabel: "Amount",
      primaryAction: "Calculate period",
      lifecycle: ["Open", "Calculated", "Under review", "Closed", "Reopened"],
      rules: [
        "Closing freezes a reproducible snapshot of settlement inputs.",
        "Reopening requires permission, reason, and audit history.",
        "Service provider-visible amounts exclude confidential customer prices.",
      ],
    },
  ],
}

const serviceProviderCompanyModule = requireWorkspaceModule(commercial, "service-providers")
const serviceProviderWorkspaceModule = requireWorkspaceModule(
  commercial,
  "service-provider-workspace",
)

const serviceAreasModule: ModuleDefinition = {
  id: "service-areas",
  label: "Service Areas",
  title: "Service Areas",
  description:
    "Geographic and time-bounded service responsibility awarded to a service provider.",
  entityLabel: "Service area",
  contextLabel: "Service provider · service scope",
  valueLabel: "Effective period",
  primaryAction: "New service area",
  lifecycle: ["Draft", "Upcoming", "Active", "Expiring", "Expired", "Terminated"],
  rules: [
    "Area responsibility is effective-dated and belongs to one service provider for the awarded service scope.",
    "Boundaries, products, zones, and exceptions remain explicit.",
    "Transfers preserve the prior award and start a new effective responsibility.",
  ],
}

const serviceProviderActivitiesModule: ModuleDefinition = {
  id: "activities",
  label: "Activities",
  title: "Service Provider Activities",
  description:
    "Proposals, compliance follow-ups, and notes between the office and its service providers, in one history.",
  entityLabel: "Service provider activity",
  contextLabel: "Service provider · service area",
  valueLabel: "Activity",
  primaryAction: "Log activity",
  lifecycle: ["Pending approval", "Approved", "Rejected", "Withdrawn", "Open", "Completed", "Cancelled"],
  rules: [
    "Each activity remains linked to its service provider and applicable service area.",
    "Protected-change proposals require office approval before affecting live records; an approval writes the scheme's next version from the proposal's day.",
    "Activities restate no operational record: a route's assignment is the route's own.",
    "Completed activity history is retained when responsibility changes.",
  ],
}

const serviceProviders: WorkspaceDefinition = {
  id: "service-providers",
  label: "Service providers",
  description:
    "Manage service provider companies, awarded service areas, and operational activity.",
  modules: [
    {
      ...serviceProviderCompanyModule,
      title: "Service Providers",
      description:
        "External service providers, company details, compliance, access, fleet links, and performance.",
    },
    serviceAreasModule,
    serviceProviderActivitiesModule,
    serviceProviderWorkspaceModule,
  ],
}

const commercialWithoutServiceProviders: WorkspaceDefinition = {
  ...commercial,
  modules: commercial.modules.filter(
    (module) =>
      module.id !== "service-providers" && module.id !== "service-provider-workspace",
  ),
}

const improve: WorkspaceDefinition = {
  id: "improve",
  label: "Dashboard",
  description: "Understand performance, automate safely, exchange trusted data, and maintain analytical honesty.",
  modules: [
    {
      id: "intelligence",
      label: "Intelligence",
      title: "Intelligence: Ask, Monitor, Report, Trust",
      description: "Governed questions, operational monitoring, scheduled reporting, and metric trust.",
      entityLabel: "Insight or report",
      contextLabel: "Area · source",
      valueLabel: "Freshness",
      primaryAction: "Ask Waste",
      lifecycle: ["Draft", "Proposed", "Certified", "Deprecated", "Retracted"],
      rules: [
        "Missing data is never presented as zero.",
        "Answers expose metric definition, grain, freshness, lineage, assumptions, and limitations.",
        "AI proposes but does not silently alter production records.",
      ],
      records: [
        record(
          "insight-441",
          "Østerbro organic SLA is declining",
          "Monitor · Citizen service",
          "Needs review",
          "Analytics Team",
          "Fresh 18 min ago",
          "18 min ago",
          "On-time completion fell from 96.2% to 91.4%; blocked access explains 62% of the change.",
          { Metric: "On-time completion rate", Grain: "Stop · week", Confidence: "High", MissingData: "1.8% GPS events" },
          ["Certified metric MET-14", "12 affected routes", "7 linked tickets"],
          "Semantic model + route events",
          "18 minutes",
          ["Create alert", "Retract"],
        ),
        record(
          "report-ads-july",
          "Danish ADS waste report · July",
          "Report · Compliance",
          "Scheduled",
          "Compliance Team",
          "Runs 1 Aug 06:00",
          "Today",
          "Regulatory report using approved waste, weight, facility, and customer mappings.",
          { Definition: "ADS-DK v2026.2", Grain: "Movement", Confidence: "Certified", MissingData: "0.2% facility code review" },
          ["Report schedule RS-ADS-01", "Metric catalogue", "Integration ADS"],
          "Compliance semantic model",
          "Today",
          ["Run now", "Pause"],
        ),
        record(
          "metric-route-cost",
          "Cost per completed stop",
          "Trust · Operations finance",
          "Certified",
          "Metric Owner · Finance",
          "Fresh 2 hours ago",
          "2 hours ago",
          "Total eligible route cost divided by completed service stops; excludes cancelled routes and missing cost allocations.",
          { Metric: "MET-38", Grain: "Route · period", Confidence: "Certified", MissingData: "Shown separately" },
          ["7 compatible dimensions", "Lineage graph", "12 dashboards"],
          "Metric catalogue",
          "2 hours",
          ["Deprecated", "Create version"],
        ),
      ],
    },
    {
      id: "analytics",
      label: "Analytics",
      title: "Analytics and Dashboards",
      description: "Source-backed operational, customer, asset, fleet, cost, sustainability, and period analysis.",
      entityLabel: "Dashboard",
      contextLabel: "Audience · scope",
      valueLabel: "Freshness",
      primaryAction: "New dashboard",
      lifecycle: ["Draft", "Published", "Certified", "Archived"],
      rules: [
        "Data freshness and source are visible in every analytical surface.",
        "Rates, averages, and counts retain their aggregation behavior.",
        "Export permission is separate from view permission for sensitive data.",
      ],
      records: [
        record(
          "dashboard-ops",
          "Daily Operations Cockpit",
          "Dispatchers · Copenhagen Central",
          "Certified",
          "Operations Analytics",
          "Fresh 2 min ago",
          "2 min ago",
          "Routes, progress, exceptions, stale vehicles, service SLA, and recovery outcomes.",
          { Owner: "Operations Analytics", Source: "Route event model", Refresh: "Every 2 minutes", Access: "Operations" },
          ["14 certified metrics", "6 cross-filters", "3 alert subscriptions"],
          "Semantic model",
          "2 minutes",
          ["Create copy", "Archive"],
        ),
        record(
          "dashboard-service-provider",
          "Service Provider Scorecard",
          "Contract managers · own scope",
          "Published",
          "Contract Analytics",
          "Fresh 1 hour ago",
          "1 hour ago",
          "Reliability, deviations, complaints, fuel, load, service, and settlement indicators.",
          { Owner: "Contract Analytics", Source: "Service provider model", Refresh: "Hourly", Access: "Scoped by service provider" },
          ["9 metrics", "3 service providers", "Privacy scope test"],
          "Semantic model",
          "1 hour",
          ["Certify", "Archive"],
        ),
      ],
    },
    {
      id: "autopilot",
      label: "Autopilot",
      title: "Autopilot and Workflow Automation",
      description: "Patterns, governed suggestions, versioned flows, shadow simulation, approvals, activity, and impact.",
      entityLabel: "Flow or suggestion",
      contextLabel: "Scope · authority",
      valueLabel: "Impact",
      primaryAction: "New flow",
      lifecycle: ["Draft", "Test", "Shadow", "Approval", "Live", "Paused", "Retired"],
      rules: [
        "The action registry defines what a flow is allowed to do.",
        "Every automated change identifies flow, version, trigger, action, and outcome.",
        "The kill switch stops new execution without deleting history.",
      ],
      records: [
        record(
          "flow-14",
          "Low-risk recollection triage",
          "Central failed stops · approval gated",
          "Shadow",
          "Process Owner · Olivia",
          "92% matched decisions",
          "1 hour ago",
          "Suggests recollection when evidence, agreement, SLA, and route capacity satisfy registered rules.",
          { Version: "v3", Authority: "Suggest only", Period: "90-day replay", Assumptions: "6 documented" },
          ["Simulation SIM-219", "Approval AP-103", "Action registry ACT-RECOLLECT"],
          "Autopilot",
          "1 hour",
          ["Approval", "Paused"],
        ),
        record(
          "flow-09",
          "Low-stock ticket creation",
          "Inventory thresholds · controlled action",
          "Live",
          "Warehouse Process Owner",
          "28 duplicate tickets avoided",
          "Today",
          "Creates one procurement ticket per unresolved low-stock condition and closes on recovery.",
          { Version: "v5", Authority: "Create ticket", Period: "Live", Assumptions: "Threshold data trusted" },
          ["14 activity runs", "Impact ledger IMP-09", "Kill switch enabled"],
          "Autopilot",
          "Today",
          ["Paused", "Retired"],
        ),
        record(
          "suggestion-881",
          "Move 8 stops from RC-1048 to RC-1060",
          "Live Operations · load balance",
          "Pending approval",
          "Dispatch Team",
          "Forecast +18 min SLA margin",
          "5 min ago",
          "Suggestion compares compatible vehicle capacity, service windows, disruption, and route impact.",
          { Version: "Model 2026.7", Authority: "Suggest only", Confidence: "Medium", Assumptions: "GPS + service duration" },
          ["Routes RC-1048 and RC-1060", "8 service stops", "Approval request"],
          "Dispatch recommendation",
          "5 minutes",
          ["Approved", "Rejected"],
        ),
      ],
    },
    {
      id: "imports",
      label: "Imports & Exports",
      title: "Imports, Exports, and Background Jobs",
      description: "Validated mapping, partial success, row-level errors, scheduled delivery, and complete request audit.",
      entityLabel: "Job",
      contextLabel: "Dataset · direction",
      valueLabel: "Result",
      primaryAction: "New import",
      lifecycle: ["Uploaded", "Mapping", "Validating", "Queued", "Running", "Partial", "Completed", "Failed"],
      rules: [
        "Import errors identify the source row and actionable problem.",
        "Partial success states exactly what was and was not applied.",
        "Download and delivery access is audited separately from view access.",
      ],
      records: [
        record(
          "import-771",
          "Property registry update · July",
          "Properties · inbound",
          "Partial",
          "Data Quality Team",
          "2,418 applied · 34 errors",
          "3 hours ago",
          "Registry import applied valid property updates and isolated row-level issues.",
          { File: "properties-july.xlsx", Rows: "2,452", Applied: "2,418", Errors: "34" },
          ["34 error rows", "Mapping MAP-PROP-8", "Result file"],
          "Manual upload",
          "3 hours",
          ["Retry errors", "Download result"],
        ),
        record(
          "export-8801",
          "June accounting export",
          "Invoices · outbound",
          "Completed",
          "Billing Team",
          "1,204 documents",
          "1 Jul",
          "Accounting rows and invoice references delivered to Navision.",
          { Format: "CSV + documents", Rows: "8,418", Delivered: "1 Jul 04:22", Destination: "Navision SFTP" },
          ["Billing run BR-2026-06", "Delivery receipt", "Download audit"],
          "Scheduled export",
          "1 Jul",
          ["Download result", "Run again"],
        ),
        record(
          "import-779",
          "Container RFID pairing",
          "Assets · inbound",
          "Failed",
          "Asset Team",
          "0 applied",
          "18 min ago",
          "File is missing the required asset identifier column; no rows were applied.",
          { File: "rfid-pairing.csv", Rows: "188", Applied: "0", Errors: "File schema" },
          ["Schema error", "Template download", "Retry instructions"],
          "Manual upload",
          "18 minutes",
          ["Upload corrected file"],
        ),
      ],
    },
    {
      id: "performance",
      label: "Performance",
      title: "Performance and Compliance",
      description: "Operational SLA, service provider, driver, fleet, service, GPS governance, and regulatory reporting.",
      entityLabel: "Scorecard",
      contextLabel: "Scope · period",
      valueLabel: "Headline result",
      primaryAction: "Create scorecard",
      lifecycle: ["Draft", "Published", "Certified", "Archived"],
      rules: [
        "Scorecards expose definitions, source, period, scope, and missing data.",
        "Service providers cannot see unrelated service provider or confidential customer-price data.",
        "GPS access and monitoring reports retain purpose and access audit.",
      ],
      records: [
        record(
          "scorecard-central",
          "Copenhagen Central Service SLA",
          "Project · last 30 days",
          "Certified",
          "Operations Analytics",
          "94.8% on time",
          "2 min ago",
          "On-time completion, first-time success, recollection, proof, and complaint indicators.",
          { Definition: "SLA-COL-4", Period: "Last 30 days", MissingData: "0.8%", Target: "95%" },
          ["12 routes", "2,812 stops", "84 tickets", "Metric catalogue"],
          "Certified semantic model",
          "2 minutes",
          ["Create report", "Archive"],
        ),
        record(
          "compliance-gps",
          "GPS monitoring register",
          "Company · Q3 2026",
          "Attention",
          "Privacy Officer",
          "2 overdue reviews",
          "Yesterday",
          "Register of configured purposes, employee notices, access roles, retention, and audit review.",
          { Purpose: "Dispatch + proof", Retention: "90 days", AccessRoles: "3", LastReview: "15 Apr 2026" },
          ["GPS policy v4", "48 access events", "2 overdue purpose reviews"],
          "Privacy configuration + access audit",
          "Yesterday",
          ["Complete review", "Create task"],
        ),
      ],
    },
    {
      id: "compliance",
      label: "Reports & Trust",
      title: "Reports, Metric Trust, and Compliance Outputs",
      description: "Scheduled management packs, regulatory outputs, definitions, lineage, ownership, and exposure review.",
      entityLabel: "Report or metric",
      contextLabel: "Audience · schedule",
      valueLabel: "State",
      primaryAction: "New report",
      lifecycle: ["Draft", "Review", "Published", "Retracted", "Archived"],
      rules: [
        "Public reporting defaults off and excludes restricted operational and financial data.",
        "Benchmark cohorts satisfy minimum privacy thresholds and opt-out rules.",
        "Retraction preserves audit and removes unsupported exposure.",
      ],
      records: [
        record(
          "report-mgmt-july",
          "Operations management pack · July",
          "Executive team · monthly",
          "Scheduled",
          "Analytics Team",
          "Runs 1 Aug",
          "Today",
          "Management pack covering service, cost, fleet, service provider, customer, and compliance performance.",
          { Format: "PDF + spreadsheet", Schedule: "Monthly", Freshness: "Certified metrics", Delivery: "Email + archive" },
          ["18 metrics", "7 sections", "Distribution list"],
          "Report scheduler",
          "Today",
          ["Run now", "Pause"],
        ),
        record(
          "metric-proof",
          "Proof completeness rate",
          "Metric catalogue · operations",
          "Certified",
          "Metric Owner · Operations",
          "MET-22",
          "1 week ago",
          "Completed stops with all required evidence divided by eligible completed stops.",
          { Grain: "Stop · period", Aggregation: "Weighted rate", Freshness: "2 minutes", MissingData: "Excluded + reported" },
          ["Lineage graph", "14 dashboards", "2 alert rules"],
          "Metric catalogue",
          "1 week",
          ["Create version", "Deprecated"],
        ),
      ],
    },
  ],
}

const configure: WorkspaceDefinition = {
  id: "configure",
  label: "Configure",
  description: "Control organization, access, master data, integrations, portals, finance, and feature behavior.",
  modules: [
    {
      id: "organization",
      label: "Company & Projects",
      title: "Company, Projects, and Operating Context",
      description: "Tenant identity, legal and billing details, projects, local operating context, and entitlements.",
      entityLabel: "Company or project",
      contextLabel: "Scope · role",
      valueLabel: "Configuration state",
      primaryAction: "New project",
      lifecycle: ["Onboarding", "Active", "Suspended", "Archived"],
      rules: [
        "Every query and mutation is company-scoped and usually project-scoped.",
        "Project access is not inferred from company access.",
        "Company and project context are visible before high-impact actions.",
      ],
    },
    {
      id: "access",
      label: "Users, Roles & Teams",
      title: "Users, Roles, Teams, and Access",
      description: "Invitations, project assignment, granular permissions, service provider links, SSO, sessions, and access history.",
      entityLabel: "User or role",
      contextLabel: "Company · project scope",
      valueLabel: "Access",
      primaryAction: "Invite user",
      lifecycle: ["Invited", "Active", "Suspended", "Deactivated"],
      rules: [
        "Project access is explicitly granted and not inferred from company membership.",
        "Service provider managers cannot invite unrestricted company users.",
        "Destructive access changes require confirmation and audit history.",
      ],
    },
    {
      id: "master",
      label: "Operational Master Data",
      title: "Operational Master Data",
      description: "Fractions, container types, service reasons, depots, stations, weeks, holidays, units, and effective versions.",
      entityLabel: "Master-data set",
      contextLabel: "Scope · version",
      valueLabel: "Records",
      primaryAction: "Add master data",
      lifecycle: ["Draft", "Scheduled", "Effective", "Superseded", "Archived"],
      rules: [
        "Effective-dated changes retain historical meaning.",
        "Dependencies and feature status are visible before editing.",
        "Protected service provider changes are submitted as proposals.",
      ],
    },
    // Areas & Zones moved here from Plan on 2026-09-03 (D37): planning
    // geography is Settings-managed master data. The `configure` workspace
    // is the registry twin of Settings — business-links resolves its
    // modules to /settings?pane=… — and the records stay business records
    // (bucket "configure.areas") so schemes, containers, and service areas
    // keep referencing them.
    {
      id: "areas",
      label: "Areas & Zones",
      title: "Areas, Zones, and Service Geography",
      description: "Planning areas, notification zones, and map validation.",
      entityLabel: "Area or zone",
      contextLabel: "Purpose · project",
      valueLabel: "Coverage",
      primaryAction: "New area",
      lifecycle: ["Draft", "Valid", "Upcoming", "Active", "Expired"],
      rules: [
        "Area boundary gaps and overlaps are visible before activation.",
        "Geographic scope is effective-dated.",
        "Notification zones and operational responsibility remain separate concepts.",
      ],
    },
    {
      id: "templates",
      label: "Tickets & Communication",
      title: "Ticket and Communication Templates",
      description: "Ticket types, categories, statuses, actions, message templates, recipients, channels, and email routing.",
      entityLabel: "Template or rule",
      contextLabel: "Type · channel",
      valueLabel: "Usage",
      primaryAction: "New template",
      lifecycle: ["Draft", "Active", "Deprecated", "Archived"],
      rules: [
        "Ticket lifecycles offer only valid configured transitions.",
        "Template preview shows variable data and channel limitations.",
        "Traditional rules and intelligence monitors expose source and migration ownership.",
      ],
    },
    {
      id: "finance",
      label: "Finance & Invoicing",
      title: "Finance and Invoicing Configuration",
      description: "VAT, currency, payment references, cadence, cost centres, accounting accounts, and routing rules.",
      entityLabel: "Finance setting",
      contextLabel: "Company or project scope",
      valueLabel: "Current value",
      primaryAction: "Add routing rule",
      lifecycle: ["Draft", "Active", "Superseded", "Archived"],
      rules: [
        "Finance defaults expose company versus project scope.",
        "Routing and VAT changes are effective-dated and auditable.",
        "Missing mappings block events with actionable reasons.",
      ],
      records: [
        record(
          "finance-defaults",
          "Copenhagen finance defaults",
          "Project scope · Copenhagen Central",
          "Active",
          "Finance Admin",
          "DKK · VAT 25%",
          "1 month ago",
          "Default currency, VAT, payment reference, invoice language, cadence, and bundling.",
          { Currency: "DKK", VAT: "25%", PaymentReference: "FIK 71", BillingCadence: "Monthly" },
          ["6 billing schedules", "2,216 agreements", "12 routing rules"],
          "Finance settings",
          "1 month",
          ["Create version", "Archive"],
        ),
        record(
          "billing-schedule-cph-monthly",
          "Copenhagen monthly billing",
          "Project scope · Copenhagen Central",
          "Active",
          "Finance Admin",
          "Runs on day 1 · 02:00",
          "1 month ago",
          "Effective billing schedule used to select the previous calendar month of ready billable events.",
          {
            Currency: "DKK",
            Cadence: "Monthly",
            Cutoff: "Last day · 23:59",
            "Next run": "1 Aug 2026 · 02:00",
          },
          ["Copenhagen finance defaults", "Ready billable events", "Billing run history"],
          "Scheduled billing",
          "1 month",
          ["Create version", "Pause"],
        ),
        record(
          "routing-organic",
          "Organic collection accounting route",
          "Project scope · service events",
          "Configuration gap",
          "Finance Admin",
          "3 unmapped products",
          "Today",
          "Three new organic products lack an accounting-account mapping after 1 August.",
          { Currency: "DKK", VAT: "25%", CostCentre: "CC-ORGANIC", BillingCadence: "Inherited" },
          ["3 blocked product mappings", "37 projected events", "Effective 1 Aug"],
          "Accounting routing",
          "Today",
          ["Add mapping", "Disable"],
        ),
      ],
    },
    {
      id: "integrations",
      label: "Integrations",
      title: "Integrations and External Data Exchange",
      description: "Authentication, flow direction, ownership, mappings, sync health, retries, and downloadable errors.",
      entityLabel: "Integration",
      contextLabel: "Category · direction",
      valueLabel: "Last synchronization",
      primaryAction: "Connect integration",
      lifecycle: ["Not connected", "Connecting", "Healthy", "Degraded", "Failed", "Disabled"],
      rules: [
        "Connection state, ownership, direction, freshness, and field mapping are visible.",
        "Partial and failed jobs expose affected records and retry guidance.",
        "Integration credentials and write scope are permission-controlled and audited.",
      ],
      records: [
        record(
          "integration-gps",
          "Fleet GPS · Webfleet",
          "IoT and telemetry · inbound",
          "Degraded",
          "Integration Owner · Fleet",
          "Last success 2 min ago",
          "2 min ago",
          "Position feed is healthy for twenty vehicles; WH-31 has not updated inside threshold.",
          { Direction: "Inbound", Authentication: "OAuth healthy", Mapping: "v4", Owner: "Fleet Team" },
          ["21 vehicles", "1 stale position alert", "Sync job GPS-9918"],
          "Webfleet API",
          "2 minutes",
          ["Retry", "Disable"],
        ),
        record(
          "integration-navision",
          "Navision Finance",
          "Finance · bidirectional",
          "Healthy",
          "Integration Owner · Finance",
          "Last success 04:22",
          "Today",
          "Invoice accounting export and payment-status import are operating normally.",
          { Direction: "Bidirectional", Authentication: "Certificate · 88 days", Mapping: "v7", Owner: "Finance Team" },
          ["Export EXP-8801", "1,204 invoices", "3 scheduled jobs"],
          "Navision SFTP + API",
          "Today",
          ["Run test", "Disable"],
        ),
        record(
          "integration-digitalpost",
          "Danish Digital Post",
          "Communication · outbound",
          "Failed",
          "Integration Owner · Communications",
          "Credential expired",
          "Today",
          "Client certificate expired; three invoice deliveries are waiting for retry.",
          { Direction: "Outbound", Authentication: "Certificate expired", Mapping: "v3", Owner: "Communications Team" },
          ["3 failed messages", "Certificate CERT-09", "Support case SUP-118"],
          "Digital Post",
          "Today",
          ["Update credential", "Disable"],
        ),
      ],
    },
    {
      id: "portals",
      label: "Portals & Branding",
      title: "Portals, Branding, and Customer-Facing Content",
      description: "Project branding, portal access, localized content, banners, self-service, and feature visibility.",
      entityLabel: "Portal",
      contextLabel: "Audience · project",
      valueLabel: "Access",
      primaryAction: "New portal",
      lifecycle: ["Draft", "Review", "Published", "Paused", "Archived"],
      rules: [
        "Portal users see only properties they are authorized to represent.",
        "Internal comments, service provider data, and operational-only fields remain hidden.",
        "Project branding and content are previewed before publication.",
      ],
      records: [
        record(
          "portal-copenhagen",
          "Copenhagen Customer Portal",
          "Citizens and property users · Copenhagen Central",
          "Published",
          "Portal Admin",
          "1,408 authorized users",
          "Today",
          "Self-service collection calendar, containers, requests, messages, and selected documents.",
          { Domain: "service.kystbyen.example", Language: "Danish", Branding: "Copenhagen", Accessibility: "AA reviewed" },
          ["1,408 users", "2,481 properties", "4 self-service actions", "2 banners"],
          "Portal configuration",
          "Today",
          ["Paused", "Create version"],
        ),
        record(
          "portal-harbor",
          "Harbor Commercial Portal",
          "Property administrators · Harbor Commercial",
          "Draft",
          "Onboarding Team",
          "Not published",
          "Yesterday",
          "Restricted commercial portal awaiting branding, payer documents, and service-action configuration.",
          { Domain: "Not assigned", Language: "Danish + English", Branding: "Draft", Accessibility: "Not reviewed" },
          ["6 properties", "2 invited admins", "3 setup issues"],
          "Portal configuration",
          "Yesterday",
          ["Review", "Archive"],
        ),
      ],
    },
    {
      id: "control-center",
      label: "Control Center",
      title: "Waste Control Center, Sales, Subscriptions, and Marketplace",
      description: "Role-gated commercial administration for leads, offers, onboarding, portal rights, feature subscriptions, payment readiness, and compatible hardware purchases.",
      entityLabel: "Commercial item",
      contextLabel: "Customer · offer · entitlement",
      valueLabel: "Commercial state",
      primaryAction: "New sales offer",
      deepLink: "/control-center",
      lifecycle: ["Lead", "Qualified", "Offer sent", "Accepted", "Payment pending", "Provisioning", "Active", "Fulfillment pending", "Suspended", "Archived"],
      rules: [
        "Waste internal customer administration is role-gated and remains separate from authorized tenant self-service.",
        "Every accepted commercial product maps to explicit project or company feature entitlements with a controlled activation or archive process.",
        "Failed payment or incomplete billing information does not grant ambiguous access, and hardware availability and fulfillment remain explicit.",
      ],
      records: [
        record(
          "sales-lead-greenloop",
          "GreenLoop Municipality",
          "Sales lead · Zealand · municipal",
          "Qualified",
          "Waste Sales · Anna Berg",
          "DKK 1.8m weighted",
          "Today",
          "Qualified municipality evaluating core operations, Citizen Portal, Route Studio, and ADS reporting.",
          {
            "Visible to": "Waste sales + onboarding",
            "Expected projects": "2",
            "Requested products": "Core · Citizen Portal · Route Studio · ADS",
            "Next decision": "Solution workshop · 29 Jul",
            "Billing readiness": "Company details verified",
          },
          ["Prospective customer GreenLoop", "Opportunity SAL-882", "Solution workshop", "Draft offer OFR-2051"],
          "Waste Sales",
          "Today",
          ["Offer sent", "Archived"],
        ),
        record(
          "offer-2044",
          "OFR-2044 · Harbor Commercial",
          "Offer · Harbor Offices ApS",
          "Offer sent",
          "Waste Sales · Anna Berg",
          "DKK 184,000 annually",
          "2 days ago",
          "Commercial offer page combines the Operations plan, Customer Portal rights, invoicing, and twenty LoRa sensors.",
          {
            "Visible to": "Waste sales + invited customer administrator",
            "Offer expiry": "8 Aug 2026",
            "Platform products": "Operations · Portal · Invoicing",
            Hardware: "20 LoRa sensors · in stock",
            "Payment terms": "30 days · invoice",
          },
          ["Customer Harbor Offices ApS", "Price book PB-2026-DK", "Subscription draft SUB-771", "Cart CART-2044"],
          "Control Center offer service",
          "2 days",
          ["Accepted", "Archived"],
        ),
        record(
          "subscription-harbor",
          "Harbor Operations subscription",
          "Harbor Offices ApS · company entitlement",
          "Provisioning",
          "Waste Onboarding",
          "3 products · 1 blocked",
          "18 min ago",
          "Operations and portal entitlements are prepared, but invoicing stays disabled until payer and billing details are complete.",
          {
            "Visible to": "Waste onboarding + authorized customer admin",
            "Plan": "Operations Growth",
            "Active entitlements": "Core Operations · Customer Portal",
            "Pending entitlement": "Invoicing",
            "Billing readiness": "Payer and CVR missing",
          },
          ["Accepted offer OFR-2044", "Portal rights PR-771", "Agreement AGR-2512", "Onboarding checklist ONB-88"],
          "Subscription and entitlement service",
          "18 minutes",
          ["Active", "Payment pending", "Suspended"],
        ),
        record(
          "subscription-route-studio",
          "Route Studio add-on",
          "Copenhagen Central · project entitlement",
          "Active",
          "Waste Customer Success",
          "12 planner seats",
          "1 week ago",
          "Accepted add-on purchase explicitly activates Route Studio and two-step plan approval for one project.",
          {
            "Visible to": "Waste support + company master",
            "Commercial product": "Route Studio Professional",
            "Feature entitlement": "route-studio · active",
            "Approval dependency": "two-step-plan-approval · enabled",
            "Renewal": "1 Jul 2027",
          },
          ["Purchase PUR-1182", "Offer OFR-1988", "12 assigned planners", "Entitlement history v3"],
          "Subscription and entitlement service",
          "1 week",
          ["Suspended", "Archived"],
        ),
        record(
          "marketplace-order-2908",
          "ORD-2908 · 20 LoRa sensors",
          "Marketplace · Harbor Offices ApS",
          "Fulfillment pending",
          "Waste Fulfillment",
          "DKK 42,800 · paid",
          "Today",
          "Compatible sensor order is paid and reserved while the shipping address awaits customer confirmation.",
          {
            "Visible to": "Waste fulfillment + authorized customer admin",
            Availability: "20 reserved · Warehouse West",
            Compatibility: "Waste LoRa asset profile v4",
            Payment: "Captured · card ending 4128",
            Fulfillment: "Address confirmation required",
          },
          ["Cart CART-2044", "Purchase summary PUR-2908", "Invoice MP-260118", "Reservation RES-881"],
          "Waste Marketplace",
          "Today",
          ["Active", "Archived"],
        ),
      ],
    },
    // Collection Calendars moved here from Plan on 2026-09-16 (Plan became
    // Map Planning). The `configure` workspace is the registry twin of
    // Settings — business-links resolves its modules to /settings?pane=… —
    // and the records stay business records (bucket "configure.calendars") so
    // generation, the wizard, and Plan Ahead keep reading them.
    requireWorkspaceModule(plan, "calendars"),
  ],
}

const controlCenterModule = requireWorkspaceModule(configure, "control-center")
const controlCenter: WorkspaceDefinition = {
  id: "control-center",
  label: "Control Center",
  description:
    "Manage role-gated sales, onboarding, subscriptions, entitlements, and marketplace fulfillment.",
  modules: [
    {
      ...controlCenterModule,
      deepLink: undefined,
    },
  ],
}

export const businessWorkspaces: Record<WorkspaceId, WorkspaceDefinition> = {
  operate: operateWithoutRouteStudio,
  plan: planWithoutFleet,
  "route-studio": routeStudio,
  fleet,
  customers,
  resources: resourcesWithoutFleet,
  "service-providers": serviceProviders,
  commercial: commercialWithoutServiceProviders,
  improve,
  configure,
  "control-center": controlCenter,
}

export const businessWorkspaceList = Object.values(businessWorkspaces).filter(
  (workspace) => workspace.id !== "configure",
)

export function getWorkspaceDefinition(id: WorkspaceId): WorkspaceDefinition {
  return businessWorkspaces[id]
}

export function getModuleDefinition({
  workspaceId,
  moduleId,
}: ModuleLocation): ModuleDefinition | undefined {
  return businessWorkspaces[workspaceId].modules.find(
    (module) => module.id === moduleId,
  )
}
