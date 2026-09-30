// The fleet on the prototype's records (Issue #180, slice 5a of #81): the
// Vehicle with its compartments as `fleet.vehicles`, the Driver as
// `fleet.drivers`. The wire shapes are the contracts' (`@waste/contracts/
// fleet`), imported as types so no zod reaches the bundle; the routes are
// apps/api/src/routes/{vehicles,drivers}.ts. The places' helpers
// (records/places.ts) name the project, the provider and the home depot the
// same way a place does.
//
// A vehicle record spells what the fixtures spelled and what the wizard's
// fleet readers read (@waste/domain/route-schemes/fleet-profiles): the name
// is `callsign · plate`, the context `type tonnage · depot` ("Rear loader 18
// t · Nordhavn Depot", the canonical type first so `vehicleTypeOfRecord`
// finds it), the Capacity fact "18 t", the typed `requiredLicenceClass` in
// the display spelling (`C`) and `resourceKind` for a trailer. The generic
// form's fields carry the rest: its "Asset reference" is the yard's callsign
// on the wire, its rated capacity the payload in kilograms, its licence
// class is turned into the vocabulary's token on the way out and back into
// the card's spelling on the way in. The fuel is a select over the wire's
// six, the vehicle type a picker at the master module, by web id through
// the resolver.
//
// Compartments travel with the vehicle, replaced whole through
// `PUT /vehicles/:id/compartments`. The form has one multiselect of waste
// fractions and no per-compartment editor, so a create makes one compartment
// carrying them (with the form's volume as its litres), and an edit that
// moves the fractions or the volume re-puts that one compartment, keeping
// its name and capacities; a vehicle the API holds with several
// compartments is read faithfully (each named in the `compartments` text,
// the union of their fractions in the picker) and its fractions are not
// re-cut from a one-slot form: that edit is refused by name. The list the
// vehicle had is kept on the record under `COMPARTMENTS_KEY`, as a role
// keeps its grants, so a patch can rebuild the whole list from it.
//
// A driver's licence is read literally — the class and the last day it holds
// — and never judged here: the licence rule is the domain's and the API's,
// and the wizard's readers ask it. The form's "Enable Driver App access" and
// "Linked user account" are the wire's `userAccountId`: on with an account,
// off is null. Statuses are the wire's, the lifecycle's Invited and Absent
// being an account's word and a dated window; a create under the form's
// default Invited says no status, so the API's default stands.
import type { Driver, Vehicle, VehicleCompartment } from "@waste/contracts/fleet"
import { displayLicenceClass, isLicenceClassToken } from "@waste/domain/resources/licence"
import { DRIVER_STATUSES, EMPLOYMENT_TYPES, FUEL_TYPES, LICENCE_CLASSES, VEHICLE_KINDS, VEHICLE_OWNERSHIPS, VEHICLE_STATUSES } from "@waste/domain/resources/vocabulary"
import { isIsoDate } from "@waste/domain/route-schemes/recurrence"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { MASTER_DATA_KIND_DETAILS, masterDataKindOf } from "@/lib/data/master-data-kinds"
import { fuelLabel } from "@/lib/data/resources-vocabulary"

import { create, get, listAll, patch, put } from "../client"
import { hasPrefix, inheritedPresentation, isLocalRefusal, ofKind, patchOf, stampFacts, statusLabel, typed, typedFlag, webIdOf, type Client, type LocalRefusal, type MappingContext, type ResourceAdapter, type ServerModule } from "./adapter"
import { userAdapter } from "./organisation"
import {
  createStatusOf,
  depotServerIdOf,
  fractionServerIdsOf,
  patchStatusOf,
  projectMoved,
  projectServerIdOf,
  providerFitsOwner,
  providerServerIdOf,
  PROVIDER_WITH_PROVIDER_OWNERSHIP,
  referenced,
  refusal,
  requiredText,
  sameSet,
  tokenOf,
  withStatus,
} from "./places"

