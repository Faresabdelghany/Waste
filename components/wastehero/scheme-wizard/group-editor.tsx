"use client"

// The collection group editor (nested Dialog): name, the scheme's service
// days, vehicle, a default driver filtered to the vehicle's licence class,
// the waste fraction inherited from step 1 (read-only, with a Change link
// back), container types, and a live summary of what the rule matches.
// "Review containers" opens the matched list read-only — there is no
// container editor, so no manual +/− adjustments are shown either.

import { useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { routeEstimateAdapter } from "@/lib/route-schemes/estimates"
import {
  driverHoldsLicence,
  driverOptionLabel,
  driverOptions,
  vehicleOptionLabel,
} from "@/lib/route-schemes/fleet-profiles"
import type { CollectionGroup } from "@/lib/route-schemes/groups"
import {
  CONTAINER_TYPE_VOCABULARY,
  containerMatchProfile,
  containerTypeShortLabel,
  resolveStopMatches,
  type StopMatchResult,
} from "@/lib/route-schemes/matching"
import type { GuidedSchemeData } from "@/lib/route-schemes/quick-create"
import {
  SERVICE_DAY_LABELS,
  SERVICE_DAY_SHORT_LABELS,
  sortServiceDays,
  type ServiceDay,
} from "@/lib/route-schemes/recurrence"
import { cn } from "@/lib/utils"

import type { WizardRecords } from "./use-wizard-records"
import type { WizardModel } from "./wizard-model"
import { Field, PILL_TOGGLE_ITEM_CLASS, SimpleSelect } from "./wizard-fields"

export type GroupEditorState = { mode: "add" } | { mode: "edit"; group: CollectionGroup }

export function newWizardGroup(): CollectionGroup {
  return {
    id: `group-${Date.now().toString(36)}`,
    name: "",
    days: [],
    fractions: [],
    stopSource: "rule",
    containerTypes: [],
    containerIds: [],
  }
}

/** The container types the container records actually carry. */
function useContainerVocabulary(records: WizardRecords) {
  return useMemo(() => {
    const types = new Set<string>()
    for (const record of records.containers) {
      const profile = containerMatchProfile(record)
      if (profile.containerType) types.add(profile.containerType)
    }
    const order = (type: string) => {
      const index = CONTAINER_TYPE_VOCABULARY.indexOf(type)
      return index === -1 ? CONTAINER_TYPE_VOCABULARY.length : index
    }
    return {
      containerTypes: [...types].sort((a, b) => order(a) - order(b) || a.localeCompare(b)),
    }
  }, [records.containers])
}

export function GroupEditor({
  editor,
  data,
  model,
  records,
  onClose,
  onSave,
  onChangeScope,
}: {
  editor: GroupEditorState
  data: GuidedSchemeData
  model: WizardModel
  records: WizardRecords
  onClose: () => void
  onSave: (group: CollectionGroup) => void
  /** "Change" beside the inherited fraction: closes the editor and returns to step 1. */
  onChangeScope: () => void
}) {
  const isEdit = editor.mode === "edit"
  const [group, setGroup] = useState<CollectionGroup>(() =>
    editor.mode === "edit" ? editor.group : newWizardGroup(),
  )
  const [reviewOpen, setReviewOpen] = useState(false)
  const vocabulary = useContainerVocabulary(records)
  const schemeDays = model.serviceDays

  const vehicle = model.vehicleById(group.vehicleId)
  // Every driver is listed; one without a readable licence, or without the
  // vehicle's class, is disabled with the reason beside the name.
  const drivers = driverOptions(records.driverProfiles, vehicle)
  const driver = model.driverById(group.driverId)
  const driverOk = !driver || !vehicle || driverHoldsLicence(driver, vehicle.licenceClass)
  // Inherited from step 1 — the scheme's waste fraction is the one source of truth.
  const fraction = data.wasteFraction
  const containerTypes = group.containerTypes ?? []

  const matches: StopMatchResult | null = useMemo(() => {
    if (!fraction || containerTypes.length === 0) return null
    return resolveStopMatches({
      rule: { fractions: [fraction], containerTypes: [...containerTypes] },
      areaId: data.planningAreaId,
      projectIds: data.projectId ? [data.projectId] : undefined,
      containers: records.containers,
    })
  }, [fraction, containerTypes, data.planningAreaId, data.projectId, records.containers])

  const count = matches ? matches.matched.length : 0
  const loadT = matches ? routeEstimateAdapter.loadTonnes(matches.matched, records.weightKg) : 0

  const valid = Boolean(
    group.name.trim() &&
      group.days.length > 0 &&
      group.vehicleId &&
      group.driverId &&
      driverOk &&
      fraction &&
      containerTypes.length > 0,
  )

  const set = <K extends keyof CollectionGroup>(key: K, value: CollectionGroup[K]) =>
    setGroup((current) => ({ ...current, [key]: value }))

  const pickVehicle = (vehicleId: string) => {
    setGroup((current) => {
      const nextVehicle = model.vehicleById(vehicleId)
      const currentDriver = model.driverById(current.driverId)
      const keepDriver =
        currentDriver && nextVehicle
          ? driverHoldsLicence(currentDriver, nextVehicle.licenceClass)
          : Boolean(currentDriver)
      return {
        ...current,
        vehicleId,
        ...(keepDriver ? {} : { driverId: undefined }),
      }
    })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden rounded-2xl bg-background p-0 sm:max-w-2xl">
        <DialogHeader className="px-6 pb-4 pt-6 text-left">
          <DialogTitle className="text-lg">
            {isEdit ? "Edit collection group" : "Add collection group"}
          </DialogTitle>
          <DialogDescription className="sr-only">Collection group settings</DialogDescription>
        </DialogHeader>
        <div className="max-h-96 space-y-5 overflow-y-auto px-6 pb-2">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field id="group-name" label="Group name" className="sm:col-span-2">
              <Input
                id="group-name"
                className="h-10 rounded-xl"
                placeholder="e.g. Residual · small bins"
                value={group.name}
                onChange={(event) => set("name", event.target.value)}
              />
            </Field>
            <div className="space-y-2 sm:col-span-2">
              <Label className="text-sm" id="group-days-label">
                Service days
              </Label>
              <ToggleGroup
                type="multiple"
                variant="outline"
                value={group.days}
                onValueChange={(values) => set("days", sortServiceDays(values as ServiceDay[]))}
                aria-labelledby="group-days-label"
                className="gap-2"
              >
                {schemeDays.map((day) => (
                  <ToggleGroupItem
                    key={day}
                    value={day}
                    aria-label={SERVICE_DAY_LABELS[day]}
                    className={cn(PILL_TOGGLE_ITEM_CLASS, "h-9")}
                  >
                    {SERVICE_DAY_SHORT_LABELS[day]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <Field id="group-vehicle" label="Vehicle">
              <Select value={group.vehicleId || undefined} onValueChange={pickVehicle}>
                <SelectTrigger id="group-vehicle" className="h-10 w-full rounded-xl">
                  <SelectValue placeholder="Select vehicle" />
                </SelectTrigger>
                <SelectContent>
                  {records.vehicleProfiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {vehicleOptionLabel(profile)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="group-driver" label="Default driver">
              <Select
                value={group.driverId || undefined}
                onValueChange={(driverId) => set("driverId", driverId)}
                disabled={!group.vehicleId}
              >
                <SelectTrigger id="group-driver" className="h-10 w-full rounded-xl">
                  <SelectValue
                    placeholder={
                      vehicle ? `Select driver (${vehicle.licenceClass} licence)` : "Select vehicle first"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {drivers.map(({ driver: profile, eligible, reason }) => (
                    <SelectItem key={profile.id} value={profile.id} disabled={!eligible}>
                      {driverOptionLabel(profile)}
                      {reason ? (
                        <span className="text-muted-foreground"> · {reason}</span>
                      ) : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="space-y-2">
              <div className="flex h-5 items-center justify-between">
                <Label className="text-sm" id="group-fraction-label">
                  Waste fraction
                </Label>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={onChangeScope}
                >
                  Change
                </Button>
              </div>
              <p
                className="flex h-10 items-center text-sm"
                aria-labelledby="group-fraction-label"
                data-testid="group-fraction"
              >
                {fraction || "—"}
              </p>
            </div>
            <div className="space-y-2">
              <Label className="text-sm" id="group-types-label">
                Container types
              </Label>
              <ToggleGroup
                type="multiple"
                variant="outline"
                value={containerTypes}
                onValueChange={(values) =>
                  set(
                    "containerTypes",
                    vocabulary.containerTypes.filter((type) => values.includes(type)),
                  )
                }
                aria-labelledby="group-types-label"
                className="flex-wrap gap-2"
              >
                {vocabulary.containerTypes.map((type) => (
                  <ToggleGroupItem
                    key={type}
                    value={type}
                    aria-label={type}
                    className={cn(PILL_TOGGLE_ITEM_CLASS, "h-9 px-3 text-xs")}
                  >
                    {containerTypeShortLabel(type)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm">
            <div className="flex items-center gap-6">
              <div>
                <div className="text-xs text-muted-foreground">Matching containers</div>
                <div className="font-medium tabular-nums">
                  {matches ? count.toLocaleString("en-GB") : "—"}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Est. load per route</div>
                <div className="font-medium tabular-nums">
                  {matches
                    ? `${loadT} t${vehicle?.capacityT != null ? ` / ${vehicle.capacityT} t` : ""}`
                    : "—"}
                </div>
              </div>
            </div>
            <Button
              variant="link"
              className="h-auto p-0"
              disabled={!matches}
              onClick={() => setReviewOpen(true)}
            >
              Review containers
            </Button>
          </div>
        </div>
        <DialogFooter className="border-t border-border px-6 py-4 sm:justify-between">
          <Button variant="outline" className="rounded-xl" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="rounded-xl"
            disabled={!valid}
            onClick={() => onSave({ ...group, fractions: fraction ? [fraction] : group.fractions })}
          >
            {isEdit ? "Save group" : "Add group"}
          </Button>
        </DialogFooter>
        {matches && (
          <ReviewContainersDialog
            open={reviewOpen}
            onOpenChange={setReviewOpen}
            matches={matches}
            groupName={group.name}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ReviewContainersDialog({
  open,
  onOpenChange,
  matches,
  groupName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  matches: StopMatchResult
  groupName: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden rounded-2xl bg-background p-0 sm:max-w-2xl">
        <DialogHeader className="px-6 pb-4 pt-6 text-left">
          <DialogTitle className="text-lg">Review containers</DialogTitle>
          <DialogDescription className="sr-only">
            Containers matched by {groupName || "this collection group"}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-96 overflow-y-auto border-t border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Container</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Fraction</TableHead>
                <TableHead className="pr-6">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {matches.matched.map((container) => (
                <TableRow key={container.id}>
                  <TableCell className="pl-6 font-medium">{container.name}</TableCell>
                  <TableCell>{container.containerType ?? "—"}</TableCell>
                  <TableCell>{container.fractions.join(" · ")}</TableCell>
                  <TableCell className="pr-6">{container.status}</TableCell>
                </TableRow>
              ))}
              {matches.excluded.map((container) => (
                <TableRow key={container.id} className="text-muted-foreground">
                  <TableCell className="pl-6">{container.name}</TableCell>
                  <TableCell colSpan={2}>{container.reason}</TableCell>
                  <TableCell className="pr-6">Excluded</TableCell>
                </TableRow>
              ))}
              {matches.matched.length === 0 && matches.excluded.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="pl-6 text-muted-foreground">
                    —
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <DialogFooter className="border-t border-border px-6 py-4">
          <Button variant="outline" className="rounded-xl" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
