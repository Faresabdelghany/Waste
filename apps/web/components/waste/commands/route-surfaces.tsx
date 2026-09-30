"use client"
// Routes on the Pilot (Issue #179, slice 6 of #81): the command surfaces of
// `route-studio.routes`, `.pickups` and `.live`. A route's details offer the
// dispatcher's five commands — assign, dispatch, reschedule, cancel, and the
// stop order (a manual Plan) — and what the route's own read gives: its stops
// in their sequence, each opening its pickup, its sessions, and the device's
// command log. A stop's details offer remove and correct outcome, with its
// proofs; a live row its sessions and the way to its route. Every command is
// offered whatever the status, and the API's 409 says why one does not apply
// (the rules on #81): a dispatch without a planned driver, a reorder of an
// active route. A route without a Plan is complete — nothing here waits on
// routing. The forms are lib/data/routes.ts's; nothing is offered until the
// module reads the API's rows.
import { useState, type ReactNode } from "react"
import { ArrowDown, ArrowSquareOut, ArrowUp } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore } from "@/components/waste/business-record-store"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { useModuleReady, useOpenRecord, useRelationPickers, useRowHistory, useServerNames } from "@/components/waste/commands/use-command-support"
import type { ApiClient } from "@/lib/api/client"
import { webIdOf, type CommandInput } from "@/lib/api/records/adapter"
import { shownOn } from "@/lib/api/records/clock"
import { CONTAINERS_MODULE } from "@/lib/api/records/containers"
import { LIVE_MODULE, routeSessions } from "@/lib/api/records/live"
import { CORRECT_PICKUP, PICKUPS_MODULE, pickupProofs, REMOVE_PICKUP } from "@/lib/api/records/pickups"
import { ASSIGN_ROUTE, CANCEL_ROUTE, DISPATCH_ROUTE, REORDER_ROUTE, RESCHEDULE_ROUTE, routeCommandLog, routeDetail, ROUTES_MODULE } from "@/lib/api/records/routes"
import { DRIVERS_MODULE, VEHICLES_MODULE } from "@/lib/data/allocations"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import { PICKUP_COMMAND_FORMS, ROUTE_COMMAND_FORMS, routeCommandValues, type PickupCommandWithForm, type RouteCommandWithForm } from "@/lib/data/routes"
import type { Pickup } from "@waste/contracts/pickups"
import type { RouteDetail } from "@waste/contracts/routes"
import type { Session } from "@waste/contracts/sessions"

/** The route's own read, as a one-row history the surface reads again after each command. */
const readRoute = (client: ApiClient, serverId: string) => routeDetail(client, serverId).then((detail): RouteDetail[] => [detail])

/** A status token as a person reads it. */
const word = (token: string) => token.charAt(0).toUpperCase() + token.slice(1).replace(/-/g, " ")

