"use client"
// Operate › Bulky Bookings on the Pilot (O11 of #290). Book bulky collection
// is the module's own dialog: the customer, the agreement charged — the
// customer's, signed — the place in the agreement's project, the fraction,
// then the days the place may be booked on, read from the API's availability
// with each day's slots left (a full one shown and not offered), and the
// items. A booking's details offer, while it stands booked, Route — onto a
// route of its project running on its day, not started — and Cancel, with
// why. The API's refusal is the store's toast in its own words. The words
// and the helpers are lib/data/bulky.ts', the adapter
// lib/api/records/bulky-bookings.ts.
import { useRef, useState, type FormEvent } from "react"
import { Plus, Trash } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { BulkyAvailableDay } from "@waste/contracts/bulky"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useApiClient } from "@/components/waste/api-session-store"
import { useBusinessRecordStore, useModuleRecords, useServerResolver, whenSaved } from "@/components/waste/business-record-store"
import type { PrimarySurfaceProps, RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { useCommandRunner, useModuleReady, useOpenRecord, useRelationPickers } from "@/components/waste/commands/use-command-support"
import { problemSentence } from "@/lib/api/problem"
import { bulkyAvailability, CANCEL_BOOKING, ROUTE_BOOKING } from "@/lib/api/records/bulky-bookings"
import { dayIn } from "@/lib/api/records/planning"
import { problemOfError } from "@/lib/api/records/server-records"
import { AGREEMENTS_MODULE, isAgreementRecord } from "@/lib/data/agreements"
import { getModuleDefinition, type BusinessRecord, type ModuleLocation } from "@/lib/data/business-modules"
import { agreementsOfCustomer, availabilityWindow, BULKY_BOOKINGS_MODULE, bookingMoves, bookingRecordOf, dayOption, ITEMS_MAX, itemsOf, routesForBooking, type ItemRow } from "@/lib/data/bulky"
import { PROPERTIES_MODULE, SHARED_POINTS_MODULE } from "@/lib/data/properties"

const NO_RECORDS: readonly BusinessRecord[] = []
const fixturesOf = (location: ModuleLocation) => getModuleDefinition(location)?.records ?? NO_RECORDS
const ROUTES = { workspaceId: "route-studio", moduleId: "routes" } as const satisfies ModuleLocation

/** A place as the dialog's one picker holds it: which of the two, and its web id. */
const placeValue = (kind: "property" | "point", id: string) => `${kind}:${id}`
const placeOf = (value: string): { propertyId: string; sharedCollectionPointId: string } => {
  const [kind, id = ""] = value.split(":")
  return kind === "property" ? { propertyId: id, sharedCollectionPointId: "" } : kind === "point" ? { propertyId: "", sharedCollectionPointId: id } : { propertyId: "", sharedCollectionPointId: "" }
}

/** The days read for a place, or why they could not be. */
type DaysRead = { status: "idle" } | { status: "reading" } | { status: "read"; days: BulkyAvailableDay[] } | { status: "refused"; sentence: string }

const field = (id: string, label: string, relation?: ModuleLocation) => ({ id, label, type: "select" as const, required: true, ...(relation === undefined ? {} : { relation }) })

/** Book bulky collection: the module's primary action. */
export function BookBulkySurface({ label }: PrimarySurfaceProps) {
  const client = useApiClient()
  const resolver = useServerResolver()
  const { upsertRecord } = useBusinessRecordStore()
  const pickers = useRelationPickers()
  const moduleReady = useModuleReady(BULKY_BOOKINGS_MODULE)
  const openRecord = useOpenRecord(BULKY_BOOKINGS_MODULE.moduleId)
  const agreements = useModuleRecords(AGREEMENTS_MODULE.workspaceId, AGREEMENTS_MODULE.moduleId, fixturesOf(AGREEMENTS_MODULE))
  const properties = useModuleRecords(PROPERTIES_MODULE.workspaceId, PROPERTIES_MODULE.moduleId, fixturesOf(PROPERTIES_MODULE))
  const points = useModuleRecords(SHARED_POINTS_MODULE.workspaceId, SHARED_POINTS_MODULE.moduleId, fixturesOf(SHARED_POINTS_MODULE))

  const [open, setOpen] = useState(false)
  const [customerId, setCustomerId] = useState("")
  const [agreementId, setAgreementId] = useState("")
  const [place, setPlace] = useState("")
  const [wasteFractionId, setWasteFractionId] = useState("")
  const [day, setDay] = useState("")
  const [items, setItems] = useState<ItemRow[]>([{ description: "", quantity: "1" }])
  const [note, setNote] = useState("")
  const [refusal, setRefusal] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [days, setDays] = useState<DaysRead>({ status: "idle" })

  const agreement = agreements.records.find((record) => record.id === agreementId)
  const projectId = agreement?.projectIds?.[0] ?? ""
  const customers = pickers.options(field("customerId", "Customer", { workspaceId: "customers", moduleId: "contacts" }), {})
  const fractions = pickers.options(field("wasteFractionId", "Waste fraction"), {})
  const ofProject = (records: readonly BusinessRecord[]) => records.filter((record) => projectId !== "" && record.projectIds?.includes(projectId))
  const placeOptions = [
    ...ofProject(properties.records).map((record) => ({ value: placeValue("property", record.id), label: record.name })),
    ...ofProject(points.records).map((record) => ({ value: placeValue("point", record.id), label: `${record.name} · shared point` })),
  ]
  const chosenPlace = placeOf(place)

  // The days are read again whenever the place moves: they are the place's area's. A later pick wins over a read still on its way.
  const asked = useRef(0)
  const pickPlace = (value: string) => {
    setPlace(value)
    setDay("")
    const picked = placeOf(value)
    const webId = picked.propertyId !== "" ? picked.propertyId : picked.sharedCollectionPointId
    const serverId = resolver.serverIdOf(webId)
    if (client === null || serverId === undefined) {
      setDays({ status: "refused", sentence: "The place is not one the API holds yet." })
      return
    }
    const ask = ++asked.current
    setDays({ status: "reading" })
    bulkyAvailability(client, picked.propertyId !== "" ? { propertyId: serverId } : { sharedCollectionPointId: serverId }, availabilityWindow(dayIn(new Date(), pickers.timezoneOf(projectId)))).then(
      (read) => {
        if (asked.current === ask) setDays({ status: "read", days: read })
      },
      (error: unknown) => {
        if (asked.current === ask) setDays({ status: "refused", sentence: problemSentence(problemOfError(error)) })
      },
    )
  }

  const reset = () => {
    setCustomerId("")
    setAgreementId("")
    setPlace("")
    setWasteFractionId("")
    setDay("")
    setItems([{ description: "", quantity: "1" }])
    setNote("")
    setRefusal(null)
    setDays({ status: "idle" })
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    const listed = itemsOf(items)
    const missing = customerId === "" ? "Pick the customer who books" : agreementId === "" ? "Pick the agreement the collection is charged to" : place === "" ? "Pick the place" : wasteFractionId === "" ? "Pick the waste fraction" : day === "" ? "Pick a day" : typeof listed === "string" ? listed : null
    if (missing !== null || typeof listed === "string") {
      setRefusal(missing)
      return
    }
    const placeName = placeOptions.find((option) => option.value === place)?.label ?? ""
    const record = bookingRecordOf({ projectId, customerId, agreementId, ...chosenPlace, wasteFractionId, day, items: listed, note }, placeName, Date.now())
    setSaving(true)
    whenSaved(
      upsertRecord(BULKY_BOOKINGS_MODULE.workspaceId, BULKY_BOOKINGS_MODULE.moduleId, record),
      () => {
        setOpen(false)
        reset()
        openRecord(record.id)
        toast.success("Bulky collection booked", { description: record.name })
      },
      () => setSaving(false),
    )
  }

  const message = refusal === null ? null : <p className="text-sm text-destructive">{refusal}</p>
  const dayHint =
    place === ""
      ? "Pick the place first: its days are its planning area's."
      : days.status === "reading"
        ? "Reading the place's days…"
        : days.status === "refused"
          ? days.sentence
          : days.status === "read" && days.days.length === 0
            ? "No bulky collection day in the next four weeks."
            : null

  return (
    <>
      <Button size="sm" disabled={!moduleReady} onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" weight="bold" />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !saving && setOpen(next)}>
        <DialogContent className="sm:max-w-xl">
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Book bulky collection</DialogTitle>
              <DialogDescription>The customer&apos;s items, collected at their place on a day of its area&apos;s bulky schedule and charged to their agreement once collected.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="bulky-customer">Customer</Label>
                <Select
                  value={customerId}
                  onValueChange={(next) => {
                    setCustomerId(next)
                    setAgreementId("")
                    setPlace("")
                  }}
                >
                  <SelectTrigger id="bulky-customer">
                    <SelectValue placeholder="Pick a customer" />
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bulky-agreement">Agreement</Label>
                <Select
                  value={agreementId}
                  onValueChange={(next) => {
                    setAgreementId(next)
                    setPlace("")
                  }}
                  disabled={customerId === ""}
                >
                  <SelectTrigger id="bulky-agreement">
                    <SelectValue placeholder="Pick the agreement charged" />
                  </SelectTrigger>
                  <SelectContent>
                    {agreementsOfCustomer(agreements.records.filter(isAgreementRecord), customerId).map((record) => (
                      <SelectItem key={record.id} value={record.id}>
                        {record.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bulky-place">Place</Label>
                <Select value={place} onValueChange={pickPlace} disabled={agreementId === ""}>
                  <SelectTrigger id="bulky-place">
                    <SelectValue placeholder="Pick the property or shared point" />
                  </SelectTrigger>
                  <SelectContent>
                    {placeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bulky-fraction">Waste fraction</Label>
                <Select value={wasteFractionId} onValueChange={setWasteFractionId}>
                  <SelectTrigger id="bulky-fraction">
                    <SelectValue placeholder="Pick a fraction" />
                  </SelectTrigger>
                  <SelectContent>
                    {fractions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="bulky-day">Day</Label>
                <Select value={day} onValueChange={setDay} disabled={days.status !== "read" || days.days.length === 0}>
                  <SelectTrigger id="bulky-day">
                    <SelectValue placeholder="Pick a day with a slot left" />
                  </SelectTrigger>
                  <SelectContent>
                    {(days.status === "read" ? days.days : []).map(dayOption).map((option) => (
                      <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {dayHint !== null && <p className="text-xs text-muted-foreground">{dayHint}</p>}
              </div>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Items</legend>
              {items.map((row, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input aria-label={`Item ${index + 1}`} placeholder="Sofa, fridge, mattress…" value={row.description} onChange={(event) => setItems(items.map((item, at) => (at === index ? { ...item, description: event.target.value } : item)))} />
                  <Input aria-label={`Count of item ${index + 1}`} className="w-20" inputMode="numeric" value={row.quantity} onChange={(event) => setItems(items.map((item, at) => (at === index ? { ...item, quantity: event.target.value } : item)))} />
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={`Remove item ${index + 1}`} disabled={items.length === 1} onClick={() => setItems(items.filter((_, at) => at !== index))}>
                    <Trash className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" disabled={items.length >= ITEMS_MAX} onClick={() => setItems([...items, { description: "", quantity: "1" }])}>
                <Plus className="h-4 w-4" weight="bold" />
                Add item
              </Button>
            </fieldset>

            <div className="space-y-1.5">
              <Label htmlFor="bulky-note">Note for the driver</Label>
              <Textarea id="bulky-note" value={note} onChange={(event) => setNote(event.target.value)} />
            </div>
            {message}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                Book
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** A booking's details: Route and Cancel while it stands booked. */
export function BulkyBookingCommandsSurface({ record }: RowSurfaceProps) {
  const moduleReady = useModuleReady(BULKY_BOOKINGS_MODULE)
  const { busy, run } = useCommandRunner(BULKY_BOOKINGS_MODULE, record.id)
  const routes = useModuleRecords(ROUTES.workspaceId, ROUTES.moduleId, fixturesOf(ROUTES))
  const [routing, setRouting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [routeId, setRouteId] = useState("")
  const [reason, setReason] = useState("")
  const offered = routesForBooking(routes.records, record)
  const moves = bookingMoves(record)

  const route = (event: FormEvent) => {
    event.preventDefault()
    run(ROUTE_BOOKING, { routeId }, (outcome) => {
      setRouting(false)
      toast.success("Booking routed", { description: outcome.record.name })
    })
  }
  const cancel = (event: FormEvent) => {
    event.preventDefault()
    run(CANCEL_BOOKING, { reason }, (outcome) => {
      setCancelling(false)
      toast.success("Booking cancelled", { description: outcome.record.name })
    })
  }

  return (
    <section className="space-y-3" data-testid="bulky-booking-commands">
      <h3 className="text-sm font-semibold">Bulky booking</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The bookings are being read from the API; their commands follow.</p>}
      {moves ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setRouting(true)}>
            Route
          </Button>
          <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setCancelling(true)}>
            Cancel booking
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Only a booked booking is routed or cancelled; a routed one&apos;s stop is taken off its route first.</p>
      )}

      <Dialog open={routing} onOpenChange={(next) => !busy && setRouting(next)}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={route} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Route booking</DialogTitle>
              <DialogDescription>Put the booking on a route of its day as a stop at its place. The route has not started.</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="bulky-route">Route</Label>
              <Select value={routeId} onValueChange={setRouteId} disabled={offered.length === 0}>
                <SelectTrigger id="bulky-route">
                  <SelectValue placeholder="Pick a route of the booking's day" />
                </SelectTrigger>
                <SelectContent>
                  {offered.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {offered.length === 0 && <p className="text-xs text-muted-foreground">No planned or ready route of the project runs on the booking&apos;s day: make one in Route Studio first.</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setRouting(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || routeId === ""}>
                Route
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelling} onOpenChange={(next) => !busy && setCancelling(next)}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={cancel} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Cancel booking</DialogTitle>
              <DialogDescription>The booking stays on the record, with why; its slot is freed.</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="bulky-cancel-reason">Why</Label>
              <Textarea id="bulky-cancel-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setCancelling(false)}>
                Keep booking
              </Button>
              <Button type="submit" disabled={busy || reason.trim() === ""}>
                Cancel booking
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}
