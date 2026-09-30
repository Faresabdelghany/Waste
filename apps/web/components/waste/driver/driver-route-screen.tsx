"use client"

// The Driver App's route screen (Issue #145), from `GET /driver/routes/:id`:
// the stops in the order they are driven (the Plan's `sequence` where there
// is one, else `position`), each with its address, container, fraction and
// status and an "Open in Maps" link over its own point, and per stop:
// complete, skip, fail, report a problem. On the route: report a problem,
// pause or resume, record an unload (any time while active, never required)
// and end the route behind a confirm that counts the stops still planned.
// What the read model makes impossible is not offered and a stop with a
// command waiting shows "Sending" until the server has answered; everything
// else is sent and the server decides (lib/driver/route-view.ts).
import Link from "next/link"
import { useEffect, useState } from "react"
import { ArrowLeft, CheckCircle, FlagCheckered, NavigationArrow, Pause, Play, Scales, SkipForward, Warning, XCircle } from "@phosphor-icons/react/dist/ssr"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useDriverApp, useDriverAppState } from "@/components/waste/driver/driver-app-provider"
import { EndRouteDialog, ReasonDialog, UnloadDialog } from "@/components/waste/driver/driver-dialogs"
import { DriverFrame } from "@/components/waste/driver/driver-frame"
import { RejectionList, operatingDay, progressLine } from "@/components/waste/driver/driver-parts"
import type { DriverMe, DriverPickup, DriverRouteDetail } from "@waste/contracts/driver-commands"
import { DRIVER_REASON_LABELS, endRouteWarning, mapsHref, PICKUP_STATUS_LABELS, ROUTE_STATUS_LABELS, routeActions, stopActions, stopsInOrder, waitingOn } from "@/lib/driver/route-view"

export function DriverRouteScreen({ routeId }: { routeId: string }) {
  const app = useDriverApp()
  useEffect(() => app.watchRoute(routeId), [app, routeId])
  return (
    <DriverFrame>
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/driver">
          <ArrowLeft aria-hidden />
          Your routes
        </Link>
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
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1 whitespace-nowrap">
            <Badge variant={detail.status === "active" ? "default" : "secondary"}>{ROUTE_STATUS_LABELS[detail.status]}</Badge>
            {detail.session?.pausedAt != null && <Badge variant="outline">Paused</Badge>}
            {waiting > 0 && <Badge variant="outline">Sending {waiting}</Badge>}
          </div>
        </div>
        <RejectionList rejections={rejections} onDismiss={app.dismiss} />
        {detail.status === "ready" && !actions.sending && (
          <p className="text-sm text-muted-foreground">
            Start this route from{" "}
            <Link href="/driver" className="underline underline-offset-4">
              your routes
            </Link>
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
        {stopsInOrder(detail.pickups).map((stop, index) => (
          <li key={stop.id}>
            <StopCard detail={detail} stop={stop} number={stop.sequence ?? index + 1} />
          </li>
        ))}
      </ol>

      <ReasonDialog
        open={dialog === "report"}
        onOpenChange={close}
        title="Report a problem on the route"
        description="The office hears of it as a ticket."
        confirm="Report problem"
        noteRequired
        onConfirm={(reason, note) => void app.tap({ kind: "report-problem", routeId: detail.id, body: { reason, note: note ?? "" } })}
      />
      <UnloadDialog open={dialog === "unload"} onOpenChange={close} me={me} onConfirm={(body) => void app.tap({ kind: "record-unload", routeId: detail.id, body })} />
      <EndRouteDialog open={dialog === "end"} onOpenChange={close} warning={endRouteWarning(detail, state.waiting)} onConfirm={() => void app.tap({ kind: "end-route", routeId: detail.id, body: {} })} />
    </main>
  )
}

function StopCard({ detail, stop, number }: { detail: DriverRouteDetail; stop: DriverPickup; number: number }) {
  const app = useDriverApp()
  const state = useDriverAppState()
  const actions = stopActions(detail, stop, state.waiting)
  const rejections = state.rejections.filter((rejection) => rejection.pickupId === stop.id)
  const maps = mapsHref(stop.location)
  const [dialog, setDialog] = useState<"skip" | "fail" | "report" | null>(null)
  const close = (open: boolean) => {
    if (!open) setDialog(null)
  }

  return (
    <article aria-label={`Stop ${number}`} className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">Stop {number}</p>
          <h2 className="font-semibold">{stop.address}</h2>
          <p className="text-sm text-muted-foreground">
            {stop.containerLabel} · {stop.wasteFractionName}
          </p>
          {stop.reason !== null && (
            <p className="text-sm text-muted-foreground">
              {PICKUP_STATUS_LABELS[stop.status]} · {stop.reason in DRIVER_REASON_LABELS ? DRIVER_REASON_LABELS[stop.reason as keyof typeof DRIVER_REASON_LABELS] : stop.reason.replaceAll("-", " ")}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 whitespace-nowrap">
          <Badge variant={stop.status === "planned" ? "outline" : "secondary"}>{PICKUP_STATUS_LABELS[stop.status]}</Badge>
          {actions.sending && <Badge variant="outline">Sending</Badge>}
        </div>
      </div>
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
      </div>
      {(actions.outcome || actions.report) && (
        <div className="grid grid-cols-2 gap-2">
          {/* A decided stop keeps only its problem report: its outcome stands, and a second is the office's correction. */}
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
        </div>
      )}
      <ReasonDialog
        open={dialog === "skip"}
        onOpenChange={close}
        title={`Skip stop ${number}`}
        description={stop.address}
        confirm="Skip stop"
        noteRequired={false}
        onConfirm={(reason, note) => void app.tap({ kind: "skip-pickup", routeId: detail.id, body: { pickupId: stop.id, reason, ...(note === undefined ? {} : { note }) } })}
      />
      <ReasonDialog
        open={dialog === "fail"}
        onOpenChange={close}
        title={`Fail stop ${number}`}
        description={stop.address}
        confirm="Fail stop"
        noteRequired={false}
        onConfirm={(reason, note) => void app.tap({ kind: "fail-pickup", routeId: detail.id, body: { pickupId: stop.id, reason, ...(note === undefined ? {} : { note }) } })}
      />
      <ReasonDialog
        open={dialog === "report"}
        onOpenChange={close}
        title={`Report a problem at stop ${number}`}
        description={stop.address}
        confirm="Report problem"
        noteRequired
        onConfirm={(reason, note) => void app.tap({ kind: "report-problem", routeId: detail.id, body: { pickupId: stop.id, reason, note: note ?? "" } })}
      />
    </article>
  )
}