/** A read's rows, or the sentence of its refusal, or that it is being read. */
function ReadRows<T>({ read, empty, label, testId, line }: { read: { rows: T[] | null; problem: string | null }; empty: string; label: string; testId: string; line: (row: T, index: number) => ReactNode }) {
  if (read.problem !== null) return <p className="text-sm text-destructive">{read.problem}</p>
  if (read.rows === null) return <p className="text-sm text-muted-foreground">{label}</p>
  if (read.rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>
  return (
    <ol className="divide-y divide-border/60 border-y border-border/60 text-sm" data-testid={testId}>
      {read.rows.map((row, index) => (
        <li key={index} className="py-2">
          {line(row, index)}
        </li>
      ))}
    </ol>
  )
}

/** "Mads Jensen · WH-31" for a session: who drove, with what. */
function useSessionLine(): (session: Session, timezone: string | undefined) => string {
  const driverName = useServerNames(DRIVERS_MODULE, "driver")
  const vehicleName = useServerNames(VEHICLES_MODULE, "vehicle")
  return (session, timezone) =>
    `${shownOn(session.startedAt, timezone)} → ${session.endedAt === null ? (session.pausedAt === null ? "open" : "paused") : shownOn(session.endedAt, timezone)} · ${driverName(session.driverId)} · ${vehicleName(session.vehicleId).split(" · ")[0]}`
}

/** What each of the route's commands is told once the API has taken it. */
const DONE: Readonly<Record<string, (name: string) => string>> = {
  [ASSIGN_ROUTE]: (name) => `${name} assigned`,
  [DISPATCH_ROUTE]: (name) => `${name} dispatched`,
  [RESCHEDULE_ROUTE]: (name) => `${name} rescheduled`,
  [CANCEL_ROUTE]: (name) => `${name} cancelled`,
  [REORDER_ROUTE]: (name) => `The stops of ${name} are reordered`,
}

type RouteOpen = { kind: "form"; name: RouteCommandWithForm; values: BusinessFormValues } | { kind: "reorder"; order: string[] }

/** A route's commands, its stops in sequence, its sessions and the device's command log, in its details. */
export function RouteCommandsSurface({ record }: RowSurfaceProps) {
  const { sendCommand } = useBusinessRecordStore()
  const pickers = useRelationPickers()
  const moduleReady = useModuleReady(ROUTES_MODULE)
  // Bumped after each command the surface sends: the stops and the log are the route's own reads.
  const [version, setVersion] = useState(0)
  const reads = useRowHistory(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId, record, version, readRoute)
  const log = useRowHistory(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId, record, version, routeCommandLog)
  const containerName = useServerNames(CONTAINERS_MODULE, "asset")
  const sessionLine = useSessionLine()
  const openPickup = useOpenRecord(PICKUPS_MODULE.moduleId)
  const [open, setOpen] = useState<RouteOpen | null>(null)
  const [busy, setBusy] = useState(false)
  const projectId = typeof record.submittedValues?.projectId === "string" ? record.submittedValues.projectId : undefined
  const timezone = pickers.timezoneOf(projectId)
  const detail = reads.rows?.[0]
  const openStops = detail?.pickups.filter((pickup) => pickup.status === "planned") ?? []

  const run = (name: string, input?: CommandInput) => {
    if (busy) return
    setBusy(true)
    void sendCommand(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId, record.id, name, input).then((outcome) => {
      setBusy(false)
      if (outcome.kind !== "done") return
      setOpen(null)
      setVersion((current) => current + 1)
      toast.success(DONE[name]?.(outcome.record.name) ?? `${outcome.record.name} updated`, { description: `Status: ${outcome.record.status}` })
    })
  }

  const offered = moduleReady && !busy
  const openForm = (name: RouteCommandWithForm) => setOpen({ kind: "form", name, values: name === "cancel" ? {} : routeCommandValues(record) })
  const stopLine = (pickup: Pickup & { sequence?: number }) => `${pickup.sequence ?? pickup.position}. ${containerName(pickup.containerId)} · ${word(pickup.status)}${pickup.reason === null ? "" : ` · ${word(pickup.reason)}`}`

  return (
    <section className="space-y-4" data-testid="route-commands">
      <h3 className="text-sm font-semibold">Route commands</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The routes are being read from the API; their commands follow.</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!offered || !pickers.readyFor(ROUTE_COMMAND_FORMS.assign)} onClick={() => openForm("assign")}>
          Assign
        </Button>
        <Button variant="outline" size="sm" disabled={!offered} onClick={() => run(DISPATCH_ROUTE)}>
          Dispatch
        </Button>
        <Button variant="outline" size="sm" disabled={!offered} onClick={() => openForm("reschedule")}>
          Reschedule
        </Button>
        <Button variant="outline" size="sm" disabled={!offered || detail === undefined || openStops.length < 2} onClick={() => setOpen({ kind: "reorder", order: openStops.map((pickup) => pickup.id) })}>
          Reorder stops
        </Button>
        <Button variant="outline" size="sm" disabled={!offered} onClick={() => openForm("cancel")}>
          Cancel route
        </Button>
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Stops, in the order they will be visited</h4>
        <ReadRows
          read={{ rows: detail?.pickups ?? null, problem: reads.problem }}
          label="Reading the route's stops…"
          empty="No stop: generation matched no container for this route."
          testId="route-stops"
          line={(pickup) => (
            <span className="flex items-center justify-between gap-2">
              <span>{stopLine(pickup)}</span>
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => openPickup(webIdOf("pickup", pickup.id))}>
                Open stop
                <ArrowSquareOut className="h-3.5 w-3.5" />
              </Button>
            </span>
          )}
        />
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Sessions</h4>
        <ReadRows read={{ rows: detail?.sessions ?? null, problem: reads.problem }} label="Reading the route's sessions…" empty="Not started: no driver has started this route." testId="route-sessions" line={(session) => sessionLine(session, timezone)} />
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Driver app commands</h4>
        <ReadRows
          read={log}
          label="Reading the device's command log…"
          empty="The driver's device has sent nothing for this route."
          testId="route-command-log"
          line={(receipt) => `${shownOn(receipt.occurredAt, timezone)} · ${word(receipt.kind)} · ${word(receipt.outcome)}${receipt.problem?.detail ? ` · ${receipt.problem.detail}` : ""}`}
        />
      </div>
      {open?.kind === "form" && (
        <BusinessRecordFormDialog
          schema={ROUTE_COMMAND_FORMS[open.name]}
          open
          onOpenChange={(isOpen) => !isOpen && setOpen(null)}
          onSubmit={(values) => run(open.name === "assign" ? ASSIGN_ROUTE : open.name === "reschedule" ? RESCHEDULE_ROUTE : CANCEL_ROUTE, values)}
          relationOptions={(field, values) => pickers.options(field, values, projectId)}
          initialValueOverrides={open.values}
        />
      )}
      {open?.kind === "reorder" && (
        <ReorderStopsDialog
          order={open.order}
          label={(id) => {
            const pickup = detail?.pickups.find((candidate) => candidate.id === id)
            return pickup === undefined ? id : containerName(pickup.containerId)
          }}
          busy={busy}
          onChange={(order) => setOpen({ kind: "reorder", order })}
          onClose={() => setOpen(null)}
          onSave={(order) => run(REORDER_ROUTE, { pickupIds: order.map((id) => webIdOf("pickup", id)) })}
        />
      )}
    </section>
  )
}

