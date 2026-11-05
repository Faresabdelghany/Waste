// A Ticket Type's automation (#546 of #544): the trigger a status fires, the
// parameters each kind of action carries, the move to a status an action is
// already triggered by, and the lines a run leaves.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ACTION_PARAMETER_KEYS, ACTION_PARAMETERS, actionIssue, actionsOf, AUTOMATION_ACTIONS_MAX, AUTOMATION_DEPTH_MAX, AUTOMATION_SPENT, AUTOMATION_STOPPED, automationNote, commandTrigger, notPlannable, PLAN_DAYS_AHEAD_MAX, plannedService, TICKET_TYPE_ACTIONS_MAX, triggerOf, type TicketAction } from "../automation"
import { TICKET_ACTION_COMMANDS, TICKET_ACTION_KINDS, TICKET_ACTION_TRIGGERS, TICKET_STATUSES } from "../vocabulary"

const NONE = { teamId: null, userAccountId: null, priority: null, command: null, resolution: null, messageTemplateName: null, recipient: null, followUpTypeId: null, vehicleId: null, daysAhead: null }
const action = (values: Partial<TicketAction>): TicketAction => ({ trigger: "opened", kind: "set-priority", ...NONE, priority: "high", ...values })

describe("when a type's actions run", () => {
  test("a status a command leads to fires its own trigger; open fires none", () => {
    for (const status of TICKET_STATUSES) assert.equal(triggerOf(status), status === "open" ? undefined : status)
    assert.deepEqual(TICKET_ACTION_COMMANDS.map(commandTrigger), ["in-progress", "pending", "on-hold", "completed", "rejected"])
    assert.ok(TICKET_ACTION_COMMANDS.every((command) => (TICKET_ACTION_TRIGGERS as readonly string[]).includes(commandTrigger(command))))
  })

  test("a trigger's actions run in the list's order", () => {
    const list = [action({ priority: "high" }), action({ trigger: "completed", kind: "assign-team", priority: null, teamId: "team-a" }), action({ priority: "low" })]
    assert.deepEqual(actionsOf(list, "opened").map((entry) => entry.priority), ["high", "low"])
    assert.deepEqual(actionsOf(list, "rejected"), [])
  })
})

