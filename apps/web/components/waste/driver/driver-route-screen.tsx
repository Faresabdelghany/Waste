"use client"

// The Driver App's route screen (Issue #145), from `GET /driver/routes/:id`:
// the stops in the order they are driven (the Plan's `sequence` where there
// is one, else `position`), with the Plan's unload visits on the way between
// them (O15 of #290), each with its address, container (none at an
// address-only stop the office added, #111), fraction and status, the
// place's instructions to the driver where it has some (never the office's
// own notes), and an "Open in Maps" link over its own point, and per stop:
// arrived, scan the container to confirm it (O19 of #290), complete, skip, fail, report a problem, add a note, record a weight
// (O2 of #290), a signature, and a photo with a skip, a failure or a problem —
// of any stop where the deployment offers it (O1). On the route: the next places still to do handed to Maps in
// one link, report a problem,
// pause or resume, record an unload (any time while active, never required)
// and end the route behind a confirm that counts the stops still planned.
// What the read model makes impossible is not offered and a stop with a
// command waiting shows "Sending" until the server has answered; everything
// else is sent and the server decides (lib/driver/route-view.ts).
import { useEffect, useState } from "react"
import { ArrowLeft, Barcode, Camera, CheckCircle, FlagCheckered, Info, MapPin, MapTrifold, NavigationArrow, NotePencil, Pause, Play, Scales, Signature, SkipForward, Truck, Warning, XCircle } from "@phosphor-icons/react/dist/ssr"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useDriverApp, useDriverAppState } from "@/components/waste/driver/driver-app-provider"
import { EndRouteDialog, NoteDialog, ReasonDialog, UnloadDialog, WeightDialog } from "@/components/waste/driver/driver-dialogs"
import { DriverFrame } from "@/components/waste/driver/driver-frame"
import { DriverRouteMessages } from "@/components/waste/driver/driver-route-messages"
import { PhotoDialog, SignatureDialog } from "@/components/waste/driver/driver-proof-dialogs"
import { DriverLink, KeptNotice, RejectionList, operatingDay, progressLine } from "@/components/waste/driver/driver-parts"
import { ScanDialog } from "@/components/waste/driver/driver-scan-dialog"
import type { DriverMe, DriverPickup, DriverRouteDetail, DriverUnloadingStation } from "@waste/contracts/driver-commands"
import { keepShell, SHELL_ENABLED } from "@/lib/driver/app-shell"
import type { ProofBytes } from "@/lib/driver/commands"
import { scanOffered } from "@/lib/driver/container-scan"
import type { DriverAppController, Tap } from "@/lib/driver/driver-app"
import { STOP_PHOTOS } from "@/lib/driver/proof-images"
import { sessionRecords } from "@/lib/driver/position-recorder"
import { DRIVER_REASON_LABELS, endRouteWarning, entriesInOrder, mapsHref, PICKUP_STATUS_LABELS, ROUTE_STATUS_LABELS, routeActions, routeMapsHref, stopActions, stopCollects, stopServices, stopsInOrder, waitingOn } from "@/lib/driver/route-view"

/** A photo taken with a stop's exception goes first, then the exception: the queue sends in the order of the taps. */
async function withPhoto(app: DriverAppController, photo: ProofBytes | null, routeId: string, pickupId: string, then: Tap): Promise<void> {
  if (photo !== null) await app.tap({ kind: "add-photo", routeId, body: { pickupId }, object: photo })
  await app.tap(then)
}

export function DriverRouteScreen({ routeId }: { routeId: string }) {
  const app = useDriverApp()
  useEffect(() => app.watchRoute(routeId), [app, routeId])
  // A route screen reached inside the app was never asked for as a page: the shell is told to keep it.
  useEffect(() => void keepShell(window, SHELL_ENABLED), [routeId])
  return (
    <DriverFrame>
      <Button asChild variant="ghost" size="sm" className="self-start">
        <DriverLink href="/driver">
          <ArrowLeft aria-hidden />
          Your routes
        </DriverLink>
      </Button>
      <RouteContent routeId={routeId} />
    </DriverFrame>
  )
}

function RouteContent({ routeId }: { routeId: string }) {
  const state = useDriverAppState()
  const read = state.routes[routeId]
  if (read === undefined || state.me === null) return <p className="py-8 text-center text-sm text-muted-foreground">{state.unreachable ? "The route could not be read yet." : "Loading the route…"}</p>
  if (read.status === "missing") return <p className="rounded-xl border p-4 text-sm">{read.sentence}</p>
  return <RouteDetailView detail={read.detail} me={state.me} />
}

