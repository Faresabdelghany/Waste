"use client"
// The waste fractions' emission factors in Settings › Operations › Emission
// factors (M13 of #293), beside the fuels': the kilograms of CO₂e a tonne of
// each fraction emits once treated, and those it avoids, over the period each
// is in force — what a Customer's sustainability report is measured by. Read
// from and written to `/waste-fraction-emission-factors` under master data's
// grants, the fractions named by the master data's own rows. The form and the
// bodies it becomes are lib/data/waste-emission-factors.ts'.
import { useState, type FormEvent } from "react"
import { PencilSimple, Plus } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { WasteFractionEmissionFactor } from "@waste/contracts/sustainability"
import { useReport } from "@/components/insight/use-report"
import { EmptyRow } from "@/components/settings/asset-management-settings"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { useApiClient, useApiSession } from "@/components/waste/api-session-store"
import { useModuleRecords, useServerModuleState } from "@/components/waste/business-record-store"
import { create, listAll, patch } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { dayIn } from "@/lib/api/records/planning"
import { problemOfError } from "@/lib/api/records/server-records"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { factorAccessOf, factorPeriodLabel } from "@/lib/data/fleet-emissions"
import { MASTER_DATA_MODULE, masterDataKindOf } from "@/lib/data/master-data"
import {
  isWasteFactorRefusal,
  newWasteFactorForm,
  wasteFactorCreateBodyOf,
  wasteFactorFormOf,
  wasteFactorPatchBodyOf,
  wasteFactorSentence,
  wasteFactorsInOrder,
  type WasteFactorForm,
  type WasteFactorRefusal,
} from "@/lib/data/waste-emission-factors"

const NO_FIXTURES: readonly BusinessRecord[] = []

type Editing = { factor: WasteFractionEmissionFactor | null; form: WasteFactorForm }

