// The places work starts, ends and stocks, on the wire (Issue #101): the
// Depot, the Warehouse and the Unloading Station — three resources, as the
// glossary keeps three terms with three Avoid lists, and the prototype's
// mixed "Depots & Unloading" tab is split. Every rule of resource.ts holds: a
// resource spreads `stamped`, a write body is strict and says only what a
// caller may say, a patch is every field optional and at least one given, a
// project-scoped record never moves between projects.
//
// A Depot and a Warehouse are a project's; an Unloading Station is the
// company's, because ARC Amager is where every Copenhagen project unloads, so
// it carries no `projectId` anywhere. A depot and a station are always
// located — a route departs from a point and empties at one — and a
// warehouse is registered before it is geocoded, so its point is nullable
// like a property's. Every point is a `FlatPoint` (geojson.ts), since the
// column is flat and a third ordinate is a 400 here rather than PostGIS's
// 22023. The `code` of each is the stable reference a person quotes and is
// set once, like a planning area's.
//
// Two shape rules run through the depot and the station, spelled once each
// with their sentences so the routes can refuse a patch, which carries half
// the picture, in the same words against the stored row: the owning service
// provider is named with `service-provider` ownership and with nothing else
// (`providerShape`, the driver's `fleet.ts` runs it over `employment`), and
// the opening hours are both given or neither (`hoursShape`; an overnight
// window, 22:00 to 05:00, is two times and allowed). A half-seen pair is not
// judged, which is what a patch gives; a create treats an absent optional as
// null.
//
// A station's fractions — what it accepts — travel with the record and are
// replaced whole through `PUT /unloading-stations/:id/fractions`; a create
// may carry the set it starts with, a patch never does.
import * as z from "zod"

import { IsoTime } from "./dates"
import { FlatPoint } from "./geojson"
import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, eachOnce, eachOnceSentence, PositiveInt, somethingToChange, stamped } from "./resource"
import { DepotOwnership, DepotStatus, UnloadingStationOwnership, UnloadingStationStatus, WarehouseStatus } from "./resources"
import { Label, Paragraph } from "./text"

/** The most fractions a set body may name: a form's list, not an import. */
const SET_MAX = 200

/** A count of vehicles a yard holds; zero is not a capacity. */
const VehicleCapacity = PositiveInt

/** What a body whose ownership and provider disagree is told, at the provider. A driver's employment has a sentence of its own (`fleet.ts`). */
export const PROVIDER_WITH_PROVIDER_OWNERSHIP = "Name the owning service provider with service-provider ownership and with nothing else"
export const providerWithProviderOwnership = { message: PROVIDER_WITH_PROVIDER_OWNERSHIP, path: ["serviceProviderId"] }

/** What a body giving one opening time is told, at the closing time. */
export const BOTH_HOURS_OR_NEITHER = "Give both opening and closing time or neither"
const bothHoursOrNeither = { message: BOTH_HOURS_OR_NEITHER, path: ["closesAt"] }

type Provided = { serviceProviderId?: string | null }

/**
 * The owning provider is named exactly when `owner` says `service-provider`.
 * `owner` is the ownership of a depot or a station, the employment of a
 * driver. A half-seen pair — a patch giving one of the two — is not judged;
 * only the route, which has the stored row, can hold the two together.
 */
export function providerShape(owner: string | undefined, body: Provided): boolean {
  if (owner === undefined || body.serviceProviderId === undefined) return true
  return (owner === "service-provider") === (body.serviceProviderId !== null)
}

/** The same rule as a create body sees it, `owner` being the body's ownership or employment: an absent provider is none. */
export const providerShapeGiven = (owner: string, body: Provided): boolean => providerShape(owner, { serviceProviderId: body.serviceProviderId ?? null })

type Hours = { opensAt?: string | null; closesAt?: string | null }

/** Both times or neither. A half-seen pair is not judged, which is what a patch gives. */
export function hoursShape(body: Hours): boolean {
  if (body.opensAt === undefined || body.closesAt === undefined) return true
  return (body.opensAt === null) === (body.closesAt === null)
}

/** The same rule as a create body sees it: an absent time is none. */
const hoursShapeGiven = (body: Hours): boolean => hoursShape({ opensAt: body.opensAt ?? null, closesAt: body.closesAt ?? null })

