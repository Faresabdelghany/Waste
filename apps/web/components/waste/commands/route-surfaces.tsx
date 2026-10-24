"use client"
// Routes on the Pilot (Issue #179, slice 6 of #81): the command surfaces of
// `route-studio.routes`, `.pickups` and `.live`. New route makes the office's
// own ad-hoc route (#111). A route's details offer the dispatcher's commands
// — assign, dispatch, reschedule, cancel, the stop order (a manual Plan), and
// on a planned or ready route Add stop (#111), a container or an address with
// its fraction — and what the route's own read gives: its stops
// in their sequence, each opening its pickup, its sessions, and the device's
// command log. A stop's details offer remove and correct outcome, with its
// proofs — a photo or a signature shown from the URL the API signs for it
// (O1 of #290) — a live row its sessions and the way to its route. Every command is
// offered whatever the status, and the API's 409 says why one does not apply
// (the rules on #81): a dispatch without a planned driver, a reorder of an
// active route. A route without a Plan is complete — nothing here waits on
// routing. The forms are lib/data/routes.ts's; nothing is offered until the
// module reads the API's rows.
//
// The dispatch day's tooling (O5 of #290): Dispatch day beside New route
// dispatches a project's planned routes of a day, or the ones left ticked, in
// one request and says what became of each; a route's details offer Optimise
// on a route that has not started and list its Plans, the active one marked.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { ArrowDown, ArrowSquareOut, ArrowUp } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { useApiClient } from "@/components/waste/api-session-store"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, useModuleRecords, useServerModuleState } from "@/components/waste/business-record-store"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { CreateSurface } from "@/components/waste/commands/create-surface"
import { ReadRows } from "@/components/waste/commands/read-rows"
import { useCommandRunner, useModuleReady, useOpenRecord, useRelationPickers, useRowHistory, useServerNames } from "@/components/waste/commands/use-command-support"
import type { ApiClient } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import { PLAN_POLL_MS } from "@/lib/map-planning/plan-readings"
import { statusLabel, webIdOf, type CommandInput } from "@/lib/api/records/adapter"
import { shownOn } from "@/lib/api/records/clock"
import { CONTAINERS_MODULE } from "@/lib/api/records/containers"
import { LIVE_MODULE, routeSessions, whileWatched } from "@/lib/api/records/live"
import { CORRECT_PICKUP, PICKUPS_MODULE, pickupProofObjects, pickupProofs, proofLine, proofObjectNoun, REMOVE_PICKUP } from "@/lib/api/records/pickups"
import { ADD_STOP, ASSIGN_ROUTE, callsignOf, CANCEL_ROUTE, DISPATCH_ROUTE, dispatchRoutes, isHeldRoute, OPTIMISE_ROUTE, planLine, RELEASE_HOLD, REORDER_ROUTE, RESCHEDULE_ROUTE, routeCommandLog, routeDetail, routePlans, ROUTES_MODULE } from "@/lib/api/records/routes"
import { DRIVERS_MODULE, VEHICLES_MODULE } from "@/lib/data/allocations"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import { PROPERTIES_MODULE, SHARED_POINTS_MODULE } from "@/lib/data/properties"
import { getModuleDefinition } from "@/lib/data/business-modules"
import { createRouteRecord, DISPATCH_DAY_FORM, dispatchDayRows, PICKUP_COMMAND_FORMS, pickupReasonLabel, ROUTE_COMMAND_FORMS, ROUTE_CREATE_FORM, routeCommandValues, type PickupCommandWithForm, type RouteCommandWithForm } from "@/lib/data/routes"
import type { Pickup } from "@waste/contracts/pickups"
import type { ProofObjectLink } from "@waste/contracts/proof-objects"
import type { ProofOfService } from "@waste/contracts/proofs"
import type { RouteDetail, RouteDispatchResult } from "@waste/contracts/routes"
import type { Session } from "@waste/contracts/sessions"

/** The route's own read, as a one-row history the surface reads again after each command. */
const readRoute = (client: ApiClient, serverId: string) => routeDetail(client, serverId).then((detail): RouteDetail[] => [detail])

