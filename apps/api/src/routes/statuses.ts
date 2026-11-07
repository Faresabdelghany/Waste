// A status gates a new reference and never an existing one (Issue #79).
//
// Every Registry record that is not effective-dated carries a status — a
// Customer active or inactive, a Property the same, a Product draft, active
// or inactive, a Shared Collection Point draft, open, restricted or closed —
// and until this module nothing read one: an inactive customer could take a
// new agreement and a closed point a new subscription. The rule is one
// sentence. A body that names a customer, a product or a place is making a
// new reference, and the row it names has to be in the state that reference
// needs: a Customer active to hold or to be billed for an agreement, a
// Product active to be subscribed to, a place served — a Property active, a
// Point open or restricted — to be delivered at or to have a container put
// into service at. A reference already made stands whatever the row does
// afterwards — an agreement of a customer that goes inactive runs on, a
// placement at a point that closes is ended by its period and not by the
// status — and a row's own status never blocks a write to the row itself: a
// draft product is patched, a customer is set inactive with agreements
// standing. A patch that re-states the id a record already carries names
// nothing new, so it is not held here either: a client that sends the record
// whole is not refused for the customer it already has. An Application (M7 of
// #293) names a customer, a place and a subscription to say whom and what a
// request is about, not to hold, bill or serve anything: no status gates it,
// since an inactive customer's fee correction or a closed place's last
// collection is exactly what an Application is for.
//
// The refusal is a 409, not a 400 and not a 404: the id is right and the row
// is there, and what refuses is the state it is in. A 400 says "fix the id"
// and a 404 says "there is no such row", and neither is what happened. It is
// a sentence naming the status the row has and the state the reference needs,
// so a person reads what to change, and each is spelled here once per family;
// "served" is defined once, in the domain (`@waste/domain/registry/served-places`),
// for every reference that asks it, so a subscription, a placement, a stop and
// a booking cannot disagree about which places take waste.
//
// These are gates over a status already read, not lookups. routes/references.ts
// answers the status with the proof the row is there, and a route runs every
// 400 it has first — the ids that are not there, the period outside its
// parent's — and these after, so a body that is wrong is told so before a
// state it did not choose: 400 before any 409, as in every route here.
//
// No row lock is taken for this rule, unlike for containment
// (routes/periods.ts), because it has one side and not two: a status change
// never looks at what references the row, so there is no pair of reads to
// serialise. A reference made the instant before the state changed is exactly
// an existing reference, and stands.
//
// What stays informational, by decision and not by omission: `project.status`,
// since an onboarding project is one being set up and setting one up is
// writing these records; `property_group.status`, since a group is built
// while draft; and `agreement.status`, since the period says the stronger
// thing (ADR-0005) — an agreement is valid on a day or it is not. The
// set-shaped references (a Property's parties, a Group's or a Point's members)
// and the customer a Group or a Point answers to are not gated in this issue
// either.
//
// Resources (Issue #101, its review rounds) applies the same rule to its own
// rows — a retired vehicle or trailer, an inactive or suspended driver —
// below the Registry's gates; a warehouse that takes no stock and a retired
// decommission reason are the Stock Movement ledger's own
// (`@waste/db/commands/stock-ledger`). The lookup that proves a Resources row
// is there answers its status too (`requireStatus` in routes/shared.ts, the
// fleet checks of routes/references.ts), so a gate costs no second
// statement; the statuses are the vocabulary's
// (@waste/domain/resources/vocabulary), the sentences are spelled here once
// and read by every door, and each review round appends its gates under its
// own heading.
import type { ProductStatus } from "@waste/contracts/catalogue"
import type { CustomerStatus } from "@waste/contracts/customers"
import type { ContaminantCodeStatus } from "@waste/contracts/pickup-exceptions"
import type { TeamStatus } from "@waste/contracts/ticket-teams"
import type { TicketTypeStatus } from "@waste/contracts/ticket-types"
import { vehicleAllocation } from "@waste/db/schema/allocations"
import type { AllocationStatus, DriverStatus, VehicleStatus } from "@waste/domain/resources/vocabulary"
import { count } from "@waste/domain/text"
import { and, eq, gt, inArray, sql, type SQL } from "drizzle-orm"

