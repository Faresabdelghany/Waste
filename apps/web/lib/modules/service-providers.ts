import { workspaceSpec } from "./spec"

export const SERVICE_PROVIDERS = workspaceSpec("service-providers", {
  label: "Service providers",
  description:
    "Manage service provider companies, awarded service areas, and operational activity.",
  path: "/service-providers",
  modules: {
    "service-providers": {
      shown: "tab",
      label: "Service Providers",
      title: "Service Providers",
      description:
        "External service providers, company details, compliance, access, fleet links, and performance.",
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
    "service-areas": {
      shown: "tab",
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
    },
    activities: {
      shown: "tab",
      providerPage: "activities",
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
    },
    "service-provider-workspace": {
      shown: "elsewhere",
      providerPage: "team",
      // Full name, Email, Phone number, Role, Status and Updated as a fixed
      // column set; the rich view still gives it edit and delete.
      view: { seededFactColumns: [], offersFactColumns: false },
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
  },
})