/** The command each of the route's dialogs sends. */
const ROUTE_COMMAND_OF: Readonly<Record<RouteCommandWithForm, string>> = { assign: ASSIGN_ROUTE, reschedule: RESCHEDULE_ROUTE, cancel: CANCEL_ROUTE, "add-stop": ADD_STOP }

/** The statuses a stop may be added in (#111): a route that has not started. */
const TAKES_A_STOP = new Set(["planned", "ready"])

/** The routes module's primary actions on the Pilot: Dispatch day (O5 of #290), then New route (#111). */
export function RoutesPrimarySurface() {
  return (
    <>
      <DispatchDaySurface />
      <NewRouteSurface />
    </>
  )
}

/** One route's answer in Dispatch day, as the dialog lists it: its label, and what became of it. */
const dispatchedLine = (result: RouteDispatchResult, label: string): string => (result.outcome === "dispatched" ? `${label} · Dispatched` : `${label} · Not dispatched: ${result.detail}`)

/**
 * Dispatch day (O5 of #290): a project's day, then its planned routes, each
 * ticked, dispatched in one request (`POST /routes/dispatch`) and answered
 * route by route — a route its own dispatch refuses (no planned driver) is
 * listed with the API's sentence and the rest go ahead. The routes and the
 * Live board are read again after, since each dispatched route moved.
 */
