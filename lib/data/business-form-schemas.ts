import {
  commercialImproveBusinessFormSchemas,
} from "@/lib/data/business-form-schemas-commercial-improve"
import {
  customerResourceBusinessFormSchemas,
} from "@/lib/data/business-form-schemas-customers-resources"
import {
  operationsBusinessFormSchemas,
} from "@/lib/data/business-form-schemas-operations"
import type {
  BusinessFieldCondition,
  BusinessFormExecution,
  BusinessFormField,
  BusinessFormSchema,
} from "@/lib/data/business-form-types"
import {
  businessWorkspaces,
  type WorkspaceId,
} from "@/lib/data/business-modules"
import {
  publicWorkspaceDomains,
  settingsModuleDomains,
} from "@/lib/data/business-domain"

const actionExecutions: Record<string, BusinessFormExecution> = {
  "route-studio.routes": {
    kind: "create-record",
    initialStatus: "Planned",
    resultValue: "Stops pending generation",
    completionMessage: "The route was created and linked to its selected resources.",
  },
  "route-studio.weights": {
    kind: "append-event",
    sourceField: "sourceWeightId",
    reviewBeforeSubmit: true,
    completionMessage: "The weight event was appended without rewriting its source evidence.",
  },
  "operate.driver-app": {
    kind: "append-event",
    sourceField: "sessionId",
    completionMessage: "The driver action was recorded against the assigned route and session.",
  },
  // A new ticket's headline value is its response target, which the type SLA
  // supplies later — not the form's submit label.
  "operate.tickets": {
    kind: "create-record",
    resultValue: "Response target pending",
    completionMessage:
      "The ticket was created; its response target follows the type SLA.",
  },
  "fleet.vehicle-planning": {
    kind: "append-event",
    sourceField: "existingAllocationId",
    reviewBeforeSubmit: true,
    completionMessage: "The planned allocation was recorded without changing execution facts.",
  },
  "customers.citizen-portal": {
    kind: "preview",
    sourceField: "propertyId",
    completionMessage: "The scoped portal preview is ready.",
  },
  "resources.inventory": {
    kind: "append-event",
    sourceField: "stockItemId",
    completionMessage: "The stock movement was appended to the inventory ledger.",
  },
  "commercial.billing": {
    kind: "start-workflow",
    reviewBeforeSubmit: true,
    completionMessage: "The reviewed billing run was started with a reproducible selection snapshot.",
  },
  "commercial.products": {
    kind: "create-record",
    reviewBeforeSubmit: true,
    completionMessage: "Product created — add its price in Price Engine with Add price.",
  },
  "commercial.price-rows": {
    kind: "create-record",
    reviewBeforeSubmit: true,
    completionMessage: "Price added — resolution follows the most-conditions rule.",
  },
  "commercial.service-provider-prices": {
    kind: "create-record",
    reviewBeforeSubmit: true,
    completionMessage:
      "Service provider price created — the bid is locked; Apply index moves the current fee from here.",
  },
}

const conditionalFields: Record<
  string,
  { condition: BusinessFieldCondition; required?: boolean }
