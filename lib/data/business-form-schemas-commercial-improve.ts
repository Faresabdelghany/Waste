import type { BusinessFormSchema } from "@/lib/data/business-form-types"
import { SERVICE_FREQUENCIES } from "@/lib/data/service-frequencies"

/**
 * Commercial, Improve, and Control Center creation contracts.
 *
 * A schema in `disabled` mode is intentional: the module contains generated
 * records or several unlike domain workflows, so the generic create dialog
 * must hand off to the named wizard/action instead of inventing a weak record.
 * Its sections still document the fields and integrity rules required by that
 * domain workflow.
 */
export const commercialImproveBusinessFormSchemas = [
  {
    key: "commercial.products",
    mode: "create",
    recordKind: "Product",
    title: "New product",
    description:
      "Create a sellable product for the catalogue. Products carry no price of their own — prices are added in Price Engine with Add price, starting with the no-conditions default row.",
    submitLabel: "Create product",
    nameField: "productName",
    contextFieldIds: ["productType", "priceUnit"],
    sections: [
      {
        id: "identity",
        title: "Product identity",
        description:
          "Validation: name is required. The three product types are fixed — templates, categories and types collapsed into one axis.",
        fields: [
          { id: "productName", label: "Product name", type: "text", required: true, placeholder: "Residual waste · 240L bin" },
          {
            id: "productType",
            label: "Type",
            type: "select",
            required: true,
            options: [
              { value: "Container collection", label: "Container collection" },
              { value: "Recurring service", label: "Recurring service" },
              { value: "Additional service", label: "Additional service" },
            ],
          },
          {
            id: "status",
            label: "Status",
            type: "select",
            required: true,
            defaultValue: "Active",
            options: [
              { value: "Active", label: "Active" },
              { value: "Draft", label: "Draft" },
            ],
          },
          {
            id: "priceUnit",
            label: "Unit",
            type: "select",
            required: true,
            defaultValue: "pickup",
            description: "Price rows on this product are quoted in this unit.",
            options: [
              { value: "pickup", label: "€ per pickup" },
              { value: "month", label: "€ per month" },
              { value: "job", label: "€ per job" },
            ],
          },
        ],
      },
      {
        id: "attributes",
        title: "Catalogue attributes",
        description: "Shown as catalogue columns; services usually leave them unset.",
        fields: [
          { id: "container", label: "Container", type: "text", placeholder: "240L bin (rental)" },
          {
            id: "containerType",
            label: "Container type",
            type: "select",
            options: [
              { value: "240L bin", label: "240L bin" },
              { value: "660L container", label: "660L container" },
              { value: "Igloo 3m³", label: "Igloo 3m³" },
            ],
          },
          {
            id: "wasteFraction",
            label: "Waste fraction",
            type: "select",
            options: [
              { value: "Residual", label: "Residual" },
              { value: "Paper & cardboard", label: "Paper & cardboard" },
              { value: "Glass", label: "Glass" },
              { value: "Organic", label: "Organic" },
            ],
          },
          {
            // Typed reference to the reusable frequency catalog (issue #20):
            // the catalogue side of the frequency promise. Not a price-row
            // condition — that extension stays a conscious cut.
            id: "serviceFrequencyId",
            label: "Service frequency",
            type: "select",
            options: SERVICE_FREQUENCIES.map((definition) => ({
              value: definition.id,
              label: definition.name,
            })),
          },
          {
            id: "serviceLevels",
            label: "Service levels",
            type: "multiselect",
            description: "Collection tiers offered on this product — managed in Settings → Commercial → Service.",
            options: [
              { value: "Standard kerbside", label: "Standard kerbside" },
              { value: "Backdoor service", label: "Backdoor service" },
              { value: "Crane emptying", label: "Crane emptying" },
              { value: "Same-week", label: "Same-week" },
              { value: "Next-day", label: "Next-day" },
            ],
          },
        ],
      },
    ],
  },
  {
    key: "commercial.price-rows",
    mode: "create",
    recordKind: "Price row",
    title: "Add price",
    description:
      "Price a product from the Settings catalogue. Leave every condition empty for the default price that applies to everyone. The row matching the most conditions wins; a negotiated row for the specific customer always wins; ties go to the newest effective-from date.",
    submitLabel: "Add price",
    contextFieldIds: ["productId", "amount", "effectiveFrom"],
    sections: [
      {
        id: "row-target",
        title: "Product and amount",
        fields: [
          { id: "productId", label: "Product", type: "select", required: true, relation: { workspaceId: "commercial", moduleId: "products" } },
          { id: "amount", label: "Amount", type: "number", required: true, min: 0, unit: "EUR" },
          {
            id: "unit",
            label: "Unit",
            type: "select",
            required: true,
            description: "Match the product's unit.",
            options: [
              { value: "pickup", label: "€ per pickup" },
              { value: "month", label: "€ per month" },
              { value: "job", label: "€ per job" },
            ],
          },
          {
            id: "tag",
            label: "Price list",
            type: "select",
            description: "Managed in Settings → Commercial → Price lists; the active lists are offered here.",
            // Fallback only — business-workspace.tsx replaces these with the
            // active lists from the commercial-registries store.
            options: [
              { value: "PL-Copenhagen-2026", label: "PL-Copenhagen-2026" },
              { value: "PL-Harbor-2026", label: "PL-Harbor-2026" },
            ],
          },
        ],
      },
      {
        id: "row-conditions",
        title: "Conditions",
        description: "Each filled condition narrows who pays this amount. Empty conditions + empty customer = the product's default row.",
        fields: [
          { id: "zone", label: "Zone", type: "select", options: [
            { value: "Zone North", label: "Zone North" },
            { value: "City Centre", label: "City Centre" },
            { value: "Amager", label: "Amager" },
            { value: "Harbor", label: "Harbor" },
          ] },
          { id: "customerType", label: "Customer type", type: "select", options: [
            { value: "Household", label: "Household" },
            { value: "Commercial", label: "Commercial" },
            { value: "Municipal", label: "Municipal" },
          ] },
          { id: "containerType", label: "Container type", type: "select", options: [
            { value: "240L bin", label: "240L bin" },
            { value: "660L container", label: "660L container" },
            { value: "Igloo 3m³", label: "Igloo 3m³" },
          ] },
          { id: "wasteFraction", label: "Waste fraction", type: "select", options: [
            { value: "Residual", label: "Residual" },
            { value: "Paper & cardboard", label: "Paper & cardboard" },
            { value: "Glass", label: "Glass" },
            { value: "Organic", label: "Organic" },
          ] },
          {
            id: "negotiatedCustomer",
            label: "Negotiated customer",
            type: "text",
            description: "Filling this makes it a negotiated deal — it always wins for that customer and is excluded from bulk adjustments by default.",
            placeholder: "Østerbro Housing Association",
          },
        ],
      },
      {
        id: "row-dates",
        title: "Effective period",
        fields: [
          { id: "effectiveFrom", label: "Effective from", type: "date", required: true, defaultValue: "2026-08-20" },
          { id: "effectiveTo", label: "Effective to", type: "date", description: "Optional end date." },
          { id: "scheduledAmount", label: "Scheduled amount", type: "number", min: 0, unit: "EUR", description: "Optional: a future amount that takes over on the scheduled date." },
          { id: "scheduledFrom", label: "Scheduled from", type: "date" },
          { id: "scheduledRevertOn", label: "Scheduled revert on", type: "date" },
        ],
      },
    ],
  },
  {
    key: "commercial.service-provider-prices",
    mode: "create",
    recordKind: "Service provider price",
    title: "New service provider price",
    description:
      "Create the confidential price we pay a service provider for one product inside a service area. The bid is locked from creation and the current fee starts equal to it — Apply index is the only way to move the current fee afterwards.",
    submitLabel: "New service provider price",
    contextFieldIds: ["serviceAreaId", "validFrom", "validUntil"],
    sections: [
      {
        id: "rate-target",
        title: "Service provider, product, and service area",
        description:
          "Validation: the price cannot overlap another row for the same service provider, product, and service area. It is confidential and never copied from a customer price list.",
        fields: [
          {
            id: "serviceProviderId",
            label: "Service provider",
            type: "select",
            required: true,
            relation: { workspaceId: "service-providers", moduleId: "service-providers" },
          },
          {
            id: "productId",
            label: "Product",
            type: "select",
            required: true,
            relation: { workspaceId: "commercial", moduleId: "products" },
          },
          {
            id: "serviceAreaId",
            label: "Service area",
            type: "select",
            required: true,
            description: "Only the selected service provider's awarded areas are offered.",
            relation: {
              workspaceId: "service-providers",
              moduleId: "service-areas",
              allowedStatuses: ["Upcoming", "Active", "Expiring"],
            },
          },
        ],
      },
      {
        id: "rate-compensation",
        title: "Compensation",
        fields: [
          {
            id: "bid",
            label: "Bid (locked)",
            type: "number",
            required: true,
            min: 0,
            unit: "EUR",
            description:
              "The contractually agreed amount. It never changes after creation; indexation moves only the current fee.",
          },
          {
            id: "unit",
            label: "Unit",
            type: "select",
            required: true,
            description: "Match the product's unit.",
            options: [
              { value: "pickup", label: "€ per pickup" },
              { value: "month", label: "€ per month" },
              { value: "job", label: "€ per job" },
            ],
          },
        ],
      },
      {
        id: "rate-validity",
        title: "Validity",
        fields: [
          { id: "validFrom", label: "Valid from", type: "date", required: true, defaultValue: "2026-08-20" },
          {
            id: "validUntil",
            label: "Valid until",
            type: "date",
            required: true,
            description: "End of the awarded period — usually the service area's end date.",
          },
        ],
      },
    ],
  },
  {
    key: "service-providers.service-providers",
    mode: "create",
    recordKind: "Service provider company",
    title: "Add service provider",
    description:
      "Create a service provider company and its initial operating relationship. Service area awards, protected changes, access, vehicle links, prices, and settlements remain separate governed records.",
    submitLabel: "Add service provider",
    nameField: "legalName",
    contextFieldIds: ["registrationNumber", "projectId", "relationshipStart"],
    sections: [
      {
        id: "company",
        title: "Company identity",
        description:
          "Validation: legal name and registration number are required; registration number is unique per legal entity and country.",
        fields: [
          {
            id: "legalName",
            label: "Legal company name",
            type: "text",
            required: true,
          },
          {
            id: "registrationNumber",
            label: "Registration number",
            type: "text",
            required: true,
            placeholder: "CVR or local company number",
          },
          {
            id: "country",
            label: "Country",
            type: "text",
            required: true,
            defaultValue: "Denmark",
          },
          {
            id: "contactName",
            label: "Primary contact",
            type: "text",
            required: true,
          },
          {
            id: "contactEmail",
            label: "Contact email",
            type: "text",
            required: true,
            description: "Must be a valid email address.",
          },
        ],
      },
      {
        id: "operating-scope",
        title: "Initial operating scope",
        description:
          "Relationship: a service provider relationship is explicit for each project. This does not award work; an effective-dated service area record must be approved separately.",
        fields: [
          {
            id: "projectId",
            label: "Project",
            type: "select",
            required: true,
            relation: { workspaceId: "configure", moduleId: "organization" },
          },
          {
            id: "relationshipStart",
            label: "Relationship starts",
            type: "date",
            required: true,
          },
          {
            id: "relationshipEnd",
            label: "Relationship ends",
            type: "date",
            description: "Optional; must follow Relationship starts.",
          },
          {
            id: "serviceAreaId",
            label: "Proposed service area",
            type: "select",
            relation: { workspaceId: "service-providers", moduleId: "service-areas" },
            description:
              "Optional relationship only. Award dates and approval are completed in the Create service area action.",
          },
          {
            id: "documentsComplete",
            label: "Required documents verified",
            type: "checkbox",
            defaultValue: false,
            description:
              "A service provider can remain Draft without verification but cannot receive an Active area award.",
          },
        ],
      },
    ],
  },
  {
    key: "service-providers.service-areas",
    mode: "create",
    recordKind: "Service area",
    title: "Create service area",
    description: "Award a geographic and time-bounded service scope to a service provider.",
    submitLabel: "Create service area",
    nameField: "areaName",
    contextFieldIds: ["areaCode", "serviceProviderId", "projectId", "validFrom", "validTo"],
    sections: [
      {
        id: "identity",
        title: "Service area",
        fields: [
          {
            id: "areaName",
            label: "Service area name",
            type: "text",
            required: true,
          },
          {
            id: "areaCode",
            label: "Area code",
            type: "text",
            required: true,
          },
          {
            id: "serviceProviderId",
            label: "Service provider",
            type: "select",
            required: true,
            relation: { workspaceId: "service-providers", moduleId: "service-providers" },
          },
          {
            id: "projectId",
            label: "Project",
            type: "select",
            required: true,
            relation: { workspaceId: "configure", moduleId: "organization" },
          },
        ],
      },
      {
        id: "scope",
        title: "Scope and period",
        fields: [
          {
            id: "boundary",
            label: "Geographic boundary",
            type: "textarea",
            required: true,
          },
          {
            id: "serviceResponsibilities",
            label: "Service responsibilities",
            type: "multiselect",
            required: true,
            options: [
              { value: "residual-waste-collection", label: "Residual waste collection" },
              { value: "organic-waste-collection", label: "Organic waste collection" },
              { value: "paper-collection", label: "Paper collection" },
              { value: "cardboard-collection", label: "Cardboard collection" },
              { value: "glass-collection", label: "Glass collection" },
              { value: "plastic-collection", label: "Plastic collection" },
              { value: "bulky-waste-collection", label: "Bulky waste collection" },
              { value: "container-maintenance", label: "Container maintenance" },
              { value: "container-washing", label: "Container washing" },
            ],
          },
          {
            id: "productIds",
            label: "Products",
            type: "multiselect",
            relation: { workspaceId: "commercial", moduleId: "products" },
          },
          {
            // Deliberate cross-domain reference (issue #12): a Service area's
            // geographic scope is a set of operator-owned Planning Areas; the
            // service provider domain has no zone concept of its own.
            id: "zoneIds",
            label: "Planning areas",
            type: "multiselect",
            relation: { workspaceId: "plan", moduleId: "areas" },
          },
          {
            id: "validFrom",
            label: "Starts",
            type: "date",
            required: true,
          },
          {
            id: "validTo",
            label: "Ends",
            type: "date",
            required: true,
          },
        ],
      },
    ],
  },
  {
    key: "service-providers.activities",
    mode: "disabled",
    recordKind: "Service provider activity",
    title: "Activities come from operational workflows",
    description:
      "Route assignments, proposals, compliance follow-ups, and coordination entries appear here from their owning workflows.",
    submitLabel: "Open service provider",
    sections: [],
  },
  {
    key: "service-providers.service-provider-workspace",
    mode: "create",
    recordKind: "Service provider user",
    title: "Add User",
    description: "Add a user with access limited to the selected service provider.",
    submitLabel: "Add user",
    contextFieldIds: ["serviceProviderId", "projectId", "serviceAreaId", "role"],
    sections: [
      {
        id: "restricted-user-invite",
        title: "User access",
        fields: [
          {
            id: "serviceProviderId",
            label: "Service provider",
            type: "select",
            required: true,
            relation: { workspaceId: "service-providers", moduleId: "service-providers" },
          },
          {
            id: "projectId",
            label: "Project",
            type: "select",
            required: true,
            relation: { workspaceId: "configure", moduleId: "organization" },
          },
          {
            id: "serviceAreaId",
            label: "Allowed service area",
            type: "select",
            required: true,
            relation: { workspaceId: "service-providers", moduleId: "service-areas" },
          },
          {
            id: "firstName",
            label: "First name",
            type: "text",
            required: true,
          },
          {
            id: "lastName",
            label: "Last name",
            type: "text",
            required: true,
          },
          {
            id: "phone",
            label: "Phone number",
            type: "text",
            placeholder: "+45 12 34 56 78",
          },
          {
            id: "email",
            label: "Email",
            type: "email",
            required: true,
          },
          {
            id: "role",
            label: "Role",
            type: "select",
            required: true,
            options: [
              { value: "manager", label: "Service provider manager" },
              { value: "foreman", label: "Foreman" },
              { value: "driver", label: "Driver" },
              { value: "viewer", label: "Read-only viewer" },
            ],
          },
          {
            id: "invitedBy",
            label: "Invited by",
            type: "text",
            required: true,
          },
        ],
      },
    ],
  },
  {
    key: "commercial.settlements",
    mode: "disabled",
    recordKind: "Service provider price or settlement action",
    title: "Use service provider pricing or settlement workflow",
    description:
      "Service provider price versions, settlement calculation, close, and reopen are different records and commands. Settlement amounts must come from a reproducible calculation snapshot, not a generic form.",
    submitLabel: "Open settlement workflow",
    contextFieldIds: ["serviceProviderId", "projectId", "periodStart", "periodEnd"],
    sections: [
      {
        id: "service-provider-price-version",
        title: "Service provider compensation price",
        description:
          "Validation: price is confidential, effective-dated, and cannot overlap another active row for the same service provider, area, service, and unit. It is never copied from a customer price list.",
        fields: [
          {
            id: "serviceProviderId",
            label: "Service provider",
            type: "select",
            required: true,
            relation: { workspaceId: "service-providers", moduleId: "service-providers" },
          },
          {
            id: "serviceAreaId",
            label: "Service area",
            type: "select",
            required: true,
            relation: { workspaceId: "service-providers", moduleId: "service-areas" },
          },
          {
            id: "productId",
            label: "Service product",
            type: "select",
            required: true,
            relation: { workspaceId: "commercial", moduleId: "products" },
          },
          {
            id: "compensationUnit",
            label: "Compensation unit",
            type: "select",
            required: true,
            options: [
              { value: "activity", label: "Per completed activity" },
              { value: "route", label: "Per completed route" },
              { value: "hour", label: "Per hour" },
              { value: "period", label: "Fixed per period" },
            ],
          },
          {
            id: "compensationAmount",
            label: "Amount",
            type: "number",
            required: true,
            min: 0,
          },
          {
            id: "priceValidFrom",
            label: "Effective from",
            type: "date",
            required: true,
          },
          {
            id: "priceValidTo",
            label: "Effective until",
            type: "date",
          },
        ],
      },
      {
        id: "settlement-calculation",
        title: "Calculate settlement",
        description:
          "Relationship: service provider and service area must match the selected period. Calculation snapshots base compensation, activities, reliability, bonuses, penalties, complaints, and coefficients.",
        fields: [
          {
            id: "projectId",
            label: "Project",
            type: "select",
            required: true,
            relation: { workspaceId: "configure", moduleId: "organization" },
          },
          {
            id: "periodStart",
            label: "Period starts",
            type: "date",
            required: true,
          },
          {
            id: "periodEnd",
            label: "Period ends",
            type: "date",
            required: true,
            description: "Must be on or after Period starts and cannot overlap a closed settlement.",
          },
          {
            id: "includeProvisionalActivity",
            label: "Include provisional activity",
            type: "checkbox",
            defaultValue: false,
            description: "If enabled, result remains Provisional and cannot be closed.",
          },
        ],
      },
      {
        id: "close-reopen",
        title: "Close or reopen",
        description:
          "Close freezes the source snapshot and totals. Reopen requires elevated permission, a mandatory reason, and an audit event; recalculation creates a new version rather than overwriting the closed result.",
        fields: [
          {
            id: "settlementId",
            label: "Settlement",
            type: "select",
            required: true,
            relation: { workspaceId: "commercial", moduleId: "settlements" },
          },
          {
            id: "action",
            label: "Action",
            type: "select",
            required: true,
            options: [
              { value: "close", label: "Close and freeze" },
              { value: "reopen", label: "Reopen" },
            ],
          },
          {
            id: "actionReason",
            label: "Reason",
            type: "textarea",
            required: true,
          },
          {
            id: "confirmed",
            label: "I understand this action is audited",
            type: "checkbox",
            required: true,
            defaultValue: false,
          },
        ],
      },
    ],
  },
  {
    key: "commercial.events",
    mode: "create",
    recordKind: "Manual billable event",
    title: "Add manual billable event",
    description:
      "Create an exceptional manual billing input with explicit origin and evidence. Route execution, weight, agreement, and ticket events are generated by their owning workflows and remain read-only here.",
    submitLabel: "Add billable event",
    nameField: "eventReference",
    contextFieldIds: ["projectId", "customerId", "occurredAt", "eventState"],
    sections: [
      {
        id: "origin-scope",
        title: "Origin and scope",
        description:
          "Validation: company and project context are mandatory. Manual origin is fixed; exactly one service evidence reference is required and must belong to the same project and customer.",
        fields: [
          {
            id: "eventReference",
            label: "Event reference",
            type: "text",
            required: true,
            placeholder: "MAN-2026-0001",
          },
          {
            id: "origin",
            label: "Origin",
            type: "select",
            required: true,
            defaultValue: "manual",
            options: [{ value: "manual", label: "Manual adjustment" }],
          },
          {
            id: "projectId",
            label: "Project",
            type: "select",
            required: true,
            relation: { workspaceId: "configure", moduleId: "organization" },
          },
          {
            id: "customerId",
            label: "Customer",
            type: "select",
            required: true,
            relation: { workspaceId: "customers", moduleId: "properties" },
            description:
              "Relationship: billed customer. Property, payer, and agreement must resolve within the same project.",
          },
          {
            id: "payerReference",
            label: "Payer reference",
            type: "text",
            required: true,
          },
          {
            id: "agreementId",
            label: "Agreement",
            type: "select",
            required: true,
            relation: { workspaceId: "customers", moduleId: "agreements" },
          },
          {
            id: "evidenceReference",
            label: "Service, ticket, or weight evidence",
            type: "text",
            required: true,
            description: "Must resolve to one auditable source record.",
          },
        ],
      },
      {
        id: "charge",
        title: "Charge facts",
        description:
          "Validation: product must be active at Occurred at; quantity is positive; unit matches the product; price, VAT, account, and cost centre must resolve before Ready.",
        fields: [
          {
            id: "productId",
            label: "Product",
            type: "select",
            required: true,
            relation: { workspaceId: "commercial", moduleId: "products" },
          },
          {
            id: "occurredAt",
            label: "Occurred at",
            type: "datetime",
            required: true,
          },
          {
            id: "quantity",
            label: "Quantity",
            type: "number",
            required: true,
            min: 0.01,
          },
          {
            id: "unit",
            label: "Unit",
            type: "select",
            required: true,
            options: [
              { value: "service", label: "Service" },
              { value: "container", label: "Container" },
              { value: "kg", label: "Kilogram" },
              { value: "hour", label: "Hour" },
            ],
          },
          {
            id: "manualAmount",
            label: "Manual amount override",
            type: "number",
            min: 0,
            description:
              "Optional and permission-controlled. Requires an override reason and retains the expected price comparison.",
          },
          {
            id: "overrideReason",
            label: "Override reason",
            type: "textarea",
            description: "Required when Manual amount override is supplied.",
          },
        ],
      },
      {
        id: "readiness",
        title: "Readiness",
        description:
          "A new event is In progress or Ready. Blocked requires an actionable block reason; Invoiced and Cancelled are lifecycle actions and cannot be selected at creation.",
        fields: [
          {
            id: "eventState",
            label: "Initial state",
            type: "select",
            required: true,
            options: [
              { value: "in-progress", label: "In progress" },
              { value: "ready", label: "Ready" },
              { value: "blocked", label: "Blocked" },
            ],
          },
          {
            id: "blockReason",
            label: "Block reason",
            type: "textarea",
            description:
              "Required for Blocked and must say what is missing, who can fix it, and which record/action resolves it.",
          },
          {
            id: "enteredBy",
            label: "Entered by",
            type: "text",
            required: true,
          },
          {
            id: "manualEntryConfirmed",
            label: "Evidence and customer scope verified",
            type: "checkbox",
            required: true,
            defaultValue: false,
          },
        ],
      },
    ],
  },
  {
    key: "commercial.billing",
    mode: "create",
    recordKind: "Billing run",
    title: "Start billing run",
    description:
      "Start a reproducible billing execution from an existing schedule or an explicit date range. This is not the Scheduled Billing configuration, which belongs to finance settings.",
    submitLabel: "Review billing run",
    nameField: "runName",
    contextFieldIds: ["projectId", "runMode", "periodStart", "periodEnd"],
    sections: [
      {
        id: "run-scope",
        title: "Run scope",
        description:
          "Validation: project, period, and currency are fixed for a run. Period-end follows period-start; Since last successful run requires a completed predecessor.",
        fields: [
          {
            id: "runName",
            label: "Run name",
            type: "text",
            required: true,
            placeholder: "Copenhagen monthly · July 2026",
          },
          {
            id: "projectId",
            label: "Project",
            type: "select",
            required: true,
            relation: { workspaceId: "configure", moduleId: "organization" },
          },
          {
            id: "runMode",
            label: "Period source",
            type: "select",
            required: true,
            options: [
              { value: "date-range", label: "Specific date range" },
              { value: "since-last", label: "Since last successful run" },
              { value: "schedule", label: "Configured billing schedule" },
            ],
          },
          {
            id: "scheduleId",
            label: "Billing schedule",
            type: "select",
            relation: { workspaceId: "configure", moduleId: "finance" },
            description: "Required when Period source is Configured billing schedule.",
          },
          {
            id: "periodStart",
            label: "Period starts",
            type: "date",
          },
          {
            id: "periodEnd",
            label: "Period ends",
            type: "date",
            required: true,
          },
          {
            id: "requestedBy",
            label: "Requested by",
            type: "text",
            required: true,
          },
        ],
      },
      {
        id: "selection",
        title: "Selection and bundling",
        description:
          "Relationship: the run selects Ready billable events only. Every considered customer receives an included, skipped, blocked, or failed result with an explicit reason.",
        fields: [
          {
            id: "customerFilter",
            label: "Customer or segment filter",
            type: "text",
            description: "Blank means all eligible customers in project scope.",
          },
          {
            id: "eventCutoff",
            label: "Event cutoff",
            type: "datetime",
            required: true,
          },
          {
            id: "bundleStrategy",
            label: "Invoice bundling",
            type: "select",
            required: true,
            options: [
              { value: "customer", label: "One invoice per customer" },
              { value: "payer", label: "One invoice per payer" },
              { value: "agreement", label: "One invoice per agreement" },
              { value: "property", label: "One invoice per property" },
            ],
          },
          {
            id: "includePreviouslyBlocked",
            label: "Re-evaluate previously blocked events",
            type: "checkbox",
            defaultValue: true,
          },
          {
            id: "dryRun",
            label: "Preview only",
            type: "checkbox",
            defaultValue: true,
            description:
              "Preview stores selection results but does not issue invoices or mark events Invoiced.",
          },
        ],
      },
      {
        id: "confirmation",
        title: "Execution confirmation",
        description:
          "The review step must show counts and reasons before execution. A run stores filters, schedule version, price versions, event IDs, and result per customer for reproducibility.",
        fields: [
          {
            id: "resultRoutingConfirmed",
            label: "I reviewed included, skipped, blocked, and failed groups",
            type: "checkbox",
            required: true,
            defaultValue: false,
          },
          {
            id: "idempotencyReference",
            label: "Run reference",
            type: "text",
            required: true,
            description: "Unique reference prevents duplicate execution of the same reviewed run.",
          },
        ],
      },
    ],
  },
  {
    key: "commercial.invoices",
    mode: "disabled",
    recordKind: "Issued invoice or credit-note action",
    title: "Use invoice correction workflow",
    description:
      "Invoices are generated from billing runs and issued documents are immutable. A credit note is a linked correction document, not an editable invoice or a generic record.",
    submitLabel: "Open invoice action",
    disabledReason:
      "Generic creation is disabled. Create invoices through Billing Runs; select an issued invoice to issue a partial/full credit note, cancel where legally permitted, send, or export.",
    contextFieldIds: ["sourceInvoiceId", "creditType", "creditDate"],
    sections: [
      {
        id: "source-document",
        title: "Source invoice",
        description:
          "Relationship: source invoice must be issued, belong to the active company/project, and have remaining creditable value. Unsent drafts are corrected in the billing workflow instead.",
        fields: [
          {
            id: "sourceInvoiceId",
            label: "Invoice",
            type: "select",
            required: true,
            relation: { workspaceId: "commercial", moduleId: "invoices" },
          },
          {
            id: "creditType",
            label: "Credit type",
            type: "select",
            required: true,
            options: [
              { value: "full", label: "Full credit" },
              { value: "partial", label: "Partial credit" },
            ],
          },
          {
            id: "creditDate",
            label: "Credit-note date",
            type: "date",
            required: true,
          },
          {
            id: "creditReasonCode",
            label: "Reason",
            type: "select",
            required: true,
            options: [
              { value: "service-not-delivered", label: "Service not delivered" },
              { value: "quantity-correction", label: "Quantity correction" },
              { value: "price-correction", label: "Price correction" },
              { value: "duplicate", label: "Duplicate charge" },
              { value: "other", label: "Other" },
            ],
          },
          {
            id: "reasonDetail",
            label: "Reason detail",
            type: "textarea",
            required: true,
          },
        ],
      },
      {
        id: "credit-lines",
        title: "Credit lines",
        description:
          "Validation: every credited line references a source invoice line; quantity and amount cannot exceed the remaining creditable balance; VAT, currency, account, and cost centre are inherited.",
        fields: [
          {
            id: "sourceLineReference",
            label: "Source line",
            type: "text",
            required: true,
          },
          {
            id: "creditQuantity",
            label: "Quantity to credit",
            type: "number",
            required: true,
            min: 0.01,
          },
          {
            id: "creditAmount",
            label: "Amount to credit",
            type: "number",
            required: true,
            min: 0.01,
            description: "Must not exceed the source line's uncredited amount.",
          },
          {
            id: "customerReference",
            label: "Customer-facing reference",
            type: "text",
          },
        ],
      },
      {
        id: "issue",
        title: "Issue and audit",
        description:
          "Issuing assigns an immutable credit-note number, links it to the source invoice and billing run, and records the actor, reason, and delivery/export result.",
        fields: [
          {
            id: "requestedBy",
            label: "Requested by",
            type: "text",
            required: true,
          },
          {
            id: "issueImmediately",
            label: "Issue immediately after review",
            type: "checkbox",
            defaultValue: false,
          },
          {
            id: "confirmation",
            label: "I reviewed tax and remaining creditable value",
            type: "checkbox",
            required: true,
            defaultValue: false,
          },
        ],
      },
    ],
  },
  {
    key: "improve.intelligence",
    mode: "disabled",
    recordKind: "Ask, monitor, insight, report, or trust record",
    title: "Choose an Intelligence workflow",
    description:
      "Ask, Monitor, Report, and Trust are distinct governed workflows. Insights are generated evidence records; reports and monitors have their own schedules, recipients, metrics, and permissions.",
    submitLabel: "Choose workflow",
    disabledReason:
      "Generic creation is disabled. Use Ask a question, Create monitor, Create report, or Define metric; generated insights cannot be manually invented.",
    contextFieldIds: ["projectId", "metricId", "analysisFrom", "analysisTo"],
    sections: [
      {
        id: "ask",
        title: "Ask a governed question",
        description:
          "Validation: project/data scope, period, grain, and metric are explicit. Missing values remain missing, not zero; incompatible aggregations are rejected. Asking cannot mutate business data.",
        fields: [
          {
            id: "question",
            label: "Question",
            type: "textarea",
            required: true,
            placeholder: "Why did completed routes fall last week?",
          },
          {
            id: "projectId",
            label: "Project",
            type: "select",
            required: true,
            relation: { workspaceId: "configure", moduleId: "organization" },
          },
          {
            id: "metricId",
            label: "Governed metric",
            type: "select",
            required: true,
            relation: { workspaceId: "improve", moduleId: "compliance" },
          },
          {
            id: "analysisFrom",
            label: "From",
            type: "date",
            required: true,
          },
          {
            id: "analysisTo",
            label: "To",
            type: "date",
            required: true,
          },
          {
            id: "comparison",
            label: "Comparison",
            type: "select",
            options: [
              { value: "none", label: "No comparison" },
              { value: "previous-period", label: "Previous period" },
              { value: "previous-year", label: "Previous year" },
              { value: "target", label: "Target" },
            ],
          },
        ],
      },
      {
        id: "monitor",
        title: "Monitor definition",
        description:
          "Relationship: monitor uses a governed metric and scoped audience. Validation: condition, evaluation window, freshness tolerance, and channel are required.",
        fields: [
          {
            id: "monitorName",
            label: "Monitor name",
            type: "text",
            required: true,
          },
          {
            id: "condition",
            label: "Alert condition",
            type: "textarea",
            required: true,
          },
          {
            id: "evaluationWindow",
            label: "Evaluation window",
            type: "select",
            required: true,
            options: [
              { value: "hourly", label: "Hourly" },
              { value: "daily", label: "Daily" },
              { value: "weekly", label: "Weekly" },
              { value: "monthly", label: "Monthly" },
            ],
          },
          {
            id: "freshnessToleranceHours",
            label: "Maximum source age",
            type: "number",
            required: true,
            min: 1,
            unit: "hours",
          },
          {
            id: "recipientRoles",
            label: "Recipient roles",
            type: "text",
            required: true,
          },
        ],
      },
      {
        id: "report",
        title: "Report definition",
        description:
          "Validation: report type, period, metrics, audience, access classification, format, and delivery destination are explicit. Email delivery cannot expose data beyond recipient project permissions.",
        fields: [
          {
            id: "reportName",
            label: "Report name",
            type: "text",
            required: true,
          },
          {
            id: "reportType",
            label: "Report type",
            type: "select",
            required: true,
            options: [
              { value: "management", label: "Management report" },
              { value: "regulatory", label: "Regulatory report" },
              { value: "data-extract", label: "Data extract" },
              { value: "digest", label: "Operational digest" },
            ],
          },
          {
            id: "metricSelection",
            label: "Metric IDs",
            type: "textarea",
            required: true,
          },
          {
            id: "reportSchedule",
            label: "Schedule",
            type: "select",
            options: [
              { value: "manual", label: "Manual only" },
              { value: "daily", label: "Daily" },
              { value: "weekly", label: "Weekly" },
              { value: "monthly", label: "Monthly" },
            ],
          },
          {
            id: "deliveryDestination",
            label: "Delivery destination",
            type: "text",
            description: "Required for a scheduled report.",
          },
        ],
      },
      {
        id: "trust",
        title: "Trust and insight evidence",
        description:
          "Every insight/report exposes metric definition and version, source lineage, freshness, limits, scope, and feedback. Public exposure is off by default and privacy thresholds apply to cohorts.",
        fields: [
          {
            id: "metricDefinitionVersion",
            label: "Metric definition version",
            type: "text",
            required: true,
          },
          {
            id: "sourceLineage",
            label: "Source lineage",
            type: "textarea",
            required: true,
          },
          {
            id: "knownLimitations",
            label: "Known limitations",
            type: "textarea",
            required: true,
          },
          {
            id: "publicExposure",
            label: "Allow public exposure",
            type: "checkbox",
            defaultValue: false,
            description: "Requires separate approval and privacy-threshold validation.",
          },
        ],
      },
    ],
  },
  {
    key: "improve.analytics",
    mode: "create",
    recordKind: "Analytics dashboard",
    title: "Create dashboard",
    description:
      "Create a scoped dashboard backed by governed metrics and saved filters. Existing classic dashboards remain available until functional and data parity is confirmed.",
    submitLabel: "Create dashboard",
    nameField: "dashboardName",
    contextFieldIds: ["projectId", "audience", "defaultPeriod"],
    sections: [
      {
        id: "dashboard",
        title: "Dashboard definition",
        description:
          "Validation: name, scope, audience, and at least one governed metric are required. Viewer permissions always narrow the saved scope.",
        fields: [
          {
            id: "dashboardName",
            label: "Dashboard name",
            type: "text",
            required: true,
          },
          {
            id: "projectId",
            label: "Project",
            type: "select",
            required: true,
            relation: { workspaceId: "configure", moduleId: "organization" },
          },
          {
            id: "audience",
            label: "Audience",
            type: "select",
            required: true,
            options: [
              { value: "private", label: "Only me" },
              { value: "team", label: "Selected team" },
              { value: "project", label: "Project members" },
              { value: "service-provider", label: "Restricted service provider audience" },
            ],
          },
          {
            id: "metricIds",
            label: "Governed metric IDs",
            type: "textarea",
            required: true,
            description:
              "Relationship: active metric definitions from Intelligence / Trust. At least one is required.",
          },
          {
            id: "defaultPeriod",
            label: "Default period",
            type: "select",
            required: true,
            options: [
              { value: "today", label: "Today" },
              { value: "last-7-days", label: "Last 7 days" },
              { value: "last-30-days", label: "Last 30 days" },
              { value: "month-to-date", label: "Month to date" },
              { value: "custom", label: "Custom" },
            ],
          },
        ],
      },
      {
        id: "saved-view",
        title: "Initial saved view",
        description:
          "Filters, grouping, grain, comparison, and missing-value behavior are stored explicitly so the dashboard is reproducible.",
        fields: [
          {
            id: "filterDefinition",
            label: "Filters",
            type: "textarea",
            description: "Use governed dimensions only.",
          },
          {
            id: "groupBy",
            label: "Group by",
            type: "text",
          },
          {
            id: "timeGrain",
            label: "Time grain",
            type: "select",
            options: [
              { value: "hour", label: "Hour" },
              { value: "day", label: "Day" },
              { value: "week", label: "Week" },
              { value: "month", label: "Month" },
            ],
          },
          {
            id: "showMissingAsZero",
            label: "Display missing values as zero",
            type: "checkbox",
            defaultValue: false,
            description:
              "Off by default. It may be enabled only when the selected metric definition declares zero-safe missing behavior.",
          },
        ],
      },
    ],
  },
  {
    key: "improve.autopilot",
    mode: "create",
    recordKind: "Automation flow version",
    title: "Create automation flow",
    description:
      "Create a versioned flow that can generate suggestions, simulations, approvals, registered actions, executions, and impact records. A suggestion never applies a change by itself.",
    submitLabel: "Create draft flow",
    nameField: "flowName",
    contextFieldIds: ["projectId", "triggerType", "riskLevel", "validFrom"],
    sections: [
      {
        id: "identity-scope",
        title: "Identity and scope",
        description:
          "Validation: flow code is unique, project scope is explicit, and a new revision creates a version rather than overwriting history.",
        fields: [
          {
            id: "flowName",
            label: "Flow name",
            type: "text",
            required: true,
          },
          {
            id: "flowCode",
            label: "Flow code",
            type: "text",
            required: true,
            placeholder: "MISSED-COLLECTION-RECOVERY",
          },
          {
            id: "projectId",
            label: "Project",
            type: "select",
            required: true,
            relation: { workspaceId: "configure", moduleId: "organization" },
          },
          {
            id: "validFrom",
            label: "Effective from",
            type: "date",
            required: true,
          },
          {
            id: "changeReason",
            label: "Version reason",
            type: "textarea",
            required: true,
          },
        ],
      },
      {
        id: "trigger-suggestion",
        title: "Trigger and suggestion",
        description:
          "Validation: trigger source, condition, evaluation window, and evidence payload are explicit. The first output is a suggestion with reasons and expected impact.",
        fields: [
          {
            id: "triggerType",
            label: "Trigger",
            type: "select",
            required: true,
            options: [
              { value: "event", label: "Business event" },
              { value: "schedule", label: "Schedule" },
              { value: "monitor", label: "Intelligence monitor" },
              { value: "manual", label: "Manual evaluation" },
            ],
          },
          {
            id: "triggerSource",
            label: "Trigger source",
            type: "text",
            required: true,
          },
          {
            id: "condition",
            label: "Condition",
            type: "textarea",
            required: true,
          },
          {
            id: "suggestionTemplate",
            label: "Suggestion and explanation template",
            type: "textarea",
            required: true,
          },
          {
            id: "expectedImpactMetric",
            label: "Expected-impact metric",
            type: "select",
            required: true,
            relation: { workspaceId: "improve", moduleId: "compliance" },
          },
        ],
      },
      {
        id: "action-governance",
        title: "Action and governance",
        description:
          "Relationship: action must exist in the approved action registry. High-risk actions require approval. Simulation assumptions and shadow-mode period are recorded before activation.",
        fields: [
          {
            id: "registeredAction",
            label: "Registered action",
            type: "text",
            required: true,
            description: "Must resolve to an enabled, typed action contract.",
          },
          {
            id: "riskLevel",
            label: "Risk level",
            type: "select",
            required: true,
            options: [
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
              { value: "critical", label: "Critical" },
            ],
          },
          {
            id: "approvalGate",
            label: "Approval gate",
            type: "select",
            required: true,
            options: [
              { value: "none", label: "No approval" },
              { value: "single", label: "One approver" },
              { value: "dual", label: "Two approvers" },
            ],
            description: "High and Critical risk cannot use No approval.",
          },
          {
            id: "simulationPeriodDays",
            label: "Replay period",
            type: "number",
            required: true,
            min: 1,
            unit: "days",
          },
          {
            id: "simulationAssumptions",
            label: "Simulation assumptions",
            type: "textarea",
            required: true,
          },
          {
            id: "shadowMode",
            label: "Start in shadow mode",
            type: "checkbox",
            defaultValue: true,
          },
        ],
      },
    ],
  },
  {
    key: "improve.imports",
    mode: "disabled",
    recordKind: "Import or export job",
    title: "Choose import or export",
    description:
      "Imports and exports are unlike job workflows. Settings owns credentials and mappings; Job Center owns uploaded/source files, validation, run results, row errors, retries, and downloadable outputs.",
    submitLabel: "Choose job type",
    disabledReason:
      "Generic creation is disabled. Start an Import wizard or Export wizard so data type, mapping version, permissions, validation, destination, and retry behavior are explicit.",
    contextFieldIds: ["projectId", "jobType", "dataType", "mappingId"],
    sections: [
      {
        id: "import-job",
        title: "Import job",
        description:
          "Validation: project, data type, source file, configured mapping version, and write permission are required. Preflight reports exact valid, invalid, skipped, and duplicate rows before commit.",
        fields: [
          {
            id: "jobType",
            label: "Job type",
            type: "select",
            required: true,
            options: [
              { value: "import", label: "Import" },
              { value: "export", label: "Export" },
            ],
          },
          {
            id: "projectId",
            label: "Project",
            type: "select",
            required: true,
            relation: { workspaceId: "configure", moduleId: "organization" },
          },
          {
            id: "dataType",
            label: "Data type",
            type: "select",
            required: true,
            options: [
              { value: "customers", label: "Customers and properties" },
              { value: "agreements", label: "Agreements" },
              { value: "assets", label: "Containers and assets" },
              { value: "products", label: "Products" },
              { value: "prices", label: "Price lists" },
              { value: "routes", label: "Routes and plans" },
              { value: "weights", label: "Weights" },
              { value: "finance", label: "Finance data" },
            ],
          },
          {
            id: "sourceFile",
            label: "Source file",
            type: "text",
            required: true,
            description: "Reference to the uploaded file; original is retained for audit.",
          },
          {
            id: "mappingId",
            label: "Configured mapping",
            type: "select",
            required: true,
            relation: { workspaceId: "configure", moduleId: "integrations" },
          },
          {
            id: "partialCommit",
            label: "Commit valid rows when other rows fail",
            type: "checkbox",
            defaultValue: false,
            description:
              "When enabled, the result must identify the exact committed, rejected, skipped, and duplicate row IDs.",
          },
        ],
      },
      {
        id: "export-job",
        title: "Export job or schedule",
        description:
          "Validation: export permission is separate from read permission. Scope, fields, format, destination, retention, and schedule are explicit and recorded in audit history.",
        fields: [
          {
            id: "exportScope",
            label: "Export scope and filters",
            type: "textarea",
            required: true,
          },
          {
            id: "exportFormat",
            label: "Format",
            type: "select",
            required: true,
            options: [
              { value: "csv", label: "CSV" },
              { value: "xlsx", label: "Excel" },
              { value: "json", label: "JSON" },
              { value: "xml", label: "XML" },
              { value: "pdf", label: "PDF report" },
            ],
          },
          {
            id: "destinationId",
            label: "Destination",
            type: "select",
            required: true,
            relation: { workspaceId: "configure", moduleId: "integrations" },
          },
          {
            id: "schedule",
            label: "Schedule",
            type: "select",
            required: true,
            options: [
              { value: "manual", label: "Run once" },
              { value: "daily", label: "Daily" },
              { value: "weekly", label: "Weekly" },
              { value: "monthly", label: "Monthly" },
            ],
          },
          {
            id: "retentionDays",
            label: "Retain output",
            type: "number",
            required: true,
            min: 1,
            unit: "days",
          },
          {
            id: "requestedBy",
            label: "Requested by",
            type: "text",
            required: true,
          },
        ],
      },
      {
        id: "job-result",
        title: "Run, errors, and retry",
        description:
          "Generated result records are read-only. Each error identifies row/record, field, rejected value, rule, and recommended fix. Retry references the original job and processes only eligible failed items.",
        fields: [
          {
            id: "sourceJobId",
            label: "Source job",
            type: "select",
            required: true,
            relation: { workspaceId: "improve", moduleId: "imports" },
          },
          {
            id: "retryFailedOnly",
            label: "Retry failed items only",
            type: "checkbox",
            defaultValue: true,
          },
          {
            id: "retryReason",
            label: "Retry reason",
            type: "textarea",
            required: true,
          },
        ],
      },
    ],
  },
  {
    key: "improve.performance",
    mode: "create",
    recordKind: "Performance scorecard",
    title: "Create performance scorecard",
    description:
      "Create a governed scorecard for an explicit project, team, service provider, or service area. Metrics retain their definition versions and privacy restrictions.",
    submitLabel: "Create scorecard",
    nameField: "scorecardName",
    contextFieldIds: ["projectId", "subjectType", "period", "validFrom"],
    sections: [
      {
        id: "scope",
        title: "Scorecard scope",
        description:
          "Validation: project and subject are required and must be compatible. Service provider scorecards may use only awarded areas and must not expose customer prices or individual driver data without permission.",
        fields: [
          {
            id: "scorecardName",
            label: "Scorecard name",
            type: "text",
            required: true,
          },
          {
            id: "projectId",
            label: "Project",
            type: "select",
            required: true,
            relation: { workspaceId: "configure", moduleId: "organization" },
          },
          {
            id: "subjectType",
            label: "Subject",
            type: "select",
            required: true,
            options: [
              { value: "project", label: "Project" },
              { value: "team", label: "Team" },
              { value: "service-provider", label: "Service provider" },
              { value: "service-area", label: "Service area" },
              { value: "route-scheme", label: "Route scheme" },
            ],
          },
          {
            id: "serviceProviderId",
            label: "Service provider",
            type: "select",
            relation: { workspaceId: "service-providers", moduleId: "service-providers" },
            description: "Required for Service provider or Service area subject.",
          },
          {
            id: "serviceAreaId",
            label: "Service area",
            type: "select",
            relation: { workspaceId: "service-providers", moduleId: "service-areas" },
          },
        ],
      },
      {
        id: "metrics-version",
        title: "Metrics and effective version",
        description:
          "Relationship: metrics come from the governed catalogue. Validation: incompatible grains or aggregation methods cannot share a total; weighting must sum to 100%.",
        fields: [
          {
            id: "metricIds",
            label: "Metric IDs and weights",
            type: "textarea",
            required: true,
          },
          {
            id: "period",
            label: "Evaluation period",
            type: "select",
            required: true,
            options: [
              { value: "daily", label: "Daily" },
              { value: "weekly", label: "Weekly" },
              { value: "monthly", label: "Monthly" },
              { value: "quarterly", label: "Quarterly" },
            ],
          },
          {
            id: "validFrom",
            label: "Effective from",
            type: "date",
            required: true,
          },
          {
            id: "validTo",
            label: "Effective until",
            type: "date",
          },
          {
            id: "minimumCohortSize",
            label: "Minimum privacy cohort",
            type: "number",
            required: true,
            min: 3,
            description:
              "Required when results could identify people; must meet or exceed the active privacy policy.",
          },
        ],
      },
    ],
  },
  {
    key: "improve.compliance",
    mode: "disabled",
    recordKind: "Report, metric, trust, or exposure action",
    title: "Use Reports & Trust workflow",
    description:
      "Reports & Trust is a governed Intelligence area retained as a current navigation module. Metric versions, scheduled reports, AI audit, exposure, feedback, and retraction are distinct records and actions.",
    submitLabel: "Open Reports & Trust",
    disabledReason:
      "Generic creation is disabled. Use Define metric, Create report, Review exposure, or Retract output so lineage, privacy, approval, and immutable history are preserved.",
    contextFieldIds: ["projectId", "recordType", "validFrom", "classification"],
    sections: [
      {
        id: "metric-definition",
        title: "Metric definition version",
        description:
          "Validation: key, formula, unit, grain, aggregation, sources, freshness target, effective dates, and missing-value policy are mandatory. Published versions are immutable.",
        fields: [
          {
            id: "metricName",
            label: "Metric name",
            type: "text",
            required: true,
          },
          {
            id: "metricKey",
            label: "Metric key",
            type: "text",
            required: true,
          },
          {
            id: "formula",
            label: "Definition and formula",
            type: "textarea",
            required: true,
          },
          {
            id: "unit",
            label: "Unit",
            type: "text",
            required: true,
          },
          {
            id: "grain",
            label: "Supported grain",
            type: "text",
            required: true,
          },
          {
            id: "aggregation",
            label: "Aggregation method",
            type: "select",
            required: true,
            options: [
              { value: "sum", label: "Sum" },
              { value: "average", label: "Average" },
              { value: "weighted-average", label: "Weighted average" },
              { value: "ratio", label: "Ratio from components" },
              { value: "non-additive", label: "Non-additive" },
            ],
          },
          {
            id: "missingValuePolicy",
            label: "Missing-value policy",
            type: "textarea",
            required: true,
          },
          {
            id: "sourceLineage",
            label: "Source lineage",
            type: "textarea",
            required: true,
          },
          {
            id: "validFrom",
            label: "Effective from",
            type: "date",
            required: true,
          },
        ],
      },
      {
        id: "governed-report",
        title: "Governed report",
        description:
          "Relationship: report pins metric versions and source cutoff. Validation: project scope, audience, classification, period, format, retention, and delivery permission are explicit.",
        fields: [
          {
            id: "recordType",
            label: "Record type",
            type: "select",
            required: true,
            options: [
              { value: "report", label: "Report" },
              { value: "metric", label: "Metric definition" },
              { value: "exposure-review", label: "Exposure review" },
            ],
          },
          {
            id: "projectId",
            label: "Project",
            type: "select",
            required: true,
            relation: { workspaceId: "configure", moduleId: "organization" },
          },
          {
            id: "classification",
            label: "Data classification",
            type: "select",
            required: true,
            options: [
              { value: "internal", label: "Internal" },
              { value: "restricted", label: "Restricted" },
              { value: "confidential", label: "Confidential" },
              { value: "public-approved", label: "Public · approved" },
            ],
          },
          {
            id: "metricVersions",
            label: "Pinned metric versions",
            type: "textarea",
            required: true,
          },
          {
            id: "retentionDays",
            label: "Retention",
            type: "number",
            required: true,
            min: 1,
            unit: "days",
          },
        ],
      },
      {
        id: "ai-audit-retraction",
        title: "AI audit and retraction",
        description:
          "Every generated output records prompt/question, model/service version, source cutoff, actor, scope, feedback, and exposure. Retraction preserves the original and adds status, reason, actor, and timestamp.",
        fields: [
          {
            id: "outputId",
            label: "Generated output",
            type: "text",
            required: true,
          },
          {
            id: "action",
            label: "Action",
            type: "select",
            required: true,
            options: [
              { value: "approve-exposure", label: "Approve exposure" },
              { value: "restrict", label: "Restrict exposure" },
              { value: "retract", label: "Retract output" },
            ],
          },
          {
            id: "actionReason",
            label: "Reason",
            type: "textarea",
            required: true,
          },
          {
            id: "sensitiveAccessReason",
            label: "Sensitive-access reason",
            type: "textarea",
            description: "Required when reviewing confidential source data.",
          },
        ],
      },
    ],
  },
  {
    key: "control-center.control-center",
    mode: "disabled",
    recordKind: "Lead, offer, subscription, entitlement, or marketplace order",
    title: "Choose a Control Center workflow",
    description:
      "Internal administration, tenant self-service, and marketplace checkout have separate permission boundaries. Leads, offers, subscriptions, entitlements, and orders are linked but never interchangeable records.",
    submitLabel: "Choose workflow",
    disabledReason:
      "Generic creation is disabled. Use New lead, Build offer, Activate subscription, Grant entitlement, or Start marketplace order; each enforces its own lifecycle and financial authority.",
    contextFieldIds: ["recordType", "tenantId", "projectId", "effectiveFrom"],
    sections: [
      {
        id: "lead",
        title: "Sales lead",
        description:
          "Validation: source, organization, contact route, region, expected value, and next action are required. A lead grants no tenant, portal, feature, or marketplace access.",
        fields: [
          {
            id: "recordType",
            label: "Workflow",
            type: "select",
            required: true,
            options: [
              { value: "lead", label: "New lead" },
              { value: "offer", label: "Build offer" },
              { value: "subscription", label: "Activate subscription" },
              { value: "order", label: "Marketplace order" },
            ],
          },
          {
            id: "leadOrganization",
            label: "Organization",
            type: "text",
            required: true,
          },
          {
            id: "leadSource",
            label: "Lead source",
            type: "select",
            required: true,
            options: [
              { value: "inbound", label: "Inbound" },
              { value: "partner", label: "Partner" },
              { value: "outbound", label: "Outbound" },
              { value: "marketplace", label: "Marketplace" },
            ],
          },
          {
            id: "contactName",
            label: "Contact",
            type: "text",
            required: true,
          },
          {
            id: "expectedValue",
            label: "Expected value",
            type: "number",
            min: 0,
          },
          {
            id: "nextAction",
            label: "Next action",
            type: "textarea",
            required: true,
          },
        ],
      },
      {
        id: "offer",
        title: "Offer",
        description:
          "Relationship: offer may originate from one lead and contains explicit commercial products/features, quantities, prices, validity, billing terms, implementation scope, and approver.",
        fields: [
          {
            id: "leadId",
            label: "Source lead",
            type: "select",
            relation: { workspaceId: "control-center", moduleId: "control-center" },
          },
          {
            id: "tenantId",
            label: "Target tenant",
            type: "select",
            relation: { workspaceId: "configure", moduleId: "organization" },
            description: "Optional until the prospect tenant exists.",
          },
          {
            id: "offerValidUntil",
            label: "Offer valid until",
            type: "date",
            required: true,
          },
          {
            id: "productAndFeatures",
            label: "Products, features, quantities, and prices",
            type: "textarea",
            required: true,
            description:
              "Every line must map to a commercial product or feature catalogue item and state currency and billing cadence.",
          },
          {
            id: "billingTerms",
            label: "Billing terms",
            type: "textarea",
            required: true,
          },
          {
            id: "implementationScope",
            label: "Implementation scope",
            type: "textarea",
            required: true,
          },
          {
            id: "offerApprover",
            label: "Approver",
            type: "text",
            required: true,
          },
        ],
      },
      {
        id: "subscription-entitlements",
        title: "Subscription and entitlements",
        description:
          "Validation: accepted offer/order lines map explicitly to plan, feature, project, portal rights, seat/usage limits, and effective dates. Failed payment or incomplete billing details cannot create access.",
        fields: [
          {
            id: "acceptedOfferId",
            label: "Accepted offer",
            type: "select",
            required: true,
            relation: { workspaceId: "control-center", moduleId: "control-center" },
          },
          {
            id: "projectId",
            label: "Project scope",
            type: "select",
            relation: { workspaceId: "configure", moduleId: "organization" },
          },
          {
            id: "planCode",
            label: "Subscription plan",
            type: "text",
            required: true,
          },
          {
            id: "entitlementMapping",
            label: "Feature and portal entitlement mapping",
            type: "textarea",
            required: true,
          },
          {
            id: "seatOrUsageLimits",
            label: "Seat or usage limits",
            type: "textarea",
            required: true,
          },
          {
            id: "effectiveFrom",
            label: "Effective from",
            type: "date",
            required: true,
          },
          {
            id: "effectiveUntil",
            label: "Effective until",
            type: "date",
          },
          {
            id: "billingVerified",
            label: "Billing details and payment state verified",
            type: "checkbox",
            required: true,
            defaultValue: false,
          },
        ],
      },
      {
        id: "marketplace-order",
        title: "Marketplace order",
        description:
          "Order records preserve cart, checkout, payment, fulfillment, entitlement mapping, and failure states. Hardware lines also require stock/availability, shipping, and fulfillment ownership.",
        fields: [
          {
            id: "buyerTenantId",
            label: "Buyer tenant",
            type: "select",
            required: true,
            relation: { workspaceId: "configure", moduleId: "organization" },
          },
          {
            id: "cartLines",
            label: "Cart lines and quantities",
            type: "textarea",
            required: true,
          },
          {
            id: "billingReference",
            label: "Billing reference",
            type: "text",
            required: true,
          },
          {
            id: "paymentState",
            label: "Payment state",
            type: "select",
            required: true,
            options: [
              { value: "pending", label: "Pending" },
              { value: "authorized", label: "Authorized" },
              { value: "paid", label: "Paid" },
              { value: "failed", label: "Failed" },
            ],
          },
          {
            id: "containsHardware",
            label: "Includes hardware",
            type: "checkbox",
            defaultValue: false,
          },
          {
            id: "shippingAndFulfillment",
            label: "Shipping and fulfillment",
            type: "textarea",
            description:
              "Required for hardware; includes availability check, destination, carrier or fulfiller, and promised date.",
          },
          {
            id: "grantAfterFulfillment",
            label: "Grant entitlement after payment/fulfillment",
            type: "checkbox",
            defaultValue: true,
            description:
              "Entitlements remain pending while payment, billing details, or required fulfillment is incomplete.",
          },
        ],
      },
    ],
  },
] as const satisfies readonly BusinessFormSchema[]

