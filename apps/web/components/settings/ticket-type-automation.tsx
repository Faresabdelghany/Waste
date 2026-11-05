"use client"

// The Automation tab of a ticket type (#546 of #544): per trigger — the ticket
// opened, or reaching a status — the actions the system takes on a ticket of
// the type, in order. Each trigger offers the kinds of action it takes
// (`actionKindsFor`): a ticket a completion or a rejection closed is written
// to or followed up, never changed, and a plan in a route is offered where a
// stop naming the ticket's container answers the type's kind. The pickers
// offer the teams, people, ticket types and vehicles the store holds, each by
// its web id, which the adapter turns into the API's on save.

import { ArrowDown, ArrowUp, Plus, Trash } from "@phosphor-icons/react/dist/ssr"

import type { TicketTypeAction } from "@waste/contracts/ticket-types"
import { PLAN_DAYS_AHEAD_MAX } from "@waste/domain/resolution/automation"
import { TICKET_ACTION_TRIGGERS, type TicketActionCommand, type TicketActionKind, type TicketActionTrigger, type TicketKind, type TicketMessageRecipient, type TicketPriority, type TicketResolution } from "@waste/domain/resolution/vocabulary"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { BusinessFormOption } from "@/lib/data/business-form-types"
import { ACTION_COMMAND_OPTIONS, ACTION_KIND_LABELS, actionKindsFor, newAction, PRIORITY_OPTIONS, RECIPIENT_OPTIONS, RESOLUTION_OPTIONS, TRIGGER_HEADINGS } from "@/lib/data/ticket-types"

/** What the pickers offer, each row by its web id and name. */
export type AutomationChoices = { teams: readonly BusinessFormOption[]; people: readonly BusinessFormOption[]; types: readonly BusinessFormOption[]; vehicles: readonly BusinessFormOption[] }

/** A select over options, its value null until one is picked; a value the options no longer hold is shown as itself, so a retired team still reads. */
function Pick({ id, label, value, options, onChange }: { id: string; label: string; value: string | null; options: readonly BusinessFormOption[]; onChange: (value: string) => void }) {
  const held = value !== null && !options.some((option) => option.value === value) ? [...options, { value, label: value }] : options
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value ?? ""} onValueChange={onChange}>
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue placeholder={options.length === 0 ? "None to pick" : "Pick one"} />
        </SelectTrigger>
        <SelectContent>
          {held.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/** The parameters an action's kind takes, as the inputs that set them. */
function ActionParameters({ action, id, choices, onChange }: { action: TicketTypeAction; id: string; choices: AutomationChoices; onChange: (change: Partial<TicketTypeAction>) => void }) {
  switch (action.kind) {
    case "assign-team":
      return <Pick id={`${id}-team`} label="Team" value={action.teamId} options={choices.teams} onChange={(teamId) => onChange({ teamId })} />
    case "assign-person":
      return <Pick id={`${id}-person`} label="Person" value={action.userAccountId} options={choices.people} onChange={(userAccountId) => onChange({ userAccountId })} />
    case "set-priority":
      return <Pick id={`${id}-priority`} label="Priority" value={action.priority} options={PRIORITY_OPTIONS} onChange={(priority) => onChange({ priority: priority as TicketPriority })} />
    case "set-status":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Pick id={`${id}-command`} label="Move to" value={action.command} options={ACTION_COMMAND_OPTIONS} onChange={(command) => onChange({ command: command as TicketActionCommand, resolution: command === "complete" ? (action.resolution ?? "serviced") : null })} />
          {action.command === "complete" && <Pick id={`${id}-resolution`} label="Resolution" value={action.resolution} options={RESOLUTION_OPTIONS} onChange={(resolution) => onChange({ resolution: resolution as TicketResolution })} />}
        </div>
      )
    case "send-message":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-template`}>Message template</Label>
            <Input id={`${id}-template`} value={action.messageTemplateName ?? ""} placeholder="The template's name in the ticket's project" onChange={(event) => onChange({ messageTemplateName: event.target.value === "" ? null : event.target.value })} />
          </div>
          <Pick id={`${id}-recipient`} label="To" value={action.recipient} options={RECIPIENT_OPTIONS} onChange={(recipient) => onChange({ recipient: recipient as TicketMessageRecipient })} />
        </div>
      )
    case "open-follow-up":
      return <Pick id={`${id}-type`} label="Follow-up of type" value={action.followUpTypeId} options={choices.types} onChange={(followUpTypeId) => onChange({ followUpTypeId })} />
    case "plan-in-route":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Pick id={`${id}-vehicle`} label="On the next route of" value={action.vehicleId} options={choices.vehicles} onChange={(vehicleId) => onChange({ vehicleId })} />
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-days`}>Days ahead at the earliest</Label>
            <Input
              id={`${id}-days`}
              type="number"
              min={0}
              max={PLAN_DAYS_AHEAD_MAX}
              value={action.daysAhead ?? ""}
              onChange={(event) => onChange({ daysAhead: event.target.value === "" ? null : Number(event.target.value) })}
            />
          </div>
        </div>
      )
  }
}

