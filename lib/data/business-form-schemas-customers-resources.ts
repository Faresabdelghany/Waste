import type { BusinessFormSchema } from "@/lib/data/business-form-types"

const projectRelation = {
  workspaceId: "configure",
  moduleId: "organization",
  allowedRecordIds: ["project-copenhagen", "project-harbor"],
} as const

const customerOrCompanyRelation = {
  workspaceId: "customers",
  moduleId: "contacts",
} as const

const propertyRelation = {
  workspaceId: "customers",
  moduleId: "properties",
} as const

const sourceOptions = [
  { value: "manual", label: "Entered by an office user" },
  { value: "import-job", label: "Validated import job" },
  { value: "integration", label: "Connected integration" },
] as const

const recordStateOptions = [
  { value: "draft", label: "Draft" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
] as const

/**
 * Entity-specific contracts for the current Customers and Resources tabs.
 *
 * `mode: "create"` means the tab owns creation of the named entity.
 * `mode: "action"` means the primary button must launch the governed domain
 * action described by the schema; it must not append a generic table record.
 *
 * Cross-field validation is stated in section and field descriptions because
 * the shared form contract intentionally keeps its validation vocabulary
 * limited to required, range, relation, and option constraints.
 */
export const customerResourceBusinessFormSchemas: readonly BusinessFormSchema[] = [
  {
    key: "customers.properties",
    mode: "create",
    recordKind: "Property",
    title: "Create property",
    description: "",
    submitLabel: "Create property",
    nameField: "displayName",
    contextFieldIds: ["projectId", "serviceAddress", "ownerCustomerId"],
    sections: [
      {
        id: "scope-source",
        title: "Scope and source",
        fields: [
          {
            id: "projectId",
            label: "Operating project",
            type: "select",
            required: true,
            relation: projectRelation,
          },
          {
            id: "source",
            label: "Record source",
            type: "select",
            required: true,
            defaultValue: "manual",
            options: [
              ...sourceOptions,
              { value: "property-registry", label: "Property registry lookup" },
            ],
          },
        ],
      },
      {
        id: "identity-address",
        title: "Property identity and service address",
        fields: [
          {
            id: "displayName",
            label: "Property name",
            type: "text",
            required: true,
            placeholder: "Parkvej 18",
          },
          {
            id: "serviceAddress",
            label: "Service address",
            type: "textarea",
            required: true,
            placeholder: "Street, number, postal code, city, country",
          },
          {
            id: "registryId",
            label: "Property registry identifier",
            type: "text",
            description:
              "Required when the source is a registry; must resolve to the selected project and retain source provenance.",
          },
          {
            id: "buildingIdentifier",
            label: "Building or cadastral identifier",
            type: "text",
          },
          {
            id: "propertyType",
            label: "Property type",
            type: "select",
            required: true,
            options: [
              { value: "residential", label: "Residential" },
              { value: "commercial", label: "Commercial" },
              { value: "public", label: "Public body or institution" },
              { value: "mixed", label: "Mixed use" },
              { value: "other", label: "Other" },
            ],
          },
        ],
      },
      {
        id: "parties",
        title: "Connected parties",
        fields: [
          {
            id: "ownerCustomerId",
            label: "Owner or responsible customer",
            type: "select",
            required: true,
            relation: customerOrCompanyRelation,
          },
          {
            id: "payerCustomerId",
            label: "Payer",
            type: "select",
            relation: customerOrCompanyRelation,
          },
          {
            id: "primaryContactId",
            label: "Primary service contact",
            type: "select",
            relation: customerOrCompanyRelation,
          },
          {
            id: "relationshipEffectiveFrom",
            label: "Party relationships effective from",
            type: "date",
            required: true,
          },
        ],
      },
      {
        id: "operating-context",
        title: "Operating context",
        fields: [
          {
            id: "specialConditions",
            label: "Special service conditions",
            type: "textarea",
          },
        ],
      },
    ],
  },
  {
    key: "customers.groups",
    mode: "create",
    recordKind: "Property Group",
    title: "Create property group",
    description:
      "Create an administrative, reporting, or service grouping while preserving every member Property as an independent record.",
    submitLabel: "Create property group",
    nameField: "name",
    contextFieldIds: ["projectId", "purpose", "responsibleCustomerId"],
    ownerField: "recordOwner",
    sections: [
      {
        id: "scope-source",
        title: "Scope and source",
        fields: [
          {
            id: "projectId",
            label: "Operating project",
            type: "select",
            required: true,
            relation: projectRelation,
          },
          {
            id: "source",
            label: "Record source",
            type: "select",
            required: true,
            defaultValue: "manual",
            options: sourceOptions,
          },
          {
            id: "recordOwner",
            label: "Business owner",
            type: "text",
            required: true,
            placeholder: "Customer Service Team",
          },
        ],
      },
      {
        id: "identity-purpose",
        title: "Identity and purpose",
        description:
          "Purpose determines whether membership is descriptive only or may influence service. A reporting-only group cannot change service or price.",
        fields: [
          {
            id: "name",
            label: "Group name",
            type: "text",
            required: true,
          },
          {
            id: "purpose",
            label: "Group purpose",
            type: "select",
            required: true,
            options: [
              { value: "administration", label: "Administration" },
              { value: "reporting", label: "Reporting only" },
              { value: "service", label: "Shared service rules" },
              { value: "agreement", label: "Agreement management" },
            ],
          },
          {
            id: "status",
            label: "Initial state",
            type: "select",
            required: true,
            defaultValue: "draft",
            options: recordStateOptions,
          },
          {
            id: "responsibleCustomerId",
            label: "Responsible customer or company",
            type: "select",
            relation: customerOrCompanyRelation,
          },
        ],
      },
      {
        id: "membership",
        title: "Membership",
        description:
          "The property selector is repeatable. At least one permitted Property is required before activation. A Property may join several groups for different purposes.",
        fields: [
          {
            id: "memberPropertyId",
            label: "Member property",
            type: "select",
            required: true,
            description: "Repeat to add more members; membership retains its own history.",
            relation: propertyRelation,
          },
          {
            id: "membershipRole",
            label: "Default membership role",
            type: "select",
            options: [
              { value: "member", label: "Member" },
              { value: "administrator", label: "Administrator" },
              { value: "payer", label: "Payer" },
              { value: "reporting", label: "Reporting only" },
            ],
          },
        ],
      },
      {
        id: "service-effect",
        title: "Service effect and effective period",
        description:
          "When purpose is Service or Agreement, an effective start date and explicit effect are required. Conflicting active service groups must be resolved before activation.",
        fields: [
          {
            id: "serviceEffect",
            label: "Service effect",
            type: "select",
            required: true,
            defaultValue: "none",
            options: [
              { value: "none", label: "No service effect" },
              { value: "frequency", label: "Collection frequency" },
              { value: "pricing", label: "Price applicability" },
              { value: "agreement", label: "Agreement or subscription rules" },
            ],
          },
          {
            id: "agreementId",
            label: "Related agreement or template",
            type: "select",
            description:
              "Required when the selected service effect is Agreement; the Agreement remains the authoritative commercial record.",
            relation: {
              workspaceId: "customers",
              moduleId: "agreements",
            },
          },
          {
            id: "effectiveFrom",
            label: "Effective from",
            type: "date",
            description: "Required for any service-affecting group.",
          },
          {
            id: "effectiveTo",
            label: "Effective to",
            type: "date",
            description: "Optional; must be later than Effective from.",
          },
        ],
      },
    ],
  },
  {
    key: "customers.shared",
    mode: "create",
    recordKind: "Shared Collection Point",
    title: "Create shared collection point",
    description:
      "Create a physical service location shared by multiple properties or organizations, with explicit membership, access, eligibility, and billing responsibility.",
    submitLabel: "Create draft shared point",
    nameField: "name",
    contextFieldIds: ["projectId", "pointType", "operatingModel"],
    ownerField: "recordOwner",
    sections: [
      {
        id: "scope-source",
        title: "Scope and source",
        fields: [
          {
            id: "projectId",
            label: "Operating project",
            type: "select",
            required: true,
            relation: projectRelation,
          },
          {
            id: "source",
            label: "Record source",
            type: "select",
            required: true,
            defaultValue: "manual",
            options: sourceOptions,
          },
          {
            id: "recordOwner",
            label: "Business owner",
            type: "text",
            required: true,
            placeholder: "Shared Services Team",
          },
        ],
      },
      {
        id: "identity-location",
        title: "Identity and location",
        description:
          "Required validation: name/code and normalized coordinates must not duplicate another active point in the project.",
        fields: [
          {
            id: "name",
            label: "Shared-point name",
            type: "text",
            required: true,
          },
          {
            id: "pointType",
            label: "Collection-point type",
            type: "select",
            required: true,
            options: [
              { value: "surface", label: "Surface containers" },
              { value: "underground", label: "Underground system" },
              { value: "recycling-station", label: "Shared recycling station" },
              { value: "commercial", label: "Commercial shared service" },
              { value: "other", label: "Other" },
            ],
          },
          {
            id: "address",
            label: "Location address",
            type: "textarea",
            required: true,
          },
          {
            id: "latitude",
            label: "Latitude",
            type: "number",
            required: true,
            min: -90,
            max: 90,
          },
          {
            id: "longitude",
            label: "Longitude",
            type: "number",
            required: true,
            min: -180,
            max: 180,
          },
          {
            id: "eligibilityDistance",
            label: "Default eligibility distance",
            type: "number",
            min: 0,
            unit: "m",
            description:
              "Membership outside this distance creates a warning; it never silently rejects or approves the relationship.",
          },
        ],
      },
      {
        id: "operation-access",
        title: "Operating and access model",
        fields: [
          {
            id: "operatingModel",
            label: "Operating model",
            type: "select",
            required: true,
            options: [
              { value: "municipal", label: "Municipal shared service" },
              { value: "member-funded", label: "Member-funded service" },
              { value: "company-operated", label: "Shared-service company" },
              { value: "contractor-operated", label: "Contractor operated" },
            ],
          },
          {
            id: "availability",
            label: "Availability",
            type: "text",
            required: true,
            placeholder: "24/7 or Mon–Fri 06:00–20:00",
          },
          {
            id: "accessMode",
            label: "Access mode",
            type: "select",
            required: true,
            options: [
              { value: "open", label: "Open access" },
              { value: "member", label: "Members only" },
              { value: "credential", label: "Card, key, or code" },
              { value: "restricted", label: "Restricted by schedule or role" },
            ],
          },
          {
            id: "accessConditions",
            label: "Access conditions",
            type: "textarea",
          },
          {
            id: "billingMode",
            label: "Billing responsibility",
            type: "select",
            required: true,
            options: [
              { value: "municipal", label: "Project or municipality" },
              { value: "single-payer", label: "One responsible payer" },
              { value: "member-share", label: "Allocated across members" },
              { value: "usage", label: "Usage based" },
            ],
          },
          {
            id: "responsibleCompanyId",
            label: "Responsible company or payer",
            type: "select",
            description:
              "Required for Single payer and Company-operated models.",
            relation: customerOrCompanyRelation,
          },
          {
            id: "responsibleContactId",
            label: "Responsible contact",
            type: "select",
            relation: customerOrCompanyRelation,
          },
        ],
      },
      {
        id: "membership-effective",
        title: "Initial membership and effective period",
        description:
          "The member selector is repeatable. Each association keeps its role, notifications, eligibility result, and effective history.",
        fields: [
          {
            id: "memberPropertyId",
            label: "Participating property",
            type: "select",
            description: "Optional in Draft; at least one member is required to open.",
            relation: propertyRelation,
          },
          {
            id: "memberRole",
            label: "Membership role",
            type: "select",
            options: [
              { value: "service-member", label: "Service member" },
              { value: "administrator", label: "Administrator" },
              { value: "payer", label: "Payer" },
              { value: "notification-contact", label: "Notification contact" },
            ],
          },
          {
            id: "effectiveFrom",
            label: "Open from",
            type: "date",
            required: true,
          },
          {
            id: "effectiveTo",
            label: "Close after",
            type: "date",
            description: "Optional; must follow Open from.",
          },
        ],
      },
    ],
  },
  {
    key: "customers.contacts",
    mode: "create",
    recordKind: "Contact or Customer Organization",
    title: "Create contact or company",
    description:
      "Create a person or organization and connect it to Properties through explicit roles, authorization, and effective dates.",
    submitLabel: "Create party",
    nameField: "displayName",
    contextFieldIds: ["partyType", "projectScope", "relationshipRole"],
    ownerField: "recordOwner",
    sections: [
      {
        id: "scope-source",
        title: "Scope and source",
        description:
          "A party may be company-wide or introduced through one project. Project scope does not itself grant portal authorization.",
        fields: [
          {
            id: "projectScope",
            label: "Initial data scope",
            type: "select",
            required: true,
            defaultValue: "project",
            options: [
              { value: "project", label: "Selected project" },
              { value: "company", label: "Company-wide customer relationship" },
            ],
          },
          {
            id: "projectId",
            label: "Operating project",
            type: "select",
            description: "Required when Initial data scope is Selected project.",
            relation: projectRelation,
          },
          {
            id: "source",
            label: "Record source",
            type: "select",
            required: true,
            defaultValue: "manual",
            options: [
              ...sourceOptions,
              { value: "business-registry", label: "Business registry lookup" },
            ],
          },
          {
            id: "recordOwner",
            label: "Business owner",
            type: "text",
            required: true,
          },
        ],
      },
      {
        id: "identity",
        title: "Party identity",
        description:
          "Required validation is type-specific: a Person needs a name and at least one service contact method; a Company needs legal name and organization identifier when locally required.",
        fields: [
          {
            id: "partyType",
            label: "Party type",
            type: "select",
            required: true,
            options: [
              { value: "person", label: "Person" },
              { value: "company", label: "Company or organization" },
            ],
          },
          {
            id: "displayName",
            label: "Display or legal name",
            type: "text",
            required: true,
          },
          {
            id: "organizationId",
            label: "Organization identifier",
            type: "text",
            description: "CVR, registry number, or equivalent for a Company.",
          },
          {
            id: "email",
            label: "Email",
            type: "text",
            placeholder: "name@example.com",
          },
          {
            id: "phone",
            label: "Phone",
            type: "text",
          },
          {
            id: "billingAddress",
            label: "Billing or correspondence address",
            type: "textarea",
          },
        ],
      },
      {
        id: "relationship",
        title: "Initial customer relationship",
        description:
          "The relation selector is repeatable. Communication preference, legal authorization, property role, and portal access are separate records.",
        fields: [
          {
            id: "relationshipRole",
            label: "Role",
            type: "select",
            required: true,
            options: [
              { value: "customer", label: "Customer" },
              { value: "owner", label: "Property owner" },
              { value: "tenant", label: "Tenant" },
              { value: "payer", label: "Payer" },
              { value: "administrator", label: "Property administrator" },
              { value: "service-contact", label: "Service contact" },
            ],
          },
          {
            id: "propertyId",
            label: "Connected property",
            type: "select",
            description:
              "Optional for a standalone customer or prospect; required for property-specific roles.",
            relation: propertyRelation,
          },
          {
            id: "connectedCompanyId",
            label: "Connected company",
            type: "select",
            description: "For a Person acting on behalf of an organization.",
            relation: customerOrCompanyRelation,
          },
          {
            id: "effectiveFrom",
            label: "Relationship effective from",
            type: "date",
            required: true,
          },
          {
            id: "effectiveTo",
            label: "Relationship effective to",
            type: "date",
            description: "Optional; must follow Effective from.",
          },
          {
            id: "serviceMessagesAllowed",
            label: "Allow required service messages",
            type: "checkbox",
            defaultValue: true,
            description:
              "This records a delivery preference, not marketing consent or legal portal authorization.",
          },
        ],
      },
    ],
  },
  {
    key: "customers.agreements",
    mode: "create",
    recordKind: "Agreement",
    title: "Create agreement",
    description:
      "Create an effective-dated customer entitlement. Product, Subscription, Price, service address, and payer remain linked records with their own history.",
    submitLabel: "Create draft agreement",
    nameField: "agreementNumber",
    contextFieldIds: ["projectId", "customerId", "payerId"],
    ownerField: "recordOwner",
    sections: [
      {
        id: "scope-source",
        title: "Scope and source",
        fields: [
          {
            id: "projectId",
            label: "Operating project",
            type: "select",
            required: true,
            relation: projectRelation,
          },
          {
            id: "source",
            label: "Agreement source",
            type: "select",
            required: true,
            defaultValue: "manual",
            options: [
              ...sourceOptions,
              { value: "template", label: "Agreement template" },
            ],
          },
          {
            id: "recordOwner",
            label: "Contract owner",
            type: "text",
            required: true,
            placeholder: "Contract Team",
          },
        ],
      },
      {
        id: "identity-parties",
        title: "Agreement identity and parties",
        description:
          "Customer and payer are required before activation and may be different. At least one Property, Property Group, or Shared Point must receive service.",
        fields: [
          {
            id: "agreementNumber",
            label: "Agreement number",
            type: "text",
            required: true,
            description: "Must be unique inside the company.",
          },
          {
            id: "agreementTemplate",
            label: "Agreement template",
            type: "text",
            placeholder: "Municipal Housing v4",
          },
          {
            id: "customerId",
            label: "Customer",
            type: "select",
            required: true,
            relation: customerOrCompanyRelation,
          },
          {
            id: "payerId",
            label: "Payer",
            type: "select",
            required: true,
            relation: customerOrCompanyRelation,
          },
          {
            id: "propertyId",
            label: "Service property",
            type: "select",
            relation: propertyRelation,
          },
          {
            id: "propertyGroupId",
            label: "Service property group",
            type: "select",
            relation: {
              workspaceId: "customers",
              moduleId: "groups",
            },
          },
          {
            id: "sharedPointId",
            label: "Shared collection point",
            type: "select",
            relation: {
              workspaceId: "customers",
              moduleId: "shared",
            },
          },
        ],
      },
      {
        id: "effective-period",
        title: "Effective period",
        description:
          "The start date is mandatory. End date is optional and must follow the start date. Amendments create a new effective version rather than rewriting active or historical meaning.",
        fields: [
          {
            id: "effectiveFrom",
            label: "Effective from",
            type: "date",
            required: true,
          },
          {
            id: "effectiveTo",
            label: "Effective to",
            type: "date",
          },
          {
            id: "billingCadence",
            label: "Billing cadence",
            type: "select",
            required: true,
            options: [
              { value: "monthly", label: "Monthly" },
              { value: "quarterly", label: "Quarterly" },
              { value: "annual", label: "Annual" },
              { value: "manual", label: "Manual" },
            ],
          },
          {
            id: "currency",
            label: "Currency",
            type: "select",
            required: true,
            defaultValue: "DKK",
            options: [
              { value: "DKK", label: "DKK" },
              { value: "NOK", label: "NOK" },
              { value: "EUR", label: "EUR" },
            ],
          },
        ],
      },
      {
        id: "initial-service",
        title: "Initial subscription",
        description:
          "Optional while saving a Draft. Activation validates required product fields, compatible service location/container, valid Price, payer, and service responsibility.",
        fields: [
          {
            id: "productId",
            label: "Product or service",
            type: "select",
            relation: {
              workspaceId: "commercial",
              moduleId: "products",
            },
          },
          {
            id: "priceListId",
            label: "Price list",
            type: "select",
            relation: {
              workspaceId: "commercial",
              moduleId: "pricing",
            },
          },
          {
            id: "serviceFrequency",
            label: "Service frequency",
            type: "text",
            placeholder: "Weekly, every second Thursday, or on demand",
          },
          {
            id: "containerId",
            label: "Assigned container",
            type: "select",
            relation: {
              workspaceId: "resources",
              moduleId: "containers",
            },
          },
          {
            id: "internalNotes",
            label: "Internal contract notes",
            type: "textarea",
            description: "Never shown in the citizen portal.",
          },
        ],
      },
    ],
  },
  {
    key: "customers.citizen-portal",
    mode: "action",
    recordKind: "Portal Preview",
    title: "Preview citizen portal",
    description:
      "Open the project-branded portal as an authorized property user. Portal activity is system-captured; office users must not create generic activity rows.",
    submitLabel: "Open scoped preview",
    contextFieldIds: ["projectId", "propertyId", "authorizationRole"],
    sections: [
      {
        id: "portal-scope",
        title: "Portal scope",
        description:
          "Required validation: the selected contact must have active authorization for the selected Property. Preview never grants access or changes authorization.",
        fields: [
          {
            id: "projectId",
            label: "Portal project",
            type: "select",
            required: true,
            relation: projectRelation,
          },
          {
            id: "portalConfigurationId",
            label: "Published portal configuration",
            type: "select",
            required: true,
            relation: {
              workspaceId: "configure",
              moduleId: "portals",
            },
          },
          {
            id: "propertyId",
            label: "Authorized property",
            type: "select",
            required: true,
            relation: propertyRelation,
          },
          {
            id: "portalUserId",
            label: "Preview as contact",
            type: "select",
            required: true,
            relation: customerOrCompanyRelation,
          },
          {
            id: "authorizationRole",
            label: "Authorization role",
            type: "select",
            required: true,
            options: [
              { value: "resident", label: "Resident" },
              { value: "property-admin", label: "Property administrator" },
              { value: "payer", label: "Payer" },
              { value: "service-contact", label: "Service contact" },
            ],
          },
        ],
      },
      {
        id: "preview",
        title: "Preview context",
        fields: [
          {
            id: "language",
            label: "Language",
            type: "select",
            required: true,
            options: [
              { value: "da", label: "Danish" },
              { value: "en", label: "English" },
              { value: "no", label: "Norwegian" },
              { value: "fi", label: "Finnish" },
            ],
          },
          {
            id: "startArea",
            label: "Start at",
            type: "select",
            required: true,
            defaultValue: "overview",
            options: [
              { value: "overview", label: "Service overview" },
              { value: "calendar", label: "Collection calendar" },
              { value: "containers", label: "Containers" },
              { value: "requests", label: "Requests and tickets" },
              { value: "messages", label: "Messages" },
              { value: "documents", label: "Invoices and documents" },
            ],
          },
          {
            id: "includeDraftContent",
            label: "Include draft branding and content",
            type: "checkbox",
            defaultValue: false,
            description:
              "Available only to portal administrators and clearly marked as preview-only.",
          },
        ],
      },
    ],
  },
  {
    key: "resources.containers",
    mode: "create",
    recordKind: "Container",
    title: "Add container",
    description:
      "Create one physical container in the selected project, configure its fractions and collection inputs, and optionally pair a fill-level sensor.",
    submitLabel: "Add container",
    nameField: "containerId",
    contextFieldIds: ["projectId", "containerType", "serviceAddress"],
    ownerField: "recordOwner",
    execution: {
      kind: "create-record",
      resultValue: "Awaiting first measurement",
      reviewBeforeSubmit: true,
      completionMessage:
        "The container was added to the project registry with configuration and audit history preserved.",
    },
    validationRules: [
      {
        type: "date-order",
        startField: "warrantyStart",
        endField: "warrantyEnd",
        allowSame: true,
        message: "Warranty end must be on or after warranty start.",
      },
      {
        type: "different-values",
        firstField: "wasteFraction",
        secondField: "secondaryWasteFraction",
        message: "The additional fraction must differ from the primary fraction.",
      },
    ],
    sections: [
      {
        id: "scope-source",
        title: "Scope and source",
        description:
          "Every container belongs to one project. Company and project access are validated before the record is created.",
        fields: [
          {
            id: "projectId",
            label: "Operating project",
            type: "select",
            required: true,
            relation: projectRelation,
          },
          {
            id: "source",
            label: "Registration source",
            type: "select",
            required: true,
            defaultValue: "manual",
            options: [
              ...sourceOptions,
              { value: "inventory-receipt", label: "Inventory receipt" },
              { value: "mobile-scan", label: "Mobile scan" },
            ],
          },
          {
            id: "recordOwner",
            label: "Registry owner team",
            type: "text",
            required: true,
            placeholder: "Asset Team",
          },
        ],
      },
      {
        id: "basic",
        title: "Basic configuration",
        description:
          "Container ID is unique inside the project and may follow the company ID template. Barcode is globally unique. RFID is limited to 32 characters and is checked during pairing because legacy data may contain duplicates.",
        fields: [
          {
            id: "containerId",
            label: "Container ID",
            type: "text",
            placeholder: "Leave blank to use the company ID template",
            description:
              "When blank, the project creates the ID from the company template (for example fraction, type, prefix, separator, and sequence).",
          },
          {
            id: "barcode",
            label: "Barcode",
            type: "text",
          },
          {
            id: "rfid",
            label: "RFID",
            type: "text",
            description:
              "Maximum 32 characters. Use the force-pair workflow only after reviewing an existing pairing.",
          },
          {
            id: "serialNumber",
            label: "Serial number",
            type: "text",
          },
          {
            id: "containerType",
            label: "Container type",
            type: "select",
            required: true,
            options: [
              { value: "two-wheel-240", label: "Two-wheel bin · 240 L" },
              { value: "four-wheel-660", label: "Four-wheel bin · 660 L" },
              { value: "four-wheel-1100", label: "Four-wheel bin · 1,100 L" },
              { value: "wastewater-3000", label: "Wastewater tank · 3,000 L" },
            ],
          },
          {
            id: "wasteFraction",
            label: "Primary waste fraction",
            type: "select",
            required: true,
            description:
              "Additional fractions retain their order. Active legacy agreements can lock fraction edits.",
            options: [
              { value: "residual", label: "Residual" },
              { value: "organic", label: "Organic" },
              { value: "cardboard", label: "Cardboard" },
              { value: "glass", label: "Glass" },
              { value: "mixed", label: "Mixed" },
              { value: "wastewater", label: "Wastewater" },
            ],
          },
          {
            id: "secondaryWasteFraction",
            label: "Additional waste fraction · order 2",
            type: "select",
            description:
              "Optional second ordered fraction. The primary fraction remains order 1.",
            options: [
              { value: "residual", label: "Residual" },
              { value: "organic", label: "Organic" },
              { value: "cardboard", label: "Cardboard" },
              { value: "glass", label: "Glass" },
              { value: "mixed", label: "Mixed" },
              { value: "wastewater", label: "Wastewater" },
            ],
          },
          {
            id: "ownership",
            label: "Ownership",
            type: "select",
            required: true,
            defaultValue: "company",
            options: [
              { value: "company", label: "Company owned" },
              { value: "customer", label: "Customer owned" },
              { value: "unrecorded", label: "Unrecorded" },
            ],
          },
          {
            id: "manufactured",
            label: "Manufactured month",
            type: "date",
          },
          {
            id: "warrantyStart",
            label: "Warranty start",
            type: "date",
          },
          {
            id: "warrantyEnd",
            label: "Warranty end",
            type: "date",
          },
        ],
      },
      {
        id: "location-status",
        title: "Location and manual lifecycle",
        description:
          "Available, Future, Ended, and On hold come from an agreement and are display-only. New unassigned units normally enter In storage, which requires a storage depot.",
        fields: [
          {
            id: "status",
            label: "Manual status",
            type: "select",
            required: true,
            defaultValue: "in_storage",
            options: [
              { value: "defect", label: "Defect" },
              { value: "in_storage", label: "In storage" },
              { value: "in_transit", label: "In transit" },
            ],
          },
          {
            id: "serviceAddress",
            label: "Location or service address",
            type: "textarea",
            required: true,
            placeholder: "Street, number, postal code, city or current transfer location",
            description:
              "Coordinates must resolve inside the company map country. Temporary relocations are created after registration.",
          },
          {
            id: "propertyId",
            label: "Linked property",
            type: "select",
            relation: propertyRelation,
          },
          {
            id: "curbLocation",
            label: "Curb-side location",
            type: "text",
            placeholder: "Courtyard, gate, loading bay, or placement note",
          },
          {
            id: "storageDepotId",
            label: "Storage depot",
            type: "select",
            requiredWhen: { fieldId: "status", equals: "in_storage" },
            relation: { workspaceId: "resources", moduleId: "warehouses" },
            description:
              "Required for In storage. Saving the depot also appends an inventory-ledger movement.",
          },
        ],
      },
      {
        id: "collection-routing",
        title: "Pickup, calendar, and route",
        description:
          "Static and Dynamic are routable. Disabled containers are excluded. Route selection also validates status, fractions, type, pickup setting, and route-scheme membership.",
        fields: [
          {
            id: "pickupMethod",
            label: "Pickup method",
            type: "select",
            required: true,
            defaultValue: "none",
            options: [
              { value: "static", label: "Static" },
              { value: "dynamic", label: "Dynamic" },
              { value: "none", label: "Disabled" },
            ],
          },
          {
            id: "pickupSetting",
            label: "Pickup setting",
            type: "select",
            options: [
              { value: "organic-14", label: "Organic · 14-day service" },
              { value: "mixed-weekly", label: "Mixed · weekly" },
              { value: "glass-monthly", label: "Glass · monthly" },
              { value: "cardboard-weekly", label: "Cardboard · weekly" },
            ],
          },
          {
            id: "collectionCalendar",
            label: "Collection calendar",
            type: "select",
            options: [
              { value: "copenhagen-2026", label: "Copenhagen 2026" },
              { value: "commercial-2026", label: "Commercial 2026" },
              { value: "glass-2026", label: "Commercial Glass 2026" },
            ],
          },
          {
            id: "routeScheme",
            label: "Route scheme",
            type: "select",
            options: [
              { value: "osterbro-organic-b", label: "Østerbro Organic B" },
              { value: "amager-glass", label: "Amager Glass" },
              { value: "norrebro-mixed", label: "Nørrebro Mixed" },
              { value: "harbor-cardboard", label: "Harbor Cardboard" },
            ],
          },
          {
            id: "vehicle",
            label: "Vehicle",
            type: "select",
            options: [
              { value: "wh-18", label: "WH-18" },
              { value: "wh-24", label: "WH-24" },
              { value: "wh-31", label: "WH-31" },
            ],
            description:
              "When selected, the vehicle must belong to the selected route scheme.",
          },
          {
            id: "prioritizeAtStart",
            label: "Prioritize at route start",
            type: "checkbox",
            defaultValue: false,
          },
        ],
      },
      {
        id: "sensor",
        title: "Optional fill-level sensor",
        description:
          "Pairing prevents overlapping active DeviceToContainer periods. Devices can use LoRaWAN, Sigfox, or NB-IoT/LTE-M/GSM networks.",
        fields: [
          {
            id: "sensorIdentifier",
            label: "Sensor identifier",
            type: "text",
          },
          {
            id: "sensorNetwork",
            label: "Sensor network",
            type: "select",
            options: [
              { value: "lorawan", label: "LoRaWAN" },
              { value: "sigfox", label: "Sigfox" },
              { value: "nb-iot", label: "NB-IoT / LTE-M / GSM" },
            ],
          },
          {
            id: "fullThreshold",
            label: "Full threshold",
            type: "number",
            min: 0,
            max: 100,
            defaultValue: "95",
            unit: "%",
          },
          {
            id: "sensorOffset",
            label: "Sensor offset",
            type: "number",
            min: 0,
            defaultValue: "0.0405",
            unit: "m",
          },
          {
            id: "lidGeometry",
            label: "Lid geometry",
            type: "select",
            options: [
              { value: "flat", label: "Flat" },
              { value: "domed", label: "Domed" },
              { value: "sloped", label: "Sloped" },
            ],
          },
          {
            id: "measurementSetting",
            label: "Measurement setting",
            type: "select",
            options: [
              { value: "standard-4h", label: "Standard · every 4 hours" },
              { value: "dynamic-1h", label: "Dynamic · every hour" },
              { value: "low-power-12h", label: "Low power · every 12 hours" },
            ],
          },
        ],
      },
      {
        id: "other",
        title: "Descriptions and custom fields",
        fields: [
          {
            id: "description",
            label: "Description",
            type: "textarea",
            placeholder: "Physical markings, access context, or service notes",
          },
          {
            id: "driverDescription",
            label: "Driver description",
            type: "textarea",
            placeholder: "Placement instructions visible during collection",
          },
          {
            id: "externalReference",
            label: "External reference",
            type: "text",
            description:
              "Stored as project-defined metadata and included in export and omnisearch.",
          },
        ],
      },
    ],
  },
  {
    key: "resources.inventory",
    mode: "action",
    recordKind: "Stock Movement",
    title: "Record stock movement",
    description: "",
    submitLabel: "Record movement",
    contextFieldIds: ["projectId", "movementType", "stockItemId"],
    ownerField: "performedBy",
    sections: [
      {
        id: "scope-source",
        title: "Scope and source",
        fields: [
          {
            id: "projectId",
            label: "Operating project",
            type: "select",
            required: true,
            relation: projectRelation,
          },
          {
            id: "source",
            label: "Movement source",
            type: "select",
            required: true,
            defaultValue: "manual",
            options: [
              { value: "manual", label: "Warehouse user" },
              { value: "route-outcome", label: "Route outcome" },
              { value: "ticket-action", label: "Ticket action" },
              { value: "import-job", label: "Validated import job" },
              { value: "integration", label: "Connected integration" },
            ],
          },
          {
            id: "performedBy",
            label: "Performed by",
            type: "text",
            required: true,
          },
          {
            id: "occurredAt",
            label: "Movement time",
            type: "datetime",
            required: true,
          },
        ],
      },
      {
        id: "movement",
        title: "Movement",
        fields: [
          {
            id: "movementType",
            label: "Movement type",
            type: "select",
            required: true,
            options: [
              { value: "receipt", label: "Receive" },
              { value: "issue", label: "Issue or deliver" },
              { value: "return", label: "Return" },
              { value: "transfer", label: "Transfer" },
              { value: "adjustment", label: "Adjustment" },
              { value: "reservation-release", label: "Release reservation" },
              { value: "decommission", label: "Decommission" },
            ],
          },
          {
            id: "stockItemId",
            label: "Stock item",
            type: "select",
            required: true,
            relation: {
              workspaceId: "resources",
              moduleId: "inventory",
            },
          },
          {
            id: "quantity",
            label: "Quantity",
            type: "number",
            required: true,
            min: 0.001,
          },
          {
            id: "unit",
            label: "Unit",
            type: "select",
            required: true,
            options: [
              { value: "piece", label: "Piece" },
              { value: "kg", label: "Kilogram" },
              { value: "litre", label: "Litre" },
              { value: "pack", label: "Pack" },
            ],
          },
          {
            id: "originWarehouseId",
            label: "Origin warehouse",
            type: "select",
            relation: {
              workspaceId: "resources",
              moduleId: "warehouses",
            },
          },
          {
            id: "destinationWarehouseId",
            label: "Destination warehouse",
            type: "select",
            relation: {
              workspaceId: "resources",
              moduleId: "warehouses",
            },
          },
          {
            id: "individualAssetId",
            label: "Individually tracked asset",
            type: "select",
            relation: {
              workspaceId: "resources",
              moduleId: "containers",
            },
          },
        ],
      },
      {
        id: "business-context",
        title: "Business context and evidence",
        fields: [
          {
            id: "reservationReference",
            label: "Reservation reference",
            type: "text",
          },
          {
            id: "routeId",
            label: "Related route",
            type: "select",
            relation: {
              workspaceId: "operate",
              moduleId: "routes",
            },
          },
          {
            id: "ticketId",
            label: "Related ticket",
            type: "select",
            relation: {
              workspaceId: "operate",
              moduleId: "tickets",
            },
          },
        ],
      },
    ],
  },
  {
    key: "resources.warehouses",
    mode: "create",
    recordKind: "Warehouse",
    title: "Create warehouse",
    description:
      "Create a stock location with operating settings. A Warehouse controls inventory and remains separate from a Depot even when they share an address.",
    submitLabel: "Create warehouse",
    nameField: "name",
    contextFieldIds: ["projectId", "code", "address"],
    ownerField: "recordOwner",
    sections: [
      {
        id: "scope-source",
        title: "Scope, source, and effective period",
        description:
          "Project and effective start are required. Closing a Warehouse later requires zero or explicitly transferred stock and preserves its ledger.",
        fields: [
          {
            id: "projectId",
            label: "Operating project",
            type: "select",
            required: true,
            relation: projectRelation,
          },
          {
            id: "source",
            label: "Record source",
            type: "select",
            required: true,
            defaultValue: "manual",
            options: sourceOptions,
          },
          {
            id: "effectiveFrom",
            label: "Effective from",
            type: "date",
            required: true,
          },
          {
            id: "recordOwner",
            label: "Warehouse owner team",
            type: "text",
            required: true,
            placeholder: "Warehouse Team",
          },
        ],
      },
      {
        id: "identity-location",
        title: "Identity and location",
        description:
          "Required validation: warehouse code must be unique in the company and the address must resolve inside the selected project.",
        fields: [
          {
            id: "name",
            label: "Warehouse name",
            type: "text",
            required: true,
          },
          {
            id: "code",
            label: "Warehouse code",
            type: "text",
            required: true,
          },
          {
            id: "status",
            label: "Initial state",
            type: "select",
            required: true,
            defaultValue: "draft",
            options: [
              { value: "draft", label: "Draft" },
              { value: "active", label: "Active" },
              { value: "restricted", label: "Restricted" },
            ],
          },
          {
            id: "address",
            label: "Address",
            type: "textarea",
            required: true,
          },
          {
            id: "latitude",
            label: "Latitude",
            type: "number",
            min: -90,
            max: 90,
          },
          {
            id: "longitude",
            label: "Longitude",
            type: "number",
            min: -180,
            max: 180,
          },
        ],
      },
      {
        id: "operating-settings",
        title: "Operating settings",
        fields: [
          {
            id: "zones",
            label: "Storage zones or aisles",
            type: "textarea",
            placeholder: "A–F, returns, quarantine, serialized assets",
          },
          {
            id: "allowFungibleStock",
            label: "Allow quantity-managed stock",
            type: "checkbox",
            defaultValue: true,
          },
          {
            id: "allowIndividualUnits",
            label: "Allow individually tracked units",
            type: "checkbox",
            defaultValue: true,
          },
          {
            id: "scanRequired",
            label: "Require scan for serialized movements",
            type: "checkbox",
            defaultValue: true,
          },
          {
            id: "colocatedDepotId",
            label: "Colocated depot",
            type: "select",
            description:
              "Optional physical relationship only; it does not merge the Warehouse ledger with Fleet operations.",
            relation: {
              workspaceId: "resources",
              moduleId: "depots",
            },
          },
        ],
      },
    ],
  },
  {
    key: "resources.depots",
    mode: "create",
    recordKind: "Operational Location",
    title: "Create depot or unloading station",
    description:
      "Create an effective operational location. The current mixed tab is transitional: Depot belongs to Fleet planning, while Unloading Station belongs to route master data.",
    submitLabel: "Create draft location",
    nameField: "name",
    contextFieldIds: ["projectId", "locationType", "ownership"],
    ownerField: "recordOwner",
    sections: [
      {
        id: "scope-source",
        title: "Scope, source, and effective period",
        fields: [
          {
            id: "projectId",
            label: "Operating project",
            type: "select",
            required: true,
            relation: projectRelation,
          },
          {
            id: "source",
            label: "Record source",
            type: "select",
            required: true,
            defaultValue: "manual",
            options: sourceOptions,
          },
          {
            id: "effectiveFrom",
            label: "Effective from",
            type: "date",
            required: true,
          },
          {
            id: "effectiveTo",
            label: "Effective to",
            type: "date",
            description: "Optional; historic Route destinations remain unchanged.",
          },
          {
            id: "recordOwner",
            label: "Operational owner team",
            type: "text",
            required: true,
          },
        ],
      },
      {
        id: "identity-location",
        title: "Identity and location",
        description:
          "Required validation: code must be unique in the company, coordinates must be valid, and the location must resolve inside or explicitly outside the project boundary.",
        fields: [
          {
            id: "locationType",
            label: "Location type",
            type: "select",
            required: true,
            options: [
              { value: "depot", label: "Vehicle and driver depot" },
              { value: "unloading", label: "Unloading or disposal station" },
            ],
          },
          {
            id: "name",
            label: "Location name",
            type: "text",
            required: true,
          },
          {
            id: "code",
            label: "Location code",
            type: "text",
            required: true,
          },
          {
            id: "address",
            label: "Address",
            type: "textarea",
            required: true,
          },
          {
            id: "latitude",
            label: "Latitude",
            type: "number",
            required: true,
            min: -90,
            max: 90,
          },
          {
            id: "longitude",
            label: "Longitude",
            type: "number",
            required: true,
            min: -180,
            max: 180,
          },
        ],
      },
      {
        id: "ownership-operation",
        title: "Ownership and operation",
        description:
          "Contractor is required when ownership is Contractor. An unloading station requires accepted fractions and operating hours; a Depot requires route-resource capacity.",
        fields: [
          {
            id: "ownership",
            label: "Ownership",
            type: "select",
            required: true,
            options: [
              { value: "company", label: "Company owned" },
              { value: "contractor", label: "Contractor owned" },
              { value: "external", label: "External facility" },
            ],
          },
          {
            id: "contractorId",
            label: "Owning contractor",
            type: "select",
            relation: {
              workspaceId: "contractors",
              moduleId: "contractors",
            },
          },
          {
            id: "operatingHours",
            label: "Operating hours",
            type: "text",
            required: true,
            placeholder: "Mon–Fri 05:00–22:00",
          },
          {
            id: "acceptedFractionId",
            label: "Accepted waste fraction",
            type: "select",
            description:
              "Repeatable and required for an Unloading Station; route assignment validates compatibility.",
            relation: {
              workspaceId: "configure",
              moduleId: "master",
            },
          },
          {
            id: "vehicleCapacity",
            label: "Vehicle capacity",
            type: "number",
            min: 0,
            unit: "vehicles",
            description: "Applicable to a Depot.",
          },
          {
            id: "weighbridgeAvailable",
            label: "Weighbridge available",
            type: "checkbox",
            defaultValue: false,
          },
          {
            id: "linkedWarehouseId",
            label: "Colocated warehouse",
            type: "select",
            description:
              "Physical relationship only; stock and route-resource ledgers remain separate.",
            relation: {
              workspaceId: "resources",
              moduleId: "warehouses",
            },
          },
        ],
      },
    ],
  },
]

export function getCustomerResourceBusinessFormSchema(
  workspaceId: "customers" | "resources",
  moduleId: string,
): BusinessFormSchema | undefined {
  return customerResourceBusinessFormSchemas.find(
    (schema) => schema.key === `${workspaceId}.${moduleId}`,
  )
}
