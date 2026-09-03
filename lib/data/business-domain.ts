export const blueprintModuleIds = [
  "M01",
  "M02",
  "M03",
  "M04",
  "M05",
  "M06",
  "M07",
  "M08",
  "M09",
  "M10",
  "M11",
  "M12",
  "M13",
  "M14",
  "M15",
  "M16",
  "M17",
  "M18",
  "M19",
  "M20",
  "M21",
  "M22",
  "M23",
  "M24",
] as const

export type BlueprintModuleId = (typeof blueprintModuleIds)[number]

export type BlueprintModuleDefinition = {
  id: BlueprintModuleId
  name: string
  primaryHref: string
}

export const blueprintModuleCatalog: Record<
  BlueprintModuleId,
  BlueprintModuleDefinition
> = {
  M01: {
    id: "M01",
    name: "Organization, projects, users, and access",
    primaryHref: "/settings?pane=company",
  },
  M02: {
    id: "M02",
    name: "Company, project, and platform configuration",
    primaryHref: "/settings?pane=operations-setup",
  },
  M03: {
    id: "M03",
    name: "Customer and property CRM",
    primaryHref: "/customers?module=properties",
  },
  M04: {
    id: "M04",
    name: "Shared collection points and shared services",
    primaryHref: "/customers?module=shared",
  },
  M05: {
    id: "M05",
    name: "Products, contracts, services, and pricing",
    primaryHref: "/commercial?module=products",
  },
  M06: {
    id: "M06",
    name: "Containers, assets, and IoT devices",
    primaryHref: "/resources?module=containers",
  },
  M07: {
    id: "M07",
    name: "Inventory and warehouses",
    primaryHref: "/resources?module=inventory",
  },
  M08: {
    id: "M08",
    name: "Fleet, drivers, depots, and workforce capacity",
    primaryHref: "/fleet",
  },
  M09: {
    id: "M09",
    name: "Collection calendars, route schemes, and operational master data",
    primaryHref: "/route-studio?module=schemes",
  },
  M10: {
    id: "M10",
    name: "Route Studio",
    primaryHref: "/route-studio",
  },
  M11: {
    id: "M11",
    name: "Routes and daily operations",
    primaryHref: "/route-studio?module=routes",
  },
  M12: {
    id: "M12",
    name: "Live Operations",
    primaryHref: "/route-studio?module=live",
  },
  M13: {
    id: "M13",
    name: "Tickets, customer service, and case management",
    primaryHref: "/tickets",
  },
  M14: {
    id: "M14",
    name: "Autopilot and workflow automation",
    primaryHref: "/improve?module=autopilot",
  },
  M15: {
    id: "M15",
    name: "Service providers and haulers",
    primaryHref: "/service-providers",
  },
  M16: {
    id: "M16",
    name: "Billable events, invoicing, credits, and legacy billing",
    primaryHref: "/commercial?module=events",
  },
  M17: {
    id: "M17",
    name: "Alerts, notifications, messages, and communication",
    primaryHref: "/tickets?module=exceptions",
  },
  M18: {
    id: "M18",
    name: "Data, analytics, imports, and exports",
    primaryHref: "/improve?module=analytics",
  },
  M19: {
    id: "M19",
    name: "Intelligence and Insights",
    primaryHref: "/improve?module=intelligence",
  },
  M20: {
    id: "M20",
    name: "Integrations, registries, and external data exchange",
    primaryHref: "/settings?pane=integrations",
  },
  M21: {
    id: "M21",
    name: "Citizen and customer portal",
    primaryHref: "/portal",
  },
  M22: {
    id: "M22",
    name: "Driver and Navigation App",
    primaryHref: "/tickets",
  },
  M23: {
    id: "M23",
    name: "Documents, audit, history, privacy, and compliance",
    primaryHref: "/settings?pane=privacy",
  },
  M24: {
    id: "M24",
    name: "WasteHero control center, sales, subscriptions, and marketplace",
    primaryHref: "/control-center",
  },
}

export type PublicBusinessWorkspaceId =
  | "operate"
  | "plan"
  | "route-studio"
  | "fleet"
  | "customers"
  | "resources"
  | "service-providers"
  | "commercial"
  | "improve"
  | "control-center"

export type PublicWorkspaceDomain = {
  workspaceId: PublicBusinessWorkspaceId
  canonicalPurpose: string
  blueprintModules: BlueprintModuleId[]
  personas: string[]
  moduleIds: string[]
  boundaryNote?: string
}

export type PublicModuleDomain = {
  key: `${PublicBusinessWorkspaceId}.${string}`
  workspaceId: PublicBusinessWorkspaceId
  moduleId: string
  primaryBlueprintModule: BlueprintModuleId
  supportingBlueprintModules: BlueprintModuleId[]
  canonicalOwner: string
  personas: string[]
  upstream: BlueprintModuleId[]
  downstream: BlueprintModuleId[]
  boundaryNote?: string
}

