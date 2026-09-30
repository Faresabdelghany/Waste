// Properties, property groups and shared collection points on the
// prototype's records (Issue #184, slice 9b of #81): the Registry's places
// and their sets (`@waste/contracts/customers`, imported as types so no zod
// reaches the bundle; the routes are apps/api/src/routes/{properties,
// property-groups,shared-collection-points}.ts) as the rows of
// `customers.properties`, `customers.groups` and `customers.shared`. The
// forms they write through are lib/data/properties.ts's, whose field ids the
// mappings here speak.
//
// A property names its parties — a customer and what it is to the property —
// through the switched contacts module, a group and a point their member
// properties through the properties loaded just before them, and each
// resolves its project through the organisation: by web id on the record,
// the server's id on a write, refused where the store holds no such row of
// the kind, an id chip (`customer-<uuid>`) where the row is not loaded. A set
// is replaced whole through its own route (`PUT /properties/:id/parties`,
// `PUT …/members`), never on a patch: an edit is the record's `PATCH` for
// the fields that moved, then the set's `PUT` when the set did, two requests
// as a station's fractions are. A member already in a group or a point keeps
// the role it holds; a new one joins in the form's role for new members.
//
// Statuses are the wire's, on the patch: a property active or inactive, a
// group draft, active or inactive, a point draft, open, restricted or closed,
// each listed as the adapter's `statuses`, so the lifecycle's other labels
// (Prospect, On hold, Archived) are refused before the API sees them. What a
// status gates is the API's (#79): a subscription or a placement at an
// inactive property or at a point not open nor restricted is its 409, whose
// sentence the store's toast shows.
//
// Ids, rule (b) of the plan on #81: no fixture lends its id. Nothing on
// fixtures names a property, a group or a point by id, and a property's
// address — its natural handle, which the seed spells as the fixtures do — is
// no key on the wire, so every row is `<prefix>-<uuid>` from the start.
import type { Property, PropertyGroup, PropertyGroupMember, PropertyParty, SharedCollectionPoint, SharedCollectionPointMember } from "@waste/contracts/customers"
import { splitList } from "@waste/domain/record-values"
import {
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

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import {
  ACCESS_MODE_LABELS,
  BILLING_MODE_LABELS,
  GROUP_MEMBER_FACTS,
  GROUP_PREFIX,
  GROUP_PURPOSE_LABELS,
  isPropertyGroupRecord,
  isPropertyRecord,
  isSharedPointRecord,
  MEMBER_ROLE_KEY,
  MEMBER_ROLES_KEY,
  MEMBERS_KEY,
  NO_ONE,
  OPERATING_MODEL_LABELS,
  PARTY_FIELDS,
  PARTY_ROLE_LABELS,
  POINT_KIND_LABELS,
  POINT_MEMBER_FACTS,
  PROPERTIES_MODULE,
  PROPERTY_GROUP_RECORD_KIND,
  PROPERTY_GROUPS_MODULE,
  PROPERTY_KIND_LABELS,
  PROPERTY_PREFIX,
  PROPERTY_RECORD_KIND,
  SHARED_POINT_PREFIX,
  SHARED_POINT_RECORD_KIND,
  SHARED_POINTS_MODULE,
} from "@/lib/data/properties"

import { create, get, listAll, patch, put } from "../client"
import { inheritedPresentation, isLocalRefusal, PartialWrite, patchOf, stampFacts, statusLabel, typed, webIdOf, type Client, type LocalRefusal, type MappingContext, type Resource, type ResourceAdapter, type ServerModule } from "./adapter"
import { isCompanyRecord } from "./organisation"
import { coordinatesFact, coordinatesOf, countOf, createStatusOf, patchStatusOf, pointOf, projectMoved, projectServerIdOf, referenced, refusal, requiredText, sameSet, tokenOf, withStatus } from "./places"
import { referencedServerId } from "./references"
import { customerAdapter } from "./registry"

/** The chip a customer the store has not loaded is named by: the one prefix of either kind. */
const CUSTOMER_CHIP = "customer"

/** A customer of the contacts module — a person or an organisation — and never the tenant's own company, which carries `company-` too. */
const isCustomer = (record: BusinessRecord) => customerAdapter.owns(record) && !isCompanyRecord(record)

const PICK_CUSTOMERS = "Pick customers the API holds"
const PICK_CUSTOMER = "Pick a customer the API holds"
const PICK_PROPERTIES = "Pick properties the API holds"
const BOTH_OR_NEITHER = "Give both the latitude and the longitude, or neither"
const POINT_LOCATED = "A shared collection point has a location: give the latitude and longitude"
const POINT_KEEPS_LOCATION = "A shared collection point keeps a location: give the latitude and longitude"
const DISTANCE_IS_A_COUNT = "An eligibility distance is a whole number of metres, 1 or more"

/** The most a set body names (`SET_MAX` in @waste/contracts/customers, not exported), spelled again since the web imports no zod at runtime; the test holds the two equal. */
export const SET_MAX = 200
const SET_TOO_LONG = `A form names at most ${SET_MAX} of a set; a longer one arrives through an import`

/**
 * The record's patch, then its set's whole replacement: the answer is the row
 * as the last request left it. A set the API refuses after the patch landed
 * is a `PartialWrite` carrying the row the patch left — the set as it was,
 * since the refused request changed nothing — which the store shows under
 * the refusal rather than the row as it stood before the edit.
 */
async function patchThenReplace<R extends Resource>(client: Client, path: string, fields: object | undefined, setPath: string, set: object | undefined): Promise<R> {
  let row: R | undefined
  if (fields !== undefined) row = await patch<R>(client, path, fields)
  if (set !== undefined) {
    try {
      row = await put<R>(client, setPath, set)
    } catch (error) {
      if (row !== undefined) throw new PartialWrite(error, row)
      throw error
    }
  }
  return row ?? (await get<R>(client, path))
}

/** The other states the wire lets a row move to, as the lifecycle's labels: every one but the row's own. */
const transitionsFrom = (statuses: readonly string[], status: string) => statuses.filter((candidate) => candidate !== status).map(statusLabel)

/** The distinct names, in the order met. */
const distinct = (names: readonly string[]) => [...new Set(names)]

/** `2 properties`, `1 member property`, `No members`: a set's size as its column reads. */
const countLabel = (count: number, one: string, many: string) => (count === 0 ? "No members" : `${count} ${count === 1 ? one : many}`)

/** The customer a record names under `key`, as a server id: null for none — blank, or None picked (`NO_ONE`) — a refusal for one the store does not hold as a customer. */
function customerServerIdOf(record: BusinessRecord, key: string, context: MappingContext): string | null | LocalRefusal {
  const webId = typed(record, key)
  if (webId === undefined || webId === NO_ONE) return null
  return referencedServerId(webId, CUSTOMER_CHIP, context, { owns: isCustomer }) ?? refusal(key, PICK_CUSTOMER)
}

/** Each entry of a set as the store knows the row it names — its web id, its name where loaded — with the role it holds. */
function entriesOf<Role extends string>(entries: readonly { id: string; role: Role }[], prefix: string, context: MappingContext) {
  return entries.map((entry) => ({ ...referenced(context, prefix, entry.id), role: entry.role }))
}

/** The facts a set shows, one per role that anybody holds: the names under the role's plural. */
function roleFacts<Role extends string>(entries: readonly { webId: string; name?: string; role: Role }[], roles: readonly Role[], labels: Readonly<Record<Role, string>>): Record<string, string> {
  const facts: Record<string, string> = {}
  for (const role of roles) {
    const holders = entries.filter((entry) => entry.role === role).map((entry) => entry.name ?? entry.webId)
    if (holders.length > 0) facts[labels[role]] = holders.join(" · ")
  }
  return facts
}

/** A pair as a set compares it: what it names and the role, order aside. */
const pairKey = (id: string, role: string) => `${id} ${role}`

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/** What a property's update carries: a patch of the property, the whole set of parties, or both, each to its own route. */
type PropertyWrite = { property?: object; parties?: PropertyParty[] }

/** The parties a record names, one field per role in the wire's role order, as server ids; a refusal at the field naming one the store does not hold as a customer. */
function partiesOf(record: BusinessRecord, context: MappingContext): PropertyParty[] | LocalRefusal {
  const parties: PropertyParty[] = []
  const named = new Set<string>()
  for (const role of PROPERTY_PARTY_ROLES) {
    const key = PARTY_FIELDS[role]
    for (const webId of splitList(typed(record, key))) {
      const customerId = referencedServerId(webId, CUSTOMER_CHIP, context, { owns: isCustomer })
      if (customerId === undefined) return refusal(key, PICK_CUSTOMERS)
      // The contract names each pair once; a pick made twice is one party.
      if (named.has(pairKey(customerId, role))) continue
      named.add(pairKey(customerId, role))
      parties.push({ customerId, role })
      if (parties.length > SET_MAX) return refusal(key, SET_TOO_LONG)
    }
  }
  return parties
}

const propertyKind = (record: BusinessRecord) => tokenOf(record, "propertyType", PROPERTY_KINDS, "kind", "a property")

export const propertyAdapter: ResourceAdapter<Property> = {
  prefix: PROPERTY_PREFIX,
  owns: isPropertyRecord,
  statuses: PROPERTY_STATUSES,
  list: (client) => listAll<Property>(client, "/properties"),
  toRecord: (property, context) => {
    const project = referenced(context, "project", property.projectId)
    const parties = entriesOf(property.parties.map((party) => ({ id: party.customerId, role: party.role })), CUSTOMER_CHIP, context)
    const holders = (role: PropertyParty["role"]) => parties.filter((party) => party.role === role).map((party) => party.name ?? party.webId)
    const owners = holders("owner").join(", ")
    const payers = holders("payer").join(", ")
    return {
      id: webIdOf(PROPERTY_PREFIX, property.id),
      name: property.name,
      context: `${owners || "No owner"} · ${payers ? `Payer ${payers}` : "No payer"}`,
      status: statusLabel(property.status),
      ...inheritedPresentation(undefined),
      ...stampFacts(property, context.now),
      description: property.notes ?? "",
      facts: {
        "Property type": PROPERTY_KIND_LABELS[property.kind],
        Address: property.address,
        ...(property.registryId === null ? {} : { "Registry identifier": property.registryId }),
        ...(property.location === null ? {} : { Coordinates: coordinatesFact(property.location) }),
        ...(project.name === undefined ? {} : { Project: project.name }),
        ...roleFacts(parties, PROPERTY_PARTY_ROLES, PARTY_ROLE_LABELS),
      },
      related: distinct(parties.map((party) => party.name ?? party.webId)),
      allowedTransitions: transitionsFrom(PROPERTY_STATUSES, property.status),
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: PROPERTY_RECORD_KIND,
      submittedValues: {
        projectId: project.webId,
        displayName: property.name,
        serviceAddress: property.address,
        registryId: property.registryId ?? "",
        propertyType: property.kind,
        ...coordinatesOf(property.location),
        specialConditions: property.notes ?? "",
        ...Object.fromEntries(PROPERTY_PARTY_ROLES.map((role) => [PARTY_FIELDS[role], parties.filter((party) => party.role === role).map((party) => party.webId).join(",")])),
      },
    }
  },
  toCreateBody: (record, context) => {
    const projectId = projectServerIdOf(record, context)
    if (isLocalRefusal(projectId)) return projectId
    const name = requiredText(record, "displayName", "A property", "a name")
    if (isLocalRefusal(name)) return name
    const address = requiredText(record, "serviceAddress", "A property", "an address")
    if (isLocalRefusal(address)) return address
    const kind = propertyKind(record) ?? refusal("propertyType", "A property needs a property type")
    if (isLocalRefusal(kind)) return kind
    const location = pointOf(record, BOTH_OR_NEITHER)
    if (isLocalRefusal(location)) return location
    const parties = partiesOf(record, context)
    if (isLocalRefusal(parties)) return parties
    const status = createStatusOf(record, PROPERTY_STATUSES, "a property")
    if (isLocalRefusal(status)) return status
    const registryId = typed(record, "registryId")
    const notes = typed(record, "specialConditions")
    return {
      projectId,
      name,
      address,
      ...(registryId === undefined ? {} : { registryId }),
      kind,
      ...(location === null ? {} : { location }),
      ...(notes === undefined ? {} : { notes }),
      ...(status === undefined ? {} : { status }),
      parties,
    }
  },
  toPatchBody: (before, after, context) => {
    if (projectMoved(before, after)) return refusal("projectId", "A property stays in its project")
    const kind = propertyKind(after)
    if (isLocalRefusal(kind)) return kind
    const location = pointOf(after, BOTH_OR_NEITHER)
    if (isLocalRefusal(location)) return location
    const parties = partiesOf(after, context)
    if (isLocalRefusal(parties)) return parties
    const status = patchStatusOf(before, after, PROPERTY_STATUSES, "a property")
    if (isLocalRefusal(status)) return status
    const property = withStatus(
      patchOf(before, after, (record) => {
        const point = pointOf(record, "")
        return {
          name: typed(record, "displayName") ?? record.name,
          address: typed(record, "serviceAddress"),
          registryId: typed(record, "registryId") ?? null,
          kind: typed(record, "propertyType"),
          location: isLocalRefusal(point) ? undefined : point,
          notes: typed(record, "specialConditions") ?? null,
        }
      }),
      before,
      status,
      PROPERTY_STATUSES,
    )
    // A set the store could not read before (a party of a customer not loaded) is replaced only when the form changed it.
    const was = partiesOf(before, context)
    const partiesMoved = isLocalRefusal(was) || !sameSet(was.map((party) => pairKey(party.customerId, party.role)), parties.map((party) => pairKey(party.customerId, party.role)))
    if (property === null && !partiesMoved) return null
    const write: PropertyWrite = { ...(property === null ? {} : { property }), ...(partiesMoved ? { parties } : {}) }
    return write
  },
  create: (client, body) => create<Property>(client, "/properties", body).then((created) => created.body),
  // The property first, then the whole set through its own route.
  update: (client, serverId, body) => {
    const write = body as PropertyWrite
    return patchThenReplace<Property>(client, `/properties/${serverId}`, write.property, `/properties/${serverId}/parties`, write.parties === undefined ? undefined : { parties: write.parties })
  },
}

// ---------------------------------------------------------------------------
// What a group and a point share: their members
// ---------------------------------------------------------------------------

type Member<Role extends string> = { propertyId: string; role: Role }

/** The roles the record's members already hold, by web id: what the load wrote under `MEMBER_ROLES_KEY`, nothing for a row not yet on the API. */
function rolesHeld(record: BusinessRecord | undefined): Readonly<Record<string, string>> {
  const text = record === undefined ? undefined : typed(record, MEMBER_ROLES_KEY)
  if (text === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/**
 * The members a record names, as server ids with their roles: each property
 * picked, in the role it already holds in `held`'s record, else the form's
 * role for new members; a refusal at the field for a property the store does
 * not hold, or a role the wire lacks.
 */
function membersOf<Role extends string>(record: BusinessRecord, held: BusinessRecord | undefined, roles: readonly Role[], noun: string, context: MappingContext): Member<Role>[] | LocalRefusal {
  const newRole = tokenOf(record, MEMBER_ROLE_KEY, roles, "role", noun) ?? roles[0]
  if (isLocalRefusal(newRole)) return newRole
  const holding = rolesHeld(held)
  const members: Member<Role>[] = []
  for (const webId of splitList(typed(record, MEMBERS_KEY))) {
    const propertyId = referencedServerId(webId, PROPERTY_PREFIX, context, { owns: isPropertyRecord })
    if (propertyId === undefined) return refusal(MEMBERS_KEY, PICK_PROPERTIES)
    // A property is a member or it is not: the contract names each once.
    if (members.some((member) => member.propertyId === propertyId)) continue
    const kept = holding[webId]
    members.push({ propertyId, role: kept !== undefined && (roles as readonly string[]).includes(kept) ? (kept as Role) : (newRole as Role) })
    if (members.length > SET_MAX) return refusal(MEMBERS_KEY, SET_TOO_LONG)
  }
  return members
}

/** Whether the members moved, as a set of pairs: an order is how they were ticked, not a change. */
function membersMoved<Role extends string>(before: BusinessRecord, members: readonly Member<Role>[], roles: readonly Role[], noun: string, context: MappingContext): boolean {
  const was = membersOf(before, before, roles, noun, context)
  return isLocalRefusal(was) || !sameSet(was.map((member) => pairKey(member.propertyId, member.role)), members.map((member) => pairKey(member.propertyId, member.role)))
}

/** The member values a record carries: the properties picked, the role new members join as, and the roles held (MEMBER_ROLES_KEY). */
function memberValues<Role extends string>(members: readonly { webId: string; role: Role }[], defaultRole: Role) {
  return {
    [MEMBERS_KEY]: members.map((member) => member.webId).join(","),
    [MEMBER_ROLE_KEY]: defaultRole,
    [MEMBER_ROLES_KEY]: JSON.stringify(Object.fromEntries(members.map((member) => [member.webId, member.role]))),
  }
}

// ---------------------------------------------------------------------------
// Property groups
// ---------------------------------------------------------------------------

/** What a group's update carries: a patch of the group, the whole membership, or both, each to its own route. */
type GroupWrite = { group?: object; members?: PropertyGroupMember[] }

const GROUP_NOUN = "a property group"
const GROUP_MEMBER = "a group member"

export const propertyGroupAdapter: ResourceAdapter<PropertyGroup> = {
  prefix: GROUP_PREFIX,
  owns: isPropertyGroupRecord,
  statuses: PROPERTY_GROUP_STATUSES,
  list: (client) => listAll<PropertyGroup>(client, "/property-groups"),
  toRecord: (group, context) => {
    const project = referenced(context, "project", group.projectId)
    const responsible = group.responsibleCustomerId === null ? undefined : referenced(context, CUSTOMER_CHIP, group.responsibleCustomerId)
    const members = entriesOf(group.members.map((member) => ({ id: member.propertyId, role: member.role })), PROPERTY_PREFIX, context)
    const purpose = GROUP_PURPOSE_LABELS[group.purpose]
    return {
      id: webIdOf(GROUP_PREFIX, group.id),
      name: group.name,
      context: responsible === undefined ? purpose : `${purpose} · ${responsible.name ?? responsible.webId}`,
      status: statusLabel(group.status),
      ...inheritedPresentation(undefined),
      ...stampFacts(group, context.now),
      value: countLabel(members.length, "property", "properties"),
      facts: {
        Purpose: purpose,
        ...(responsible === undefined ? {} : { "Responsible customer": responsible.name ?? responsible.webId }),
        ...(project.name === undefined ? {} : { Project: project.name }),
        ...roleFacts(members, PROPERTY_GROUP_MEMBER_ROLES, GROUP_MEMBER_FACTS),
      },
      // No related chips: a chip links through the fixtures' index to a fixture id no server property carries (rule (b)); the facts name the members.
      related: [],
      allowedTransitions: transitionsFrom(PROPERTY_GROUP_STATUSES, group.status),
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: PROPERTY_GROUP_RECORD_KIND,
      submittedValues: {
        projectId: project.webId,
        name: group.name,
        purpose: group.purpose,
        responsibleCustomerId: responsible?.webId ?? "",
        ...memberValues(members, PROPERTY_GROUP_MEMBER_ROLES[0]),
      },
    }
  },
  toCreateBody: (record, context) => {
    const projectId = projectServerIdOf(record, context)
    if (isLocalRefusal(projectId)) return projectId
    const name = requiredText(record, "name", "A property group", "a name")
    if (isLocalRefusal(name)) return name
    const purpose = tokenOf(record, "purpose", PROPERTY_GROUP_PURPOSES, "purpose", GROUP_NOUN) ?? refusal("purpose", "A property group needs a purpose")
    if (isLocalRefusal(purpose)) return purpose
    const status = createStatusOf(record, PROPERTY_GROUP_STATUSES, GROUP_NOUN)
    if (isLocalRefusal(status)) return status
    const responsibleCustomerId = customerServerIdOf(record, "responsibleCustomerId", context)
    if (isLocalRefusal(responsibleCustomerId)) return responsibleCustomerId
    const members = membersOf(record, undefined, PROPERTY_GROUP_MEMBER_ROLES, GROUP_MEMBER, context)
    if (isLocalRefusal(members)) return members
    return {
      projectId,
      name,
      purpose,
      ...(responsibleCustomerId === null ? {} : { responsibleCustomerId }),
      ...(status === undefined ? {} : { status }),
      members,
    }
  },
  toPatchBody: (before, after, context) => {
    if (projectMoved(before, after)) return refusal("projectId", "A property group stays in its project")
    const purpose = tokenOf(after, "purpose", PROPERTY_GROUP_PURPOSES, "purpose", GROUP_NOUN)
    if (isLocalRefusal(purpose)) return purpose
    const responsible = customerServerIdOf(after, "responsibleCustomerId", context)
    if (isLocalRefusal(responsible)) return responsible
    const members = membersOf(after, before, PROPERTY_GROUP_MEMBER_ROLES, GROUP_MEMBER, context)
    if (isLocalRefusal(members)) return members
    const status = patchStatusOf(before, after, PROPERTY_GROUP_STATUSES, GROUP_NOUN)
    if (isLocalRefusal(status)) return status
    const group = withStatus(
      patchOf(before, after, (record) => {
        const customer = customerServerIdOf(record, "responsibleCustomerId", context)
        return {
          name: typed(record, "name") ?? record.name,
          purpose: typed(record, "purpose"),
          responsibleCustomerId: isLocalRefusal(customer) ? undefined : customer,
        }
      }),
      before,
      status,
      PROPERTY_GROUP_STATUSES,
    )
    const moved = membersMoved(before, members, PROPERTY_GROUP_MEMBER_ROLES, GROUP_MEMBER, context)
    if (group === null && !moved) return null
    const write: GroupWrite = { ...(group === null ? {} : { group }), ...(moved ? { members } : {}) }
    return write
  },
  create: (client, body) => create<PropertyGroup>(client, "/property-groups", body).then((created) => created.body),
  // The group first, then the whole membership through its own route.
  update: (client, serverId, body) => {
    const write = body as GroupWrite
    return patchThenReplace<PropertyGroup>(client, `/property-groups/${serverId}`, write.group, `/property-groups/${serverId}/members`, write.members === undefined ? undefined : { members: write.members })
  },
}

// ---------------------------------------------------------------------------
// Shared collection points
// ---------------------------------------------------------------------------

/** What a point's update carries: a patch of the point, the whole membership, or both, each to its own route. */
type PointWrite = { point?: object; members?: SharedCollectionPointMember[] }

const POINT_NOUN = "a shared collection point"
const POINT_MEMBER = "a point member"

/** A closed list a point's form must name, as its token; a refusal in the point's words when blank, or naming the list for a token the wire lacks. */
const pointToken = (record: BusinessRecord, key: string, tokens: readonly string[], what: string) =>
  tokenOf(record, key, tokens, what, POINT_NOUN) ?? refusal(key, `A shared collection point needs ${/^[aeiou]/.test(what) ? "an" : "a"} ${what}`)

export const sharedPointAdapter: ResourceAdapter<SharedCollectionPoint> = {
  prefix: SHARED_POINT_PREFIX,
  owns: isSharedPointRecord,
  statuses: SHARED_COLLECTION_POINT_STATUSES,
  list: (client) => listAll<SharedCollectionPoint>(client, "/shared-collection-points"),
  toRecord: (point, context) => {
    const project = referenced(context, "project", point.projectId)
    const responsible = point.responsibleCustomerId === null ? undefined : referenced(context, CUSTOMER_CHIP, point.responsibleCustomerId)
    const members = entriesOf(point.members.map((member) => ({ id: member.propertyId, role: member.role })), PROPERTY_PREFIX, context)
    return {
      id: webIdOf(SHARED_POINT_PREFIX, point.id),
      name: point.name,
      context: `${OPERATING_MODEL_LABELS[point.operatingModel]} · ${ACCESS_MODE_LABELS[point.accessMode]}`,
      status: statusLabel(point.status),
      ...inheritedPresentation(undefined),
      ...stampFacts(point, context.now),
      value: countLabel(members.length, "member property", "member properties"),
      facts: {
        Type: POINT_KIND_LABELS[point.kind],
        Address: point.address,
        Coordinates: coordinatesFact(point.location),
        "Operating model": OPERATING_MODEL_LABELS[point.operatingModel],
        Access: ACCESS_MODE_LABELS[point.accessMode],
        ...(point.accessConditions === null ? {} : { "Access conditions": point.accessConditions }),
        ...(point.availability === null ? {} : { Availability: point.availability }),
        Billing: BILLING_MODE_LABELS[point.billingMode],
        ...(point.eligibilityDistanceM === null ? {} : { Eligibility: `Within ${point.eligibilityDistanceM} m` }),
        ...(responsible === undefined ? {} : { "Responsible customer": responsible.name ?? responsible.webId }),
        ...(project.name === undefined ? {} : { Project: project.name }),
        ...roleFacts(members, SHARED_COLLECTION_POINT_MEMBER_ROLES, POINT_MEMBER_FACTS),
      },
      // As a group's: the facts name the members, since a chip would link to a fixture id.
      related: [],
      allowedTransitions: transitionsFrom(SHARED_COLLECTION_POINT_STATUSES, point.status),
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: SHARED_POINT_RECORD_KIND,
      submittedValues: {
        projectId: project.webId,
        name: point.name,
        pointType: point.kind,
        address: point.address,
        ...coordinatesOf(point.location),
        eligibilityDistance: point.eligibilityDistanceM === null ? "" : String(point.eligibilityDistanceM),
        operatingModel: point.operatingModel,
        availability: point.availability ?? "",
        accessMode: point.accessMode,
        accessConditions: point.accessConditions ?? "",
        billingMode: point.billingMode,
        responsibleCustomerId: responsible?.webId ?? "",
        ...memberValues(members, SHARED_COLLECTION_POINT_MEMBER_ROLES[0]),
      },
    }
  },
  toCreateBody: (record, context) => {
    const projectId = projectServerIdOf(record, context)
    if (isLocalRefusal(projectId)) return projectId
    const name = requiredText(record, "name", "A shared collection point", "a name")
    if (isLocalRefusal(name)) return name
    const kind = pointToken(record, "pointType", SHARED_COLLECTION_POINT_KINDS, "collection-point type")
    if (isLocalRefusal(kind)) return kind
    const address = requiredText(record, "address", "A shared collection point", "an address")
    if (isLocalRefusal(address)) return address
    const location = pointOf(record, POINT_LOCATED)
    if (isLocalRefusal(location)) return location
    if (location === null) return refusal("latitude", POINT_LOCATED)
    const eligibilityDistanceM = countOf(record, "eligibilityDistance", DISTANCE_IS_A_COUNT)
    if (isLocalRefusal(eligibilityDistanceM)) return eligibilityDistanceM
    const operatingModel = pointToken(record, "operatingModel", SHARED_COLLECTION_POINT_OPERATING_MODELS, "operating model")
    if (isLocalRefusal(operatingModel)) return operatingModel
    const accessMode = pointToken(record, "accessMode", SHARED_COLLECTION_POINT_ACCESS_MODES, "access mode")
    if (isLocalRefusal(accessMode)) return accessMode
    const billingMode = pointToken(record, "billingMode", SHARED_COLLECTION_POINT_BILLING_MODES, "billing mode")
    if (isLocalRefusal(billingMode)) return billingMode
    const responsibleCustomerId = customerServerIdOf(record, "responsibleCustomerId", context)
    if (isLocalRefusal(responsibleCustomerId)) return responsibleCustomerId
    const status = createStatusOf(record, SHARED_COLLECTION_POINT_STATUSES, POINT_NOUN)
    if (isLocalRefusal(status)) return status
    const members = membersOf(record, undefined, SHARED_COLLECTION_POINT_MEMBER_ROLES, POINT_MEMBER, context)
    if (isLocalRefusal(members)) return members
    const accessConditions = typed(record, "accessConditions")
    const availability = typed(record, "availability")
    return {
      projectId,
      name,
      kind,
      address,
      location,
      ...(eligibilityDistanceM === undefined ? {} : { eligibilityDistanceM }),
      operatingModel,
      accessMode,
      ...(accessConditions === undefined ? {} : { accessConditions }),
      ...(availability === undefined ? {} : { availability }),
      billingMode,
      ...(responsibleCustomerId === null ? {} : { responsibleCustomerId }),
      ...(status === undefined ? {} : { status }),
      members,
    }
  },
  toPatchBody: (before, after, context) => {
    if (projectMoved(before, after)) return refusal("projectId", "A shared collection point stays in its project")
    const location = pointOf(after, POINT_KEEPS_LOCATION)
    if (isLocalRefusal(location)) return location
    if (location === null) return refusal("latitude", POINT_KEEPS_LOCATION)
    for (const [key, tokens, what] of [
      ["pointType", SHARED_COLLECTION_POINT_KINDS, "collection-point type"],
      ["operatingModel", SHARED_COLLECTION_POINT_OPERATING_MODELS, "operating model"],
      ["accessMode", SHARED_COLLECTION_POINT_ACCESS_MODES, "access mode"],
      ["billingMode", SHARED_COLLECTION_POINT_BILLING_MODES, "billing mode"],
    ] as const) {
      const token = tokenOf(after, key, tokens, what, POINT_NOUN)
      if (isLocalRefusal(token)) return token
    }
    const distance = countOf(after, "eligibilityDistance", DISTANCE_IS_A_COUNT)
    if (isLocalRefusal(distance)) return distance
    const responsible = customerServerIdOf(after, "responsibleCustomerId", context)
    if (isLocalRefusal(responsible)) return responsible
    const members = membersOf(after, before, SHARED_COLLECTION_POINT_MEMBER_ROLES, POINT_MEMBER, context)
    if (isLocalRefusal(members)) return members
    const status = patchStatusOf(before, after, SHARED_COLLECTION_POINT_STATUSES, POINT_NOUN)
    if (isLocalRefusal(status)) return status
    const point = withStatus(
      patchOf(before, after, (record) => {
        const located = pointOf(record, "")
        const metres = countOf(record, "eligibilityDistance", "")
        const customer = customerServerIdOf(record, "responsibleCustomerId", context)
        return {
          name: typed(record, "name") ?? record.name,
          kind: typed(record, "pointType"),
          address: typed(record, "address"),
          location: isLocalRefusal(located) || located === null ? undefined : located,
          eligibilityDistanceM: isLocalRefusal(metres) ? undefined : (metres ?? null),
          operatingModel: typed(record, "operatingModel"),
          accessMode: typed(record, "accessMode"),
          accessConditions: typed(record, "accessConditions") ?? null,
          availability: typed(record, "availability") ?? null,
          billingMode: typed(record, "billingMode"),
          responsibleCustomerId: isLocalRefusal(customer) ? undefined : customer,
        }
      }),
      before,
      status,
      SHARED_COLLECTION_POINT_STATUSES,
    )
    const moved = membersMoved(before, members, SHARED_COLLECTION_POINT_MEMBER_ROLES, POINT_MEMBER, context)
    if (point === null && !moved) return null
    const write: PointWrite = { ...(point === null ? {} : { point }), ...(moved ? { members } : {}) }
    return write
  },
  create: (client, body) => create<SharedCollectionPoint>(client, "/shared-collection-points", body).then((created) => created.body),
  // The point first, then the whole membership through its own route.
  update: (client, serverId, body) => {
    const write = body as PointWrite
    return patchThenReplace<SharedCollectionPoint>(client, `/shared-collection-points/${serverId}`, write.point, `/shared-collection-points/${serverId}/members`, write.members === undefined ? undefined : { members: write.members })
  },
}

// ---------------------------------------------------------------------------
// The modules
// ---------------------------------------------------------------------------

/** Customers › Properties: the service addresses and who their customers are. */
export const propertiesModule: ServerModule = { workspaceId: PROPERTIES_MODULE.workspaceId, moduleId: PROPERTIES_MODULE.moduleId, resources: [propertyAdapter] }

/** Customers › Property Groups, after the properties they gather. */
export const propertyGroupsModule: ServerModule = { workspaceId: PROPERTY_GROUPS_MODULE.workspaceId, moduleId: PROPERTY_GROUPS_MODULE.moduleId, resources: [propertyGroupAdapter] }

/** Customers › Shared Points, after the properties they serve. */
export const sharedPointsModule: ServerModule = { workspaceId: SHARED_POINTS_MODULE.workspaceId, moduleId: SHARED_POINTS_MODULE.moduleId, resources: [sharedPointAdapter] }

export type { Client }
