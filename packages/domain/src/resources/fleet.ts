// What a vehicle, a driver and a vehicle type hold to beside their lists
// (Issue #101): a powered vehicle carries a compartment, its compartments are
// few and each carries a set of fractions, a driver a service provider
// employs names the provider and no other does, and a vehicle type's
// container types are a set.
//
// And a vehicle, a trailer or a driver named afresh (Issue #101, round B) —
// an allocation's, a collection group's, a route's planned assignment — is in
// a state to be planned with (`../status-gates`): a vehicle not retired, since
// one in the workshop today is planned with for next month, and a driver
// active. Each refusal names the row as a person does, the status it carries
// and what the reference needs. A group whose vehicle later retires is not
// refused on an unrelated patch, and a note-only change to an allocation asks
// nothing of its vehicle. The other half of the rule is the fleet's own: a
// vehicle is not retired, and a driver not set inactive or suspended, while a
// live allocation or a collection group of a scheme in force still names them.
import { count } from "../text"
import { eachOnceSentence } from "../requests"
import { refuseUnless } from "../status-gates"
import { ACTIVE_DRIVER_STATUSES, PLANNABLE_VEHICLE_STATUSES, type DriverStatus, type VehicleStatus } from "./vocabulary"

/** The most compartments a body may give a vehicle: a body, a left and a right is three, and twenty is room for anything with wheels. */
export const COMPARTMENTS_MAX = 20

export const COMPARTMENT_FRACTIONS_MAX = 200

/** What a powered vehicle without a compartment is told, at the list. */
export const A_POWERED_VEHICLE_HAS_A_COMPARTMENT = "A powered vehicle has at least one compartment"

/** A trailer may carry no compartment; a powered vehicle carries one or more. */
export const poweredVehicleHasACompartment = (kind: string, compartments: readonly unknown[]): boolean => kind !== "powered-vehicle" || compartments.length > 0

/** What a driver body whose employment and provider disagree is told, at the provider: the same rule as a place's ownership (./places), in the driver's words. */
export const PROVIDER_WITH_PROVIDER_EMPLOYMENT = "Name the employing service provider with service-provider employment, and none otherwise"

/** What a vehicle type's set naming a container type twice is told. */
export const EACH_CONTAINER_TYPE_ONCE = eachOnceSentence("container type")

/** Who names a fleet row afresh, as its sentence says what it needs: "an allocation needs a vehicle in service", "a collection group needs an active driver", "a route needs a trailer in service" (Execution's Planned Assignment, Issue #104). */
export type FleetReference = "an allocation" | "a collection group" | "a route"

/** What a body naming a retired vehicle is told — as the vehicle, or as an allocation's trailer: "WH-99 is retired; an allocation needs a vehicle in service", "WH-T99 is retired; an allocation needs a trailer in service". */
export const isRetired = (label: string, by: FleetReference, as: "vehicle" | "trailer" = "vehicle"): string => `${label} is retired; ${by} needs a ${as} in service`

/** A vehicle named afresh is not retired; `unavailable` and `maintenance` pass. A conflict, after every invalid value. */
export function refuseRetiredVehicle(status: VehicleStatus, label: string, by: FleetReference, as: "vehicle" | "trailer" = "vehicle"): void {
  refuseUnless(status, PLANNABLE_VEHICLE_STATUSES, isRetired(label, by, as))
}

/** What a body naming a driver who is not active is told, the status spelled since the two are corrected differently: "Karen Holt is inactive; an allocation needs an active driver", "Peter Lund is suspended; a collection group needs an active driver". */
export const isUnavailable = (name: string, status: Exclude<DriverStatus, "active">, by: FleetReference): string => `${name} is ${status}; ${by} needs an active driver`

/** A driver named afresh is active: an inactive or a suspended one is refused naming the status. A conflict, after every invalid value. */
export function refuseUnavailableDriver(status: DriverStatus, name: string, by: FleetReference): void {
  refuseUnless(status, ACTIVE_DRIVER_STATUSES, (other) => isUnavailable(name, other, by))
}

/** What taking a row out of service under the collection groups of schemes in force today is refused with: "1 collection group names this driver; reassign it first". */
export const groupsName =
  (what: "vehicle" | "driver") =>
  (rows: number): string =>
    `${count(rows, "collection group")} ${rows === 1 ? "names" : "name"} this ${what}; reassign ${rows === 1 ? "it" : "them"} first`
