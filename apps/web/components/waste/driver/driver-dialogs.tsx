"use client"

// The Driver App's forms (Issue #145): what a skip, a failure and a problem
// ask for — one of the driver's six reasons and a note, which a problem
// requires, and a photo if the driver takes one (O1 of #290,
// driver-proof-dialogs.tsx) — a stop's note and its weight (O2), an unload's station,
// fraction and weights, and the end of a
// route behind a confirm that counts the stops still to do, and a vehicle's
// pre-trip check (O13 of #290). Native selects,
// since a phone draws its own picker for them. The forms shape the body and
// no more: whether it holds is the server's to say, and a rejection comes
// back as its sentence on the stop or the route.
import { useId, useState, type FormEvent, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { PhotoField } from "@/components/waste/driver/driver-proof-dialogs"
import type { DriverMe, DriverVehicle } from "@waste/contracts/driver-commands"
import { DRIVER_PICKUP_REASONS, UNLOAD_REFUSAL_REASONS, type DriverPickupReason, type FillLevel, type UnloadRefusalReason } from "@waste/domain/execution/vocabulary"
import { NOTE_MAX, wholeKilograms, type PilotBody, type ProofBytes } from "@/lib/driver/commands"
import { checkOutcome, preTripBody, type CheckForm, type CheckMark } from "@/lib/driver/pre-trip"
import { DRIVER_REASON_LABELS } from "@/lib/driver/route-view"
import { FILL_OPTIONS } from "@/lib/data/fill-levels"
import { REFUSAL_LABELS, SAY_WHY_REFUSED } from "@/lib/data/unload-refusals"

const SELECT = "border-input dark:bg-input/30 h-11 w-full rounded-md border bg-transparent px-3 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

export function NativeSelect({ id, label, value, onChange, children }: { id: string; label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} className={SELECT} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
    </div>
  )
}

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void }

type ReasonProps = {
  title: string
  description: string
  confirm: string
  noteRequired: boolean
  /** Whether the form takes a photo: a stop's exception does, which the stop's details show; the route's own problem does not, since no office surface reads a photo of a route. */
  takesPhoto: boolean
  onConfirm: (reason: DriverPickupReason, note: string | undefined, photo: ProofBytes | null) => void
}

