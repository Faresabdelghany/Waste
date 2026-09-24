import assert from "node:assert/strict"
import { describe, test } from "node:test"

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

import {
  Customer,
  CustomerCreate,
  CustomerKind,
  CustomerPatch,
  CustomerStatus,
  Property,
  PropertyCreate,
  PropertyGroup,
  PropertyGroupCreate,
  PropertyGroupMemberRole,
  PropertyGroupMembersSet,
  PropertyGroupPatch,
  PropertyGroupPurpose,
  PropertyGroupStatus,
  PropertyKind,
  PropertyPartiesSet,
  PropertyPartyRole,
  PropertyListQuery,
  PropertyPatch,
  PropertyStatus,
  SharedCollectionPoint,
  SharedCollectionPointAccessMode,
  SharedCollectionPointBillingMode,
  SharedCollectionPointCreate,
  SharedCollectionPointKind,
  SharedCollectionPointMemberRole,
  SharedCollectionPointMembersSet,
  SharedCollectionPointOperatingModel,
  SharedCollectionPointPatch,
  SharedCollectionPointStatus,
} from "../customers"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-09-24T13:41:00.000Z", updatedAt: "2026-09-24T13:41:00.000Z" }
const POINT = { type: "Point", coordinates: [12.5683, 55.6761] }

/** More ids than a set body may carry, to tell the body's bound from the row's. */
const tooManyIds = Array.from({ length: 201 }, (_unused, index) => `01a0d3a5-e5e0-7000-8000-${String(index).padStart(12, "0")}`)

const customer = {
  id: ID,
  kind: "organisation",
  name: "Kystbyen Boligforening",
  registrationNumber: "38144210",
  email: "post@boligforening.example",
  phone: "+45 33 11 22 33",
  billingAddress: "Att. Regnskab\nParkvej 18\n2000 Frederiksberg",
  serviceMessagesAllowed: true,
  status: "active",
  ...STAMPS,
}

const property = {
  id: ID,
  projectId: OTHER,
  name: "Parkvej 18",
  address: "Parkvej 18, 2000 Frederiksberg",
  registryId: "4001234567",
  kind: "residential",
  location: POINT,
  notes: "Gate code at the caretaker.",
  status: "active",
  parties: [{ customerId: THIRD, role: "owner" }],
  ...STAMPS,
}

const group = {
  id: ID,
  projectId: OTHER,
  name: "Parkvej housing association",
  purpose: "administration",
  responsibleCustomerId: THIRD,
  status: "active",
  members: [{ propertyId: THIRD, role: "member" }],
  ...STAMPS,
}

const point = {
  id: ID,
  projectId: OTHER,
  name: "Parkvej underground point",
  kind: "underground",
  address: "Parkvej 20, 2000 Frederiksberg",
  location: POINT,
  eligibilityDistanceM: 150,
  operatingModel: "municipal",
  accessMode: "member",
  accessConditions: "Members open the lid with the chip on their key ring.",
  availability: "Open around the clock",
  billingMode: "member-share",
  responsibleCustomerId: THIRD,
  status: "open",
  members: [{ propertyId: THIRD, role: "service-member" }],
  ...STAMPS,
}

describe("the customer and property enums", () => {
  test("are the vocabulary the database checks against, value for value and in the same order", () => {
    assert.deepEqual(CustomerKind.options, [...CUSTOMER_KINDS])
    assert.deepEqual(CustomerStatus.options, [...CUSTOMER_STATUSES])
    assert.deepEqual(PropertyKind.options, [...PROPERTY_KINDS])
    assert.deepEqual(PropertyStatus.options, [...PROPERTY_STATUSES])
    assert.deepEqual(PropertyPartyRole.options, [...PROPERTY_PARTY_ROLES])
    assert.deepEqual(PropertyGroupPurpose.options, [...PROPERTY_GROUP_PURPOSES])
    assert.deepEqual(PropertyGroupStatus.options, [...PROPERTY_GROUP_STATUSES])
    assert.deepEqual(PropertyGroupMemberRole.options, [...PROPERTY_GROUP_MEMBER_ROLES])
    assert.deepEqual(SharedCollectionPointKind.options, [...SHARED_COLLECTION_POINT_KINDS])
    assert.deepEqual(SharedCollectionPointOperatingModel.options, [...SHARED_COLLECTION_POINT_OPERATING_MODELS])
    assert.deepEqual(SharedCollectionPointAccessMode.options, [...SHARED_COLLECTION_POINT_ACCESS_MODES])
    assert.deepEqual(SharedCollectionPointBillingMode.options, [...SHARED_COLLECTION_POINT_BILLING_MODES])
    assert.deepEqual(SharedCollectionPointStatus.options, [...SHARED_COLLECTION_POINT_STATUSES])
    assert.deepEqual(SharedCollectionPointMemberRole.options, [...SHARED_COLLECTION_POINT_MEMBER_ROLES])
  })
})

