// Who is served and where (Issue #78): the Customer, the Property, the
// parties between them, the Property Group and the Shared Collection Point
// with its members. Nothing here is effective-dated (ADR-0005): a membership
// or a party role is present or absent and its history is the audit log, and a
// Customer, Property, Group or Point carries a status.
//
// `customer` is one record for a person or an organisation; the prototype's
// "Contacts & Companies" is this one table. A person has no natural key, so
// two records for one person are merged by hand later; an organisation's
// registration number is unique per company where it is given, which is a
// partial unique index and not a constraint, since most rows have none.
// `registration_number` is optional for both kinds — a sole trader may have
// none — and the form decides what it asks for. The e-mail is not unique: a
// housing administrator's address serves many organisations.
//
// `property` is the service address. Its `location` is the first point this
// system stores rather than derives: a geocoded property, so map planning
// stops guessing positions from address text. It is nullable because a
// property is registered before it is geocoded, and `registry_id` (a BFE
// number in Denmark) is unique per company where given, the same partial index
// as the customer's registration.
//
// `property_party` is what a Customer is to a Property: the prototype's owner,
// payer and primary contact of a property, and its contact's relationship
// role, are all rows here. It is also the citizen portal's customer-side
// identity — which properties a person may see and as what — a read model over
// these rows, not a `user_account`.
//
// A Property Group and a Shared Collection Point both gather properties, and
// they are different things: a Group is administrative (one invoice, one
// report, one agreement), a Point is a physical place where several properties
// put their waste, so it carries a location, an access mode and a billing
// mode, and a Property may belong to both. A Point's `location` is NOT NULL
// because the place is the record.
//
// A member and a party reference their Property through a `projectReference`:
// both tables are project-scoped, so the key carries `project_id` and a group
// of one project cannot gather another project's properties. A Customer is
// company-wide, so a party's reference to it is a plain `tenantReference`.
import {
  CUSTOMER_KINDS,
  CUSTOMER_STATUSES,
  PROPERTY_GROUP_MEMBER_ROLES,
  PROPERTY_GROUP_PURPOSES,
  PROPERTY_GROUP_STATUSES,
  PROPERTY_KINDS,
  PROPERTY_PARTY_ROLES,
  PROPERTY_STATUSES,
  SHARED_COLLECTION_POINT_ACCESS_MODES,
  SHARED_COLLECTION_POINT_BILLING_MODES,
  SHARED_COLLECTION_POINT_KINDS,
  SHARED_COLLECTION_POINT_MEMBER_ROLES,
  SHARED_COLLECTION_POINT_OPERATING_MODELS,
  SHARED_COLLECTION_POINT_STATUSES,
} from "@waste/domain/registry/vocabulary"
import { sql } from "drizzle-orm"
import { boolean, integer, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { lowercase, oneOf, positive } from "./checks"
import { id, projectScoped, tenant, timestamps } from "./columns"
import { geometry, validGeometry } from "./geometry"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantKey, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const customer = wms.table(
  "customer",
  {
    ...id,
    ...tenant,
    ...timestamps,
    kind: text().notNull(),
    name: text().notNull(),
    /** A CVR number in Denmark; optional for a person and an organisation alike. */
    registrationNumber: text(),
    email: text(),
    phone: text(),
    billingAddress: text(),
    /** Whether the Customer may be written to about their service at all. */
    serviceMessagesAllowed: boolean().notNull().default(true),
    status: text().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantKey(t),
    oneOf(t.kind, CUSTOMER_KINDS),
    oneOf(t.status, CUSTOMER_STATUSES),
    lowercase(t.email),
    // Most customers have no registration number, and a null is not a
    // duplicate of another null, so the key is a partial index rather than a
    // unique constraint.
    uniqueIndex(tableObjectName(t.companyId.table, "registration_number_idx", "customer"))
      .on(t.companyId, t.registrationNumber)
      .where(sql`${t.registrationNumber} is not null`),
  ],
)

export const property = wms.table(
  "property",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** The display name: `Parkvej 18`. */
    name: text().notNull(),
    /** The service address as one text; a structured address arrives with the address lookup (#77). */
    address: text().notNull(),
    /** The property registry's identifier: a BFE number in Denmark. */
    registryId: text(),
    kind: text().notNull(),
    /** Geocoded, null until it is. */
    location: geometry.point(),
    notes: text(),
    status: text().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantUnique(t, t.projectId, t.name),
    projectKey(t),
    oneOf(t.kind, PROPERTY_KINDS),
    oneOf(t.status, PROPERTY_STATUSES),
    validGeometry(t.location),
    uniqueIndex(tableObjectName(t.companyId.table, "registry_id_idx", "property")).on(t.companyId, t.registryId).where(sql`${t.registryId} is not null`),
  ],
)

