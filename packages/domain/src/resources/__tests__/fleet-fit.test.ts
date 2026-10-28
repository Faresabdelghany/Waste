// Fleet rules on the server (O7 of #290): what a vehicle carries by its
// compartments, how much of a fraction it takes on one trip, and the first
// stop it cannot serve — the one rule `assign`, the stop moves, an
// allocation and the Balance day's `canTake` all read.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  allocationOverPayload,
  carriesFraction,
  firstMisfit,
  fractionsCarried,
  misfitSentence,
  noCompartmentFor,
  payloadFor,
  type FitStop,
  type FitVehicle,
} from "../fleet-fit"

const glass = "fraction-glass"
const paper = "fraction-paper"
const food = "fraction-food"

const twoChambers: FitVehicle = {
  capacityKg: 12_000,
  compartments: [
    { capacityKg: 5_000, wasteFractionIds: [paper] },
    { capacityKg: 3_000, wasteFractionIds: [glass, food] },
  ],
  liftsContainerTypeIds: ["bin-240", "bin-660"],
}

const stop = (wasteFractionId: string, kg: number | null = 20, containerTypeId: string | null = "bin-240"): FitStop => ({ wasteFractionId, kg, containerTypeId })

describe("what a vehicle carries", () => {
  test("is the union of its compartments' fractions, each once in the order written", () => {
    assert.deepEqual(fractionsCarried(twoChambers.compartments), [paper, glass, food])
  })

  test("is anything where no compartment names a fraction, as the Balance day reads a vehicle", () => {
    assert.equal(fractionsCarried([]), null)
    assert.equal(fractionsCarried([{ wasteFractionIds: [] }]), null)
    assert.equal(carriesFraction(null, glass), true)
    assert.equal(carriesFraction([paper], glass), false)
    assert.equal(carriesFraction([paper, glass], glass), true)
  })
})

describe("how much of a fraction a vehicle takes on one trip", () => {
  test("is the capacity of the compartments carrying it, never above the vehicle's payload", () => {
    assert.equal(payloadFor(twoChambers, glass), 3_000)
    assert.equal(payloadFor(twoChambers, paper), 5_000)
    assert.equal(payloadFor({ ...twoChambers, capacityKg: 4_000 }, paper), 4_000)
  })

  test("is the vehicle's payload where a compartment carrying it states no capacity, or where nothing names fractions", () => {
    const unsaid: FitVehicle = { capacityKg: 9_000, compartments: [{ capacityKg: null, wasteFractionIds: [glass] }, { capacityKg: 2_000, wasteFractionIds: [glass] }], liftsContainerTypeIds: null }
    assert.equal(payloadFor(unsaid, glass), 9_000)
    const anything: FitVehicle = { capacityKg: 9_000, compartments: [{ capacityKg: 2_000, wasteFractionIds: [] }, { capacityKg: 3_000, wasteFractionIds: [] }], liftsContainerTypeIds: null }
    assert.equal(payloadFor(anything, glass), 5_000, "every compartment carries it")
  })

  test("is every compartment's without a fraction, and unknown where nothing says one", () => {
    assert.equal(payloadFor(twoChambers, null), 8_000, "the compartments hold less than the payload")
    assert.equal(payloadFor({ ...twoChambers, compartments: [] }, null), 12_000)
    assert.equal(payloadFor({ capacityKg: null, compartments: [{ capacityKg: 2_000, wasteFractionIds: [glass] }, { capacityKg: 3_000, wasteFractionIds: [paper] }] }, null), 5_000)
    assert.equal(payloadFor({ capacityKg: null, compartments: [{ capacityKg: null, wasteFractionIds: [glass] }] }, glass), null)
  })
})