> = {
  "customers.properties.registryId": {
    condition: { fieldId: "source", equals: "property-registry" },
    required: true,
  },
  "customers.groups.agreementId": {
    condition: { fieldId: "serviceEffect", equals: "agreement" },
    required: true,
  },
  "customers.groups.effectiveFrom": {
    condition: {
      fieldId: "serviceEffect",
      oneOf: ["frequency", "pricing", "agreement"],
    },
    required: true,
  },
  "customers.shared.responsibleCompanyId": {
    condition: { fieldId: "billingMode", equals: "single-payer" },
    required: true,
  },
  "customers.contacts.projectId": {
    condition: { fieldId: "projectScope", equals: "project" },
    required: true,
  },
  "customers.contacts.organizationId": {
    condition: { fieldId: "partyType", equals: "company" },
    required: true,
  },
  "customers.contacts.connectedCompanyId": {
    condition: { fieldId: "partyType", equals: "person" },
  },
  "resources.depots.serviceProviderId": {
    condition: { fieldId: "ownership", equals: "service-provider" },
    required: true,
  },
  "resources.depots.acceptedFractionId": {
    condition: { fieldId: "locationType", equals: "unloading" },
    required: true,
  },
  "resources.depots.vehicleCapacity": {
    condition: { fieldId: "locationType", equals: "depot" },
  },
  "resources.inventory.originWarehouseId": {
    condition: {
      fieldId: "movementType",
      oneOf: [
        "issue",
        "return",
        "transfer",
        "adjustment",
        "reservation-release",
        "decommission",
      ],
    },
    required: true,
  },
  "resources.inventory.destinationWarehouseId": {
    condition: {
      fieldId: "movementType",
      oneOf: ["receipt", "transfer"],
    },
    required: true,
  },
  "commercial.events.overrideReason": {
    condition: { fieldId: "manualAmount", hasValue: true },
    required: true,
  },
  "commercial.events.blockReason": {
    condition: { fieldId: "eventState", equals: "blocked" },
    required: true,
  },
  "commercial.billing.scheduleId": {
    condition: { fieldId: "runMode", equals: "schedule" },
    required: true,
  },
  "commercial.billing.periodStart": {
    condition: { fieldId: "runMode", equals: "date-range" },
    required: true,
  },
  "improve.performance.serviceProviderId": {
    condition: {
      fieldId: "subjectType",
      oneOf: ["service-provider", "service-area"],
    },
    required: true,
  },
  "improve.performance.serviceAreaId": {
    condition: { fieldId: "subjectType", equals: "service-area" },
    required: true,
  },
  "route-studio.live.actualVehicleId": {
    condition: { fieldId: "actionType", equals: "reassign" },
    required: true,
  },
  "route-studio.live.actualDriverId": {
    condition: { fieldId: "actionType", equals: "reassign" },
    required: true,
  },
  "route-studio.live.destinationRouteId": {
    condition: { fieldId: "actionType", equals: "move-stops" },
    required: true,
  },
  "route-studio.live.stopReferences": {
    condition: {
      fieldId: "actionType",
      oneOf: ["move-stops", "recollection"],
    },
    required: true,
  },
  "route-studio.live.recollectionAt": {
    condition: { fieldId: "actionType", equals: "recollection" },
    required: true,
  },
  "route-studio.live.driverMessage": {
    condition: { fieldId: "actionType", equals: "send-message" },
    required: true,
  },
  "operate.driver-app.stopReference": {
    condition: {
      fieldId: "actionType",
      oneOf: [
        "complete-stop",
        "skip-stop",
        "fail-stop",
        "reschedule-stop",
        "report-problem",
      ],
    },
    required: true,
  },
  "operate.driver-app.reasonCode": {
    condition: {
      fieldId: "actionType",
      oneOf: [
        "skip-stop",
        "fail-stop",
        "reschedule-stop",
        "report-problem",
      ],
    },
    required: true,
  },
  "operate.driver-app.rescheduleAt": {
    condition: { fieldId: "actionType", equals: "reschedule-stop" },
    required: true,
  },
  "fleet.vehicle-planning.existingAllocationId": {
    condition: {
      fieldId: "allocationAction",
      oneOf: ["change", "release", "confirm"],
    },
    required: true,
  },
  "fleet.vehicle-planning.changeReason": {
    condition: {
      fieldId: "allocationAction",
      oneOf: ["change", "release"],
    },
    required: true,
  },
  "fleet.vehicle-planning.routeId": {
    condition: {
      fieldId: "allocationAction",
      oneOf: ["allocate", "change"],
    },
  },
  "fleet.vehicle-planning.schemeId": {
    condition: {
      fieldId: "allocationAction",
      oneOf: ["allocate", "change"],
    },
  },
  "fleet.vehicle-planning.plannedStart": {
    condition: {
      fieldId: "allocationAction",
      oneOf: ["allocate", "change"],
    },
    required: true,
  },
  "fleet.vehicle-planning.plannedEnd": {
    condition: {
      fieldId: "allocationAction",
      oneOf: ["allocate", "change"],
    },
    required: true,
  },
  "fleet.vehicle-planning.vehicleId": {
    condition: {
      fieldId: "allocationAction",
      oneOf: ["allocate", "change"],
    },
    required: true,
  },
  "fleet.vehicle-planning.driverId": {
    condition: {
      fieldId: "allocationAction",
      oneOf: ["allocate", "change"],
    },
    required: true,
  },
  "fleet.vehicle-planning.trailerId": {
    condition: {
      fieldId: "allocationAction",
      oneOf: ["allocate", "change"],
    },
  },
  "fleet.vehicle-planning.depotId": {
    condition: {
      fieldId: "allocationAction",
      oneOf: ["allocate", "change"],
    },
    required: true,
  },
  "fleet.vehicle-planning.plannedFraction": {
    condition: {
      fieldId: "allocationAction",
      oneOf: ["allocate", "change"],
    },
    required: true,
  },
  "fleet.vehicle-planning.requiredCapacity": {
    condition: {
      fieldId: "allocationAction",
      oneOf: ["allocate", "change"],
    },
    required: true,
  },
  "fleet.vehicle-planning.serviceProviderId": {
    condition: {
      fieldId: "allocationAction",
      oneOf: ["allocate", "change"],
    },
  },
  "fleet.vehicle-planning.compatibilitySummary": {
    condition: {
      fieldId: "allocationAction",
      oneOf: ["allocate", "change"],
    },
    required: true,
  },
  "fleet.vehicle-planning.overrideReason": {
    condition: { fieldId: "compatibilitySummary", hasValue: true },
  },
  "fleet.drivers.serviceProviderId": {
    condition: { fieldId: "employmentType", equals: "service-provider" },
    required: true,
  },
  "fleet.drivers.linkedUserId": {
    condition: { fieldId: "driverAppAccess", equals: true },
    required: true,
  },
}

