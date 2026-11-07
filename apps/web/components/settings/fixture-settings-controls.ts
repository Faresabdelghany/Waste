// The fixtures' Settings form: the controls of the panes whose values only
// this browser keeps (SETTINGS_STORAGE_KEY), which nothing reads (#487), so
// fixture mode alone offers them. Each pane's title and description are the
// Settings table's (lib/data/settings-panes.ts); these are its groups.
import type { SettingsPaneId } from "@/lib/data/settings-panes"

type ControlBase = {
  id: string
  label: string
  description: string
  scope: "Personal" | "Company" | "Project" | "Platform"
}

export type SettingControl = ControlBase &
  (
    | { type: "input"; value: string; inputType?: "email" }
    | { type: "select"; value: string; options: Array<{ value: string; label: string }> }
    | { type: "switch"; checked: boolean }
    | { type: "status"; value: string; tone: "healthy" | "warning" | "danger" | "neutral" }
    /** A line read, not set: what the API holds and no control here writes. */
    | { type: "text"; value: string }
  )

export type SettingsGroup = { id?: string; title: string; controls: SettingControl[] }

const ACCOUNT: SettingsGroup[] = [
  {
    id: "profile",
    title: "Profile",
    controls: [
      {
        id: "account-name",
        label: "Full name",
        description: "Shown in assignments, approvals, comments, and audit history.",
        scope: "Personal",
        type: "input",
        value: "Olivia Larsen",
      },
      {
        id: "account-email",
        label: "Email address",
        description: "Used for authentication and configured notification delivery.",
        scope: "Personal",
        type: "input",
        inputType: "email",
        value: "olivia.larsen@kystbyen.example",
      },
      {
        id: "account-role",
        label: "Primary role",
        description: "Your effective permissions still depend on explicit project grants.",
        scope: "Personal",
        type: "status",
        value: "Operations Manager · 3 projects",
        tone: "healthy",
      },
    ],
  },
  {
    id: "defaults",
    title: "Defaults",
    controls: [
      {
        id: "account-project",
        label: "Default project",
        description: "Opened after sign-in; this does not change your permitted project scope.",
        scope: "Personal",
        type: "select",
        value: "copenhagen",
        options: [
          { value: "copenhagen", label: "Copenhagen Central" },
          { value: "harbor", label: "Harbor Commercial" },
          { value: "last", label: "Last opened project" },
        ],
      },
      {
        id: "account-layout",
        label: "Default operations view",
        description: "Choose the first view used in Operate.",
        scope: "Personal",
        type: "select",
        value: "live",
        options: [
          { value: "live", label: "Live Operations" },
          { value: "routes", label: "Routes" },
          { value: "tickets", label: "Tickets" },
        ],
      },
      {
        id: "account-saved",
        label: "Remember filters and layouts",
        description: "Save project-specific filters, table columns, and map layout.",
        scope: "Personal",
        type: "switch",
        checked: true,
      },
    ],
  },
]

const NOTIFICATIONS: SettingsGroup[] = [
  {
    title: "Operational attention",
    controls: [
      {
        id: "notify-critical",
        label: "Critical route and vehicle alerts",
        description: "In-app and push notifications for critical assigned operations.",
        scope: "Personal",
        type: "switch",
        checked: true,
      },
      {
        id: "notify-approvals",
        label: "Approval requests",
        description: "Plans, service provider proposals, automation actions, and protected changes awaiting your decision.",
        scope: "Personal",
        type: "switch",
        checked: true,
      },
      {
        id: "notify-ticket",
        label: "Ticket SLA warnings",
        description: "Notify before an owned or team ticket breaches its response target.",
        scope: "Personal",
        type: "select",
        value: "30",
        options: [
          { value: "15", label: "15 minutes before" },
          { value: "30", label: "30 minutes before" },
          { value: "60", label: "1 hour before" },
          { value: "off", label: "Off" },
        ],
      },
    ],
  },
  {
    title: "Digests and reports",
    controls: [
      {
        id: "notify-digest",
        label: "Daily operations digest",
        description: "Routes, exceptions, tickets, stale resources, and recovery outcomes.",
        scope: "Personal",
        type: "select",
        value: "0600",
        options: [
          { value: "0600", label: "06:00 local time" },
          { value: "0700", label: "07:00 local time" },
          { value: "off", label: "Off" },
        ],
      },
      {
        id: "notify-failed",
        label: "Failed integrations and messages",
        description: "Email when owned integrations or customer messages require retry.",
        scope: "Personal",
        type: "switch",
        checked: true,
      },
    ],
  },
]