export const publicWorkspaceDomains: readonly PublicWorkspaceDomain[] = [
  {
    workspaceId: "operate",
    canonicalPurpose:
      "Manage customer and operational tickets, triage exceptions, and preserve resolution history.",
    blueprintModules: ["M11", "M13", "M17", "M22", "M23"],
    personas: [
      "Operations manager",
      "Dispatcher",
      "Customer-service agent",
      "Driver",
    ],
    moduleIds: ["tickets", "exceptions", "driver-app"],
    boundaryNote:
      "Tickets owns resolution work and linked communication. Driver App remains available only through its restricted shell.",
  },
  {
    workspaceId: "plan",
    canonicalPurpose:
      "Maintain collection calendars. Route Schemes own recurrence and service days and live in Route Studio; planning geography is managed in Settings → Areas & Zones.",
    blueprintModules: ["M09", "M23"],
    personas: ["Route planner", "Operations administrator"],
    moduleIds: ["calendars"],
    boundaryNote:
      "Areas & Zones moved to Settings 2026-09-03 (configure.areas, D37) — Plan consumes planning geography without owning it; Service providers owns Service Areas and their awards. Pickup Settings, Collection Weeks, and Collection Calendar Days are retired — Route Schemes own recurrence. Collection Deviations were removed 2026-09-03 — holiday and non-working dates are skipped at generation, never moved.",
  },
  {
    workspaceId: "route-studio",
    canonicalPurpose:
      "Monitor live service, maintain recurring route schemes, manage dated routes and their generated Pickups, and control route weights.",
    blueprintModules: ["M09", "M11", "M12", "M23"],
    personas: [
      "Route planner",
      "Operations manager",
      "Dispatcher",
      "Compliance manager",
    ],
    moduleIds: ["live", "schemes", "routes", "pickups", "weights"],
    boundaryNote:
      "Live Operations owns current execution state. Route Schemes are recurring master data; every dated Route generates its Pickups, whose outcomes and proof stay on those same records.",
  },
  {
    workspaceId: "fleet",
    canonicalPurpose:
      "Maintain vehicles, drivers, compatibility, availability, and planned allocation.",
    blueprintModules: ["M08"],
    personas: ["Fleet manager", "Dispatcher", "Route planner", "Service provider manager"],
    moduleIds: ["vehicles", "drivers", "vehicle-planning"],
    boundaryNote:
      "Keep the three top-level Fleet tabs. Depot management is a subordinate Fleet planning capability, while unloading destinations are route master data.",
  },
  {
    workspaceId: "customers",
    canonicalPurpose:
      "Maintain customers, service properties, relationships, agreements, shared services, and customer communication.",
    blueprintModules: ["M03", "M04", "M17", "M21"],
    personas: [
      "Customer-service agent",
      "Contract manager",
      "Operations administrator",
      "Finance specialist",
    ],
    moduleIds: [
      "properties",
      "groups",
      "shared",
      "contacts",
      "agreements",
      "citizen-portal",
    ],
    boundaryNote:
      "Customer, Property, Contact, Payer, and Project remain different records even when shown in one contextual workspace.",
  },
  {
    workspaceId: "resources",
    canonicalPurpose:
      "Control physical service assets, individually tracked units, stock, and warehouses.",
    blueprintModules: ["M06", "M07", "M08"],
    personas: ["Asset manager", "Warehouse staff", "Technician", "Operations planner"],
    moduleIds: ["containers", "inventory", "warehouses", "depots"],
    boundaryNote:
      "Resources should become Assets & Inventory. Depot records belong to Fleet; warehouses remain separate even when colocated.",
  },
  {
    workspaceId: "service-providers",
    canonicalPurpose:
      "Manage service provider companies, awarded service areas, and operational service provider activity.",
    blueprintModules: ["M15"],
    personas: [
      "Office contract manager",
      "Operations manager",
      "Service provider manager",
      "Service provider foreman",
    ],
    moduleIds: [
      "service-providers",
      "service-areas",
      "activities",
      "service-provider-workspace",
    ],
    boundaryNote:
      "Office service provider management is separate from the restricted service provider application and from confidential settlement processing.",
  },
  {
    workspaceId: "commercial",
    canonicalPurpose:
      "Define sellable services and prices, manage settlement, and convert service into traceable financial records.",
    blueprintModules: ["M05", "M15", "M16"],
    personas: [
      "Contract and pricing manager",
      "Finance specialist",
      "Billing administrator",
      "Service provider manager",
    ],
    moduleIds: [
      "products",
      "price-rows",
      "service-provider-prices",
      "settlements",
      "events",
      "billing",
      "invoices",
    ],
    boundaryNote:
      "The service provider workspace must be a restricted shell, not another tab inside the full office Commercial workspace.",
  },
  {
    workspaceId: "improve",
    canonicalPurpose:
      "Analyze trusted data, automate within explicit authority, and exchange governed data.",
    blueprintModules: ["M14", "M18", "M19", "M20", "M23"],
    personas: [
      "Analyst",
      "Compliance manager",
      "Process owner",
      "Data administrator",
      "Integration owner",
    ],
    moduleIds: ["intelligence", "analytics", "autopilot", "imports", "performance", "compliance"],
    boundaryNote:
      "Report and Trust are nested Intelligence areas; general audit, privacy, and compliance remain cross-cutting M23 responsibilities.",
  },
  {
    workspaceId: "control-center",
    canonicalPurpose:
      "Support WasteHero sales, onboarding, entitlement administration, and fulfillment.",
    blueprintModules: ["M24"],
    personas: [
      "WasteHero sales",
      "WasteHero onboarding",
      "WasteHero support",
      "WasteHero fulfillment",
    ],
    moduleIds: ["control-center"],
    boundaryNote:
      "Control Center is an internal application boundary. Tenant administrators receive only explicitly authorized self-service views.",
  },
]