const datePairs = [
  ["validFrom", "validTo"],
  ["periodStart", "periodEnd"],
  ["plannedStart", "plannedEnd"],
  ["effectiveFrom", "effectiveUntil"],
  ["effectiveFrom", "effectiveTo"],
  ["startDate", "endDate"],
  ["analysisFrom", "analysisTo"],
] as const

function enhanceField(
  schema: BusinessFormSchema,
  field: BusinessFormField,
  hasScopeField: boolean,
): BusinessFormField {
  const fieldKey = `${schema.key}.${field.id}`
  const conditional = conditionalFields[fieldKey]
  let enhanced: BusinessFormField = { ...field }

  if (/email/i.test(field.id) && field.type === "text") {
    enhanced = { ...enhanced, type: "email" }
  }

  if (
    field.id === "projectId" &&
    !field.required &&
    hasScopeField &&
    !field.visibleWhen
  ) {
    const projectScopeCondition: BusinessFieldCondition = {
      fieldId: "scope",
      hasValue: true,
      notIn: ["company", "all", "company-wide", "global"],
    }
    enhanced = {
      ...enhanced,
      visibleWhen: projectScopeCondition,
      requiredWhen: projectScopeCondition,
    }
  }

  if (conditional) {
    enhanced = {
      ...enhanced,
      visibleWhen: conditional.condition,
      ...(conditional.required
        ? { requiredWhen: conditional.condition }
        : {}),
    }
  }

  if (fieldKey === "commercial.events.customerId") {
    enhanced = {
      ...enhanced,
      relation: { workspaceId: "customers", moduleId: "contacts" },
    }
  }

  if (
    enhanced.relation?.moduleId === "master" &&
    /fraction/i.test(field.id)
  ) {
    enhanced = {
      ...enhanced,
      relation: undefined,
      options: [
        { value: "residual", label: "Residual waste" },
        { value: "organic", label: "Organic waste" },
        { value: "cardboard", label: "Cardboard" },
        { value: "mixed-recycling", label: "Mixed recycling" },
      ],
    }
  }

  if (fieldKey === "operate.driver-app.reasonCode") {
    enhanced = {
      ...enhanced,
      relation: undefined,
      options: [
        { value: "inaccessible", label: "Access unavailable" },
        { value: "contamination", label: "Contamination" },
        { value: "not-presented", label: "Container not presented" },
        { value: "capacity", label: "Capacity or weight limit" },
        { value: "safety", label: "Safety issue" },
        { value: "other", label: "Other governed reason" },
      ],
    }
  }


  return enhanced
}

