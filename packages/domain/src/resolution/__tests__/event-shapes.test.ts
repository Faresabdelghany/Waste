import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { TICKET_EVENT_SHAPES, ticketEventShape, ticketEventShapeIssue, type TicketEventRow } from "../event-shapes"
import { TICKET_EVENT_KINDS, TICKET_STATUSES, TICKET_VISIBILITIES, type TicketEventKind } from "../vocabulary"

/** A row with every column given, on a completed ticket. */
const full: TicketEventRow = { status: "completed", body: "Re-collected on Friday", objectKey: "c/t/e.jpg", visibility: "customer", resolution: "recollected" }

/** The one row of each kind that carries exactly what the kind requires and nothing it forbids, on an open ticket. */
const exemplar = (kind: TicketEventKind): TicketEventRow => {
  const shape = TICKET_EVENT_SHAPES[kind]
  return {
    status: "in-progress",
    body: shape.body === "none" ? null : full.body,
    objectKey: shape.objectKey === "none" ? null : full.objectKey,
    visibility: "internal",
    resolution: null,
  }
}

describe("TICKET_EVENT_SHAPES", () => {
  test("spells the four kinds: what each carries, forbids and who may read it", () => {
    assert.deepEqual(Object.keys(TICKET_EVENT_SHAPES).sort(), [...TICKET_EVENT_KINDS].sort())
    // The first row of every ticket says nothing but its status and assignee.
    assert.deepEqual(TICKET_EVENT_SHAPES.created, { body: "none", objectKey: "none", visibility: "internal", resolution: "none" })
    // An assignment may carry the command's note.
    assert.deepEqual(TICKET_EVENT_SHAPES.assigned, { body: "any", objectKey: "none", visibility: "internal", resolution: "none" })
    // A status change may carry the note or the reason, and a resolution exactly when it completed the ticket.
    assert.deepEqual(TICKET_EVENT_SHAPES["status-changed"], { body: "any", objectKey: "none", visibility: "internal", resolution: "with-completed" })
    // A comment says something, may attach something, may be the customer's to read, and changes nothing of the case.
    assert.deepEqual(TICKET_EVENT_SHAPES.comment, { body: "required", objectKey: "any", visibility: "any", resolution: "none" })
    for (const kind of TICKET_EVENT_KINDS) {
      assert.equal(TICKET_EVENT_SHAPES[kind].objectKey !== "none", kind === "comment", `only a comment carries an attachment: ${kind}`)
      assert.equal(TICKET_EVENT_SHAPES[kind].visibility === "any", kind === "comment", `only a comment may be the customer's: ${kind}`)
      assert.equal(TICKET_EVENT_SHAPES[kind].resolution === "with-completed", kind === "status-changed", `only a status change carries a resolution: ${kind}`)
    }
  })
})

describe("ticketEventShape", () => {
  test("every kind's exemplar passes, and a comment is the one exemplar that passes under no other kind", () => {
    for (const kind of TICKET_EVENT_KINDS) {
      assert.equal(ticketEventShape(kind, exemplar(kind)), true, kind)
      assert.equal(ticketEventShapeIssue(kind, exemplar(kind)), undefined, kind)
    }
    // A created row's exemplar is what an assignment and a status change may carry too; a comment's body is theirs to carry, but its exemplar carries a key.
    assert.equal(ticketEventShape("assigned", exemplar("created")), true)
    assert.equal(ticketEventShape("status-changed", exemplar("created")), true)
    assert.equal(ticketEventShape("created", exemplar("assigned")), false, "an assignment's note is more than a created row says")
    assert.equal(ticketEventShape("comment", exemplar("created")), false, "a comment says something")
    for (const kind of TICKET_EVENT_KINDS) if (kind !== "comment") assert.equal(ticketEventShape(kind, exemplar("comment")), false, kind)
  })

  test("each column set or unset against its kind's rule, one at a time, over every kind: the sentence names the column", () => {
    for (const kind of TICKET_EVENT_KINDS) {
      const shape = TICKET_EVENT_SHAPES[kind]
      for (const column of ["body", "objectKey"] as const) {
        const given = { ...exemplar(kind), [column]: full[column] }
        const absent = { ...exemplar(kind), [column]: null }
        assert.equal(ticketEventShape(kind, given), shape[column] !== "none", `${kind} with ${column}`)
        assert.equal(ticketEventShape(kind, absent), shape[column] !== "required", `${kind} without ${column}`)
        if (shape[column] === "required") assert.equal(ticketEventShapeIssue(kind, absent), `A ${kind} event carries ${column}`)
        if (shape[column] === "none") assert.equal(ticketEventShapeIssue(kind, given), `A ${kind} event carries no ${column}`)
      }
      // Who may read it: a comment either, every other kind the office alone.
      for (const visibility of TICKET_VISIBILITIES) {
        const row = { ...exemplar(kind), visibility }
        assert.equal(ticketEventShape(kind, row), shape.visibility === "any" || visibility === "internal", `${kind} readable by ${visibility}`)
        if (shape.visibility === "internal" && visibility !== "internal") assert.equal(ticketEventShapeIssue(kind, row), `A ${kind} event is internal`)
      }
      // The resolution against the status: a status change carries one exactly when completed, every other kind never.
      for (const status of TICKET_STATUSES) {
        for (const resolution of [full.resolution, null]) {
          const row = { ...exemplar(kind), status, resolution }
          const expected = shape.resolution === "none" ? resolution === null : (status === "completed") === (resolution !== null)
          assert.equal(ticketEventShape(kind, row), expected, `${kind} ${status} with resolution ${resolution}`)
          if (!expected) {
            assert.equal(ticketEventShapeIssue(kind, row), shape.resolution === "none" ? `A ${kind} event carries no resolution` : "A status-changed event carries a resolution exactly when its status is completed")
          }
        }
      }
    }
  })

  test("the sentences, in the order the columns are judged: the body, the attachment, who may read it, the resolution", () => {
    assert.equal(ticketEventShapeIssue("comment", { ...exemplar("comment"), body: null, visibility: "customer" }), "A comment event carries body")
    assert.equal(ticketEventShapeIssue("created", { ...exemplar("created"), body: "x", objectKey: "k" }), "A created event carries no body")
    assert.equal(ticketEventShapeIssue("assigned", { ...exemplar("assigned"), objectKey: "k", visibility: "customer" }), "A assigned event carries no objectKey")
    assert.equal(ticketEventShapeIssue("status-changed", { ...exemplar("status-changed"), visibility: "customer", resolution: "answered" }), "A status-changed event is internal")
    assert.equal(ticketEventShapeIssue("status-changed", { ...exemplar("status-changed"), status: "completed" }), "A status-changed event carries a resolution exactly when its status is completed")
    assert.equal(ticketEventShapeIssue("status-changed", { ...exemplar("status-changed"), status: "completed", resolution: "answered" }), undefined)
    assert.equal(ticketEventShapeIssue("status-changed", { ...exemplar("status-changed"), status: "rejected" }), undefined, "a rejection has a reason and no resolution")
  })
})
