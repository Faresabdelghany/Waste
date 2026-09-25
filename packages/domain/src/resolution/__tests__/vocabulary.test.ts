// The Resolution vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts), and to four things of its own: the open and
// the closed statuses are two values of the status list that together make
// the whole of it; the kinds are the prototype's five, the repair ticket, the
// glossary's two and the consumer's two; the sources spell the driver as
// Execution does and put the dispatcher beside; and an alert's statuses are
// the prototype's less "Linked to ticket", a reading.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import { EXECUTION_SOURCES } from "../../execution/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("Resolution", vocabulary, vocabulary.RESOLUTION_VOCABULARIES, 11, ["OPEN_TICKET_STATUSES", "CLOSED_TICKET_STATUSES"])

describe("the Resolution vocabulary's own rules", () => {
  test("the open and the closed statuses are values of the status list and together make the whole of it, in its order", () => {
    assert.deepEqual([...vocabulary.TICKET_STATUSES], ["open", "in-progress", "pending", "on-hold", "completed", "rejected"])
    assert.deepEqual([...vocabulary.OPEN_TICKET_STATUSES, ...vocabulary.CLOSED_TICKET_STATUSES], [...vocabulary.TICKET_STATUSES])
    for (const status of vocabulary.TICKET_STATUSES) {
      assert.equal(vocabulary.isClosedTicketStatus(status), (vocabulary.CLOSED_TICKET_STATUSES as readonly string[]).includes(status), status)
    }
    assert.equal((vocabulary.TICKET_STATUSES as readonly string[]).includes("created"), false, "Created folds into open; created_at says when")
  })

  test("the kinds are the prototype's five types, the repair ticket, the glossary's complaint and task, the consumer's two, and other", () => {
    assert.deepEqual([...vocabulary.TICKET_KINDS], ["missed-collection", "overflow", "access-issue", "container-request", "container-defect", "proof-follow-up", "complaint", "reported-problem", "rejected-command", "internal-task", "other"])
    assert.deepEqual([...vocabulary.TICKET_PRIORITIES], ["critical", "high", "medium", "low", "none"])
    assert.deepEqual([...vocabulary.TICKET_RESOLUTIONS], ["recollected", "serviced", "answered", "no-action", "duplicate"])
  })

  test("the sources spell the driver as Execution does, and the dispatcher beside; the history has no edited kind and two readerships", () => {
    assert.deepEqual([...vocabulary.TICKET_SOURCES], ["office", "phone", "email", "portal", "driver-app", "dispatch", "import", "integration"])
    for (const source of ["driver-app", "dispatch"] as const) assert.ok((EXECUTION_SOURCES as readonly string[]).includes(source), `${source} is Execution's spelling`)
    assert.equal((vocabulary.TICKET_SOURCES as readonly string[]).includes("driver"), false)
    assert.deepEqual([...vocabulary.TICKET_EVENT_KINDS], ["created", "assigned", "status-changed", "comment"])
    assert.equal((vocabulary.TICKET_EVENT_KINDS as readonly string[]).includes("edited"), false, "the history of a field edit is the audit log's (ADR-0005)")
    assert.deepEqual([...vocabulary.TICKET_VISIBILITIES], ["internal", "customer"])
  })

  test("an alert's kinds are the prototype's six, its sources leave the later three their token, and its statuses leave out the linked reading", () => {
    assert.deepEqual([...vocabulary.ALERT_KINDS], ["route-exception", "resource", "service-risk", "asset", "weight", "other"])
    assert.deepEqual([...vocabulary.ALERT_SEVERITIES], ["critical", "high", "medium", "low"])
    assert.deepEqual([...vocabulary.ALERT_SOURCES], ["manual", "execution", "telemetry", "rule"])
    assert.deepEqual([...vocabulary.ALERT_STATUSES], ["new", "acknowledged", "resolved"])
    assert.equal((vocabulary.ALERT_STATUSES as readonly string[]).includes("linked"), false, "a reading of ticket_id")
  })
})
