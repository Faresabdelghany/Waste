import { RESOLUTION_RULE } from "@waste/domain/finance/pricing"

import { workspaceSpec } from "./spec"

export const COMMERCIAL = workspaceSpec("commercial", {
  label: "Price Engine",
  description:
    "Price the sellable catalogue, manage service provider prices and settlement, and convert delivered work into auditable money flows.",
  path: "/commercial",
  modules: {
    products: {
      shown: "tab",
      view: { seededFactColumns: ["Type", "Container", "Container type", "Customer", "Waste fraction", "VAT", "Variations", "Price list"] },
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
    "price-rows": {
      shown: "tab",
      // Row-level Actions (generic edit/delete) are the rich view's: price rows
      // need the edit path for the schedule-a-change flow.
      view: { seededFactColumns: ["Zone", "Customer type", "Container type", "Waste fraction", "Negotiated customer", "Price list", "Effective from"] },
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
    events: {
      shown: "tab",
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
    billing: {
      shown: "tab",
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
    invoices: {
      shown: "tab",
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
    payments: {
      shown: "more",
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
    "service-provider-prices": {
      shown: "more",
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
    settlements: {
      shown: "more",
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
  },
})
