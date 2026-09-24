// The Registry's closed lists: every kind, status, role, purpose, mode and
// unit the context's rows may carry, spelled once (Issue #78). The database
// reads them into its `CHECK ... in (...)` constraints (`oneOf` in
// packages/db/src/schema/checks.ts) and the contracts read them into their
// `z.enum`, so the check at the API boundary and the check in the table cannot
// drift and there is no lockstep test to write. The Organisation & Access
// statuses keep their two spellings and their lockstep test; they came first
// and are not touched.
//
// A value is a kebab-case token, lowercase words joined by single hyphens: it
// goes into a migration as a SQL literal and onto the wire as an enum member,
// and those are the same string. Adding one is a code change and a migration,
// since the table's check names its values; the rendering test says so by
// failing when drizzle-kit's output for the schema no longer matches the
// applied file.
//
// A list is exported as a `readonly` tuple with a type read off it, so a
// column, a form field and a route parameter all narrow to the same union.
// `REGISTRY_VOCABULARIES` names them all for a test that walks them.

/** A Customer is a person or an organisation; a sole trader is an organisation with no registration number. */
export const CUSTOMER_KINDS = ["person", "organisation"] as const
/** Whether the Customer is served; a record is deactivated, never deleted. */
export const CUSTOMER_STATUSES = ["active", "inactive"] as const

/** What stands on the Property, which decides what may be collected there. */
export const PROPERTY_KINDS = ["residential", "commercial", "public", "mixed", "other"] as const
/** Whether the Property is served. */
export const PROPERTY_STATUSES = ["active", "inactive"] as const
/** What a Customer is to a Property: the prototype's owner, payer and primary contact are all roles here. */
export const PROPERTY_PARTY_ROLES = ["owner", "payer", "tenant", "administrator", "service-contact"] as const

/** Why the Property Group exists, which decides what reads it. */
export const PROPERTY_GROUP_PURPOSES = ["administration", "reporting", "service", "agreement"] as const
/** Whether the Property Group is in use. */
export const PROPERTY_GROUP_STATUSES = ["draft", "active", "inactive"] as const
/** What a Property is to its Group. */
export const PROPERTY_GROUP_MEMBER_ROLES = ["member", "administrator", "payer", "reporting"] as const

/** How the Shared Collection Point is built. */
export const SHARED_COLLECTION_POINT_KINDS = ["surface", "underground", "recycling-station", "commercial", "other"] as const
/** Who runs the Shared Collection Point. */
export const SHARED_COLLECTION_POINT_OPERATING_MODELS = ["municipal", "member-funded", "company-operated", "service-provider-operated"] as const
/** Who may use the Shared Collection Point, and how they prove it. */
export const SHARED_COLLECTION_POINT_ACCESS_MODES = ["open", "member", "credential", "restricted"] as const
/** Who pays for the Shared Collection Point. */
export const SHARED_COLLECTION_POINT_BILLING_MODES = ["municipal", "single-payer", "member-share", "usage"] as const
/** Whether the Shared Collection Point takes waste, and from whom. */
export const SHARED_COLLECTION_POINT_STATUSES = ["draft", "open", "restricted", "closed"] as const
/** What a Property is to the Shared Collection Point it is a member of. */
export const SHARED_COLLECTION_POINT_MEMBER_ROLES = ["service-member", "administrator", "payer", "notification-contact"] as const

/** What the Product delivers: a collection at a container, a recurring service, or a one-off. */
export const PRODUCT_KINDS = ["container-collection", "recurring-service", "additional-service"] as const
/** Whether the Product may be subscribed to. */
export const PRODUCT_STATUSES = ["draft", "active", "inactive"] as const
/** What one of the Product is: prices are Finance & Contracting's, the unit they are quoted per is here. */
export const PRODUCT_UNITS = ["pickup", "month", "job"] as const

/** Where the Agreement stands; "expiring", "expired" and "terminated" are readings of `valid_to` (ADR-0005), never stored. */
export const AGREEMENT_STATUSES = ["draft", "active", "cancelled"] as const
/** How often the Agreement is billed. */
export const BILLING_CADENCES = ["monthly", "quarterly", "annual", "manual"] as const

/** Whose Container it is; `unrecorded` is what an imported registry usually says. */
export const CONTAINER_OWNERSHIPS = ["company", "customer", "unrecorded"] as const

export type CustomerKind = (typeof CUSTOMER_KINDS)[number]
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number]
export type PropertyKind = (typeof PROPERTY_KINDS)[number]
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number]
export type PropertyPartyRole = (typeof PROPERTY_PARTY_ROLES)[number]
export type PropertyGroupPurpose = (typeof PROPERTY_GROUP_PURPOSES)[number]
export type PropertyGroupStatus = (typeof PROPERTY_GROUP_STATUSES)[number]
export type PropertyGroupMemberRole = (typeof PROPERTY_GROUP_MEMBER_ROLES)[number]
export type SharedCollectionPointKind = (typeof SHARED_COLLECTION_POINT_KINDS)[number]
export type SharedCollectionPointOperatingModel = (typeof SHARED_COLLECTION_POINT_OPERATING_MODELS)[number]
export type SharedCollectionPointAccessMode = (typeof SHARED_COLLECTION_POINT_ACCESS_MODES)[number]
export type SharedCollectionPointBillingMode = (typeof SHARED_COLLECTION_POINT_BILLING_MODES)[number]
export type SharedCollectionPointStatus = (typeof SHARED_COLLECTION_POINT_STATUSES)[number]
export type SharedCollectionPointMemberRole = (typeof SHARED_COLLECTION_POINT_MEMBER_ROLES)[number]
export type ProductKind = (typeof PRODUCT_KINDS)[number]
export type ProductStatus = (typeof PRODUCT_STATUSES)[number]
export type ProductUnit = (typeof PRODUCT_UNITS)[number]
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number]
export type BillingCadence = (typeof BILLING_CADENCES)[number]
export type ContainerOwnership = (typeof CONTAINER_OWNERSHIPS)[number]

/** Every list of this module by its name, for a test that walks them and for a reader looking for the whole vocabulary at once. */
export const REGISTRY_VOCABULARIES = {
  CUSTOMER_KINDS,
  CUSTOMER_STATUSES,
  PROPERTY_KINDS,
  PROPERTY_STATUSES,
  PROPERTY_PARTY_ROLES,
  PROPERTY_GROUP_PURPOSES,
  PROPERTY_GROUP_STATUSES,
  PROPERTY_GROUP_MEMBER_ROLES,
  SHARED_COLLECTION_POINT_KINDS,
  SHARED_COLLECTION_POINT_OPERATING_MODELS,
  SHARED_COLLECTION_POINT_ACCESS_MODES,
  SHARED_COLLECTION_POINT_BILLING_MODES,
  SHARED_COLLECTION_POINT_STATUSES,
  SHARED_COLLECTION_POINT_MEMBER_ROLES,
  PRODUCT_KINDS,
  PRODUCT_STATUSES,
  PRODUCT_UNITS,
  AGREEMENT_STATUSES,
  BILLING_CADENCES,
  CONTAINER_OWNERSHIPS,
} as const satisfies Record<string, readonly [string, ...string[]]>
