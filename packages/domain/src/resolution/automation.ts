// A Ticket Type's automation (#546 of #544): per trigger, an ordered list of
// actions the system performs on a ticket of the type — hand it to a team or
// a person, set its priority, move its status, send a message from one of
// its project's templates, open a follow-up ticket. A trigger is the ticket
// opened, or reaching one of the statuses a command leads to; `open` is no
// trigger, since only opening and a reopen reach it.
//
// Each action carries the parameters its kind needs and no other
// (`ACTION_PARAMETERS`), a completion its resolution, which the database's
// shape check reads too. A move to the status the action is triggered by is
// refused when the list is set, since it would do nothing and say so on every
// ticket, and so is any change to a ticket that the completion or the
// rejection reaching it closed — its team, its assignee, its priority, its
// status — which the office's own commands refuse too (`actionIssue`): a
// closed ticket's actions write to someone or open a follow-up.
//
// The system runs a ticket's actions in the transaction of the change that
// fired them (@waste/db/commands/ticket-automation). A move fires the
// trigger of the status it reaches, and a follow-up runs its own type's
// opened actions, each one level deeper; past `AUTOMATION_DEPTH_MAX` levels
// the chain stops and says so, so two types' rules looping through each
// other end, and past `AUTOMATION_ACTIONS_MAX` actions over the whole chain
// it stops too, so rules opening several follow-ups each end before their
// tickets multiply. The type's roles and required fields bind people, never
// these.
import { TICKET_COMMAND_TARGETS } from "./transitions"
import { isClosedTicketStatus, type TicketActionCommand, type TicketActionKind, type TicketActionTrigger, type TicketMessageRecipient, type TicketPriority, type TicketResolution, type TicketStatus } from "./vocabulary"

/** How many levels a chain of actions runs to: a move into another trigger, a follow-up's own actions. */
export const AUTOMATION_DEPTH_MAX = 5

/** The most actions a type holds, over every trigger. */
export const TICKET_TYPE_ACTIONS_MAX = 40

/** The most actions one change sets going over its whole chain: as many as a type holds, so one trigger of one type never meets it. */
export const AUTOMATION_ACTIONS_MAX = TICKET_TYPE_ACTIONS_MAX

/** What an action may carry beside its trigger and its kind, each null where its kind needs none. */
export type TicketActionParameters = {
  teamId: string | null
  userAccountId: string | null
  priority: TicketPriority | null
  command: TicketActionCommand | null
  /** With `complete` alone: what the ticket ends in. */
  resolution: TicketResolution | null
  /** A template of the ticket's project by this name, its project's own. */
  messageTemplateName: string | null
  recipient: TicketMessageRecipient | null
  followUpTypeId: string | null
}

/** One action as the rules read it. */
export type TicketAction = { trigger: TicketActionTrigger; kind: TicketActionKind } & TicketActionParameters

/** What each kind carries; a completion's resolution is `set-status`'s with `complete` beside these. */
export const ACTION_PARAMETERS: Readonly<Record<TicketActionKind, readonly (keyof TicketActionParameters)[]>> = {
  "assign-team": ["teamId"],
  "assign-person": ["userAccountId"],
  "set-priority": ["priority"],
  "set-status": ["command"],
  "send-message": ["messageTemplateName", "recipient"],
  "open-follow-up": ["followUpTypeId"],
}

/** Every parameter, in the order a sentence names them. */
export const ACTION_PARAMETER_KEYS: readonly (keyof TicketActionParameters)[] = ["teamId", "userAccountId", "priority", "command", "resolution", "messageTemplateName", "recipient", "followUpTypeId"]

/** Each parameter as a sentence names it. */
const PARAMETER_WORDS: Readonly<Record<keyof TicketActionParameters, string>> = {
  teamId: "a team",
  userAccountId: "a person",
  priority: "a priority",
  command: "a status",
  resolution: "a resolution",
  messageTemplateName: "a message template",
  recipient: "a recipient",
  followUpTypeId: "a ticket type",
}