export const Warehouse = z.object({
  ...stamped,
  projectId: Id,
  /** The stable reference a person quotes: `WH-WEST`. Unique per project; set once. */
  code: Label,
  /** Unique per project. */
  name: Label,
  /** The address as one text; a structured address arrives with the address lookup (#77). */
  address: Paragraph,
  /** Geocoded, null until it is. */
  location: FlatPoint.nullable(),
  /** The depot this warehouse shares a yard with, if any. */
  depotId: Id.nullable(),
  status: WarehouseStatus,
  notes: Paragraph.nullable(),
})
export type Warehouse = z.infer<typeof Warehouse>

export const WarehouseCreate = z.strictObject({
  projectId: Id,
  code: Label,
  name: Label,
  address: Paragraph,
  location: FlatPoint.nullable().optional(),
  depotId: Id.nullable().optional(),
  status: WarehouseStatus.default("active").describe("Defaults to active when absent: a warehouse is registered because stock already moves through it."),
  notes: Paragraph.nullable().optional(),
})
export type WarehouseCreate = z.infer<typeof WarehouseCreate>

/** Everything but the project, the code and the stamps. */
export const WarehousePatch = z
  .strictObject({
    name: Label.optional(),
    address: Paragraph.optional(),
    location: FlatPoint.nullable().optional(),
    depotId: Id.nullable().optional(),
    status: WarehouseStatus.optional(),
    notes: Paragraph.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type WarehousePatch = z.infer<typeof WarehousePatch>

export const Depot = z.object({
  ...stamped,
  projectId: Id,
  /** The stable reference a person quotes: `DEP-NORD`. Unique per project; set once. */
  code: Label,
  name: Label,
  address: Paragraph,
  /** A route departs from a point, so a depot is always located. */
  location: FlatPoint,
  ownership: DepotOwnership,
  /** The owning provider, given exactly with service-provider ownership. */
  serviceProviderId: Id.nullable(),
  /** Opening hours on the project's clock, both or neither; an overnight window is two times. */
  opensAt: IsoTime.nullable(),
  closesAt: IsoTime.nullable(),
  /** How many vehicles the yard holds. */
  vehicleCapacity: VehicleCapacity.nullable(),
  status: DepotStatus,
  notes: Paragraph.nullable(),
})
export type Depot = z.infer<typeof Depot>

export const DepotCreate = z
  .strictObject({
    projectId: Id,
    code: Label,
    name: Label,
    address: Paragraph,
    location: FlatPoint,
    ownership: DepotOwnership.default("company").describe("Defaults to company when absent: a depot the company runs is the common case; a provider's names its provider."),
    serviceProviderId: Id.nullable().optional(),
    opensAt: IsoTime.nullable().optional(),
    closesAt: IsoTime.nullable().optional(),
    vehicleCapacity: VehicleCapacity.nullable().optional(),
    status: DepotStatus.default("active").describe("Defaults to active when absent: a depot is registered because routes already leave from it."),
    notes: Paragraph.nullable().optional(),
  })
  .refine((body) => providerShapeGiven(body.ownership, body), providerWithProviderOwnership)
  .refine(hoursShapeGiven, bothHoursOrNeither)
export type DepotCreate = z.infer<typeof DepotCreate>

/** Everything but the project, the code and the stamps; the two shape rules are held here where the patch carries both halves, and by the route against the stored row otherwise. */
export const DepotPatch = z
  .strictObject({
    name: Label.optional(),
    address: Paragraph.optional(),
    location: FlatPoint.optional(),
    ownership: DepotOwnership.optional(),
    serviceProviderId: Id.nullable().optional(),
    opensAt: IsoTime.nullable().optional(),
    closesAt: IsoTime.nullable().optional(),
    vehicleCapacity: VehicleCapacity.nullable().optional(),
    status: DepotStatus.optional(),
    notes: Paragraph.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
  .refine((patch) => providerShape(patch.ownership, patch), providerWithProviderOwnership)
  .refine(hoursShape, bothHoursOrNeither)
export type DepotPatch = z.infer<typeof DepotPatch>

export const EACH_FRACTION_ONCE = eachOnceSentence("waste fraction")
const eachFractionOnce = { message: EACH_FRACTION_ONCE, path: ["wasteFractionIds"] }

const WasteFractionIds = z.array(Id)
const WasteFractionIdsBody = WasteFractionIds.max(SET_MAX)

export const UnloadingStation = z.object({
  ...stamped,
  /** The stable reference a person quotes: `ARC-AMAGER`. Unique per company; set once. */
  code: Label,
  /** Unique per company. */
  name: Label,
  address: Paragraph,
  /** A route empties at a point, so a station is always located. */
  location: FlatPoint,
  ownership: UnloadingStationOwnership,
  serviceProviderId: Id.nullable(),
  opensAt: IsoTime.nullable(),
  closesAt: IsoTime.nullable(),
  /** Whether the station weighs what is delivered; the tickets themselves are Execution's. */
  weighbridge: z.boolean(),
  status: UnloadingStationStatus,
  notes: Paragraph.nullable(),
  /** What the station accepts, by id; replaced whole through its own route. */
  wasteFractionIds: WasteFractionIds,
})
export type UnloadingStation = z.infer<typeof UnloadingStation>

/** The station is the company's, so no project is here; the ownership has no default, since the plant the company delivers to is as common as its own. */
export const UnloadingStationCreate = z
  .strictObject({
    code: Label,
    name: Label,
    address: Paragraph,
    location: FlatPoint,
    ownership: UnloadingStationOwnership,
    serviceProviderId: Id.nullable().optional(),
    opensAt: IsoTime.nullable().optional(),
    closesAt: IsoTime.nullable().optional(),
    weighbridge: z.boolean().default(false).describe("Defaults to false when absent: whether the station weighs what is delivered."),
    status: UnloadingStationStatus.default("active").describe("Defaults to active when absent: a station is registered because routes already empty there."),
    notes: Paragraph.nullable().optional(),
    wasteFractionIds: WasteFractionIdsBody.default([]).describe("The fractions the station starts out accepting; none when absent."),
  })
  .refine((body) => providerShapeGiven(body.ownership, body), providerWithProviderOwnership)
  .refine(hoursShapeGiven, bothHoursOrNeither)
  .refine((body) => eachOnce(body.wasteFractionIds), eachFractionOnce)
export type UnloadingStationCreate = z.infer<typeof UnloadingStationCreate>

/** Everything but the code, the fractions and the stamps. */
export const UnloadingStationPatch = z
  .strictObject({
    name: Label.optional(),
    address: Paragraph.optional(),
    location: FlatPoint.optional(),
    ownership: UnloadingStationOwnership.optional(),
    serviceProviderId: Id.nullable().optional(),
    opensAt: IsoTime.nullable().optional(),
    closesAt: IsoTime.nullable().optional(),
    weighbridge: z.boolean().optional(),
    status: UnloadingStationStatus.optional(),
    notes: Paragraph.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
  .refine((patch) => providerShape(patch.ownership, patch), providerWithProviderOwnership)
  .refine(hoursShape, bothHoursOrNeither)
export type UnloadingStationPatch = z.infer<typeof UnloadingStationPatch>

/** The whole set of fractions the station accepts, replacing what it had. */
export const UnloadingStationFractionsSet = z.strictObject({ wasteFractionIds: WasteFractionIdsBody }).refine((body) => eachOnce(body.wasteFractionIds), eachFractionOnce)
export type UnloadingStationFractionsSet = z.infer<typeof UnloadingStationFractionsSet>

/** A page of warehouses, from one project and of one status. */
export const WarehouseListQuery = ProjectScopedListQuery.extend({
  status: WarehouseStatus.optional(),
})
export type WarehouseListQuery = z.infer<typeof WarehouseListQuery>

/** A page of depots, from one project and of one status. */
export const DepotListQuery = ProjectScopedListQuery.extend({
  status: DepotStatus.optional(),
})
export type DepotListQuery = z.infer<typeof DepotListQuery>

/** A page of unloading stations: the company's, of one status, accepting one fraction. */
export const UnloadingStationListQuery = PageRequest.extend({
  status: UnloadingStationStatus.optional(),
  /** The stations that accept this fraction. */
  wasteFractionId: Id.optional(),
})
export type UnloadingStationListQuery = z.infer<typeof UnloadingStationListQuery>