// Apply index is the service-provider-prices module's bulk maintenance workflow.
// The module key now resolves to the New service provider price create schema, so
// this action lives outside the registry and is offered via schemaOverride
// (the Price Engine module header's secondary button). Unlike registry
// schemas, it carries its execution policy inline.
export const serviceProviderPriceIndexationFormSchema: BusinessFormSchema = {
  key: "commercial.service-provider-prices.apply-index",
  mode: "action",
  recordKind: "Service provider price indexation",
  title: "Apply index",
  description:
    "Recompute current fees for the selected service provider prices. The base is the original bid or the current fee (current compounds earlier changes; the bid never moves). Each run appends to the indexation history.",
  submitLabel: "Apply index",
  contextFieldIds: ["indexLabel", "percent", "effectiveFrom"],
  execution: {
    kind: "start-workflow",
    reviewBeforeSubmit: true,
    completionMessage: "Index applied — current fees recomputed, bids untouched.",
  },
  sections: [
    {
      id: "index-scope",
      title: "Scope",
      fields: [
        {
          id: "rateIds",
          label: "Service provider prices",
          type: "multiselect",
          required: true,
          relation: { workspaceId: "commercial", moduleId: "service-provider-prices" },
          description: "Pick the rows to index — filter by service provider or service area as you select.",
        },
      ],
    },
    {
      id: "index-terms",
      title: "Index terms",
      fields: [
        { id: "indexLabel", label: "Index", type: "text", required: true, placeholder: "CPI" },
        { id: "percent", label: "Percent", type: "number", required: true, unit: "%" },
        {
          id: "base",
          label: "Base",
          type: "select",
          required: true,
          defaultValue: "current fee",
          options: [
            { value: "current fee", label: "Current fee (compounds earlier changes)" },
            { value: "bid", label: "Original bid (never moves)" },
          ],
        },
        { id: "effectiveFrom", label: "Effective from", type: "date", required: true, defaultValue: "2026-08-20" },
      ],
    },
  ],
}