function DispatchDaySurface() {
  const client = useApiClient()
  const { refreshModule } = useBusinessRecordStore()
  const pickers = useRelationPickers()
  const moduleReady = useModuleReady(ROUTES_MODULE)
  const routes = useModuleRecords(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId, getModuleDefinition(ROUTES_MODULE)?.records ?? [])
  const routeState = useServerModuleState(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId)
  const [step, setStep] = useState<"closed" | "day" | "routes">("closed")
  const [day, setDay] = useState<{ projectId: string; operatingDate: string } | null>(null)
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set())
  const [answered, setAnswered] = useState<readonly { line: string; dispatched: boolean }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const offered = dispatchDayRows(routes.records, day?.projectId, day?.operatingDate ?? "")
  const picked = offered.filter((record) => !unticked.has(record.id))

  const pickDay = (values: BusinessFormValues) => {
    const projectId = typeof values.projectId === "string" ? values.projectId : ""
    const operatingDate = typeof values.operatingDate === "string" ? values.operatingDate : ""
    setDay({ projectId, operatingDate })
    setUnticked(new Set())
    setAnswered(null)
    setStep("routes")
  }

  const dispatchPicked = () => {
    if (busy || client === null || picked.length === 0) return
    const serverIdOf = (webId: string) => routeState?.serverIds.get(webId)
    const named = picked.flatMap((record) => {
      const serverId = serverIdOf(record.id)
      return serverId === undefined ? [] : [{ serverId, label: record.name }]
    })
    // A row the store holds no server id for has not been read from the API: it is said so, never left out unseen.
    const unread = picked.filter((record) => serverIdOf(record.id) === undefined).map((record) => ({ line: `${record.name} · Not dispatched: not read from the API yet`, dispatched: false }))
    setBusy(true)
    dispatchRoutes(
      client,
      named.map((route) => route.serverId),
    )
      .then(
        ({ results }) => {
          const labelOf = new Map(named.map((route) => [route.serverId, route.label]))
          const lines = [...results.map((result) => ({ line: dispatchedLine(result, result.outcome === "dispatched" ? result.route.label : (labelOf.get(result.routeId) ?? result.routeId)), dispatched: result.outcome === "dispatched" })), ...unread]
          setAnswered(lines)
          const dispatched = lines.filter((line) => line.dispatched).length
          const said = `${dispatched} of ${lines.length} ${lines.length === 1 ? "route" : "routes"} dispatched`
          if (dispatched === lines.length) toast.success(said, { description: "Each reaches its driver's device." })
          else toast.error(said, { description: `${lines.length - dispatched} not dispatched: the dialog says why.` })
          // Every dispatched route moved, and the Live board reads the routes' rows.
          void refreshModule(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId)
          void refreshModule(LIVE_MODULE.workspaceId, LIVE_MODULE.moduleId)
        },
        (error: unknown) => toast.error("The routes were not dispatched", { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setBusy(false))
  }

  const close = () => {
    if (busy) return
    setStep("closed")
    setAnswered(null)
  }

  return (
    <>
      <Button size="sm" variant="outline" disabled={!moduleReady || client === null || !pickers.readyFor(DISPATCH_DAY_FORM)} onClick={() => setStep("day")}>
        Dispatch day
      </Button>
      {step === "day" && (
        <BusinessRecordFormDialog
          schema={DISPATCH_DAY_FORM}
          open
          onOpenChange={(isOpen) => !isOpen && setStep("closed")}
          onSubmit={pickDay}
          relationOptions={(field, values) => pickers.options(field, values, undefined, {})}
          initialValueOverrides={day ?? {}}
        />
      )}
      {step === "routes" && day !== null && (
        <Dialog open onOpenChange={(isOpen) => !isOpen && close()}>
          <DialogContent className="sm:max-w-xl" data-testid="dispatch-day">
            <DialogHeader>
              <DialogTitle>Dispatch day</DialogTitle>
              <DialogDescription>The planned routes running on {day.operatingDate}. Each one ticked goes to its planned driver; a route without one is refused and stays planned.</DialogDescription>
            </DialogHeader>
            {answered !== null ? (
              <ol className="divide-y divide-border/60 border-y border-border/60 text-sm" data-testid="dispatch-day-results">
                {answered.map((answer) => (
                  <li key={answer.line} className={answer.dispatched ? "py-1.5" : "py-1.5 text-destructive"}>
                    {answer.line}
                  </li>
                ))}
              </ol>
            ) : offered.length === 0 ? (
              <p className="text-sm text-muted-foreground">No planned route runs that day.</p>
            ) : (
              <ul className="divide-y divide-border/60 border-y border-border/60 text-sm" data-testid="dispatch-day-routes">
                {offered.map((record) => (
                  <DispatchDayRow key={record.id} checked={!unticked.has(record.id)} onToggle={(checked) => setUnticked((was) => toggled(was, record.id, !checked))}>
                    {[record.name, record.facts.Driver ?? "No planned driver", record.facts.Vehicle].filter(Boolean).join(" · ")}
                  </DispatchDayRow>
                ))}
              </ul>
            )}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={close}>
                {answered === null ? "Back" : "Close"}
              </Button>
              {answered === null && (
                <Button disabled={busy || picked.length === 0} onClick={dispatchPicked}>
                  Dispatch {picked.length} {picked.length === 1 ? "route" : "routes"}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

/** The set with `id` in it or out of it. */
const toggled = (set: ReadonlySet<string>, id: string, inIt: boolean): ReadonlySet<string> => {
  const next = new Set(set)
  if (inIt) next.add(id)
  else next.delete(id)
  return next
}

/** One route Dispatch day offers, ticked unless left out. */
function DispatchDayRow({ checked, onToggle, children }: { checked: boolean; onToggle: (checked: boolean) => void; children: ReactNode }) {
  return (
    <li className="py-1.5">
      <label className="flex items-center gap-2">
        <Checkbox checked={checked} onCheckedChange={(state) => onToggle(state === true)} />
        <span>{children}</span>
      </label>
    </li>
  )
}

/** New route (#111): the office's own ad-hoc route, planned on a project's day; its stops are added next. Named for what it makes, not the fixture module's "Create route". */
export function NewRouteSurface() {
  return (
    <CreateSurface
      label="New route"
      module={ROUTES_MODULE}
      schema={ROUTE_CREATE_FORM}
      make={(values, now) => createRouteRecord(values, { now })}
      created={() => ({ title: "Route created", description: "It is planned with no stops: add its stops, then dispatch it to its driver." })}
    />
  )
}

/** "Mads Jensen · WH-31" for a session: who drove, with what. */
function useSessionLine(): (session: Session, timezone: string | undefined) => string {
  const driverName = useServerNames(DRIVERS_MODULE, "driver")
  const vehicleName = useServerNames(VEHICLES_MODULE, "vehicle")
  return (session, timezone) =>
    `${shownOn(session.startedAt, timezone)} → ${session.endedAt === null ? (session.pausedAt === null ? "open" : "paused") : shownOn(session.endedAt, timezone)} · ${driverName(session.driverId)} · ${callsignOf(vehicleName(session.vehicleId))}`
}

/** What each of the route's commands is told once the API has taken it. */
const DONE: Readonly<Record<string, (name: string) => string>> = {
  [ASSIGN_ROUTE]: (name) => `${name} assigned`,
  [DISPATCH_ROUTE]: (name) => `${name} dispatched`,
  [RESCHEDULE_ROUTE]: (name) => `${name} rescheduled`,
  [CANCEL_ROUTE]: (name) => `${name} cancelled`,
  [REORDER_ROUTE]: (name) => `The stops of ${name} are reordered`,
  [RELEASE_HOLD]: (name) => `${name} handed back to its scheme`,
  [ADD_STOP]: (name) => `A stop was added to ${name}`,
  [OPTIMISE_ROUTE]: (name) => `A Plan was asked for ${name}`,
}

/** What each command's toast says beneath its title: where it now stands, or, for a hand-back, what is still to come (#226). */
const DONE_SAYS: Readonly<Record<string, string>> = {
  [RELEASE_HOLD]: "The next generation run brings back the scheme's day, start and assignment.",
  [ADD_STOP]: "It goes after the route's last stop, and generation never moves or skips it.",
  [OPTIMISE_ROUTE]: "Its open stops are ordered and measured; the Plan's distance and duration follow once it is ready.",
}

type RouteOpen = { kind: "form"; name: RouteCommandWithForm; values: BusinessFormValues } | { kind: "reorder"; order: string[] }

/** A route's commands, its stops in sequence, its sessions and the device's command log, in its details. */
export function RouteCommandsSurface({ record }: RowSurfaceProps) {
  const pickers = useRelationPickers()
  const moduleReady = useModuleReady(ROUTES_MODULE)
  // The version is bumped after each command the API took: the stops and the log are the route's own reads.
  const { busy, version, run: send } = useCommandRunner(ROUTES_MODULE, record.id)
  const { refreshRecord } = useBusinessRecordStore()
  // A Plan still being measured — an optimisation just asked — is read again on the map's cadence (O5 of #290), the route's own read with it.
  const [measuring, setMeasuring] = useState(0)
  const reads = useRowHistory(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId, record, version + measuring, readRoute)
  const log = useRowHistory(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId, record, version, routeCommandLog)
  const plans = useRowHistory(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId, record, version + measuring, routePlans)
  const calculating = plans.rows?.some((plan) => plan.status === "calculating") ?? false
  useEffect(() => {
    if (!calculating) return
    const timer = setTimeout(() => setMeasuring((reads) => reads + 1), PLAN_POLL_MS)
    return () => clearTimeout(timer)
  }, [calculating, measuring])
  // Once none is measuring any more, the row is read back: its distance and duration are the active Plan's.
  const wasCalculating = useRef(false)
  useEffect(() => {
    if (wasCalculating.current && !calculating) void refreshRecord(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId, record.id)
    wasCalculating.current = calculating
  }, [calculating, record.id, refreshRecord])
  const containerName = useServerNames(CONTAINERS_MODULE, "asset")
  const propertyName = useServerNames(PROPERTIES_MODULE, "property")
  const pointName = useServerNames(SHARED_POINTS_MODULE, "shared-point")
  const sessionLine = useSessionLine()
  const openPickup = useOpenRecord(PICKUPS_MODULE.moduleId)
  const [open, setOpen] = useState<RouteOpen | null>(null)
  const projectId = typeof record.submittedValues?.projectId === "string" ? record.submittedValues.projectId : undefined
  const timezone = pickers.timezoneOf(projectId)
  const detail = reads.rows?.[0]
  const openStops = detail?.pickups.filter((pickup) => pickup.status === "planned") ?? []

  const run = (name: string, input?: CommandInput) =>
    send(name, input, (outcome) => {
      setOpen(null)
      toast.success(DONE[name]?.(outcome.record.name) ?? `${outcome.record.name} updated`, { description: DONE_SAYS[name] ?? `Status: ${outcome.record.status}` })
    })

  const offered = moduleReady && !busy
  const status = typeof record.submittedValues?.status === "string" ? record.submittedValues.status : ""
  const openForm = (name: RouteCommandWithForm) => setOpen({ kind: "form", name, values: name === "assign" || name === "reschedule" ? routeCommandValues(record) : {} })
  // An address-only stop the office added (#111) names no container: it is named by the place it is collected at.
  const stopName = (pickup: Pickup) => {
    if (pickup.containerId !== null) return containerName(pickup.containerId)
    if (pickup.propertyId !== null) return propertyName(pickup.propertyId)
    return pickup.sharedCollectionPointId === null ? "A stop with no place" : pointName(pickup.sharedCollectionPointId)
  }
  const stopLine = (pickup: Pickup & { sequence?: number }) =>
    `${pickup.sequence ?? pickup.position}. ${stopName(pickup)} · ${statusLabel(pickup.status)}${pickup.reason === null ? "" : ` · ${pickupReasonLabel(pickup.reason)}`}${pickup.origin === "office" ? " · added by the office" : ""}`

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
        {/* A route the office holds goes back to its scheme on a word: the next generation run brings back its day, start and assignment (#226). */}
        {isHeldRoute(record) && record.submittedValues?.status === "planned" && (
          <Button variant="outline" size="sm" disabled={!offered} onClick={() => run(RELEASE_HOLD)}>
            Release hold
          </Button>
        )}
        {/* A stop of the office's own goes onto a route that has not started (#111). */}
        {TAKES_A_STOP.has(status) && (
          <Button variant="outline" size="sm" disabled={!offered || !pickers.readyFor(ROUTE_COMMAND_FORMS["add-stop"])} onClick={() => openForm("add-stop")}>
            Add stop
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={!offered || detail === undefined || openStops.length < 2} onClick={() => setOpen({ kind: "reorder", order: openStops.map((pickup) => pickup.id) })}>
          Reorder stops
        </Button>
        {/* A Plan over the open stops, on a route that has not started (O5 of #290): the optimiser's order, or a measured baseline where it cannot take the route. */}
        {TAKES_A_STOP.has(status) && (
          <Button variant="outline" size="sm" disabled={!offered || detail === undefined || openStops.length === 0} onClick={() => run(OPTIMISE_ROUTE)}>
            Optimise
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={!offered} onClick={() => openForm("cancel")}>
          Cancel route
        </Button>
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Stops, in the order they will be visited</h4>
        <ReadRows
          read={{ rows: detail?.pickups ?? null, problem: reads.problem }}
          label="Reading the route's stops…"
          empty={record.facts.Origin === undefined ? "No stop: generation matched no container for this route." : "No stop yet: add the route's stops."}
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
        <h4 className="text-xs font-medium text-muted-foreground">Plans</h4>
        <ReadRows
          read={plans}
          label="Reading the route's Plans…"
          empty="No Plan yet: the generated order stands unmeasured."
          testId="route-plans"
          line={(plan) => planLine(plan, { activePlanId: detail?.activePlan?.id, timezone })}
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
          line={(receipt) => `${shownOn(receipt.occurredAt, timezone)} · ${statusLabel(receipt.kind)} · ${statusLabel(receipt.outcome)}${receipt.problem?.detail ? ` · ${receipt.problem.detail}` : ""}`}
        />
      </div>
      {open?.kind === "form" && (
        <BusinessRecordFormDialog
          schema={ROUTE_COMMAND_FORMS[open.name]}
          open
          onOpenChange={(isOpen) => !isOpen && setOpen(null)}
          onSubmit={(values) => run(ROUTE_COMMAND_OF[open.name], values)}
          relationOptions={(field, values) => pickers.options(field, values, projectId)}
          initialValueOverrides={open.values}
        />
      )}
      {open?.kind === "reorder" && (
        <ReorderStopsDialog
          order={open.order}
          label={(id) => {
            const pickup = detail?.pickups.find((candidate) => candidate.id === id)
            return pickup === undefined ? id : stopName(pickup)
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

/** A proof's photo or signature beside its line: the picture from its signed URL, opening it whole, or why there is none to show. */
function ProofObject({ proof, links }: { proof: ProofOfService; links: { rows: ProofObjectLink[] | null; problem: string | null } }) {
  if (proof.objectKey === null || links.rows === null) return null
  const noun = proofObjectNoun(proof)
  const link = links.rows.find((candidate) => candidate.proofId === proof.id)
  if (link?.url == null) return <p className="mt-1 text-xs text-muted-foreground">The {noun} is no longer stored.</p>
  return (
    <a href={link.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-2 text-xs underline-offset-2 hover:underline">
      {/* A private object's signed URL, which next/image would fetch through the server. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={link.url} alt={`The ${noun} recorded at this stop`} className="h-16 w-16 rounded border bg-white object-contain" />
      Open {noun}
    </a>
  )
}

/** No read of a stop's objects, for a stop whose proofs name none. */
const NO_PROOF_OBJECTS = async (): Promise<ProofObjectLink[]> => []

/** How long before its read URLs lapse a stop's objects are read again, so a details left open never offers a dead link. */
const RENEW_BEFORE_MS = 30_000

/** A stop's commands and its proofs, in its details. */
export function PickupCommandsSurface({ record }: RowSurfaceProps) {
  const pickers = useRelationPickers()
  const moduleReady = useModuleReady(PICKUPS_MODULE)
  const { busy, version, run: send } = useCommandRunner(PICKUPS_MODULE, record.id)
  const proofs = useRowHistory(PICKUPS_MODULE.workspaceId, PICKUPS_MODULE.moduleId, record, version, pickupProofs)
  // The objects' read URLs are asked for only where a proof names an object, and asked again before they lapse.
  const withObjects = proofs.rows?.some((proof) => proof.objectKey !== null) ?? false
  const [renewals, setRenewals] = useState(0)
  const objects = useRowHistory(PICKUPS_MODULE.workspaceId, PICKUPS_MODULE.moduleId, record, `${version}:${withObjects}:${renewals}`, withObjects ? pickupProofObjects : NO_PROOF_OBJECTS)
  const lapsesAt = objects.rows?.reduce<number | null>((soonest, link) => Math.min(soonest ?? Infinity, Date.parse(link.expiresAt)), null) ?? null
  useEffect(() => {
    if (lapsesAt === null) return
    const renew = setTimeout(() => setRenewals((count) => count + 1), Math.max(0, lapsesAt - RENEW_BEFORE_MS - Date.now()))
    return () => clearTimeout(renew)
  }, [lapsesAt])
  const openRoute = useOpenRecord(ROUTES_MODULE.moduleId)
  const [open, setOpen] = useState<PickupCommandWithForm | null>(null)
  const projectId = record.projectIds?.[0]
  const timezone = pickers.timezoneOf(projectId)
  const routeId = typeof record.submittedValues?.routeId === "string" ? record.submittedValues.routeId : undefined

  const run = (name: PickupCommandWithForm, values: BusinessFormValues) =>
    send(name === "remove" ? REMOVE_PICKUP : CORRECT_PICKUP, values, (outcome) => {
      setOpen(null)
      toast.success(PICKUP_COMMAND_FORMS[name].execution?.completionMessage ?? "Recorded", { description: `${outcome.record.name} is now ${outcome.record.status.toLowerCase()}.` })
    })

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
          line={(proof) => (
            <>
              <span>{proofLine(proof, timezone)}</span>
              <ProofObject proof={proof} links={objects} />
            </>
          )}
        />
        {objects.problem !== null && proofs.rows?.some((proof) => proof.objectKey !== null) && <p className="text-xs text-muted-foreground">{objects.problem}</p>}
      </div>
      {open !== null && <BusinessRecordFormDialog schema={PICKUP_COMMAND_FORMS[open]} open onOpenChange={(isOpen) => !isOpen && setOpen(null)} onSubmit={(values) => run(open, values)} relationOptions={pickers.options} />}
    </section>
  )
}

/** A live route's sessions, and the way to the route itself, in its details. */
/**
 * Mounted beside the Live board while it is shown (the registry's
 * `whileShown`), rendering nothing: the board is read again every 30 s
 * through the store's `refreshModule` — #213's re-read exposed, no second
 * read path — on one interval, cleared when the board is left.
 */
export function LiveBoardRefresh() {
  const { refreshModule } = useBusinessRecordStore()
  useEffect(() => whileWatched(() => void refreshModule(LIVE_MODULE.workspaceId, LIVE_MODULE.moduleId)), [refreshModule])
  return null
}

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
