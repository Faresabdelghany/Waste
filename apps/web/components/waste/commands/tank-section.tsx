"use client"
// A Property's tanks in its details on the Pilot (M11 of #293): each tank the
// register holds — what it is, the container that stands for it, the last
// emptying and the day the next falls due, the API's own reading — with its
// inspections beneath it. A role that edits the properties registers a tank on
// a container serving the Property and records an inspection; a refusal is the
// API's sentence, and the list is read again once a write lands. The
// sentences and the bodies are lib/data/tanks.ts'.
import { useCallback, useEffect, useState, type FormEvent } from "react"
import { ClipboardText, Drop } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"
import type { TankInspection, TankInstallation } from "@waste/contracts/tanks"
import { TANK_INSPECTION_OUTCOMES, TANK_KINDS, TANK_OUTLETS } from "@waste/domain/registry/vocabulary"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useApiClient, useApiSession } from "@/components/waste/api-session-store"
import { useServerModuleState } from "@/components/waste/business-record-store"
import { useProjectRecords, useRowHistory, useServerNames } from "@/components/waste/commands/use-command-support"
import { problemSentence } from "@/lib/api/problem"
import { isLocalRefusal, typed } from "@/lib/api/records/adapter"
import { CONTAINERS_MODULE } from "@/lib/api/records/containers"
import { dayIn } from "@/lib/api/records/planning"
import { problemOfError } from "@/lib/api/records/server-records"
import type { BusinessRecord, ModuleLocation } from "@/lib/data/business-modules"
import {
  containersAtProperty,
  dueSentence,
  inspectionBodyOf,
  inspectionsOf,
  lastEmptyingSentence,
  recordInspection,
  registerTank,
  TANK_INSPECTION_OUTCOME_LABELS,
  TANK_KIND_LABELS,
  TANK_OUTLET_LABELS,
  tankBodyOf,
  tanksEditable,
  tanksOfProperty,
  tanksReadable,
  tankSummary,
  type InspectionTyped,
  type TankTyped,
} from "@/lib/data/tanks"

export function TanksSection({ record, module }: { record: BusinessRecord; module: ModuleLocation }) {
  const { me } = useApiSession()
  const readable = tanksReadable(me?.role.grants)
  const editable = tanksEditable(me?.role.grants)
  const [version, setVersion] = useState(0)
  const reread = useCallback(() => setVersion((current) => current + 1), [])
  const tanks = useRowHistory(module.workspaceId, module.moduleId, record, readable ? `read|${version}` : "not-granted", readable ? tanksOfProperty : NO_TANKS)
  const propertyServerId = useServerModuleState(module.workspaceId, module.moduleId)?.serverIds.get(record.id)
  const projectOf = useProjectRecords()
  const project = projectOf(record.projectIds?.[0])
  const today = dayIn(new Date(), project === undefined ? undefined : typed(project, "timezone"))
  const containerName = useServerNames(CONTAINERS_MODULE, "container")
  const [registering, setRegistering] = useState(false)

  return (
    <section className="space-y-2" data-testid="property-tanks" aria-label="Tanks">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tanks</h3>
      {!readable ? (
        <p className="text-sm text-muted-foreground">The tanks are not shown to your role.</p>
      ) : tanks.problem !== null ? (
        <p className="text-sm text-muted-foreground">The tanks could not be read from the API: {tanks.problem}</p>
      ) : tanks.rows === null ? (
        <p className="text-sm text-muted-foreground">Reading the tanks from the API…</p>
      ) : (
        <>
          {tanks.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No septic tank, holding tank or separator is registered here.</p>
          ) : (
            <ul className="space-y-2">
              {tanks.rows.map((tank) => (
                <TankItem key={tank.id} tank={tank} today={today} containerName={containerName} editable={editable} />
              ))}
            </ul>
          )}
          {editable && propertyServerId !== undefined && (
            <Button variant="outline" size="sm" onClick={() => setRegistering(true)}>
              <Drop className="h-4 w-4" />
              Register tank…
            </Button>
          )}
        </>
      )}
      {registering && propertyServerId !== undefined && (
        <RegisterTankDialog
          record={record}
          propertyServerId={propertyServerId}
          today={today}
          onClose={() => setRegistering(false)}
          onSaved={() => {
            setRegistering(false)
            reread()
          }}
        />
      )}
    </section>
  )
}