export const publicModuleDomains: readonly PublicModuleDomain[] = [
  {
    key: "route-studio.live",
    workspaceId: "route-studio",
    moduleId: "live",
    primaryBlueprintModule: "M12",
    supportingBlueprintModules: ["M09", "M11", "M17", "M23"],
    canonicalOwner: "Route Studio · Live Operations",
    personas: ["Dispatcher", "Operations manager", "Route planner"],
    upstream: ["M01", "M02", "M08", "M09", "M11", "M15", "M20", "M23"],
    downstream: ["M11", "M13", "M16", "M17", "M18", "M22", "M23"],
    boundaryNote:
      "Live Operations consumes actual execution records; it must not silently replace planned assignment or Route Scheme truth.",
  },
  {
    key: "route-studio.routes",
    workspaceId: "route-studio",
    moduleId: "routes",
    primaryBlueprintModule: "M11",
    supportingBlueprintModules: ["M09", "M22", "M23"],
    canonicalOwner: "Route Studio · Routes",
    personas: ["Operations manager", "Dispatcher", "Driver", "Customer-service agent"],
    upstream: ["M01", "M03", "M05", "M06", "M08", "M09", "M10", "M15"],
    downstream: ["M12", "M13", "M16", "M17", "M18", "M22", "M23"],
    boundaryNote:
      "A Route is a dated executable record, not a Project or Route Scheme.",
  },
  {
    key: "operate.exceptions",
    workspaceId: "operate",
    moduleId: "exceptions",
    primaryBlueprintModule: "M17",
    supportingBlueprintModules: ["M12", "M13", "M19"],
    canonicalOwner: "Operate · Exceptions & Alerts",
    personas: ["Dispatcher", "Operations manager", "Customer-service agent"],
    upstream: ["M02", "M06", "M08", "M11", "M12", "M19", "M20", "M22"],
    downstream: ["M13", "M14", "M16", "M17", "M18", "M23"],
    boundaryNote:
      "An Alert owns attention and acknowledgement; a Ticket owns resolution work.",
  },
  {
    key: "operate.tickets",
    workspaceId: "operate",
    moduleId: "tickets",
    primaryBlueprintModule: "M13",
    supportingBlueprintModules: ["M14", "M17", "M23"],
    canonicalOwner: "Operate · Tickets",
    personas: [
      "Customer-service agent",
      "Operations user",
      "Driver",
      "Service provider user",
      "Citizen",
    ],
    upstream: ["M01", "M02", "M03", "M04", "M06", "M11", "M12", "M17", "M21", "M22"],
    downstream: ["M07", "M11", "M14", "M16", "M17", "M18", "M23"],
    boundaryNote:
      "Customer messages, internal comments, Alerts, and Tickets are separate records connected through explicit relationships.",
  },
  {
    key: "route-studio.pickups",
    workspaceId: "route-studio",
    moduleId: "pickups",
    primaryBlueprintModule: "M11",
    supportingBlueprintModules: ["M23"],
    canonicalOwner: "Route Studio · Pickups",
    personas: ["Operations manager", "Customer-service agent", "Compliance manager"],
    upstream: ["M03", "M06", "M09", "M11", "M15", "M22", "M23"],
    downstream: ["M13", "M16", "M18", "M19", "M23"],
    boundaryNote:
      "Every Pickup is generated as a Route stop and remains the same record as planning becomes execution outcome and proof.",
  },
  {
    key: "route-studio.weights",
    workspaceId: "route-studio",
    moduleId: "weights",
    primaryBlueprintModule: "M11",
    supportingBlueprintModules: ["M16", "M20", "M23"],
    canonicalOwner: "Route Studio · Weight Control",
    personas: ["Operations manager", "Dispatcher", "Finance specialist"],
    upstream: ["M02", "M08", "M09", "M11", "M15", "M20", "M22"],
    downstream: ["M13", "M16", "M18", "M19", "M23"],
    boundaryNote:
      "Weight control validates execution evidence; financial eligibility remains owned by Billable Events.",
  },
  {
    key: "operate.driver-app",
    workspaceId: "operate",
    moduleId: "driver-app",
    primaryBlueprintModule: "M22",
    supportingBlueprintModules: ["M11", "M17", "M23"],
    canonicalOwner: "Driver application",
    personas: ["Driver", "Service provider driver"],
    upstream: ["M01", "M02", "M03", "M08", "M11", "M15", "M17", "M20", "M23"],
    downstream: ["M11", "M12", "M13", "M16", "M17", "M18", "M23"],
    boundaryNote:
      "The driver application is a restricted mobile shell and must not expose the office Operate navigation.",
  },
  {
    key: "route-studio.schemes",
    workspaceId: "route-studio",
    moduleId: "schemes",
    primaryBlueprintModule: "M09",
    supportingBlueprintModules: ["M15", "M23"],
    canonicalOwner: "Route Studio · Route Schemes",
    personas: ["Route planner", "Operations administrator"],
    upstream: ["M02", "M03", "M04", "M05", "M06", "M08", "M15"],
    downstream: ["M10", "M11", "M12", "M17", "M18", "M22", "M23"],
    boundaryNote:
      "A Route Scheme is effective-dated recurring master data; editing it never changes historic Routes.",
  },
  {
    key: "plan.calendars",
    workspaceId: "plan",
    moduleId: "calendars",
    primaryBlueprintModule: "M09",
    supportingBlueprintModules: ["M17", "M21"],
    canonicalOwner: "Plan · Collection Calendars",
    personas: ["Route planner", "Operations administrator", "Customer-service agent"],
    upstream: ["M02", "M03", "M04", "M05"],
    downstream: ["M09", "M10", "M11", "M17", "M21", "M23"],
    boundaryNote:
      "Settings owns working-calendar defaults; Plan owns effective calendar records — working days, holidays, and validity. Holiday and non-working dates are skipped at generation, never moved.",
  },
  {
    key: "fleet.vehicles",
    workspaceId: "fleet",
    moduleId: "vehicles",
    primaryBlueprintModule: "M08",
    supportingBlueprintModules: ["M15", "M20"],
    canonicalOwner: "Fleet · Vehicles",
    personas: ["Fleet manager", "Dispatcher", "Route planner", "Service provider manager"],
    upstream: ["M01", "M02", "M05", "M15", "M20", "M23"],
    downstream: ["M08", "M09", "M10", "M11", "M12", "M18", "M22"],
    boundaryNote:
      "Vehicle master data is distinct from planned allocation, actual Route assignment, and live telemetry.",
  },
  {
    key: "fleet.drivers",
    workspaceId: "fleet",
    moduleId: "drivers",
    primaryBlueprintModule: "M08",
    supportingBlueprintModules: ["M01", "M15", "M22"],
    canonicalOwner: "Fleet · Drivers",
    personas: ["Fleet manager", "Dispatcher", "Route planner", "Service provider manager"],
    upstream: ["M01", "M02", "M15", "M23"],
    downstream: ["M08", "M09", "M11", "M12", "M18", "M22", "M23"],
    boundaryNote:
      "Driver is a workforce profile linked to a User identity; it is not the same record as User or actual assignment.",
  },
  {
    key: "fleet.vehicle-planning",
    workspaceId: "fleet",
    moduleId: "vehicle-planning",
    primaryBlueprintModule: "M08",
    supportingBlueprintModules: ["M09", "M11"],
    canonicalOwner: "Fleet · Vehicle Planning",
    personas: ["Fleet manager", "Dispatcher", "Route planner"],
    upstream: ["M01", "M02", "M08", "M09", "M15", "M23"],
    downstream: ["M09", "M10", "M11", "M12", "M18", "M22"],
    boundaryNote:
      "Vehicle Allocation is planned capacity. Route execution records the actual driver and vehicle separately.",
  },
  {
    key: "customers.properties",
    workspaceId: "customers",
    moduleId: "properties",
    primaryBlueprintModule: "M03",
    supportingBlueprintModules: ["M21", "M23"],
    canonicalOwner: "Customers · Properties",
    personas: ["Customer-service agent", "Contract manager", "Operations user", "Finance user"],
    upstream: ["M01", "M02", "M20", "M23"],
    downstream: ["M03", "M04", "M05", "M06", "M09", "M11", "M13", "M16", "M21"],
    boundaryNote:
      "Property is a physical service location. Customer, owner, tenant, payer, contact, and Project remain separate relationships.",
  },
  {
    key: "customers.groups",
    workspaceId: "customers",
    moduleId: "groups",
    primaryBlueprintModule: "M03",
    supportingBlueprintModules: ["M04"],
    canonicalOwner: "Customers · Property Groups",
    personas: ["Customer-service agent", "Contract manager", "Operations administrator"],
    upstream: ["M01", "M02", "M03"],
    downstream: ["M03", "M05", "M09", "M13", "M18", "M21"],
    boundaryNote:
      "A Property Group is an administrative or service grouping; it is not a Shared Collection Point.",
  },
  {
    key: "customers.shared",
    workspaceId: "customers",
    moduleId: "shared",
    primaryBlueprintModule: "M04",
    supportingBlueprintModules: ["M03", "M21"],
    canonicalOwner: "Customers · Shared Collection Points",
    personas: ["Customer-service agent", "Operations user", "Contract manager"],
    upstream: ["M02", "M03", "M05", "M06"],
    downstream: ["M06", "M09", "M11", "M13", "M16", "M17", "M21"],
    boundaryNote:
      "Membership, service use, authorization, and billing responsibility are separate relationships.",
  },
  {
    key: "customers.contacts",
    workspaceId: "customers",
    moduleId: "contacts",
    primaryBlueprintModule: "M03",
    supportingBlueprintModules: ["M17", "M21"],
    canonicalOwner: "Customers · Contacts & Companies",
    personas: ["Customer-service agent", "Contract manager", "Finance user"],
    upstream: ["M01", "M02", "M20", "M23"],
    downstream: ["M03", "M04", "M13", "M16", "M17", "M21"],
    boundaryNote:
      "Communication preference, legal authorization, customer role, and portal access are separate concerns.",
  },
  {
    key: "customers.agreements",
    workspaceId: "customers",
    moduleId: "agreements",
    primaryBlueprintModule: "M03",
    supportingBlueprintModules: ["M05", "M16"],
    canonicalOwner: "Customers · Agreements & Subscriptions",
    personas: [
      "Contract manager",
      "Customer-service agent",
      "Operations administrator",
      "Finance specialist",
    ],
    upstream: ["M01", "M02", "M03", "M05", "M06"],
    downstream: ["M06", "M09", "M11", "M13", "M16", "M18", "M21"],
    boundaryNote:
      "The customer Agreement instance lives in Customers; Product and Price master data live in Commercial.",
  },
  {
    key: "customers.citizen-portal",
    workspaceId: "customers",
    moduleId: "citizen-portal",
    primaryBlueprintModule: "M21",
    supportingBlueprintModules: ["M03", "M13", "M17"],
    canonicalOwner: "Citizen and customer portal",
    personas: ["Citizen", "Property user", "Portal administrator", "Customer-service agent"],
    upstream: ["M01", "M02", "M03", "M04", "M06", "M09", "M13", "M16", "M17", "M23"],
    downstream: ["M13", "M17", "M18", "M23"],
    boundaryNote:
      "The citizen portal is a separate restricted shell; the Customers tab is the office-side activity and support view.",
  },
  {
    key: "resources.containers",
    workspaceId: "resources",
    moduleId: "containers",
    primaryBlueprintModule: "M06",
    supportingBlueprintModules: ["M07", "M20"],
    canonicalOwner: "Resources · Containers & Assets",
    personas: ["Asset manager", "Operations user", "Customer-service agent", "Technician"],
    upstream: ["M02", "M03", "M04", "M05", "M07", "M20"],
    downstream: ["M07", "M09", "M11", "M13", "M16", "M18", "M19", "M21"],
    boundaryNote:
      "An individually tracked Asset is not an Inventory balance or Stock Movement.",
  },
  {
    key: "resources.inventory",
    workspaceId: "resources",
    moduleId: "inventory",
    primaryBlueprintModule: "M07",
    supportingBlueprintModules: ["M06", "M23"],
    canonicalOwner: "Resources · Inventory",
    personas: ["Warehouse staff", "Asset manager", "Operations planner", "Technician"],
    upstream: ["M02", "M05", "M06", "M20"],
    downstream: ["M06", "M09", "M11", "M13", "M14", "M18", "M24"],
    boundaryNote:
      "Inventory balances are calculated read models. Append-only Stock Movements are the auditable source.",
  },
  {
    key: "resources.warehouses",
    workspaceId: "resources",
    moduleId: "warehouses",
    primaryBlueprintModule: "M07",
    supportingBlueprintModules: ["M06", "M23"],
    canonicalOwner: "Resources · Warehouses",
    personas: ["Warehouse staff", "Asset manager", "Operations planner"],
    upstream: ["M01", "M02", "M06"],
    downstream: ["M06", "M07", "M09", "M11", "M18", "M24"],
    boundaryNote:
      "A Warehouse controls stock. A Depot controls route resources, even when both share an address.",
  },
  {
    key: "resources.depots",
    workspaceId: "resources",
    moduleId: "depots",
    primaryBlueprintModule: "M08",
    supportingBlueprintModules: ["M09", "M11"],
    canonicalOwner: "Fleet · Depot management and Plan · Unloading destinations",
    personas: ["Fleet manager", "Route planner", "Operations administrator"],
    upstream: ["M01", "M02", "M08", "M15", "M20"],
    downstream: ["M08", "M09", "M10", "M11", "M12", "M18"],
    boundaryNote:
      "The current mixed tab must be split: Depot belongs under Fleet planning; Unloading Station belongs to route operational master data.",
  },
  {
    key: "commercial.products",
    workspaceId: "commercial",
    moduleId: "products",
    primaryBlueprintModule: "M05",
    supportingBlueprintModules: ["M06", "M07"],
    canonicalOwner: "Commercial · Products & Services",
    personas: [
      "Contract and pricing manager",
      "Finance specialist",
      "Customer-service administrator",
      "Operations administrator",
    ],
    upstream: ["M01", "M02", "M06"],
    downstream: ["M03", "M04", "M07", "M09", "M13", "M15", "M16"],
    boundaryNote:
      "A Product is the sellable definition, managed in Settings; its prices are rows in the price-rows module, worked in Price Engine.",
  },
  {
    key: "commercial.price-rows",
    workspaceId: "commercial",
    moduleId: "price-rows",
    primaryBlueprintModule: "M05",
    supportingBlueprintModules: ["M16"],
    canonicalOwner: "Commercial · Price Rows",
    personas: ["Pricing manager", "Finance specialist"],
    upstream: ["M01", "M02", "M03", "M05"],
    downstream: ["M03", "M05", "M15", "M16", "M18", "M23"],
    boundaryNote:
      "One price model: every sellable price (default, variation, negotiated) is a row; the default price is a row with no conditions.",
  },
  {
    key: "commercial.service-provider-prices",
    workspaceId: "commercial",
    moduleId: "service-provider-prices",
    primaryBlueprintModule: "M15",
    supportingBlueprintModules: ["M05", "M23"],
    canonicalOwner: "Commercial · Service Provider Prices",
    personas: ["Office contract manager", "Finance specialist", "Service provider manager"],
    upstream: ["M05", "M08", "M15"],
    downstream: ["M15", "M18", "M20", "M23"],
    boundaryNote:
      "The bid is contractually immutable; indexation changes only the current fee. Service Provider Price and Settlement remain separate records.",
  },
  {
    key: "service-providers.service-providers",
    workspaceId: "service-providers",
    moduleId: "service-providers",
    primaryBlueprintModule: "M15",
    supportingBlueprintModules: ["M08", "M09", "M23"],
    canonicalOwner: "Service Providers · Companies",
    personas: ["Office contract manager", "Operations manager"],
    upstream: ["M01", "M02", "M05", "M08", "M09", "M20", "M23"],
    downstream: ["M08", "M09", "M10", "M11", "M12", "M13", "M15", "M18"],
    boundaryNote:
      "Service provider companies are distinct from their effective-dated Service Area awards.",
  },
  {
    key: "service-providers.service-areas",
    workspaceId: "service-providers",
    moduleId: "service-areas",
    primaryBlueprintModule: "M15",
    supportingBlueprintModules: ["M08", "M09", "M23"],
    canonicalOwner: "Service Providers · Service Areas",
    personas: ["Office contract manager", "Operations manager"],
    upstream: ["M01", "M02", "M05", "M08", "M09", "M20", "M23"],
    downstream: ["M08", "M09", "M10", "M11", "M12", "M13", "M15", "M18"],
    boundaryNote:
      "Service Providers owns awarded Service Areas; Plan consumes responsibility without owning the commercial award.",
  },
  {
    key: "service-providers.activities",
    workspaceId: "service-providers",
    moduleId: "activities",
    primaryBlueprintModule: "M15",
    supportingBlueprintModules: ["M08", "M11", "M13", "M23"],
    canonicalOwner: "Service Providers · Activities",
    personas: ["Office contract manager", "Operations manager", "Service provider manager"],
    upstream: ["M08", "M09", "M11", "M13", "M15", "M17", "M23"],
    downstream: ["M11", "M13", "M15", "M18", "M23"],
    boundaryNote:
      "Activities link operational assignments, proposals, compliance, and follow-up without replacing their source records.",
  },
  {
    key: "service-providers.service-provider-workspace",
    workspaceId: "service-providers",
    moduleId: "service-provider-workspace",
    primaryBlueprintModule: "M15",
    supportingBlueprintModules: ["M08", "M11", "M13"],
    canonicalOwner: "Restricted service provider application",
    personas: ["Service provider manager", "Service provider foreman"],
    upstream: ["M01", "M08", "M09", "M11", "M13", "M15", "M17", "M23"],
    downstream: ["M08", "M11", "M13", "M15", "M17", "M18", "M23"],
    boundaryNote:
      "This must not expose unrelated service providers, customer prices, office billing, or office structural controls.",
  },
  {
    key: "commercial.settlements",
    workspaceId: "commercial",
    moduleId: "settlements",
    primaryBlueprintModule: "M15",
    supportingBlueprintModules: ["M05", "M23"],
    canonicalOwner: "Commercial · Service Provider Prices & Settlements",
    personas: ["Office contract manager", "Finance specialist", "Service provider manager"],
    upstream: ["M05", "M08", "M11", "M13", "M15", "M18"],
    downstream: ["M15", "M18", "M20", "M23"],
    boundaryNote:
      "Service Provider Price and Settlement are separate records. Closing Settlement freezes a reproducible period snapshot.",
  },
  {
    key: "commercial.events",
    workspaceId: "commercial",
    moduleId: "events",
    primaryBlueprintModule: "M16",
    supportingBlueprintModules: ["M05", "M11"],
    canonicalOwner: "Commercial · Billable Events",
    personas: ["Finance specialist", "Contract manager", "Billing administrator"],
    upstream: ["M02", "M03", "M05", "M11", "M13", "M20"],
    downstream: ["M16", "M18", "M20", "M23"],
    boundaryNote:
      "A Billable Event is traceable service eligibility, not an Invoice line until a Billing Run selects it.",
  },
  {
    key: "commercial.billing",
    workspaceId: "commercial",
    moduleId: "billing",
    primaryBlueprintModule: "M16",
    supportingBlueprintModules: ["M20", "M23"],
    canonicalOwner: "Commercial · Scheduled Billing & Billing Runs",
    personas: ["Finance specialist", "Billing administrator"],
    upstream: ["M02", "M03", "M05", "M16"],
    downstream: ["M16", "M17", "M18", "M20", "M23"],
    boundaryNote:
      "Scheduled Billing configuration and the executed Billing Run are different records; every excluded customer requires a result reason.",
  },
  {
    key: "commercial.invoices",
    workspaceId: "commercial",
    moduleId: "invoices",
    primaryBlueprintModule: "M16",
    supportingBlueprintModules: ["M17", "M20", "M23"],
    canonicalOwner: "Commercial · Invoices & Credit Notes",
    personas: ["Finance specialist", "Billing administrator", "Customer-service agent"],
    upstream: ["M02", "M03", "M05", "M16"],
    downstream: ["M17", "M18", "M20", "M21", "M23"],
    boundaryNote:
      "Invoice and Credit Note are immutable issued-document types with explicit correction relationships.",
  },
  {
    key: "improve.intelligence",
    workspaceId: "improve",
    moduleId: "intelligence",
    primaryBlueprintModule: "M19",
    supportingBlueprintModules: ["M17", "M18", "M23"],
    canonicalOwner: "Improve · Intelligence · Ask, Monitor, Report, Trust",
    personas: [
      "Analyst",
      "Compliance manager",
      "Operations manager",
      "Finance user",
      "Metric owner",
    ],
    upstream: ["M01", "M17", "M18", "M20", "M23"],
    downstream: ["M10", "M12", "M13", "M14", "M17", "M18", "M20", "M23"],
    boundaryNote:
      "Ask, Monitor, Report, and Trust are nested areas. AI may propose actions but cannot silently mutate production.",
  },
  {
    key: "improve.analytics",
    workspaceId: "improve",
    moduleId: "analytics",
    primaryBlueprintModule: "M18",
    supportingBlueprintModules: ["M19"],
    canonicalOwner: "Improve · Analytics & Dashboards",
    personas: ["Analyst", "Operations manager", "Fleet manager", "Finance specialist"],
    upstream: ["M01", "M03", "M06", "M08", "M11", "M13", "M15", "M16", "M20", "M23"],
    downstream: ["M10", "M12", "M14", "M15", "M19", "M23"],
    boundaryNote:
      "Classic dashboards remain beside Intelligence until metric and workflow parity is confirmed.",
  },
  {
    key: "improve.autopilot",
    workspaceId: "improve",
    moduleId: "autopilot",
    primaryBlueprintModule: "M14",
    supportingBlueprintModules: ["M13", "M17", "M19", "M23"],
    canonicalOwner: "Improve · Autopilot",
    personas: [
      "Process owner",
      "Operations manager",
      "Customer-service leader",
      "Administrator",
    ],
    upstream: ["M01", "M02", "M11", "M13", "M17", "M18", "M19", "M23"],
    downstream: ["M11", "M13", "M17", "M18", "M23"],
    boundaryNote:
      "Suggestion, Approval, registered Action, Execution, and Impact are separate records. Legacy rules require explicit ownership.",
  },
  {
    key: "improve.imports",
    workspaceId: "improve",
    moduleId: "imports",
    primaryBlueprintModule: "M18",
    supportingBlueprintModules: ["M20", "M23"],
    canonicalOwner: "Improve · Data Exchange & Job Center",
    personas: ["Data administrator", "Integration owner", "Analyst", "Finance specialist"],
    upstream: ["M01", "M02", "M20", "M23"],
    downstream: [
      "M03",
      "M05",
      "M06",
      "M07",
      "M09",
      "M11",
      "M16",
      "M18",
      "M20",
      "M23",
    ],
    boundaryNote:
      "Settings owns connection credentials and mappings; the Job Center owns runs, row errors, results, retries, and delivery receipts.",
  },
  {
    key: "improve.performance",
    workspaceId: "improve",
    moduleId: "performance",
    primaryBlueprintModule: "M18",
    supportingBlueprintModules: ["M19", "M23"],
    canonicalOwner: "Improve · Performance & Compliance",
    personas: ["Analyst", "Compliance manager", "Operations manager", "Privacy officer"],
    upstream: ["M08", "M11", "M13", "M15", "M16", "M18", "M20", "M23"],
    downstream: ["M10", "M12", "M14", "M15", "M19", "M23"],
    boundaryNote:
      "Performance scorecards consume governed metrics; privacy policy and immutable audit remain M23.",
  },
  {
    key: "improve.compliance",
    workspaceId: "improve",
    moduleId: "compliance",
    primaryBlueprintModule: "M19",
    supportingBlueprintModules: ["M18", "M23"],
    canonicalOwner: "Improve · Intelligence · Report & Trust",
    personas: ["Analyst", "Compliance manager", "Metric owner", "Report recipient"],
    upstream: ["M18", "M20", "M23"],
    downstream: ["M17", "M18", "M20", "M23"],
    boundaryNote:
      "The current top-level Reports & Trust tab duplicates Intelligence. It should become nested Report and Trust areas.",
  },
  {
    key: "control-center.control-center",
    workspaceId: "control-center",
    moduleId: "control-center",
    primaryBlueprintModule: "M24",
    supportingBlueprintModules: ["M01", "M07", "M16", "M23"],
    canonicalOwner: "WasteHero internal Control Center",
    personas: [
      "WasteHero sales",
      "WasteHero onboarding",
      "WasteHero support",
      "WasteHero fulfillment",
      "Authorized tenant administrator",
    ],
    upstream: ["M01", "M02", "M05", "M07", "M16", "M20", "M23"],
    downstream: ["M01", "M02", "M07", "M16", "M20", "M23"],
    boundaryNote:
      "Internal customer administration, tenant self-service, and marketplace fulfillment require separate permission boundaries and typed records.",
  },
]

