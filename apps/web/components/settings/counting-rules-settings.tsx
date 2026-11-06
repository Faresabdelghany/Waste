"use client"

// Settings › Operations › Counting rules (#547 of #544): the company's rules
// counting the completed emptyings at each property over a month, a quarter
// or a year, and opening one ticket of a chosen type, waiting with a chosen
// team, on a property whose count reaches the limit — read from and written
// to `/counting-rules` under `configure.templates`, as the Ticket SLA's pane
// reads its set. A rule is made inactive and may be simulated over past
// emptyings before it is switched on (`POST /counting-rules/simulation`): the
// properties that would have received a ticket, and when. The pickers offer
// the API's own lists by server id — the active ticket types and teams, the
// fractions and container types — and a retired type or team a rule names
// still reads by its name; the rows and bodies are
// lib/data/counting-rules.ts's. Offered on the Pilot alone.

import { useState, type ReactNode } from "react"
import { Calculator, FloppyDisk, PencilSimple, Plus, Trash } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { CountingRule, CountingSimulation } from "@waste/contracts/counting-rules"
import type { ContainerType, WasteFraction } from "@waste/contracts/catalogue"
import type { Team } from "@waste/contracts/ticket-teams"
import type { TicketType } from "@waste/contracts/ticket-types"
import { todayIso } from "@waste/domain/route-schemes/recurrence"
import { useReport } from "@/components/insight/use-report"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/asset-management-settings"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { StatusBadge } from "@/components/ui/status-badge"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiClient, useApiSession } from "@/components/waste/api-session-store"
import { create, listAll, patch, post, remove } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import {
  COUNTING_PERIOD_OPTIONS,
  countingRuleBodyOf,
  countingRuleDraftOf,
  countingRulePatchOf,
  countingRuleSentence,
  countingRulesAccessOf,
  EVERY,
  isCountingRuleRefusal,
  simulatedPeriod,
  SIMULATION_WINDOWS,
  simulationBodyOf,
  simulationWindowOf,
  type CountingRuleDraft,
  type CountingRuleRefusal,
} from "@/lib/data/counting-rules"
import type { CountingPeriod } from "@waste/domain/resolution/vocabulary"

/** What the pickers offer and the table names a rule's references by: each by server id. */
type Choices = { types: readonly TicketType[]; teams: readonly Team[]; fractions: readonly WasteFraction[]; containerTypes: readonly ContainerType[] }

const NO_CHOICES: Choices = { types: [], teams: [], fractions: [], containerTypes: [] }

/** The name of a reference among the choices, or its id where no list the role reads holds it. */
const nameIn = (rows: readonly { id: string; name: string }[], id: string | null): string | null => (id === null ? null : (rows.find((row) => row.id === id)?.name ?? id))

/** The lists a rule picks from, each read under its own grant: a list the role may not read offers nothing, and a rule's reference reads as its id. */
async function choicesOf(client: Parameters<typeof listAll>[0]): Promise<Choices> {
  const settle = async <T,>(read: Promise<T[]>): Promise<T[]> => read.catch(() => [])
  const [types, teams, fractions, containerTypes] = await Promise.all([
    settle(listAll<TicketType>(client, "/ticket-types")),
    settle(listAll<Team>(client, "/teams")),
    settle(listAll<WasteFraction>(client, "/waste-fractions")),
    settle(listAll<ContainerType>(client, "/container-types")),
  ])
  return { types, teams, fractions, containerTypes }
}

