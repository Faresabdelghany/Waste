// Properties, property groups and shared collection points as the web keeps
// them on the Pilot (Issue #184, slice 9b of #81): the three Registry modules
// `customers.properties`, `customers.groups` and `customers.shared` read the
// API, and each is operated through the command surfaces
// (components/waste/commands/place-surfaces.tsx) with the forms here — a
// create form and an edit form per module, whose field ids are the keys the
// adapters read (lib/api/records/properties.ts). A standard-view module
// offers no generic Edit, and the registry's own forms ask for what the wire
// has no home for — a record source, a building identifier, an effective
// date on a party or a membership, a group's service effect — so fixture mode
// keeps those forms whole and the Pilot has these.
//
// A set travels whole, as one `PUT`. A property's parties are one multiselect
// per role over the switched contacts module, so every (customer, role) pair
// the API holds is one pick and the set a form sends back is the set a person
// sees. A group's or a point's members are one multiselect over the
// properties, with the role a new member joins as: a member already there
// keeps the role it holds, which the record carries under `MEMBER_ROLES_KEY`.
//
// A property's location is the wire's point, both numbers or neither: blank
// until the address is geocoded, and then its containers have no place on
// the map. A point is always located.
import {
  PROPERTY_GROUP_MEMBER_ROLES,
  PROPERTY_GROUP_PURPOSES,
  PROPERTY_GROUP_STATUSES,
  PROPERTY_KINDS,
  PROPERTY_PARTY_ROLES,
  SHARED_COLLECTION_POINT_ACCESS_MODES,
  SHARED_COLLECTION_POINT_BILLING_MODES,
  SHARED_COLLECTION_POINT_KINDS,
  SHARED_COLLECTION_POINT_MEMBER_ROLES,
  SHARED_COLLECTION_POINT_OPERATING_MODELS,
  SHARED_COLLECTION_POINT_STATUSES,
  type PropertyGroupMemberRole,
  type PropertyGroupPurpose,
  type PropertyKind,
  type PropertyPartyRole,
  type SharedCollectionPointAccessMode,
  type SharedCollectionPointBillingMode,
  type SharedCollectionPointKind,
  type SharedCollectionPointMemberRole,
  type SharedCollectionPointOperatingModel,
} from "@waste/domain/registry/vocabulary"

import { ofKind, statusLabel } from "@/lib/api/records/adapter"