/**
 * Modules whose records are real business records — a form schema, a record
 * store bucket, relation targets — but whose management surface is Settings
 * rather than a public workspace. They are registered under the `configure`
 * workspace (the registry twin of Settings: business-links resolves its
 * modules to `/settings?pane=…`) and rendered by the named Settings pane. The
 * schema registry's lockstep gate counts these keys as expected.
 *
 * Areas & Zones moved here from Plan on 2026-09-03 (D37).
 */
export type SettingsModuleDomain = {
  key: `configure.${string}`
  workspaceId: "configure"
  moduleId: string
  /** The SettingsDialog pane that renders the module. */
  settingsPaneId: string
  primaryBlueprintModule: BlueprintModuleId
  supportingBlueprintModules: BlueprintModuleId[]
  canonicalOwner: string
  personas: string[]
  upstream: BlueprintModuleId[]
  downstream: BlueprintModuleId[]
  boundaryNote?: string
}

export const settingsModuleDomains: readonly SettingsModuleDomain[] = [
  {
    key: "configure.areas",
    workspaceId: "configure",
    moduleId: "areas",
    settingsPaneId: "areas",
    primaryBlueprintModule: "M09",
    supportingBlueprintModules: ["M02", "M15"],
    canonicalOwner: "Settings · Areas & Zones",
    personas: ["Operations administrator", "Route planner", "Contract manager"],
    upstream: ["M01", "M02", "M03", "M15", "M20"],
    downstream: ["M09", "M10", "M11", "M12", "M15", "M17", "M18"],
    boundaryNote:
      "Settings owns operational planning and notification geography as master data; Plan and Route Studio consume it. Service providers owns Service Areas awarded to service providers.",
  },
]

export function getPublicModuleDomain(
  workspaceId: PublicBusinessWorkspaceId,
  moduleId: string,
): PublicModuleDomain | undefined {
  return publicModuleDomains.find(
    (assignment) =>
      assignment.workspaceId === workspaceId && assignment.moduleId === moduleId,
  )
}

export function getPublicWorkspaceDomain(
  workspaceId: PublicBusinessWorkspaceId,
): PublicWorkspaceDomain | undefined {
  return publicWorkspaceDomains.find(
    (assignment) => assignment.workspaceId === workspaceId,
  )
}