/** Skip, fail or report a problem: a reason, a note that a problem must carry, and a photo of what the driver found. */
export function ReasonDialog({ open, onOpenChange, title, description, ...form }: DialogProps & ReasonProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {/* Mounted with each opening: a cancelled form, or a photo still being prepared when it closed, leaves nothing for the next. */}
        <ReasonForm {...form} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function ReasonForm({ confirm, noteRequired, takesPhoto, onConfirm, onClose }: Omit<ReasonProps, "title" | "description"> & { onClose: () => void }) {
  const id = useId()
  const [reason, setReason] = useState<DriverPickupReason>(DRIVER_PICKUP_REASONS[0])
  const [note, setNote] = useState("")
  const [photo, setPhoto] = useState<ProofBytes | null>(null)
  const [preparing, setPreparing] = useState(false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const text = note.trim()
    if (preparing || (noteRequired && text === "")) return
    onConfirm(reason, text === "" ? undefined : text, photo)
    onClose()
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <NativeSelect id={`${id}-reason`} label="Reason" value={reason} onChange={(value) => setReason(value as DriverPickupReason)}>
        {DRIVER_PICKUP_REASONS.map((candidate) => (
          <option key={candidate} value={candidate}>
            {DRIVER_REASON_LABELS[candidate]}
          </option>
        ))}
      </NativeSelect>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-note`}>{noteRequired ? "What happened" : "Note (optional)"}</Label>
        <Textarea id={`${id}-note`} value={note} required={noteRequired} maxLength={NOTE_MAX} onChange={(event) => setNote(event.target.value)} />
      </div>
      {takesPhoto && <PhotoField photo={photo} onPhoto={setPhoto} onPreparing={setPreparing} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" className="h-11" disabled={preparing}>
          {confirm}
        </Button>
      </DialogFooter>
    </form>
  )
}

type UnloadBody = Omit<PilotBody<"record-unload">, "location" | "accuracyM">

/** Record an unload: the station, the fraction it takes, the net weight, and a gross/tare pair and a weighbridge ticket where there are ones. */
export function UnloadDialog({ open, onOpenChange, me, onConfirm }: DialogProps & { me: DriverMe; onConfirm: (body: UnloadBody) => void }) {
  const id = useId()
  const [stationId, setStationId] = useState(me.unloadingStations[0]?.id ?? "")
  const [fractionId, setFractionId] = useState("")
  const [net, setNet] = useState("")
  const [gross, setGross] = useState("")
  const [tare, setTare] = useState("")
  const [ticket, setTicket] = useState("")
  const [note, setNote] = useState("")
  // The station turned the load away (O9 of #290): why, and in its words, which another reason needs.
  const [refused, setRefused] = useState(false)
  const [reason, setReason] = useState<UnloadRefusalReason>("contamination")
  const [refusalNote, setRefusalNote] = useState("")
  const station = me.unloadingStations.find((candidate) => candidate.id === stationId)
  // What the station accepts where it says; any of the company's where it says nothing, or where it refused the load.
  const fractions = !refused && station !== undefined && station.wasteFractionIds.length > 0 ? me.wasteFractions.filter((fraction) => station.wasteFractionIds.includes(fraction.id)) : me.wasteFractions
  const wordless = refused && reason === "other" && refusalNote.trim() === ""
  const chosenFraction = fractions.some((fraction) => fraction.id === fractionId) ? fractionId : (fractions[0]?.id ?? "")
  const weighed = gross !== "" && tare !== ""
  const netKg = weighed ? (wholeKilograms(gross) ?? 0) - (wholeKilograms(tare) ?? 0) : wholeKilograms(net)
  const pairMissing = (gross === "") !== (tare === "")

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (stationId === "" || chosenFraction === "" || netKg === undefined || netKg < 1 || pairMissing || wordless) return
    const text = note.trim()
    const words = refusalNote.trim()
    onConfirm({
      unloadingStationId: stationId,
      wasteFractionId: chosenFraction,
      netKg,
      ...(weighed ? { grossKg: wholeKilograms(gross), tareKg: wholeKilograms(tare) } : {}),
      ...(ticket.trim() === "" ? {} : { weighbridgeTicket: ticket.trim() }),
      ...(text === "" ? {} : { note: text }),
      ...(refused ? { refusal: { reason, ...(words === "" ? {} : { note: words }) } } : {}),
    })
    onOpenChange(false)
    for (const clear of [setNet, setGross, setTare, setTicket, setNote, setRefusalNote]) clear("")
    setRefused(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Record an unload</DialogTitle>
            <DialogDescription>Where the load went and what it weighed.</DialogDescription>
          </DialogHeader>
          <NativeSelect id={`${id}-station`} label="Unloading station" value={stationId} onChange={setStationId}>
            {me.unloadingStations.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect id={`${id}-fraction`} label="Waste fraction" value={chosenFraction} onChange={setFractionId}>
            {fractions.map((fraction) => (
              <option key={fraction.id} value={fraction.id}>
                {fraction.name}
              </option>
            ))}
          </NativeSelect>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-gross`}>Gross kg</Label>
              <Input id={`${id}-gross`} inputMode="numeric" type="number" min={1} step={1} className="h-11" value={gross} onChange={(event) => setGross(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-tare`}>Tare kg</Label>
              <Input id={`${id}-tare`} inputMode="numeric" type="number" min={1} step={1} className="h-11" value={tare} onChange={(event) => setTare(event.target.value)} />
            </div>
          </div>
          {pairMissing && <p className="text-sm text-destructive">Give both gross and tare, or neither.</p>}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-net`}>Net kg</Label>
            <Input
              id={`${id}-net`}
              inputMode="numeric"
              type="number"
              min={1}
              step={1}
              required={!weighed}
              disabled={weighed}
              className="h-11"
              value={weighed ? String(netKg ?? "") : net}
              onChange={(event) => setNet(event.target.value)}
            />
            {weighed && <p className="text-xs text-muted-foreground">Gross less tare.</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-ticket`}>Weighbridge ticket (optional)</Label>
            <Input id={`${id}-ticket`} className="h-11" value={ticket} onChange={(event) => setTicket(event.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-note`}>Note (optional)</Label>
            <Textarea id={`${id}-note`} value={note} maxLength={NOTE_MAX} onChange={(event) => setNote(event.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm" htmlFor={`${id}-refused`}>
            <input id={`${id}-refused`} type="checkbox" className="h-5 w-5" checked={refused} onChange={(event) => setRefused(event.target.checked)} />
            The station refused the load
          </label>
          {refused && (
            <>
              <NativeSelect id={`${id}-reason`} label="Why it was refused" value={reason} onChange={(value) => setReason(value as UnloadRefusalReason)}>
                {UNLOAD_REFUSAL_REASONS.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {REFUSAL_LABELS[candidate]}
                  </option>
                ))}
              </NativeSelect>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-refusal-note`}>{reason === "other" ? "In the station's words" : "In the station's words (optional)"}</Label>
                <Textarea id={`${id}-refusal-note`} value={refusalNote} maxLength={NOTE_MAX} required={reason === "other"} onChange={(event) => setRefusalNote(event.target.value)} />
                {wordless && <p className="text-sm text-destructive">{SAY_WHY_REFUSED}.</p>}
              </div>
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="h-11">
              Record unload
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** A note on a stop: anything the driver wants on its record, which the office reads among its proofs. */
export function NoteDialog({ open, onOpenChange, title, description, onConfirm }: DialogProps & { title: string; description: string; onConfirm: (note: string) => void }) {
  const id = useId()
  const [note, setNote] = useState("")
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const text = note.trim()
    if (text === "") return
    onConfirm(text)
    onOpenChange(false)
    setNote("")
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-note`}>Note</Label>
            <Textarea id={`${id}-note`} value={note} required maxLength={NOTE_MAX} onChange={(event) => setNote(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="h-11">
              Add note
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** A stop's weight above this is a slip of the finger, not a load: the form stops it, as the door would refuse what no weight column holds. */
export const WEIGHT_MAX_KG = 99_999

/** A stop's weight in whole kilograms, as an on-board scale or a reading shows it. */
export function WeightDialog({ open, onOpenChange, title, description, onConfirm }: DialogProps & { title: string; description: string; onConfirm: (weightKg: number) => void }) {
  const id = useId()
  const [weight, setWeight] = useState("")
  const weightKg = wholeKilograms(weight)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (weightKg === undefined || weightKg < 1 || weightKg > WEIGHT_MAX_KG) return
    onConfirm(weightKg)
    onOpenChange(false)
    setWeight("")
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-weight`}>Weight kg</Label>
            <Input id={`${id}-weight`} inputMode="numeric" type="number" min={1} max={WEIGHT_MAX_KG} step={1} required className="h-11" value={weight} onChange={(event) => setWeight(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="h-11">
              Record weight
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** How full the stop's container was (M23 of #293): one tap on a level records it, a later one replacing it. */
export function FillDialog({ open, onOpenChange, title, description, current, onConfirm }: DialogProps & { title: string; description: string; current: FillLevel | null; onConfirm: (fill: FillLevel) => void }) {
  const pick = (fill: FillLevel) => {
    onConfirm(fill)
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div role="group" aria-label="How full it was" className="grid grid-cols-2 gap-2">
          {FILL_OPTIONS.map((option) => (
            <Button key={option.value} type="button" variant={option.value === current ? "default" : "outline"} className="h-11" aria-pressed={option.value === current} onClick={() => pick(option.value)}>
              {option.label}
            </Button>
          ))}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** End the route, behind a confirm that says how many stops the end closes as skipped. */
export function EndRouteDialog({ open, onOpenChange, warning, onConfirm }: DialogProps & { warning: string; onConfirm: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>End this route?</DialogTitle>
          <DialogDescription>{warning}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Not yet
          </Button>
          <Button
            className="h-11"
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
          >
            End route
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The pre-trip check (O13 of #290): each item of the vehicle's checklist,
 * passed unless the driver ticks it a defect and says what was seen, then the
 * odometer and the engine hours where the driver reads them, and a line
 * saying what the check will do. A vehicle whose type holds no checklist is
 * checked with the readings alone.
 */
export function PreTripDialog({ open, onOpenChange, vehicle, onConfirm }: DialogProps & { vehicle: DriverVehicle; onConfirm: (body: PilotBody<"pre-trip-check">) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pre-trip check of {vehicle.label}</DialogTitle>
          <DialogDescription>Walk round the vehicle. Tick an item only where you found a defect; a critical defect takes the vehicle off the road.</DialogDescription>
        </DialogHeader>
        {/* Mounted with each opening: a cancelled check leaves nothing for the next. */}
        <PreTripForm vehicle={vehicle} onConfirm={onConfirm} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function PreTripForm({ vehicle, onConfirm, onClose }: { vehicle: DriverVehicle; onConfirm: (body: PilotBody<"pre-trip-check">) => void; onClose: () => void }) {
  const id = useId()
  const [form, setForm] = useState<CheckForm>({ marks: {}, odometerKm: "", engineHours: "" })
  const mark = (itemId: string, change: Partial<CheckMark>) => setForm((current) => ({ ...current, marks: { ...current.marks, [itemId]: { ...(current.marks[itemId] ?? { defect: false, note: "" }), ...change } } }))
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onConfirm(preTripBody(vehicle, form))
    onClose()
  }
  return (
    <form onSubmit={submit} className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
      {vehicle.checklist.length === 0 ? (
        <p className="text-sm text-muted-foreground">The office has set no checklist for this vehicle&apos;s type. Record the readings and confirm.</p>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Checklist">
          {vehicle.checklist.map((item) => {
            const current = form.marks[item.id]
            return (
              <li key={item.id} className="flex flex-col gap-2 rounded-lg border p-3">
                <label className="flex items-center gap-3 text-sm">
                  <input type="checkbox" className="size-5" checked={current?.defect === true} onChange={(event) => mark(item.id, { defect: event.target.checked })} />
                  <span className="font-medium">{item.label}</span>
                  {item.critical && <span className="text-xs text-muted-foreground">critical</span>}
                </label>
                {current?.defect === true && <Textarea aria-label={`What is wrong with ${item.label}`} placeholder="What is wrong" maxLength={NOTE_MAX} value={current.note} onChange={(event) => mark(item.id, { note: event.target.value })} />}
              </li>
            )
          })}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-odometer`}>Odometer (km)</Label>
          <Input id={`${id}-odometer`} inputMode="numeric" type="number" min={0} step={1} className="h-11" value={form.odometerKm} onChange={(event) => setForm((current) => ({ ...current, odometerKm: event.target.value }))} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-hours`}>Engine hours</Label>
          <Input id={`${id}-hours`} inputMode="numeric" type="number" min={0} step={1} className="h-11" value={form.engineHours} onChange={(event) => setForm((current) => ({ ...current, engineHours: event.target.value }))} />
        </div>
      </div>
      <p className="text-sm text-muted-foreground" role="status">
        {checkOutcome(vehicle, form)}
      </p>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" className="h-11">
          Record check
        </Button>
      </DialogFooter>
    </form>
  )
}
