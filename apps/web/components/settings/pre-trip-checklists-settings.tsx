"use client"

// Settings › Pre-trip checklists (O13 of #290): a vehicle type's checklist —
// what a driver looks at on a vehicle of the type before or during the day,
// in order, each item critical or not — read with the company's vehicle types
// and replaced whole through the client (lib/api/pre-trip-checklists.ts),
// since the list is a type's configuration and no row of a workspace's table.
// A row the API would refuse is refused at the row first, in its sentence
// (lib/data/pre-trip-checklists.ts). On the Pilot alone: fixture mode keeps no
// checklists.
import { useRef, useState } from "react"
import { ArrowDown, ArrowUp, FloppyDisk, Plus, Trash } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { VehicleType } from "@waste/contracts/vehicle-types"
import { useReport } from "@/components/insight/use-report"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/asset-management-settings"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiClient, useApiSession } from "@/components/waste/api-session-store"
import { readVehicleTypes, replaceChecklist } from "@/lib/api/pre-trip-checklists"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import { checklistAccessOf, checklistBodyOf, checklistChanged, checklistRowsOf, isChecklistRefusal, movedRow, type ChecklistRefusal, type ChecklistRow } from "@/lib/data/pre-trip-checklists"
import { CHECKLIST_MAX } from "@waste/domain/resources/pre-trip"

export function PreTripChecklistsSettings() {
  const client = useApiClient()
  const { me } = useApiSession()
  const access = checklistAccessOf(me?.role.grants)
  const read = useReport<VehicleType[]>(access.view ? "vehicle-types" : null, readVehicleTypes)
  // The types the last save answered for, which stand for the read's until it is read again.
  const [answered, setAnswered] = useState<Record<string, VehicleType>>({})
  const types = (read.report ?? []).map((type) => answered[type.id] ?? type)
  const [chosenTypeId, setChosenTypeId] = useState<string | null>(null)
  const type = types.find((candidate) => candidate.id === chosenTypeId) ?? types[0] ?? null
  // The rows as edited, held to the type and the list they were edited from: a save or another type starts them again.
  const [edits, setEdits] = useState<{ base: VehicleType; rows: ChecklistRow[] } | null>(null)
  const editing = edits !== null && type !== null && edits.base === type
  const rows = type === null ? [] : editing ? edits.rows : checklistRowsOf(type.checklist)
  const changed = type !== null && editing && checklistChanged(rows, type.checklist)
  const [refusal, setRefusal] = useState<ChecklistRefusal | null>(null)
  const [saving, setSaving] = useState(false)
  const minted = useRef(0)

  const change = (next: ChecklistRow[]) => {
    if (type === null) return
    setEdits({ base: type, rows: next })
    setRefusal(null)
  }
  const changeRow = (index: number, values: Partial<ChecklistRow>) => change(rows.map((row, at) => (at === index ? { ...row, ...values } : row)))
  const addRow = () => {
    minted.current += 1
    change([...rows, { key: `new-${minted.current}`, label: "", critical: true }])
  }

  const save = () => {
    if (client === null || type === null) return
    const body = checklistBodyOf(rows)
    if (isChecklistRefusal(body)) {
      setRefusal(body)
      return
    }
    setSaving(true)
    replaceChecklist(client, type.id, body)
      .then(
        (saved) => {
          setAnswered((current) => ({ ...current, [saved.id]: saved }))
          setEdits(null)
          toast.success("Checklist saved", { description: `${saved.name} has ${saved.checklist.length === 1 ? "one item" : `${saved.checklist.length} items`}. Checks made from now on answer it.` })
        },
        (error: unknown) => toast.error("The checklist was not saved", { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setSaving(false))
  }

  const emptyMessage = !access.view
    ? "The pre-trip checklists are not shown to your role."
    : read.problem !== null
      ? `The vehicle types could not be read from the API: ${problemSentence(read.problem)}`
      : read.report === null
        ? "Reading the vehicle types from the API…"
        : type === null
          ? "No vehicle type to set a checklist for: add one in Master data."
          : `${type.name} has no checklist: a check of its vehicles records the readings alone.`

  return (
    <AssetPanelShell
      heading="Operations"
      title="Pre-trip checklists"
      description="What a driver checks on a vehicle of each type before or during the day. A defect of a critical item takes the vehicle off the road until it is mended."
      action={
        <div className="flex items-center gap-2">
          {editing && (
            <Button variant="outline" size="sm" disabled={saving} onClick={() => setEdits(null)}>
              Discard
            </Button>
          )}
          <Button size="sm" disabled={!access.edit || !changed || saving} onClick={save}>
            <FloppyDisk className="h-4 w-4" />
            Save checklist
          </Button>
        </div>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="pre-trip-vehicle-type" className="text-sm text-muted-foreground">
            Vehicle type
          </Label>
          {/* Held while the rows are edited: another type's list would drop them unasked. */}
          <Select
            value={type?.id ?? ""}
            onValueChange={(id) => {
              setChosenTypeId(id)
              setRefusal(null)
            }}
            disabled={types.length === 0 || editing}
          >
            <SelectTrigger id="pre-trip-vehicle-type" className="w-64">
              <SelectValue placeholder="Pick a vehicle type" />
            </SelectTrigger>
            <SelectContent>
              {types.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" disabled={!access.edit || type === null || rows.length >= CHECKLIST_MAX} onClick={addRow}>
            <Plus className="h-4 w-4" weight="bold" />
            Add item
          </Button>
          {editing && <span className="text-xs text-muted-foreground">Save or discard the changes to pick another type.</span>}
        </div>
      }
    >
      <RecordsSection shown={rows.length} total={rows.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[640px]" data-testid="pre-trip-checklist">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="w-12">#</TableHead>
                <TableHead>What the driver checks</TableHead>
                <TableHead className="w-32">Critical</TableHead>
                <TableHead className="w-36" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={4} message={emptyMessage} hint={access.edit && type !== null ? "Add the items of the walk-round, in the order a driver walks it." : ""} />
              ) : (
                rows.map((row, index) => {
                  const refused = refusal?.index === index ? refusal : null
                  return (
                    <TableRow key={row.key} aria-label={`Item ${index + 1}`}>
                      <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                      <TableCell>
                        <Input className="h-9" aria-label="What the driver checks" aria-invalid={refused !== null} value={row.label} disabled={!access.edit} onChange={(event) => changeRow(index, { label: event.target.value })} />
                        {refused !== null && <p className="mt-1 text-xs text-destructive">{refused.message}</p>}
                      </TableCell>
                      <TableCell>
                        <Checkbox aria-label={`Item ${index + 1} is critical`} checked={row.critical} disabled={!access.edit} onCheckedChange={(checked) => changeRow(index, { critical: checked === true })} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Move item ${index + 1} up`} disabled={!access.edit || index === 0} onClick={() => change(movedRow(rows, index, -1))}>
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Move item ${index + 1} down`} disabled={!access.edit || index === rows.length - 1} onClick={() => change(movedRow(rows, index, 1))}>
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Remove item ${index + 1}`} disabled={!access.edit} onClick={() => change(rows.filter((_, at) => at !== index))}>
                          <Trash className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </RecordsSection>
    </AssetPanelShell>
  )
}