/** What a powered vehicle without a compartment is told (`@waste/contracts/fleet`, `A_POWERED_VEHICLE_HAS_A_COMPARTMENT`); the test holds the two equal. */
export const A_POWERED_VEHICLE_HAS_A_COMPARTMENT = "A powered vehicle has at least one compartment"
/** What a driver body whose employment and provider disagree is told (`@waste/contracts/fleet`, `PROVIDER_WITH_PROVIDER_EMPLOYMENT`); the test holds the two equal. */
export const PROVIDER_WITH_PROVIDER_EMPLOYMENT = "Name the employing service provider with service-provider employment, and none otherwise"

/** The typed key the vehicle record keeps its compartments under, as the API listed them, for the patch to rebuild the whole list. */
export const COMPARTMENTS_KEY = "compartmentSet"

const A_LICENCE_CLASS = `A licence class is ${LICENCE_CLASSES.map(displayLicenceClass).join(", ").replace(/, ([^,]*)$/, " or $1")}`

/** One compartment as the record keeps it and a body gives it: without the position, which is the list's order. */
type CompartmentBody = { name?: string | null; capacityKg?: number | null; volumeLitres?: number | null; wasteFractionIds: string[] }

/** The compartments a vehicle record carries, as the API listed them (no position: the list's order is it); none for a record that carries none. */
export function compartmentsOfRecord(record: Pick<BusinessRecord, "submittedValues">): CompartmentBody[] {
  const raw = typed(record, COMPARTMENTS_KEY)
  if (raw === undefined) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as CompartmentBody[]) : []
  } catch {
    return []
  }
}

const kept = (compartment: VehicleCompartment): CompartmentBody => ({ name: compartment.name, capacityKg: compartment.capacityKg, volumeLitres: compartment.volumeLitres, wasteFractionIds: compartment.wasteFractionIds })

/** A compartment body saying only what it has: the contract's optional members are left out where null. */
function compartmentBody(compartment: Partial<CompartmentBody>, wasteFractionIds: string[]): CompartmentBody {
  return {
    ...(compartment.name == null ? {} : { name: compartment.name }),
    ...(compartment.capacityKg == null ? {} : { capacityKg: compartment.capacityKg }),
    ...(compartment.volumeLitres == null ? {} : { volumeLitres: compartment.volumeLitres }),
    wasteFractionIds,
  }
}

/** The form's licence class (`CE`) as the vocabulary's token, or a refusal; undefined for blank. */
function licenceTokenOf(record: BusinessRecord, key: string): string | undefined | LocalRefusal {
  const text = typed(record, key)
  if (text === undefined) return undefined
  const token = text.toLowerCase()
  return isLicenceClassToken(token) ? token : refusal(key, A_LICENCE_CLASS)
}

/** `18 t` from 18 000 kg; a payload no fixture spelled is left as the number says. */
const tonnes = (capacityKg: number) => `${Number((capacityKg / 1000).toFixed(2))} t`

/** The rated payload the form typed, in whole kilograms; undefined for blank. */
function payloadOf(record: BusinessRecord): number | undefined | LocalRefusal {
  const text = typed(record, "capacity")
  if (text === undefined) return undefined
  return /^\d+$/.test(text) && Number(text) >= 1 ? Number(text) : refusal("capacity", "A rated capacity is a whole number of kilograms, 1 or more")
}

/** The form's volume in cubic metres as whole litres for the one compartment; undefined for blank. */
function litresOf(record: BusinessRecord): number | undefined | LocalRefusal {
  const text = typed(record, "volumeCapacity")
  if (text === undefined) return undefined
  const cubicMetres = Number(text)
  const litres = Math.round(cubicMetres * 1000)
  return Number.isFinite(cubicMetres) && cubicMetres > 0 && litres >= 1 ? litres : refusal("volumeCapacity", "A volume capacity is cubic metres, above zero")
}

