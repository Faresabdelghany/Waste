// The fleet on the wire (Issue #101): the Vehicle with its compartments, and
// the Driver. Both are a project's, and both carry a status and no period
// (ADR-0005): the prototype's `effectiveFrom`/`effectiveTo` and `availability`
// on a vehicle are gone — a window over a vehicle is a Vehicle Allocation
// (`allocations.ts`).
//
// A vehicle's compartments are the glossary's "one or more compartments, each
// with a capacity for one or more waste fractions", as a positioned list that
// travels with the vehicle: read with it, written with it, and replaced whole
// through `PUT /vehicles/:id/compartments`, since positions are 1..n in the
// body's order and a set the client already holds is replaced and not
// diffed. A powered vehicle carries at least one compartment
// (`A_POWERED_VEHICLE_HAS_A_COMPARTMENT`, refused at `compartments`), a
// trailer may carry none; the create holds it, and the set route holds it
// against the stored kind. A vehicle's compatible fractions are the union of
// its compartments', read and never stored. The vehicle does not become a
// trailer: `kind`, the project and the compartments are not on the patch.
//
// `requiredLicenceClass` is required on a vehicle, since unknown passes
// nobody (the fleet readers' rule, #37) and a vehicle without a class is a
// vehicle nobody may take out; a driver's `licenceClass` is nullable, since a
// new hire without a licence is a real record, eligible for nothing until it
// is filled in. The expiry is the last day the licence holds
// (`@waste/domain/resources/licence`). The provider rule of `places.ts` runs
// over a vehicle's `ownership` with the places' sentence, and over a driver's
// `employment` with a sentence of its own, since a driver body has no
// ownership to be told about.
import { EACH_FRACTION_ONCE } from "@waste/domain/registry/catalogue"
import { eachOnce } from "@waste/domain/requests"
import { A_POWERED_VEHICLE_HAS_A_COMPARTMENT, COMPARTMENT_FRACTIONS_MAX, COMPARTMENTS_MAX, poweredVehicleHasACompartment, PROVIDER_WITH_PROVIDER_EMPLOYMENT } from "@waste/domain/resources/fleet"
import { providerShape, providerShapeGiven } from "@waste/domain/resources/places"
import * as z from "zod"

import { IsoDate } from "./dates"
import { Id } from "./ids"
import { providerWithProviderOwnership } from "./places"
import { ProjectScopedListQuery } from "./queries"
import { PositiveInt, resourceBodies, stamped } from "./resource"
import { DriverStatus, EmploymentType, FuelType, LicenceClass, VehicleKind, VehicleOwnership, VehicleStatus } from "./resources"
import { DriverShift } from "./shifts"
import { Label, Paragraph } from "./text"

/** An order among siblings: whole and positive, since the first is number one. */
const Ordinal = PositiveInt

/** A payload or a volume: whole units, above zero. */
const Amount = PositiveInt

const providerWithProviderEmployment = { message: PROVIDER_WITH_PROVIDER_EMPLOYMENT, path: ["serviceProviderId"] }

const CompartmentFractionIds = z.array(Id).min(1).refine((ids) => eachOnce(ids), { message: EACH_FRACTION_ONCE })

export const VehicleCompartment = z.object({
  /** Its place among the vehicle's compartments, 1..n. */
  position: Ordinal,
  /** `Body`, `Left`, `Right`; null for a vehicle with one unnamed body. */
  name: Label.nullable(),
  capacityKg: Amount.nullable(),
  volumeLitres: Amount.nullable(),
  wasteFractionIds: CompartmentFractionIds,
})
export type VehicleCompartment = z.infer<typeof VehicleCompartment>

/** One compartment as a body gives it: the position is the body's order. */
export const VehicleCompartmentCreate = z.strictObject({
  name: Label.nullable().optional(),
  capacityKg: Amount.nullable().optional(),
  volumeLitres: Amount.nullable().optional(),
  wasteFractionIds: CompartmentFractionIds.max(COMPARTMENT_FRACTIONS_MAX),
})
export type VehicleCompartmentCreate = z.infer<typeof VehicleCompartmentCreate>

const CompartmentsBody = z.array(VehicleCompartmentCreate).max(COMPARTMENTS_MAX)

const aPoweredVehicleHasACompartment = { message: A_POWERED_VEHICLE_HAS_A_COMPARTMENT, path: ["compartments"] }

export const Vehicle = z.object({
  ...stamped,
  projectId: Id,
  /** The plate, `CN 42 018`: unique per company. */
  registration: Label,
  /** What the yard calls it, `WH-24`; unique per company where given. */
  callsign: Label.nullable(),
  kind: VehicleKind,
  vehicleTypeId: Id,
  ownership: VehicleOwnership,
  /** The owning provider, given exactly with service-provider ownership. */
  serviceProviderId: Id.nullable(),
  status: VehicleStatus,
  /** The rated payload. */
  capacityKg: Amount.nullable(),
  /** The class a driver needs to take it out; never unknown. */
  requiredLicenceClass: LicenceClass,
  homeDepotId: Id.nullable(),
  fuel: FuelType.nullable(),
  telematicsDeviceId: Label.nullable(),
  notes: Paragraph.nullable(),
  /** By position. */
  compartments: z.array(VehicleCompartment),
})
export type Vehicle = z.infer<typeof Vehicle>

