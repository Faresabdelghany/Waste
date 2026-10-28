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
//
// Balance day (O15 of #290) beside it weighs a project's day, proposes moving
// stops off the routes over their payload or shift, and moves the ticked ones
// with the proposal's token.
//
// Moving stops (O23 of #290): on a route that has not started, Move stops
// sends ticked open stops to another route of the project, Split route sends
// them to a new route of its day, and Merge route takes in every open stop of
// another route and cancels it as merged; the other route is one
// `routesToJoin` offers, and the API judges each stop where it goes.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { ArrowDown, ArrowSquareOut, ArrowUp } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useApiClient } from "@/components/waste/api-session-store"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, useModuleRecords, useServerModuleState } from "@/components/waste/business-record-store"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { CreateSurface } from "@/components/waste/commands/create-surface"
import { ReadRows } from "@/components/waste/commands/read-rows"
import { useCommandRunner, useModuleReady, useOpenRecord, useRelationPickers, useRowHistory, useServerNames } from "@/components/waste/commands/use-command-support"
import { useCommandOffered } from "@/components/waste/provider-account"
import { useProofObjectLinks } from "@/components/waste/commands/use-proof-object-links"
import type { ApiClient } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import { PLAN_POLL_MS } from "@/lib/map-planning/plan-readings"
import { statusLabel, webIdOf, type CommandInput } from "@/lib/api/records/adapter"
import { shownOn } from "@/lib/api/records/clock"
import { CONTAINERS_MODULE } from "@/lib/api/records/containers"
import { LIVE_MODULE, routeSessions, whileWatched } from "@/lib/api/records/live"
import { CORRECT_PICKUP, PICKUPS_MODULE, pickupProofs, proofLine, proofObjectNoun, REMOVE_PICKUP } from "@/lib/api/records/pickups"
import { ORGANISATION_MODULE } from "@/lib/data/containers"
import { ADD_STOP, applyBalance, ASSIGN_ROUTE, balanceMoveLine, callsignOf, CANCEL_ROUTE, dayLoadLine, DISPATCH_ROUTE, dispatchRoutes, previewBalance, isHeldRoute, MERGE_ROUTE, MOVE_STOPS, OPTIMISE_ROUTE, planLine, RELEASE_HOLD, REORDER_ROUTE, RESCHEDULE_ROUTE, routeCommandLog, routeDetail, routePlans, ROUTES_MODULE, SPLIT_ROUTE } from "@/lib/api/records/routes"
import { DRIVERS_MODULE, VEHICLES_MODULE } from "@/lib/data/allocations"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import { PROPERTIES_MODULE, SHARED_POINTS_MODULE } from "@/lib/data/properties"
import { getModuleDefinition, type BusinessRecord } from "@/lib/data/business-modules"
import { BULKY_BOOKINGS_MODULE, bookingsForRoute } from "@/lib/data/bulky"
import { MASTER_DATA_MODULE, masterDataKindOf } from "@/lib/data/master-data"
import { BALANCE_DAY_FORM, contaminantCodeOptions, createRouteRecord, DISPATCH_DAY_FORM, dispatchDayRows, PICKUP_COMMAND_FORMS, pickupReasonLabel, ROUTE_COMMAND_FORMS, ROUTE_CREATE_FORM, routeCommandValues, routesToJoin, type PickupCommandWithForm, type RouteCommandWithForm } from "@/lib/data/routes"
import type { Pickup } from "@waste/contracts/pickups"
import type { ProofObjectLink } from "@waste/contracts/proof-objects"
import type { ProofOfService } from "@waste/contracts/proofs"
import type { RouteBalancePreview, RouteDetail, RouteDispatchResult } from "@waste/contracts/routes"
import type { Session } from "@waste/contracts/sessions"

/** The route's own read, as a one-row history the surface reads again after each command. */
const readRoute = (client: ApiClient, serverId: string) => routeDetail(client, serverId).then((detail): RouteDetail[] => [detail])

/** The command each of the route's dialogs sends. */
const ROUTE_COMMAND_OF: Readonly<Record<RouteCommandWithForm, string>> = { assign: ASSIGN_ROUTE, reschedule: RESCHEDULE_ROUTE, cancel: CANCEL_ROUTE, "add-stop": ADD_STOP }