/** The vehicle type the form picked at the master module, as a server id, or a refusal. */
function vehicleTypeServerIdOf(record: BusinessRecord, context: MappingContext): string | LocalRefusal {
  const webId = typed(record, "vehicleType")
  const serverId = webId === undefined ? undefined : context.resolve.serverIdOf(webId)
  const named = serverId === undefined ? undefined : context.resolve.byServerId(serverId)
  if (serverId === undefined || named === undefined || masterDataKindOf(named) !== "vehicle-type") return refusal("vehicleType", "Pick a vehicle type the API holds")
  return serverId
}

/** The telematics device the form typed; undefined for blank. */
const telematicsOf = (record: BusinessRecord) => typed(record, "gpsDeviceId")

const FRACTIONS_KEY = "wasteFractionIds"

/**
 * The compartments an edit puts, or nothing when neither the fractions nor
 * the volume moved. A vehicle of one compartment (or none) re-puts that one
 * with the new fractions and volume, keeping its name and payload; one of
 * several is not re-cut from a one-slot form.
 */
function compartmentsPut(before: BusinessRecord, after: BusinessRecord, fractionIds: string[], context: MappingContext): CompartmentBody[] | undefined | LocalRefusal {
  const stored = compartmentsOfRecord(before)
  const was = fractionServerIdsOf(before, FRACTIONS_KEY, context)
  const fractionsMoved = isLocalRefusal(was) || !sameSet(was, fractionIds)
  const volume = litresOf(after)
  if (isLocalRefusal(volume)) return volume
  const volumeMoved = typed(after, "volumeCapacity") !== typed(before, "volumeCapacity")
  if (!fractionsMoved && !volumeMoved) return undefined
  if (stored.length > 1) {
    const label = typed(before, "assetReference") ?? before.name
    return refusal(FRACTIONS_KEY, `${label} has ${stored.length} compartments: their fractions are set compartment by compartment on the API`)
  }
  const kind = typed(after, "resourceKind") ?? typed(before, "resourceKind")
  if (fractionIds.length === 0) return kind === "trailer" ? [] : refusal(FRACTIONS_KEY, A_POWERED_VEHICLE_HAS_A_COMPARTMENT)
  const [first] = stored
  return [compartmentBody({ ...first, ...(volumeMoved ? { volumeLitres: volume ?? null } : {}) }, fractionIds)]
}

/** What a vehicle's update carries: a patch of the vehicle, the whole list of compartments, or both, each to its own route. */
type VehicleWrite = {
  vehicle?: object
  compartments?: CompartmentBody[]
}

