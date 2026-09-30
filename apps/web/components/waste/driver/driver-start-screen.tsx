"use client"

// The Driver App's start screen (Issue #145), from `GET /driver/me`: the open
// Session, and the routes the door bounds — ready or active, or completed
// today — by operating date, with no date picker. A ready route offers Start
// on its planned vehicle and trailer, changeable from the project's lists the
// door carries (#144). Whether the driver may take that vehicle, whether it
// is in service and whether another route is still open are the server's to
// say: the start is sent, and a refusal comes back as its sentence on the
// route, which stays ready.
import Link from "next/link"
import { useState } from "react"
import { ArrowClockwise, MapPin, Play } from "@phosphor-icons/react/dist/ssr"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useDriverApp, useDriverAppState } from "@/components/waste/driver/driver-app-provider"
import { NativeSelect } from "@/components/waste/driver/driver-dialogs"
import { DriverFrame } from "@/components/waste/driver/driver-frame"
import { RejectionList, operatingDay, progressLine } from "@/components/waste/driver/driver-parts"
import type { DriverMe } from "@waste/contracts/driver-commands"
import type { Route } from "@waste/contracts/routes"
import { ROUTE_STATUS_LABELS, routeActions, routesInDayOrder, waitingOn } from "@/lib/driver/route-view"

export function DriverStartScreen() {
  return (
    <DriverFrame>
      <StartContent />
    </DriverFrame>
  )
}

function StartContent() {
  const app = useDriverApp()
  const state = useDriverAppState()
  const me = state.me
  if (me === null) return null
  const open = me.openSession === null ? undefined : me.routes.find((candidate) => candidate.id === me.openSession?.routeId)

  return (
    <main className="flex flex-col gap-4">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <MapPin aria-hidden className="shrink-0" />
        Your position travels with your actions on your route, when this phone shares it.
      </p>
      {open !== undefined && (
        <section className="flex items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/5 p-4">
          <div>
            <p className="text-sm text-muted-foreground">You are on</p>
            <p className="text-lg font-semibold">{open.label}</p>
          </div>
          <Button asChild className="h-11">
            <Link href={`/driver/routes/${open.id}`}>Continue route</Link>
          </Button>
        </section>
      )}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Your routes</h1>
        <Button variant="ghost" size="sm" onClick={() => void app.retry()}>
          <ArrowClockwise aria-hidden />
          Refresh
        </Button>
      </div>
      {me.routes.length === 0 ? (
        <p className="rounded-xl border p-4 text-sm text-muted-foreground">No route is dispatched to you. When the office dispatches one, it appears here.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {routesInDayOrder(me.routes).map((candidate) => (
            <li key={candidate.id}>
              <RouteCard route={candidate} me={me} />
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

function RouteCard({ route, me }: { route: Route; me: DriverMe }) {
  const app = useDriverApp()
  const state = useDriverAppState()
  const waiting = waitingOn(state.waiting, route.id)
  const actions = routeActions(route, null, state.waiting)
  const rejections = state.rejections.filter((rejection) => rejection.routeId === route.id && rejection.pickupId === null)

  return (
    <article aria-label={`Route ${route.label}`} className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{route.label}</h2>
          <p className="text-sm text-muted-foreground">
            {operatingDay(route.operatingDate)}
            {route.plannedStartTime !== null && ` · starts ${route.plannedStartTime.slice(0, 5)}`}
          </p>
          <p className="text-sm text-muted-foreground">{progressLine(route.progress)}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 whitespace-nowrap">
          <Badge variant={route.status === "active" ? "default" : "secondary"}>{ROUTE_STATUS_LABELS[route.status]}</Badge>
          {waiting.length > 0 && <Badge variant="outline">Sending</Badge>}
        </div>
      </div>
      <RejectionList rejections={rejections} onDismiss={app.dismiss} />
      {actions.start && <StartForm route={route} me={me} />}
      <Button asChild variant={route.status === "active" ? "default" : "outline"} className="h-11">
        <Link href={`/driver/routes/${route.id}`}>Open route</Link>
      </Button>
    </article>
  )
}

function StartForm({ route, me }: { route: Route; me: DriverMe }) {
  const app = useDriverApp()
  const vehicles = me.vehicles.filter((vehicle) => vehicle.kind !== "trailer")
  const trailers = me.vehicles.filter((vehicle) => vehicle.kind === "trailer")
  const planned = (id: string | null, from: typeof vehicles) => (id !== null && from.some((vehicle) => vehicle.id === id) ? id : "")
  const [vehicleId, setVehicleId] = useState(() => planned(route.planned.vehicleId, vehicles) || (vehicles[0]?.id ?? ""))
  const [trailerId, setTrailerId] = useState(() => planned(route.planned.trailerId, trailers))

  return (
    <form
      className="flex flex-col gap-3 border-t pt-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (vehicleId === "") return
        void app.tap({ kind: "start-route", routeId: route.id, body: { vehicleId, ...(trailerId === "" ? {} : { trailerId }) } })
      }}
    >
      <NativeSelect id={`vehicle-${route.id}`} label="Vehicle" value={vehicleId} onChange={setVehicleId}>
        {vehicles.map((vehicle) => (
          <option key={vehicle.id} value={vehicle.id}>
            {vehicle.label}
            {vehicle.id === route.planned.vehicleId ? " (planned)" : ""}
          </option>
        ))}
      </NativeSelect>
      {trailers.length > 0 && (
        <NativeSelect id={`trailer-${route.id}`} label="Trailer" value={trailerId} onChange={setTrailerId}>
          <option value="">No trailer</option>
          {trailers.map((trailer) => (
            <option key={trailer.id} value={trailer.id}>
              {trailer.label}
              {trailer.id === route.planned.trailerId ? " (planned)" : ""}
            </option>
          ))}
        </NativeSelect>
      )}
      <Button type="submit" className="h-11" disabled={vehicleId === ""}>
        <Play aria-hidden weight="fill" />
        Start route
      </Button>
    </form>
  )
}
