// Who is served and where, on the wire (Issue #78): the Customer, the
// Property, the parties between them, the Property Group and the Shared
// Collection Point with its members. Nothing here is effective-dated
// (ADR-0005): a party or a membership is present or absent, and a Customer, a
// Property, a Group and a Point each carry a status instead.
//
// A Customer is one record for a person and an organisation alike — the
// prototype's "Contacts & Companies" is this one resource — so everything but
// the kind, the name and the status is optional: a sole trader has no
// registration number, and a customer who never gave a phone number still has
// to be billable.
//
// A membership travels with the record it is a membership of, and it is
// replaced whole: `Property.parties`, `PropertyGroup.members` and
// `SharedCollectionPoint.members` are read with their record, and a PUT of
// the whole list is how they change, since "add one, remove one" over a set
// the client already holds is two requests that can disagree. Each set body
// refuses the same pair twice, because the database's key refuses it as a
// duplicate and a 400 naming the rule is a better answer than a 409 naming a
// constraint. A body is bounded and a resource is not: a set body is a form's
// list, and a group of more than two hundred properties arrives through an
// import rather than a PUT, but a group that already has that many has to
// read back whatever it grew to.
//
// A create body may carry the list it starts with, so the form that makes a
// property with its owner is one request; a patch never does, because a patch
// is a field-by-field change and a membership is a set.
//
// A Property's `location` is the first point this system stores rather than
// derives: it is null until the address is geocoded. A Shared Collection
// Point's is not nullable — the place is the record. Both are `FlatPoint`
// (geojson.ts): the column is `geometry(Point, 4326)`, flat, so a third
// ordinate is refused here at `coordinates` and never by PostGIS as a 500.
//
// A Property may be found in the address register (#291 C13): a body that
// names the register's `addressId` instead of typing `address` is stored with
// the register's designation as its address, its parts beside it, and the
// register's BFE number and point wherever the body sets neither — a point
// placed by hand at the bins' gate wins. Typing the address is still whole:
// a register that does not answer leaves the office the typed address and a
// point placed by hand, and a typed address is no longer the register's, so
// a patch of `address` alone lets the register's id and parts go.
import {
  CONTACT_ROLES,
  CONTACT_STATUSES,
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
import * as z from "zod"

import { AddressId, AddressParts } from "./addresses"
import { PaymentTermsDays } from "./finance"
import { FlatPoint } from "./geojson"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, PositiveInt, somethingToChange, stamped } from "./resource"
import { TimeWindow } from "./shifts"
import { Label, Paragraph } from "./text"

/** A person or an organisation. */
export const CustomerKind = z.enum(CUSTOMER_KINDS)
export type CustomerKind = z.infer<typeof CustomerKind>

/** Whether the Customer is served; a record is deactivated, never deleted. */
export const CustomerStatus = z.enum(CUSTOMER_STATUSES)
export type CustomerStatus = z.infer<typeof CustomerStatus>

/** What stands on the Property. */
export const PropertyKind = z.enum(PROPERTY_KINDS)
export type PropertyKind = z.infer<typeof PropertyKind>

/** Whether the Property is served. */
export const PropertyStatus = z.enum(PROPERTY_STATUSES)
export type PropertyStatus = z.infer<typeof PropertyStatus>

/** What a Customer is to a Property. */
export const PropertyPartyRole = z.enum(PROPERTY_PARTY_ROLES)
export type PropertyPartyRole = z.infer<typeof PropertyPartyRole>

/** Why the Property Group exists. */
export const PropertyGroupPurpose = z.enum(PROPERTY_GROUP_PURPOSES)
export type PropertyGroupPurpose = z.infer<typeof PropertyGroupPurpose>

/** Whether the Property Group is in use. */
export const PropertyGroupStatus = z.enum(PROPERTY_GROUP_STATUSES)
export type PropertyGroupStatus = z.infer<typeof PropertyGroupStatus>

/** What a Property is to its Group. */
export const PropertyGroupMemberRole = z.enum(PROPERTY_GROUP_MEMBER_ROLES)
export type PropertyGroupMemberRole = z.infer<typeof PropertyGroupMemberRole>

/** How the Shared Collection Point is built. */
export const SharedCollectionPointKind = z.enum(SHARED_COLLECTION_POINT_KINDS)
export type SharedCollectionPointKind = z.infer<typeof SharedCollectionPointKind>