export const propertyParty = wms.table(
  "property_party",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    propertyId: uuid().notNull(),
    customerId: uuid().notNull(),
    role: text().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.propertyId], property),
    tenantReference(t, [t.customerId], customer),
    // One Customer may be several things to one Property (an owner who also pays), so the role is part of the key.
    tenantUnique(t, t.propertyId, t.customerId, t.role),
    tenantIndex(t, t.customerId),
    oneOf(t.role, PROPERTY_PARTY_ROLES),
  ],
)

export const propertyGroup = wms.table(
  "property_group",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    name: text().notNull(),
    purpose: text().notNull(),
    /** The Customer the Group answers to: a housing association, an administrator. */
    responsibleCustomerId: uuid(),
    status: text().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.responsibleCustomerId], customer),
    tenantUnique(t, t.projectId, t.name),
    projectKey(t),
    oneOf(t.purpose, PROPERTY_GROUP_PURPOSES),
    oneOf(t.status, PROPERTY_GROUP_STATUSES),
    tenantIndex(t, t.responsibleCustomerId),
  ],
)

export const propertyGroupMember = wms.table(
  "property_group_member",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    propertyGroupId: uuid().notNull(),
    propertyId: uuid().notNull(),
    role: text().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.propertyGroupId], propertyGroup),
    projectReference(t, [t.propertyId], property),
    tenantUnique(t, t.propertyGroupId, t.propertyId),
    tenantIndex(t, t.propertyId),
    oneOf(t.role, PROPERTY_GROUP_MEMBER_ROLES),
  ],
)

export const sharedCollectionPoint = wms.table(
  "shared_collection_point",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    name: text().notNull(),
    kind: text().notNull(),
    address: text().notNull(),
    /** The place is the record, so the point is always located. */
    location: geometry.point().notNull(),
    /** How far a Property may be and still be served here. */
    eligibilityDistanceM: integer(),
    operatingModel: text().notNull(),
    accessMode: text().notNull(),
    /** What a user has to do or show, in words, where the mode alone does not say. */
    accessConditions: text(),
    /** When it is open, in words; opening hours as data are Planning's. */
    availability: text(),
    billingMode: text().notNull(),
    responsibleCustomerId: uuid(),
    status: text().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.responsibleCustomerId], customer),
    tenantUnique(t, t.projectId, t.name),
    projectKey(t),
    validGeometry(t.location),
    positive(t.eligibilityDistanceM),
    oneOf(t.kind, SHARED_COLLECTION_POINT_KINDS),
    oneOf(t.operatingModel, SHARED_COLLECTION_POINT_OPERATING_MODELS),
    oneOf(t.accessMode, SHARED_COLLECTION_POINT_ACCESS_MODES),
    oneOf(t.billingMode, SHARED_COLLECTION_POINT_BILLING_MODES),
    oneOf(t.status, SHARED_COLLECTION_POINT_STATUSES),
    tenantIndex(t, t.responsibleCustomerId),
  ],
)

export const sharedCollectionPointMember = wms.table(
  "shared_collection_point_member",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    sharedCollectionPointId: uuid().notNull(),
    propertyId: uuid().notNull(),
    role: text().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.sharedCollectionPointId], sharedCollectionPoint),
    projectReference(t, [t.propertyId], property),
    // One membership per Property at a Point. `tenantUnique` would derive
    // `shared_collection_point_member_shared_collection_point_id_property_id_key`,
    // 73 bytes, which names.ts refuses and Postgres would truncate; the key is
    // named for what it holds instead.
    unique(tableObjectName(t.companyId.table, "membership_key", "sharedCollectionPointMember")).on(t.companyId, t.sharedCollectionPointId, t.propertyId),
    tenantIndex(t, t.propertyId),
    oneOf(t.role, SHARED_COLLECTION_POINT_MEMBER_ROLES),
  ],
)