const CALENDARS: SettingsGroup[] = [
  {
    title: "Working calendar",
    controls: [
      {
        id: "calendar-week",
        label: "Week numbering system",
        description: "Default week interpretation for calendars and planning views; Route Schemes own recurrence.",
        scope: "Project",
        type: "select",
        value: "iso",
        options: [
          { value: "iso", label: "ISO weeks · Monday start" },
          { value: "custom", label: "Custom week numbering" },
        ],
      },
    ],
  },
]

const MASTER_DATA: SettingsGroup[] = [
  {
    title: "Master-data managers",
    controls: [
      {
        id: "master-fractions",
        label: "Waste fractions",
        description: "24 records · regulatory mappings · vehicle, product, and route dependencies.",
        scope: "Company",
        type: "status",
        value: "Version 18 · effective",
        tone: "healthy",
      },
      {
        id: "master-containers",
        label: "Container types",
        description: "Capacity, dimensions, accepted fractions, stock identity, and compatible service.",
        scope: "Company",
        type: "status",
        value: "42 active types",
        tone: "healthy",
      },
      {
        id: "master-reasons",
        label: "Stop outcome reasons",
        description: "Failure, skip, reschedule, and exception codes used by office and driver app.",
        scope: "Project",
        type: "status",
        value: "18 active · 2 deprecated",
        tone: "warning",
      },
      {
        id: "master-effective",
        label: "Require effective date for protected changes",
        description: "Prevents today’s edits from rewriting historical operational truth.",
        scope: "Company",
        type: "status",
        value: "Enforced",
        tone: "healthy",
      },
    ],
  },
]

const TICKET_COMMS: SettingsGroup[] = [
  {
    title: "Ticket configuration",
    controls: [
      {
        id: "ticket-types",
        label: "Ticket types and categories",
        description: "Type-specific fields, actions, SLA, portal exposure, and automation.",
        scope: "Project",
        type: "status",
        value: "18 active types",
        tone: "healthy",
      },
      {
        id: "ticket-lifecycle",
        label: "Ticket lifecycle",
        description: "Configured transitions for Created, Open, Pending, On hold, In progress, Completed, and Rejected.",
        scope: "Project",
        type: "status",
        value: "Version 6 · active",
        tone: "healthy",
      },
      {
        id: "ticket-comments",
        label: "Separate internal comments",
        description: "Internal comments are never included in customer-visible messages or portal history.",
        scope: "Company",
        type: "status",
        value: "Enforced",
        tone: "healthy",
      },
    ],
  },
  {
    title: "Channels and templates",
    controls: [
      {
        id: "comm-templates",
        label: "Message and notification templates",
        description: "Email, SMS, push, portal, and service-change messages.",
        scope: "Project",
        type: "status",
        value: "42 templates · 3 preview issues",
        tone: "warning",
      },
      {
        id: "comm-email",
        label: "Inbound email routing",
        description: "Connected accounts, matching rules, ticket creation, and unassigned fallback.",
        scope: "Project",
        type: "status",
        value: "3 accounts · healthy",
        tone: "healthy",
      },
      {
        id: "comm-failure",
        label: "Keep failed delivery visible",
        description: "Failed messages remain actionable with retry and delivery history.",
        scope: "Company",
        type: "switch",
        checked: true,
      },
    ],
  },
]