function TankItem({ tank, today, containerName, editable }: { tank: TankInstallation; today: string; containerName: (serverId: string) => string; editable: boolean }) {
  const [version, setVersion] = useState(0)
  const [inspecting, setInspecting] = useState(false)
  const inspections = useInspections(tank.id, version)
  const ended = tank.validTo !== null && tank.validTo <= today

  return (
    <li className="space-y-1 rounded-md border border-border px-3 py-2 text-sm" data-testid="tank">
      <p className="font-medium">{tankSummary(tank)}</p>
      <p className="text-muted-foreground">
        {containerName(tank.containerId)} · every {tank.emptyingIntervalMonths} {tank.emptyingIntervalMonths === 1 ? "month" : "months"}
        {tank.validTo === null ? "" : ended ? ` · out of use since ${tank.validTo}` : ` · in use until ${tank.validTo}`}
      </p>
      {!ended && <p data-testid="tank-due">{dueSentence(tank, today)}</p>}
      <p className="text-muted-foreground" data-testid="tank-last-emptying">
        {lastEmptyingSentence(tank)}
      </p>
      {tank.notes !== null && <p className="whitespace-pre-line text-muted-foreground">{tank.notes}</p>}
      <div className="space-y-1 pt-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Inspections</p>
        {inspections.problem !== null ? (
          <p className="text-muted-foreground">The inspections could not be read from the API: {inspections.problem}</p>
        ) : inspections.rows === null ? (
          <p className="text-muted-foreground">Reading the inspections…</p>
        ) : inspections.rows.length === 0 ? (
          <p className="text-muted-foreground">Not inspected yet.</p>
        ) : (
          <ul data-testid="tank-inspections">
            {inspections.rows.map((inspection) => (
              <li key={inspection.id}>
                <span className="tabular-nums text-muted-foreground">{inspection.inspectedOn}</span> · {TANK_INSPECTION_OUTCOME_LABELS[inspection.outcome]}
                {inspection.findings === null ? "" : ` — ${inspection.findings}`}
                {inspection.nextInspectionOn === null ? "" : ` · next ${inspection.nextInspectionOn}`}
              </li>
            ))}
          </ul>
        )}
        {editable && (
          <Button variant="ghost" size="sm" onClick={() => setInspecting(true)}>
            <ClipboardText className="h-4 w-4" />
            Record inspection…
          </Button>
        )}
      </div>
      {inspecting && (
        <InspectionDialog
          tank={tank}
          today={today}
          onClose={() => setInspecting(false)}
          onSaved={() => {
            setInspecting(false)
            setVersion((current) => current + 1)
          }}
        />
      )}
    </li>
  )
}

