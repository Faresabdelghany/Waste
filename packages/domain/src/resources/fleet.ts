// What a vehicle, a driver and a vehicle type hold to beside their lists
// (Issue #101): a powered vehicle carries a compartment, its compartments are
// few and each carries a set of fractions, a driver a service provider
// employs names the provider and no other does, and a vehicle type's
// container types are a set.
import { eachOnceSentence } from "../requests"

/** The most compartments a body may give a vehicle: a body, a left and a right is three, and twenty is room for anything with wheels. */
export const COMPARTMENTS_MAX = 20

/** The most fractions a compartment body may name. */
export const COMPARTMENT_FRACTIONS_MAX = 200

/** What a powered vehicle without a compartment is told, at the list. */
export const A_POWERED_VEHICLE_HAS_A_COMPARTMENT = "A powered vehicle has at least one compartment"

/** A trailer may carry no compartment; a powered vehicle carries one or more. */
export const poweredVehicleHasACompartment = (kind: string, compartments: readonly unknown[]): boolean => kind !== "powered-vehicle" || compartments.length > 0

/** What a driver body whose employment and provider disagree is told, at the provider: the same rule as a place's ownership (./places), in the driver's words. */
export const PROVIDER_WITH_PROVIDER_EMPLOYMENT = "Name the employing service provider with service-provider employment, and none otherwise"

/** What a vehicle type's set naming a container type twice is told. */
export const EACH_CONTAINER_TYPE_ONCE = eachOnceSentence("container type")
