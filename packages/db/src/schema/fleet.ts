// The fleet (Issue #101): the Vehicle with its compartments, and the Driver.
// Both are a project's, like the depot they are based at and the schemes and
// allocations that name them, and both carry a status and no period
// (ADR-0005): the prototype's `effectiveFrom`/`effectiveTo` and `availability`
// text on a vehicle are gone — a window over a vehicle is a Vehicle
// Allocation (allocations.ts), and its unavailability windows arrive with
// Execution.
//
// `vehicle` is a powered vehicle or a trailer (`kind`), of a `vehicle_type`
// of the company (fleet-types.ts). Its registration — the plate — is unique
// per company and not per project, because a plate is read off a vehicle
// anywhere in the company, the way a container's label is; the callsign
// (`WH-24`) is unique per company where given, a partial index over the rows
// that have one. `required_licence_class` is NOT NULL: the fleet readers'
// rule is that an unknown class passes nobody (#37), so a vehicle without one
// is a vehicle nobody may take out, and the form has to say. Its ownership
// has the depot's shape check: a provider's vehicle names its provider and no
// other does.
//
// `vehicle_compartment` is the glossary's "one or more compartments, each
// with a capacity for one or more waste fractions", as rows: a compartment
// has a position among the vehicle's (unique, and safe because the set is
// replaced whole), a name, a payload and a volume, and its fractions are
// `vehicle_compartment_fraction` rows a key can refuse when they name another
// company's. A vehicle's compatible fractions are the union of its
// compartments', read and never stored. The fraction unique is spelled inline
// and named for what it holds, the derived name passing 63 bytes.
//
// `driver` is "a workforce profile linked to a User identity", never the same
// record: `user_account_id` is the login the driver app uses, one profile per
// login where given (a partial unique index, which is also the index the
// reference needs — a second one would take the same derived name). The
// licence is three attributes and not an effective-dated row (ADR-0005: a
// renewal is an edit and the audit log its history): the class held, null for
// none on record — Jonas Lind, eligible for nothing — the number, and the
// expiry, which is what "holds on that day" reads
// (@waste/domain/resources/licence). A driver's employment has the provider's
// shape check over `employment` instead of `ownership`.
import { DRIVER_STATUSES, EMPLOYMENT_TYPES, FUEL_TYPES, LICENCE_CLASSES, VEHICLE_KINDS, VEHICLE_OWNERSHIPS, VEHICLE_STATUSES } from "@waste/domain/resources/vocabulary"
import { sql } from "drizzle-orm"
import { check, date, integer, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { wasteFraction } from "./catalogue"
import { oneOf, positive } from "./checks"
import { id, projectScoped, timestamps } from "./columns"
import { vehicleType } from "./fleet-types"
import { company, project, serviceProvider } from "./organisation"
import { depot } from "./places"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const vehicle = wms.table(
  "vehicle",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** The plate, `CN 42 018`: unique per company, since it is read off the vehicle anywhere. */
    registration: text().notNull(),
    /** What the yard calls it, `WH-24`; unique per company where given. */
    callsign: text(),
    kind: text().notNull(),
    vehicleTypeId: uuid().notNull(),
    ownership: text().notNull(),
    /** The owning provider, given exactly when the ownership says so. */
    serviceProviderId: uuid(),
    status: text().notNull(),
    /** The rated payload. */
    capacityKg: integer(),
    /** The class a driver needs to take it out; never unknown, since unknown passes nobody. */
    requiredLicenceClass: text().notNull(),
    homeDepotId: uuid(),
    fuel: text(),
    /** The telematics unit's own identifier; what it reports is Execution's. */
    telematicsDeviceId: text(),
    notes: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.vehicleTypeId], vehicleType),
    tenantReference(t, [t.serviceProviderId], serviceProvider),
    projectReference(t, [t.homeDepotId], depot),
    tenantUnique(t, t.registration),
    projectKey(t),
    oneOf(t.kind, VEHICLE_KINDS),
    oneOf(t.ownership, VEHICLE_OWNERSHIPS),
    oneOf(t.status, VEHICLE_STATUSES),
    oneOf(t.requiredLicenceClass, LICENCE_CLASSES),
    oneOf(t.fuel, FUEL_TYPES),
    positive(t.capacityKg),
    check(tableObjectName(t.id.table, "provider_shape", "vehicle"), sql`(${t.ownership} = 'service-provider') = (${t.serviceProviderId} is not null)`),
    // Most vehicles have a callsign and some do not, and a null is not a duplicate of another null: a partial index, not a constraint.
    uniqueIndex(tableObjectName(t.companyId.table, "callsign_idx", "vehicle")).on(t.companyId, t.callsign).where(sql`${t.callsign} is not null`),
    tenantIndex(t, t.vehicleTypeId),
    tenantIndex(t, t.serviceProviderId),
    tenantIndex(t, t.homeDepotId),
  ],
)

