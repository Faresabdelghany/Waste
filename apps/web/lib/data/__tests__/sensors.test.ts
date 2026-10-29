// What a Sensor's details offer (O26 of #290): the containers of its project
// to pair with, by label, and what the pairing dialogs open on.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../business-modules"
import { changeDraft, pairableContainers, pairDraft, pairOffered } from "../sensors"

const record = (over: Partial<BusinessRecord>): BusinessRecord => ({ id: "x", name: "x", context: "", status: "Active", owner: "", updatedAt: "", value: "", description: "", facts: {}, related: [], companyId: "c", ...over }) as BusinessRecord

describe("a sensor's details", () => {
  test("offer the containers of the sensor's project alone, by label, in label order", () => {
    const containers = [
      record({ id: "asset-b", name: "b", facts: { "Container ID": "BIN-2" }, projectIds: ["project-a"] }),
      record({ id: "asset-a", name: "a", facts: { "Container ID": "BIN-1" }, projectIds: ["project-a"] }),
      record({ id: "asset-c", name: "c", facts: { "Container ID": "BIN-0" }, projectIds: ["project-b"] }),
    ]
    assert.deepEqual(pairableContainers(containers, "project-a"), [
      { value: "asset-a", label: "BIN-1" },
      { value: "asset-b", label: "BIN-2" },
    ])
    assert.deepEqual(pairableContainers(containers, undefined), [])
  })

  test("open Pair on today and the default threshold, and Change pairing on the pairing in force", () => {
    assert.deepEqual(pairDraft("2026-10-29"), { containerId: "", validFrom: "2026-10-29", fullThresholdPercent: "85", booksEmptying: false })
    const paired = record({ submittedValues: { pairingId: "p", fullThresholdPercent: "90", booksEmptying: true, lastDayIn: "2026-11-30" } })
    assert.deepEqual(changeDraft(paired), { fullThresholdPercent: "90", booksEmptying: true, lastDayIn: "2026-11-30" })
    assert.equal(pairOffered(paired), false, "a sensor measuring a container is changed, not paired again")
    assert.equal(pairOffered(record({ submittedValues: { pairingId: "" } })), true)
    assert.equal(pairOffered(record({ status: "Retired", submittedValues: { pairingId: "" } })), false)
  })
})