import { problem } from "../problem"

/** The two fields an agreement names a customer in: as its holder, and as the customer it is billed to. */
export type Party = "customerId" | "payerCustomerId"

/** What an inactive customer is told in each field; the sentence says which, and a payer is a Customer in the glossary's terms. */
const INACTIVE_PARTY: Readonly<Record<Party, string>> = {
  customerId: "The customer is inactive; an agreement needs an active customer",
  payerCustomerId: "The customer named as payer is inactive; an agreement needs an active one",
}

/** A Customer an agreement names, in either field: active, or the sentence for that field. Nothing named is nothing to gate. */
export function refuseInactiveCustomer(status: CustomerStatus | undefined, path: Party): void {
  if (status === undefined || status === "active") return
  throw problem(409, { detail: INACTIVE_PARTY[path] })
}

/** What a body naming a product that is not offered is told: the status it has, and what the reference needs. Read by the descriptions that quote it, so the document says what the route says. */
export const unofferedProduct = (status: Exclude<ProductStatus, "active">): string => `The product is ${status}; only an active product can be subscribed to`

/** A Product a subscription names: offered, or the sentence naming the status it has instead. */
export function refuseUnofferedProduct(status: ProductStatus | undefined): void {
  if (status === undefined || status === "active") return
  throw problem(409, { detail: unofferedProduct(status) })
}

// Resources, round B: the fleet. An allocation's `vehicleId`, `trailerId` and
// `driverId`, a collection group's `vehicleId` and `driverId` — on a create,
// on a patch that moves the field, and on the scheme create's groups — are
// held here; a group whose vehicle later retires is not refused on an
// unrelated patch, and a note-only change to an allocation asks nothing of
// its vehicle. Each refusal is a 409 naming the row as a person does, the
// status it carries and what the reference needs, like every status gate
// (#79, and PR #94 for the Registry): the id is right and the row is there,
// so it is not the 400 a missing id or a wrong kind earns, and what refuses
// is the state the row is in, which no better body mends. It runs after
// every 400 a body can earn — existence, kind, shape, period, the licence —
// and before any other 409, so the caller hears what to fix in the body
// before what to fix in the fleet; the doors keep that order
// (`holdReservation` in routes/vehicle-allocations.ts, `requireFleetInService`
// in routes/scheme-groups.ts). The other half of the rule is the fleet's own:
// a vehicle is not retired, and a driver not set inactive or suspended, while
// a live allocation or a collection group of a scheme in force still names
// them (routes/vehicles.ts, routes/drivers.ts, counting through
// `refuseStranded` with the pieces below).

/** Who names a fleet row afresh, as its sentence says what it needs: "an allocation needs a vehicle in service", "a collection group needs an active driver", "a route needs a trailer in service" (Execution's Planned Assignment, Issue #104). */
export type FleetReference = "an allocation" | "a collection group" | "a route"

/** What a body naming a retired vehicle is told — as the vehicle, or as an allocation's trailer: "WH-99 is retired; an allocation needs a vehicle in service", "WH-T99 is retired; an allocation needs a trailer in service". */
export const isRetired = (label: string, by: FleetReference, as: "vehicle" | "trailer" = "vehicle"): string => `${label} is retired; ${by} needs a ${as} in service`

/** A vehicle named afresh is not retired; `unavailable` and `maintenance` pass, since a vehicle in the workshop today is planned with for next month. A 409, after every 400. */
export function refuseRetiredVehicle(status: VehicleStatus, label: string, by: FleetReference, as: "vehicle" | "trailer" = "vehicle"): void {
  if (status !== "retired") return
  throw problem(409, { detail: isRetired(label, by, as) })
}

/** What a body naming a driver who is not active is told, the status spelled since the two are corrected differently: "Karen Holt is inactive; an allocation needs an active driver", "Peter Lund is suspended; a collection group needs an active driver". */
export const isUnavailable = (name: string, status: Exclude<DriverStatus, "active">, by: FleetReference): string => `${name} is ${status}; ${by} needs an active driver`