function RouteDetailView({ detail, me }: { detail: DriverRouteDetail; me: DriverMe }) {
  const app = useDriverApp()
  const state = useDriverAppState()
  const actions = routeActions(detail, detail.session, state.waiting)
  const waiting = waitingOn(state.waiting, detail.id).length
  const rejections = state.rejections.filter((rejection) => rejection.routeId === detail.id && rejection.pickupId === null)
  const routeMaps = routeMapsHref(detail, state.waiting)
  // What each stop is for, read once for the route rather than per card.
  const services = stopServices(detail.pickups)
  // A stop's number counts the stops alone, the unload visits between them unnumbered.
  const numbers = new Map(stopsInOrder(detail.pickups).map((stop, index) => [stop.id, index + 1]))
  const [dialog, setDialog] = useState<"report" | "unload" | "end" | null>(null)
  const close = (open: boolean) => {
    if (!open) setDialog(null)
  }

  return (
    <main className="flex flex-col gap-4">
      <section aria-label={`Route ${detail.label}`} className="flex flex-col gap-3 rounded-xl border p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{detail.label}</h1>
            <p className="text-sm text-muted-foreground">{operatingDay(detail.operatingDate)}</p>
            <p className="text-sm text-muted-foreground">{progressLine(detail.progress)}</p>
            {sessionRecords(detail, me.driver.id) && <p className="text-sm text-muted-foreground">Your position is shared with the office while this route runs and this screen is open.</p>}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1 whitespace-nowrap">
            <Badge variant={detail.status === "active" ? "default" : "secondary"}>{ROUTE_STATUS_LABELS[detail.status]}</Badge>
            {detail.session?.pausedAt != null && <Badge variant="outline">Paused</Badge>}
            {waiting > 0 && <Badge variant="outline">Sending {waiting}</Badge>}
          </div>
        </div>
        <KeptNotice readAt={state.shownFrom.routes[detail.id]} />
        <RejectionList rejections={rejections} onDismiss={app.dismiss} />
        {routeMaps !== null && (
          <Button asChild variant="outline" className="h-11">
            <a href={routeMaps} target="_blank" rel="noopener noreferrer">
              <MapTrifold aria-hidden />
              Navigate the next stops in Maps
            </a>
          </Button>
        )}
        {detail.status === "ready" && !actions.sending && (
          <p className="text-sm text-muted-foreground">
            Start this route from{" "}
            <DriverLink href="/driver" className="underline underline-offset-4">
              your routes
            </DriverLink>
            .
          </p>
        )}
        {(actions.pause || actions.resume || actions.report || actions.unload || actions.end) && (
          <div className="grid grid-cols-2 gap-2">
            {actions.resume ? (
              <Button variant="outline" className="h-11" onClick={() => void app.tap({ kind: "resume", routeId: detail.id, body: {} })}>
                <Play aria-hidden />
                Resume
              </Button>
            ) : (
              <Button variant="outline" className="h-11" disabled={!actions.pause} onClick={() => void app.tap({ kind: "pause", routeId: detail.id, body: {} })}>
                <Pause aria-hidden />
                Pause
              </Button>
            )}
            <Button variant="outline" className="h-11" disabled={!actions.unload} onClick={() => setDialog("unload")}>
              <Scales aria-hidden />
              Record unload
            </Button>
            <Button variant="outline" className="h-11" disabled={!actions.report} onClick={() => setDialog("report")}>
              <Warning aria-hidden />
              Report a problem
            </Button>
            <Button className="h-11" disabled={!actions.end} onClick={() => setDialog("end")}>
              <FlagCheckered aria-hidden />
              End route
            </Button>
          </div>
        )}
      </section>

      <ol className="flex flex-col gap-3" aria-label="Stops">
        {entriesInOrder(detail.pickups, detail.activePlan).map((entry, index) =>
          entry.kind === "stop" ? (
            <li key={entry.stop.id}>
              <StopCard detail={detail} stop={entry.stop} number={numbers.get(entry.stop.id) ?? index + 1} service={services.get(entry.stop.id) ?? null} numberOf={(id) => numbers.get(id)} />
            </li>
          ) : (
            <li key={`unload-${index}`}>
              <UnloadCard station={me.unloadingStations.find((candidate) => candidate.id === entry.unloadingStationId)} recordable={actions.unload} onRecord={() => setDialog("unload")} />
            </li>
          ),
        )}
      </ol>

      <ReasonDialog
        open={dialog === "report"}
        onOpenChange={close}
        title="Report a problem on the route"
        description="The office hears of it as a ticket."
        confirm="Report problem"
        noteRequired
        takesPhoto={false}
        onConfirm={(reason, note) => void app.tap({ kind: "report-problem", routeId: detail.id, body: { reason, note: note ?? "" } })}
      />
      <UnloadDialog open={dialog === "unload"} onOpenChange={close} me={me} onConfirm={(body) => void app.tap({ kind: "record-unload", routeId: detail.id, body })} />
      <EndRouteDialog open={dialog === "end"} onOpenChange={close} warning={endRouteWarning(detail, state.waiting)} onConfirm={() => void app.tap({ kind: "end-route", routeId: detail.id, body: {} })} />
      <DriverRouteMessages routeId={detail.id} />
    </main>
  )
}

