"use client"
// A vehicle's compartments one by one, on the Pilot (O7 of #290): the row
// surface of `fleet.vehicles` lists each compartment — its name, its payload,
// its litres and the fractions it carries — and edits the list whole, sent as
// the adapter's `SET_COMPARTMENTS` command (lib/api/records/fleet.ts), which
// puts it through `PUT /vehicles/:id/compartments`. The fractions are the
// master data's, read through the store. A refusal — a fraction no
// compartment has, a figure the API will not take — is the store's toast in
// its words, and the dialog stays open on it. What a compartment carries is
// what the API's fleet rules read: the fractions a route's vehicle takes, and
// how much of each on one trip. The periods out of use stand beneath it
// (availability-surfaces.tsx).
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useModuleRecords } from "@/components/waste/business-record-store"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { VehicleUnavailabilitySurface } from "@/components/waste/commands/availability-surfaces"
import { VehicleDefectsSurface } from "@/components/waste/commands/pre-trip-surfaces"
import { useCommandRunner, useModuleReady } from "@/components/waste/commands/use-command-support"
import { compartmentDraftsOf, SET_COMPARTMENTS, type CompartmentDraft } from "@/lib/api/records/fleet"
import { isTrailerRecord, VEHICLES_MODULE } from "@/lib/data/allocations"
import { MASTER_DATA_MODULE, masterDataKindOf } from "@/lib/data/master-data"

const NO_RECORDS = [] as const
const blank = (): CompartmentDraft => ({ name: "", capacityKg: "", volumeLitres: "", wasteFractionIds: [] })

/** A compartment as its line reads: "Body · 8000 kg · 16000 L · Residual, Mixed". */
function compartmentLine(draft: CompartmentDraft, index: number, fractionName: (webId: string) => string): string {
  return [
    draft.name === "" ? `Compartment ${index + 1}` : draft.name,
    draft.capacityKg === "" ? "" : `${draft.capacityKg} kg`,
    draft.volumeLitres === "" ? "" : `${draft.volumeLitres} L`,
    draft.wasteFractionIds.map(fractionName).join(", "),
  ]
    .filter((part) => part !== "")
    .join(" · ")
}

/** A vehicle's compartments, in its details, and the editor of the whole list. */
export function VehicleCompartmentsSurface({ record }: RowSurfaceProps) {
  const moduleReady = useModuleReady(VEHICLES_MODULE)
  const { busy, run } = useCommandRunner(VEHICLES_MODULE, record.id)
  const master = useModuleRecords(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId, NO_RECORDS)
  const fractions = master.records.filter((row) => masterDataKindOf(row) === "waste-fraction")
  const fractionName = (webId: string) => fractions.find((row) => row.id === webId)?.name ?? webId
  const stored = compartmentDraftsOf(record)
  const [drafts, setDrafts] = useState<CompartmentDraft[] | null>(null)

  const change = (index: number, patch: Partial<CompartmentDraft>) => setDrafts((current) => (current ?? []).map((draft, at) => (at === index ? { ...draft, ...patch } : draft)))
  const toggle = (index: number, webId: string, on: boolean) =>
    setDrafts((current) =>
      (current ?? []).map((draft, at) => (at !== index ? draft : { ...draft, wasteFractionIds: on ? [...draft.wasteFractionIds, webId] : draft.wasteFractionIds.filter((id) => id !== webId) })),
    )
  const save = () => {
    if (drafts === null) return
    run(SET_COMPARTMENTS, { compartments: drafts }, () => {
      setDrafts(null)
      toast.success("Compartments saved", { description: record.name })
    })
  }

  return (
    <section className="space-y-4" data-testid="vehicle-compartments">
      <h3 className="text-sm font-semibold">Compartments</h3>
      {stored.length === 0 ? (
        <p className="text-sm text-muted-foreground">{isTrailerRecord(record) ? "No compartment: the trailer carries nothing of its own." : "No compartment recorded: the vehicle is taken to carry any fraction."}</p>
      ) : (
        <ul className="space-y-1 text-sm" data-testid="vehicle-compartments-list">
          {stored.map((draft, index) => (
            <li key={index}>{compartmentLine(draft, index, fractionName)}</li>
          ))}
        </ul>
      )}
      <Button variant="outline" size="sm" disabled={!moduleReady || !master.ready || busy} onClick={() => setDrafts(stored.length === 0 ? [blank()] : stored)}>
        Edit compartments
      </Button>
      {drafts !== null && (
        <Dialog open onOpenChange={(open) => !open && setDrafts(null)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Compartments of {record.name}</DialogTitle>
              <DialogDescription>Each compartment carries the fractions ticked, up to its payload on one trip. Routes, moves and allocations are held to them.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              {drafts.map((draft, index) => (
                <fieldset key={index} className="space-y-3 rounded-md border p-3" data-testid={`compartment-${index}`}>
                  <div className="flex items-center justify-between">
                    <legend className="text-sm font-medium">Compartment {index + 1}</legend>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDrafts(drafts.filter((_, at) => at !== index))}>
                      Remove
                    </Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label htmlFor={`compartment-${index}-name`}>Name</Label>
                      <Input id={`compartment-${index}-name`} value={draft.name} placeholder="Body" onChange={(event) => change(index, { name: event.target.value })} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`compartment-${index}-capacity`}>Payload (kg)</Label>
                      <Input id={`compartment-${index}-capacity`} inputMode="numeric" value={draft.capacityKg} onChange={(event) => change(index, { capacityKg: event.target.value })} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`compartment-${index}-volume`}>Volume (L)</Label>
                      <Input id={`compartment-${index}-volume`} inputMode="numeric" value={draft.volumeLitres} onChange={(event) => change(index, { volumeLitres: event.target.value })} />
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {fractions.map((fraction) => (
                      <label key={fraction.id} className="flex items-center gap-2 text-sm">
                        <Checkbox checked={draft.wasteFractionIds.includes(fraction.id)} onCheckedChange={(checked) => toggle(index, fraction.id, checked === true)} />
                        {fraction.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setDrafts([...drafts, blank()])}>
                Add compartment
              </Button>
            </div>
            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => setDrafts(null)}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={save}>
                Save compartments
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}

/** A vehicle's details: its compartments, its periods out of use, then what its pre-trip checks found (O13 of #290). */
export function VehicleRowSurface({ record }: RowSurfaceProps) {
  return (
    <div className="space-y-6">
      <VehicleCompartmentsSurface record={record} />
      <VehicleUnavailabilitySurface record={record} />
      <VehicleDefectsSurface record={record} />
    </div>
  )
}
