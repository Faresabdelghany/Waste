"use client"
// A fill-level Sensor's details on the Pilot (O26 of #290): the container it
// measures today and its readings, newest recorded first, read from the API
// beside the row (`useRowHistory`) and again after a pairing the API took.
// Pair names a container of the sensor's project, the first day, the full
// threshold and whether a filling books an emptying; Change pairing moves the
// pairing in force's threshold, its booking or its last day. Both are the
// row's commands (lib/api/records/sensors.ts), answered by the sensor read
// again; a refusal — the container measured by another sensor, the sensor
// retired — is the store's toast in the API's words. Nothing is offered until
// the module reads the API's rows.
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useModuleRecords } from "@/components/waste/business-record-store"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { ReadRows } from "@/components/waste/commands/read-rows"
import { useCommandRunner, useModuleReady, useProjectTimezone, useRowHistory } from "@/components/waste/commands/use-command-support"
import { dayAndTimeOn, wallClockIn } from "@/lib/api/records/clock"
import { CHANGE_PAIRING, PAIR_SENSOR, readingLine, sensorReadings, SENSORS_MODULE } from "@/lib/api/records/sensors"
import { getModuleDefinition } from "@/lib/data/business-modules"
import { changeDraft, pairableContainers, pairDraft, pairOffered } from "@/lib/data/sensors"

const CONTAINERS = { workspaceId: "resources", moduleId: "containers" } as const
const NO_RECORDS: never[] = []

export function SensorPairingSurface({ record }: RowSurfaceProps) {
  const moduleReady = useModuleReady(SENSORS_MODULE)
  const { busy, version, run } = useCommandRunner(SENSORS_MODULE, record.id)
  const projectId = typeof record.submittedValues?.projectId === "string" ? record.submittedValues.projectId : undefined
  const timezone = useProjectTimezone(projectId)
  const containers = useModuleRecords(CONTAINERS.workspaceId, CONTAINERS.moduleId, getModuleDefinition(CONTAINERS)?.records ?? NO_RECORDS)
  const readings = useRowHistory(SENSORS_MODULE.workspaceId, SENSORS_MODULE.moduleId, record, version, sensorReadings)
  const today = wallClockIn(new Date().toISOString(), timezone).slice(0, 10)
  const [pairing, setPairing] = useState<ReturnType<typeof pairDraft> | null>(null)
  const [changing, setChanging] = useState<ReturnType<typeof changeDraft> | null>(null)
  const paired = (record.submittedValues?.pairingId ?? "") !== ""
  const options = pairableContainers(containers.records, projectId)

  const pair = () => {
    if (pairing === null) return
    run(PAIR_SENSOR, pairing, (outcome) => {
      setPairing(null)
      toast.success("Sensor paired", { description: `${outcome.record.name}: ${outcome.record.facts.Container ?? ""}` })
    })
  }
  const change = () => {
    if (changing === null) return
    run(CHANGE_PAIRING, changing, (outcome) => {
      setChanging(null)
      toast.success("Pairing changed", { description: `${outcome.record.name}: ${outcome.record.facts.Container ?? ""}` })
    })
  }

  return (
    <section className="space-y-4" data-testid="sensor-pairing">
      <h3 className="text-sm font-semibold">Container</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The sensors are being read from the API; their pairings follow.</p>}
      <p className="text-sm">{record.facts.Container ?? "Not paired today"}</p>
      <div className="flex flex-wrap gap-2">
        {pairOffered(record) && (
          <Button variant="outline" size="sm" disabled={!moduleReady || busy || !containers.ready} onClick={() => setPairing(pairDraft(today))}>
            Pair with a container
          </Button>
        )}
        {paired && (
          <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setChanging(changeDraft(record))}>
            Change pairing
          </Button>
        )}
      </div>
      <h3 className="text-sm font-semibold">Readings</h3>
      <ReadRows
        read={readings}
        label="Reading what the sensor sent…"
        empty="No reading received yet."
        testId="sensor-readings"
        line={(reading) => (
          <span>
            {dayAndTimeOn(reading.measuredAt, timezone)} · {readingLine(reading)}
          </span>
        )}
      />

      <Dialog open={pairing !== null} onOpenChange={(open) => !open && setPairing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pair {record.name} with a container</DialogTitle>
            <DialogDescription>The sensor measures one container at a time, and a container is measured by one sensor at a time.</DialogDescription>
          </DialogHeader>
          {pairing !== null && (
            <div className="space-y-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sensor-container">Container</Label>
                <Select value={pairing.containerId} onValueChange={(containerId) => setPairing({ ...pairing, containerId })}>
                  <SelectTrigger id="sensor-container">
                    <SelectValue placeholder="Pick a container of the sensor's project" />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sensor-valid-from">First day</Label>
                <Input id="sensor-valid-from" type="date" value={pairing.validFrom} onChange={(event) => setPairing({ ...pairing, validFrom: event.target.value })} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sensor-threshold">Full at (%)</Label>
                <Input id="sensor-threshold" type="number" min={1} max={100} value={pairing.fullThresholdPercent} onChange={(event) => setPairing({ ...pairing, fullThresholdPercent: event.target.value })} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={pairing.booksEmptying} onCheckedChange={(checked) => setPairing({ ...pairing, booksEmptying: checked === true })} />
                Book an emptying when it fills, on the next route of its round
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPairing(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={pair}>
              Pair sensor
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={changing !== null} onOpenChange={(open) => !open && setChanging(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change {record.name}&apos;s pairing</DialogTitle>
            <DialogDescription>Move the threshold or the booking, or give the last day the sensor measures the container; leave it blank while it does.</DialogDescription>
          </DialogHeader>
          {changing !== null && (
            <div className="space-y-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sensor-change-threshold">Full at (%)</Label>
                <Input id="sensor-change-threshold" type="number" min={1} max={100} value={changing.fullThresholdPercent} onChange={(event) => setChanging({ ...changing, fullThresholdPercent: event.target.value })} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={changing.booksEmptying} onCheckedChange={(checked) => setChanging({ ...changing, booksEmptying: checked === true })} />
                Book an emptying when it fills, on the next route of its round
              </label>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="sensor-last-day">Last day</Label>
                <Input id="sensor-last-day" type="date" value={changing.lastDayIn} onChange={(event) => setChanging({ ...changing, lastDayIn: event.target.value })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setChanging(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={change}>
              Save pairing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