/** The pane, a tab of Settings › Tickets (#548 of #544): `tabs` is the page's tab strip, drawn in this pane's header. */
export function CountingRulesSettings({ tabs }: { tabs?: ReactNode } = {}) {
  const client = useApiClient()
  const { me } = useApiSession()
  const access = countingRulesAccessOf(me?.role.grants)
  // Read again after every write: the key carries how many there have been.
  const [writes, setWrites] = useState(0)
  const rules = useReport<CountingRule[]>(access.view ? `counting-rules:${writes}` : null, (asking) => listAll<CountingRule>(asking, "/counting-rules"))
  const choices = useReport<Choices>(access.view ? "counting-rule-choices" : null, choicesOf).report ?? NO_CHOICES
  const [editing, setEditing] = useState<CountingRule | "new" | null>(null)
  const rows = rules.report ?? []

  const emptyMessage = !access.view
    ? "The counting rules are not shown to your role."
    : rules.problem !== null
      ? `The counting rules could not be read from the API: ${problemSentence(rules.problem)}`
      : rules.report === null
        ? "Reading the counting rules from the API…"
        : "No counting rule yet."

  return (
    <AssetPanelShell
      heading="Tickets"
      tabs={tabs}
      title="Counting rules"
      description="Count the emptyings at each property over a month, a quarter or a year, and open a ticket when a limit is reached."
      action={
        <Button size="sm" disabled={!access.create || client === null} onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" weight="bold" />
          Add rule
        </Button>
      }
      toolbar={
        <span className="text-sm text-muted-foreground">
          {rows.length === 0 ? "No rule counts yet." : `${rows.filter((rule) => rule.status === "active").length} of ${rows.length} ${rows.length === 1 ? "rule is" : "rules are"} counting.`}
        </span>
      }
    >
      <p className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
        The worker counts each completed emptying as it happens, by its route&apos;s service date. A property gets at most one ticket per rule and period; the ticket names the property, the rule and the count, and is never charged. Simulate a rule over past emptyings before you switch it on.
      </p>
      <RecordsSection shown={rows.length} total={rows.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Rule</TableHead>
                <TableHead>Counts</TableHead>
                <TableHead>Opens</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={5} message={emptyMessage} hint={access.create && rules.report !== null ? "Add a rule, simulate it, then switch it on." : ""} />
              ) : (
                rows.map((rule) => (
                  <TableRow key={rule.id} aria-label={rule.name}>
                    <TableCell className="font-medium">{rule.name}</TableCell>
                    <TableCell>{countingRuleSentence(rule, { wasteFraction: nameIn(choices.fractions, rule.wasteFractionId), containerType: nameIn(choices.containerTypes, rule.containerTypeId) })}</TableCell>
                    <TableCell>
                      {nameIn(choices.types, rule.ticketTypeId)} · {nameIn(choices.teams, rule.teamId)}
                      {rule.notifiesTeam && <span className="text-muted-foreground"> · team told</span>}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={rule.status === "active" ? "success" : "neutral"}>{rule.status === "active" ? "Active" : "Inactive"}</StatusBadge>
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${rule.name}`} onClick={() => setEditing(rule)}>
                        <PencilSimple className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </RecordsSection>
      {editing !== null && client !== null && (
        <CountingRuleDialog
          key={editing === "new" ? "new" : editing.id}
          rule={editing === "new" ? undefined : editing}
          choices={choices}
          access={access}
          client={client}
          onClose={() => setEditing(null)}
          onWritten={() => setWrites((count) => count + 1)}
        />
      )}
    </AssetPanelShell>
  )
}

/** The rows a picker offers a new reference: the active ones, where a list has a status (a status gates a new reference). */
const offered = <Row extends { id: string; name: string; status?: string }>(rows: readonly Row[]): readonly Row[] => rows.filter((row) => row.status === undefined || row.status === "active")

/** A select over a list by id, with an "every one" choice where the list may be left open. */
function PickRow({ id, label, value, rows, every, invalid, disabled, onChange }: { id: string; label: string; value: string | null; rows: readonly { id: string; name: string; status?: string }[]; every?: string; invalid?: boolean; disabled?: boolean; onChange: (value: string | null) => void }) {
  // The reference the rule holds still reads, retired or not, by its name where the list has it and by its id where it does not.
  const choices = offered(rows)
  const held = value !== null && !choices.some((row) => row.id === value) ? [...choices, { id: value, name: nameIn(rows, value) ?? value }] : choices
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value ?? (every === undefined ? "" : EVERY)} onValueChange={(picked) => onChange(picked === EVERY ? null : picked)} disabled={disabled}>
        <SelectTrigger id={id} aria-label={label} aria-invalid={invalid}>
          <SelectValue placeholder={choices.length === 0 ? "None to pick" : "Pick one"} />
        </SelectTrigger>
        <SelectContent>
          {every !== undefined && <SelectItem value={EVERY}>{every}</SelectItem>}
          {held.map((row) => (
            <SelectItem key={row.id} value={row.id}>
              {row.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/** A rule's editor: its terms, the ticket it opens, whether it counts, and a simulation of the terms as they stand in the form. */
function CountingRuleDialog({
  rule,
  choices,
  access,
  client,
  onClose,
  onWritten,
}: {
  rule: CountingRule | undefined
  choices: Choices
  access: ReturnType<typeof countingRulesAccessOf>
  client: NonNullable<ReturnType<typeof useApiClient>>
  onClose: () => void
  onWritten: () => void
}) {
  const [draft, setDraft] = useState<CountingRuleDraft>(() => countingRuleDraftOf(rule))
  const [refusal, setRefusal] = useState<CountingRuleRefusal | null>(null)
  const [busy, setBusy] = useState(false)
  const [windowMonths, setWindowMonths] = useState<string>(SIMULATION_WINDOWS[0].value)
  const [simulation, setSimulation] = useState<{ period: CountingPeriod; answer: CountingSimulation } | null>(null)
  const may = rule === undefined ? access.create : access.edit
  const change = (values: Partial<CountingRuleDraft>) => {
    setDraft((current) => ({ ...current, ...values }))
    setRefusal(null)
  }
  const failed = (said: string) => (error: unknown) => toast.error(said, { description: problemSentence(problemOfError(error)) })

  const save = () => {
    const body = rule === undefined ? countingRuleBodyOf(draft) : countingRulePatchOf(rule, draft)
    if (body === null) return onClose()
    if (isCountingRuleRefusal(body)) return setRefusal(body)
    setBusy(true)
    const write = rule === undefined ? create<CountingRule>(client, "/counting-rules", body).then((made) => made.body) : patch<CountingRule>(client, `/counting-rules/${rule.id}`, body)
    write
      .then(
        (written) => {
          onWritten()
          onClose()
          toast.success(rule === undefined ? "Counting rule added" : "Counting rule saved", { description: `${written.name} is ${written.status === "active" ? "counting" : "switched off"}.` })
        },
        failed("The counting rule was not saved"),
      )
      .finally(() => setBusy(false))
  }

  const removeRule = () => {
    if (rule === undefined) return
    setBusy(true)
    remove(client, `/counting-rules/${rule.id}`)
      .then(
        () => {
          onWritten()
          onClose()
          toast.success("Counting rule removed", { description: rule.name })
        },
        failed("The counting rule was not removed"),
      )
      .finally(() => setBusy(false))
  }

  const simulate = () => {
    const body = simulationBodyOf(draft, simulationWindowOf(todayIso(), Number(windowMonths)))
    if (isCountingRuleRefusal(body)) return setRefusal(body)
    setBusy(true)
    post<CountingSimulation>(client, "/counting-rules/simulation", body)
      .then((answered) => setSimulation({ period: body.period, answer: answered.body }), failed("The simulation did not run"))
      .finally(() => setBusy(false))
  }

  const refused = (field: keyof CountingRuleDraft) => (refusal?.field === field ? refusal.message : null)
  const said = (field: keyof CountingRuleDraft) => {
    const message = refused(field)
    return message === null ? null : <p className="text-xs text-destructive">{message}</p>
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-6 py-5 pr-12">
          <DialogTitle>{rule === undefined ? "New counting rule" : rule.name}</DialogTitle>
          <DialogDescription>What it counts at each property, the limit that opens a ticket, and the ticket it opens.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="counting-rule-name">Name</Label>
              <Input id="counting-rule-name" value={draft.name} disabled={!may} aria-invalid={refused("name") !== null} onChange={(event) => change({ name: event.target.value })} placeholder="Emptied more than the agreement allows" />
              {said("name")}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="counting-rule-period">Counted over a calendar</Label>
              <Select value={draft.period} onValueChange={(period) => change({ period: period as CountingPeriod })} disabled={!may}>
                <SelectTrigger id="counting-rule-period" aria-label="Counted over a calendar">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COUNTING_PERIOD_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="counting-rule-limit">Limit: emptyings that open a ticket</Label>
              <Input id="counting-rule-limit" inputMode="numeric" value={draft.limit} disabled={!may} aria-invalid={refused("limit") !== null} onChange={(event) => change({ limit: event.target.value })} placeholder="12" />
              {said("limit")}
            </div>
            <PickRow id="counting-rule-fraction" label="Waste fraction" value={draft.wasteFractionId} rows={choices.fractions} every="Every fraction" disabled={!may} onChange={(wasteFractionId) => change({ wasteFractionId })} />
            <PickRow id="counting-rule-container-type" label="Container type" value={draft.containerTypeId} rows={choices.containerTypes} every="Every container type" disabled={!may} onChange={(containerTypeId) => change({ containerTypeId })} />
            <div className="grid gap-1">
              <PickRow id="counting-rule-type" label="Ticket type" value={draft.ticketTypeId} rows={choices.types} invalid={refused("ticketTypeId") !== null} disabled={!may} onChange={(ticketTypeId) => change({ ticketTypeId })} />
              {said("ticketTypeId")}
            </div>
            <div className="grid gap-1">
              <PickRow id="counting-rule-team" label="Waits with team" value={draft.teamId} rows={choices.teams} invalid={refused("teamId") !== null} disabled={!may} onChange={(teamId) => change({ teamId })} />
              {said("teamId")}
            </div>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Checkbox checked={draft.notifiesTeam} disabled={!may} onCheckedChange={(checked) => change({ notifiesTeam: checked === true })} />
              E-mail each member of the team when a ticket opens
            </label>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Switch checked={draft.active} disabled={!may} onCheckedChange={(active) => change({ active })} aria-label="Counting" />
              {draft.active ? "Counting: each emptying from now on is counted" : "Switched off: nothing is counted"}
            </label>
          </div>

          <section className="rounded-md border" aria-label="Simulation">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
              <h3 className="text-sm font-medium">Simulate over past emptyings</h3>
              <div className="flex items-center gap-2">
                <Select value={windowMonths} onValueChange={setWindowMonths}>
                  <SelectTrigger className="h-8 w-48" aria-label="Simulate over">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SIMULATION_WINDOWS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button type="button" variant="outline" size="sm" disabled={!access.simulate || busy} onClick={simulate}>
                  <Calculator className="h-4 w-4" />
                  Simulate
                </Button>
              </div>
            </header>
            {!access.simulate ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">A simulation reads the stops, which your role does not.</p>
            ) : simulation === null ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">The properties that would have received a ticket under these terms, and when, in the projects you work in.</p>
            ) : (
              <div className="space-y-2 px-3 py-3">
                <p className="text-sm">
                  {simulation.answer.tickets === 0
                    ? `No property would have received a ticket from ${simulation.answer.from} to ${simulation.answer.to}.`
                    : `${simulation.answer.tickets} ${simulation.answer.tickets === 1 ? "ticket" : "tickets"} at ${simulation.answer.properties} ${simulation.answer.properties === 1 ? "property" : "properties"} from ${simulation.answer.from} to ${simulation.answer.to}.`}
                  {simulation.answer.shown.length < simulation.answer.tickets && ` The first ${simulation.answer.shown.length} are listed.`}
                </p>
                {simulation.answer.shown.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Property</TableHead>
                        <TableHead>Period</TableHead>
                        <TableHead>Reached on</TableHead>
                        <TableHead>Emptyings in the period</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {simulation.answer.shown.map((ticket) => (
                        <TableRow key={`${ticket.propertyId}-${ticket.periodFrom}`}>
                          <TableCell>{ticket.propertyName}</TableCell>
                          <TableCell>{simulatedPeriod(ticket.periodFrom, simulation.period)}</TableCell>
                          <TableCell>{ticket.reachedOn}</TableCell>
                          <TableCell>{ticket.count}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            )}
          </section>
        </div>
        <DialogFooter className="border-t px-6 py-4">
          {rule !== undefined && (
            <Button type="button" variant="ghost" className="mr-auto text-destructive" disabled={!access.delete || busy} onClick={removeRule}>
              <Trash className="h-4 w-4" />
              Remove
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!may || busy} onClick={save}>
            <FloppyDisk className="h-4 w-4" />
            Save rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
