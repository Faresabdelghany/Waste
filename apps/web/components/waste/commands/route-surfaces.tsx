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
// (O1 of #290) — a live row its track, the estimates at its stops (O8 of
// #290), its sessions and the way to its route. Every command is
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
import type { ModuleKey } from "@waste/domain/access/modules"
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react"
import { ArrowDown, ArrowSquareOut, ArrowUp, CaretDown, CaretRight, Funnel, MagnifyingGlass, MapTrifold, PaperPlaneTilt } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { RouteMapPanel } from "@/components/waste/route-map-panel"
import { cn } from "@/lib/utils"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PageActions, PillTab, PillTabsList } from "@/components/page-layout"
import { PICKUP_SERVICE_LABELS } from "@/lib/data/pickup-services"
import { recordStatusTone } from "@/components/platform/business-record-views"
import { StatusBadge } from "@/components/ui/status-badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useApiClient } from "@/components/platform/api-session-store"
import { RouteMessagesSection } from "@/components/waste/commands/route-messages-section"
import { useGrants } from "@/components/platform/use-grants"
import { mayOn, mayTake, type ModuleAction } from "@/lib/modules/grants"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BusinessRecordFormDialog } from "@/components/platform/business-record-form-dialog"
import { useBusinessRecordStore, useModuleRecords, useServerModuleState } from "@/components/platform/business-record-store"
import type { RowSurfaceProps } from "@/components/platform/surface-props"
import { CreateSurface } from "@/components/waste/commands/create-surface"
import { ReadRows } from "@/components/waste/commands/read-rows"
import { useCommandRunner, useModuleReady, useOpenRecord, useRelationPickers, useRowHistory, useServerNames } from "@/components/platform/use-command-support"
import { useCommandOffered } from "@/components/platform/provider-account"
import { ProofObject } from "@/components/platform/proof-object"
import { useProofObjectLinks } from "@/components/platform/use-proof-object-links"
import type { ApiClient } from "@/lib/api/client"
import { problemOfError, problemSentence } from "@/lib/api/problem"
import { PLAN_POLL_MS } from "@/lib/map-planning/plan-readings"
import { type CommandInput } from "@/lib/api/records/adapter"
import { statusLabel, webIdOf } from "@/lib/records/fields"
import { shownOn, timeOn } from "@/lib/format/clock"
import { CONTAINERS_MODULE, ORGANISATION_MODULE } from "@/lib/data/containers"
import { LIVE_MODULE, routeEtas, routeSessions, routeTrack, trackPath, whileWatched } from "@/lib/api/records/live"
import { CORRECT_PICKUP, pickupProofs, proofLine, REMOVE_PICKUP } from "@/lib/api/records/pickups"
import { BALANCE_DAY_FORM, contaminantCodeOptions, createRouteRecord, DISPATCH_DAY_FORM, dispatchDayRows, PICKUP_COMMAND_FORMS, type PickupCommandWithForm, PICKUPS_MODULE, ROUTE_COMMAND_FORMS, ROUTE_CREATE_FORM, routeCommandValues, type RouteCommandWithForm, ROUTES_MODULE, routesToJoin } from "@/lib/data/routes"
import { ADD_STOP, applyBalance, ASSIGN_ROUTE, balanceMoveLine, callsignOf, CANCEL_ROUTE, dayLoadLine, DISPATCH_ROUTE, dispatchRoutes, previewBalance, isHeldRoute, MERGE_ROUTE, MOVE_STOPS, OPTIMISE_ROUTE, planLine, RELEASE_HOLD, REORDER_ROUTE, RESCHEDULE_ROUTE, routeCommandLog, routeDetail, routePlans, SPLIT_ROUTE } from "@/lib/api/records/routes"
import { DRIVERS_MODULE, VEHICLES_MODULE } from "@/lib/data/allocations"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import { PROPERTIES_MODULE, SHARED_POINTS_MODULE } from "@/lib/data/properties"
import { BULKY_BOOKINGS_MODULE, bookingsForRoute } from "@/lib/data/bulky"
import { MASTER_DATA_MODULE, masterDataKindOf } from "@/lib/data/master-data"
import { pickupReasonLabel } from "@/lib/data/route-labels"
import { waitingSentence } from "@/lib/api/read-state"
import type { Pickup } from "@waste/contracts/pickups"
import type { RouteEta, RouteTrack } from "@waste/contracts/positions"
import type { RouteBalancePreview, RouteDetail, RouteDispatchResult } from "@waste/contracts/routes"
import type { Session } from "@waste/contracts/sessions"
import { stopNumber } from "@waste/domain/execution/routes"