/**
 * The type's actions by trigger, each trigger's in the order they run: a kind
 * picked from those the trigger takes, its parameters, moved within its
 * trigger or taken off. The list is the editor's; it is written on save.
 */
export function TicketTypeAutomation({ kind, actions, choices, onChange }: { kind: TicketKind; actions: readonly TicketTypeAction[]; choices: AutomationChoices; onChange: (actions: TicketTypeAction[]) => void }) {
  const replace = (index: number, action: TicketTypeAction) => onChange(actions.map((current, at) => (at === index ? action : current)))
  /** Swaps an action with its trigger's neighbour before or after it. */
  const move = (index: number, by: -1 | 1) => {
    const trigger = actions[index].trigger
    const places = actions.flatMap((action, at) => (action.trigger === trigger ? [at] : []))
    const other = places[places.indexOf(index) + by]
    if (other === undefined) return
    const next = [...actions]
    ;[next[index], next[other]] = [next[other], next[index]]
    onChange(next)
  }
  const add = (trigger: TicketActionTrigger) => {
    const [first] = actionKindsFor(trigger, kind)
    onChange([...actions, newAction(trigger, first)])
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        What the system does on its own when a ticket of this type opens or reaches a status, in order. Each action leaves a line in the ticket&apos;s history; one that cannot run — a team since retired, no route to plan in — says why, and the rest still run. The roles and fields asked of people do not bind it.
      </p>
      {TICKET_ACTION_TRIGGERS.map((trigger) => {
        const offered = actionKindsFor(trigger, kind)
        const listed = actions.flatMap((action, index) => (action.trigger === trigger ? [{ action, index }] : []))
        return (
          <section key={trigger} className="rounded-md border" aria-label={TRIGGER_HEADINGS[trigger]}>
            <header className="flex items-center justify-between gap-3 border-b bg-muted/40 px-3 py-2">
              <h3 className="text-sm font-medium">{TRIGGER_HEADINGS[trigger]}</h3>
              <Button type="button" variant="ghost" size="sm" onClick={() => add(trigger)} aria-label={`Add an action ${TRIGGER_HEADINGS[trigger].toLowerCase()}`}>
                <Plus className="h-4 w-4" />
                Add action
              </Button>
            </header>
            {listed.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">Nothing happens.</p>
            ) : (
              <ol className="divide-y">
                {listed.map(({ action, index }, place) => {
                  const id = `action-${trigger}-${place}`
                  const name = `${TRIGGER_HEADINGS[trigger]}, action ${place + 1}`
                  return (
                    <li key={index} className="grid gap-3 p-3 sm:grid-cols-[14rem_1fr_auto]" aria-label={name}>
                      <div className="grid gap-1.5">
                        <Label htmlFor={`${id}-kind`}>Action {place + 1}</Label>
                        <Select value={action.kind} onValueChange={(picked) => replace(index, newAction(trigger, picked as TicketActionKind))}>
                          <SelectTrigger id={`${id}-kind`} aria-label={`${name}: what it does`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {offered.map((option) => (
                              <SelectItem key={option} value={option}>
                                {ACTION_KIND_LABELS[option]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <ActionParameters action={action} id={id} choices={choices} onChange={(change) => replace(index, { ...action, ...change })} />
                      <div className="flex items-end gap-1">
                        <Button type="button" variant="ghost" size="icon" className="h-9 w-9" aria-label={`Move ${name} up`} disabled={place === 0} onClick={() => move(index, -1)}>
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" className="h-9 w-9" aria-label={`Move ${name} down`} disabled={place === listed.length - 1} onClick={() => move(index, 1)}>
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" className="h-9 w-9" aria-label={`Remove ${name}`} onClick={() => onChange(actions.filter((_, at) => at !== index))}>
                          <Trash className="h-4 w-4" />
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
          </section>
        )
      })}
    </div>
  )
}
