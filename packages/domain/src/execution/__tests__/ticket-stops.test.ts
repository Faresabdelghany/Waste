// A ticket the office answers with a stop (O3c of #290): which services
// answer which kind, how the stop is held to what the ticket is about, and
// what the ticket is told as its stop is done, missed or corrected.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { TICKET_KINDS } from "../../resolution/vocabulary"
import { answeredAlready, bookedFor, correctedAway, isStopTicketKind, notAnsweredBy, onlyAnOpenTicket, servedAfterClose, servicedBy, servicesAnswering, stopCorrected, stopMismatch, stopMissed } from "../ticket-stops"

const stop = { position: 4, route: "RC-1042" }

describe("the tickets a stop answers", () => {
  test("a container request by a delivery, an overflow by an emptying, a defective container by a repair or a swap; no other kind", () => {
    assert.deepEqual(TICKET_KINDS.filter(isStopTicketKind), ["overflow", "container-request", "container-defect"])
    assert.deepEqual(servicesAnswering("container-request"), ["deliver"])
    assert.deepEqual(servicesAnswering("overflow"), ["empty"])
    assert.deepEqual(servicesAnswering("container-defect"), ["repair", "swap"])
    assert.deepEqual(servicesAnswering("missed-collection"), [])
  })

  test("a stop of another service, or for a ticket no stop answers, is told what would answer it", () => {
    assert.equal(notAnsweredBy("container-request", "swap"), "A container request is answered by a delivery, not a swap")
    assert.equal(notAnsweredBy("container-defect", "deliver"), "A container defect is answered by a repair or a swap, not a delivery")
    assert.equal(notAnsweredBy("overflow", "wash"), "An overflow is answered by an emptying, not a wash")
    assert.equal(notAnsweredBy("complaint", "empty"), "A complaint is not answered by a stop")
  })
})

describe("a stop held to what its ticket is about", () => {
  const at = { containerId: null, propertyId: null, sharedCollectionPointId: null }

  test("a ticket naming nothing takes any stop", () => {
    assert.equal(stopMismatch(at, { service: "empty", containerId: "bin-1", propertyId: "parkvej", sharedCollectionPointId: null }), undefined)
  })

  test("a ticket's container is the stop's, but for a delivery, which brings another", () => {
    const ticket = { ...at, containerId: "bin-1", propertyId: "parkvej" }
    assert.deepEqual(stopMismatch(ticket, { service: "repair", containerId: "bin-2", propertyId: "parkvej", sharedCollectionPointId: null }), { path: "containerId", message: "Name the container the ticket is about" })
    assert.equal(stopMismatch(ticket, { service: "swap", containerId: "bin-1", propertyId: "parkvej", sharedCollectionPointId: null }), undefined)
    assert.equal(stopMismatch(ticket, { service: "deliver", containerId: "bin-9", propertyId: "parkvej", sharedCollectionPointId: null }), undefined)
  })

  test("a ticket's place is the stop's: a delivery's by its subscription, a container's by its placement, an address-only stop's by its own", () => {
    const ticket = { ...at, propertyId: "parkvej" }
    const elsewhere = { containerId: "bin-9", propertyId: "havnegade", sharedCollectionPointId: null }
    assert.deepEqual(stopMismatch(ticket, { ...elsewhere, service: "deliver" }), { path: "subscriptionId", message: "Name a subscription at the ticket's place" })
    assert.deepEqual(stopMismatch(ticket, { ...elsewhere, service: "empty" }), { path: "containerId", message: "Name a container at the ticket's place" })
    assert.deepEqual(stopMismatch(ticket, { ...elsewhere, containerId: null, service: "empty" }), { path: "propertyId", message: "Collect at the ticket's place" })
    const atAPoint = { ...at, sharedCollectionPointId: "point-1" }
    assert.deepEqual(stopMismatch(atAPoint, { containerId: null, propertyId: null, sharedCollectionPointId: "point-2", service: "empty" }), { path: "sharedCollectionPointId", message: "Collect at the ticket's place" })
    assert.equal(stopMismatch(atAPoint, { containerId: null, propertyId: null, sharedCollectionPointId: "point-1", service: "empty" }), undefined)
  })
})

describe("booking the stop", () => {
  test("the ticket is told which stop answers it, and a second booking while that stop is planned is refused naming it", () => {
    assert.equal(bookedFor({ ...stop, service: "deliver" }), "Booked stop 4 of route RC-1042: a delivery")
    assert.equal(answeredAlready("T-8831", stop), "Ticket T-8831 is answered by stop 4 of route RC-1042 already; take that stop off first")
  })

  test("a closed ticket is answered by no stop", () => {
    assert.equal(onlyAnOpenTicket("T-8831", "completed"), "Ticket T-8831 is completed; a stop answers an open ticket")
  })
})

describe("what the ticket is told", () => {
  test("its stop done: serviced by it, or, closed already, that it was done after", () => {
    assert.equal(servicedBy(stop), "Serviced by stop 4 of route RC-1042")
    assert.equal(servedAfterClose({ ...stop, service: "deliver" }), "The delivery at stop 4 of route RC-1042 was completed after this ticket closed")
  })

  test("its stop missed: what happened and why, for the office to book another", () => {
    assert.equal(stopMissed({ ...stop, service: "deliver", outcome: "failed", reason: "inaccessible", open: true }), "The delivery at stop 4 of route RC-1042 failed: inaccessible. Book another stop to answer this ticket.")
    assert.equal(stopMissed({ ...stop, service: "empty", outcome: "skipped", reason: "removed-by-dispatcher", open: true }), "The emptying at stop 4 of route RC-1042 was skipped: removed by dispatcher. Book another stop to answer this ticket.")
    assert.equal(stopMissed({ ...stop, service: "deliver", outcome: "skipped", reason: "route-cancelled", open: false }), "The delivery at stop 4 of route RC-1042 was skipped: route cancelled.", "a closed ticket is not told to book another")
  })

  test("its stop corrected away from completed after it serviced the ticket: what the office said, and that reopening is the office's", () => {
    assert.equal(
      correctedAway({ ...stop, service: "swap", outcome: "failed", note: "The gate was locked" }),
      "Stop 4 of route RC-1042 was corrected to failed after it serviced this ticket: The gate was locked. Reopen the ticket if the swap is still owed.",
    )
  })

  test("its stop corrected away from completed when it had not serviced the ticket: the correction alone", () => {
    assert.equal(stopCorrected({ ...stop, outcome: "skipped", note: "Never went" }), "Stop 4 of route RC-1042 was corrected to skipped: Never went.")
  })
})
