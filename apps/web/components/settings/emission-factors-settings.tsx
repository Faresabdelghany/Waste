"use client"

// Settings › Operations › Emission factors (M10 of #293): the company's
// grams of CO₂e per unit of each fuel, each over a period, which the fleet's
// routes are measured by — read from and written to the API's
// `/fuel-emission-factors` under master data's grants, as the vehicle types
// beside them are. A factor's fuel, number and start are its period's own:
// the edit moves its end and its source, and a revised number is the next
// period's factor, added from the day the old one ends. The form and the
// bodies it becomes are lib/data/fleet-emissions.ts'. Offered on the Pilot
// alone.

import { useState, type FormEvent } from "react"
import { PencilSimple, Plus } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { FuelEmissionFactor } from "@waste/contracts/emissions"
import { FUEL_TYPES, type FuelType } from "@waste/domain/resources/vocabulary"
import { useReport } from "@/components/insight/use-report"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/asset-management-settings"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { useApiClient, useApiSession } from "@/components/waste/api-session-store"
import { create, listAll, patch } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { dayIn, lastDayIn } from "@/lib/api/records/planning"
import { problemOfError } from "@/lib/api/records/server-records"
import {
  factorAccessOf,
  factorCreateBodyOf,
  factorFormOf,
  factorPatchBodyOf,
  factorSentence,
  factorsInOrder,
  FUEL_LABELS,
  isFactorRefusal,
  newFactorForm,
  type FactorForm,
  type FactorRefusal,
} from "@/lib/data/fleet-emissions"

/** The dialog open on a new factor or on one of the company's, with the form as edited. */
type Editing = { factor: FuelEmissionFactor | null; form: FactorForm }

