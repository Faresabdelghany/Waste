"use client"
// A transfer station's details on the Pilot (M17 of #293, row 28.3): what it
// holds by project and fraction, and the loads that left it, newest first,
// each with the receiving site's ticket read against our out-weighing once it
// is recorded. Adjust stock appends a count's correction; Send a load records
// a load leaving for another station; a load is then received against the
// receiving site's ticket, reconciled or disputed, or cancelled before it is
// received, the commands offered being those the domain's machine moves it by.
// Each is the station's action (lib/api/records/haul-out.ts), and the stock
// and the loads are read again once one lands. A station that is not a
// transfer station shows nothing here; a role without the weights grant is told
// so in the API's words where the stock would be.
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useBusinessRecordStore, useModuleRecords } from "@/components/waste/business-record-store"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { ReadRows } from "@/components/waste/commands/read-rows"
import { useModuleReady, useRecordsByServerId, useRowHistory, useServerNames } from "@/components/waste/commands/use-command-support"
import { dayAndTimeOn, wallClockIn } from "@/lib/api/records/clock"
import { actOnStation, ADJUST_STOCK, CANCEL_LOAD, DISPUTE_LOAD, loadLine, RECEIVE_LOAD, RECONCILE_LOAD, SEND_LOAD, stationLoads, stationStock, stockLine } from "@/lib/api/records/haul-out"
import type { BusinessFormOption } from "@/lib/data/business-form-types"
import { getModuleDefinition } from "@/lib/data/business-modules"
import { VEHICLES_MODULE } from "@/lib/data/allocations"
import { ORGANISATION_MODULE } from "@/lib/data/containers"
import { adjustDraft, destinationChoices, isTransferStation, loadCommandsOffered, projectChoices, receiptDraft, sendDraft, STATIONS_MODULE, vehicleChoices } from "@/lib/data/haul-out"
import { MASTER_DATA_MODULE, masterDataKindOf } from "@/lib/data/master-data"

const NO_RECORDS: never[] = []
/** What a station that is not a transfer station reads: nothing, and no request. */
const nothing = async (): Promise<never[]> => []
const VERB = { receive: "Record receipt", reconcile: "Reconcile", dispute: "Dispute", cancel: "Cancel load" } as const
const ACTION = { receive: RECEIVE_LOAD, reconcile: RECONCILE_LOAD, dispute: DISPUTE_LOAD, cancel: CANCEL_LOAD } as const

type Draft = Record<string, string>
type LoadDialog = { verb: keyof typeof VERB; draft: Draft; timezone: string | undefined }

/** One labelled text field of a dialog. */
function Field({ id, label, value, onChange, type = "text", placeholder }: { id: string; label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </div>
  )
}

/** One labelled pick of a dialog. */
function Pick({ id, label, value, options, onChange, placeholder }: { id: string; label: string; value: string; options: readonly BusinessFormOption[]; onChange: (value: string) => void; placeholder: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={placeholder} />
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
  )
}