describe("Customer", () => {
  test("is one record for a person and an organisation alike, everything but the kind, the name and the status optional", () => {
    assert.deepEqual(Customer.parse(customer), customer)
    const person = { ...customer, kind: "person", name: "Olivia Larsen", registrationNumber: null, email: null, phone: null, billingAddress: null }
    assert.deepEqual(Customer.parse(person), person)
  })

  test("refuses an address that is not one, a kind outside the vocabulary and a blank name", () => {
    assert.equal(Customer.safeParse({ ...customer, email: "post at boligforening" }).success, false)
    assert.equal(Customer.safeParse({ ...customer, kind: "company" }).success, false)
    assert.equal(Customer.safeParse({ ...customer, name: "  " }).success, false)
  })
})

describe("CustomerCreate and CustomerPatch", () => {
  const body = { kind: "person", name: "Olivia Larsen" }

  test("default a new customer to active and to hearing from us, and say so in the schema", () => {
    assert.deepEqual(CustomerCreate.parse(body), { ...body, status: "active", serviceMessagesAllowed: true })
    assert.equal(CustomerCreate.parse({ ...body, serviceMessagesAllowed: false }).serviceMessagesAllowed, false)
    assert.match(CustomerCreate.shape.status.description ?? "", /active/)
    assert.match(CustomerCreate.shape.serviceMessagesAllowed.description ?? "", /service/i)
  })

  test("need a kind and a name, and mint nothing", () => {
    for (const key of ["kind", "name"]) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(CustomerCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    refusesWhatTheServerOwns(CustomerCreate, body)
  })

  test("clear an optional field with null, and refuse an empty patch", () => {
    assert.deepEqual(CustomerPatch.parse({ email: null }), { email: null })
    assert.deepEqual(CustomerPatch.parse({ status: "inactive" }), { status: "inactive" })
    refusesAnEmptyPatch(CustomerPatch)
  })
})

describe("Property", () => {
  test("is the service address, with its parties and the point it was geocoded to", () => {
    assert.deepEqual(Property.parse(property), property)
    const ungeocoded = { ...property, location: null, registryId: null, notes: null, parties: [] }
    assert.deepEqual(Property.parse(ungeocoded), ungeocoded)
  })

  test("takes the address as prose and the location as GeoJSON, and refuses anything else", () => {
    assert.equal(Property.safeParse({ ...property, address: "" }).success, false)
    assert.equal(Property.safeParse({ ...property, location: { type: "Point", coordinates: [200, 55] } }).success, false)
    assert.equal(Property.safeParse({ ...property, location: [12.5683, 55.6761] }).success, false)
    assert.equal(Property.safeParse({ ...property, kind: "house" }).success, false)
  })

  test("names each party by customer and role, and refuses a role outside the vocabulary", () => {
    assert.equal(Property.safeParse({ ...property, parties: [{ customerId: THIRD, role: "landlord" }] }).success, false)
    assert.equal(Property.safeParse({ ...property, parties: [{ customerId: "nobody", role: "owner" }] }).success, false)
  })
})

describe("PropertyCreate and PropertyPatch", () => {
  const body = { projectId: OTHER, name: "Parkvej 18", address: "Parkvej 18, 2000 Frederiksberg", kind: "residential" }

  test("default a new property to active with no parties, and say so in the schema", () => {
    assert.deepEqual(PropertyCreate.parse(body), { ...body, status: "active", parties: [] })
    assert.match(PropertyCreate.shape.status.description ?? "", /active/)
  })

  test("take the parties the form collected, need the project, the name, the address and the kind, and mint nothing", () => {
    const parties = [{ customerId: THIRD, role: "owner" }]
    assert.deepEqual(PropertyCreate.parse({ ...body, parties }).parties, parties)
    assert.deepEqual(refusal(PropertyCreate.safeParse({ ...body, parties: [parties[0], parties[0]] })), [
      { path: "parties", message: "Name each customer once per role: a party is a customer and a role, and the list holds each pair once" },
    ])
    for (const key of ["projectId", "name", "address", "kind"]) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(PropertyCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    refusesWhatTheServerOwns(PropertyCreate, body)
  })

  test("leave the parties to their own route: a patch does not carry them, and neither does the project", () => {
    assert.deepEqual(PropertyPatch.parse({ location: POINT }), { location: POINT })
    assert.deepEqual(PropertyPatch.parse({ notes: null }), { notes: null })
    refusesAnEmptyPatch(PropertyPatch)
    assert.match(refusal(PropertyPatch.safeParse({ name: "x", parties: [] }))[0].message, /parties/)
    assert.match(refusal(PropertyPatch.safeParse({ name: "x", projectId: OTHER }))[0].message, /projectId/)
  })
})

describe("PropertyPartiesSet", () => {
  test("replaces the whole list, the empty list included: a property with nobody on it is a property nobody is billed for", () => {
    const parties = [
      { customerId: THIRD, role: "owner" },
      { customerId: THIRD, role: "payer" },
      { customerId: OTHER, role: "tenant" },
    ]
    assert.deepEqual(PropertyPartiesSet.parse({ parties }), { parties })
    assert.deepEqual(PropertyPartiesSet.parse({ parties: [] }), { parties: [] })
  })

  test("refuses the same customer in the same role twice, which the database's key would refuse as a duplicate", () => {
    const parties = [
      { customerId: THIRD, role: "owner" },
      { customerId: THIRD, role: "owner" },
    ]
    assert.deepEqual(refusal(PropertyPartiesSet.safeParse({ parties })), [
      { path: "parties", message: "Name each customer once per role: a party is a customer and a role, and the list holds each pair once" },
    ])
  })

  test("is strict and bounded: no other member, and not a bulk import", () => {
    assert.match(refusal(PropertyPartiesSet.safeParse({ parties: [], propertyId: ID }))[0].message, /propertyId/)
    const many = tooManyIds.map((customerId) => ({ customerId, role: "tenant" }))
    assert.equal(PropertyPartiesSet.safeParse({ parties: many }).success, false)
    assert.equal(Property.parse({ ...property, parties: many }).parties.length, many.length, "the bound is a body's; a stored list has to parse however long it grew")
  })
})

describe("PropertyGroup", () => {
  test("is the administrative gathering: a purpose, the customer it answers to, and its members", () => {
    assert.deepEqual(PropertyGroup.parse(group), group)
    const unowned = { ...group, responsibleCustomerId: null, members: [] }
    assert.deepEqual(PropertyGroup.parse(unowned), unowned)
    assert.equal(PropertyGroup.safeParse({ ...group, purpose: "billing" }).success, false)
  })

  test("defaults a new group to a draft with no members, and never patches the project or the members", () => {
    const body = { projectId: OTHER, name: "Parkvej housing association", purpose: "administration" }
    assert.deepEqual(PropertyGroupCreate.parse(body), { ...body, status: "draft", members: [] })
    assert.match(PropertyGroupCreate.shape.status.description ?? "", /draft/)
    refusesWhatTheServerOwns(PropertyGroupCreate, body)
    refusesAnEmptyPatch(PropertyGroupPatch)
    assert.deepEqual(PropertyGroupPatch.parse({ status: "inactive" }), { status: "inactive" })
    assert.match(refusal(PropertyGroupPatch.safeParse({ name: "x", members: [] }))[0].message, /members/)
  })
})

describe("PropertyGroupMembersSet", () => {
  const namedOnce = { path: "members", message: "Name each property once: a property is a member of the group or it is not, and the role says what kind" }

  test("replaces the whole membership and refuses a property named twice", () => {
    const members = [
      { propertyId: THIRD, role: "member" },
      { propertyId: OTHER, role: "administrator" },
    ]
    assert.deepEqual(PropertyGroupMembersSet.parse({ members }), { members })
    assert.deepEqual(PropertyGroupMembersSet.parse({ members: [] }), { members: [] })
    assert.deepEqual(refusal(PropertyGroupMembersSet.safeParse({ members: [members[0], { propertyId: THIRD, role: "payer" }] })), [namedOnce])
  })

  test("is strict and bounded, while the group itself carries however many it gathered", () => {
    assert.match(refusal(PropertyGroupMembersSet.safeParse({ members: [], propertyGroupId: ID }))[0].message, /propertyGroupId/)
    const many = tooManyIds.map((propertyId) => ({ propertyId, role: "member" }))
    assert.equal(PropertyGroupMembersSet.safeParse({ members: many }).success, false)
    assert.equal(PropertyGroup.parse({ ...group, members: many }).members.length, many.length)
  })

  test("holds the create body to the same rule, since a group may be gathered with its members", () => {
    const body = { projectId: OTHER, name: "Parkvej housing association", purpose: "administration" }
    const member = { propertyId: THIRD, role: "member" }
    assert.deepEqual(PropertyGroupCreate.parse({ ...body, members: [member] }).members, [member])
    assert.deepEqual(refusal(PropertyGroupCreate.safeParse({ ...body, members: [member, member] })), [namedOnce])
  })
})

describe("SharedCollectionPoint", () => {
  test("is the place itself, so it is always located and always addressed", () => {
    assert.deepEqual(SharedCollectionPoint.parse(point), point)
    const bare = { ...point, eligibilityDistanceM: null, accessConditions: null, availability: null, responsibleCustomerId: null, members: [] }
    assert.deepEqual(SharedCollectionPoint.parse(bare), bare)
    assert.equal(SharedCollectionPoint.safeParse({ ...point, location: null }).success, false)
    assert.equal(SharedCollectionPoint.safeParse({ ...point, eligibilityDistanceM: 0 }).success, false)
    assert.equal(SharedCollectionPoint.safeParse({ ...point, billingMode: "invoice" }).success, false)
  })

  test("defaults a new point to a draft, needs its place, and mints nothing", () => {
    const body = {
      projectId: OTHER,
      name: "Parkvej underground point",
      kind: "underground",
      address: "Parkvej 20, 2000 Frederiksberg",
      location: POINT,
      operatingModel: "municipal",
      accessMode: "member",
      billingMode: "member-share",
    }
    assert.deepEqual(SharedCollectionPointCreate.parse(body), { ...body, status: "draft", members: [] })
    assert.match(SharedCollectionPointCreate.shape.status.description ?? "", /draft/)
    for (const key of ["projectId", "name", "kind", "address", "location", "operatingModel", "accessMode", "billingMode"]) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(SharedCollectionPointCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    refusesWhatTheServerOwns(SharedCollectionPointCreate, body)
  })

  test("patches the point but not its project or its membership", () => {
    assert.deepEqual(SharedCollectionPointPatch.parse({ status: "closed" }), { status: "closed" })
    assert.deepEqual(SharedCollectionPointPatch.parse({ accessConditions: null }), { accessConditions: null })
    refusesAnEmptyPatch(SharedCollectionPointPatch)
    assert.match(refusal(SharedCollectionPointPatch.safeParse({ name: "x", members: [] }))[0].message, /members/)
    assert.match(refusal(SharedCollectionPointPatch.safeParse({ name: "x", projectId: OTHER }))[0].message, /projectId/)
  })
})

describe("SharedCollectionPointMembersSet", () => {
  const namedOnce = { path: "members", message: "Name each property once: a property is a member of the point or it is not, and the role says what kind" }

  test("replaces the whole membership, refuses a property named twice and takes only the point's own roles", () => {
    const members = [{ propertyId: THIRD, role: "service-member" }]
    assert.deepEqual(SharedCollectionPointMembersSet.parse({ members }), { members })
    assert.deepEqual(SharedCollectionPointMembersSet.parse({ members: [] }), { members: [] })
    assert.deepEqual(refusal(SharedCollectionPointMembersSet.safeParse({ members: [members[0], { propertyId: THIRD, role: "payer" }] })), [namedOnce])
    assert.equal(SharedCollectionPointMembersSet.safeParse({ members: [{ propertyId: THIRD, role: "member" }] }).success, false)
  })

  test("is strict and bounded, while the point itself carries however many joined it", () => {
    assert.match(refusal(SharedCollectionPointMembersSet.safeParse({ members: [], sharedCollectionPointId: ID }))[0].message, /sharedCollectionPointId/)
    const many = tooManyIds.map((propertyId) => ({ propertyId, role: "service-member" }))
    assert.equal(SharedCollectionPointMembersSet.safeParse({ members: many }).success, false)
    assert.equal(SharedCollectionPoint.parse({ ...point, members: many }).members.length, many.length)
  })

  test("holds the create body to the same rule, since a point may be opened with its members", () => {
    const body = {
      projectId: OTHER,
      name: "Parkvej underground point",
      kind: "underground",
      address: "Parkvej 20, 2000 Frederiksberg",
      location: POINT,
      operatingModel: "municipal",
      accessMode: "member",
      billingMode: "member-share",
    }
    const member = { propertyId: THIRD, role: "service-member" }
    assert.deepEqual(SharedCollectionPointCreate.parse({ ...body, members: [member] }).members, [member])
    assert.deepEqual(refusal(SharedCollectionPointCreate.safeParse({ ...body, members: [member, member] })), [namedOnce])
  })
})

describe("the list query of a property", () => {
  test("filters by project and by the customer who is a party to it, on top of a page", () => {
    assert.deepEqual(PropertyListQuery.parse({}), { limit: 50 })
    assert.deepEqual(PropertyListQuery.parse({ projectId: OTHER, customerId: THIRD, limit: "25" }), { projectId: OTHER, customerId: THIRD, limit: 25 })
    assert.equal(PropertyListQuery.safeParse({ customerId: "everyone" }).success, false)
  })
})
