"use client"

// Settings › Operations › Bulky schedules (O11 of #290): one project's Bulky
// Schedules at a time — the days each planning area collects bulky waste on,
// the slots each day has and the product a booking is charged at — read from
// and written to the API's `/bulky-schedules` under the route schemes'
// grants. The areas and the products a schedule names are read beside them,
// each under its own grant; a role without one sees the id. A schedule is
// never deleted: it ends on its last day in force, and another starts after
// it. The form and the bodies it becomes are lib/data/bulky.ts'. Offered on
// the Pilot alone.

import { useState, type FormEvent } from "react"
import { PencilSimple, Plus } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { BulkySchedule } from "@waste/contracts/bulky"
import type { Product } from "@waste/contracts/catalogue"
import type { PlanningArea } from "@waste/contracts/planning-areas"
import type { HolidayPolicy, RecurrenceFrequency, ServiceDay, WeekRotation } from "@waste/domain/planning/vocabulary"
import { useReport } from "@/components/insight/use-report"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/asset-management-settings"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiClient, useApiSession } from "@/components/waste/api-session-store"
import { create, listAll, patch } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { dayIn } from "@/lib/api/records/planning"
import { problemOfError } from "@/lib/api/records/server-records"
import {
  FREQUENCY_OPTIONS,
  HOLIDAY_POLICY_OPTIONS,
  isScheduleRefusal,
  newScheduleForm,
  periodSentence,
  recurrenceSentence,
  scheduleAccessOf,
  scheduleCreateBodyOf,
  scheduleFormOf,
  schedulePatchBodyOf,
  schedulesInOrder,
  SERVICE_DAY_OPTIONS,
  slotsSentence,
  type ScheduleForm,
  type ScheduleRefusal,
} from "@/lib/data/bulky"

type Read = { schedules: BulkySchedule[]; areas: PlanningArea[]; products: Product[] }

/** The dialog open on a new schedule or on one of the project's, with the form as edited. */
type Editing = { schedule: BulkySchedule | null; form: ScheduleForm }