export function EmissionFactorsSettings() {
  const client = useApiClient()
  const { me } = useApiSession()
  const access = factorAccessOf(me?.role.grants)
  // Bumped by a save, so the factors are read again as the API now holds them.
  const [version, setVersion] = useState(0)
  const read = useReport<FuelEmissionFactor[]>(access.view ? `emission-factors:${version}` : null, (asking) => listAll<FuelEmissionFactor>(asking, "/fuel-emission-factors"))
  const factors = read.shown === null ? [] : factorsInOrder(read.shown)

  const [editing, setEditing] = useState<Editing | null>(null)
  const [refusal, setRefusal] = useState<FactorRefusal | null>(null)
  const [saving, setSaving] = useState(false)

  const open = (factor: FuelEmissionFactor | null) => {
    setRefusal(null)
    setEditing({ factor, form: factor === null ? newFactorForm(dayIn(new Date(), undefined)) : factorFormOf(factor) })
  }
  const change = (values: Partial<FactorForm>) => {
    if (editing === null) return
    setEditing({ ...editing, form: { ...editing.form, ...values } })
    setRefusal(null)
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (client === null || editing === null) return
    const { factor, form } = editing
    const body = factor === null ? factorCreateBodyOf(form) : factorPatchBodyOf(factor, form)
    if (body === null) {
      setEditing(null)
      return
    }
    if (isFactorRefusal(body)) {
      setRefusal(body)
      return
    }
    setSaving(true)
    const writing = factor === null ? create<FuelEmissionFactor>(client, "/fuel-emission-factors", body).then((answer) => answer.body) : patch<FuelEmissionFactor>(client, `/fuel-emission-factors/${factor.id}`, body)
    writing
      .then(
        (written) => {
          setEditing(null)
          setVersion((current) => current + 1)
          toast.success(factor === null ? "Factor added" : "Factor saved", { description: `${FUEL_LABELS[written.fuel]}: ${factorSentence(written)}, ${periodOf(written)}.` })
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
        : "No emission factors: every route's emissions are unmeasured until its fuel has one."

  return (
    <AssetPanelShell
      heading="Operations"
      title="Emission factors"
      description="Grams of CO₂e per unit of each fuel, over the period it is in force, which the fleet's routes are measured by."
      action={
        <Button size="sm" disabled={!access.create || read.shown === null} onClick={() => open(null)}>
          <Plus className="h-4 w-4" weight="bold" />
          Add factor
        </Button>
      }
      toolbar={null}
    >
      <p className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
        A route is measured by the factor of its vehicle&apos;s fuel in force on the day it drives. Quote the published list and its year in the source, or say it is a demo value. A revised number is a new factor from the day the old one ends.
      </p>
      <RecordsSection shown={factors.length} total={factors.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Fuel</TableHead>
                <TableHead>Factor</TableHead>
                <TableHead>In force</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {factors.length === 0 ? (
                <EmptyRow colSpan={5} message={emptyMessage} hint={access.create && read.shown !== null ? "Add the factor of each fuel your fleet runs on." : ""} />
              ) : (
                factors.map((factor) => (
                  <TableRow key={factor.id} aria-label={`${FUEL_LABELS[factor.fuel]} from ${factor.validFrom}`}>
                    <TableCell className="font-medium">{FUEL_LABELS[factor.fuel]}</TableCell>
                    <TableCell>{factorSentence(factor)}</TableCell>
                    <TableCell className="text-muted-foreground">{periodOf(factor)}</TableCell>
                    <TableCell className="max-w-[360px] truncate text-muted-foreground" title={factor.source}>
                      {factor.source}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${FUEL_LABELS[factor.fuel]} from ${factor.validFrom}`} disabled={!access.edit} onClick={() => open(factor)}>
                        <PencilSimple className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </RecordsSection>

      <Dialog open={editing !== null} onOpenChange={(next) => !next && !saving && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          {editing !== null && <FactorDialogForm editing={editing} refusal={refusal} saving={saving} onChange={change} onCancel={() => setEditing(null)} onSubmit={save} />}
        </DialogContent>
      </Dialog>
    </AssetPanelShell>
  )
}

/** A factor's period as the table reads it: "From 2025-01-01", or its first and last day in force. */
const periodOf = (factor: Pick<FuelEmissionFactor, "validFrom" | "validTo">) => (factor.validTo === null ? `From ${factor.validFrom}` : `${factor.validFrom} to ${lastDayIn(factor.validTo)}`)

function FactorDialogForm({
  editing,
  refusal,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  editing: Editing
  refusal: FactorRefusal | null
  saving: boolean
  onChange: (values: Partial<FactorForm>) => void
  onCancel: () => void
  onSubmit: (event: FormEvent) => void
}) {
  const { factor, form } = editing
  // The fuel, the number and the start are the period's own: an edit moves the end and the source.
  const keyed = factor !== null
  const message = (field: keyof FactorForm) => (refusal?.field === field ? <p className="text-xs text-destructive">{refusal.message}</p> : null)

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{keyed ? "Edit factor" : "Add factor"}</DialogTitle>
        <DialogDescription>
          {keyed ? "End the factor or correct its source. A revised number is a new factor from the day this one ends." : "Grams of CO₂e per unit of the fuel from the first day it is in force, and where the number comes from."}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="factor-fuel">Fuel</Label>
          <Select value={form.fuel} onValueChange={(fuel) => onChange({ fuel: fuel as FuelType })} disabled={keyed}>
            <SelectTrigger id="factor-fuel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FUEL_TYPES.map((fuel) => (
                <SelectItem key={fuel} value={fuel}>
                  {FUEL_LABELS[fuel]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="factor-grams">{`g CO₂e per ${factorSentence({ fuel: form.fuel, gramsPerUnit: 0 }).split(" per ")[1]}`}</Label>
          <Input id="factor-grams" inputMode="numeric" value={form.gramsPerUnit} disabled={keyed} aria-invalid={refusal?.field === "gramsPerUnit"} onChange={(event) => onChange({ gramsPerUnit: event.target.value })} />
          {message("gramsPerUnit")}
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="factor-source">Source</Label>
          <Textarea id="factor-source" rows={3} value={form.source} aria-invalid={refusal?.field === "source"} placeholder="The published list and its year, or Demo value" onChange={(event) => onChange({ source: event.target.value })} />
          {message("source")}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="factor-from">First day in force</Label>
          <Input id="factor-from" type="date" value={form.validFrom} disabled={keyed} aria-invalid={refusal?.field === "validFrom"} onChange={(event) => onChange({ validFrom: event.target.value })} />
          {message("validFrom")}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="factor-last-day">Last day in force</Label>
          <Input id="factor-last-day" type="date" value={form.lastDay} aria-invalid={refusal?.field === "lastDay"} onChange={(event) => onChange({ lastDay: event.target.value })} />
          {message("lastDay")}
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {keyed ? "Save factor" : "Add factor"}
        </Button>
      </DialogFooter>
    </form>
  )
}
