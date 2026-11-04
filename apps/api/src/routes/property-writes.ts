// A Property's writes (Issue #78), the one spelling `POST /properties`,
// `PATCH /properties/:id`, `PUT /properties/:id/parties` and the CSV import
// (#291 slice 12) all run: the project held to the caller's, the parties each
// a customer of this company, a name one property's inside its project and a
// registry identifier one property's inside the company, in the routes' own
// sentences. Each takes the request's transaction, or a savepoint of it, and
// the caller; the grant is the caller's to have checked. `propertiesAt` is
// the key a person knows a property by in a file, its address in a project.
//
// A body may name the address register's `addressId` (#291 C13): the route
// read the address before its transaction opened (routes/addresses.ts) and
// hands it here, and the property stores the register's designation as its
// address with the parts and the id beside it, and the register's BFE number
// and point where the body sets neither. An id the register does not hold is
// a 400 on `addressId`. A typed address is no longer the register's, so a
// patch of `address` alone lets the id and the parts go.
//
// A party holds its role over a period (#374). The property reads the parties
// in force on its project's today and those from a later day, a move booked
// ahead, which `heldFromToday` says in SQL from the request's clock and the
// party's project, so a page spanning projects is one statement. A body names
// the set in force today and the server dates it: a create's parties begin
// today, and `PUT …/parties` ends today a party it leaves out — deleting one
// begun today, a same-day correction — begins today one it adds, and never
// touches a party from a later day or one that has ended. History is never
// deleted, so the parties' own read is the record of who held a property when.
import type { Address } from "@waste/contracts/addresses"
import type { AddressParts } from "@waste/domain/registry/address"
import type { Property, PropertyCreate, PropertyKind, PropertyParty, PropertyPartyHeld, PropertyPartyRole, PropertyPatch, PropertyStatus } from "@waste/contracts/customers"
import type { FlatPoint } from "@waste/contracts/geojson"
import type { Tx } from "@waste/db/client"
import { property, propertyParty } from "@waste/db/schema/customers"
import { projectToday } from "@waste/db/commands/project-clock"
import { and, asc, eq, inArray, isNull, lte, or, sql, type SQL, type SQLWrapper } from "drizzle-orm"