/** Who runs the Shared Collection Point. */
export const SharedCollectionPointOperatingModel = z.enum(SHARED_COLLECTION_POINT_OPERATING_MODELS)
export type SharedCollectionPointOperatingModel = z.infer<typeof SharedCollectionPointOperatingModel>

/** Who may use the Shared Collection Point, and how they prove it. */
export const SharedCollectionPointAccessMode = z.enum(SHARED_COLLECTION_POINT_ACCESS_MODES)
export type SharedCollectionPointAccessMode = z.infer<typeof SharedCollectionPointAccessMode>

/** Who pays for the Shared Collection Point. */
export const SharedCollectionPointBillingMode = z.enum(SHARED_COLLECTION_POINT_BILLING_MODES)
export type SharedCollectionPointBillingMode = z.infer<typeof SharedCollectionPointBillingMode>

/** Whether the Shared Collection Point takes waste, and from whom. */
export const SharedCollectionPointStatus = z.enum(SHARED_COLLECTION_POINT_STATUSES)
export type SharedCollectionPointStatus = z.infer<typeof SharedCollectionPointStatus>

/** What a Property is to the Shared Collection Point it is a member of. */
export const SharedCollectionPointMemberRole = z.enum(SHARED_COLLECTION_POINT_MEMBER_ROLES)
export type SharedCollectionPointMemberRole = z.infer<typeof SharedCollectionPointMemberRole>

/**
 * The most a set body may carry: a form's list, not an import. A resource
 * carries the same entries unbounded, since a membership already stored is a
 * membership that has to parse however long it grew.
 */
const SET_MAX = 200

/** A distance in whole metres; zero is not a distance. */
const Metres = PositiveInt

/** Each entry names its row once, as the database's key insists. */
const eachNamedOnce = <Entry>(entries: readonly Entry[], key: (entry: Entry) => string) => new Set(entries.map(key)).size === entries.length

export const Customer = z.object({
  ...stamped,
  kind: CustomerKind,
  /** A person's name or an organisation's. */
  name: Label,
  /** A CVR number in Denmark; null where there is none, which is most people. */
  registrationNumber: Label.nullable(),
  /** Stored lowercase; the route lowercases it, the database's check is the backstop. */
  email: z.email().nullable(),
  phone: Label.nullable(),
  /** Where the invoice goes when it is not the service address. */
  billingAddress: Paragraph.nullable(),
  /** Whether the Customer may be written to about their service at all. */
  serviceMessagesAllowed: z.boolean(),
  status: CustomerStatus,
  /** Its own payment terms (#291 C4), which its invoices are due by instead of their project's; null keeps the project's. */
  paymentTermsDays: PaymentTermsDays.nullable(),
})
export type Customer = z.infer<typeof Customer>

export const CustomerCreate = z.strictObject({
  kind: CustomerKind,
  name: Label,
  registrationNumber: Label.nullable().optional(),
  email: z.email().nullable().optional(),
  phone: Label.nullable().optional(),
  billingAddress: Paragraph.nullable().optional(),
  serviceMessagesAllowed: z
    .boolean()
    .default(true)
    .describe("Defaults to true when absent: a customer is written to about their own service until they say not to."),
  status: CustomerStatus.default("active").describe("Defaults to active when absent: a customer is registered in order to be served."),
  paymentTermsDays: PaymentTermsDays.nullable().optional().describe("Null or absent keeps its projects' terms."),
})
export type CustomerCreate = z.infer<typeof CustomerCreate>

