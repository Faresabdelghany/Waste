"use client"

// The Driver App's forms (Issue #145): what a skip, a failure and a problem
// ask for — one of the driver's six reasons and a note, which a problem
// requires — an unload's station, fraction and weights, and the end of a
// route behind a confirm that counts the stops still to do. Native selects,
// since a phone draws its own picker for them. The forms shape the body and
// no more: whether it holds is the server's to say, and a rejection comes
// back as its sentence on the stop or the route.
import { useId, useState, type FormEvent, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { DriverMe } from "@waste/contracts/driver-commands"
import { DRIVER_PICKUP_REASONS, type DriverPickupReason } from "@waste/domain/execution/vocabulary"
import type { PilotBody } from "@/lib/driver/commands"
import { DRIVER_REASON_LABELS } from "@/lib/driver/route-view"

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

/** Skip, fail or report a problem: a reason, and a note that a problem must carry. */
export function ReasonDialog({ open, onOpenChange, title, description, confirm, noteRequired, onConfirm }: DialogProps & { title: string; description: string; confirm: string; noteRequired: boolean; onConfirm: (reason: DriverPickupReason, note: string | undefined) => void }) {
  const id = useId()
  const [reason, setReason] = useState<DriverPickupReason>(DRIVER_PICKUP_REASONS[0])
  const [note, setNote] = useState("")
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const text = note.trim()
    if (noteRequired && text === "") return
    onConfirm(reason, text === "" ? undefined : text)
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
          <NativeSelect id={`${id}-reason`} label="Reason" value={reason} onChange={(value) => setReason(value as DriverPickupReason)}>
            {DRIVER_PICKUP_REASONS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {DRIVER_REASON_LABELS[candidate]}
              </option>
            ))}
          </NativeSelect>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-note`}>{noteRequired ? "What happened" : "Note (optional)"}</Label>
            <Textarea id={`${id}-note`} value={note} required={noteRequired} onChange={(event) => setNote(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="h-11">
              {confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

type UnloadBody = Omit<PilotBody<"record-unload">, "location" | "accuracyM">

const kilograms = (value: string): number | undefined => {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

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
  const station = me.unloadingStations.find((candidate) => candidate.id === stationId)
  // What the station accepts where it says; any of the company's where it says nothing.
  const fractions = station !== undefined && station.wasteFractionIds.length > 0 ? me.wasteFractions.filter((fraction) => station.wasteFractionIds.includes(fraction.id)) : me.wasteFractions
  const chosenFraction = fractions.some((fraction) => fraction.id === fractionId) ? fractionId : (fractions[0]?.id ?? "")
  const weighed = gross !== "" && tare !== ""
  const netKg = weighed ? (kilograms(gross) ?? 0) - (kilograms(tare) ?? 0) : kilograms(net)
  const pairMissing = (gross === "") !== (tare === "")

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (stationId === "" || chosenFraction === "" || netKg === undefined || netKg < 1 || pairMissing) return
    const text = note.trim()
    onConfirm({
      unloadingStationId: stationId,
      wasteFractionId: chosenFraction,
      netKg,
      ...(weighed ? { grossKg: kilograms(gross), tareKg: kilograms(tare) } : {}),
      ...(ticket.trim() === "" ? {} : { weighbridgeTicket: ticket.trim() }),
      ...(text === "" ? {} : { note: text }),
    })
    onOpenChange(false)
    for (const clear of [setNet, setGross, setTare, setTicket, setNote]) clear("")
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
            <Textarea id={`${id}-note`} value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
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