/** A driver named afresh is active: an inactive or a suspended one is refused naming the status. A 409, after every 400. */
export function refuseUnavailableDriver(status: DriverStatus, name: string, by: FleetReference): void {
  if (status === "active") return
  throw problem(409, { detail: isUnavailable(name, status, by) })
}

/** The allocation statuses that reserve: `released` reserves nothing, and the exclusion constraints ignore it the same way. */
export const LIVE_ALLOCATION_STATUSES = ["planned", "confirmed"] as const satisfies readonly AllocationStatus[]

/**
 * The live allocations still naming a row — `naming` says how: as the vehicle
 * or as the trailer, or as the driver — not yet over on the database's clock.
 * `company_id` and the row's id and never `inProjects`: the row was read under
 * the caller's scope and an allocation's project is the row's by the composite
 * key, and a count that refuses a write must not be the one statement that
 * could miss a row.
 */
export const liveAllocationsNaming = (companyId: string, naming: SQL | undefined): SQL | undefined =>
  and(eq(vehicleAllocation.companyId, companyId), naming, inArray(vehicleAllocation.status, [...LIVE_ALLOCATION_STATUSES]), gt(vehicleAllocation.plannedTo, sql`now()`))

/** What taking a row out of service under live allocations is refused with: "2 live allocations name this vehicle; release them first". */
export const liveAllocationsName =
  (what: "vehicle" | "driver") =>
  (rows: number): string =>
    `${count(rows, "live allocation")} ${rows === 1 ? "names" : "name"} this ${what}; release ${rows === 1 ? "it" : "them"} first`

/** The same under the collection groups of schemes in force today: "1 collection group names this driver; reassign it first". */
export const groupsName =
  (what: "vehicle" | "driver") =>
  (rows: number): string =>
    `${count(rows, "collection group")} ${rows === 1 ? "names" : "name"} this ${what}; reassign ${rows === 1 ? "it" : "them"} first`

// Pickup Exceptions (M5 of #293): a retired contaminant code tags nothing new
// and is named by no new rule, and a rule's step charges a product that is
// offered. A stop tagged before the code was retired keeps its tag, and a
// rule written before a product was withdrawn keeps its step.

/** What naming a retired contaminant code is told, by what names it. */
export const retiredCode = (code: string, by: "a tag" | "a rule"): string => `The contaminant code ${code} is retired; ${by} names an active one`

/** A contaminant code a new tag or rule names: active, or the sentence. */
export function refuseRetiredCode(status: ContaminantCodeStatus, code: string, by: "a tag" | "a rule"): void {
  if (status === "active") return
  throw problem(409, { detail: retiredCode(code, by) })
}

/** What a ticket or a project's default naming a retired team is told (O30 of #290, row 7.20). */
export const retiredTeam = (name: string): string => `The team ${JSON.stringify(name)} is retired; a ticket waits with an active team`

/** A Team a new ticket, a patch moving a ticket's team, or a project's default names: active, or the sentence. */
export function refuseRetiredTeam(status: TeamStatus, name: string): void {
  if (status === "active") return
  throw problem(409, { detail: retiredTeam(name) })
}

/** What a new ticket or a patch naming a retired Ticket Type is told (#545 of #544). */
export const retiredTicketType = (name: string): string => `The ticket type ${JSON.stringify(name)} is retired; a ticket is of an active type`

/** A Ticket Type a new ticket or a patch moving a ticket's type names: active, or the sentence. The type a ticket already is of is kept whatever its status. */
export function refuseRetiredTicketType(status: TicketTypeStatus, name: string): void {
  if (status === "active") return
  throw problem(409, { detail: retiredTicketType(name) })
}

/** What a rule's step naming a product that is not offered is told. */
export const unofferedStep = (position: number, status: Exclude<ProductStatus, "active">): string => `The product on step ${position} is ${status}; a rule charges an active product`