/** The statuses a stop may be added in (#111): a route that has not started. */
const TAKES_A_STOP = new Set(["planned", "ready"])

/** The routes module's primary actions on the Pilot: Dispatch day (O5 of #290), Balance day (O15), then New route (#111). */
export function RoutesPrimarySurface() {
  return (
    <>
      <DispatchDaySurface />
      <BalanceDaySurface />
      <NewRouteSurface />
    </>
  )
}

/**
 * Balance day (O15 of #290): a project's day, then what the API proposes —
 * stops moved off the routes over their vehicle's payload or their driver's
 * shift onto routes of the day that can take them, each route before and after
 * — every move ticked. Nothing moves until Apply sends the ticked moves with
 * the preview's token; a day that changed since is the API's 409, read here as
 * a sentence to preview again. Each move is the API's Move stops, and each
 * route it touched is asked a new Plan; the routes and the stops are read
 * again after.
 */
function BalanceDaySurface() {
  const client = useApiClient()
  const { refreshModule } = useBusinessRecordStore()
  const pickers = useRelationPickers()
  const moduleReady = useModuleReady(ROUTES_MODULE)
  const projects = useServerModuleState(ORGANISATION_MODULE.workspaceId, ORGANISATION_MODULE.moduleId)
  const routeName = useServerNames(ROUTES_MODULE, "route")
  const stopName = useServerNames(PICKUPS_MODULE, "pickup")
  const [step, setStep] = useState<"closed" | "day" | "proposal">("closed")
  const [day, setDay] = useState<{ projectId: string; operatingDate: string } | null>(null)
  const [proposal, setProposal] = useState<RouteBalancePreview | null>(null)
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set())
  const [answered, setAnswered] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ticked = proposal?.moves.filter((move) => !unticked.has(move.pickupId)) ?? []
  const projectServerId = day === null ? undefined : projects?.serverIds.get(day.projectId)

  const pickDay = (values: BusinessFormValues) => {
    const projectId = typeof values.projectId === "string" ? values.projectId : ""
    const operatingDate = typeof values.operatingDate === "string" ? values.operatingDate : ""
    const serverId = projects?.serverIds.get(projectId)
    if (client === null || serverId === undefined) {
      toast.error("The day was not weighed", { description: "The project has not been read from the API yet." })
      return
    }
    setDay({ projectId, operatingDate })
    setUnticked(new Set())
    setAnswered(null)
    setProposal(null)
    setBusy(true)
    previewBalance(client, { projectId: serverId, operatingDate })
      .then(
        (preview) => {
          setProposal(preview)
          setStep("proposal")
        },
        (error: unknown) => toast.error("The day was not weighed", { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setBusy(false))
  }

  const applyTicked = () => {
    if (busy || client === null || proposal === null || day === null || projectServerId === undefined || ticked.length === 0) return
    setBusy(true)
    applyBalance(client, { projectId: projectServerId, operatingDate: day.operatingDate, token: proposal.token, moves: ticked.map((move) => ({ pickupId: move.pickupId, toRouteId: move.toRouteId })) })
      .then(
        (result) => {
          const said = `${result.moved} ${result.moved === 1 ? "stop" : "stops"} moved`
          setAnswered(`${said}; ${result.routes.length} ${result.routes.length === 1 ? "route" : "routes"} asked a new Plan.`)
          toast.success(said, { description: "Each route the moves touched is measured again." })
          // The stops moved between routes, and each touched route's order is asked again.
          void refreshModule(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId)
          void refreshModule(PICKUPS_MODULE.workspaceId, PICKUPS_MODULE.moduleId)
        },
        (error: unknown) => toast.error("The day was not balanced", { description: problemSentence(problemOfError(error)) }),
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
      <Button size="sm" variant="outline" disabled={!moduleReady || client === null || !pickers.readyFor(BALANCE_DAY_FORM)} onClick={() => setStep("day")}>
        Balance day
      </Button>
      {step === "day" && (
        <BusinessRecordFormDialog
          schema={BALANCE_DAY_FORM}
          open
          onOpenChange={(isOpen) => !isOpen && !busy && setStep("closed")}
          onSubmit={pickDay}
          relationOptions={(field, values) => pickers.options(field, values, undefined, {})}
          initialValueOverrides={day ?? {}}
        />
      )}
      {step === "proposal" && day !== null && proposal !== null && (
        <Dialog open onOpenChange={(isOpen) => !isOpen && close()}>
          <DialogContent className="sm:max-w-2xl" data-testid="balance-day">
            <DialogHeader>
              <DialogTitle>Balance day</DialogTitle>
              <DialogDescription>
                The routes of {day.operatingDate} that have not started. A stop moves only onto a route of the same service provider whose vehicle carries its fraction and whose day reaches its window. The times after are estimates until the routes are measured again.
              </DialogDescription>
            </DialogHeader>
            {answered !== null ? (
              <p className="text-sm" data-testid="balance-day-result">
                {answered}
              </p>
            ) : (
              <>
                {proposal.moves.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No route of the day runs over its payload or its shift where another can take its stops: nothing to move.</p>
                ) : (
                  <ul className="divide-y divide-border/60 border-y border-border/60 text-sm" data-testid="balance-day-moves">
                    {proposal.moves.map((move) => (
                      <DispatchDayRow key={move.pickupId} checked={!unticked.has(move.pickupId)} onToggle={(checked) => setUnticked((was) => toggled(was, move.pickupId, !checked))}>
                        {balanceMoveLine(stopName(move.pickupId), routeName(move.fromRouteId), routeName(move.toRouteId))}
                      </DispatchDayRow>
                    ))}
                  </ul>
                )}
                <ul className="text-xs text-muted-foreground" data-testid="balance-day-routes">
                  {proposal.routes.map((weighed) => (
                    <li key={weighed.routeId} className="py-0.5">
                      {routeName(weighed.routeId)}: {dayLoadLine(weighed.before)}
                      {JSON.stringify(weighed.before) === JSON.stringify(weighed.after) ? "" : ` → ${dayLoadLine(weighed.after)}`}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={close}>
                {answered === null ? "Back" : "Close"}
              </Button>
              {answered === null && proposal.moves.length > 0 && (
                <Button disabled={busy || ticked.length === 0} onClick={applyTicked}>
                  Move {ticked.length} {ticked.length === 1 ? "stop" : "stops"}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
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
  [MOVE_STOPS]: (name) => `Stops of ${name} moved`,
  [SPLIT_ROUTE]: (name) => `${name} split`,
  [MERGE_ROUTE]: (name) => `A route was merged into ${name}`,
}

/** What each command's toast says beneath its title: where it now stands, or, for a hand-back, what is still to come (#226). */
const DONE_SAYS: Readonly<Record<string, string>> = {
  [RELEASE_HOLD]: "The next generation run brings back the scheme's day, start and assignment.",
  [ADD_STOP]: "It goes after the route's last stop, and generation never moves or skips it.",
  [OPTIMISE_ROUTE]: "Its open stops are ordered and measured; the Plan's distance and duration follow once it is ready.",
  [MOVE_STOPS]: "Each is taken off here and added to the other route as the office's, after its last stop.",
  [SPLIT_ROUTE]: "The stops are on a new route of the same day: assign its crew, then dispatch it.",
  [MERGE_ROUTE]: "Its open stops are on this route now, after the last stop, and it is cancelled as merged.",
}

type RouteOpen = { kind: "form"; name: RouteCommandWithForm; values: BusinessFormValues } | { kind: "reorder"; order: string[] } | { kind: "stops"; mode: StopsMode }

/** A route's commands, its stops in sequence, its sessions and the device's command log, in its details. */
/** No fixture bookings: the module is the API's alone. */
const NO_BOOKINGS: readonly BusinessRecord[] = []

export function RouteCommandsSurface({ record }: RowSurfaceProps) {
  const pickers = useRelationPickers()
  // The bookings Add stop may collect (O11 of #290): booked ones of the route's project for its day.
  const bulkyBookings = useModuleRecords(BULKY_BOOKINGS_MODULE.workspaceId, BULKY_BOOKINGS_MODULE.moduleId, NO_BOOKINGS)
  const moduleReady = useModuleReady(ROUTES_MODULE)
  // The routes a move goes to or a merge takes in (O23 of #290): the project's others that have not started.
  const routes = useModuleRecords(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId, getModuleDefinition(ROUTES_MODULE)?.records ?? [])
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

  const sendable = moduleReady && !busy
  const status = typeof record.submittedValues?.status === "string" ? record.submittedValues.status : ""
  const openForm = (name: RouteCommandWithForm) => setOpen({ kind: "form", name, values: name === "assign" || name === "reschedule" ? routeCommandValues(record) : {} })
  // What the account signed in sends: a provider's crews a route it runs and sends it to its own driver alone (#291 C24).
  const offered = useCommandOffered(ROUTES_MODULE)
  // An address-only stop the office added (#111) names no container: it is named by the place it is collected at.
  const stopName = (pickup: Pickup) => {
    if (pickup.containerId !== null) return containerName(pickup.containerId)
    if (pickup.propertyId !== null) return propertyName(pickup.propertyId)
    return pickup.sharedCollectionPointId === null ? "A stop with no place" : pointName(pickup.sharedCollectionPointId)
  }
  const stopLine = (pickup: Pickup & { sequence?: number }) =>
    `${pickup.sequence ?? pickup.position}. ${stopName(pickup)} · ${statusLabel(pickup.status)}${pickup.reason === null ? "" : ` · ${pickupReasonLabel(pickup.reason)}`}${pickup.movedFromPickupId != null ? " · moved here" : pickup.origin === "office" ? " · added by the office" : ""}`

  return (
    <section className="space-y-4" data-testid="route-commands">
      <h3 className="text-sm font-semibold">Route commands</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The routes are being read from the API; their commands follow.</p>}
      <div className="flex flex-wrap gap-2">
        {offered(ASSIGN_ROUTE) && (
          <Button variant="outline" size="sm" disabled={!sendable || !pickers.readyFor(ROUTE_COMMAND_FORMS.assign)} onClick={() => openForm("assign")}>
            Assign
          </Button>
        )}
        {offered(DISPATCH_ROUTE) && (
          <Button variant="outline" size="sm" disabled={!sendable} onClick={() => run(DISPATCH_ROUTE)}>
            Dispatch
          </Button>
        )}
        {offered(RESCHEDULE_ROUTE) && (
          <Button variant="outline" size="sm" disabled={!sendable} onClick={() => openForm("reschedule")}>
            Reschedule
          </Button>
        )}
        {/* A route the office holds goes back to its scheme on a word: the next generation run brings back its day, start and assignment (#226). */}
        {offered(RELEASE_HOLD) && isHeldRoute(record) && record.submittedValues?.status === "planned" && (
          <Button variant="outline" size="sm" disabled={!sendable} onClick={() => run(RELEASE_HOLD)}>
            Release hold
          </Button>
        )}
        {/* A stop of the office's own goes onto a route that has not started (#111). */}
        {offered(ADD_STOP) && TAKES_A_STOP.has(status) && (
          <Button variant="outline" size="sm" disabled={!sendable || !pickers.readyFor(ROUTE_COMMAND_FORMS["add-stop"])} onClick={() => openForm("add-stop")}>
            Add stop
          </Button>
        )}
        {/* Open stops onto another route, a new one of the day, or another route's taken in (O23 of #290), on a route that has not started. */}
        {offered(MOVE_STOPS) && TAKES_A_STOP.has(status) && (
          <Button variant="outline" size="sm" disabled={!sendable || openStops.length === 0} onClick={() => setOpen({ kind: "stops", mode: "move" })}>
            Move stops
          </Button>
        )}
        {offered(SPLIT_ROUTE) && TAKES_A_STOP.has(status) && (
          <Button variant="outline" size="sm" disabled={!sendable || openStops.length < 2} onClick={() => setOpen({ kind: "stops", mode: "split" })}>
            Split route
          </Button>
        )}
        {offered(MERGE_ROUTE) && TAKES_A_STOP.has(status) && (
          <Button variant="outline" size="sm" disabled={!sendable} onClick={() => setOpen({ kind: "stops", mode: "merge" })}>
            Merge route
          </Button>
        )}
        {offered(REORDER_ROUTE) && (
          <Button variant="outline" size="sm" disabled={!sendable || detail === undefined || openStops.length < 2} onClick={() => setOpen({ kind: "reorder", order: openStops.map((pickup) => pickup.id) })}>
            Reorder stops
          </Button>
        )}
        {/* A Plan over the open stops, on a route that has not started (O5 of #290): the optimiser's order, or a measured baseline where it cannot take the route. */}
        {offered(OPTIMISE_ROUTE) && TAKES_A_STOP.has(status) && (
          <Button variant="outline" size="sm" disabled={!sendable || detail === undefined || openStops.length === 0} onClick={() => run(OPTIMISE_ROUTE)}>
            Optimise
          </Button>
        )}
        {offered(CANCEL_ROUTE) && (
          <Button variant="outline" size="sm" disabled={!sendable} onClick={() => openForm("cancel")}>
            Cancel route
          </Button>
        )}
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
          relationOptions={(field, values) => (field.id === "bulkyBookingId" ? bookingsForRoute(bulkyBookings.records, record) : pickers.options(field, values, projectId))}
          initialValueOverrides={open.values}
        />
      )}
      {open?.kind === "stops" && (
        <MoveStopsDialog
          mode={open.mode}
          stops={openStops.map((pickup) => ({ id: webIdOf("pickup", pickup.id), label: stopName(pickup) }))}
          routes={routesToJoin(routes.records, record).map((other) => ({ id: other.id, label: `${other.name} · ${String(other.submittedValues?.operatingDate ?? "")} · ${statusLabel(String(other.submittedValues?.status ?? ""))}` }))}
          busy={busy}
          onClose={() => setOpen(null)}
          onSend={(input) => run(STOPS_COMMAND_OF[open.mode], input)}
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

/** The three ways stops change route (O23 of #290). */
type StopsMode = "move" | "split" | "merge"

/** The command each mode sends. */
const STOPS_COMMAND_OF: Readonly<Record<StopsMode, string>> = { move: MOVE_STOPS, split: SPLIT_ROUTE, merge: MERGE_ROUTE }

/** What each mode's dialog says. */
const STOPS_DIALOG: Readonly<Record<StopsMode, { title: string; description: string; send: string }>> = {
  move: { title: "Move stops", description: "Tick the open stops to move and pick the route they go to: a route of this project that has not started. Each is taken off here and added there after its last stop.", send: "Move stops" },
  split: { title: "Split route", description: "Tick the open stops to split off: they go onto a new route of the same day, with this route's depot, unloading station and start. Leave this route some of its stops.", send: "Split route" },
  merge: { title: "Merge route", description: "Pick the route to merge into this one: its open stops come here after the last stop, and it is cancelled as merged.", send: "Merge route" },
}

/** The stops ticked and the other route picked, for a move, a split or a merge; the API judges each stop where it goes. */
function MoveStopsDialog({ mode, stops, routes, busy, onClose, onSend }: { mode: StopsMode; stops: readonly { id: string; label: string }[]; routes: readonly { id: string; label: string }[]; busy: boolean; onClose: () => void; onSend: (input: CommandInput) => void }) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [other, setOther] = useState("")
  const [note, setNote] = useState("")
  const words = STOPS_DIALOG[mode]
  const picksStops = mode !== "merge"
  const picksRoute = mode !== "split"
  const ready = (!picksStops || ticked.size > 0) && (!picksRoute || other !== "")
  const send = () => {
    const pickupIds = stops.filter((stop) => ticked.has(stop.id)).map((stop) => stop.id)
    if (mode === "move") onSend({ pickupIds, toRouteId: other })
    else if (mode === "split") onSend(note.trim() === "" ? { pickupIds } : { pickupIds, note: note.trim() })
    else onSend({ routeId: other })
  }
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{words.title}</DialogTitle>
          <DialogDescription>{words.description}</DialogDescription>
        </DialogHeader>
        {picksStops && (
          <ul className="max-h-64 divide-y divide-border/60 overflow-y-auto border-y border-border/60 text-sm" data-testid="move-stops">
            {stops.map((stop) => (
              <DispatchDayRow key={stop.id} checked={ticked.has(stop.id)} onToggle={(checked) => setTicked((set) => toggled(set, stop.id, checked))}>
                {stop.label}
              </DispatchDayRow>
            ))}
          </ul>
        )}
        {picksRoute &&
          (routes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No other route of this project has yet to start.</p>
          ) : (
            <Select value={other} onValueChange={setOther}>
              <SelectTrigger aria-label={mode === "move" ? "Route to move the stops to" : "Route to merge into this one"}>
                <SelectValue placeholder={mode === "move" ? "Route to move them to" : "Route to merge in"} />
              </SelectTrigger>
              <SelectContent>
                {routes.map((route) => (
                  <SelectItem key={route.id} value={route.id}>
                    {route.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}
        {mode === "split" && <Input aria-label="Note for the new route" placeholder="Note for the new route (optional)" value={note} onChange={(event) => setNote(event.target.value)} />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Back
          </Button>
          <Button disabled={busy || !ready} onClick={send}>
            {words.send}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
export function ProofObject({ proof, links }: { proof: Pick<ProofOfService, "id" | "kind" | "objectKey">; links: { rows: ProofObjectLink[] | null; problem: string | null } }) {
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

/** No fixture lends a contaminant code: the master data's fixtures are coarse sets of no kind. */
const NO_MASTER_FIXTURES: readonly BusinessRecord[] = []

/** A stop's commands and its proofs, in its details. */
export function PickupCommandsSurface({ record }: RowSurfaceProps) {
  const pickers = useRelationPickers()
  // The contaminant codes a correction may tag the stop with (M5 of #293): the master data's rows of that kind.
  const master = useModuleRecords(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId, NO_MASTER_FIXTURES)
  const codes = master.records.filter((row) => masterDataKindOf(row) === "contaminant-code")
  const moduleReady = useModuleReady(PICKUPS_MODULE)
  const { busy, version, run: send } = useCommandRunner(PICKUPS_MODULE, record.id)
  const proofs = useRowHistory(PICKUPS_MODULE.workspaceId, PICKUPS_MODULE.moduleId, record, version, pickupProofs)
  // The objects' read URLs are asked for only where a proof names an object.
  const withObjects = proofs.rows?.some((proof) => proof.objectKey !== null) ?? false
  const serverId = useServerModuleState(PICKUPS_MODULE.workspaceId, PICKUPS_MODULE.moduleId)?.serverIds.get(record.id)
  const objects = useProofObjectLinks(withObjects ? (serverId ?? null) : null, version)
  const openRoute = useOpenRecord(ROUTES_MODULE.moduleId)
  const [open, setOpen] = useState<PickupCommandWithForm | null>(null)
  // A stop's commands are the office's: a provider's account reads its stops and their proofs (#291 C24).
  const offered = useCommandOffered(PICKUPS_MODULE)
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
        {offered(REMOVE_PICKUP) && (
          <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setOpen("remove")}>
            Remove stop
          </Button>
        )}
        {offered(CORRECT_PICKUP) && (
          <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setOpen("correct")}>
            Correct outcome
          </Button>
        )}
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
      {open !== null && (
        <BusinessRecordFormDialog
          schema={PICKUP_COMMAND_FORMS[open]}
          open
          onOpenChange={(isOpen) => !isOpen && setOpen(null)}
          onSubmit={(values) => run(open, values)}
          // The correction's code is the master data's codes for the stop's fraction (M5 of #293), and opens on the stop's own.
          relationOptions={(field, values) => (field.id === "contaminantCodeId" ? contaminantCodeOptions(codes, record) : pickers.options(field, values))}
          initialValueOverrides={open === "correct" && typeof record.submittedValues?.contaminantCodeId === "string" ? { contaminantCodeId: record.submittedValues.contaminantCodeId } : undefined}
        />
      )}
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