export function BulkySchedulesSettings() {
  const client = useApiClient()
  const { me } = useApiSession()
  const projects = me?.projects ?? []
  const access = scheduleAccessOf(me?.role.grants)
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null)
  const project = projects.find((candidate) => candidate.id === chosenProjectId) ?? projects[0] ?? null
  // Bumped by a save, so the schedules are read again as the API now holds them.
  const [version, setVersion] = useState(0)

  const read = useReport<Read>(project === null || !access.view ? null : `bulky-schedules:${project.id}:${version}`, async (asking) => {
    const projectId = project?.id ?? ""
    const [schedules, areas, products] = await Promise.all([
      listAll<BulkySchedule>(asking, "/bulky-schedules", { projectId }),
      access.areas ? listAll<PlanningArea>(asking, "/planning-areas", { projectId }) : Promise.resolve([]),
      access.products ? listAll<Product>(asking, "/products", { projectId }) : Promise.resolve([]),
    ])
    return { schedules, areas, products }
  })
  const shown = read.shown
  const areaName = (id: string) => shown?.areas.find((candidate) => candidate.id === id)?.name ?? id
  const productName = (id: string) => shown?.products.find((candidate) => candidate.id === id)?.name ?? id
  const schedules = shown === null ? [] : schedulesInOrder(shown.schedules, areaName)

  const [editing, setEditing] = useState<Editing | null>(null)
  const [refusal, setRefusal] = useState<ScheduleRefusal | null>(null)
  const [saving, setSaving] = useState(false)

  const open = (schedule: BulkySchedule | null) => {
    setRefusal(null)
    setEditing({ schedule, form: schedule === null ? newScheduleForm(dayIn(new Date(), undefined)) : scheduleFormOf(schedule) })
  }
  const change = (values: Partial<ScheduleForm>) => {
    if (editing === null) return
    setEditing({ ...editing, form: { ...editing.form, ...values } })
    setRefusal(null)
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (client === null || project === null || editing === null) return
    const { schedule, form } = editing
    const body = schedule === null ? scheduleCreateBodyOf(project.id, form) : schedulePatchBodyOf(schedule, form)
    if (body === null) {
      setEditing(null)
      return
    }
    if (isScheduleRefusal(body)) {
      setRefusal(body)
      return
    }
    setSaving(true)
    const writing = schedule === null ? create<BulkySchedule>(client, "/bulky-schedules", body).then((answer) => answer.body) : patch<BulkySchedule>(client, `/bulky-schedules/${schedule.id}`, body)
    writing
      .then(
        (written) => {
          setEditing(null)
          setVersion((current) => current + 1)
          toast.success(schedule === null ? "Schedule added" : "Schedule saved", { description: `${areaName(written.planningAreaId)}: ${recurrenceSentence(written)}, ${slotsSentence(written.slotsPerDay)}.` })
        },
        (error: unknown) => toast.error(schedule === null ? "The schedule was not added" : "The schedule was not saved", { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setSaving(false))
  }

  const emptyMessage = !access.view
    ? "The bulky schedules are not shown to your role."
    : project === null
      ? "No project to schedule bulky collections in."
      : read.problem !== null
        ? `The schedules could not be read from the API: ${problemSentence(read.problem)}`
        : shown === null
          ? "Reading the schedules from the API…"
          : `${project.name} collects no bulky waste by booking: no area has a schedule.`

  // The products a schedule may charge: the project's active ones sold by the job, and the one it charges now whatever it is.
  const productOptions = (kept: string | undefined) => (shown?.products ?? []).filter((candidate) => (candidate.unit === "job" && candidate.status === "active") || candidate.id === kept)

  return (
    <AssetPanelShell
      heading="Operations"
      title="Bulky schedules"
      description="The days each planning area collects bulky waste on, how many bookings a day takes, and what a booking is charged once collected."
      action={
        <Button size="sm" disabled={!access.create || project === null || shown === null} onClick={() => open(null)}>
          <Plus className="h-4 w-4" weight="bold" />
          Add schedule
        </Button>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="bulky-schedules-project" className="text-sm text-muted-foreground">
            Project
          </Label>
          <Select value={project?.id ?? ""} onValueChange={setChosenProjectId} disabled={projects.length === 0}>
            <SelectTrigger id="bulky-schedules-project" className="w-64">
              <SelectValue placeholder="Pick a project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    >
      <p className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
        A place is booked on the days of the schedule of the area it lies in. Each booking takes one slot of its day; a full day is not offered. Fewer slots close a day to new bookings and move none already made.
      </p>
      <RecordsSection shown={schedules.length} total={schedules.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Area</TableHead>
                <TableHead>Days</TableHead>
                <TableHead>Slots</TableHead>
                <TableHead>Charged at</TableHead>
                <TableHead>In force</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.length === 0 ? (
                <EmptyRow colSpan={6} message={emptyMessage} hint={access.create && shown !== null ? "Add a schedule for each area that collects bulky waste by booking." : ""} />
              ) : (
                schedules.map((schedule) => (
                  <TableRow key={schedule.id} aria-label={`${areaName(schedule.planningAreaId)} bulky schedule`}>
                    <TableCell className="font-medium">{areaName(schedule.planningAreaId)}</TableCell>
                    <TableCell>{recurrenceSentence(schedule)}</TableCell>
                    <TableCell className="text-muted-foreground">{slotsSentence(schedule.slotsPerDay)}</TableCell>
                    <TableCell>{productName(schedule.productId)}</TableCell>
                    <TableCell className="text-muted-foreground">{periodSentence(schedule)}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${areaName(schedule.planningAreaId)} bulky schedule`} disabled={!access.edit} onClick={() => open(schedule)}>
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
        <DialogContent className="sm:max-w-xl">
          {editing !== null && shown !== null && (
            <ScheduleDialogForm
              editing={editing}
              refusal={refusal}
              saving={saving}
              areas={shown.areas}
              products={productOptions(editing.schedule?.productId)}
              onChange={change}
              onCancel={() => setEditing(null)}
              onSubmit={save}
            />
          )}
        </DialogContent>
      </Dialog>
    </AssetPanelShell>
  )
}

function ScheduleDialogForm({
  editing,
  refusal,
  saving,
  areas,
  products,
  onChange,
  onCancel,
  onSubmit,
}: {
  editing: Editing
  refusal: ScheduleRefusal | null
  saving: boolean
  areas: readonly PlanningArea[]
  products: readonly Product[]
  onChange: (values: Partial<ScheduleForm>) => void
  onCancel: () => void
  onSubmit: (event: FormEvent) => void
}) {
  const { schedule, form } = editing
  // The area, the recurrence and the start are the schedule's key: an edit moves the slots, the product and the end.
  const keyed = schedule !== null
  const message = (field: keyof ScheduleForm) => (refusal?.field === field ? <p className="text-xs text-destructive">{refusal.message}</p> : null)
  const toggleDay = (day: ServiceDay, on: boolean) => onChange({ serviceDays: on ? [...form.serviceDays, day] : form.serviceDays.filter((candidate) => candidate !== day) })

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{keyed ? "Edit schedule" : "Add schedule"}</DialogTitle>
        <DialogDescription>
          {keyed ? "Move the slots a day, the product or the end. The area, its days and the start are the schedule's own: end it and add another to change them." : "The area, the days it collects bulky waste on, the slots each day has and the product a booking is charged at."}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="bulky-area">Planning area</Label>
          <Select value={form.planningAreaId} onValueChange={(planningAreaId) => onChange({ planningAreaId })} disabled={keyed}>
            <SelectTrigger id="bulky-area" aria-invalid={refusal?.field === "planningAreaId"}>
              <SelectValue placeholder="Pick an area" />
            </SelectTrigger>
            <SelectContent>
              {areas.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {message("planningAreaId")}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bulky-frequency">Frequency</Label>
          <Select value={form.frequency} onValueChange={(frequency) => onChange({ frequency: frequency as RecurrenceFrequency, weekRotation: frequency === "every-2-weeks" ? form.weekRotation : "" })} disabled={keyed}>
            <SelectTrigger id="bulky-frequency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FREQUENCY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bulky-holidays">On a holiday</Label>
          <Select value={form.holidayPolicy} onValueChange={(holidayPolicy) => onChange({ holidayPolicy: holidayPolicy as HolidayPolicy })} disabled={keyed}>
            <SelectTrigger id="bulky-holidays">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOLIDAY_POLICY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {form.frequency !== "daily" && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Service days</legend>
          <div className="flex flex-wrap gap-3">
            {SERVICE_DAY_OPTIONS.map((option) => (
              <label key={option.value} className="flex items-center gap-1.5 text-sm">
                <Checkbox checked={form.serviceDays.includes(option.value)} disabled={keyed} onCheckedChange={(checked) => toggleDay(option.value, checked === true)} aria-label={option.label} />
                {option.label}
              </label>
            ))}
          </div>
          {message("serviceDays")}
        </fieldset>
      )}

      {form.frequency === "every-2-weeks" && (
        <div className="space-y-1.5">
          <Label htmlFor="bulky-rotation">Weeks</Label>
          <Select value={form.weekRotation} onValueChange={(weekRotation) => onChange({ weekRotation: weekRotation as WeekRotation })} disabled={keyed}>
            <SelectTrigger id="bulky-rotation" aria-invalid={refusal?.field === "weekRotation"}>
              <SelectValue placeholder="Pick odd or even weeks" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="odd">Odd weeks</SelectItem>
              <SelectItem value="even">Even weeks</SelectItem>
            </SelectContent>
          </Select>
          {message("weekRotation")}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="bulky-slots">Slots a day</Label>
          <Input id="bulky-slots" inputMode="numeric" value={form.slotsPerDay} aria-invalid={refusal?.field === "slotsPerDay"} onChange={(event) => onChange({ slotsPerDay: event.target.value })} />
          {message("slotsPerDay")}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bulky-product">Charged at</Label>
          <Select value={form.productId} onValueChange={(productId) => onChange({ productId })}>
            <SelectTrigger id="bulky-product" aria-invalid={refusal?.field === "productId"}>
              <SelectValue placeholder="Pick a product" />
            </SelectTrigger>
            <SelectContent>
              {products.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {products.length === 0 && <p className="text-xs text-muted-foreground">No product to charge: a booking is charged at one of the project&apos;s active products sold by the job.</p>}
          {message("productId")}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bulky-from">First day in force</Label>
          <Input id="bulky-from" type="date" value={form.validFrom} disabled={keyed} aria-invalid={refusal?.field === "validFrom"} onChange={(event) => onChange({ validFrom: event.target.value })} />
          {message("validFrom")}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bulky-last-day">Last day in force</Label>
          <Input id="bulky-last-day" type="date" value={form.lastDay} aria-invalid={refusal?.field === "lastDay"} onChange={(event) => onChange({ lastDay: event.target.value })} />
          {message("lastDay")}
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {keyed ? "Save schedule" : "Add schedule"}
        </Button>
      </DialogFooter>
    </form>
  )
}