export const vehicleAdapter: ResourceAdapter<Vehicle> = {
  prefix: "vehicle",
  // A fixture trailer's id carries `trailer-`; a server row is `vehicle-<uuid>` whatever its kind, its kind on the typed `resourceKind`.
  owns: (record) => ofKind("vehicle", ["Vehicle or trailer"])(record) || hasPrefix("trailer")(record),
  statuses: VEHICLE_STATUSES,
  list: (client) => listAll<Vehicle>(client, "/vehicles"),
  toRecord: (vehicle, context) => {
    const project = referenced(context, "project", vehicle.projectId)
    const provider = vehicle.serviceProviderId === null ? undefined : referenced(context, "service-provider", vehicle.serviceProviderId)
    const type = referenced(context, MASTER_DATA_KIND_DETAILS["vehicle-type"].prefix, vehicle.vehicleTypeId)
    const depot = vehicle.homeDepotId === null ? undefined : referenced(context, "depot", vehicle.homeDepotId)
    // The union of the compartments' fractions, each once, in the order they were written.
    const fractionIds = [...new Set(vehicle.compartments.flatMap((compartment) => compartment.wasteFractionIds))]
    const fractions = fractionIds.map((id) => referenced(context, MASTER_DATA_KIND_DETAILS["waste-fraction"].prefix, id))
    const fractionNames = new Map(fractionIds.map((id, index) => [id, fractions[index].name ?? fractions[index].webId]))
    const fractionName = (id: string) => fractionNames.get(id) ?? id
    const capacity = vehicle.capacityKg === null ? undefined : tonnes(vehicle.capacityKg)
    const typeName = type.name ?? "Vehicle"
    const volumeLitres = vehicle.compartments.reduce((total, compartment) => total + (compartment.volumeLitres ?? 0), 0)
    const facts: Record<string, string> = {
      Registration: vehicle.registration,
      ...(vehicle.callsign === null ? {} : { Callsign: vehicle.callsign }),
      Kind: statusLabel(vehicle.kind),
      Type: typeName,
      Ownership: provider?.name ?? statusLabel(vehicle.ownership),
      ...(capacity === undefined ? {} : { Capacity: capacity }),
      ...(fractions.length === 0 ? {} : { Fractions: fractions.map((fraction) => fraction.name ?? fraction.webId).join(" · ") }),
      ...(vehicle.compartments.length === 0 ? {} : { Compartments: String(vehicle.compartments.length) }),
      ...(vehicle.fuel === null ? {} : { Fuel: fuelLabel(vehicle.fuel) }),
      "Required licence class": displayLicenceClass(vehicle.requiredLicenceClass),
      ...(depot === undefined ? {} : { "Home depot": depot.name ?? depot.webId }),
      ...(vehicle.telematicsDeviceId === null ? {} : { Telematics: vehicle.telematicsDeviceId }),
      ...(project.name === undefined ? {} : { Project: project.name }),
    }
    return {
      id: webIdOf("vehicle", vehicle.id),
      name: vehicle.callsign === null ? vehicle.registration : `${vehicle.callsign} · ${vehicle.registration}`,
      context: [`${typeName}${capacity === undefined ? "" : ` ${capacity}`}`, depot?.name].filter(Boolean).join(" · "),
      status: statusLabel(vehicle.status),
      ...inheritedPresentation(undefined),
      ...stampFacts(vehicle, context.now),
      owner: provider?.name ?? "",
      description: vehicle.notes ?? "",
      facts,
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      serviceProviderId: provider?.webId,
      recordKind: "Vehicle or trailer",
      submittedValues: {
        registrationNumber: vehicle.registration,
        assetReference: vehicle.callsign ?? "",
        resourceKind: vehicle.kind,
        vehicleType: type.webId,
        ownershipType: vehicle.ownership,
        serviceProviderId: provider?.webId ?? "",
        status: vehicle.status,
        capacity: vehicle.capacityKg === null ? "" : String(vehicle.capacityKg),
        requiredLicenceClass: displayLicenceClass(vehicle.requiredLicenceClass),
        volumeCapacity: volumeLitres === 0 ? "" : String(volumeLitres / 1000),
        [FRACTIONS_KEY]: fractions.map((fraction) => fraction.webId).join(","),
        compartments: vehicle.compartments.map((compartment) => `${compartment.name ?? `Compartment ${compartment.position}`}: ${compartment.wasteFractionIds.map(fractionName).join(", ")}`).join("; "),
        projectId: project.webId,
        homeDepotId: depot?.webId ?? "",
        gpsDeviceId: vehicle.telematicsDeviceId ?? "",
        fuelOrEnergyType: vehicle.fuel ?? "",
        [COMPARTMENTS_KEY]: JSON.stringify(vehicle.compartments.map(kept)),
      },
    }
  },
  toCreateBody: (record, context) => {
    const projectId = projectServerIdOf(record, context)
    if (isLocalRefusal(projectId)) return projectId
    const registration = requiredText(record, "registrationNumber", "A vehicle", "a registration")
    if (isLocalRefusal(registration)) return registration
    const kind = tokenOf(record, "resourceKind", VEHICLE_KINDS, "kind", "a vehicle") ?? refusal("resourceKind", "Say whether this is a powered vehicle or a trailer")
    if (isLocalRefusal(kind)) return kind
    const vehicleTypeId = vehicleTypeServerIdOf(record, context)
    if (isLocalRefusal(vehicleTypeId)) return vehicleTypeId
    const ownership = tokenOf(record, "ownershipType", VEHICLE_OWNERSHIPS, "ownership", "a vehicle") ?? "company"
    if (isLocalRefusal(ownership)) return ownership
    const serviceProviderId = providerServerIdOf(record, context)
    if (isLocalRefusal(serviceProviderId)) return serviceProviderId
    if (!providerFitsOwner(ownership, serviceProviderId)) return refusal("serviceProviderId", PROVIDER_WITH_PROVIDER_OWNERSHIP)
    const status = createStatusOf(record, VEHICLE_STATUSES, "a vehicle")
    if (isLocalRefusal(status)) return status
    const capacityKg = payloadOf(record)
    if (isLocalRefusal(capacityKg)) return capacityKg
    const requiredLicenceClass = licenceTokenOf(record, "requiredLicenceClass") ?? refusal("requiredLicenceClass", A_LICENCE_CLASS)
    if (isLocalRefusal(requiredLicenceClass)) return requiredLicenceClass
    const homeDepotId = depotServerIdOf(record, "homeDepotId", context)
    if (isLocalRefusal(homeDepotId)) return homeDepotId
    const fuel = tokenOf(record, "fuelOrEnergyType", FUEL_TYPES, "fuel", "a vehicle")
    if (isLocalRefusal(fuel)) return fuel
    const wasteFractionIds = fractionServerIdsOf(record, FRACTIONS_KEY, context)
    if (isLocalRefusal(wasteFractionIds)) return wasteFractionIds
    if (wasteFractionIds.length === 0 && kind !== "trailer") return refusal(FRACTIONS_KEY, A_POWERED_VEHICLE_HAS_A_COMPARTMENT)
    const volumeLitres = litresOf(record)
    if (isLocalRefusal(volumeLitres)) return volumeLitres
    const callsign = typed(record, "assetReference")
    const telematicsDeviceId = telematicsOf(record)
    return {
      projectId,
      registration,
      ...(callsign === undefined ? {} : { callsign }),
      kind,
      vehicleTypeId,
      ownership,
      ...(serviceProviderId === null ? {} : { serviceProviderId }),
      ...(status === undefined ? {} : { status }),
      ...(capacityKg === undefined ? {} : { capacityKg }),
      requiredLicenceClass,
      ...(homeDepotId === null ? {} : { homeDepotId }),
      ...(fuel === undefined ? {} : { fuel }),
      ...(telematicsDeviceId === undefined ? {} : { telematicsDeviceId }),
      compartments: wasteFractionIds.length === 0 ? [] : [compartmentBody({ volumeLitres }, wasteFractionIds)],
    }
  },
  toPatchBody: (before, after, context) => {
    if (typed(after, "resourceKind") !== typed(before, "resourceKind")) return refusal("resourceKind", "A vehicle keeps its kind: a powered vehicle does not become a trailer")
    if (projectMoved(before, after)) return refusal("projectId", "A vehicle stays in its project")
    const vehicleTypeId = typed(after, "vehicleType") === typed(before, "vehicleType") ? undefined : vehicleTypeServerIdOf(after, context)
    if (isLocalRefusal(vehicleTypeId)) return vehicleTypeId
    const ownership = tokenOf(after, "ownershipType", VEHICLE_OWNERSHIPS, "ownership", "a vehicle")
    if (isLocalRefusal(ownership)) return ownership
    const serviceProviderId = providerServerIdOf(after, context)
    if (isLocalRefusal(serviceProviderId)) return serviceProviderId
    if (!providerFitsOwner(ownership ?? typed(before, "ownershipType") ?? "company", serviceProviderId)) return refusal("serviceProviderId", PROVIDER_WITH_PROVIDER_OWNERSHIP)
    const status = patchStatusOf(before, after, VEHICLE_STATUSES, "a vehicle")
    if (isLocalRefusal(status)) return status
    const capacityKg = payloadOf(after)
    if (isLocalRefusal(capacityKg)) return capacityKg
    const requiredLicenceClass = licenceTokenOf(after, "requiredLicenceClass")
    if (isLocalRefusal(requiredLicenceClass)) return requiredLicenceClass
    const homeDepotId = depotServerIdOf(after, "homeDepotId", context)
    if (isLocalRefusal(homeDepotId)) return homeDepotId
    const fuel = tokenOf(after, "fuelOrEnergyType", FUEL_TYPES, "fuel", "a vehicle")
    if (isLocalRefusal(fuel)) return fuel
    const wasteFractionIds = fractionServerIdsOf(after, FRACTIONS_KEY, context)
    if (isLocalRefusal(wasteFractionIds)) return wasteFractionIds
    const compartments = compartmentsPut(before, after, wasteFractionIds, context)
    if (isLocalRefusal(compartments)) return compartments
    const vehicle = withStatus(
      patchOf(before, after, (record) => {
        const provider = providerServerIdOf(record, context)
        const depot = depotServerIdOf(record, "homeDepotId", context)
        const licence = licenceTokenOf(record, "requiredLicenceClass")
        const payload = payloadOf(record)
        return {
          registration: typed(record, "registrationNumber"),
          callsign: typed(record, "assetReference") ?? null,
          // Resolved once above, for the row the edit leaves behind; the row before says nothing, so a changed type is a change.
          vehicleTypeId: record === after ? vehicleTypeId : undefined,
          ownership: typed(record, "ownershipType"),
          serviceProviderId: isLocalRefusal(provider) ? undefined : provider,
          capacityKg: isLocalRefusal(payload) ? undefined : (payload ?? null),
          requiredLicenceClass: isLocalRefusal(licence) ? undefined : licence,
          homeDepotId: isLocalRefusal(depot) ? undefined : depot,
          fuel: typed(record, "fuelOrEnergyType") ?? null,
          telematicsDeviceId: telematicsOf(record) ?? null,
        }
      }),
      before,
      status,
      VEHICLE_STATUSES,
    )
    if (vehicle === null && compartments === undefined) return null
    const write: VehicleWrite = { ...(vehicle === null ? {} : { vehicle }), ...(compartments === undefined ? {} : { compartments }) }
    return write
  },
  create: (client, body) => create<Vehicle>(client, "/vehicles", body).then((created) => created.body),
  // The vehicle first, then the whole list through its own route; the answer
  // is the vehicle as it now stands. Two requests are two, as the vehicle
  // types' update says.
  update: async (client, serverId, body) => {
    const write = body as VehicleWrite
    let vehicle: Vehicle | undefined
    if (write.vehicle !== undefined) vehicle = await patch<Vehicle>(client, `/vehicles/${serverId}`, write.vehicle)
    if (write.compartments !== undefined) vehicle = await put<Vehicle>(client, `/vehicles/${serverId}/compartments`, { compartments: write.compartments })
    return vehicle ?? (await get<Vehicle>(client, `/vehicles/${serverId}`))
  },
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

/** `C · valid to 2026-09-05`, literal: the class and the last day it holds; the reading is the licence rule's. */
function licenceFact(driver: Driver): string {
  if (driver.licenceClass === null) return "Not on record"
  const held = displayLicenceClass(driver.licenceClass)
  return driver.licenceExpiry === null ? held : `${held} · valid to ${driver.licenceExpiry}`
}

/**
 * The user account the form links — on with an account, off is none — as a
 * server id, null or a refusal. The picker is over `configure.access`,
 * which lists roles beside users, so a row that is no user is refused here
 * as a station is where a depot is asked for.
 */
function accountServerIdOf(record: BusinessRecord, context: MappingContext): string | null | undefined | LocalRefusal {
  const access = typedFlag(record, "driverAppAccess")
  if (access === undefined) return undefined
  if (!access) return null
  const webId = typed(record, "linkedUserId")
  if (webId === undefined) return refusal("linkedUserId", "Pick the driver's user account")
  const serverId = context.resolve.serverIdOf(webId)
  const named = serverId === undefined ? undefined : context.resolve.byServerId(serverId)
  if (serverId === undefined || named === undefined || !userAdapter.owns(named)) return refusal("linkedUserId", "Pick a user account the API holds")
  return serverId
}

/** The licence expiry the form typed as a day, null for blank, a refusal for anything else. */
function expiryOf(record: BusinessRecord): string | null | LocalRefusal {
  const text = typed(record, "licenceExpiry")
  if (text === undefined) return null
  return isIsoDate(text) ? text : refusal("licenceExpiry", "A licence expiry is a day, YYYY-MM-DD")
}

export const driverAdapter: ResourceAdapter<Driver> = {
  prefix: "driver",
  owns: ofKind("driver", ["Driver workforce profile"]),
  statuses: DRIVER_STATUSES,
  list: (client) => listAll<Driver>(client, "/drivers"),
  toRecord: (driver, context) => {
    const project = referenced(context, "project", driver.projectId)
    const provider = driver.serviceProviderId === null ? undefined : referenced(context, "service-provider", driver.serviceProviderId)
    const depot = driver.homeDepotId === null ? undefined : referenced(context, "depot", driver.homeDepotId)
    const account = driver.userAccountId === null ? undefined : referenced(context, "user", driver.userAccountId)
    const employer = provider?.name ?? "Company"
    const facts: Record<string, string> = {
      Licence: licenceFact(driver),
      Employer: employer,
      Employment: statusLabel(driver.employment),
      ...(driver.workforceReference === null ? {} : { "Workforce reference": driver.workforceReference }),
      ...(driver.licenceNumber === null ? {} : { "Licence number": driver.licenceNumber }),
      ...(depot === undefined ? {} : { "Home depot": depot.name ?? depot.webId }),
      "App access": account === undefined ? "None" : (account.name ?? account.webId),
      ...(project.name === undefined ? {} : { Project: project.name }),
    }
    return {
      id: webIdOf("driver", driver.id),
      name: driver.name,
      context: `${employer} · ${statusLabel(driver.employment).toLowerCase()}`,
      status: statusLabel(driver.status),
      ...inheritedPresentation(undefined),
      ...stampFacts(driver, context.now),
      owner: provider?.name ?? "",
      description: driver.notes ?? "",
      facts,
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      serviceProviderId: provider?.webId,
      recordKind: "Driver workforce profile",
      submittedValues: {
        driverName: driver.name,
        workforceReference: driver.workforceReference ?? "",
        employmentType: driver.employment,
        serviceProviderId: provider?.webId ?? "",
        projectId: project.webId,
        homeDepotId: depot?.webId ?? "",
        licenceNumber: driver.licenceNumber ?? "",
        licenceClass: driver.licenceClass === null ? "" : displayLicenceClass(driver.licenceClass),
        licenceExpiry: driver.licenceExpiry ?? "",
        driverAppAccess: account !== undefined,
        linkedUserId: account?.webId ?? "",
      },
    }
  },
  toCreateBody: (record, context) => {
    const projectId = projectServerIdOf(record, context)
    if (isLocalRefusal(projectId)) return projectId
    const name = requiredText(record, "driverName", "A driver", "a name")
    if (isLocalRefusal(name)) return name
    const employment = tokenOf(record, "employmentType", EMPLOYMENT_TYPES, "employment", "a driver") ?? refusal("employmentType", "Say how the driver is employed")
    if (isLocalRefusal(employment)) return employment
    const serviceProviderId = providerServerIdOf(record, context)
    if (isLocalRefusal(serviceProviderId)) return serviceProviderId
    if (!providerFitsOwner(employment, serviceProviderId)) return refusal("serviceProviderId", PROVIDER_WITH_PROVIDER_EMPLOYMENT)
    const homeDepotId = depotServerIdOf(record, "homeDepotId", context)
    if (isLocalRefusal(homeDepotId)) return homeDepotId
    const licenceClass = licenceTokenOf(record, "licenceClass")
    if (isLocalRefusal(licenceClass)) return licenceClass
    const licenceExpiry = expiryOf(record)
    if (isLocalRefusal(licenceExpiry)) return licenceExpiry
    const userAccountId = accountServerIdOf(record, context)
    if (isLocalRefusal(userAccountId)) return userAccountId
    const status = createStatusOf(record, DRIVER_STATUSES, "a driver")
    if (isLocalRefusal(status)) return status
    const workforceReference = typed(record, "workforceReference")
    const licenceNumber = typed(record, "licenceNumber")
    return {
      projectId,
      name,
      ...(workforceReference === undefined ? {} : { workforceReference }),
      employment,
      ...(serviceProviderId === null ? {} : { serviceProviderId }),
      ...(homeDepotId === null ? {} : { homeDepotId }),
      ...(licenceClass === undefined ? {} : { licenceClass }),
      ...(licenceNumber === undefined ? {} : { licenceNumber }),
      ...(licenceExpiry === null ? {} : { licenceExpiry }),
      ...(userAccountId == null ? {} : { userAccountId }),
      ...(status === undefined ? {} : { status }),
    }
  },
  toPatchBody: (before, after, context) => {
    if (projectMoved(before, after)) return refusal("projectId", "A driver stays in its project")
    const employment = tokenOf(after, "employmentType", EMPLOYMENT_TYPES, "employment", "a driver")
    if (isLocalRefusal(employment)) return employment
    const serviceProviderId = providerServerIdOf(after, context)
    if (isLocalRefusal(serviceProviderId)) return serviceProviderId
    if (!providerFitsOwner(employment ?? typed(before, "employmentType") ?? "employee", serviceProviderId)) return refusal("serviceProviderId", PROVIDER_WITH_PROVIDER_EMPLOYMENT)
    const homeDepotId = depotServerIdOf(after, "homeDepotId", context)
    if (isLocalRefusal(homeDepotId)) return homeDepotId
    const licenceClass = licenceTokenOf(after, "licenceClass")
    if (isLocalRefusal(licenceClass)) return licenceClass
    const licenceExpiry = expiryOf(after)
    if (isLocalRefusal(licenceExpiry)) return licenceExpiry
    const userAccountId = accountServerIdOf(after, context)
    if (isLocalRefusal(userAccountId)) return userAccountId
    const status = patchStatusOf(before, after, DRIVER_STATUSES, "a driver")
    if (isLocalRefusal(status)) return status
    const body = patchOf(before, after, (record) => {
      const provider = providerServerIdOf(record, context)
      const depot = depotServerIdOf(record, "homeDepotId", context)
      const licence = licenceTokenOf(record, "licenceClass")
      const expiry = expiryOf(record)
      const account = accountServerIdOf(record, context)
      return {
        name: typed(record, "driverName") ?? record.name,
        workforceReference: typed(record, "workforceReference") ?? null,
        employment: typed(record, "employmentType"),
        serviceProviderId: isLocalRefusal(provider) ? undefined : provider,
        homeDepotId: isLocalRefusal(depot) ? undefined : depot,
        licenceClass: isLocalRefusal(licence) ? undefined : (licence ?? null),
        licenceNumber: typed(record, "licenceNumber") ?? null,
        licenceExpiry: isLocalRefusal(expiry) ? undefined : expiry,
        userAccountId: isLocalRefusal(account) ? undefined : account,
      }
    })
    return withStatus(body, before, status, DRIVER_STATUSES)
  },
  create: (client, body) => create<Driver>(client, "/drivers", body).then((created) => created.body),
  update: (client, serverId, body) => patch<Driver>(client, `/drivers/${serverId}`, body),
}

// ---------------------------------------------------------------------------
// The modules
// ---------------------------------------------------------------------------

/** Fleet → Vehicles, after the master data (its type), the providers and the depots (its base). */
export const fleetVehiclesModule: ServerModule = {
  workspaceId: "fleet",
  moduleId: "vehicles",
  resources: [vehicleAdapter],
}

/** Fleet → Drivers, after the access module (its login), the providers and the depots. */
export const fleetDriversModule: ServerModule = {
  workspaceId: "fleet",
  moduleId: "drivers",
  resources: [driverAdapter],
}

export type { Client }