/** A patch takes everything but the project, the kind and the compartments: a vehicle does not become a trailer, and its compartments have a route of their own. */
const vehicleBodies = resourceBodies(
  {
    projectId: Id,
    registration: Label,
    callsign: Label.nullable().optional(),
    kind: VehicleKind,
    vehicleTypeId: Id,
    ownership: VehicleOwnership.default("company").describe("Defaults to company when absent: a vehicle the company owns is the common case; a provider's names its provider."),
    serviceProviderId: Id.nullable().optional(),
    status: VehicleStatus.default("active").describe("Defaults to active when absent: a vehicle is registered in order to drive."),
    capacityKg: Amount.nullable().optional(),
    requiredLicenceClass: LicenceClass,
    homeDepotId: Id.nullable().optional(),
    fuel: FuelType.nullable().optional(),
    telematicsDeviceId: Label.nullable().optional(),
    notes: Paragraph.nullable().optional(),
    compartments: CompartmentsBody.default([]).describe("The compartments in position order, 1..n; a powered vehicle has at least one, a trailer may have none."),
  },
  { createOnly: { projectId: true, kind: true, compartments: true } },
)

export const VehicleCreate = vehicleBodies.create
  .refine((body) => providerShapeGiven(body.ownership, body), providerWithProviderOwnership)
  .refine((body) => poweredVehicleHasACompartment(body.kind, body.compartments), aPoweredVehicleHasACompartment)
export type VehicleCreate = z.infer<typeof VehicleCreate>

export const VehiclePatch = vehicleBodies.patch.refine((patch) => providerShape(patch.ownership, patch), providerWithProviderOwnership)
export type VehiclePatch = z.infer<typeof VehiclePatch>

/** The whole list in position order, replacing what the vehicle had; whether it may be empty depends on the stored kind, which the route knows. */
export const VehicleCompartmentsSet = z.strictObject({ compartments: CompartmentsBody })
export type VehicleCompartmentsSet = z.infer<typeof VehicleCompartmentsSet>

export const Driver = z.object({
  ...stamped,
  projectId: Id,
  name: Label,
  /** The payroll or workforce system's reference; unique per company where given. */
  workforceReference: Label.nullable(),
  employment: EmploymentType,
  /** The employing provider, given exactly with service-provider employment. */
  serviceProviderId: Id.nullable(),
  homeDepotId: Id.nullable(),
  /** The highest class held; null is not on record, which is eligible for nothing. */
  licenceClass: LicenceClass.nullable(),
  licenceNumber: Label.nullable(),
  /** The last day the licence holds. */
  licenceExpiry: IsoDate.nullable(),
  /** The login the driver app uses; one profile per login. */
  userAccountId: Id.nullable(),
  status: DriverStatus,
  notes: Paragraph.nullable(),
  /** The working day on the project's clock with its one break (O14 of #290): what the optimiser is sent for a route the driver is planned on, and what its over-shift verdict reads. Null is no shift on record. */
  shift: DriverShift.nullable(),
})
export type Driver = z.infer<typeof Driver>

/** A patch takes everything but the project; its shift is written whole, the break with it, and a null clears it. */
const driverBodies = resourceBodies(
  {
    projectId: Id,
    name: Label,
    workforceReference: Label.nullable().optional(),
    employment: EmploymentType,
    serviceProviderId: Id.nullable().optional(),
    homeDepotId: Id.nullable().optional(),
    licenceClass: LicenceClass.nullable().optional(),
    licenceNumber: Label.nullable().optional(),
    licenceExpiry: IsoDate.nullable().optional(),
    userAccountId: Id.nullable().optional(),
    status: DriverStatus.default("active").describe("Defaults to active when absent: a driver is registered in order to drive."),
    notes: Paragraph.nullable().optional(),
    shift: DriverShift.nullable().optional(),
  },
  { createOnly: { projectId: true } },
)

export const DriverCreate = driverBodies.create.refine((body) => providerShapeGiven(body.employment, body), providerWithProviderEmployment)
export type DriverCreate = z.infer<typeof DriverCreate>

export const DriverPatch = driverBodies.patch.refine((patch) => providerShape(patch.employment, patch), providerWithProviderEmployment)
export type DriverPatch = z.infer<typeof DriverPatch>

export const VehicleListQuery = ProjectScopedListQuery.extend({
  kind: VehicleKind.optional(),
  vehicleTypeId: Id.optional(),
  status: VehicleStatus.optional(),
  homeDepotId: Id.optional(),
})
export type VehicleListQuery = z.infer<typeof VehicleListQuery>

export const DriverListQuery = ProjectScopedListQuery.extend({
  status: DriverStatus.optional(),
  licenceClass: LicenceClass.optional(),
  homeDepotId: Id.optional(),
})
export type DriverListQuery = z.infer<typeof DriverListQuery>