function enhanceSchema(schema: BusinessFormSchema): BusinessFormSchema {
  const allFields = schema.sections.flatMap((section) => section.fields)
  const fieldIds = new Set(allFields.map((field) => field.id))
  const hasScopeField = fieldIds.has("scope")
  const sections = schema.sections.map((section) => ({
    ...section,
    fields: section.fields
      .filter(
        (field) =>
          !(
            schema.key === "commercial.billing" &&
            field.id === "resultRoutingConfirmed"
          ),
      )
      .map((field) => enhanceField(schema, field, hasScopeField)),
  }))
  const validationRules = [
    ...(schema.validationRules ?? []),
    ...datePairs
      .filter(([startField, endField]) =>
        fieldIds.has(startField) && fieldIds.has(endField),
      )
      // A one-day scheme window (from == to, a single service date) is valid,
      // so schemes get their own allowSame rule below.
      .filter(
        ([, endField]) =>
          !(schema.key === "route-studio.schemes" && endField === "effectiveTo"),
      )
      .map(([startField, endField]) => ({
        type: "date-order" as const,
        startField,
        endField,
        message: "The end date or time must be after the start.",
      })),
    ...(schema.key === "route-studio.schemes"
      ? [
          {
            type: "date-order" as const,
            startField: "effectiveFrom",
            endField: "effectiveTo",
            allowSame: true,
            message: "Effective to must be on or after Effective from.",
          },
        ]
      : []),
    ...(schema.key === "resources.inventory"
      ? [
          {
            type: "different-values" as const,
            firstField: "originWarehouseId",
            secondField: "destinationWarehouseId",
            message: "Origin and destination warehouses must be different.",
          },
        ]
      : []),
    ...(schema.key === "route-studio.routes" && fieldIds.has("periodEnd")
      ? [
          {
            type: "date-order" as const,
            startField: "operatingDate",
            endField: "periodEnd",
            allowSame: true,
            message: "Generate through must be on or after the operating date.",
          },
        ]
      : []),
    ...(schema.key === "commercial.service-provider-prices"
      ? [
          {
            type: "date-order" as const,
            startField: "validFrom",
            endField: "validUntil",
            allowSame: true,
            message: "Valid until must be on or after Valid from.",
          },
        ]
      : []),
  ]

  const execution =
    schema.mode === "disabled"
      ? undefined
      : actionExecutions[schema.key] ?? {
          kind: "create-record",
          completionMessage: `${schema.recordKind} created and linked to its business context.`,
        }

  return {
    ...schema,
    sections,
    validationRules,
    execution,
  }
}

export const businessFormSchemas: readonly BusinessFormSchema[] = [
  ...operationsBusinessFormSchemas,
  ...customerResourceBusinessFormSchemas,
  ...commercialImproveBusinessFormSchemas,
].map(enhanceSchema)

const duplicateKeys = businessFormSchemas
  .map((schema) => schema.key)
  .filter((key, index, keys) => keys.indexOf(key) !== index)