import { PROPERTY_PREFIX, SHARED_POINT_PREFIX } from "./agreements"
import type { BusinessFormField, BusinessFormOption, BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import type { BusinessRecord, ModuleLocation } from "./business-modules"
import { mintedRecord, ORGANISATION_MODULE } from "./containers"

/** Where each kind lives — the one seam callers resolve the modules through. */
export const PROPERTIES_MODULE: ModuleLocation = { workspaceId: "customers", moduleId: "properties" }
export const PROPERTY_GROUPS_MODULE: ModuleLocation = { workspaceId: "customers", moduleId: "groups" }
export const SHARED_POINTS_MODULE: ModuleLocation = { workspaceId: "customers", moduleId: "shared" }
/** Where the customers a party or a responsible customer names live (switched before these three). */
export const CONTACTS_MODULE: ModuleLocation = { workspaceId: "customers", moduleId: "contacts" }

/** The id prefixes: the fixtures' own, so a fixture's id and the adapters' `<prefix>-<uuid>` read alike. */
export { PROPERTY_PREFIX, SHARED_POINT_PREFIX }
export const GROUP_PREFIX = "group"

/** What the forms stamp on a row of each kind (`recordKind`), and what a new row is recognised by until the API has answered. */
export const PROPERTY_RECORD_KIND = "Property"
export const PROPERTY_GROUP_RECORD_KIND = "Property Group"
export const SHARED_POINT_RECORD_KIND = "Shared Collection Point"

/** Whether a record is of each kind: its id's prefix, else the kind the form stamped on it (adapter.ts, `ofKind`). */
export const isPropertyRecord: (record: Pick<BusinessRecord, "id" | "recordKind">) => boolean = ofKind(PROPERTY_PREFIX, [PROPERTY_RECORD_KIND])
export const isPropertyGroupRecord: (record: Pick<BusinessRecord, "id" | "recordKind">) => boolean = ofKind(GROUP_PREFIX, [PROPERTY_GROUP_RECORD_KIND])
export const isSharedPointRecord: (record: Pick<BusinessRecord, "id" | "recordKind">) => boolean = ofKind(SHARED_POINT_PREFIX, [SHARED_POINT_RECORD_KIND])

/** The field each party role is picked in, in the wire's role order. */
export const PARTY_FIELDS: Readonly<Record<PropertyPartyRole, string>> = {
  owner: "ownerIds",
  payer: "payerIds",
  tenant: "tenantIds",
  administrator: "administratorIds",
  "service-contact": "serviceContactIds",
}

/** What a single optional customer field says for nobody: a select holds no empty value, so None is this token, which the adapters read as no customer. */
export const NO_ONE = "none"

/** A group's or a point's member properties, the role a new member joins as, and the roles the members already hold (JSON: web id → role). */
export const MEMBERS_KEY = "memberPropertyIds"
export const MEMBER_ROLE_KEY = "memberRole"
export const MEMBER_ROLES_KEY = "memberRoles"

// ---------------------------------------------------------------------------
// The words: every closed list as the registry's forms spell it
// ---------------------------------------------------------------------------

export const PROPERTY_KIND_LABELS: Readonly<Record<PropertyKind, string>> = {
  residential: "Residential",
  commercial: "Commercial",
  public: "Public body or institution",
  mixed: "Mixed use",
  other: "Other",
}
/** A role as its field and its fact are called: the parties who hold it. */
export const PARTY_ROLE_LABELS: Readonly<Record<PropertyPartyRole, string>> = {
  owner: "Owners",
  payer: "Payers",
  tenant: "Tenants",
  administrator: "Administrators",
  "service-contact": "Service contacts",
}
export const GROUP_PURPOSE_LABELS: Readonly<Record<PropertyGroupPurpose, string>> = {
  administration: "Administration",
  reporting: "Reporting only",
  service: "Shared service rules",
  agreement: "Agreement management",
}
export const GROUP_MEMBER_ROLE_LABELS: Readonly<Record<PropertyGroupMemberRole, string>> = {
  member: "Member",
  administrator: "Administrator",
  payer: "Payer",
  reporting: "Reporting only",
}
/** A group role as its fact is called: the members who hold it. */
export const GROUP_MEMBER_FACTS: Readonly<Record<PropertyGroupMemberRole, string>> = {
  member: "Members",
  administrator: "Administrators",
  payer: "Payers",
  reporting: "Reporting members",
}
export const POINT_KIND_LABELS: Readonly<Record<SharedCollectionPointKind, string>> = {
  surface: "Surface containers",
  underground: "Underground system",
  "recycling-station": "Shared recycling station",
  commercial: "Commercial shared service",
  other: "Other",
}
export const OPERATING_MODEL_LABELS: Readonly<Record<SharedCollectionPointOperatingModel, string>> = {
  municipal: "Municipal shared service",
  "member-funded": "Member-funded service",
  "company-operated": "Shared-service company",
  "service-provider-operated": "Service provider operated",
}
export const ACCESS_MODE_LABELS: Readonly<Record<SharedCollectionPointAccessMode, string>> = {
  open: "Open access",
  member: "Members only",
  credential: "Card, key, or code",
  restricted: "Restricted by schedule or role",
}
export const BILLING_MODE_LABELS: Readonly<Record<SharedCollectionPointBillingMode, string>> = {
  municipal: "Project or municipality",
  "single-payer": "One responsible payer",
  "member-share": "Allocated across members",
  usage: "Usage based",
}
export const POINT_MEMBER_ROLE_LABELS: Readonly<Record<SharedCollectionPointMemberRole, string>> = {
  "service-member": "Service member",
  administrator: "Administrator",
  payer: "Payer",
  "notification-contact": "Notification contact",
}
/** A point role as its fact is called: the members who hold it. */
export const POINT_MEMBER_FACTS: Readonly<Record<SharedCollectionPointMemberRole, string>> = {
  "service-member": "Service members",
  administrator: "Administrators",
  payer: "Payers",
  "notification-contact": "Notification contacts",
}

const optionsOf = <Token extends string>(tokens: readonly Token[], labels: Readonly<Record<Token, string>>): BusinessFormOption[] => tokens.map((value) => ({ value, label: labels[value] }))
const statusOptions = (tokens: readonly string[]): BusinessFormOption[] => tokens.map((value) => ({ value, label: statusLabel(value) }))

// ---------------------------------------------------------------------------
// The forms
// ---------------------------------------------------------------------------

const project: BusinessFormField = { id: "projectId", label: "Operating project", type: "select", required: true, relation: ORGANISATION_MODULE }
const heldProject: BusinessFormField = { ...project, readOnly: true }
const latitude = (required: boolean, description?: string): BusinessFormField => ({ id: "latitude", label: "Latitude", type: "number", required, min: -90, max: 90, description })
const longitude = (required: boolean): BusinessFormField => ({ id: "longitude", label: "Longitude", type: "number", required, min: -180, max: 180 })
const responsibleCustomer = (label: string): BusinessFormField => ({ id: "responsibleCustomerId", label, type: "select", relation: CONTACTS_MODULE })
const members = (label: string): BusinessFormField => ({ id: MEMBERS_KEY, label, type: "multiselect", relation: PROPERTIES_MODULE, description: "Properties of the same project." })
const memberRole = (tokens: readonly string[], labels: Readonly<Record<string, string>>): BusinessFormField => ({
  id: MEMBER_ROLE_KEY,
  label: "Role for new members",
  type: "select",
  defaultValue: tokens[0],
  options: tokens.map((value) => ({ value, label: labels[value] })),
  description: "What a property added here joins as. A member already there keeps the role it holds.",
})

const propertyFields = (projectField: BusinessFormField): BusinessFormSchema["sections"] => [
  {
    id: "identity-address",
    title: "Property identity and service address",
    fields: [
      projectField,
      { id: "displayName", label: "Property name", type: "text", required: true, placeholder: "Parkvej 18" },
      { id: "serviceAddress", label: "Service address", type: "textarea", required: true, placeholder: "Street and number, postal code and city" },
      { id: "registryId", label: "Property registry identifier", type: "text", description: "The property registry's number, a BFE number in Denmark; unique across the company." },
      { id: "propertyType", label: "Property type", type: "select", required: true, options: optionsOf(PROPERTY_KINDS, PROPERTY_KIND_LABELS) },
    ],
  },
  {
    id: "location",
    title: "Location",
    description: "Where the property's containers stand on the map: both numbers, or neither until the address is geocoded.",
    fields: [latitude(false), longitude(false)],
  },
  {
    id: "parties",
    title: "Connected parties",
    description: "Who the property's customers are, and as what. One customer may hold several roles.",
    fields: PROPERTY_PARTY_ROLES.map((role) => ({ id: PARTY_FIELDS[role], label: PARTY_ROLE_LABELS[role], type: "multiselect" as const, relation: CONTACTS_MODULE })),
  },
  {
    id: "operating-context",
    title: "Operating context",
    fields: [{ id: "specialConditions", label: "Special service conditions", type: "textarea" }],
  },
]

/** Create property on the Pilot: what the wire carries, the parties with it in one request. */
export const PROPERTY_FORM: BusinessFormSchema = {
  key: "customers.properties",
  mode: "create",
  recordKind: PROPERTY_RECORD_KIND,
  title: "Create property",
  description: "Register a service address in a project, with the customers connected to it.",
  submitLabel: "Create property",
  nameField: "displayName",
  contextFieldIds: ["projectId", "serviceAddress"],
  sections: propertyFields(project),
  execution: { kind: "create-record", completionMessage: "The property was registered." },
}

/** The edit: the same fields, the project held; the status moves by the lifecycle's actions. */
export const PROPERTY_EDIT_FORM: BusinessFormSchema = {
  ...PROPERTY_FORM,
  title: "Edit property",
  description: "Correct the property and its parties. Its project does not move.",
  submitLabel: "Save changes",
  sections: propertyFields(heldProject),
}

const groupSections = (projectField: BusinessFormField, withStatus: boolean): BusinessFormSchema["sections"] => [
  {
    id: "identity-purpose",
    title: "Identity and purpose",
    fields: [
      projectField,
      { id: "name", label: "Group name", type: "text", required: true },
      { id: "purpose", label: "Group purpose", type: "select", required: true, options: optionsOf(PROPERTY_GROUP_PURPOSES, GROUP_PURPOSE_LABELS) },
      ...(withStatus ? [{ id: "status", label: "Initial state", type: "select" as const, required: true, defaultValue: "draft", options: statusOptions(PROPERTY_GROUP_STATUSES) }] : []),
      responsibleCustomer("Responsible customer or company"),
    ],
  },
  {
    id: "membership",
    title: "Membership",
    description: "Membership does not replace a property's own record; a property may belong to several groups for different purposes.",
    fields: [members("Member properties"), memberRole(PROPERTY_GROUP_MEMBER_ROLES, GROUP_MEMBER_ROLE_LABELS)],
  },
]

/** Create property group on the Pilot: the group and its members in one request. */
export const PROPERTY_GROUP_FORM: BusinessFormSchema = {
  key: "customers.groups",
  mode: "create",
  recordKind: PROPERTY_GROUP_RECORD_KIND,
  title: "Create property group",
  description: "Gather properties for one administration, report, service rule or agreement, each property keeping its own record.",
  submitLabel: "Create property group",
  nameField: "name",
  contextFieldIds: ["projectId", "purpose"],
  sections: groupSections(project, true),
  execution: { kind: "create-record", completionMessage: "The property group was created." },
}

/** The edit: the group and its members, the project held; the status moves by the lifecycle's actions. */
export const PROPERTY_GROUP_EDIT_FORM: BusinessFormSchema = {
  ...PROPERTY_GROUP_FORM,
  title: "Edit property group",
  description: "Correct the group and its members. Its project does not move.",
  submitLabel: "Save changes",
  sections: groupSections(heldProject, false),
}

const pointSections = (projectField: BusinessFormField, withStatus: boolean): BusinessFormSchema["sections"] => [
  {
    id: "identity-location",
    title: "Identity and location",
    fields: [
      projectField,
      { id: "name", label: "Shared-point name", type: "text", required: true },
      { id: "pointType", label: "Collection-point type", type: "select", required: true, options: optionsOf(SHARED_COLLECTION_POINT_KINDS, POINT_KIND_LABELS) },
      ...(withStatus ? [{ id: "status", label: "Initial state", type: "select" as const, required: true, defaultValue: "draft", options: statusOptions(SHARED_COLLECTION_POINT_STATUSES) }] : []),
      { id: "address", label: "Location address", type: "textarea", required: true },
      latitude(true, "The place is the record: a point is always located."),
      longitude(true),
      { id: "eligibilityDistance", label: "Default eligibility distance", type: "number", min: 1, unit: "m", description: "How far a property may be and still be served here, in whole metres." },
    ],
  },
  {
    id: "operation-access",
    title: "Operating and access model",
    fields: [
      { id: "operatingModel", label: "Operating model", type: "select", required: true, options: optionsOf(SHARED_COLLECTION_POINT_OPERATING_MODELS, OPERATING_MODEL_LABELS) },
      { id: "availability", label: "Availability", type: "text", placeholder: "24/7 or Mon–Fri 06:00–20:00" },
      { id: "accessMode", label: "Access mode", type: "select", required: true, options: optionsOf(SHARED_COLLECTION_POINT_ACCESS_MODES, ACCESS_MODE_LABELS) },
      { id: "accessConditions", label: "Access conditions", type: "textarea" },
      { id: "billingMode", label: "Billing responsibility", type: "select", required: true, options: optionsOf(SHARED_COLLECTION_POINT_BILLING_MODES, BILLING_MODE_LABELS) },
      responsibleCustomer("Responsible customer or payer"),
    ],
  },
  {
    id: "membership",
    title: "Membership",
    fields: [members("Participating properties"), memberRole(SHARED_COLLECTION_POINT_MEMBER_ROLES, POINT_MEMBER_ROLE_LABELS)],
  },
]

/** Create shared point on the Pilot: the place, its access and billing, its members in one request. */
export const SHARED_POINT_FORM: BusinessFormSchema = {
  key: "customers.shared",
  mode: "create",
  recordKind: SHARED_POINT_RECORD_KIND,
  title: "Create shared collection point",
  description: "Plan a physical place several properties share, with its access, its billing responsibility and its members.",
  submitLabel: "Create shared point",
  nameField: "name",
  contextFieldIds: ["projectId", "pointType", "operatingModel"],
  sections: pointSections(project, true),
  execution: { kind: "create-record", completionMessage: "The shared collection point was created." },
}

/** The edit: the point and its members, the project held; the status moves by the lifecycle's actions. */
export const SHARED_POINT_EDIT_FORM: BusinessFormSchema = {
  ...SHARED_POINT_FORM,
  title: "Edit shared collection point",
  description: "Correct the point and its members. Its project does not move.",
  submitLabel: "Save changes",
  sections: pointSections(heldProject, false),
}

// ---------------------------------------------------------------------------
// The records the forms make
// ---------------------------------------------------------------------------

/** The values an edit form opens with: the record's typed values for the form's fields. */
export function formValuesOf(schema: BusinessFormSchema, record: BusinessRecord): BusinessFormValues {
  const fieldIds = new Set(schema.sections.flatMap((section) => section.fields.map((field) => field.id)))
  return Object.fromEntries(Object.entries(record.submittedValues ?? {}).filter(([key, value]) => fieldIds.has(key) && typeof value === "string"))
}

const said = (values: BusinessFormValues, key: string) => (typeof values[key] === "string" ? (values[key] as string).trim() : "")

/** A property the create form made: the generic create path's id and kind, so the adapter owns it until the API's answer replaces it. */
export function createPropertyRecord(values: BusinessFormValues, { now }: { now: number }): BusinessRecord {
  return mintedRecord({ id: `properties-property-${now}`, name: said(values, "displayName"), status: "Active", recordKind: PROPERTY_RECORD_KIND, values })
}

/** A group the create form made, in the state its form chose. */
export function createPropertyGroupRecord(values: BusinessFormValues, { now }: { now: number }): BusinessRecord {
  return mintedRecord({ id: `groups-property-group-${now}`, name: said(values, "name"), status: statusLabel(said(values, "status") || "draft"), recordKind: PROPERTY_GROUP_RECORD_KIND, values })
}

/** A point the create form made, in the state its form chose. */
export function createSharedPointRecord(values: BusinessFormValues, { now }: { now: number }): BusinessRecord {
  return mintedRecord({ id: `shared-shared-collection-point-${now}`, name: said(values, "name"), status: statusLabel(said(values, "status") || "draft"), recordKind: SHARED_POINT_RECORD_KIND, values })
}

/** An edited row: its identity kept, the form's values over its typed ones, the name from the form's name field. */
export function updatedRecord(record: BusinessRecord, values: BusinessFormValues, nameField: string): BusinessRecord {
  const name = said(values, nameField)
  return { ...record, name: name === "" ? record.name : name, submittedValues: { ...record.submittedValues, ...values } }
}
