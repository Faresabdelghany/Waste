"use client"

import { useEffect, useMemo, useState, type ComponentType } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Bell,
  CaretLeft,
  CheckCircle,
  CreditCard,
  Gear,
  IdentificationBadge,
  Lightning,
  LinkSimple,
  MagnifyingGlass,
  MapTrifold,
  Package,
  PaintBrush,
  Receipt,
  ShieldCheck,
  SlidersHorizontal,
  SquaresFour,
  Tag,
  UserCircle,
  UsersThree,
  Warning,
} from "@phosphor-icons/react/dist/ssr"

import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { ThemeCustomizer } from "@/components/settings/theme-customizer"
import { OrganizationAccessManagement } from "@/components/settings/organization-access-management"
import { CompanyProjectsManagement } from "@/components/settings/company-projects-management"
import { AssetManagementSettings } from "@/components/settings/asset-management-settings"
import { CommercialDefaultsExtras, CommercialSectionPane } from "@/components/settings/commercial-settings"

type SettingControl =
  | {
      id: string
      label: string
      description: string
      scope: "Personal" | "Company" | "Project" | "Platform"
      type: "input"
      value: string
    }
  | {
      id: string
      label: string
      description: string
      scope: "Personal" | "Company" | "Project" | "Platform"
      type: "select"
      value: string
      options: Array<{ value: string; label: string }>
    }
  | {
      id: string
      label: string
      description: string
      scope: "Personal" | "Company" | "Project" | "Platform"
      type: "switch"
      checked: boolean
    }
  | {
      id: string
      label: string
      description: string
      scope: "Personal" | "Company" | "Project" | "Platform"
      type: "status"
      value: string
      tone: "healthy" | "warning" | "danger" | "neutral"
      action?: string
    }

type SettingsPaneDefinition = {
  title: string
  description: string
  groups: Array<{
    title: string
    controls: SettingControl[]
  }>
}

const settingsSections: Array<{
  id: string
  label: string
  items: Array<{ id: string; label: string; icon: ComponentType<{ className?: string }> }>
}> = [
  {
    id: "personal",
    label: "Personal",
    items: [
      { id: "account", label: "Account & appearance", icon: UserCircle },
      { id: "notifications", label: "Notifications", icon: Bell },
    ],
  },
  {
    id: "organization",
    label: "Organization",
    items: [
      { id: "company", label: "Company & projects", icon: SquaresFour },
      { id: "access", label: "Users & roles", icon: UsersThree },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      { id: "asset-management", label: "Asset management", icon: Gear },
      { id: "operations-setup", label: "Operations setup", icon: SlidersHorizontal },
      { id: "ticket-comms", label: "Tickets & communication", icon: Bell },
    ],
  },
  {
    id: "administration",
    label: "Administration",
    items: [
      { id: "finance", label: "Finance & invoicing", icon: CreditCard },
      { id: "pricing", label: "Commercial defaults", icon: Tag },
      { id: "integrations", label: "Integrations", icon: LinkSimple },
      { id: "portals", label: "Portals & branding", icon: PaintBrush },
      { id: "privacy", label: "Privacy, audit & retention", icon: ShieldCheck },
    ],
  },
  {
    id: "commercial",
    label: "Commercial",
    items: [
      { id: "commercial-products", label: "Products", icon: Package },
      { id: "commercial-price-lists", label: "Price lists", icon: Receipt },
      { id: "commercial-zones", label: "Zones", icon: MapTrifold },
      { id: "commercial-service", label: "Service", icon: Lightning },
      {
        id: "commercial-customer-types",
        label: "Customer types",
        icon: IdentificationBadge,
      },
    ],
  },
]