export function WasteFactorsSection() {
  const client = useApiClient()
  const { me } = useApiSession()
  const access = factorAccessOf(me?.role.grants)
  const master = useModuleRecords(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId, NO_FIXTURES)
  const serverIds = useServerModuleState(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId)?.serverIds
  // The fractions by server id, which the factors name them by.
  const fractions = master.records.flatMap((record) => {
    const serverId = masterDataKindOf(record) === "waste-fraction" ? serverIds?.get(record.id) : undefined
    return serverId === undefined ? [] : [{ serverId, name: record.name }]
  })
  const nameOf = (serverId: string) => fractions.find((fraction) => fraction.serverId === serverId)?.name ?? "A fraction not read"
  const [version, setVersion] = useState(0)
  const read = useReport<WasteFractionEmissionFactor[]>(access.view ? `waste-emission-factors:${version}` : null, (asking) => listAll<WasteFractionEmissionFactor>(asking, "/waste-fraction-emission-factors"))
  const factors = read.shown === null ? [] : wasteFactorsInOrder(read.shown, nameOf)

  const [editing, setEditing] = useState<Editing | null>(null)
  const [refusal, setRefusal] = useState<WasteFactorRefusal | null>(null)
  const [saving, setSaving] = useState(false)

  const open = (factor: WasteFractionEmissionFactor | null) => {
    setRefusal(null)
    setEditing({ factor, form: factor === null ? newWasteFactorForm(dayIn(new Date(), undefined), fractions[0]?.serverId ?? "") : wasteFactorFormOf(factor) })
  }
  const change = (values: Partial<WasteFactorForm>) => {
    if (editing === null) return
    setEditing({ ...editing, form: { ...editing.form, ...values } })
    setRefusal(null)
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (client === null || editing === null) return
    const { factor, form } = editing
    const body = factor === null ? wasteFactorCreateBodyOf(form) : wasteFactorPatchBodyOf(factor, form)
    if (body === null) {
      setEditing(null)
      return
    }
    if (isWasteFactorRefusal(body)) {
      setRefusal(body)
      return
    }
    setSaving(true)
    const writing =
      factor === null
        ? create<WasteFractionEmissionFactor>(client, "/waste-fraction-emission-factors", body).then((answer) => answer.body)
        : patch<WasteFractionEmissionFactor>(client, `/waste-fraction-emission-factors/${factor.id}`, body)
    writing
      .then(
        (written) => {
          setEditing(null)
          setVersion((current) => current + 1)
          toast.success(factor === null ? "Factor added" : "Factor saved", { description: `${nameOf(written.wasteFractionId)}: ${wasteFactorSentence(written)}, ${periodOf(written)}.` })
        },
        (error: unknown) => toast.error(factor === null ? "The factor was not added" : "The factor was not saved", { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setSaving(false))
  }

  const emptyMessage = !access.view
    ? "The emission factors are not shown to your role."
    : read.problem !== null
      ? `The factors could not be read from the API: ${problemSentence(read.problem)}`
      : read.shown === null
        ? "Reading the factors from the API…"
        : "No waste factors: a customer's sustainability report shows no CO₂e until its fractions have one."

  return (
    <section aria-label="Waste fractions" data-testid="waste-factors">
      <div className="flex items-center justify-between gap-3 border-y border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">Waste fractions</h3>
          <p className="text-sm text-muted-foreground">Kilograms of CO₂e per tonne of each fraction once treated, and what it avoids, which a customer&apos;s sustainability report is measured by.</p>
        </div>
        <Button size="sm" disabled={!access.create || fractions.length === 0} onClick={() => open(null)}>
          <Plus className="h-4 w-4" weight="bold" />
          Add waste factor
        </Button>
      </div>
      {read.problem !== null && factors.length > 0 && (
        <p role="alert" className="border-b border-border px-4 py-3 text-sm text-destructive">
          The factors could not be read again from the API: {problemSentence(read.problem)}. What is listed is the last read.
        </p>
      )}
      <div className="overflow-x-auto">
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead>Waste fraction</TableHead>
              <TableHead>Factor</TableHead>
              <TableHead>In force</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {factors.length === 0 ? (
              <EmptyRow colSpan={5} message={emptyMessage} hint={access.create && read.shown !== null ? "Add the factor of each fraction you collect, quoting where the numbers come from." : ""} />
            ) : (
              factors.map((factor) => (
                <TableRow key={factor.id} aria-label={`${nameOf(factor.wasteFractionId)} from ${factor.validFrom}`}>
                  <TableCell className="font-medium">{nameOf(factor.wasteFractionId)}</TableCell>
                  <TableCell>{wasteFactorSentence(factor)}</TableCell>
                  <TableCell className="text-muted-foreground">{periodOf(factor)}</TableCell>
                  <TableCell className="max-w-[360px] truncate text-muted-foreground" title={factor.source}>
                    {factor.source}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${nameOf(factor.wasteFractionId)} from ${factor.validFrom}`} disabled={!access.edit} onClick={() => open(factor)}>
                      <PencilSimple className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={editing !== null} onOpenChange={(next) => !next && !saving && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          {editing !== null && <WasteFactorDialogForm editing={editing} fractions={fractions} refusal={refusal} saving={saving} onChange={change} onCancel={() => setEditing(null)} onSubmit={save} />}
        </DialogContent>
      </Dialog>
    </section>
  )
}

const periodOf = factorPeriodLabel

function WasteFactorDialogForm({
  editing,
  fractions,
  refusal,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  editing: Editing
  fractions: readonly { serverId: string; name: string }[]
  refusal: WasteFactorRefusal | null
  saving: boolean
  onChange: (values: Partial<WasteFactorForm>) => void
  onCancel: () => void
  onSubmit: (event: FormEvent) => void
}) {
  const { factor, form } = editing
  // The fraction, the numbers and the start are the period's own: an edit moves the end and the source.
  const keyed = factor !== null
  const message = (field: keyof WasteFactorForm) => (refusal?.field === field ? <p className="text-xs text-destructive">{refusal.message}</p> : null)

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{keyed ? "Edit waste factor" : "Add waste factor"}</DialogTitle>
        <DialogDescription>
          {keyed ? "End the factor or correct its source. Revised numbers are a new factor from the day this one ends." : "Kilograms of CO₂e per tonne of the fraction from the first day it is in force, and where the numbers come from."}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="waste-factor-fraction">Waste fraction</Label>
          <Select value={form.wasteFractionId} onValueChange={(wasteFractionId) => onChange({ wasteFractionId })} disabled={keyed}>
            <SelectTrigger id="waste-factor-fraction" aria-invalid={refusal?.field === "wasteFractionId"}>
              <SelectValue placeholder="Pick a fraction" />
            </SelectTrigger>
            <SelectContent>
              {fractions.map((fraction) => (
                <SelectItem key={fraction.serverId} value={fraction.serverId}>
                  {fraction.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {message("wasteFractionId")}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="waste-factor-footprint">kg CO₂e per t</Label>
          <Input id="waste-factor-footprint" inputMode="numeric" value={form.footprint} disabled={keyed} aria-invalid={refusal?.field === "footprint"} onChange={(event) => onChange({ footprint: event.target.value })} />
          {message("footprint")}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="waste-factor-avoided">kg CO₂e avoided per t</Label>
          <Input id="waste-factor-avoided" inputMode="numeric" value={form.avoided} disabled={keyed} placeholder="Blank where it displaces nothing" aria-invalid={refusal?.field === "avoided"} onChange={(event) => onChange({ avoided: event.target.value })} />
          {message("avoided")}
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="waste-factor-source">Source</Label>
          <Textarea id="waste-factor-source" rows={3} value={form.source} aria-invalid={refusal?.field === "source"} placeholder="The published list and its year, or Demo value" onChange={(event) => onChange({ source: event.target.value })} />
          {message("source")}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="waste-factor-from">First day in force</Label>
          <Input id="waste-factor-from" type="date" value={form.validFrom} disabled={keyed} aria-invalid={refusal?.field === "validFrom"} onChange={(event) => onChange({ validFrom: event.target.value })} />
          {message("validFrom")}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="waste-factor-last-day">Last day in force</Label>
          <Input id="waste-factor-last-day" type="date" value={form.lastDay} aria-invalid={refusal?.field === "lastDay"} onChange={(event) => onChange({ lastDay: event.target.value })} />
          {message("lastDay")}
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {keyed ? "Save factor" : "Add waste factor"}
        </Button>
      </DialogFooter>
    </form>
  )
}