import type { Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { newId } from "../ids"
import { invalidRequest, problem } from "../problem"
import { requirePartyCustomers, type Entry, type Parent } from "./members"
import { refuseDuplicate, refuseOverlap, stamp, stampsOf } from "./shared"
import { serviceWindowOf, serviceWindowValues } from "./time-windows"

export const propertyColumns = {
  id: property.id,
  projectId: property.projectId,
  name: property.name,
  address: property.address,
  addressId: property.addressId,
  streetName: property.streetName,
  houseNumber: property.houseNumber,
  floor: property.floor,
  door: property.door,
  postcode: property.postcode,
  postTown: property.postTown,
  municipalityCode: property.municipalityCode,
  registryId: property.registryId,
  kind: property.kind,
  location: property.location,
  notes: property.notes,
  driverInstructions: property.driverInstructions,
  serviceWindowStart: property.serviceWindowStart,
  serviceWindowEnd: property.serviceWindowEnd,
  status: property.status,
  createdAt: property.createdAt,
  updatedAt: property.updatedAt,
}

export type PropertyRow = Pick<typeof property.$inferSelect, keyof typeof propertyColumns>

/** The day `now` falls on in the project of the party row a statement reads, on that project's clock. */
const partyDay = (now: Date): SQL =>
  sql`(select (${now.toISOString()}::timestamptz at time zone p."timezone")::date from "wms"."project" p where p."company_id" = ${propertyParty.companyId} and p."id" = ${propertyParty.projectId})`

/** A party in force on its project's today, or from a later day: what a property reads (#374). */
export const heldFromToday = (now: Date): SQL => or(isNull(propertyParty.validTo), sql`${propertyParty.validTo} > ${partyDay(now)}`) as SQL

/** A party in force on its project's today: who a customer is to a property now, the portal's and a ticket's question. */
export const partyInForce = (now: Date): SQL => and(lte(propertyParty.validFrom, partyDay(now)), heldFromToday(now)) as SQL

/** The parties of a page of properties in one statement, held from today, grouped by property in read order: the customer, the role, then the first day. */
export async function partiesOf(tx: Tx, companyId: string, propertyIds: readonly string[], now: Date): Promise<Map<string, PropertyPartyHeld[]>> {
  const grouped = new Map<string, PropertyPartyHeld[]>()
  if (propertyIds.length === 0) return grouped
  const rows = await tx
    .select({ propertyId: propertyParty.propertyId, customerId: propertyParty.customerId, role: propertyParty.role, validFrom: propertyParty.validFrom, validTo: propertyParty.validTo })
    .from(propertyParty)
    .where(and(eq(propertyParty.companyId, companyId), inArray(propertyParty.propertyId, [...propertyIds]), heldFromToday(now)))
    .orderBy(asc(propertyParty.propertyId), asc(propertyParty.customerId), asc(propertyParty.role), asc(propertyParty.validFrom))
  for (const { propertyId, role, ...party } of rows) {
    const held = grouped.get(propertyId) ?? []
    held.push({ ...party, role: role as PropertyPartyRole })
    grouped.set(propertyId, held)
  }
  return grouped
}

/** A party's row beginning on `from`, still running. */
const partyRow = (parent: Parent, party: PropertyParty, from: string): typeof propertyParty.$inferInsert => ({
  id: newId(),
  companyId: parent.companyId,
  projectId: parent.projectId,
  propertyId: parent.id,
  customerId: party.customerId,
  role: party.role,
  validFrom: from,
})

/** The two spellings of one party: the wire's, and the set mechanics' (routes/members.ts), which hold its customer to this company. */
export const entryOf = (party: PropertyParty): Entry => ({ id: party.customerId, role: party.role })
const partyKey = (party: PropertyParty): string => `${party.customerId} ${party.role}`

/** The row on the wire, with the parties the page loaded for it. `kind` and `status` are text with a CHECK in the database and an enum here; the point is the contracts' `FlatPoint`, since the column is `geometry(Point, 4326)`, flat, and refuses a third ordinate on write, however the column's type spells the altitude as optional. */
export function propertyOf(row: PropertyRow, held: readonly PropertyPartyHeld[]): Property {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    address: row.address,
    addressId: row.addressId,
    addressParts: partsOf(row),
    registryId: row.registryId,
    kind: row.kind as PropertyKind,
    location: row.location as FlatPoint | null,
    notes: row.notes,
    driverInstructions: row.driverInstructions,
    serviceWindow: serviceWindowOf(row),
    status: row.status as PropertyStatus,
    parties: [...held],
    ...stampsOf(row),
  }
}

/** The register's parts of a row, null for a typed address; the database's `property_address_shape` holds them all present with the id. */
function partsOf(row: PropertyRow): AddressParts | null {
  if (row.addressId === null || row.streetName === null || row.houseNumber === null || row.postcode === null || row.postTown === null || row.municipalityCode === null) return null
  return { streetName: row.streetName, houseNumber: row.houseNumber, floor: row.floor, door: row.door, postcode: row.postcode, postTown: row.postTown, municipalityCode: row.municipalityCode }
}

/** The columns of a register's address, or of none: what a typed address clears. */
const addressColumns = (found: Address | null) => ({
  addressId: found?.id ?? null,
  streetName: found?.parts.streetName ?? null,
  houseNumber: found?.parts.houseNumber ?? null,
  floor: found?.parts.floor ?? null,
  door: found?.parts.door ?? null,
  postcode: found?.parts.postcode ?? null,
  postTown: found?.parts.postTown ?? null,
  municipalityCode: found?.parts.municipalityCode ?? null,
})

/**
 * What a body's `addressId` writes, given what the register said of it: the
 * register's designation and parts, and its BFE number and point where the
 * body sets neither. Nothing where the body names no id; a 400 on
 * `addressId` where the register holds none by it.
 */
type RegisterValues = Partial<ReturnType<typeof addressColumns> & { address: string; registryId: string | null; location: FlatPoint | null }>

function registerValues(body: { addressId?: string | null; registryId?: string | null; location?: unknown }, found: Address | null | undefined): RegisterValues {
  if (body.addressId == null) return {}
  if (found == null || found.id !== body.addressId) {
    throw invalidRequest("body", [{ path: "addressId", message: `No address ${body.addressId} in the address register` }])
  }
  return {
    address: found.designation,
    ...addressColumns(found),
    ...(body.registryId === undefined ? { registryId: found.registryId } : {}),
    ...(body.location === undefined ? { location: found.location } : {}),
  }
}