export const vehicleCompartment = wms.table(
  "vehicle_compartment",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    vehicleId: uuid().notNull(),
    /** Its place among the vehicle's compartments, 1..n; the set is replaced whole, so the unique on it is safe. */
    position: integer().notNull(),
    /** `Body`, `Left`, `Right`; null for a vehicle with one unnamed body. */
    name: text(),
    capacityKg: integer(),
    volumeLitres: integer(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.vehicleId], vehicle),
    tenantUnique(t, t.vehicleId, t.position),
    projectKey(t),
    positive(t.position),
    positive(t.capacityKg),
    positive(t.volumeLitres),
    tenantIndex(t, t.projectId),
  ],
)

export const vehicleCompartmentFraction = wms.table(
  "vehicle_compartment_fraction",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    vehicleCompartmentId: uuid().notNull(),
    wasteFractionId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.vehicleCompartmentId], vehicleCompartment),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    // One row per fraction a compartment carries; the derived name would pass 63 bytes, so the key is named for what it holds.
    unique(tableObjectName(t.companyId.table, "membership_key", "vehicleCompartmentFraction")).on(t.companyId, t.vehicleCompartmentId, t.wasteFractionId),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.wasteFractionId),
  ],
)

export const driver = wms.table(
  "driver",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    name: text().notNull(),
    /** The payroll or workforce system's reference; unique per company where given. */
    workforceReference: text(),
    employment: text().notNull(),
    /** The employing provider, given exactly when the employment says so. */
    serviceProviderId: uuid(),
    homeDepotId: uuid(),
    /** The highest class held; null is not on record, which is eligible for nothing. */
    licenceClass: text(),
    licenceNumber: text(),
    /** The last day the licence holds. */
    licenceExpiry: date(),
    /** The login the driver app uses; one profile per login where given. */
    userAccountId: uuid(),
    status: text().notNull(),
    notes: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.serviceProviderId], serviceProvider),
    tenantReference(t, [t.userAccountId], userAccount),
    projectReference(t, [t.homeDepotId], depot),
    projectKey(t),
    oneOf(t.employment, EMPLOYMENT_TYPES),
    oneOf(t.licenceClass, LICENCE_CLASSES),
    oneOf(t.status, DRIVER_STATUSES),
    check(tableObjectName(t.id.table, "provider_shape", "driver"), sql`(${t.employment} = 'service-provider') = (${t.serviceProviderId} is not null)`),
    // Both unique where given, so both are partial indexes over the rows that
    // have one. The login's doubles as the index its reference needs: a
    // `tenantIndex` on it would derive the same name.
    uniqueIndex(tableObjectName(t.companyId.table, "workforce_reference_idx", "driver")).on(t.companyId, t.workforceReference).where(sql`${t.workforceReference} is not null`),
    uniqueIndex(tableObjectName(t.companyId.table, "user_account_id_idx", "driver")).on(t.companyId, t.userAccountId).where(sql`${t.userAccountId} is not null`),
    tenantIndex(t, t.serviceProviderId),
    tenantIndex(t, t.homeDepotId),
  ],
)