describe("what an action carries", () => {
  test("each kind its own parameters and no other", () => {
    assert.deepEqual(Object.keys(ACTION_PARAMETERS), [...TICKET_ACTION_KINDS])
    assert.equal(actionIssue(action({})), undefined)
    assert.deepEqual(actionIssue(action({ priority: null })), { path: "priority", message: "An action to set the priority names a priority" })
    assert.deepEqual(actionIssue(action({ teamId: "team-a" })), { path: "teamId", message: "An action to set the priority names no team" })
    assert.equal(actionIssue(action({ kind: "send-message", priority: null, messageTemplateName: "Collection booked", recipient: "owner" })), undefined)
    assert.equal(actionIssue(action({ kind: "send-message", priority: null, messageTemplateName: "Collection booked" }))?.path, "recipient")
    assert.equal(ACTION_PARAMETER_KEYS.length, Object.keys(NONE).length)
  })

  test("a completion names its resolution, and nothing else does", () => {
    const completing = action({ trigger: "in-progress", kind: "set-status", priority: null, command: "complete", resolution: "serviced" })
    assert.equal(actionIssue(completing), undefined)
    assert.deepEqual(actionIssue({ ...completing, resolution: null }), { path: "resolution", message: "An action to move the status names a resolution" })
    assert.deepEqual(actionIssue({ ...completing, command: "hold" }), { path: "resolution", message: "Only a completion names a resolution" })
  })

  test("a move to the status the action is triggered by is refused: it would do nothing on every ticket", () => {
    assert.deepEqual(actionIssue(action({ trigger: "on-hold", kind: "set-status", priority: null, command: "hold" })), { path: "command", message: "A ticket reaching on hold is on hold already; move it to another status" })
    assert.equal(actionIssue(action({ trigger: "on-hold", kind: "set-status", priority: null, command: "start" })), undefined)
  })

  test("a ticket a completion or a rejection closed keeps its team, its assignee, its priority and its status: its actions write to someone or open a follow-up", () => {
    for (const trigger of ["completed", "rejected"] as const) {
      assert.deepEqual(actionIssue(action({ trigger, kind: "assign-team", priority: null, teamId: "team-a" })), { path: "teamId", message: `A ticket reaching ${trigger} is closed and keeps its team` })
      assert.deepEqual(actionIssue(action({ trigger, kind: "assign-person", priority: null, userAccountId: "olivia" })), { path: "userAccountId", message: `A ticket reaching ${trigger} is closed and keeps its assignee` })
      assert.deepEqual(actionIssue(action({ trigger })), { path: "priority", message: `A ticket reaching ${trigger} is closed and keeps its priority` })
      assert.deepEqual(actionIssue(action({ trigger, kind: "set-status", priority: null, command: "start" })), { path: "command", message: `A ticket reaching ${trigger} is closed and keeps its status until a person reopens it` })
      assert.equal(actionIssue(action({ trigger, kind: "send-message", priority: null, messageTemplateName: "Case closed", recipient: "ticket-customer" })), undefined)
      assert.equal(actionIssue(action({ trigger, kind: "open-follow-up", priority: null, followUpTypeId: "type-a" })), undefined)
    }
    assert.equal(actionIssue(action({ trigger: "pending", kind: "assign-team", priority: null, teamId: "team-a" })), undefined, "an open status is no closing")
    assert.deepEqual(actionIssue(action({ trigger: "completed", kind: "plan-in-route", priority: null, vehicleId: "truck", daysAhead: 1 })), { path: "vehicleId", message: "A ticket reaching completed is closed and is answered by no stop" })
  })

  test("a plan in a route names a vehicle and from 0 to the most days ahead, and plans the stop answering its kind that names nothing but its container", () => {
    const planning = action({ kind: "plan-in-route", priority: null, vehicleId: "truck", daysAhead: 2 })
    assert.equal(actionIssue(planning), undefined)
    assert.equal(actionIssue({ ...planning, daysAhead: 0 }), undefined, "the vehicle's next route from today")
    assert.deepEqual(actionIssue({ ...planning, daysAhead: null }), { path: "daysAhead", message: "An action to plan it in a route names how many days ahead" })
    assert.deepEqual(actionIssue({ ...planning, daysAhead: PLAN_DAYS_AHEAD_MAX + 1 }), { path: "daysAhead", message: `Plan from 0 to ${PLAN_DAYS_AHEAD_MAX} days ahead` })
    assert.deepEqual(actionIssue({ ...planning, daysAhead: -1 }), { path: "daysAhead", message: `Plan from 0 to ${PLAN_DAYS_AHEAD_MAX} days ahead` })
    assert.deepEqual(actionIssue({ ...planning, vehicleId: null }), { path: "vehicleId", message: "An action to plan it in a route names a vehicle" })
    assert.deepEqual([plannedService("overflow"), plannedService("container-defect"), plannedService("container-request"), plannedService("complaint")], ["empty", "repair", undefined, undefined])
    assert.equal(notPlannable("container-request"), "A container request is answered by a stop naming more than its container: the office books it")
    assert.equal(notPlannable("internal-task"), "An internal task is answered by no stop to plan in a route")
  })
})

describe("the lines a run leaves", () => {
  test("name the type and the trigger, and a chain past its last level says where it stopped", () => {
    assert.equal(automationNote("Bulky waste collection", "completed", "assigned to team Container desk."), "Automation of Bulky waste collection on completion: assigned to team Container desk.")
    assert.equal(automationNote("Overflow", "opened", "priority set to high."), "Automation of Overflow on opening: priority set to high.")
    assert.match(AUTOMATION_STOPPED, new RegExp(`past ${AUTOMATION_DEPTH_MAX} levels`))
    assert.match(AUTOMATION_SPENT, new RegExp(`set ${AUTOMATION_ACTIONS_MAX} actions going`))
    assert.ok(AUTOMATION_ACTIONS_MAX >= TICKET_TYPE_ACTIONS_MAX, "one trigger of one type never meets the budget")
  })
})