/** Each kind as a sentence names it. */
export const ACTION_KIND_WORDS: Readonly<Record<TicketActionKind, string>> = {
  "assign-team": "assign to a team",
  "assign-person": "assign to a person",
  "set-priority": "set the priority",
  "set-status": "move the status",
  "send-message": "send a message",
  "open-follow-up": "open a follow-up",
}

/** Each trigger as a sentence names when it fires. */
export const TRIGGER_WORDS: Readonly<Record<TicketActionTrigger, string>> = {
  opened: "on opening",
  "in-progress": "on reaching in progress",
  pending: "on reaching pending",
  "on-hold": "on reaching on hold",
  completed: "on completion",
  rejected: "on rejection",
}

/** What a closed ticket keeps, by the kind of action that would change it. */
const KEPT_WHEN_CLOSED: Partial<Readonly<Record<TicketActionKind, { path: keyof TicketActionParameters; what: string }>>> = {
  "assign-team": { path: "teamId", what: "its team" },
  "assign-person": { path: "userAccountId", what: "its assignee" },
  "set-priority": { path: "priority", what: "its priority" },
  "set-status": { path: "command", what: "its status until a person reopens it" },
}

/** Whether the action needs the parameter: its kind's, and a resolution with a completion. */
const needs = (action: Pick<TicketAction, "kind" | "command">, key: keyof TicketActionParameters): boolean =>
  key === "resolution" ? action.kind === "set-status" && action.command === "complete" : ACTION_PARAMETERS[action.kind].includes(key)

/** The trigger a status reached fires; none for open, which only opening and a reopen reach. */
export const triggerOf = (status: TicketStatus): TicketActionTrigger | undefined => (status === "open" ? undefined : status)

/** The trigger a move to the command's status fires. */
export const commandTrigger = (command: TicketActionCommand): TicketActionTrigger => TICKET_COMMAND_TARGETS[command] as TicketActionTrigger

/** The first way one action breaks its rules, at the member at fault; undefined where it keeps them. */
export function actionIssue(action: TicketAction): { path: keyof TicketActionParameters; message: string } | undefined {
  for (const key of ACTION_PARAMETER_KEYS) {
    const present = action[key] !== null
    const needed = needs(action, key)
    if (needed && !present) return { path: key, message: `An action to ${ACTION_KIND_WORDS[action.kind]} names ${PARAMETER_WORDS[key]}` }
    if (!needed && present) return { path: key, message: key === "resolution" ? "Only a completion names a resolution" : `An action to ${ACTION_KIND_WORDS[action.kind]} names no ${PARAMETER_WORDS[key].replace(/^an? /, "")}` }
  }
  const kept = KEPT_WHEN_CLOSED[action.kind]
  if (kept !== undefined && action.trigger !== "opened" && isClosedTicketStatus(action.trigger)) return { path: kept.path, message: `A ticket reaching ${action.trigger} is closed and keeps ${kept.what}` }
  if (action.kind === "set-status" && action.command !== null && commandTrigger(action.command) === action.trigger) {
    const status = action.trigger.replaceAll("-", " ")
    return { path: "command", message: `A ticket reaching ${status} is ${status} already; move it to another status` }
  }
  return undefined
}

/** A type's actions of one trigger, in the order they run. */
export const actionsOf = <A extends Pick<TicketAction, "trigger">>(actions: readonly A[], trigger: TicketActionTrigger): A[] => actions.filter((action) => action.trigger === trigger)

/** A line of a ticket's history an action leaves: "Automation of Bulky waste collection on completion: assigned to team Container desk." */
export const automationNote = (typeName: string, trigger: TicketActionTrigger, said: string): string => `Automation of ${typeName} ${TRIGGER_WORDS[trigger]}: ${said}`

/** What a chain past its last level leaves. */
export const AUTOMATION_STOPPED = `Automation stopped: a chain of rules ran past ${AUTOMATION_DEPTH_MAX} levels, as two types' rules would if they set each other off`

/** What a chain past its last action leaves. */
export const AUTOMATION_SPENT = `Automation stopped: one change set ${AUTOMATION_ACTIONS_MAX} actions going, as rules opening several follow-ups of each other would`