/** One property on the wire, its parties read back the way a page reads them, so an answer equals the next read. */
export async function propertyWithParties(tx: Tx, companyId: string, row: PropertyRow, now: Date): Promise<Property> {
  return propertyOf(row, (await partiesOf(tx, companyId, [row.id], now)).get(row.id) ?? [])
}

/** `unique (company_id, project_id, name)`: a name is one property's inside a project, and free in the next. */
const NAME_TAKEN = "property_project_id_name_key"
const nameTaken = (name: string) => `This project already has a property called ${JSON.stringify(name)}`

/** The partial unique index `(company_id, registry_id) where registry_id is not null`, which Postgres names as the constraint it refused with. */
const REGISTRY_TAKEN = "property_registry_id_idx"
const registryTaken = (registryId: string) => `This company already has a property with the registry identifier ${registryId}`

/** The sentences a write here can earn, and only for the fields the body gave. */
const collisions = (values: { name?: string; registryId?: string | null }): Record<string, string> => ({
  ...(values.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(values.name) }),
  ...(values.registryId == null ? {} : { [REGISTRY_TAKEN]: registryTaken(values.registryId) }),
})

export const noSuchProperty = (id: string) => problem(404, { detail: `No property ${id} in the projects this account works in` })

/** The rows of this company, in the projects the caller works in: what every property statement is bounded by. */
export const propertyScope = (principal: Principal) => and(eq(property.companyId, principal.companyId), inProjects(property.projectId, principal))

/** One property of this company by id, inside the caller's projects; undefined when it is neither. */
export async function findProperty(tx: Tx, principal: Principal, id: string): Promise<PropertyRow | undefined> {
  const [row] = await tx
    .select(propertyColumns)
    .from(property)
    .where(and(propertyScope(principal), eq(property.id, id)))
    .limit(1)
  return row
}

/** Registers a property in one of the caller's projects, with the parties it starts with, each from the project's today on `now`; `found` is what the register said of the body's `addressId`. */
export async function createProperty(tx: Tx, principal: Principal, body: PropertyCreate, now: () => Date, found?: Address | null): Promise<Property> {
  const { parties: asked, serviceWindow, addressId: _named, ...given } = body
  requireProject(principal, given.projectId)
  const fromRegister = registerValues(body, found)
  const address = fromRegister.address ?? given.address
  // The contract holds a create to one address, typed or the register's; this is its type's word for it.
  if (address === undefined) throw invalidRequest("body", [{ path: "address", message: "Give the address, typed or as the address register's addressId" }])
  const values = { ...given, ...fromRegister, address }
  const parent: Parent = { companyId: principal.companyId, projectId: values.projectId, id: newId() }
  await requirePartyCustomers(tx, parent, asked.map(entryOf))
  const [row] = await refuseDuplicate(collisions(values), () =>
    tx
      .insert(property)
      .values({ ...values, ...serviceWindowValues(serviceWindow), id: parent.id, companyId: parent.companyId })
      .returning(propertyColumns),
  )
  if (asked.length > 0) {
    const today = await projectToday(tx, parent, now)()
    await tx.insert(propertyParty).values(asked.map((party) => partyRow(parent, party, today)))
  }
  return await propertyWithParties(tx, parent.companyId, row, now())
}

/** Changes one property of the caller's projects; a 404 for one they do not reach. `found` is what the register said of the body's `addressId`. */
export async function patchProperty(tx: Tx, principal: Principal, id: string, body: PropertyPatch, now: () => Date, found?: Address | null): Promise<Property> {
  const { serviceWindow, addressId, ...given } = body
  // The path's row first (404), then the body's id (400), as a route judges them.
  if (addressId != null && (await findProperty(tx, principal, id)) === undefined) throw noSuchProperty(id)
  const patch = {
    ...given,
    // A typed address, or an id let go, is no longer the register's; an id named is the register's whole.
    ...(given.address !== undefined || addressId === null ? addressColumns(null) : {}),
    ...registerValues(body, found),
  }
  const [row] = await refuseDuplicate(collisions(patch), () =>
    tx
      .update(property)
      .set({ ...patch, ...serviceWindowValues(serviceWindow) })
      .where(and(propertyScope(principal), eq(property.id, id)))
      .returning(propertyColumns),
  )
  if (row === undefined) throw noSuchProperty(id)
  return await propertyWithParties(tx, principal.companyId, row, now())
}