describe("the first stop a vehicle cannot serve", () => {
  test("is nothing where it carries every fraction, lifts every container and takes every stop on one trip", () => {
    assert.equal(firstMisfit(twoChambers, [stop(glass), stop(paper, 400, "bin-660"), stop(food, null, null)]), undefined)
  })

  test("is a fraction it has no compartment for, counting the stops of it, before anything else", () => {
    assert.deepEqual(firstMisfit({ ...twoChambers, liftsContainerTypeIds: [] }, [stop(paper), stop("fraction-metal"), stop("fraction-metal")]), { kind: "fraction", wasteFractionId: "fraction-metal", stops: 2 })
  })

  test("is a container its type does not lift, where its type names the containers it lifts", () => {
    assert.deepEqual(firstMisfit(twoChambers, [stop(glass, 20, "bin-1100"), stop(paper, 20, "bin-1100")]), { kind: "container-type", containerTypeId: "bin-1100", stops: 2 })
    assert.equal(firstMisfit({ ...twoChambers, liftsContainerTypeIds: null }, [stop(glass, 20, "bin-1100")]), undefined, "a type naming none lifts any")
  })

  test("is a stop heavier than one trip can take of its fraction, the heaviest said: a route over its payload is not, since its Plan unloads on the way", () => {
    assert.equal(firstMisfit(twoChambers, [stop(glass, 2_500), stop(glass, 2_500), stop(glass, 2_500)]), undefined)
    assert.deepEqual(firstMisfit(twoChambers, [stop(glass, 3_200), stop(glass, 3_600), stop(paper, 4_000)]), { kind: "too-heavy", wasteFractionId: glass, kg: 3_600, payloadKg: 3_000, stops: 2 })
  })
})

describe("the sentences", () => {
  const names = { vehicle: "WH-24", fraction: "Glass", containerType: "1100 L bin", of: "route RC-1042" }

  test("name the vehicle, what it cannot take and the stops that need it", () => {
    assert.equal(misfitSentence({ kind: "fraction", wasteFractionId: glass, stops: 1 }, names), "WH-24 has no compartment for Glass, which a stop of route RC-1042 collects")
    assert.equal(misfitSentence({ kind: "fraction", wasteFractionId: glass, stops: 3 }, names), "WH-24 has no compartment for Glass, which 3 stops of route RC-1042 collect")
    assert.equal(misfitSentence({ kind: "container-type", containerTypeId: "bin-1100", stops: 2 }, names), "WH-24 cannot lift a 1100 L bin, which 2 stops of route RC-1042 empty")
    assert.equal(
      misfitSentence({ kind: "too-heavy", wasteFractionId: glass, kg: 3_600, payloadKg: 3_000, stops: 2 }, names),
      "WH-24 takes 3000 kg of Glass on one trip, and 2 stops of route RC-1042 are expected to weigh up to 3600 kg each",
    )
    assert.equal(misfitSentence({ kind: "fraction", wasteFractionId: glass, stops: 1 }, { ...names, of: undefined }), "WH-24 has no compartment for Glass, which the stop collects")
    assert.equal(misfitSentence({ kind: "container-type", containerTypeId: "bin-1100", stops: 2 }, { ...names, of: undefined }), "WH-24 cannot lift a 1100 L bin, which 2 of the stops empty")
    assert.equal(misfitSentence({ kind: "too-heavy", wasteFractionId: glass, kg: 3_600, payloadKg: 3_000, stops: 1 }, names), "WH-24 takes 3000 kg of Glass on one trip, and a stop of route RC-1042 is expected to weigh 3600 kg")
  })

  test("refuse an allocation the vehicle cannot carry", () => {
    assert.equal(noCompartmentFor("WH-24", "Glass"), "WH-24 has no compartment for Glass")
    assert.equal(allocationOverPayload("WH-24", 3_000, 3_500, "Glass"), "WH-24 takes 3000 kg of Glass on one trip, less than the 3500 kg required")
    assert.equal(allocationOverPayload("WH-24", 12_000, 13_000, null), "WH-24's payload is 12000 kg, less than the 13000 kg required")
  })
})
