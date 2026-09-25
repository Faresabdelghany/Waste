import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ALERT_COMMANDS, ALERT_DOES_NOT_CHANGE, alertTransition, closedTicket, TICKET_COMMAND_TARGETS, TICKET_COMMANDS, ticketTransition, type AlertCommand, type TicketCommand, type Transition } from "../transitions"
import { ALERT_STATUSES, CLOSED_TICKET_STATUSES, OPEN_TICKET_STATUSES, TICKET_STATUSES, type AlertStatus, type TicketStatus } from "../vocabulary"

const LABEL = "T-8831"

const COMPLETED = "Ticket T-8831 is completed; reopen it first"
const REJECTED = "Ticket T-8831 is rejected; reopen it first"

/** The ticket machine spelled out, status by status and command by command, so the function is pinned in words and not only in itself. */
const ticketTable: Record<TicketStatus, Record<TicketCommand, Transition<TicketStatus>>> = {
  open: {
    start: { kind: "move", to: "in-progress" },
    wait: { kind: "move", to: "pending" },
    hold: { kind: "move", to: "on-hold" },
    complete: { kind: "move", to: "completed" },
    reject: { kind: "move", to: "rejected" },
    reopen: { kind: "stay" },
  },
  "in-progress": {
    start: { kind: "stay" },
    wait: { kind: "move", to: "pending" },
    hold: { kind: "move", to: "on-hold" },
    complete: { kind: "move", to: "completed" },
    reject: { kind: "move", to: "rejected" },
    reopen: { kind: "stay" },
  },
  pending: {
    start: { kind: "move", to: "in-progress" },
    wait: { kind: "stay" },
    hold: { kind: "move", to: "on-hold" },
    complete: { kind: "move", to: "completed" },
    reject: { kind: "move", to: "rejected" },
    reopen: { kind: "stay" },
  },
  "on-hold": {
    start: { kind: "move", to: "in-progress" },
    wait: { kind: "move", to: "pending" },
    hold: { kind: "stay" },
    complete: { kind: "move", to: "completed" },
    reject: { kind: "move", to: "rejected" },
    reopen: { kind: "stay" },
  },
  completed: {
    start: { kind: "refuse", sentence: COMPLETED },
    wait: { kind: "refuse", sentence: COMPLETED },
    hold: { kind: "refuse", sentence: COMPLETED },
    complete: { kind: "refuse", sentence: COMPLETED },
    reject: { kind: "refuse", sentence: COMPLETED },
    reopen: { kind: "move", to: "open" },
  },
  rejected: {
    start: { kind: "refuse", sentence: REJECTED },
    wait: { kind: "refuse", sentence: REJECTED },
    hold: { kind: "refuse", sentence: REJECTED },
    complete: { kind: "refuse", sentence: REJECTED },
    reject: { kind: "refuse", sentence: REJECTED },
    reopen: { kind: "move", to: "open" },
  },
}

describe("ticketTransition", () => {
  test("every status under every command, as the table spells it: thirty-six pairs", () => {
    let pairs = 0
    for (const status of TICKET_STATUSES) {
      for (const command of TICKET_COMMANDS) {
        assert.deepEqual(ticketTransition(status, command, LABEL), ticketTable[status][command], `${status} under ${command}`)
        pairs += 1
      }
    }
    assert.equal(pairs, 36)
    assert.deepEqual([...TICKET_COMMANDS], ["start", "wait", "hold", "complete", "reject", "reopen"])
  })

  test("an open ticket takes every command but reopen, staying where a command leads to the status it is in; complete and reject always move it", () => {
    for (const status of OPEN_TICKET_STATUSES) {
      for (const command of TICKET_COMMANDS) {
        const transition = ticketTransition(status, command, LABEL)
        assert.notEqual(transition.kind, "refuse", `${status} under ${command}`)
        if (command === "reopen") assert.deepEqual(transition, { kind: "stay" }, "reopening an open ticket is nothing to do")
        else if (TICKET_COMMAND_TARGETS[command] === status) assert.deepEqual(transition, { kind: "stay" }, `${command} on a ticket already ${status}`)
        else assert.deepEqual(transition, { kind: "move", to: TICKET_COMMAND_TARGETS[command] })
      }
      assert.deepEqual(ticketTransition(status, "complete", LABEL), { kind: "move", to: "completed" })
      assert.deepEqual(ticketTransition(status, "reject", LABEL), { kind: "move", to: "rejected" })
    }
  })

  test("a closed ticket refuses every command but reopen with the one sentence, complete and reject included: a second resolution is a change a person meant", () => {
    for (const status of CLOSED_TICKET_STATUSES) {
      for (const command of TICKET_COMMANDS) {
        const transition = ticketTransition(status, command, LABEL)
        if (command === "reopen") assert.deepEqual(transition, { kind: "move", to: "open" })
        else assert.deepEqual(transition, { kind: "refuse", sentence: closedTicket(LABEL, status) }, `${status} under ${command}`)
      }
    }
    assert.equal(closedTicket("T-7", "completed"), "Ticket T-7 is completed; reopen it first")
    assert.equal(closedTicket("T-7", "rejected"), "Ticket T-7 is rejected; reopen it first")
  })

  test("the targets: each command leads to one status, reopen back to open", () => {
    assert.deepEqual(TICKET_COMMAND_TARGETS, { start: "in-progress", wait: "pending", hold: "on-hold", complete: "completed", reject: "rejected", reopen: "open" })
  })
})

/** The alert machine spelled out. */
const alertTable: Record<AlertStatus, Record<AlertCommand, Transition<AlertStatus>>> = {
  new: {
    acknowledge: { kind: "move", to: "acknowledged" },
    resolve: { kind: "move", to: "resolved" },
  },
  acknowledged: {
    acknowledge: { kind: "stay" },
    resolve: { kind: "move", to: "resolved" },
  },
  resolved: {
    acknowledge: { kind: "refuse", sentence: ALERT_DOES_NOT_CHANGE },
    resolve: { kind: "stay" },
  },
}

describe("alertTransition", () => {
  test("every status under every command, as the table spells it: six pairs", () => {
    let pairs = 0
    for (const status of ALERT_STATUSES) {
      for (const command of ALERT_COMMANDS) {
        assert.deepEqual(alertTransition(status, command), alertTable[status][command], `${status} under ${command}`)
        pairs += 1
      }
    }
    assert.equal(pairs, 6)
    assert.deepEqual([...ALERT_COMMANDS], ["acknowledge", "resolve"])
  })

  test("an alert is resolved without being acknowledged, each command on its own status is nothing to do, and a resolved alert is not acknowledged", () => {
    assert.deepEqual(alertTransition("new", "resolve"), { kind: "move", to: "resolved" })
    assert.deepEqual(alertTransition("acknowledged", "acknowledge"), { kind: "stay" })
    assert.deepEqual(alertTransition("resolved", "resolve"), { kind: "stay" })
    assert.deepEqual(alertTransition("resolved", "acknowledge"), { kind: "refuse", sentence: "This alert is resolved and does not change" })
  })
})