/** What a party added today meets when the customer already holds that role from a later day: a move booked ahead. */
const PARTY_OVERLAP = "property_party_no_overlap"
const heldAhead = "A customer the body adds already holds that role at this property from a later day; that day's change stands, so add them from it instead"

/**
 * Replaces a property's parties in force today on its project's clock (#374);
 * a 404 for a property the caller does not reach. The property's row is
 * stamped first, which is also what answers "no such property here", then the
 * customers are held to this company, then the set in force today is read and
 * compared with the body by customer and role: a party the body leaves out
 * ends today, or is deleted where it began today — a same-day correction, not
 * a role anybody held — and a party the body adds begins today. A party from
 * a later day, or one already ended, is not today's set and is never touched;
 * a party added today that the same customer holds in the same role from a
 * later day is refused (409), since the exclusion constraint would.
 */
export async function setPropertyParties(tx: Tx, principal: Principal, id: string, asked: readonly PropertyParty[], now: () => Date): Promise<Property> {
  const [row] = await tx
    .update(property)
    .set(stamp())
    .where(and(propertyScope(principal), eq(property.id, id)))
    .returning(propertyColumns)
  if (row === undefined) throw noSuchProperty(id)
  const parent: Parent = { companyId: principal.companyId, projectId: row.projectId, id: row.id }
  await requirePartyCustomers(tx, parent, asked.map(entryOf))
  const today = await projectToday(tx, parent, now)()
  const current = await tx
    .select({ id: propertyParty.id, customerId: propertyParty.customerId, role: propertyParty.role, validFrom: propertyParty.validFrom })
    .from(propertyParty)
    .where(and(eq(propertyParty.companyId, parent.companyId), eq(propertyParty.propertyId, parent.id), lte(propertyParty.validFrom, today), or(isNull(propertyParty.validTo), sql`${propertyParty.validTo} > ${today}`)))
  const kept = new Set(asked.map(partyKey))
  const held = new Set(current.map((party) => partyKey({ customerId: party.customerId, role: party.role as PropertyPartyRole })))
  const leaving = current.filter((party) => !kept.has(partyKey({ customerId: party.customerId, role: party.role as PropertyPartyRole })))
  const corrected = leaving.filter((party) => party.validFrom === today).map((party) => party.id)
  const ended = leaving.filter((party) => party.validFrom !== today).map((party) => party.id)
  if (corrected.length > 0) await tx.delete(propertyParty).where(and(eq(propertyParty.companyId, parent.companyId), inArray(propertyParty.id, corrected)))
  if (ended.length > 0) await tx.update(propertyParty).set({ validTo: today }).where(and(eq(propertyParty.companyId, parent.companyId), inArray(propertyParty.id, ended)))
  const added = asked.filter((party) => !held.has(partyKey(party)))
  if (added.length > 0) {
    await refuseOverlap({ [PARTY_OVERLAP]: heldAhead }, () => tx.insert(propertyParty).values(added.map((party) => partyRow(parent, party, today))))
  }
  return await propertyWithParties(tx, principal.companyId, row, now())
}

/** The properties of one of the caller's projects at an address, compared as a person reads it: case and spacing aside. In creation order, without their parties, which `propertyWithParties` reads for the one a caller settles on. */
export async function propertiesAt(tx: Tx, principal: Principal, projectId: string, address: string): Promise<PropertyRow[]> {
  return await tx
    .select(propertyColumns)
    .from(property)
    .where(and(propertyScope(principal), eq(property.projectId, projectId), sql`${addressKey(property.address)} = ${addressKey(address)}`))
    .orderBy(asc(property.id))
}

/** An address as it is compared — trimmed, lowercase, its runs of white space one space — spelled in SQL for the column and the value alike, so one `lower` reads both whatever the database's locale makes of a letter. */
const addressKey = (address: string | SQLWrapper): SQL => sql`lower(regexp_replace(trim(${address}::text), '\\s+', ' ', 'g'))`
