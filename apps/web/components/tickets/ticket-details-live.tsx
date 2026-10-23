"use client"
// A ticket's details on the Pilot (Issue #182, slice 8 of #81; #147): the
// case as `GET /tickets/:id` gives it — its fields, its history in recording
// order, the alerts naming it — re-read after every command, patch and
// comment, and the row itself the store's live one, so the list and the
// dialog agree. Each inline row is one door of the API's: priority, kind and
// due are the case's patch; the status moves by the command buttons, each
// offered where the domain's machine would move the ticket or find it there
// already (`offersTicketCommand`); the assignee by `assign`; the source, the
// project and the links are read-only. A link is the linked row's name with
// its way there where its module has loaded the row, its id chip otherwise.
// The composer writes a comment, an internal note unless said to be the
// customer's. No attachment and no SMS: the pilot has neither (#126).
import { useState, type ReactNode } from "react"
import { ArrowLeft, ArrowSquareOut, ChatCircleText, CheckCircle, ClockCounterClockwise, LockKey, PaperPlaneTilt, PencilSimple, X } from "@phosphor-icons/react/dist/ssr"
import Link from "next/link"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, useServerModuleState, whenSaved } from "@/components/waste/business-record-store"
import { useCommandRunner, useRowHistory, useServerNames } from "@/components/waste/commands/use-command-support"
import type { ApiClient } from "@/lib/api/client"
import { statusLabel } from "@/lib/api/records/adapter"
import { ALERTS_MODULE } from "@/lib/api/records/alerts"
import { shownOn } from "@/lib/api/records/clock"
import { CONTAINERS_MODULE } from "@/lib/api/records/containers"
import { PICKUPS_MODULE } from "@/lib/api/records/pickups"
import { ROUTES_MODULE } from "@/lib/api/records/routes"
import { ASSIGN_TICKET, commentOnTicket, offersTicketCommand, ticketDetail, TICKET_LINKS, TICKET_MACHINE_COMMANDS, TICKETS_MODULE, ticketWord, type TicketCommandName } from "@/lib/api/records/tickets"
import { AGREEMENTS_MODULE } from "@/lib/data/agreements"
import { DRIVERS_MODULE } from "@/lib/data/allocations"
import { getBusinessModuleHref } from "@/lib/data/business-links"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import type { BusinessRecord, ModuleLocation } from "@/lib/data/business-modules"
import { CONTACTS_MODULE, NO_ONE, PROPERTIES_MODULE, SHARED_POINTS_MODULE } from "@/lib/data/properties"
import { ACCESS_MODULE, TICKET_COMMAND_FORMS, TICKET_EDIT_FORM, updateTicketRecord, type TicketCommandWithForm } from "@/lib/data/tickets"
import { cn } from "@/lib/utils"
import type { TicketDetail, TicketEvent } from "@waste/contracts/tickets"
import { TICKET_KINDS, TICKET_PRIORITIES, type TicketStatus } from "@waste/domain/resolution/vocabulary"

import { useResolutionPickers } from "./resolution-pickers"

const { workspaceId, moduleId } = TICKETS_MODULE

/** The ticket's own read, as a one-row history the dialog reads again after each change. */
const readTicket = (client: ApiClient, serverId: string) => ticketDetail(client, serverId).then((detail): TicketDetail[] => [detail])

/** Where each link's rows live, by the link's key: the way to a linked row. */
const LINK_MODULES: Readonly<Record<string, ModuleLocation>> = {
  routeId: ROUTES_MODULE,
  pickupId: PICKUPS_MODULE,
  containerId: CONTAINERS_MODULE,
  propertyId: PROPERTIES_MODULE,
  sharedCollectionPointId: SHARED_POINTS_MODULE,
  customerId: CONTACTS_MODULE,
  agreementId: AGREEMENTS_MODULE,
  driverId: DRIVERS_MODULE,
  parentTicketId: TICKETS_MODULE,
}

/** The machine's commands as the dialog's buttons read; `start` is sent as it stands, the others open their dialog. */
const COMMAND_LABELS: Readonly<Record<TicketCommandName, string>> = {
  assign: "Assign",
  start: "Start",
  wait: "Waiting for customer",
  hold: "Put on hold",
  complete: "Complete",
  reject: "Reject",
  reopen: "Reopen",
}

/** What each command is told once the API has taken it. */
const COMMAND_DONE: Readonly<Record<TicketCommandName, string>> = {
  assign: "Ticket assigned",
  start: "Ticket started",
  wait: "Ticket waiting for the customer",
  hold: "Ticket on hold",
  complete: "Ticket completed",
  reject: "Ticket rejected",
  reopen: "Ticket reopened",
}

