// The work orders that move a container through the ledger (O3b of #290): a
// delivery issues it into service, a removal returns it to a warehouse, a
// swap does both; what each books beside its container; which container a
// planned stop holds back from another booking; and the ticket a movement the
// ledger refused opens, the driver's completion standing.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BOOKED_WITH, isLedgerService, LEDGER_SERVICES, LEDGER_STEPS, ledgerMovedThenCorrected, ledgerNotRecorded, reservedContainerOf, takenContainerOf } from "../work-orders"
import { OFFICE_STOP_SERVICES, PICKUP_SERVICES } from "../vocabulary"

describe("the ledger's work orders", () => {
  test("are the delivery, the removal and the swap; the office books every service", () => {
    assert.deepEqual([...LEDGER_SERVICES], ["deliver", "remove", "swap"])
    assert.deepEqual([...OFFICE_STOP_SERVICES], [...PICKUP_SERVICES])
    assert.deepEqual(PICKUP_SERVICES.filter(isLedgerService), ["deliver", "remove", "swap"])
  })

  test("a delivery books its subscription, a removal its warehouse, a swap the replacement and the warehouse; nothing else books either", () => {
    assert.deepEqual(BOOKED_WITH, { empty: [], deliver: ["subscriptionId"], remove: ["warehouseId"], swap: ["replacementContainerId", "warehouseId"], repair: [], wash: [], bulky: [] })
  })

  test("a completed delivery issues, a removal returns, a swap returns the container taken and issues its replacement, in that order", () => {
    assert.deepEqual(LEDGER_STEPS, { deliver: ["issue"], remove: ["return"], swap: ["return", "issue"] })
  })
})

describe("what a planned stop holds back", () => {
  const stop = { containerId: "bin-1", replacementContainerId: null, status: "planned" as const }

  test("a delivery its container, a swap its replacement, while planned", () => {
    assert.equal(reservedContainerOf({ ...stop, service: "deliver" }), "bin-1")
    assert.equal(reservedContainerOf({ ...stop, service: "swap", replacementContainerId: "bin-7" }), "bin-7")
  })

  test("nothing once done, skipped or failed, and nothing for any other service", () => {
    for (const status of ["completed", "skipped", "failed"] as const) assert.equal(reservedContainerOf({ ...stop, service: "deliver", status }), null, status)
    for (const service of ["empty", "remove", "repair", "wash"] as const) assert.equal(reservedContainerOf({ ...stop, service }), null, service)
  })

  test("a removal and a swap the container they take away, while planned; nothing else takes one", () => {
    assert.equal(takenContainerOf({ ...stop, service: "remove" }), "bin-1")
    assert.equal(takenContainerOf({ ...stop, service: "swap" }), "bin-1")
    for (const status of ["completed", "skipped", "failed"] as const) assert.equal(takenContainerOf({ ...stop, service: "remove", status }), null, status)
    for (const service of ["empty", "deliver", "repair", "wash"] as const) assert.equal(takenContainerOf({ ...stop, service }), null, service)
  })
})

describe("a movement the ledger refused", () => {
  test("opens a high internal task naming the work, where and when it was done, and the ledger's own sentence", () => {
    assert.deepEqual(
      ledgerNotRecorded({ service: "deliver", containerLabel: "BIN-7", replacementLabel: null, address: "Parkvej 18", by: "driver", completedAt: "10:12", sentence: "BIN-7 is in service at Havnegade 3; return it first" }),
      {
        kind: "internal-task",
        priority: "high",
        subject: "Delivery of BIN-7 to Parkvej 18 not recorded",
        description: "The driver completed the stop at 10:12, but the ledger refused the delivery: BIN-7 is in service at Havnegade 3; return it first. Record it through the container's commands.",
      },
    )
  })

  test("names a removal and a swap by their containers, and a stop with no address by its work alone", () => {
    assert.equal(ledgerNotRecorded({ service: "remove", containerLabel: "BIN-1", replacementLabel: null, address: null, by: "driver", completedAt: "10:12", sentence: "x" }).subject, "Removal of BIN-1 not recorded")
    const swap = ledgerNotRecorded({ service: "swap", containerLabel: "BIN-1", replacementLabel: "BIN-7", address: "Parkvej 18", by: "driver", completedAt: "10:12", sentence: "BIN-7 is in service at Havnegade 3" })
    assert.equal(swap.subject, "Swap of BIN-1 for BIN-7 at Parkvej 18 not recorded")
    assert.match(swap.description, /refused the swap: BIN-7 is in service at Havnegade 3\. Record it/)
  })
})

describe("a ledger work order the office corrects", () => {
  test("to completed, the ledger refusing: the task says the office's correction completed it", () => {
    const task = ledgerNotRecorded({ service: "remove", containerLabel: "BIN-1", replacementLabel: null, address: "Parkvej 18", by: "office", completedAt: "14:05", sentence: "Container BIN-1 is not in service" })
    assert.equal(task.description, "The office corrected the stop to completed at 14:05, but the ledger refused the removal: Container BIN-1 is not in service. Record it through the container's commands.")
  })

  test("away from completed: a high internal task says the ledger moved the containers, for the office to put back if the work did not happen", () => {
    assert.deepEqual(ledgerMovedThenCorrected({ service: "swap", containerLabel: "BIN-1", replacementLabel: "BIN-7", address: "Parkvej 18", outcome: "failed", correctedAt: "14:05" }), {
      kind: "internal-task",
      priority: "high",
      subject: "Swap of BIN-1 for BIN-7 at Parkvej 18 recorded, stop now failed",
      description: "The ledger recorded the swap when the stop was completed; the office corrected the stop to failed at 14:05. If the swap did not happen, put the containers back through their commands.",
    })
  })
})