/** An unload visit the active Plan makes on the way (O15 of #290): the vehicle is full here, so it empties at the station and goes on. */
function UnloadCard({ station, recordable, onRecord }: { station: DriverUnloadingStation | undefined; recordable: boolean; onRecord: () => void }) {
  const maps = station === undefined ? null : mapsHref(station.location)
  return (
    <article aria-label="Unload on the way" className="flex flex-col gap-3 rounded-xl border border-dashed p-4">
      <div className="flex items-start gap-3">
        <Truck aria-hidden className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <h2 className="font-semibold">Unload at {station?.name ?? "the unloading station"}</h2>
          <p className="text-sm text-muted-foreground">The vehicle is full here: empty it at the station, then go on to the next stop.</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {maps !== null && (
          <Button asChild variant="ghost" size="sm">
            <a href={maps} target="_blank" rel="noopener noreferrer">
              <NavigationArrow aria-hidden />
              Open in Maps
            </a>
          </Button>
        )}
        <Button variant="outline" size="sm" disabled={!recordable} onClick={onRecord}>
          <Scales aria-hidden />
          Record unload
        </Button>
      </div>
    </article>
  )
}

function StopCard({ detail, stop, number, service, numberOf }: { detail: DriverRouteDetail; stop: DriverPickup; number: number; service: string | null; numberOf: (pickupId: string) => number | undefined }) {
  const app = useDriverApp()
  const state = useDriverAppState()
  const actions = stopActions(detail, stop, state.waiting)
  const rejections = state.rejections.filter((rejection) => rejection.pickupId === stop.id)
  const maps = mapsHref(stop.location)
  const [dialog, setDialog] = useState<"skip" | "fail" | "report" | "note" | "weight" | "signature" | "photo" | "scan" | null>(null)
  const close = (open: boolean) => {
    if (!open) setDialog(null)
  }

  return (
    <article aria-label={`Stop ${number}`} className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">Stop {number}</p>
          <h2 className="font-semibold">{stop.address}</h2>
          <p className="text-sm text-muted-foreground">{stopCollects(stop)}</p>
          {stop.reason !== null && (
            <p className="text-sm text-muted-foreground">
              {PICKUP_STATUS_LABELS[stop.status]} · {stop.reason in DRIVER_REASON_LABELS ? DRIVER_REASON_LABELS[stop.reason as keyof typeof DRIVER_REASON_LABELS] : stop.reason.replaceAll("-", " ")}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 whitespace-nowrap">
          <Badge variant={stop.status === "planned" ? "outline" : "secondary"}>{PICKUP_STATUS_LABELS[stop.status]}</Badge>
          {stop.status === "planned" && stop.arrivedAt !== null && <Badge variant="outline">Arrived</Badge>}
          {/* Truthy, not non-null: an API from before the scan answers none at all. */}
          {stop.containerConfirmedAt ? <Badge variant="outline">Container confirmed</Badge> : null}
          {service !== null && <Badge variant="outline">{service}</Badge>}
          {actions.sending && <Badge variant="outline">Sending</Badge>}
        </div>
      </div>
      {/* Truthy, not non-null: an API from before the field answers none at all, and an empty note is worse than none. */}
      {stop.driverInstructions ? (
        <div role="note" aria-label="Driver instructions" className="flex gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
          <Info aria-hidden className="mt-0.5 shrink-0" />
          <p className="whitespace-pre-line">{stop.driverInstructions}</p>
        </div>
      ) : null}
      <RejectionList rejections={rejections} onDismiss={app.dismiss} />
      <div className="flex flex-wrap gap-2">
        {maps !== null && (
          <Button asChild variant="ghost" size="sm">
            <a href={maps} target="_blank" rel="noopener noreferrer">
              <NavigationArrow aria-hidden />
              Open in Maps
            </a>
          </Button>
        )}
        {actions.arrive && (
          <Button variant="outline" size="sm" onClick={() => void app.tap({ kind: "arrive", routeId: detail.id, body: { pickupId: stop.id } })}>
            <MapPin aria-hidden />
            Arrived
          </Button>
        )}
        {scanOffered(stop, actions) && (
          <Button variant="outline" size="sm" onClick={() => setDialog("scan")}>
            <Barcode aria-hidden />
            Scan container
          </Button>
        )}
      </div>
      {(actions.outcome || actions.report) && (
        <div className="grid grid-cols-2 gap-2">
          {/* A decided stop keeps its problem report, a note and a weight: its outcome stands, and a second is the office's correction. */}
          {stop.status === "planned" && (
            <>
              <Button className="h-11" disabled={!actions.outcome} onClick={() => void app.tap({ kind: "complete-pickup", routeId: detail.id, body: { pickupId: stop.id } })}>
                <CheckCircle aria-hidden />
                Complete
              </Button>
              <Button variant="outline" className="h-11" disabled={!actions.outcome} onClick={() => setDialog("skip")}>
                <SkipForward aria-hidden />
                Skip
              </Button>
              <Button variant="outline" className="h-11" disabled={!actions.outcome} onClick={() => setDialog("fail")}>
                <XCircle aria-hidden />
                Fail
              </Button>
            </>
          )}
          <Button variant="outline" className="h-11" disabled={!actions.report} onClick={() => setDialog("report")}>
            <Warning aria-hidden />
            Problem
          </Button>
          <Button variant="outline" className="h-11" disabled={!actions.report} onClick={() => setDialog("note")}>
            <NotePencil aria-hidden />
            Note
          </Button>
          <Button variant="outline" className="h-11" disabled={!actions.report} onClick={() => setDialog("weight")}>
            <Scales aria-hidden />
            Weight
          </Button>
          <Button variant="outline" className="h-11" disabled={!actions.report} onClick={() => setDialog("signature")}>
            <Signature aria-hidden />
            Signature
          </Button>
          {STOP_PHOTOS && (
            <Button variant="outline" className="h-11" disabled={!actions.report} onClick={() => setDialog("photo")}>
              <Camera aria-hidden />
              Photo
            </Button>
          )}
        </div>
      )}
      <ScanDialog
        open={dialog === "scan"}
        onOpenChange={close}
        title={`Scan the container at stop ${number}`}
        description={stop.containerLabel === null ? stop.address : `${stop.containerLabel} · ${stop.address}`}
        stopId={stop.id}
        numberOf={numberOf}
        identify={(code) => app.identify(detail.id, code)}
        onConfirm={(identification) => void app.tap({ kind: "arrive", routeId: detail.id, body: { pickupId: stop.id, identification } })}
      />
      <ReasonDialog
        open={dialog === "skip"}
        onOpenChange={close}
        title={`Skip stop ${number}`}
        description={stop.address}
        confirm="Skip stop"
        noteRequired={false}
        takesPhoto
        onConfirm={(reason, note, photo) => void withPhoto(app, photo, detail.id, stop.id, { kind: "skip-pickup", routeId: detail.id, body: { pickupId: stop.id, reason, ...(note === undefined ? {} : { note }) } })}
      />
      <ReasonDialog
        open={dialog === "fail"}
        onOpenChange={close}
        title={`Fail stop ${number}`}
        description={stop.address}
        confirm="Fail stop"
        noteRequired={false}
        takesPhoto
        onConfirm={(reason, note, photo) => void withPhoto(app, photo, detail.id, stop.id, { kind: "fail-pickup", routeId: detail.id, body: { pickupId: stop.id, reason, ...(note === undefined ? {} : { note }) } })}
      />
      <ReasonDialog
        open={dialog === "report"}
        onOpenChange={close}
        title={`Report a problem at stop ${number}`}
        description={stop.address}
        confirm="Report problem"
        noteRequired
        takesPhoto
        onConfirm={(reason, note, photo) => void withPhoto(app, photo, detail.id, stop.id, { kind: "report-problem", routeId: detail.id, body: { pickupId: stop.id, reason, note: note ?? "" } })}
      />
      <NoteDialog open={dialog === "note"} onOpenChange={close} title={`A note on stop ${number}`} description={stop.address} onConfirm={(note) => void app.tap({ kind: "add-note", routeId: detail.id, body: { pickupId: stop.id, note } })} />
      <SignatureDialog
        open={dialog === "signature"}
        onOpenChange={close}
        title={`Signature at stop ${number}`}
        description={stop.address}
        onConfirm={(signature) => void app.tap({ kind: "add-signature", routeId: detail.id, body: { pickupId: stop.id }, object: signature })}
      />
      <PhotoDialog open={dialog === "photo"} onOpenChange={close} title={`A photo of stop ${number}`} description={stop.address} onConfirm={(photo) => void app.tap({ kind: "add-photo", routeId: detail.id, body: { pickupId: stop.id }, object: photo })} />
      <WeightDialog open={dialog === "weight"} onOpenChange={close} title={`Weight at stop ${number}`} description={stopCollects(stop)} onConfirm={(weightKg) => void app.tap({ kind: "add-weight", routeId: detail.id, body: { pickupId: stop.id, weightKg } })} />
    </article>
  )
}