const COMPOSER = {
  internal: { label: "Internal note", hint: "Only the office reads it", placeholder: "Write an internal note…", action: "Add note", done: "Internal note added" },
  customer: { label: "Customer-visible comment", hint: "The customer reads it too", placeholder: "Write a comment the customer reads…", action: "Add comment", done: "Comment added" },
} as const
type Visibility = keyof typeof COMPOSER

function statusClasses(status: string): string {
  if (/completed/i.test(status)) return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
  if (/progress|open/i.test(status)) return "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-200"
  return "border-border bg-muted/60 text-muted-foreground"
}

function priorityClasses(priority: string): string {
  if (/critical|high/i.test(priority)) return "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-200"
  if (/medium/i.test(priority)) return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-200"
  return "border-border bg-muted/60 text-muted-foreground"
}

type Open = { kind: "command"; name: TicketCommandWithForm; values: BusinessFormValues } | { kind: "edit" }

export function LiveTicketDetailsDialog({ record, onClose }: { record: BusinessRecord; onClose: () => void }) {
  const state = useServerModuleState(workspaceId, moduleId)
  // The row as the store now holds it: a command, a patch or a re-read replaces it, and the dialog shows what the API answered.
  const live = state?.records.find((candidate) => candidate.id === record.id) ?? record
  const ready = state?.status === "ready"
  const { upsertRecord, sendAction } = useBusinessRecordStore()
  const pickers = useResolutionPickers()
  const { busy, version, run: send } = useCommandRunner(TICKETS_MODULE, live.id)
  // The comment and the patch answer no command: their own count makes the history read again.
  const [changes, setChanges] = useState(0)
  const reads = useRowHistory(workspaceId, moduleId, live, version + changes, readTicket)
  const userName = useServerNames(ACCESS_MODULE, "user")
  const alertName = useServerNames(ALERTS_MODULE, "alert")
  const [open, setOpen] = useState<Open | null>(null)
  const [message, setMessage] = useState("")
  const [visibility, setVisibility] = useState<Visibility>("internal")
  const [sending, setSending] = useState(false)
  const [saving, setSaving] = useState(false)

  const value = (key: string) => (typeof live.submittedValues?.[key] === "string" ? (live.submittedValues[key] as string) : "")
  const projectId = value("projectId") || live.projectIds?.[0]
  const timezone = pickers.timezoneOf(projectId)
  const status = (value("status") || "open") as TicketStatus
  const label = live.facts.Ticket ?? live.name
  const detail = reads.rows?.[0]
  const offered = ready && !busy && !saving

  const run = (name: TicketCommandName, input?: BusinessFormValues) =>
    send(name, input, (outcome) => {
      setOpen(null)
      toast.success(COMMAND_DONE[name], { description: `${label} is ${outcome.record.status.toLowerCase()}.` })
    })

  const command = (name: TicketCommandName) => {
    if (name === "start") return run("start")
    const values: BusinessFormValues = name === ASSIGN_TICKET ? { assigneeUserAccountId: value("assigneeUserAccountId") || NO_ONE } : {}
    setOpen({ kind: "command", name, values })
  }

  /** The case's patch: one field's change, or the edit's, saved through the store and re-read once the API has it. */
  const save = (values: BusinessFormValues, said: string) => {
    if (saving) return
    setSaving(true)
    whenSaved(
      upsertRecord(workspaceId, moduleId, updateTicketRecord(live, values)),
      () => {
        setOpen(null)
        setChanges((count) => count + 1)
        toast.success(said)
      },
      () => setSaving(false),
    )
  }

  const comment = () => {
    const body = message.trim()
    if (body === "" || sending) return
    setSending(true)
    void commentOnTicket(sendAction, live.id, { body, visibility }).then((outcome) => {
      setSending(false)
      if (outcome.kind !== "done") return
      setMessage("")
      setVisibility("internal")
      setChanges((count) => count + 1)
      toast.success(COMPOSER[visibility].done)
    })
  }

  const machine = TICKET_MACHINE_COMMANDS.filter((name) => offersTicketCommand(status, name, label))
  const links = TICKET_LINKS.flatMap(([key, , fact]) => {
    const webId = value(key)
    if (webId === "") return []
    const name = live.facts[fact] ?? webId
    // A name the store resolved is a loaded row of a switched module: the way there. An id chip has none yet.
    const module = LINK_MODULES[key]
    return [{ key, fact, name, href: name !== webId && module !== undefined ? getBusinessModuleHref(module.workspaceId, module.moduleId, webId) : undefined }]
  })

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="h-[calc(100dvh-1rem)] max-h-[980px] w-[calc(100vw-1rem)] max-w-none gap-0 overflow-hidden rounded-2xl p-0 sm:h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] sm:max-w-[1500px]"
      >
        <div className="flex h-full min-h-0 flex-col lg:flex-row">
          <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
            <header className="flex min-h-[76px] items-center justify-between gap-4 border-b border-border/60 px-4 py-3 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Back to tickets">
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <DialogTitle className="truncate text-lg font-semibold">{live.name}</DialogTitle>
                    <Badge variant="outline" className={cn("rounded-full text-[11px]", statusClasses(live.status))}>
                      {live.status}
                    </Badge>
                  </div>
                  <DialogDescription className="mt-0.5 truncate text-xs sm:text-sm">
                    {label} · {live.facts.Project} · Updated {live.updated.toLowerCase()}
                  </DialogDescription>
                </div>
              </div>
              <Button type="button" variant="outline" size="sm" disabled={!offered} onClick={() => setOpen({ kind: "edit" })}>
                <PencilSimple className="h-4 w-4" />
                <span className="hidden sm:inline">Edit case</span>
              </Button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-7 sm:py-7">
              <div className="mx-auto max-w-4xl space-y-6">
                {!ready && <p className="text-sm text-muted-foreground">The tickets are being read from the API; the ticket&apos;s commands follow.</p>}
                <article className="rounded-xl border border-border/70 bg-card px-4 py-3.5 shadow-sm">
                  <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{live.description}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge variant="outline" className="rounded-full font-normal">
                      {live.facts.Kind}
                    </Badge>
                    <Badge variant="outline" className={cn("rounded-full font-normal", priorityClasses(live.facts.Priority ?? ""))}>
                      {live.facts.Priority} priority
                    </Badge>
                    <Badge variant="outline" className="rounded-full font-normal">
                      Opened via {live.facts["Opened via"]}
                    </Badge>
                  </div>
                </article>

                <section className="space-y-3" aria-label="History">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">History</h3>
                  {reads.problem !== null ? (
                    <p className="text-sm text-destructive">{reads.problem}</p>
                  ) : detail === undefined ? (
                    <p className="text-sm text-muted-foreground">Reading the ticket&apos;s history…</p>
                  ) : (
                    <ol className="space-y-1" data-testid="ticket-history">
                      {detail.events.map((event) => (
                        <HistoryRow key={event.id} event={event} who={event.recordedBy === null ? live.facts["Opened via"] ?? "The system" : userName(event.recordedBy)} assignee={event.assigneeUserAccountId === null ? undefined : userName(event.assigneeUserAccountId)} at={shownOn(event.recordedAt, timezone)} />
                      ))}
                    </ol>
                  )}
                </section>
              </div>
            </div>

            <footer className="border-t border-border/60 bg-background px-4 py-3 sm:px-7 sm:py-4">
              <div className="mx-auto max-w-4xl overflow-hidden rounded-xl border border-border bg-background shadow-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15">
                <div className={cn("flex items-center gap-2 border-b px-3 py-2", visibility === "internal" ? "border-amber-500/20 bg-amber-500/5" : "border-blue-500/20 bg-blue-500/5")}>
                  {visibility === "internal" ? <LockKey className="h-4 w-4 shrink-0 text-amber-600" /> : <ChatCircleText className="h-4 w-4 shrink-0 text-blue-600" />}
                  <div className="flex gap-1" role="radiogroup" aria-label="Who reads it">
                    {(Object.keys(COMPOSER) as Visibility[]).map((mode) => (
                      <Button key={mode} type="button" role="radio" aria-checked={visibility === mode} size="sm" variant={visibility === mode ? "secondary" : "ghost"} className="h-7 text-xs" onClick={() => setVisibility(mode)}>
                        {COMPOSER[mode].label}
                      </Button>
                    ))}
                  </div>
                  <span className="ml-auto hidden text-[11px] text-muted-foreground sm:inline">{COMPOSER[visibility].hint}</span>
                </div>
                <Textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      comment()
                    }
                  }}
                  placeholder={COMPOSER[visibility].placeholder}
                  aria-label={COMPOSER[visibility].label}
                  className="min-h-20 resize-none rounded-none border-0 px-4 py-3 shadow-none focus-visible:ring-0"
                />
                <div className="flex justify-end border-t border-border/60 px-2 py-2">
                  <Button type="button" size="sm" disabled={!ready || sending || message.trim() === ""} onClick={comment}>
                    <PaperPlaneTilt className="h-4 w-4" weight="fill" />
                    {COMPOSER[visibility].action}
                  </Button>
                </div>
              </div>
            </footer>
          </section>

          <aside className="flex h-[45%] min-h-0 w-full shrink-0 flex-col border-t border-border/60 bg-muted/20 lg:h-auto lg:w-[34%] lg:min-w-[420px] lg:border-l lg:border-t-0">
            <div className="flex min-h-[76px] items-center justify-between border-b border-border/60 px-4 sm:px-5">
              <h2 className="text-sm font-semibold">Details</h2>
              <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close ticket details">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
              <section className="space-y-3" data-testid="ticket-commands">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</h3>
                <div className="flex flex-wrap gap-2">
                  {machine.map((name) => (
                    <Button key={name} type="button" variant="outline" size="sm" disabled={!offered} onClick={() => command(name)}>
                      {COMMAND_LABELS[name]}
                    </Button>
                  ))}
                </div>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ticket</h3>
                <div className="mt-3 divide-y divide-border/60 border-y border-border/60">
                  <Row label="Number" value={label} />
                  <PickRow label="Priority" value={value("priority")} tokens={TICKET_PRIORITIES} disabled={!offered} onPick={(token) => save({ priority: token }, "Priority changed")} />
                  <PickRow label="Kind" value={value("kind")} tokens={TICKET_KINDS} disabled={!offered} onPick={(token) => save({ kind: token }, "Kind changed")} />
                  <DueRow value={value("dueAt")} shown={live.facts.Due ?? "None"} disabled={!offered} onSave={(dueAt) => save({ dueAt }, dueAt === "" ? "Due cleared" : "Due changed")} />
                  <Row label="Occurred" value={live.facts.Occurred ?? ""} />
                  {live.facts.Resolution !== undefined && <Row label="Resolution" value={live.facts.Resolution} />}
                  {live.facts["Re-collection route"] !== undefined && <Row label="Re-collection route" value={live.facts["Re-collection route"]} />}
                  {live.facts.Closed !== undefined && <Row label="Closed" value={live.facts.Closed} />}
                </div>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Assignment</h3>
                <div className="mt-3 divide-y divide-border/60 border-y border-border/60">
                  <Row label="Assignee" value={live.owner}>
                    <span className="flex items-center justify-end gap-2">
                      <span className="truncate">{live.owner}</span>
                      {offersTicketCommand(status, ASSIGN_TICKET, label) && (
                        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" aria-label="Change Assignee" disabled={!offered || !pickers.readyFor(TICKET_COMMAND_FORMS.assign)} onClick={() => command(ASSIGN_TICKET)}>
                          Change
                        </Button>
                      )}
                    </span>
                  </Row>
                  <Row label="Opened via" value={live.facts["Opened via"] ?? ""} />
                  <Row label="Project" value={live.facts.Project ?? ""} />
                </div>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What it is about</h3>
                {links.length === 0 ? (
                  <p className="mt-3 text-sm text-muted-foreground">Nothing: a case about itself.</p>
                ) : (
                  <div className="mt-3 divide-y divide-border/60 border-y border-border/60" data-testid="ticket-links">
                    {links.map((link) => (
                      <Row key={link.key} label={link.fact} value={link.name}>
                        {link.href === undefined ? (
                          <span className="rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{link.name}</span>
                        ) : (
                          <Link href={link.href} className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
                            {link.name}
                            <ArrowSquareOut className="h-3.5 w-3.5" />
                          </Link>
                        )}
                      </Row>
                    ))}
                  </div>
                )}
              </section>

              {detail !== undefined && detail.alerts.length > 0 && (
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Alerts</h3>
                  <ul className="mt-3 divide-y divide-border/60 border-y border-border/60 text-sm" data-testid="ticket-alerts">
                    {detail.alerts.map((alert) => (
                      <li key={alert.id} className="flex items-center justify-between gap-2 py-2">
                        <Link href={getBusinessModuleHref(ALERTS_MODULE.workspaceId, ALERTS_MODULE.moduleId, `alert-${alert.id}`)} className="truncate underline-offset-4 hover:underline">
                          {alert.title || alertName(alert.id)}
                        </Link>
                        <Badge variant="outline" className="shrink-0 rounded-full text-[11px]">
                          {statusLabel(alert.severity)} · {statusLabel(alert.status)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </aside>
        </div>
      </DialogContent>
      {open?.kind === "command" && (
        <BusinessRecordFormDialog
          schema={TICKET_COMMAND_FORMS[open.name]}
          open
          onOpenChange={(isOpen) => !isOpen && setOpen(null)}
          onSubmit={(values) => run(open.name, values)}
          relationOptions={(field, values) => pickers.options(field, values, projectId, open.values)}
          initialValueOverrides={open.values}
        />
      )}
      {open?.kind === "edit" && (
        <BusinessRecordFormDialog
          schema={TICKET_EDIT_FORM}
          open
          onOpenChange={(isOpen) => !isOpen && setOpen(null)}
          onSubmit={(values) => save(values, "Ticket saved")}
          relationOptions={(field, values) => pickers.options(field, values, projectId)}
          initialValueOverrides={{ subject: value("subject") || live.name, description: value("description") || live.description }}
        />
      )}
    </Dialog>
  )
}

/** One row of the history: what it is, who and when, and what it said. A comment shows who may read it. */
function HistoryRow({ event, who, assignee, at }: { event: TicketEvent; who: string; assignee: string | undefined; at: string }) {
  const title =
    event.kind === "created"
      ? "Opened"
      : event.kind === "assigned"
        ? assignee === undefined
          ? "Unassigned"
          : `Assigned to ${assignee}`
        : event.kind === "status-changed"
          ? `${statusLabel(event.status)}${event.resolution === null ? "" : ` · ${ticketWord(event.resolution)}`}`
          : event.visibility === "customer"
            ? "Customer-visible comment"
            : "Internal note"
  const isComment = event.kind === "comment"
  return (
    <li className="relative flex gap-3 pb-4" data-kind={event.kind}>
      <span className={cn("relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-background", event.kind === "status-changed" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-600")}>
        {isComment ? (
          event.visibility === "customer" ? <ChatCircleText className="h-4 w-4 text-blue-600" /> : <LockKey className="h-4 w-4 text-amber-600" />
        ) : event.kind === "status-changed" ? (
          <CheckCircle className="h-4 w-4" weight="fill" />
        ) : (
          <ClockCounterClockwise className="h-4 w-4" />
        )}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-sm font-medium">
          {title}
          {isComment && (
            <Badge variant="outline" className={cn("ml-2 rounded-full px-2 py-0 text-[10px] font-medium", event.visibility === "customer" ? "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-200" : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200")}>
              {event.visibility === "customer" ? "Customer" : "Internal"}
            </Badge>
          )}
        </p>
        {event.body !== null && (
          <p className={cn("mt-1 whitespace-pre-wrap text-sm leading-6", isComment ? "rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-foreground" : "text-muted-foreground")}>{event.body}</p>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">
          {who} · {at}
        </p>
      </div>
    </li>
  )
}

function Row({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0 text-right font-medium text-foreground">{children ?? value}</div>
    </div>
  )
}

/** A field of a closed list, changed in place: the patch of that one field. */
function PickRow({ label, value, tokens, disabled, onPick }: { label: string; value: string; tokens: readonly string[]; disabled: boolean; onPick: (token: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" disabled={disabled} aria-label={`Change ${label}`} className="min-h-8 rounded-md px-2 py-1.5 text-right font-medium hover:bg-accent disabled:opacity-60">
            {ticketWord(value)}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="!z-[100] w-56 p-1">
          <div role="listbox" aria-label={label}>
            {tokens.map((token) => (
              <button
                key={token}
                type="button"
                role="option"
                aria-selected={token === value}
                className={cn("flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent", token === value && "font-semibold")}
                onClick={() => {
                  setOpen(false)
                  if (token !== value) onPick(token)
                }}
              >
                {ticketWord(token)}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** The due, changed in place on the project's clock, or cleared. */
function DueRow({ value, shown, disabled, onSave }: { value: string; shown: string; disabled: boolean; onSave: (dueAt: string) => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground">Due</span>
      <Popover
        open={open}
        onOpenChange={(isOpen) => {
          setOpen(isOpen)
          if (isOpen) setDraft(value)
        }}
      >
        <PopoverTrigger asChild>
          <button type="button" disabled={disabled} aria-label="Change Due" className="min-h-8 rounded-md px-2 py-1.5 text-right font-medium hover:bg-accent disabled:opacity-60">
            {shown}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="!z-[100] w-72 space-y-2 p-3">
          <Input type="datetime-local" aria-label="Due" value={draft} onChange={(event) => setDraft(event.target.value)} />
          <div className="flex justify-end gap-2">
            {value !== "" && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpen(false)
                  onSave("")
                }}
              >
                Clear
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              disabled={draft === "" || draft === value}
              onClick={() => {
                setOpen(false)
                onSave(draft)
              }}
            >
              Save
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