const MAPS: SettingsGroup[] = [
  {
    title: "Map behavior",
    controls: [
      {
        id: "map-provider",
        label: "Base map provider",
        description: "Map tiles and geocoding used by office planning and operations.",
        scope: "Company",
        type: "select",
        value: "mapbox",
        options: [
          { value: "mapbox", label: "Mapbox" },
          { value: "osm", label: "OpenStreetMap" },
          { value: "customer", label: "Customer-provided layers" },
        ],
      },
      {
        id: "map-layers",
        label: "Operational layers",
        description: "Properties, containers, routes, service areas, zones, depots, and facilities.",
        scope: "Project",
        type: "status",
        value: "18 layers · 2 restricted",
        tone: "healthy",
      },
      {
        id: "map-overlap",
        label: "Service area validation",
        description: "Upcoming Østerbro area overlaps an existing responsibility for five properties.",
        scope: "Project",
        type: "status",
        value: "1 overlap",
        tone: "danger",
      },
      {
        id: "map-gps",
        label: "Display location freshness",
        description: "Stale positions always display age and never use a live-state treatment.",
        scope: "Company",
        type: "status",
        value: "Enforced",
        tone: "healthy",
      },
    ],
  },
]

const FINANCE: SettingsGroup[] = [
  {
    title: "Invoice defaults",
    controls: [
      {
        id: "finance-vat",
        label: "Default VAT",
        description: "Project default used when no more specific valid rule applies.",
        scope: "Project",
        type: "select",
        value: "25",
        options: [
          { value: "25", label: "25%" },
          { value: "0", label: "0%" },
          { value: "mixed", label: "Determine by product" },
        ],
      },
      {
        id: "finance-ref",
        label: "Payment reference",
        description: "Reference method printed on issued invoices.",
        scope: "Project",
        type: "select",
        value: "fik71",
        options: [
          { value: "fik71", label: "FIK 71" },
          { value: "ocr", label: "OCR" },
          { value: "customer", label: "Customer-specific" },
        ],
      },
      {
        id: "finance-cadence",
        label: "Default billing cadence",
        description: "Agreements can override when their rules permit.",
        scope: "Project",
        type: "select",
        value: "monthly",
        options: [
          { value: "monthly", label: "Monthly" },
          { value: "quarterly", label: "Quarterly" },
          { value: "manual", label: "Manual" },
        ],
      },
      {
        id: "finance-issued",
        label: "Protect issued documents",
        description: "Corrections require cancellation or full or partial credit instead of silent editing.",
        scope: "Company",
        type: "status",
        value: "Enforced",
        tone: "healthy",
      },
    ],
  },
  {
    title: "Accounting routing",
    controls: [
      {
        id: "finance-centres",
        label: "Cost centres and accounts",
        description: "17 of 18 cost centres are fully mapped.",
        scope: "Company",
        type: "status",
        value: "1 mapping gap",
        tone: "warning",
      },
      {
        id: "finance-skip",
        label: "Report every billing-run exclusion",
        description: "Included, skipped, blocked, and failed customers remain explicit.",
        scope: "Company",
        type: "switch",
        checked: true,
      },
    ],
  },
]

const INTEGRATIONS: SettingsGroup[] = [
  {
    title: "Connection health",
    controls: [
      {
        id: "integration-gps",
        label: "Fleet GPS · Webfleet",
        description: "Inbound vehicle positions · owned by Fleet Team · one stale vehicle.",
        scope: "Project",
        type: "status",
        value: "Degraded · last success 2 min",
        tone: "warning",
      },
      {
        id: "integration-navision",
        label: "Navision Finance",
        description: "Bidirectional accounting export and payment status.",
        scope: "Company",
        type: "status",
        value: "Healthy · last success 04:22",
        tone: "healthy",
      },
      {
        id: "integration-digitalpost",
        label: "Danish Digital Post",
        description: "Outbound messages · client certificate expired · three deliveries waiting.",
        scope: "Project",
        type: "status",
        value: "Failed · credential expired",
        tone: "danger",
      },
      {
        id: "integration-ads",
        label: "Danish ADS waste reporting",
        description: "Scheduled regulatory export with approved mappings and error download.",
        scope: "Project",
        type: "status",
        value: "Healthy · next run 1 Aug",
        tone: "healthy",
      },
    ],
  },
  {
    title: "Operational controls",
    controls: [
      {
        id: "integration-partial",
        label: "Keep partial jobs actionable",
        description: "Show applied, skipped, failed, row-level errors, and retry scope.",
        scope: "Company",
        type: "status",
        value: "Enforced",
        tone: "healthy",
      },
      {
        id: "integration-audit",
        label: "Audit downloads and credential changes",
        description: "Sensitive export and connection actions retain actor, purpose, scope, and time.",
        scope: "Company",
        type: "status",
        value: "Enforced",
        tone: "healthy",
      },
    ],
  },
]

