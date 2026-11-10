// The Resolution vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts), and to the rules between its lists: the open
// and the closed statuses are two values of the status list that together
// make the whole of it; the sources spell the driver as Execution does and
// the office claims no door's own; a ticket type is retired as a team is; and
// what is a reading and not a value — a ticket created, a field edited, an
// alert linked to a ticket — is in no list.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import { EXECUTION_SOURCES } from "../../execution/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("Resolution", vocabulary, vocabulary.RESOLUTION_VOCABULARIES, { OPEN_TICKET_STATUSES: "TICKET_STATUSES", CLOSED_TICKET_STATUSES: "TICKET_STATUSES", BILLABLE_RESOLUTIONS: "TICKET_RESOLUTIONS", OFFICE_TICKET_SOURCES: "TICKET_SOURCES", ACTIVE_TEAM_STATUSES: "TEAM_STATUSES", ACTIVE_TICKET_TYPE_STATUSES: "TICKET_TYPE_STATUSES" })

describe("the Resolution vocabulary's own rules", () => {
  test("the open and the closed statuses are values of the status list and together make the whole of it, in its order", () => {
    assert.deepEqual([...vocabulary.OPEN_TICKET_STATUSES, ...vocabulary.CLOSED_TICKET_STATUSES], [...vocabulary.TICKET_STATUSES])
    for (const status of vocabulary.TICKET_STATUSES) {
      assert.equal(vocabulary.isClosedTicketStatus(status), (vocabulary.CLOSED_TICKET_STATUSES as readonly string[]).includes(status), status)
    }
    assert.equal((vocabulary.TICKET_STATUSES as readonly string[]).includes("created"), false, "Created folds into open; created_at says when")
  })

  test("the sources spell the driver as Execution does and the office claims no door's own; the history has no edited kind", () => {
    for (const source of ["driver-app", "dispatch"] as const) assert.ok((EXECUTION_SOURCES as readonly string[]).includes(source), `${source} is Execution's spelling`)
    assert.equal((vocabulary.TICKET_SOURCES as readonly string[]).includes("driver"), false)
    assert.deepEqual([...vocabulary.OFFICE_TICKET_SOURCES], ["office", "phone", "email", "portal", "import", "integration"], "the office claims no door's own source")
    assert.equal((vocabulary.TICKET_EVENT_KINDS as readonly string[]).includes("edited"), false, "the history of a field edit is the audit log's (ADR-0005)")
  })

  test("a ticket type is active or retired as a team is (#545 of #544)", () => {
    assert.deepEqual([...vocabulary.TICKET_TYPE_STATUSES], [...vocabulary.TEAM_STATUSES])
  })

  test("an alert's statuses leave out the linked reading", () => {
    assert.equal((vocabulary.ALERT_STATUSES as readonly string[]).includes("linked"), false, "a reading of ticket_id")
  })
})