/** A transfer station's stock and loads, and their commands. */
export function TransferStationSurface({ record }: RowSurfaceProps) {
  const { sendAction } = useBusinessRecordStore()
  const moduleReady = useModuleReady(STATIONS_MODULE)
  const [version, setVersion] = useState(0)
  const transfer = isTransferStation(record)
  const stock = useRowHistory(STATIONS_MODULE.workspaceId, STATIONS_MODULE.moduleId, record, version, transfer ? stationStock : nothing)
  const loads = useRowHistory(STATIONS_MODULE.workspaceId, STATIONS_MODULE.moduleId, record, version, transfer ? stationLoads : nothing)
  const projectByServerId = useRecordsByServerId(ORGANISATION_MODULE)
  const organisation = useModuleRecords(ORGANISATION_MODULE.workspaceId, ORGANISATION_MODULE.moduleId, getModuleDefinition(ORGANISATION_MODULE)?.records ?? NO_RECORDS)
  const master = useModuleRecords(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId, NO_RECORDS)
  const stations = useModuleRecords(STATIONS_MODULE.workspaceId, STATIONS_MODULE.moduleId, NO_RECORDS)
  const vehicles = useModuleRecords(VEHICLES_MODULE.workspaceId, VEHICLES_MODULE.moduleId, NO_RECORDS)
  const projectName = useServerNames(ORGANISATION_MODULE, "project")
  const fractionName = useServerNames(MASTER_DATA_MODULE, "waste-fraction")
  const stationName = useServerNames(STATIONS_MODULE, "station")
  const projects = projectChoices(organisation.records)
  const fractions = master.records.filter((row) => masterDataKindOf(row) === "waste-fraction").map((row) => ({ value: row.id, label: row.name }))
  const [adjusting, setAdjusting] = useState<Draft | null>(null)
  const [sending, setSending] = useState<Draft | null>(null)
  const [acting, setActing] = useState<LoadDialog | null>(null)
  const [busy, setBusy] = useState(false)

  if (!transfer) return null

  const project = (id: string | undefined) => projects.find((choice) => choice.value === id)
  const nowOn = (timezone: string | undefined) => wallClockIn(new Date().toISOString(), timezone)
  const send = (name: string, input: Draft, done: () => void, said: string) => {
    if (busy) return
    setBusy(true)
    void actOnStation(sendAction, record.id, name, input).then((outcome) => {
      setBusy(false)
      if (outcome.kind !== "done") return
      done()
      setVersion((count) => count + 1)
      toast.success(said, { description: record.name })
    })
  }

  return (
    <section className="space-y-4" data-testid="transfer-station">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Stock</h3>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={!moduleReady || busy || !organisation.ready || !master.ready} onClick={() => setAdjusting(adjustDraft(projects[0]?.value ?? ""))}>
            Adjust stock
          </Button>
          <Button variant="outline" size="sm" disabled={!moduleReady || busy || !organisation.ready || !master.ready} onClick={() => setSending(sendDraft(projects[0]?.value ?? "", nowOn(projects[0]?.timezone)))}>
            Send a load
          </Button>
        </div>
      </div>
      <ReadRows
        read={stock}
        label="Reading what the station holds…"
        empty="Nothing tipped here, sent on or adjusted yet."
        testId="transfer-station-stock"
        line={(row) => (
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">
              {fractionName(row.wasteFractionId)} · {projectName(row.projectId)}
            </span>
            <span className="text-muted-foreground">{stockLine(row)}</span>
          </div>
        )}
      />
      <h3 className="text-sm font-semibold">Outbound loads</h3>
      <ReadRows
        read={loads}
        label="Reading the loads sent on…"
        empty="No load has left this station yet."
        testId="transfer-station-loads"
        line={(load) => {
          const zone = projectByServerId(load.projectId)?.submittedValues?.timezone
          const timezone = typeof zone === "string" && zone !== "" ? zone : undefined
          return (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {dayAndTimeOn(load.departedAt, timezone)} to {stationName(load.toStationId)} · {fractionName(load.wasteFractionId)} · {loadLine(load)}
              </span>
              <span className="flex gap-1">
                {loadCommandsOffered(load.status).map((verb) => (
                  <Button
                    key={verb}
                    variant="ghost"
                    size="sm"
                    disabled={!moduleReady || busy}
                    onClick={() => setActing({ verb, timezone, draft: verb === "receive" ? receiptDraft(load.id, nowOn(timezone)) : { loadId: load.id, note: "" } })}
                  >
                    {VERB[verb]}
                  </Button>
                ))}
              </span>
            </div>
          )
        }}
      />

      <Dialog open={adjusting !== null} onOpenChange={(open) => !open && setAdjusting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust {record.name}&apos;s stock</DialogTitle>
            <DialogDescription>A stock count&apos;s correction of what the station holds of one fraction for one project: more in kilograms, or less with a minus.</DialogDescription>
          </DialogHeader>
          {adjusting !== null && (
            <div className="space-y-3">
              <Pick id="adjust-project" label="Project" value={adjusting.projectId ?? ""} options={projects} onChange={(projectId) => setAdjusting({ ...adjusting, projectId })} placeholder="Whose material it is" />
              <Pick id="adjust-fraction" label="Waste fraction" value={adjusting.wasteFractionId ?? ""} options={fractions} onChange={(wasteFractionId) => setAdjusting({ ...adjusting, wasteFractionId })} placeholder="Pick a fraction" />
              <Field id="adjust-delta" label="Kilograms" value={adjusting.deltaKg ?? ""} onChange={(deltaKg) => setAdjusting({ ...adjusting, deltaKg })} placeholder="-1500" />
              <Field id="adjust-note" label="What the count found" value={adjusting.note ?? ""} onChange={(note) => setAdjusting({ ...adjusting, note })} />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjusting(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => adjusting !== null && send(ADJUST_STOCK, adjusting, () => setAdjusting(null), "Stock adjusted")}>
              Adjust stock
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={sending !== null} onOpenChange={(open) => !open && setSending(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Send a load from {record.name}</DialogTitle>
            <DialogDescription>Our out-weighing of a load leaving for another station; the receiving site&apos;s ticket is recorded when it comes back. Costs are recorded in the project&apos;s currency and never billed.</DialogDescription>
          </DialogHeader>
          {sending !== null && (
            <div className="space-y-3">
              <Pick id="send-project" label="Project" value={sending.projectId ?? ""} options={projects} onChange={(projectId) => setSending({ ...sending, projectId, vehicleId: "" })} placeholder="Whose material it is" />
              <Pick id="send-to" label="Goes to" value={sending.toStationId ?? ""} options={destinationChoices(stations.records, record.id)} onChange={(toStationId) => setSending({ ...sending, toStationId })} placeholder="The receiving station" />
              <Pick id="send-fraction" label="Waste fraction" value={sending.wasteFractionId ?? ""} options={fractions} onChange={(wasteFractionId) => setSending({ ...sending, wasteFractionId })} placeholder="Pick a fraction" />
              <Pick id="send-vehicle" label="Our vehicle" value={sending.vehicleId ?? ""} options={vehicleChoices(vehicles.records, sending.projectId ?? "")} onChange={(vehicleId) => setSending({ ...sending, vehicleId })} placeholder="A hauler's truck: leave it and give the plate" />
              <Field id="send-plate" label="Plate" value={sending.vehicleRegistration ?? ""} onChange={(vehicleRegistration) => setSending({ ...sending, vehicleRegistration })} placeholder="Read off our vehicle when blank" />
              <Field id="send-departed" label="Left at" type="datetime-local" value={sending.departedAt ?? ""} onChange={(departedAt) => setSending({ ...sending, departedAt })} />
              <Field id="send-net" label="Net (kg)" value={sending.netKg ?? ""} onChange={(netKg) => setSending({ ...sending, netKg })} />
              <div className="grid grid-cols-2 gap-3">
                <Field id="send-gross" label="Gross (kg)" value={sending.grossKg ?? ""} onChange={(grossKg) => setSending({ ...sending, grossKg })} />
                <Field id="send-tare" label="Tare (kg)" value={sending.tareKg ?? ""} onChange={(tareKg) => setSending({ ...sending, tareKg })} />
              </div>
              <Field id="send-ticket" label="Our ticket" value={sending.outboundTicket ?? ""} onChange={(outboundTicket) => setSending({ ...sending, outboundTicket })} />
              <div className="grid grid-cols-2 gap-3">
                <Field id="send-haul" label={`Haul cost (${project(sending.projectId)?.currency ?? ""})`} value={sending.haulCost ?? ""} onChange={(haulCost) => setSending({ ...sending, haulCost })} />
                <Field id="send-disposal" label={`Disposal cost (${project(sending.projectId)?.currency ?? ""})`} value={sending.disposalCost ?? ""} onChange={(disposalCost) => setSending({ ...sending, disposalCost })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSending(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                if (sending === null) return
                const chosen = project(sending.projectId)
                send(SEND_LOAD, { ...sending, timezone: chosen?.timezone ?? "", currency: chosen?.currency ?? "DKK" }, () => setSending(null), "Load sent")
              }}
            >
              Send load
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={acting !== null} onOpenChange={(open) => !open && setActing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{acting === null ? "" : VERB[acting.verb]}</DialogTitle>
            <DialogDescription>
              {acting?.verb === "receive"
                ? "The receiving site's own ticket: its number, its net and when it weighed. Given again, it corrects the receipt."
                : acting?.verb === "reconcile"
                  ? "Accept the receiving site's ticket against our out-weighing; say how a dispute was settled if you like."
                  : "Say why."}
            </DialogDescription>
          </DialogHeader>
          {acting !== null &&
            (acting.verb === "receive" ? (
              <div className="space-y-3">
                <Field id="receipt-ticket" label="Their ticket" value={acting.draft.receivingTicket ?? ""} onChange={(receivingTicket) => setActing({ ...acting, draft: { ...acting.draft, receivingTicket } })} />
                <Field id="receipt-net" label="Their net (kg)" value={acting.draft.receivedNetKg ?? ""} onChange={(receivedNetKg) => setActing({ ...acting, draft: { ...acting.draft, receivedNetKg } })} />
                <Field id="receipt-at" label="Weighed at" type="datetime-local" value={acting.draft.receivedAt ?? ""} onChange={(receivedAt) => setActing({ ...acting, draft: { ...acting.draft, receivedAt } })} />
              </div>
            ) : (
              <Field id="load-note" label={acting.verb === "reconcile" ? "Note" : "Why"} value={acting.draft.note ?? ""} onChange={(note) => setActing({ ...acting, draft: { ...acting.draft, note } })} />
            ))}
          <DialogFooter>
            <Button variant="outline" onClick={() => setActing(null)}>
              Close
            </Button>
            <Button
              disabled={busy}
              onClick={() => acting !== null && send(ACTION[acting.verb], { ...acting.draft, timezone: acting.timezone ?? "" }, () => setActing(null), acting.verb === "receive" ? "Receipt recorded" : acting.verb === "reconcile" ? "Load reconciled" : acting.verb === "dispute" ? "Load disputed" : "Load cancelled")}
            >
              {acting === null ? "" : VERB[acting.verb]}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