const PORTALS: SettingsGroup[] = [
  {
    title: "Customer-facing identity",
    controls: [
      {
        id: "portal-brand",
        label: "Copenhagen project branding",
        description: "Logo, colors, customer-facing name, service text, documents, and message identity.",
        scope: "Project",
        type: "status",
        value: "Published · version 7",
        tone: "healthy",
      },
      {
        id: "portal-customer",
        label: "Customer portal",
        description: "1,408 authorized users with scoped property and service access.",
        scope: "Project",
        type: "status",
        value: "Published · healthy",
        tone: "healthy",
      },
      {
        id: "portal-driver",
        label: "Driver and Navigation App",
        description: "Assigned routes, navigation, outcome actions, proof, messages, offline sync, and location notice.",
        scope: "Project",
        type: "status",
        value: "Active · 34 drivers",
        tone: "healthy",
      },
      {
        id: "portal-internal",
        label: "Hide internal and restricted information",
        description: "Internal comments, service provider data, financial data, and unrelated routes never enter portal payloads.",
        scope: "Company",
        type: "status",
        value: "Enforced",
        tone: "healthy",
      },
      {
        id: "portal-accessibility",
        label: "Accessibility review before publish",
        description: "Require a preview and accessibility checklist for portal content changes.",
        scope: "Project",
        type: "switch",
        checked: true,
      },
    ],
  },
]

const COMMERCIAL_DEFAULTS: SettingsGroup[] = [
  {
    title: "Company defaults",
    controls: [
      {
        id: "pricing-currency",
        label: "Currency",
        description: "Currency for all product prices and service provider fees.",
        scope: "Company",
        type: "select",
        value: "EUR",
        options: [
          { value: "EUR", label: "EUR" },
          { value: "DKK", label: "DKK" },
        ],
      },
      {
        id: "pricing-default-vat",
        label: "Default VAT rate",
        description: "Prefilled on every new product.",
        scope: "Company",
        type: "input",
        value: "25%",
      },
      {
        id: "pricing-invoice-prefix",
        label: "Invoice code prefix",
        description: "Prepended to suggested invoice codes.",
        scope: "Company",
        type: "input",
        value: "WH-",
      },
    ],
  },
]

/** Each fixture pane's groups. Operations setup gathers the week numbering, the master-data managers and the map's behaviour. */
export const FIXTURE_SETTINGS_GROUPS: Partial<Record<SettingsPaneId, readonly SettingsGroup[]>> = {
  account: ACCOUNT,
  notifications: NOTIFICATIONS,
  "operations-setup": [...CALENDARS, ...MASTER_DATA, ...MAPS],
  "ticket-comms": TICKET_COMMS,
  finance: FINANCE,
  pricing: COMMERCIAL_DEFAULTS,
  integrations: INTEGRATIONS,
  portals: PORTALS,
}

/** What the search finds a fixture pane by beyond its table entry: its groups' and controls' words. */
export function fixtureSettingsTerms(paneId: SettingsPaneId): readonly string[] {
  return (FIXTURE_SETTINGS_GROUPS[paneId] ?? []).flatMap((group) => [group.title, ...group.controls.flatMap((control) => [control.label, control.description])])
}

/** Every control's value as the fixtures set it, before this browser saved any. */
export function fixtureSettingDefaults(): Record<string, string | boolean> {
  return Object.fromEntries(
    Object.values(FIXTURE_SETTINGS_GROUPS).flatMap((groups) =>
      (groups ?? []).flatMap((group) => group.controls.flatMap((control): Array<[string, string | boolean]> => (control.type === "switch" ? [[control.id, control.checked]] : control.type === "status" ? [] : [[control.id, control.value]]))),
    ),
  )
}