/** The route's open stops in the order they will be visited, each moved up or down; the whole order is sent. */
function ReorderStopsDialog({ order, label, busy, onChange, onClose, onSave }: { order: string[]; label: (id: string) => string; busy: boolean; onChange: (order: string[]) => void; onClose: () => void; onSave: (order: string[]) => void }) {
  const move = (index: number, by: number) => {
    const next = [...order]
    const [moved] = next.splice(index, 1)
    next.splice(index + by, 0, moved)
    onChange(next)
  }
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reorder stops</DialogTitle>
          <DialogDescription>The open stops in the order the driver will visit them. The order becomes the route&apos;s Plan; the stops already decided keep their place.</DialogDescription>
        </DialogHeader>
        <ol className="divide-y divide-border/60 border-y border-border/60 text-sm" data-testid="reorder-stops">
          {order.map((id, index) => (
            <li key={id} className="flex items-center justify-between gap-2 py-1.5">
              <span>
                {index + 1}. {label(id)}
              </span>
              <span className="flex gap-1">
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Move ${label(id)} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Move ${label(id)} down`} disabled={index === order.length - 1} onClick={() => move(index, 1)}>
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
              </span>
            </li>
          ))}
        </ol>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Back
          </Button>
          <Button disabled={busy} onClick={() => onSave(order)}>
            Save order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A stop's commands and its proofs, in its details. */
export function PickupCommandsSurface({ record }: RowSurfaceProps) {
  const { sendCommand } = useBusinessRecordStore()
  const pickers = useRelationPickers()
  const moduleReady = useModuleReady(PICKUPS_MODULE)
  const [version, setVersion] = useState(0)
  const proofs = useRowHistory(PICKUPS_MODULE.workspaceId, PICKUPS_MODULE.moduleId, record, version, pickupProofs)
  const openRoute = useOpenRecord(ROUTES_MODULE.moduleId)
  const [open, setOpen] = useState<PickupCommandWithForm | null>(null)
  const [busy, setBusy] = useState(false)
  const projectId = record.projectIds?.[0]
  const timezone = pickers.timezoneOf(projectId)
  const routeId = typeof record.submittedValues?.routeId === "string" ? record.submittedValues.routeId : undefined

  const run = (name: PickupCommandWithForm, values: BusinessFormValues) => {
    if (busy) return
    setBusy(true)
    void sendCommand(PICKUPS_MODULE.workspaceId, PICKUPS_MODULE.moduleId, record.id, name === "remove" ? REMOVE_PICKUP : CORRECT_PICKUP, values).then((outcome) => {
      setBusy(false)
      if (outcome.kind !== "done") return
      setOpen(null)
      setVersion((current) => current + 1)
      toast.success(PICKUP_COMMAND_FORMS[name].execution?.completionMessage ?? "Recorded", { description: `${outcome.record.name} is now ${outcome.record.status.toLowerCase()}.` })
    })
  }

  return (
    <section className="space-y-4" data-testid="pickup-commands">
      <h3 className="text-sm font-semibold">Stop commands</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The stops are being read from the API; their commands follow.</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setOpen("remove")}>
          Remove stop
        </Button>
        <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setOpen("correct")}>
          Correct outcome
        </Button>
        {routeId !== undefined && (
          <Button variant="ghost" size="sm" className="gap-1" onClick={() => openRoute(routeId)}>
            Open route
            <ArrowSquareOut className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Proofs of service</h4>
        <ReadRows
          read={proofs}
          label="Reading the stop's proofs…"
          empty="No proof yet."
          testId="pickup-proofs"
          line={(proof) => `${shownOn(proof.occurredAt, timezone)} · ${word(proof.kind)} · ${word(proof.source)}${proof.outcome ? ` · ${word(proof.outcome)}` : ""}${proof.note ? ` · ${proof.note}` : ""}`}
        />
      </div>
      {open !== null && <BusinessRecordFormDialog schema={PICKUP_COMMAND_FORMS[open]} open onOpenChange={(isOpen) => !isOpen && setOpen(null)} onSubmit={(values) => run(open, values)} relationOptions={pickers.options} />}
    </section>
  )
}

/** A live route's sessions, and the way to the route itself, in its details. */
export function LiveRouteSurface({ record }: RowSurfaceProps) {
  const pickers = useRelationPickers()
  const sessions = useRowHistory(LIVE_MODULE.workspaceId, LIVE_MODULE.moduleId, record, 0, routeSessions)
  const sessionLine = useSessionLine()
  const openRoute = useOpenRecord(ROUTES_MODULE.moduleId)
  const timezone = pickers.timezoneOf(record.projectIds?.[0])
  return (
    <section className="space-y-4" data-testid="live-route">
      <div className="flex flex-wrap gap-2">
        {/* A live row is its route under the route's own web id: its commands are the route's. */}
        <Button variant="outline" size="sm" className="gap-1" onClick={() => openRoute(record.id)}>
          Open route
          <ArrowSquareOut className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Sessions</h4>
        <ReadRows read={sessions} label="Reading the route's sessions…" empty="Not started: no driver has started this route." testId="live-sessions" line={(session) => sessionLine(session, timezone)} />
      </div>
    </section>
  )
}