const paneDefinitions: Record<string, SettingsPaneDefinition> = {
  account: {
    title: "Account",
    description: "Your identity, preferences, project defaults, language, time, and active security context.",
    groups: [
      {
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
            value: "olivia.larsen@wastehero.example",
          },
          {
            id: "account-role",
            label: "Primary role",
            description: "Your effective permissions still depend on explicit project grants.",
            scope: "Personal",
            type: "status",
            value: "Operations Manager · 3 projects",
            tone: "healthy",
            action: "View access summary",
          },
        ],
      },
      {
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
    ],
  },
  notifications: {
    title: "Notifications",
    description: "Personal delivery preferences within the recipient scope configured by administrators.",
    groups: [
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
            description: "Plans, contractor proposals, automation actions, and protected changes awaiting your decision.",
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
    ],
  },
  access: {
    title: "Users, roles, and teams",
    description: "Invitations, explicit project grants, granular permissions, contractor links, sessions, and access history.",
    groups: [
      {
        title: "User access",
        controls: [
          {
            id: "access-users",
            label: "Active users",
            description: "62 office and 22 field users across permitted projects.",
            scope: "Company",
            type: "status",
            value: "84 active · 6 invited",
            tone: "healthy",
            action: "Manage users",
          },
          {
            id: "access-review",
            label: "Access review",
            description: "Two machine or temporary users have broader scope than their current ownership.",
            scope: "Company",
            type: "status",
            value: "2 issues",
            tone: "danger",
            action: "Review now",
          },
          {
            id: "access-default",
            label: "Default invited-user access",
            description: "Company membership never implies project access.",
            scope: "Company",
            type: "select",
            value: "none",
            options: [
              { value: "none", label: "No project access" },
              { value: "selected", label: "Selected project only" },
            ],
          },
        ],
      },
      {
        title: "Roles and teams",
        controls: [
          {
            id: "access-roles",
            label: "Custom roles",
            description: "Versioned permission sets with user and project impact summaries.",
            scope: "Company",
            type: "status",
            value: "12 roles · 284 grants",
            tone: "healthy",
            action: "Edit roles",
          },
          {
            id: "access-teams",
            label: "Assignment teams",
            description: "Teams used for tickets, approvals, operational ownership, and collaboration.",
            scope: "Company",
            type: "status",
            value: "18 active teams",
            tone: "neutral",
            action: "Manage teams",
          },
          {
            id: "access-confirm",
            label: "Confirm destructive access changes",
            description: "Require confirmation, reason, and audit history for deactivation or broad grant removal.",
            scope: "Company",
            type: "status",
            value: "Enforced",
            tone: "healthy",
          },
        ],
      },
    ],
  },
  localization: {
    title: "Localization",
    description: "Language, time zone, dates, numbers, currency, units, and local calendar behavior.",
    groups: [
      {
        title: "Project locale",
        controls: [
          {
            id: "locale-language",
            label: "Office language",
            description: "Default UI and generated-office-document language.",
            scope: "Project",
            type: "select",
            value: "da",
            options: [
              { value: "da", label: "Danish" },
              { value: "en", label: "English" },
              { value: "no", label: "Norwegian" },
              { value: "fi", label: "Finnish" },
            ],
          },
          {
            id: "locale-timezone",
            label: "Time zone",
            description: "Applied to routes, service windows, jobs, billing schedules, and audit display.",
            scope: "Project",
            type: "select",
            value: "copenhagen",
            options: [
              { value: "copenhagen", label: "Europe/Copenhagen" },
              { value: "oslo", label: "Europe/Oslo" },
              { value: "helsinki", label: "Europe/Helsinki" },
              { value: "utc", label: "UTC" },
            ],
          },
          {
            id: "locale-currency",
            label: "Default currency",
            description: "Finance records retain their original issued currency.",
            scope: "Company",
            type: "select",
            value: "dkk",
            options: [
              { value: "dkk", label: "DKK · Danish krone" },
              { value: "nok", label: "NOK · Norwegian krone" },
              { value: "eur", label: "EUR · Euro" },
            ],
          },
          {
            id: "locale-units",
            label: "Measurement units",
            description: "Weight, distance, volume, fuel, and emissions display.",
            scope: "Project",
            type: "select",
            value: "metric",
            options: [
              { value: "metric", label: "Metric · kg, km, litre" },
              { value: "custom", label: "Custom by measure" },
            ],
          },
        ],
      },
    ],
  },
  calendars: {
    title: "Calendars and working days",
    description: "Week numbering, default working days, holidays, service promises, and deviation communication defaults.",
    groups: [
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
          {
            id: "calendar-working-days",
            label: "Default working days",
            description: "Holiday and deviation rules can replace individual service dates.",
            scope: "Project",
            type: "select",
            value: "mon-fri",
            options: [
              { value: "mon-fri", label: "Monday–Friday" },
              { value: "mon-sat", label: "Monday–Saturday" },
              { value: "all", label: "All days" },
            ],
          },
          {
            id: "calendar-2027",
            label: "2027 holiday calendar",
            description: "Two replacement dates currently fall outside permitted working days.",
            scope: "Project",
            type: "status",
            value: "2 validation issues",
            tone: "danger",
            action: "Resolve issues",
          },
          {
            id: "calendar-notify",
            label: "Require customer communication plan",
            description: "Deviations affecting customer-visible collection dates need an approved message plan.",
            scope: "Project",
            type: "switch",
            checked: true,
          },
        ],
      },
    ],
  },
  "master-data": {
    title: "Operational master data",
    description: "Effective-dated fractions, container types, reasons, units, service levels, depots, and facilities.",
    groups: [
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
            action: "Manage fractions",
          },
          {
            id: "master-containers",
            label: "Container types",
            description: "Capacity, dimensions, accepted fractions, stock identity, and compatible service.",
            scope: "Company",
            type: "status",
            value: "42 active types",
            tone: "healthy",
            action: "Manage types",
          },
          {
            id: "master-reasons",
            label: "Stop outcome reasons",
            description: "Failure, skip, reschedule, and exception codes used by office and driver app.",
            scope: "Project",
            type: "status",
            value: "18 active · 2 deprecated",
            tone: "warning",
            action: "Manage reasons",
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
    ],
  },
  "ticket-comms": {
    title: "Tickets and communication",
    description: "Ticket types, lifecycle, actions, SLA, channels, templates, recipients, and inbound routing.",
    groups: [
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
            action: "Open Ticket Studio",
          },
          {
            id: "ticket-lifecycle",
            label: "Ticket lifecycle",
            description: "Configured transitions for Created, Open, Pending, On hold, In progress, Completed, and Rejected.",
            scope: "Project",
            type: "status",
            value: "Version 6 · active",
            tone: "healthy",
            action: "Review lifecycle",
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
            description: "Email, SMS, push, portal, route deviation, and service-change messages.",
            scope: "Project",
            type: "status",
            value: "42 templates · 3 preview issues",
            tone: "warning",
            action: "Review templates",
          },
          {
            id: "comm-email",
            label: "Inbound email routing",
            description: "Connected accounts, matching rules, ticket creation, and unassigned fallback.",
            scope: "Project",
            type: "status",
            value: "3 accounts · healthy",
            tone: "healthy",
            action: "Manage routing",
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
    ],
  },
  maps: {
    title: "Maps, areas, and zones",
    description: "Map sources, operating areas, contract boundaries, notification zones, depots, and geographic controls.",
    groups: [
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
            description: "Properties, containers, routes, contract areas, zones, depots, and facilities.",
            scope: "Project",
            type: "status",
            value: "18 layers · 2 restricted",
            tone: "healthy",
            action: "Configure layers",
          },
          {
            id: "map-overlap",
            label: "Contract-area validation",
            description: "Upcoming Østerbro area overlaps an existing responsibility for five properties.",
            scope: "Project",
            type: "status",
            value: "1 overlap",
            tone: "danger",
            action: "Review boundary",
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
    ],
  },
  finance: {
    title: "Finance and invoicing",
    description: "VAT, payment references, cadence, bundling, cost centres, accounts, routing rules, and financial integrity.",
    groups: [
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
            action: "Resolve mapping",
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
    ],
  },
  pricing: {
    title: "Products and pricing",
    description: "Product categories, templates, service levels, units, components, price lists, rows, surcharges, and history.",
    groups: [
      {
        title: "Product configuration",
        controls: [
          {
            id: "pricing-products",
            label: "Product catalogue",
            description: "84 active products across 12 categories with effective version history.",
            scope: "Company",
            type: "status",
            value: "5 missing active prices",
            tone: "danger",
            action: "Review products",
          },
          {
            id: "pricing-lists",
            label: "Price lists",
            description: "Customer and standard lists with zones, quantity, schedule, and surcharge rules.",
            scope: "Company",
            type: "status",
            value: "9 active · 1,842 rows",
            tone: "healthy",
            action: "Manage price lists",
          },
          {
            id: "pricing-explain",
            label: "Require price explanation",
            description: "Show inputs, candidates, selected row, and applied adjustments in price check.",
            scope: "Company",
            type: "switch",
            checked: true,
          },
          {
            id: "pricing-separate",
            label: "Separate contractor compensation",
            description: "Customer pricing and contractor-specific prices use separate confidential records.",
            scope: "Company",
            type: "switch",
            checked: true,
          },
        ],
      },
    ],
  },
  contractors: {
    title: "Contractors",
    description: "Contract-area responsibility, proposals, compliance, visibility, prices, settlements, and protected changes.",
    groups: [
      {
        title: "Contractor governance",
        controls: [
          {
            id: "contractors-active",
            label: "Active contractors and areas",
            description: "Three contractors across seven effective contract areas.",
            scope: "Company",
            type: "status",
            value: "1 overlap · 2 compliance issues",
            tone: "warning",
            action: "Open contractor setup",
          },
          {
            id: "contractors-proposal",
            label: "Protect route-scheme master data",
            description: "Contractor route-day and interval changes become office proposals.",
            scope: "Company",
            type: "switch",
            checked: true,
          },
          {
            id: "contractors-money",
            label: "Restrict price and settlement visibility",
            description: "Foremen and drivers cannot access prices, settlements, or customer financial data.",
            scope: "Company",
            type: "switch",
            checked: true,
          },
          {
            id: "contractors-close",
            label: "Settlement close control",
            description: "Closing freezes a snapshot; reopening needs permission, reason, and audit.",
            scope: "Company",
            type: "switch",
            checked: true,
          },
        ],
      },
    ],
  },
  plans: {
    title: "Plans, subscriptions, and marketplace",
    description: "Company subscription, explicit feature rights, billing readiness, renewals, and compatible hardware purchasing.",
    groups: [
      {
        title: "Subscription",
        controls: [
          {
            id: "plan-current",
            label: "Current platform plan",
            description: "Commercial products map to explicit company and project feature entitlements.",
            scope: "Company",
            type: "status",
            value: "Operations Growth · active",
            tone: "healthy",
            action: "Review plan",
          },
          {
            id: "plan-renewal",
            label: "Renewal term",
            description: "Future changes remain separate from the active subscription until their effective date.",
            scope: "Company",
            type: "select",
            value: "annual",
            options: [
              { value: "annual", label: "Annual · renews 1 Jul 2027" },
              { value: "monthly", label: "Monthly" },
              { value: "custom", label: "Custom contract term" },
            ],
          },
          {
            id: "plan-billing",
            label: "Billing readiness",
            description: "Incomplete payer or payment details never grant ambiguous platform access.",
            scope: "Company",
            type: "status",
            value: "Healthy · invoice terms verified",
            tone: "healthy",
            action: "Review billing details",
          },
          {
            id: "plan-self-service",
            label: "Allow administrator self-service",
            description: "Authorized company administrators can request plan changes; activation still follows approval and payment validation.",
            scope: "Company",
            type: "switch",
            checked: true,
          },
        ],
      },
      {
        title: "Marketplace and fulfillment",
        controls: [
          {
            id: "marketplace-hardware",
            label: "Compatible hardware catalogue",
            description: "Availability, compatibility, reservation, shipment, and fulfillment status remain explicit.",
            scope: "Company",
            type: "status",
            value: "24 products · 2 low stock",
            tone: "warning",
            action: "Browse catalogue",
          },
          {
            id: "marketplace-approval",
            label: "Purchase approval threshold",
            description: "Orders above this amount require a second authorized company approver.",
            scope: "Company",
            type: "select",
            value: "25000",
            options: [
              { value: "10000", label: "DKK 10,000" },
              { value: "25000", label: "DKK 25,000" },
              { value: "50000", label: "DKK 50,000" },
            ],
          },
          {
            id: "marketplace-updates",
            label: "Fulfillment updates",
            description: "Notify purchasing administrators about reservation, shipment, delivery, and failed-payment events.",
            scope: "Company",
            type: "switch",
            checked: true,
          },
        ],
      },
    ],
  },
  features: {
    title: "Features and entitlements",
    description: "Commercial entitlements, project activation, dependencies, trials, and release-dependent capabilities.",
    groups: [
      {
        title: "Core and optional capabilities",
        controls: [
          {
            id: "feature-core",
            label: "Core operations",
            description: "Customers, assets, fleet, route schemes, routes, tickets, communication, and audit.",
            scope: "Company",
            type: "status",
            value: "Entitled · active",
            tone: "healthy",
            action: "View modules",
          },
          {
            id: "feature-live",
            label: "Live Operations",
            description: "Requires fleet position source, driver access, GPS governance, and route execution.",
            scope: "Project",
            type: "status",
            value: "Entitled · active",
            tone: "healthy",
            action: "Review dependencies",
          },
          {
            id: "feature-studio",
            label: "Route Studio",
            description: "Import, scenarios, simulations, immutable plans, comparisons, approvals, and promotion.",
            scope: "Project",
            type: "status",
            value: "Entitled · active",
            tone: "healthy",
            action: "Review dependencies",
          },
          {
            id: "feature-public",
            label: "Public transparency pages",
            description: "Defaults off and requires reviewed frozen payload plus privacy checks.",
            scope: "Project",
            type: "switch",
            checked: false,
          },
        ],
      },
    ],
  },
  integrations: {
    title: "Integrations",
    description: "Connection, authentication, ownership, flow direction, mappings, jobs, retries, and support.",
    groups: [
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
            action: "Inspect jobs",
          },
          {
            id: "integration-navision",
            label: "Navision Finance",
            description: "Bidirectional accounting export and payment status.",
            scope: "Company",
            type: "status",
            value: "Healthy · last success 04:22",
            tone: "healthy",
            action: "Run test",
          },
          {
            id: "integration-digitalpost",
            label: "Danish Digital Post",
            description: "Outbound messages · client certificate expired · three deliveries waiting.",
            scope: "Project",
            type: "status",
            value: "Failed · credential expired",
            tone: "danger",
            action: "Update credential",
          },
          {
            id: "integration-ads",
            label: "Danish ADS waste reporting",
            description: "Scheduled regulatory export with approved mappings and error download.",
            scope: "Project",
            type: "status",
            value: "Healthy · next run 1 Aug",
            tone: "healthy",
            action: "Review mapping",
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
    ],
  },
  portals: {
    title: "Portals and branding",
    description: "Project identity, localized content, customer portal, driver app, banners, actions, and accessibility preview.",
    groups: [
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
            action: "Preview branding",
          },
          {
            id: "portal-customer",
            label: "Customer portal",
            description: "1,408 authorized users with scoped property and service access.",
            scope: "Project",
            type: "status",
            value: "Published · healthy",
            tone: "healthy",
            action: "Configure portal",
          },
          {
            id: "portal-driver",
            label: "Driver and Navigation App",
            description: "Assigned routes, navigation, outcome actions, proof, messages, offline sync, and location notice.",
            scope: "Project",
            type: "status",
            value: "Active · 34 drivers",
            tone: "healthy",
            action: "Configure driver app",
          },
          {
            id: "portal-internal",
            label: "Hide internal and restricted information",
            description: "Internal comments, contractor data, financial data, and unrelated routes never enter portal payloads.",
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
    ],
  },
  privacy: {
    title: "Privacy, audit, and retention",
    description: "Sensitive access, GPS governance, change history, evidence classes, retention, and compliance controls.",
    groups: [
      {
        title: "GPS and employee monitoring",
        controls: [
          {
            id: "privacy-purpose",
            label: "Permitted GPS purpose",
            description: "Dispatch, operational recovery, route evidence, and approved compliance use.",
            scope: "Company",
            type: "select",
            value: "dispatch-proof",
            options: [
              { value: "dispatch-proof", label: "Dispatch + proof of service" },
              { value: "dispatch", label: "Dispatch only" },
              { value: "disabled", label: "Location disabled" },
            ],
          },
          {
            id: "privacy-retention-gps",
            label: "GPS retention",
            description: "Historic position records are removed or aggregated after this period.",
            scope: "Company",
            type: "select",
            value: "90",
            options: [
              { value: "30", label: "30 days" },
              { value: "90", label: "90 days" },
              { value: "180", label: "180 days" },
            ],
          },
          {
            id: "privacy-review",
            label: "Monitoring register review",
            description: "Purpose and employee-notice reviews are overdue.",
            scope: "Company",
            type: "status",
            value: "2 controls overdue",
            tone: "danger",
            action: "Complete review",
          },
          {
            id: "privacy-access",
            label: "Require purpose for sensitive access",
            description: "GPS, financial, customer export, and restricted evidence views record a user-supplied purpose.",
            scope: "Company",
            type: "status",
            value: "Enforced",
            tone: "healthy",
          },
        ],
      },
      {
        title: "Retention and audit",
        controls: [
          {
            id: "privacy-ticket-retention",
            label: "Closed ticket retention",
            description: "Customer messages, internal comments, attachments, and audit use separate storage classes.",
            scope: "Company",
            type: "select",
            value: "7y",
            options: [
              { value: "5y", label: "5 years" },
              { value: "7y", label: "7 years" },
              { value: "10y", label: "10 years" },
            ],
          },
          {
            id: "privacy-financial",
            label: "Financial-record protection",
            description: "Issued documents, credits, accounting rows, and settlement snapshots follow statutory retention.",
            scope: "Company",
            type: "status",
            value: "Enforced",
            tone: "healthy",
          },
          {
            id: "privacy-history",
            label: "Immutable audit history",
            description: "Ordinary users cannot edit or delete before-and-after history, approvals, or evidence audit.",
            scope: "Platform",
            type: "status",
            value: "Enforced",
            tone: "healthy",
          },
        ],
      },
    ],
  },
  security: {
    title: "API, SSO, and security",
    description: "Identity provider, sessions, controlled API clients, token scope, credentials, and security review.",
    groups: [
      {
        title: "Authentication",
        controls: [
          {
            id: "security-sso",
            label: "Single sign-on",
            description: "Company identity provider with enforced office-user authentication.",
            scope: "Company",
            type: "status",
            value: "Healthy · Microsoft Entra ID",
            tone: "healthy",
            action: "Configure SSO",
          },
          {
            id: "security-mfa",
            label: "Require multi-factor authentication",
            description: "Required for administrators, finance, approvals, and sensitive operational access.",
            scope: "Company",
            type: "switch",
            checked: true,
          },
          {
            id: "security-session",
            label: "Office session duration",
            description: "Reauthentication is required sooner for sensitive actions.",
            scope: "Company",
            type: "select",
            value: "8h",
            options: [
              { value: "4h", label: "4 hours" },
              { value: "8h", label: "8 hours" },
              { value: "12h", label: "12 hours" },
            ],
          },
        ],
      },
      {
        title: "API and credentials",
        controls: [
          {
            id: "security-api",
            label: "API clients",
            description: "Three active machine clients with explicit company, project, dataset, and action scope.",
            scope: "Company",
            type: "status",
            value: "3 active · 1 review issue",
            tone: "warning",
            action: "Manage API clients",
          },
          {
            id: "security-key",
            label: "Credential expiry warning",
            description: "Notify owners before API keys, certificates, and integration secrets expire.",
            scope: "Company",
            type: "select",
            value: "30",
            options: [
              { value: "14", label: "14 days before" },
              { value: "30", label: "30 days before" },
              { value: "60", label: "60 days before" },
            ],
          },
          {
            id: "security-write",
            label: "Require explicit write capabilities",
            description: "Read access never implies mutation, export, approval, or automation authority.",
            scope: "Platform",
            type: "status",
            value: "Enforced",
            tone: "healthy",
          },
        ],
      },
    ],
  },
}

