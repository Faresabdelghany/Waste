// Whether a vehicle fits the work it is given (O7 of #290). A vehicle carries
// the fractions its compartments name — the glossary's "one or more
// compartments, each with a capacity for one or more waste fractions" — and a
// vehicle whose compartments name none carries any, the reading the Balance
// day's `canTake` was first to make (routing/balance.ts reads it from here).
// Its type lifts the container types the company's compatibility set pairs it
// with (`container_type_vehicle_type`), the set generation's matcher reads;
// a type the set names nothing for lifts any.
//
// How much of a fraction it takes on one trip is the capacity of the
// compartments carrying it, never above the vehicle's payload; where a
// compartment carrying it states no capacity, the vehicle's payload is all
// that is known. A route heavier than one trip is not refused for it: since
// O15 its Plan unloads on the way, and the route read's `overCapacityKg` says
// how far over one payload it runs. What no trip can carry is a single stop
// heavier than that — a container whose expected load is more than the
// compartment it goes into holds — and that is the refusal.
//
// `firstMisfit` judges a vehicle against the stops it would serve in a fixed
// order — a fraction it has no compartment for, a container it cannot lift,
// a stop too heavy for one trip — and answers the first, counting the stops
// alike, so a command refuses with one sentence. Pure: ids and kilograms in,
// a reading out; the caller reads the rows and spells the names.

/** A compartment as the rules read it: its capacity, null where unsaid, and the fractions it carries. */
export type FitCompartment = { capacityKg: number | null; wasteFractionIds: readonly string[] }

/** A vehicle as the rules read it. */
export type FitVehicle = {
  /** Its payload, null where unsaid. */
  capacityKg: number | null
  compartments: readonly FitCompartment[]
  /** The container types its type lifts; null where its type names none, so it lifts any. */
  liftsContainerTypeIds: readonly string[] | null
}

/** A stop as the rules read it: what it collects, what it is expected to weigh on the truck (null unknown, 0 for nothing), and its container's type (null for none). */
export type FitStop = { wasteFractionId: string; kg: number | null; containerTypeId: string | null }

/** Why a vehicle cannot serve some of the stops, the first rule broken, with how many stops it holds for. */
export type Misfit =
  | { kind: "fraction"; wasteFractionId: string; stops: number }
  | { kind: "container-type"; containerTypeId: string; stops: number }
  | { kind: "too-heavy"; wasteFractionId: string; kg: number; payloadKg: number; stops: number }

/** The fractions the compartments carry, each once in the order written; null where none names one, which carries any. */
export function fractionsCarried(compartments: readonly Pick<FitCompartment, "wasteFractionIds">[]): string[] | null {
  const fractions = [...new Set(compartments.flatMap((compartment) => compartment.wasteFractionIds))]
  return fractions.length === 0 ? null : fractions
}

/** Whether a vehicle carrying `fractions` (null: any) carries the fraction. */
export const carriesFraction = (fractions: readonly string[] | null, wasteFractionId: string): boolean => fractions === null || fractions.includes(wasteFractionId)

/** The kilograms of the fraction the vehicle takes on one trip — of any, without one — or null where nothing says. */
export function payloadFor(vehicle: Pick<FitVehicle, "capacityKg" | "compartments">, wasteFractionId: string | null): number | null {
  const anything = fractionsCarried(vehicle.compartments) === null
  const carrying = vehicle.compartments.filter((compartment) => wasteFractionId === null || anything || compartment.wasteFractionIds.includes(wasteFractionId))
  const stated = carrying.length > 0 && carrying.every((compartment) => compartment.capacityKg !== null)
  const chambers = stated ? carrying.reduce((sum, compartment) => sum + (compartment.capacityKg as number), 0) : null
  if (chambers === null) return vehicle.capacityKg
  return vehicle.capacityKg === null ? chambers : Math.min(chambers, vehicle.capacityKg)
}

/** The first rule the vehicle breaks over the stops — a fraction it has no compartment for, a container it cannot lift, a stop heavier than one trip of its fraction — or undefined where it serves them all. */
export function firstMisfit(vehicle: FitVehicle, stops: readonly FitStop[]): Misfit | undefined {
  const fractions = fractionsCarried(vehicle.compartments)
  const uncarried = stops.find((stop) => !carriesFraction(fractions, stop.wasteFractionId))
  if (uncarried !== undefined) return { kind: "fraction", wasteFractionId: uncarried.wasteFractionId, stops: stops.filter((stop) => stop.wasteFractionId === uncarried.wasteFractionId).length }

  const lifts = vehicle.liftsContainerTypeIds
  const unlifted = lifts === null ? undefined : stops.find((stop) => stop.containerTypeId !== null && !lifts.includes(stop.containerTypeId))
  if (unlifted !== undefined) return { kind: "container-type", containerTypeId: unlifted.containerTypeId as string, stops: stops.filter((stop) => stop.containerTypeId === unlifted.containerTypeId).length }

  for (const stop of stops) {
    const payloadKg = payloadFor(vehicle, stop.wasteFractionId)
    if (payloadKg === null || stop.kg === null || stop.kg <= payloadKg) continue
    const heavy = stops.filter((other) => other.wasteFractionId === stop.wasteFractionId && other.kg !== null && other.kg > payloadKg)
    return { kind: "too-heavy", wasteFractionId: stop.wasteFractionId, kg: Math.max(...heavy.map((other) => other.kg as number)), payloadKg, stops: heavy.length }
  }
  return undefined
}

/** The names a misfit's sentence spells: the vehicle's label, the fraction's or the container type's name, and whose stops they are (`route RC-1042`), absent for the stops a command names itself. */
export type MisfitNames = { vehicle: string; fraction?: string; containerType?: string; of?: string }

const someStops = (stops: number, of: string | undefined): string => {
  if (of === undefined) return stops === 1 ? "the stop" : `${stops} of the stops`
  return stops === 1 ? `a stop of ${of}` : `${stops} stops of ${of}`
}

/** "WH-24 has no compartment for Glass, which 3 stops of route RC-1042 collect". */
export function misfitSentence(misfit: Misfit, names: MisfitNames): string {
  const one = misfit.stops === 1
  switch (misfit.kind) {
    case "fraction":
      return `${noCompartmentFor(names.vehicle, names.fraction ?? misfit.wasteFractionId)}, which ${someStops(misfit.stops, names.of)} ${one ? "collects" : "collect"}`
    case "container-type":
      return `${names.vehicle} cannot lift a ${names.containerType ?? misfit.containerTypeId}, which ${someStops(misfit.stops, names.of)} ${one ? "empties" : "empty"}`
    case "too-heavy":
      return `${names.vehicle} takes ${misfit.payloadKg} kg of ${names.fraction ?? misfit.wasteFractionId} on one trip, and ${someStops(misfit.stops, names.of)} ${one ? `is expected to weigh ${misfit.kg} kg` : `are expected to weigh up to ${misfit.kg} kg each`}`
  }
}

/** "WH-24 has no compartment for Glass": an allocation's fraction the vehicle does not carry. */
export const noCompartmentFor = (vehicle: string, fraction: string): string => `${vehicle} has no compartment for ${fraction}`

/** An allocation's required capacity above what the vehicle takes on one trip — of its fraction where it names one. */
export const allocationOverPayload = (vehicle: string, payloadKg: number, requiredKg: number, fraction: string | null): string =>
  fraction === null ? `${vehicle}'s payload is ${payloadKg} kg, less than the ${requiredKg} kg required` : `${vehicle} takes ${payloadKg} kg of ${fraction} on one trip, less than the ${requiredKg} kg required`