export const CustomerPatch = z
  .strictObject({
    kind: CustomerKind.optional(),
    name: Label.optional(),
    registrationNumber: Label.nullable().optional(),
    email: z.email().nullable().optional(),
    phone: Label.nullable().optional(),
    billingAddress: Paragraph.nullable().optional(),
    serviceMessagesAllowed: z.boolean().optional(),
    status: CustomerStatus.optional(),
    /** Null gives the project's terms back. */
    paymentTermsDays: PaymentTermsDays.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type CustomerPatch = z.infer<typeof CustomerPatch>

/** What a Contact Person does for the organisation they speak for (#291 C14). */
export const ContactRole = z.enum(CONTACT_ROLES)
export type ContactRole = z.infer<typeof ContactRole>

/** Whether the Contact Person still speaks for their Customer; one who has left is made inactive, never deleted. */
export const ContactStatus = z.enum(CONTACT_STATUSES)
export type ContactStatus = z.infer<typeof ContactStatus>

/** A contact is reached on an e-mail or a phone, or both; one with neither could never be written to. */
export const REACHABLE_ON_A_CHANNEL = "Give an e-mail or a phone: a contact is reached on one at least"
const reachable = (contact: { email?: string | null; phone?: string | null }) => contact.email != null || contact.phone != null

/**
 * A Contact Person (#291 C14): a named person who speaks for an organisation
 * Customer, with a role and the channels they are reached on. A person
 * Customer is their own contact and has none. Read under its customer
 * (`GET /customers/:id/contacts`) and written one at a time; there is no
 * delete, since a message sent to one stays on its ledger naming them.
 */
export const CustomerContact = z.object({
  ...stamped,
  customerId: Id,
  name: Label,
  role: ContactRole,
  /** Stored lowercase, as a customer's is. */
  email: z.email().nullable(),
  phone: Label.nullable(),
  status: ContactStatus,
})
export type CustomerContact = z.infer<typeof CustomerContact>

export const CustomerContactCreate = z
  .strictObject({
    name: Label,
    role: ContactRole,
    email: z.email().nullable().optional(),
    phone: Label.nullable().optional(),
    status: ContactStatus.default("active").describe("Defaults to active when absent: a contact is registered in order to be reached."),
  })
  .refine(reachable, { message: REACHABLE_ON_A_CHANNEL, path: ["email"] })
export type CustomerContactCreate = z.infer<typeof CustomerContactCreate>

/** Every field optional; a null clears a channel, and the route refuses a patch that would leave the contact with neither. */
export const CustomerContactPatch = z
  .strictObject({
    name: Label.optional(),
    role: ContactRole.optional(),
    email: z.email().nullable().optional(),
    phone: Label.nullable().optional(),
    status: ContactStatus.optional(),
  })
  .refine(changesSomething, somethingToChange)
export type CustomerContactPatch = z.infer<typeof CustomerContactPatch>

/** A customer's contacts, every one: an organisation has a handful, never a page's worth. */
export const CustomerContacts = z.object({ items: z.array(CustomerContact) })
export type CustomerContacts = z.infer<typeof CustomerContacts>

/** What one Customer is to one Property. One customer may be several things to one property, so the role is part of the pair. */
export const PropertyParty = z.strictObject({
  customerId: Id,
  role: PropertyPartyRole,
})
export type PropertyParty = z.infer<typeof PropertyParty>

const Parties = z.array(PropertyParty)
const PartiesBody = Parties.max(SET_MAX)
const partiesNamedOnce = {
  message: "Name each customer once per role: a party is a customer and a role, and the list holds each pair once",
  path: ["parties"],
}
const noRepeatedParty = (parties: readonly PropertyParty[]) => eachNamedOnce(parties, (party) => `${party.customerId} ${party.role}`)

export const Property = z.object({
  ...stamped,
  projectId: Id,
  /** The display name: `Parkvej 18`. */
  name: Label,
  /** The service address as one text: the register's designation where the property was found there. */
  address: Paragraph,
  /** The address register's id for the address (DAR, #291 C13); null where the address was typed. */
  addressId: AddressId.nullable(),
  /** The address's parts as the register holds them, with `addressId` and only with it. */
  addressParts: AddressParts.nullable(),
  /** The property registry's identifier: a BFE number in Denmark. */
  registryId: Label.nullable(),
  kind: PropertyKind,
  /** Geocoded, null until it is. */
  location: FlatPoint.nullable(),
  /** The office's own, never shown to a driver. */
  notes: Paragraph.nullable(),
  /** What the driver is told at the place — the gate code, where the bins stand: the Driver App's stop shows it. */
  driverInstructions: Paragraph.nullable(),
  /** The property's access hours (O14 of #290): when in the day a stop here may be served, on the project's clock; null is any time. */
  serviceWindow: TimeWindow.nullable(),
  status: PropertyStatus,
  /** Who the property's customers are and as what; replaced whole through its own route. */
  parties: Parties,
})
export type Property = z.infer<typeof Property>

/** A body names the address one way: typed, or the register's. */
const oneAddress = {
  message: "Give the address typed, or the address register's addressId, not both",
  path: ["addressId"],
}
const typedOrFound = (body: { address?: string; addressId?: string | null }) => !(body.address !== undefined && body.addressId != null)

export const PropertyCreate = z
  .strictObject({
    projectId: Id,
    name: Label,
    /** Typed; or leave it out and name `addressId`, and the register's designation is stored. */
    address: Paragraph.optional(),
    /** The address register's id (`GET /addresses`): the address, its parts, and the BFE number and point the body does not set, read from the register. */
    addressId: AddressId.optional(),
    registryId: Label.nullable().optional(),
    kind: PropertyKind,
    location: FlatPoint.nullable().optional(),
    notes: Paragraph.nullable().optional(),
    driverInstructions: Paragraph.nullable().optional(),
    serviceWindow: TimeWindow.nullable().optional(),
    status: PropertyStatus.default("active").describe("Defaults to active when absent: a property is registered in order to be served."),
    parties: PartiesBody.default([]).describe("The parties the property starts with; none when absent."),
  })
  .refine(typedOrFound, oneAddress)
  .refine((body) => body.address !== undefined || body.addressId !== undefined, { message: "Give the address, typed or as the address register's addressId", path: ["address"] })
  .refine((body) => noRepeatedParty(body.parties), partiesNamedOnce)
export type PropertyCreate = z.infer<typeof PropertyCreate>

/** The parties are a set and are replaced whole, so they are not here; the project is not a property's to change. */
export const PropertyPatch = z
  .strictObject({
    name: Label.optional(),
    /** Typed: the register's id and parts go with the text they no longer spell. */
    address: Paragraph.optional(),
    /** The address register's id: the address and its parts read from the register, the BFE number and point too where the body sets neither; null lets the register's id and parts go and keeps the text. */
    addressId: AddressId.nullable().optional(),
    registryId: Label.nullable().optional(),
    kind: PropertyKind.optional(),
    location: FlatPoint.nullable().optional(),
    notes: Paragraph.nullable().optional(),
    driverInstructions: Paragraph.nullable().optional(),
    /** Written whole; null clears it to any time of the day. */
    serviceWindow: TimeWindow.nullable().optional(),
    status: PropertyStatus.optional(),
  })
  .refine(changesSomething, somethingToChange)
  .refine(typedOrFound, oneAddress)
export type PropertyPatch = z.infer<typeof PropertyPatch>

/** The whole list, replacing what the property had. An empty list is a property nobody is billed for. */
export const PropertyPartiesSet = z.strictObject({ parties: PartiesBody }).refine((body) => noRepeatedParty(body.parties), partiesNamedOnce)
export type PropertyPartiesSet = z.infer<typeof PropertyPartiesSet>

/** A page of properties, from one project and of one customer's. */
export const PropertyListQuery = ProjectScopedListQuery.extend({
  /** The properties this customer is a party to, in any role. */
  customerId: Id.optional(),
})
export type PropertyListQuery = z.infer<typeof PropertyListQuery>

/** What one Property is to its Group. A property is a member or it is not, so the property alone is the key. */
export const PropertyGroupMember = z.strictObject({
  propertyId: Id,
  role: PropertyGroupMemberRole,
})
export type PropertyGroupMember = z.infer<typeof PropertyGroupMember>

const GroupMembers = z.array(PropertyGroupMember)
const GroupMembersBody = GroupMembers.max(SET_MAX)
const groupMembersNamedOnce = {
  message: "Name each property once: a property is a member of the group or it is not, and the role says what kind",
  path: ["members"],
}
const noRepeatedGroupMember = (members: readonly PropertyGroupMember[]) => eachNamedOnce(members, (member) => member.propertyId)

export const PropertyGroup = z.object({
  ...stamped,
  projectId: Id,
  name: Label,
  purpose: PropertyGroupPurpose,
  /** The Customer the Group answers to: a housing association, an administrator. */
  responsibleCustomerId: Id.nullable(),
  status: PropertyGroupStatus,
  members: GroupMembers,
})
export type PropertyGroup = z.infer<typeof PropertyGroup>

export const PropertyGroupCreate = z
  .strictObject({
    projectId: Id,
    name: Label,
    purpose: PropertyGroupPurpose,
    responsibleCustomerId: Id.nullable().optional(),
    status: PropertyGroupStatus.default("draft").describe("Defaults to draft when absent: a group is gathered before it is used."),
    members: GroupMembersBody.default([]).describe("The properties the group starts with; none when absent."),
  })
  .refine((body) => noRepeatedGroupMember(body.members), groupMembersNamedOnce)
export type PropertyGroupCreate = z.infer<typeof PropertyGroupCreate>

export const PropertyGroupPatch = z
  .strictObject({
    name: Label.optional(),
    purpose: PropertyGroupPurpose.optional(),
    responsibleCustomerId: Id.nullable().optional(),
    status: PropertyGroupStatus.optional(),
  })
  .refine(changesSomething, somethingToChange)
export type PropertyGroupPatch = z.infer<typeof PropertyGroupPatch>

/** The whole membership, replacing what the group had. */
export const PropertyGroupMembersSet = z
  .strictObject({ members: GroupMembersBody })
  .refine((body) => noRepeatedGroupMember(body.members), groupMembersNamedOnce)
export type PropertyGroupMembersSet = z.infer<typeof PropertyGroupMembersSet>

/** What one Property is to the Point it puts its waste at. */
export const SharedCollectionPointMember = z.strictObject({
  propertyId: Id,
  role: SharedCollectionPointMemberRole,
})
export type SharedCollectionPointMember = z.infer<typeof SharedCollectionPointMember>

const PointMembers = z.array(SharedCollectionPointMember)
const PointMembersBody = PointMembers.max(SET_MAX)
const pointMembersNamedOnce = {
  message: "Name each property once: a property is a member of the point or it is not, and the role says what kind",
  path: ["members"],
}
const noRepeatedPointMember = (members: readonly SharedCollectionPointMember[]) => eachNamedOnce(members, (member) => member.propertyId)

export const SharedCollectionPoint = z.object({
  ...stamped,
  projectId: Id,
  name: Label,
  kind: SharedCollectionPointKind,
  address: Paragraph,
  /** The place is the record, so the point is always located. */
  location: FlatPoint,
  /** How far a Property may be and still be served here. */
  eligibilityDistanceM: Metres.nullable(),
  operatingModel: SharedCollectionPointOperatingModel,
  accessMode: SharedCollectionPointAccessMode,
  /** What a user has to do or show, in words, where the mode alone does not say. */
  accessConditions: Paragraph.nullable(),
  /** When it is open, in words; opening hours as data are Planning's. */
  availability: Label.nullable(),
  /** What the driver is told at the point: the Driver App's stop shows it. */
  driverInstructions: Paragraph.nullable(),
  billingMode: SharedCollectionPointBillingMode,
  responsibleCustomerId: Id.nullable(),
  status: SharedCollectionPointStatus,
  members: PointMembers,
})
export type SharedCollectionPoint = z.infer<typeof SharedCollectionPoint>

export const SharedCollectionPointCreate = z
  .strictObject({
    projectId: Id,
    name: Label,
    kind: SharedCollectionPointKind,
    address: Paragraph,
    location: FlatPoint,
    eligibilityDistanceM: Metres.nullable().optional(),
    operatingModel: SharedCollectionPointOperatingModel,
    accessMode: SharedCollectionPointAccessMode,
    accessConditions: Paragraph.nullable().optional(),
    availability: Label.nullable().optional(),
    driverInstructions: Paragraph.nullable().optional(),
    billingMode: SharedCollectionPointBillingMode,
    responsibleCustomerId: Id.nullable().optional(),
    status: SharedCollectionPointStatus.default("draft").describe("Defaults to draft when absent: a point is planned before it takes waste."),
    members: PointMembersBody.default([]).describe("The properties the point starts with; none when absent."),
  })
  .refine((body) => noRepeatedPointMember(body.members), pointMembersNamedOnce)
export type SharedCollectionPointCreate = z.infer<typeof SharedCollectionPointCreate>

export const SharedCollectionPointPatch = z
  .strictObject({
    name: Label.optional(),
    kind: SharedCollectionPointKind.optional(),
    address: Paragraph.optional(),
    location: FlatPoint.optional(),
    eligibilityDistanceM: Metres.nullable().optional(),
    operatingModel: SharedCollectionPointOperatingModel.optional(),
    accessMode: SharedCollectionPointAccessMode.optional(),
    accessConditions: Paragraph.nullable().optional(),
    availability: Label.nullable().optional(),
    driverInstructions: Paragraph.nullable().optional(),
    billingMode: SharedCollectionPointBillingMode.optional(),
    responsibleCustomerId: Id.nullable().optional(),
    status: SharedCollectionPointStatus.optional(),
  })
  .refine(changesSomething, somethingToChange)
export type SharedCollectionPointPatch = z.infer<typeof SharedCollectionPointPatch>

/** The whole membership, replacing what the point had. */
export const SharedCollectionPointMembersSet = z
  .strictObject({ members: PointMembersBody })
  .refine((body) => noRepeatedPointMember(body.members), pointMembersNamedOnce)
export type SharedCollectionPointMembersSet = z.infer<typeof SharedCollectionPointMembersSet>
