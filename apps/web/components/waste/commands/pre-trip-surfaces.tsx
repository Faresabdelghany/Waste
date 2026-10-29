"use client"
// What the drivers' pre-trip checks found on a vehicle, on the Pilot (O13 of
// #290): a section of the vehicle's details in Fleet. Its defects, open first,
// each with Resolve — what was done, in a note — and its last checks with
// what each found and the readings taken. Both are read from the API beside
// the row (`useRowHistory`), again after a resolve the API took, and a resolve
// is the row's action (lib/api/records/pre-trip.ts); a refusal is the store's
// toast in the API's words. Resolving leaves the vehicle's status alone: a
// vehicle a critical defect took off the road is set active again by its own
// Edit. Nothing is offered until the module reads the API's rows.
import { useState } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useBusinessRecordStore } from "@/components/waste/business-record-store"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { ReadRows } from "@/components/waste/commands/read-rows"
import { useModuleReady, useProjectTimezone, useRowHistory } from "@/components/waste/commands/use-command-support"
import { dayAndTimeOn } from "@/lib/api/records/clock"
import { checkLine, defectLine, resolveVehicleDefect, vehicleChecks, vehicleDefects } from "@/lib/api/records/pre-trip"
import { VEHICLES_MODULE } from "@/lib/data/allocations"
import type { VehicleDefect } from "@waste/contracts/pre-trip"

/** The checks a vehicle's details show: the last few, newest first. */
const CHECKS_SHOWN = 5

export function VehicleDefectsSurface({ record }: RowSurfaceProps) {
  const { sendAction } = useBusinessRecordStore()
  const moduleReady = useModuleReady(VEHICLES_MODULE)
  const projectId = record.submittedValues?.projectId
  const timezone = useProjectTimezone(typeof projectId === "string" ? projectId : undefined)
  const [busy, setBusy] = useState(false)
  const [resolving, setResolving] = useState<VehicleDefect | null>(null)
  const [note, setNote] = useState("")
  // Bumped after each resolve the API took: the defects are read again, whatever the row shows.
  const [version, setVersion] = useState(0)
  const defects = useRowHistory(VEHICLES_MODULE.workspaceId, VEHICLES_MODULE.moduleId, record, version, vehicleDefects)
  const checks = useRowHistory(VEHICLES_MODULE.workspaceId, VEHICLES_MODULE.moduleId, record, version, vehicleChecks)

  const resolve = () => {
    if (busy || resolving === null) return
    setBusy(true)
    void resolveVehicleDefect(sendAction, record.id, resolving.id, note.trim()).then((result) => {
      setBusy(false)
      if (result.kind !== "done") return
      toast.success("Defect resolved", { description: `${record.name}: ${resolving.label}` })
      setResolving(null)
      setNote("")
      setVersion((current) => current + 1)
    })
  }

  return (
    <section className="space-y-4" data-testid="vehicle-defects">
      <h3 className="text-sm font-semibold">Defects</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The rows are being read from the API; what the drivers&apos; checks found follows.</p>}
      <ReadRows
        read={defects}
        label="Reading the defects…"
        empty="No defect found by a pre-trip check."
        testId="vehicle-defects-list"
        line={(defect) => (
          <div className="flex items-center justify-between gap-2">
            <span>
              {defectLine(defect)}
              <span className="text-muted-foreground"> · found {dayAndTimeOn(defect.foundAt, timezone)}</span>
            </span>
            {defect.status === "open" ? (
              <Button variant="ghost" size="sm" disabled={!moduleReady || busy} onClick={() => setResolving(defect)}>
                Resolve
              </Button>
            ) : (
              <Badge variant="secondary">Resolved</Badge>
            )}
          </div>
        )}
      />
      <h3 className="text-sm font-semibold">Pre-trip checks</h3>
      <ReadRows
        read={{ rows: checks.rows === null ? null : checks.rows.slice(0, CHECKS_SHOWN), problem: checks.problem }}
        label="Reading the checks…"
        empty="No pre-trip check recorded."
        testId="vehicle-checks-list"
        line={(check) => (
          <span>
            {dayAndTimeOn(check.occurredAt, timezone)} · {checkLine(check)}
          </span>
        )}
      />
      <Dialog open={resolving !== null} onOpenChange={(open) => !open && setResolving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve {resolving?.label}</DialogTitle>
            <DialogDescription>Say what was done. The vehicle&apos;s status stays as it is: set it active with Edit once it is fit to drive.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="defect-resolution-note">What was done (optional)</Label>
            <Textarea id="defect-resolution-note" value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolving(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={resolve}>
              Resolve defect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