function RegisterTankDialog({ record, propertyServerId, today, onClose, onSaved }: { record: BusinessRecord; propertyServerId: string; today: string; onClose: () => void; onSaved: () => void }) {
  const client = useApiClient()
  const containers = useServerModuleState(CONTAINERS_MODULE.workspaceId, CONTAINERS_MODULE.moduleId)
  const offered = containersAtProperty(
    (containers?.records ?? []).filter((container) => containers?.serverIds.has(container.id)),
    record,
  )
  const [typedTank, setTyped] = useState<TankTyped>({ containerId: "", kind: "septic-tank", volumeLitres: "", outlet: "soakaway", emptyingIntervalMonths: "12", lastEmptiedOn: "", validFrom: today, notes: "" })
  const [refusal, setRefusal] = useState<{ path: string; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (field: keyof TankTyped) => (value: string) => setTyped((current) => ({ ...current, [field]: value }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (client === null) return
    const body = tankBodyOf(typedTank, propertyServerId)
    if (isLocalRefusal(body)) {
      setRefusal(body)
      return
    }
    setBusy(true)
    try {
      const tank = await registerTank(client, body)
      toast.success("Tank registered", { description: `${tankSummary(tank)} — ${dueSentence(tank, today).toLowerCase()}.` })
      onSaved()
    } catch (error) {
      setRefusal({ path: "", message: problemSentence(problemOfError(error)) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Register a tank at {record.name}</DialogTitle>
            <DialogDescription>The container that stands for the tank is planned, emptied and charged as any container is; the next emptying falls due its interval after the last.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="tank-container">Container</Label>
              <Select value={typedTank.containerId} onValueChange={set("containerId")}>
                <SelectTrigger id="tank-container">
                  <SelectValue placeholder={offered.length === 0 ? "No container serves this property today" : "Pick the container"} />
                </SelectTrigger>
                <SelectContent>
                  {offered.map((container) => {
                    const serverId = containers?.serverIds.get(container.id)
                    return serverId === undefined ? null : (
                      <SelectItem key={container.id} value={serverId}>
                        {container.name}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tank-kind">Kind</Label>
              <Select value={typedTank.kind} onValueChange={set("kind")}>
                <SelectTrigger id="tank-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TANK_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {TANK_KIND_LABELS[kind]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tank-outlet">Outlet</Label>
              <Select value={typedTank.outlet} onValueChange={set("outlet")}>
                <SelectTrigger id="tank-outlet">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TANK_OUTLETS.map((outlet) => (
                    <SelectItem key={outlet} value={outlet}>
                      {TANK_OUTLET_LABELS[outlet]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tank-volume">Volume (litres)</Label>
              <Input id="tank-volume" inputMode="numeric" type="number" min={1} step={1} value={typedTank.volumeLitres} onChange={(event) => set("volumeLitres")(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tank-interval">Emptied every (months)</Label>
              <Input id="tank-interval" inputMode="numeric" type="number" min={1} max={120} step={1} value={typedTank.emptyingIntervalMonths} onChange={(event) => set("emptyingIntervalMonths")(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tank-from">In the register from</Label>
              <Input id="tank-from" type="date" value={typedTank.validFrom} onChange={(event) => set("validFrom")(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tank-last">Last emptied (before the platform)</Label>
              <Input id="tank-last" type="date" value={typedTank.lastEmptiedOn} onChange={(event) => set("lastEmptiedOn")(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="tank-notes">Notes</Label>
              <Textarea id="tank-notes" value={typedTank.notes} onChange={(event) => set("notes")(event.target.value)} />
            </div>
          </div>
          {refusal !== null && (
            <p role="alert" className="text-sm text-destructive">
              {refusal.message}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Register tank
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function InspectionDialog({ tank, today, onClose, onSaved }: { tank: TankInstallation; today: string; onClose: () => void; onSaved: () => void }) {
  const client = useApiClient()
  const [typedInspection, setTyped] = useState<InspectionTyped>({ inspectedOn: today, outcome: "approved", findings: "", nextInspectionOn: "" })
  const [refusal, setRefusal] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (field: keyof InspectionTyped) => (value: string) => setTyped((current) => ({ ...current, [field]: value }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (client === null) return
    const body = inspectionBodyOf(typedInspection)
    if (isLocalRefusal(body)) {
      setRefusal(body.message)
      return
    }
    setBusy(true)
    try {
      await recordInspection(client, tank.id, body)
      toast.success("Inspection recorded", { description: `${TANK_INSPECTION_OUTCOME_LABELS[body.outcome]} on ${body.inspectedOn}.` })
      onSaved()
    } catch (error) {
      setRefusal(problemSentence(problemOfError(error)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Record an inspection</DialogTitle>
            <DialogDescription>{tankSummary(tank)}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inspection-on">Inspected on</Label>
              <Input id="inspection-on" type="date" max={today} value={typedInspection.inspectedOn} onChange={(event) => set("inspectedOn")(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inspection-outcome">Outcome</Label>
              <Select value={typedInspection.outcome} onValueChange={set("outcome")}>
                <SelectTrigger id="inspection-outcome">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TANK_INSPECTION_OUTCOMES.map((outcome) => (
                    <SelectItem key={outcome} value={outcome}>
                      {TANK_INSPECTION_OUTCOME_LABELS[outcome]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="inspection-findings">Findings</Label>
              <Textarea id="inspection-findings" value={typedInspection.findings} onChange={(event) => set("findings")(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="inspection-next">Next inspection</Label>
              <Input id="inspection-next" type="date" value={typedInspection.nextInspectionOn} onChange={(event) => set("nextInspectionOn")(event.target.value)} />
            </div>
          </div>
          {refusal !== null && (
            <p role="alert" className="text-sm text-destructive">
              {refusal}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Record inspection
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** A tank's inspections, read again whenever `version` moves. */
function useInspections(tankId: string, version: number): { rows: TankInspection[] | null; problem: string | null } {
  const client = useApiClient()
  const key = `${tankId}|${version}`
  const [state, setState] = useState<{ key: string; rows: TankInspection[] | null; problem: string | null }>({ key: "", rows: null, problem: null })
  useEffect(() => {
    if (client === null) return
    let current = true
    inspectionsOf(client, tankId).then(
      (rows) => current && setState({ key, rows, problem: null }),
      (error: unknown) => current && setState({ key, rows: null, problem: problemSentence(problemOfError(error)) }),
    )
    return () => {
      current = false
    }
  }, [client, key, tankId])
  return state.key === key ? state : { rows: null, problem: null }
}

const NO_TANKS = async (): Promise<TankInstallation[]> => []