if (duplicateKeys.length > 0) {
  throw new Error(`Duplicate business form schemas: ${duplicateKeys.join(", ")}`)
}

// Every public module, plus the Settings-managed modules (configure.*) that
// keep real business records behind a Settings pane.
const expectedKeys: string[] = [
  ...publicWorkspaceDomains.flatMap((workspace) =>
    workspace.moduleIds.map((moduleId) => `${workspace.workspaceId}.${moduleId}`),
  ),
  ...settingsModuleDomains.map((module) => module.key),
]
const actualKeys = new Set<string>(
  businessFormSchemas.map((schema) => schema.key),
)
const missingKeys = expectedKeys.filter((key) => !actualKeys.has(key))
const unexpectedKeys = [...actualKeys].filter(
  (key) => !expectedKeys.includes(key),
)

if (missingKeys.length > 0 || unexpectedKeys.length > 0) {
  throw new Error(
    [
      missingKeys.length > 0
        ? `Missing business form schemas: ${missingKeys.join(", ")}`
        : "",
      unexpectedKeys.length > 0
        ? `Unexpected business form schemas: ${unexpectedKeys.join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join(". "),
  )
}

const schemaIntegrityIssues = businessFormSchemas.flatMap((schema) => {
  const fields = schema.sections.flatMap((section) => section.fields)
  const fieldIds = fields.map((field) => field.id)
  const fieldIdSet = new Set(fieldIds)
  const duplicateFieldIds = fieldIds.filter(
    (fieldId, index) => fieldIds.indexOf(fieldId) !== index,
  )
  const issues: string[] = duplicateFieldIds.map(
    (fieldId) => `${schema.key}: duplicate field ${fieldId}`,
  )

  for (const field of fields) {
    if (
      (field.type === "select" || field.type === "multiselect") &&
      !field.relation &&
      (!field.options || field.options.length === 0)
    ) {
      issues.push(`${schema.key}: select ${field.id} has no source`)
    }
    for (const condition of [field.visibleWhen, field.requiredWhen]) {
      if (condition && !fieldIdSet.has(condition.fieldId)) {
        issues.push(
          `${schema.key}: ${field.id} depends on missing field ${condition.fieldId}`,
        )
      }
    }
    if (field.relation) {
      const directModule = businessWorkspaces[
        field.relation.workspaceId
      ].modules.find((module) => module.id === field.relation?.moduleId)
      const fallbackModule = Object.values(businessWorkspaces)
        .flatMap((workspace) => workspace.modules)
        .find((module) => module.id === field.relation?.moduleId)
      if (!directModule && !fallbackModule) {
        issues.push(
          `${schema.key}: ${field.id} targets missing module ${field.relation.workspaceId}.${field.relation.moduleId}`,
        )
      }
    }
  }

  for (const fieldId of [
    schema.nameField,
    ...(schema.contextFieldIds ?? []),
    schema.execution?.sourceField,
  ]) {
    if (fieldId && !fieldIdSet.has(fieldId)) {
      issues.push(`${schema.key}: references missing field ${fieldId}`)
    }
  }

  if (schema.mode !== "disabled" && !schema.execution) {
    issues.push(`${schema.key}: enabled schema has no execution policy`)
  }
  if (schema.mode === "disabled" && schema.execution) {
    issues.push(`${schema.key}: disabled schema has an execution policy`)
  }

  return issues
})

if (schemaIntegrityIssues.length > 0) {
  throw new Error(schemaIntegrityIssues.join(". "))
}

const schemaByKey = new Map(
  businessFormSchemas.map((schema) => [schema.key, schema]),
)

export function getBusinessFormSchema(
  workspaceId: WorkspaceId,
  moduleId: string,
): BusinessFormSchema | undefined {
  return schemaByKey.get(`${workspaceId}.${moduleId}`)
}