const visiblePaneDefinitions: Record<string, SettingsPaneDefinition> = {
  account: {
    ...paneDefinitions.account,
    title: "Account and appearance",
    description: "Your profile, personal defaults, saved views, and visual preferences.",
  },
  notifications: paneDefinitions.notifications,
  company: {
    title: "Company and projects",
    description:
      "Create companies, their operating projects, and the administrators responsible for each tenant.",
    groups: [],
  },
  "asset-management": {
    title: "Asset management",
    description: "Configure the company asset libraries.",
    groups: [],
  },
  access: {
    title: "Users and roles",
    description:
      "Manage every system user, role, organization assignment, and project access.",
    groups: [],
  },
  "operations-setup": {
    title: "Operations setup",
    description:
      "Calendars, working-day defaults, operational master data, maps, areas, zones, and location behavior.",
    groups: [
      ...paneDefinitions.calendars.groups,
      ...paneDefinitions["master-data"].groups,
      ...paneDefinitions.maps.groups,
    ],
  },
  "ticket-comms": paneDefinitions["ticket-comms"],
  finance: paneDefinitions.finance,
  pricing: {
    title: "Commercial defaults",
    description:
      "One-time commercial setup: company defaults, registries, and surcharge rules. Price lists are managed in the Commercial section; day-to-day pricing lives in Price Engine.",
    groups: [
      {
        title: "Company defaults",
        controls: [
          {
            id: "pricing-currency",
            label: "Currency",
            description: "Currency for all product prices and contractor fees.",
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
    ],
  },
  "commercial-products": {
    title: "Products",
    description: "The sellable catalogue — add and edit products here. Prices are managed in Price Engine.",
    groups: [],
  },
  "commercial-price-lists": {
    title: "Price lists",
    description:
      "Annual tariffs and negotiated deals that price rows are tagged with — created, edited and retired here.",
    groups: [],
  },
  "commercial-zones": {
    title: "Zones",
    description:
      "Pricing zones that price rows can condition on — created, edited and retired here.",
    groups: [],
  },
  "commercial-service": {
    title: "Service",
    description:
      "Service levels offered on products — collection tiers like same-week, backdoor or crane emptying.",
    groups: [],
  },
  "commercial-customer-types": {
    title: "Customer types",
    description:
      "Customer segments that price rows can condition on — created, edited and retired here.",
    groups: [],
  },
  integrations: paneDefinitions.integrations,
  portals: paneDefinitions.portals,
  privacy: paneDefinitions.privacy,
}

type SettingsWorkspaceProps = {
  initialPaneId?: string
  returnTo?: string
}

type SettingValue = string | boolean

const SETTINGS_STORAGE_KEY = "wastehero.settings.v1"

function initialSettingValues(): Record<string, SettingValue> {
  return Object.fromEntries(
    Object.values(visiblePaneDefinitions).flatMap((pane) =>
      pane.groups.flatMap((group) =>
        group.controls
          .filter((control) => control.type !== "status")
          .map((control) => [
            control.id,
            control.type === "switch" ? control.checked : control.value,
          ]),
      ),
    ),
  )
}

// Control ids renamed since values were first persisted (issue #14: the
// working-days id collided with the retired plan.calendar-days module).
// Stored values under the old id keep loading; the next save writes the new id.
const legacySettingIds: Record<string, string> = {
  "calendar-days": "calendar-working-days",
}

function mergeStoredSettingValues(
  defaults: Record<string, SettingValue>,
  rawValue: string,
): Record<string, SettingValue> {
  const parsed: unknown = JSON.parse(rawValue)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults

  const storedEntries = Object.entries(parsed).map(([controlId, value]) => {
    const renamedId = legacySettingIds[controlId]
    return renamedId && !(renamedId in parsed)
      ? ([renamedId, value] as const)
      : ([controlId, value] as const)
  })
  const storedValues = Object.fromEntries(
    storedEntries.filter(([controlId, value]) => {
      const defaultValue = defaults[controlId]
      return (
        defaultValue !== undefined &&
        typeof value === typeof defaultValue &&
        (typeof value === "string" || typeof value === "boolean")
      )
    }),
  )

  return { ...defaults, ...storedValues }
}

export function SettingsWorkspace({
  initialPaneId,
  returnTo = "/",
}: SettingsWorkspaceProps) {
  const router = useRouter()
  const [activeItemId, setActiveItemId] = useState(() =>
    initialPaneId && visiblePaneDefinitions[initialPaneId]
      ? initialPaneId
      : "account",
  )
  const [search, setSearch] = useState("")
  const [values, setValues] = useState<Record<string, SettingValue>>(initialSettingValues)
  const [dirtyControlIds, setDirtyControlIds] = useState<string[]>([])
  const [configurationHistory, setConfigurationHistory] = useState<
    Array<{ id: string; at: string; controls: string[] }>
  >([])

  useEffect(() => {
    const defaults = initialSettingValues()
    try {
      const storedValue = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
      if (storedValue) {
        setValues(mergeStoredSettingValues(defaults, storedValue))
      }
    } catch {
      // Keep safe defaults when local storage is unavailable or contains invalid data.
    }
  }, [])

  useEffect(() => {
    if (initialPaneId && visiblePaneDefinitions[initialPaneId]) {
      setActiveItemId(initialPaneId)
    }
  }, [initialPaneId])

  const filteredSections = useMemo(() => {
    const normalized = search.trim().toLowerCase()
    if (!normalized) return settingsSections

    return settingsSections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => {
          const pane = visiblePaneDefinitions[item.id]
          return [
            item.label,
            pane?.title,
            pane?.description,
            ...(item.id === "account"
              ? [
                  "Appearance",
                  "Theme",
                  "Ash",
                  "Midnight",
                  "Dawn",
                  "Pale",
                  "Custom",
                  "Light",
                  "Dark",
                  "Sidebar color",
                  "Interface color",
                  "Theme code",
                  "Accent",
                ]
              : []),
            ...(item.id === "company"
              ? [
                  "Create company",
                  "Add company",
                  "Add project",
                  "Company administrator",
                  "First project",
                  "Tenant",
                  "Legal name",
                  "Registration number",
                  "Language",
                  "Currency",
                  "Timezone",
                ]
              : []),
            ...(item.id === "asset-management"
              ? [
                  "Containers",
                  "Container Types",
                  "Waste Fractions",
                  "Spare Parts",
                  "Part Types",
                  "Property equipment",
                  "Key Types",
                  "Locksmith",
                ]
              : []),
            ...(
              pane?.groups.flatMap((group) => [
                group.title,
                ...group.controls.flatMap((control) => [
                  control.label,
                  control.description,
                ]),
              ]) ?? []
            ),
          ]
            .join(" ")
            .toLowerCase()
            .includes(normalized)
        }),
      }))
      .filter((section) => section.items.length > 0)
  }, [search])

  const activePane =
    visiblePaneDefinitions[activeItemId] ?? visiblePaneDefinitions.account
  const selectPane = (paneId: string) => {
    setActiveItemId(paneId)
    const params = new URLSearchParams({ pane: paneId })
    if (returnTo !== "/") params.set("from", returnTo)
    router.replace(`/settings?${params.toString()}`, { scroll: false })
  }
  const updateValue = (controlId: string, value: SettingValue) => {
    setValues((current) => ({ ...current, [controlId]: value }))
    setDirtyControlIds((current) =>
      current.includes(controlId) ? current : [...current, controlId],
    )
  }
  const saveChanges = () => {
    const changedControls = [...dirtyControlIds]
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(values))
    } catch {
      toast.error("Settings could not be saved", {
        description: "Local storage is unavailable. Your changes are still visible in this session.",
      })
      return
    }

    setConfigurationHistory((current) => [
      {
        id: `configuration-${Date.now()}`,
        at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        controls: changedControls,
      },
      ...current,
    ])
    setDirtyControlIds([])
    toast.success("Settings saved", {
      description: `${changedControls.length} change${changedControls.length === 1 ? "" : "s"} saved on this device.`,
    })
  }

  return (
    <div className="flex h-dvh min-w-0 flex-col bg-sidebar sm:flex-row">
      <aside className="flex max-h-[44dvh] w-full shrink-0 flex-col px-3 py-3 sm:max-h-none sm:min-h-0 sm:w-64 sm:px-4 sm:py-4">
        <button
          type="button"
          onClick={() => router.push(returnTo)}
          className="mb-4 flex h-8 w-fit cursor-pointer items-center gap-1.5 rounded-full bg-sidebar-accent px-3 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:text-sidebar-foreground"
        >
          <CaretLeft className="h-3.5 w-3.5" />
          Back to app
        </button>

        <div className="relative mb-4">
          <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sidebar-foreground/55" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search settings"
            aria-label="Search settings"
            className="h-9 rounded-md border-sidebar-border bg-sidebar-accent/45 pl-9 text-sm text-sidebar-foreground shadow-none placeholder:text-sidebar-foreground/50 focus-visible:border-sidebar-ring focus-visible:ring-1 focus-visible:ring-sidebar-ring/25"
          />
        </div>

        <nav
          className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 text-sm"
          aria-label="Settings sections"
        >
          {filteredSections.map((section) => (
            <div key={section.id}>
              <div className="flex h-6 items-center px-2.5 text-sm font-medium text-sidebar-foreground/55">
                {section.label}
              </div>
              <div className="flex flex-col gap-0.5">
                {section.items.map((item) => {
                  const isActive = item.id === activeItemId
                  const Icon = item.icon
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => selectPane(item.id)}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "flex h-7 cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-xs font-normal text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
                        isActive && "bg-sidebar-accent font-medium text-sidebar-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <main
        className="mx-2 mb-2 min-h-0 min-w-0 flex-1 overflow-y-auto rounded-lg border border-sidebar bg-background sm:my-2 sm:ml-0"
        id="settings-content"
      >
        <div
          className={
            activeItemId === "asset-management" ||
            activeItemId === "access" ||
            activeItemId === "company" ||
            activeItemId.startsWith("commercial-")
              ? "flex min-h-full w-full flex-col"
              : "mx-auto min-h-full w-full max-w-5xl px-5 py-7 sm:px-10 sm:py-10 lg:px-14"
          }
        >
          <SettingsPane
            definition={activePane}
            paneId={activeItemId}
            values={values}
            dirtyControlIds={dirtyControlIds}
            configurationHistory={configurationHistory}
            onValueChange={updateValue}
            onSave={saveChanges}
          />
        </div>
      </main>
    </div>
  )
}

function SettingsPane({
  definition,
  paneId,
  values,
  dirtyControlIds,
  configurationHistory,
  onValueChange,
  onSave,
}: {
  definition: SettingsPaneDefinition
  paneId: string
  values: Record<string, SettingValue>
  dirtyControlIds: string[]
  configurationHistory: Array<{ id: string; at: string; controls: string[] }>
  onValueChange: (controlId: string, value: SettingValue) => void
  onSave: () => void
}) {
  const isDirty = dirtyControlIds.length > 0

  return (
    <div
      className={
        paneId === "asset-management" ||
        paneId === "access" ||
        paneId === "company" ||
        paneId.startsWith("commercial-")
          ? "flex min-w-0 flex-1 flex-col"
          : "space-y-7"
      }
    >
      {paneId === "company" ? (
        <>
          <h1 className="sr-only">Companies</h1>
          <p className="sr-only">
            Manage companies, company information, and projects.
          </p>
        </>
      ) : paneId === "asset-management" ||
        paneId === "access" ||
        paneId.startsWith("commercial-") ? null : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                {definition.title}
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                {definition.description}
              </p>
            </div>
            {paneId === "account" && (
              <Avatar className="h-12 w-12">
                <AvatarImage src="/avatar-profile.jpg" />
                <AvatarFallback>OL</AvatarFallback>
              </Avatar>
            )}
          </div>

          <Separator />
        </>
      )}

      {paneId === "company" ? (
        <CompanyProjectsManagement />
      ) : paneId === "access" ? (
        <OrganizationAccessManagement />
      ) : paneId === "asset-management" ? (
        <AssetManagementSettings />
      ) : paneId.startsWith("commercial-") ? (
        <CommercialSectionPane paneId={paneId} />
      ) : (
        <>
          {paneId === "account" && <ThemeCustomizer />}

          {definition.groups.map((group, groupIndex) => (
            <div key={group.title} className="space-y-4">
              <h3 className="text-sm font-semibold text-foreground">{group.title}</h3>
              <div className="divide-y divide-border border-y border-border/60">
                {group.controls.map((control) => (
                  <div
                    key={control.id}
                    className="grid gap-4 px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)] md:items-center"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          id={`${control.id}-label`}
                          className="text-sm font-medium text-foreground"
                        >
                          {control.label}
                        </span>
                        <ScopeBadge scope={control.scope} />
                      </div>
                      <p
                        id={`${control.id}-description`}
                        className="text-xs leading-5 text-muted-foreground"
                      >
                        {control.description}
                      </p>
                    </div>
                    <div className="md:justify-self-stretch">
                      {control.type === "input" && (
                        <Input
                          id={control.id}
                          type={control.id === "account-email" ? "email" : "text"}
                          value={String(values[control.id] ?? control.value)}
                          className="h-9 text-sm"
                          aria-labelledby={`${control.id}-label`}
                          aria-describedby={`${control.id}-description`}
                          onChange={(event) => onValueChange(control.id, event.target.value)}
                        />
                      )}
                      {control.type === "select" && (
                        <Select
                          value={String(values[control.id] ?? control.value)}
                          onValueChange={(value) => onValueChange(control.id, value)}
                        >
                          <SelectTrigger
                            id={control.id}
                            className="h-9 text-sm"
                            aria-labelledby={`${control.id}-label`}
                            aria-describedby={`${control.id}-description`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {control.options.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {control.type === "switch" && (
                        <div className="flex items-center justify-end">
                          <Switch
                            id={control.id}
                            checked={Boolean(values[control.id] ?? control.checked)}
                            aria-labelledby={`${control.id}-label`}
                            aria-describedby={`${control.id}-description`}
                            onCheckedChange={(checked) => onValueChange(control.id, checked)}
                          />
                        </div>
                      )}
                      {control.type === "status" && (
                        <div
                          className="flex flex-wrap items-center gap-2"
                          aria-labelledby={`${control.id}-label`}
                          aria-describedby={`${control.id}-description`}
                        >
                          <StatusIndicator tone={control.tone} value={control.value} />
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {groupIndex < definition.groups.length - 1 && <Separator />}
            </div>
          ))}

          {paneId === "pricing" && <CommercialDefaultsExtras />}

          <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-border bg-background py-4">
            <p className="text-xs text-muted-foreground">
              {isDirty
                ? `${dirtyControlIds.length} unsaved change${dirtyControlIds.length === 1 ? "" : "s"} · save to keep ${dirtyControlIds.length === 1 ? "it" : "them"} on this device.`
                : configurationHistory[0]
                  ? `Saved on this device at ${configurationHistory[0].at} · ${configurationHistory[0].controls.length} change${configurationHistory[0].controls.length === 1 ? "" : "s"}.`
                  : "Changes are saved on this device when you select Save changes."}
            </p>
            <Button disabled={!isDirty} onClick={onSave}>
              Save changes
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function ScopeBadge({ scope }: { scope: SettingControl["scope"] }) {
  return (
    <Badge variant="outline" className="rounded-full px-2 py-0 text-[10px] font-normal">
      {scope}
    </Badge>
  )
}

function StatusIndicator({
  tone,
  value,
}: {
  tone: Extract<SettingControl, { type: "status" }>["tone"]
  value: string
}) {
  const Icon =
    tone === "healthy" ? CheckCircle : tone === "danger" ? Warning : tone === "warning" ? Warning : Gear
  const className =
    tone === "healthy"
      ? "text-emerald-600"
      : tone === "danger"
        ? "text-rose-600"
        : tone === "warning"
          ? "text-amber-600"
          : "text-muted-foreground"

  return (
    <span className={cn("inline-flex items-center gap-2 text-xs font-medium", className)}>
      <Icon className="h-4 w-4" weight={tone === "healthy" || tone === "danger" ? "fill" : "regular"} />
      {value}
    </span>
  )
}