/** The route's own read, as a one-row history the surface reads again after each command. */
const readRoute = (client: ApiClient, serverId: string) => routeDetail(client, serverId).then((detail): RouteDetail[] => [detail])

const ROUTE_COMMAND_OF: Readonly<Record<RouteCommandWithForm, string>> = { assign: ASSIGN_ROUTE, reschedule: RESCHEDULE_ROUTE, cancel: CANCEL_ROUTE, "add-stop": ADD_STOP }

/** The statuses a stop may be added in (#111): a route that has not started. */
const TAKES_A_STOP = new Set(["planned", "ready"])

/** The routes module's primary actions, each under the grant its API route checks: Dispatch day's `POST /routes/dispatch`, Balance day's `/routes/balance-preview` and `/routes/balance`, New route's `POST /routes`. */
export const ROUTES_PRIMARY_ACTIONS = {
  dispatchDay: { module: ROUTES_MODULE, action: "edit" },
  balanceDay: { module: PICKUPS_MODULE, action: "edit" },
  newRoute: { module: ROUTES_MODULE, action: "create" },
} as const satisfies Record<string, ModuleAction>

/** The routes module's primary actions on the Pilot: Dispatch day (O5 of #290), Balance day (O15), then New route (#111), each where its grant is held. */
export function RoutesPrimarySurface() {
  const grants = useGrants()
  return (
    <>
      {mayTake(grants, ROUTES_PRIMARY_ACTIONS.dispatchDay) && <DispatchDaySurface />}
      {mayTake(grants, ROUTES_PRIMARY_ACTIONS.balanceDay) && <BalanceDaySurface />}
      {mayTake(grants, ROUTES_PRIMARY_ACTIONS.newRoute) && <NewRouteSurface />}
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
              <DialogDescription>{day.operatingDate}</DialogDescription>
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
  const routes = useModuleRecords(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId)
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
              <DialogDescription>{day.operatingDate}</DialogDescription>
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

const toggled = (set: ReadonlySet<string>, id: string, inIt: boolean): ReadonlySet<string> => {
  const next = new Set(set)
  if (inIt) next.add(id)
  else next.delete(id)
  return next
}

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

function useSessionLine(): (session: Session, timezone: string | undefined) => string {
  const driverName = useServerNames(DRIVERS_MODULE, "driver")
  const vehicleName = useServerNames(VEHICLES_MODULE, "vehicle")
  return (session, timezone) =>
    `${shownOn(session.startedAt, timezone)} → ${session.endedAt === null ? (session.pausedAt === null ? "open" : "paused") : shownOn(session.endedAt, timezone)} · ${driverName(session.driverId)} · ${callsignOf(vehicleName(session.vehicleId))}`
}

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

/** The grant a route's messages are written under (O24 of #290): the routes' own. */
const ROUTE_MESSAGES_MODULE_KEY = "route-studio.routes" satisfies ModuleKey

/** A route's details in the side panel: its facts above, these commands and reads under them. */
export function RouteCommandsSurface({ record }: RowSurfaceProps) {
  return <RouteSurface record={record} layout="sheet" />
}

/**
 * A route's own page (`RouteDetailsOnApi`): Overview's stops table with its
 * search and Filters, headed by Dispatch and one Actions menu of every other
 * command, the Map and the route's information beside it; then the route's
 * tickets, sessions, Plans, messages and activity.
 */
export function RouteSurfacePage({
  record,
  information,
  tickets,
  history,
  menu,
}: RowSurfaceProps & {
  /** The route's facts, grouped: the Route information panel beside the stops. */
  information: ReactNode
  tickets: { count: number; content: ReactNode }
  /** The route's History, under its Activity tab. */
  history?: ReactNode
  /** The record's own actions (Delete, …), after Actions. */
  menu?: ReactNode
}) {
  return <RouteSurface record={record} layout="page" page={{ information, tickets, history, menu }} />
}

/** A route command as a surface offers it: a button in the side panel; on the page, Dispatch, or an item of the Actions menu grouped by `place`. */
type RouteCommandEntry = { name: string; place: "primary" | "route" | "stops"; offered: boolean; disabled: boolean; select: () => void }

/** The stop statuses Filters narrows the stops to: the ones not collected. */
const NEEDS_ATTENTION = new Set<string>(["skipped", "failed"])

type RoutePageParts = { information: ReactNode; tickets: { count: number; content: ReactNode }; history?: ReactNode; menu?: ReactNode }

function RouteSurface({ record, layout, page }: RowSurfaceProps & { layout: "sheet" | "page"; page?: RoutePageParts }) {
  const pickers = useRelationPickers()
  const grants = useGrants()
  // The bookings Add stop may collect (O11 of #290): booked ones of the route's project for its day.
  const bulkyBookings = useModuleRecords(BULKY_BOOKINGS_MODULE.workspaceId, BULKY_BOOKINGS_MODULE.moduleId)
  const moduleReady = useModuleReady(ROUTES_MODULE)
  // The routes a move goes to or a merge takes in (O23 of #290): the project's others that have not started.
  const routes = useModuleRecords(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId)
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
  const stopNote = (pickup: Pickup) =>
    [pickup.reason === null ? null : pickupReasonLabel(pickup.reason), pickup.movedFromPickupId != null ? "Moved here" : pickup.origin === "office" ? "Added by the office" : null].filter(Boolean).join(" · ")
  const stopLine = (pickup: Pickup & { sequence?: number }) =>
    `${stopNumber(pickup)}. ${stopName(pickup)} · ${statusLabel(pickup.status)}${pickup.reason === null ? "" : ` · ${pickupReasonLabel(pickup.reason)}`}${pickup.movedFromPickupId != null ? " · moved here" : pickup.origin === "office" ? " · added by the office" : ""}`

  const [stopSearch, setStopSearch] = useState("")
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [rightPanel, setRightPanel] = useState<"map" | "information">("information")

  // Every command, in the order the side panel draws them.
  const allCommands: RouteCommandEntry[] = [
    { name: "Assign", place: "route", offered: offered(ASSIGN_ROUTE), disabled: !sendable || !pickers.readyFor(ROUTE_COMMAND_FORMS.assign), select: () => openForm("assign") },
    { name: "Dispatch", place: "primary", offered: offered(DISPATCH_ROUTE), disabled: !sendable, select: () => run(DISPATCH_ROUTE) },
    { name: "Reschedule", place: "route", offered: offered(RESCHEDULE_ROUTE), disabled: !sendable, select: () => openForm("reschedule") },
    // A route the office holds goes back to its scheme on a word: the next generation run brings back its day, start and assignment (#226).
    { name: "Release hold", place: "route", offered: offered(RELEASE_HOLD) && isHeldRoute(record) && record.submittedValues?.status === "planned", disabled: !sendable, select: () => run(RELEASE_HOLD) },
    // A stop of the office's own goes onto a route that has not started (#111).
    { name: "Add stop", place: "stops", offered: offered(ADD_STOP) && TAKES_A_STOP.has(status), disabled: !sendable || !pickers.readyFor(ROUTE_COMMAND_FORMS["add-stop"]), select: () => openForm("add-stop") },
    // Open stops onto another route, a new one of the day, or another route's taken in (O23 of #290), on a route that has not started.
    { name: "Move stops", place: "stops", offered: offered(MOVE_STOPS) && TAKES_A_STOP.has(status), disabled: !sendable || openStops.length === 0, select: () => setOpen({ kind: "stops", mode: "move" }) },
    { name: "Split route", place: "stops", offered: offered(SPLIT_ROUTE) && TAKES_A_STOP.has(status), disabled: !sendable || openStops.length < 2, select: () => setOpen({ kind: "stops", mode: "split" }) },
    { name: "Merge route", place: "stops", offered: offered(MERGE_ROUTE) && TAKES_A_STOP.has(status), disabled: !sendable, select: () => setOpen({ kind: "stops", mode: "merge" }) },
    { name: "Reorder stops", place: "stops", offered: offered(REORDER_ROUTE), disabled: !sendable || detail === undefined || openStops.length < 2, select: () => setOpen({ kind: "reorder", order: openStops.map((pickup) => pickup.id) }) },
    // A Plan over the open stops, on a route that has not started (O5 of #290): the optimiser's order, or a measured baseline where it cannot take the route.
    { name: "Optimise", place: "stops", offered: offered(OPTIMISE_ROUTE) && TAKES_A_STOP.has(status), disabled: !sendable || detail === undefined || openStops.length === 0, select: () => run(OPTIMISE_ROUTE) },
    { name: "Cancel route", place: "route", offered: offered(CANCEL_ROUTE), disabled: !sendable, select: () => openForm("cancel") },
  ]
  const commands = allCommands.filter((command) => command.offered)
  const stopsEmpty = record.facts.Origin === undefined ? "No stop: generation matched no container for this route." : "No stop yet: add the route's stops."
  const plansBlock = (
    <ReadRows
      read={plans}
      label="Reading the route's Plans…"
      empty="No Plan yet: the generated order stands unmeasured."
      testId="route-plans"
      line={(plan) => planLine(plan, { activePlanId: detail?.activePlan?.id, timezone })}
    />
  )
  const sessionsBlock = <ReadRows read={{ rows: detail?.sessions ?? null, problem: reads.problem }} label="Reading the route's sessions…" empty="Not started: no driver has started this route." testId="route-sessions" line={(session) => sessionLine(session, timezone)} />
  const messagesBlock = <RouteMessagesSection record={record} timezone={timezone} canSend={mayOn(grants, ROUTE_MESSAGES_MODULE_KEY, "edit")} />
  const logBlock = (
    <ReadRows
      read={log}
      label="Reading the device's command log…"
      empty="The driver's device has sent nothing for this route."
      testId="route-command-log"
      line={(receipt) => `${shownOn(receipt.occurredAt, timezone)} · ${statusLabel(receipt.kind)} · ${statusLabel(receipt.outcome)}${receipt.problem?.detail ? ` · ${receipt.problem.detail}` : ""}`}
    />
  )
  const dialogs = (
    <>
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
    </>
  )

  if (layout === "page" && page !== undefined) {
    const stops = detail?.pickups
    const dispatch = commands.find((command) => command.place === "primary")
    const menuGroups = [
      commands.filter((command) => command.place === "route" && command.name !== "Cancel route"),
      commands.filter((command) => command.place === "stops"),
      commands.filter((command) => command.name === "Cancel route"),
    ].filter((group) => group.length > 0)
    const query = stopSearch.trim().toLowerCase()
    const shownStops = (stops ?? []).filter(
      (pickup) =>
        (!attentionOnly || NEEDS_ATTENTION.has(pickup.status)) &&
        (query === "" || `${stopName(pickup)} ${PICKUP_SERVICE_LABELS[pickup.service]} ${statusLabel(pickup.status)} ${stopNote(pickup)}`.toLowerCase().includes(query)),
    )
    const tabs: ReadonlyArray<readonly [string, string, number | undefined]> = [
      ["overview", "Overview", undefined],
      ["tickets", "Tickets", page.tickets.count],
      ["sessions", "Sessions", detail?.sessions.length],
      ["plans", "Plans", plans.rows?.length],
      ["messages", "Messages", undefined],
      ["activity", "Activity", undefined],
    ]
    // Every tab stays mounted, its reads with it, and an inactive one is hidden.
    const tabContent = "mt-0 min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden"
    return (
      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 px-4 py-3">
          <div className="min-w-0 overflow-x-auto">
            <PillTabsList>
              {tabs.map(([value, label, count]) => (
                <PillTab key={value} value={value}>
                  {label}
                  {count !== undefined && <span className="ml-1.5 text-[10px] text-muted-foreground">{count}</span>}
                </PillTab>
              ))}
            </PillTabsList>
          </div>
        </div>
        {!moduleReady && <p className="border-b border-border/40 px-4 py-2 text-xs text-muted-foreground">{waitingSentence("routes", "their commands follow")}</p>}

        <TabsContent value="overview" forceMount className={tabContent}>
          <div className="grid min-h-[640px] min-[1180px]:grid-cols-[minmax(0,1.45fr)_minmax(380px,0.95fr)]">
            <section className="min-w-0 border-b border-border min-[1180px]:border-b-0 min-[1180px]:border-r">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                <div className="relative min-w-[220px] max-w-sm flex-1">
                  <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={stopSearch} onChange={(event) => setStopSearch(event.target.value)} placeholder="Search route stops" aria-label="Search route stops" className="h-8 pl-9 text-sm" />
                </div>
                {(stopSearch !== "" || attentionOnly) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setStopSearch("")
                      setAttentionOnly(false)
                    }}
                  >
                    Reset
                  </Button>
                )}
                <Button variant={attentionOnly ? "secondary" : "outline"} size="sm" aria-pressed={attentionOnly} onClick={() => setAttentionOnly((current) => !current)}>
                  <Funnel className="h-4 w-4" />
                  Filters
                </Button>
              </div>

              <div className="p-3 sm:p-4">
                <div className="max-w-full overflow-hidden rounded-xl border border-border">
                  {/* The route's commands head its stops, as a module's actions head its table: Dispatch, then one Actions menu. */}
                  <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
                    <p className="text-xs text-muted-foreground">
                      {stops === undefined ? "Reading the route's stops…" : attentionOnly || query !== "" ? `${shownStops.length} of ${stops.length} stops` : `${stops.length} ${stops.length === 1 ? "stop" : "stops"} · ${openStops.length} open`}
                    </p>
                    <div data-testid="route-commands">
                      <PageActions>
                        {dispatch && (
                          <Button size="sm" disabled={dispatch.disabled} onClick={dispatch.select}>
                            <PaperPlaneTilt className="h-4 w-4" weight="fill" />
                            {dispatch.name}
                          </Button>
                        )}
                        {menuGroups.length > 0 && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="outline" size="sm">
                                Actions
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-52">
                              {menuGroups.map((group, index) => (
                                <Fragment key={group[0].name}>
                                  {index > 0 && <DropdownMenuSeparator />}
                                  {group.map((command) => (
                                    <DropdownMenuItem key={command.name} disabled={command.disabled} onSelect={command.select} className={cn(command.name === "Cancel route" && "text-destructive focus:text-destructive")}>
                                      {command.name}
                                    </DropdownMenuItem>
                                  ))}
                                </Fragment>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                        {page.menu}
                      </PageActions>
                    </div>
                  </div>
                  {reads.problem !== null ? (
                    <p className="px-4 py-10 text-center text-sm text-destructive">{reads.problem}</p>
                  ) : stops === undefined ? null : stops.length === 0 ? (
                    <p className="px-4 py-10 text-center text-sm text-muted-foreground">{stopsEmpty}</p>
                  ) : (
                    <div className="max-w-full overflow-x-auto">
                      <Table className="min-w-[640px]" data-testid="route-stops">
                        <TableHeader className="bg-muted/30">
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="w-14 pl-4 text-xs font-medium text-muted-foreground">#</TableHead>
                            <TableHead className="text-xs font-medium text-muted-foreground">Stop</TableHead>
                            <TableHead className="text-xs font-medium text-muted-foreground">Service</TableHead>
                            <TableHead className="text-xs font-medium text-muted-foreground">Status</TableHead>
                            <TableHead className="w-12" />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {shownStops.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={5} className="h-40 text-center">
                                <p className="text-sm font-medium">No matching stops</p>
                                <p className="mt-1 text-xs text-muted-foreground">Change the search or filter.</p>
                              </TableCell>
                            </TableRow>
                          ) : (
                            shownStops.map((pickup) => {
                              const note = stopNote(pickup)
                              return (
                                <TableRow key={pickup.id} className="hover:bg-muted/60">
                                  <TableCell className="py-3 pl-4 text-sm tabular-nums text-muted-foreground">{stopNumber(pickup)}</TableCell>
                                  <TableCell className="min-w-[180px] py-3">
                                    <p className="text-sm font-medium text-foreground">{stopName(pickup)}</p>
                                    {note !== "" && <p className="text-xs text-muted-foreground">{note}</p>}
                                  </TableCell>
                                  <TableCell className="py-3 text-sm text-muted-foreground">{PICKUP_SERVICE_LABELS[pickup.service]}</TableCell>
                                  <TableCell className="py-3">
                                    <StatusBadge outlined tone={recordStatusTone(statusLabel(pickup.status))} className="rounded-full px-2 py-0.5 text-[11px] font-medium">
                                      {statusLabel(pickup.status)}
                                    </StatusBadge>
                                  </TableCell>
                                  <TableCell className="py-3 pr-4 text-right">
                                    <Button variant="ghost" size="icon-sm" className="rounded-full text-muted-foreground hover:text-foreground" aria-label="Open stop" onClick={() => openPickup(webIdOf("pickup", pickup.id))}>
                                      <ArrowSquareOut className="h-4 w-4" />
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              )
                            })
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              </div>
            </section>

            <aside className="min-w-0">
              <Button
                type="button"
                variant="ghost"
                className={cn(
                  "flex h-auto min-h-14 w-full items-center justify-start gap-2 rounded-none border-b border-border px-4 py-3 text-left font-normal hover:bg-transparent hover:text-current has-[>svg]:px-4 dark:hover:bg-transparent",
                  rightPanel !== "map" && "bg-muted/20",
                )}
                onClick={() => setRightPanel("map")}
                aria-expanded={rightPanel === "map"}
              >
                {rightPanel === "map" ? <CaretDown className="h-4 w-4 text-muted-foreground" /> : <CaretRight className="h-4 w-4 text-muted-foreground" />}
                <MapTrifold className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Map</span>
              </Button>
              {rightPanel === "map" && <RouteMapPanel record={record} pickups={detail?.pickups} stopName={stopName} />}
              <Button
                type="button"
                variant="ghost"
                className="flex h-auto min-h-14 w-full items-center justify-start gap-2 rounded-none border-b border-border px-4 py-3 text-left font-normal hover:bg-transparent hover:text-current has-[>svg]:px-4 dark:hover:bg-transparent"
                onClick={() => setRightPanel("information")}
                aria-expanded={rightPanel === "information"}
              >
                {rightPanel === "information" ? <CaretDown className="h-4 w-4 text-muted-foreground" /> : <CaretRight className="h-4 w-4 text-muted-foreground" />}
                <span className="text-sm font-semibold">Route information</span>
              </Button>
              {rightPanel === "information" && page.information}
            </aside>
          </div>
        </TabsContent>

        <TabsContent value="tickets" forceMount className={tabContent}>
          {page.tickets.content}
        </TabsContent>
        <TabsContent value="sessions" forceMount className={tabContent}>
          <RoutePageSection title="Sessions">
            {sessionsBlock}
          </RoutePageSection>
        </TabsContent>
        <TabsContent value="plans" forceMount className={tabContent}>
          <RoutePageSection title="Plans">
            {plansBlock}
          </RoutePageSection>
        </TabsContent>
        <TabsContent value="messages" forceMount className={tabContent}>
          <RoutePageSection title="Messages">
            {messagesBlock}
          </RoutePageSection>
        </TabsContent>
        <TabsContent value="activity" forceMount className={tabContent}>
          <RoutePageSection title="Driver app commands">
            {logBlock}
          </RoutePageSection>
          {page.history !== undefined && <div className="px-5 pb-6 empty:hidden">{page.history}</div>}
        </TabsContent>
        {dialogs}
      </Tabs>
    )
  }

  return (
    <section className="space-y-4" data-testid="route-commands">
      <h3 className="text-sm font-semibold">Route commands</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">{waitingSentence("routes", "their commands follow")}</p>}
      <div className="flex flex-wrap gap-2">
        {commands.map((command) => (
          <Button key={command.name} variant="outline" size="sm" disabled={command.disabled} onClick={command.select}>
            {command.name}
          </Button>
        ))}
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Stops, in the order they will be visited</h4>
        <ReadRows
          read={{ rows: detail?.pickups ?? null, problem: reads.problem }}
          label="Reading the route's stops…"
          empty={stopsEmpty}
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
        {plansBlock}
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Sessions</h4>
        {sessionsBlock}
      </div>
      {messagesBlock}
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Driver app commands</h4>
        {logBlock}
      </div>
      {dialogs}
    </section>
  )
}

function RoutePageSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </section>
  )
}

/** The three ways stops change route (O23 of #290). */
type StopsMode = "move" | "split" | "merge"

const STOPS_COMMAND_OF: Readonly<Record<StopsMode, string>> = { move: MOVE_STOPS, split: SPLIT_ROUTE, merge: MERGE_ROUTE }

const STOPS_DIALOG: Readonly<Record<StopsMode, { title: string; send: string; warning?: string }>> = {
  move: { title: "Move stops", send: "Move stops" },
  split: { title: "Split route", send: "Split route" },
  merge: { title: "Merge route", send: "Merge route", warning: "The picked route's open stops come here after the last stop, and it is cancelled as merged." },
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
      <DialogContent {...(words.warning === undefined ? { "aria-describedby": undefined } : {})}>
        <DialogHeader>
          <DialogTitle>{words.title}</DialogTitle>
          {words.warning !== undefined && <DialogDescription className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-warning-foreground">{words.warning}</DialogDescription>}
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
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Reorder stops</DialogTitle>
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

export function PickupCommandsSurface({ record }: RowSurfaceProps) {
  const pickers = useRelationPickers()
  // The contaminant codes a correction may tag the stop with (M5 of #293): the master data's rows of that kind.
  const master = useModuleRecords(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId)
  const codes = master.records.filter((row) => masterDataKindOf(row) === "contaminant-code")
  const moduleReady = useModuleReady(PICKUPS_MODULE)
  const { busy, version, run: send } = useCommandRunner(PICKUPS_MODULE, record.id)
  const proofs = useRowHistory(PICKUPS_MODULE.workspaceId, PICKUPS_MODULE.moduleId, record, version, pickupProofs)
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
      {!moduleReady && <p className="text-sm text-muted-foreground">{waitingSentence("stops", "their commands follow")}</p>}
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
  // Read again with the board: the row's last-seen moves on every read of it.
  const version = record.submittedValues?.lastSeenAt ?? ""
  const track = useRowHistory(LIVE_MODULE.workspaceId, LIVE_MODULE.moduleId, record, String(version), routeTrack)
  const etas = useRowHistory(LIVE_MODULE.workspaceId, LIVE_MODULE.moduleId, record, String(version), routeEtas)
  const stopName = useServerNames(PICKUPS_MODULE, "pickup")
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
        <h4 className="text-xs font-medium text-muted-foreground">Track</h4>
        <ReadRows read={track} label="Reading the route's track…" empty="No track." testId="live-track" line={(read) => <TrackDrawing track={read} timezone={timezone} />} />
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Expected at each stop</h4>
        <ReadRows
          read={{ rows: etas.rows === null ? null : etas.rows.flatMap((read) => read.stops), problem: etas.problem }}
          label="Reading the route's estimates…"
          empty="No active Plan: nothing to estimate."
          testId="live-etas"
          line={(stop) => <StopEtaLine stop={stop} name={stop.pickupId === null ? "Unload visit" : stopName(stop.pickupId)} timezone={timezone} />}
        />
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Sessions</h4>
        <ReadRows read={sessions} label="Reading the route's sessions…" empty="Not started: no driver has started this route." testId="live-sessions" line={(session) => sessionLine(session, timezone)} />
      </div>
    </section>
  )
}

/** A session's track as a line in a box, north up (O8 of #290), with when it starts and ends; the positions are kept 30 days at most. */
function TrackDrawing({ track, timezone }: { track: RouteTrack; timezone: string | undefined }) {
  const first = track.points[0]
  const last = track.points.at(-1)
  if (first === undefined || last === undefined) return <span className="text-muted-foreground">{track.sessionId === null ? "Not started: no track." : "No position recorded for this session."}</span>
  const path = trackPath(track.points, 240, 120)
  return (
    <div className="space-y-1">
      {path !== null && (
        <svg viewBox="0 0 240 120" className="h-32 w-full max-w-sm rounded-md border bg-muted/30" role="img" aria-label={`Track of ${track.points.length} positions`}>
          <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="text-primary" />
        </svg>
      )}
      <p className="text-muted-foreground">
        {track.points.length} {track.points.length === 1 ? "position" : "positions"}, {timeOn(first.at, timezone)} to {timeOn(last.at, timezone)}
        {track.thinned ? " (thinned to fit)" : ""}
      </p>
    </div>
  )
}

function StopEtaLine({ stop, name, timezone }: { stop: RouteEta["stops"][number]; name: string; timezone: string | undefined }) {
  return (
    <span className="flex justify-between gap-3">
      <span>
        {stop.position}. {name}
      </span>
      <span className="text-muted-foreground">{stop.eta === null ? "Passed or not estimated" : timeOn(stop.eta, timezone)}</span>
    </span>
  )
}
