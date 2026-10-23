"use client"

// Step 3 — Who collects what on which service days? Coverage chips per
// service day, the issue alert, and one row per collection group.

import { useState } from "react"
import { Check, Pencil, Plus, Trash2 } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { CollectionGroup } from "@waste/domain/route-schemes/groups"
import { containerTypeShortLabel } from "@waste/domain/route-schemes/matching"
import type { GuidedSchemeData } from "@waste/domain/route-schemes/quick-create"
import {
  SERVICE_DAY_LABELS,
  SERVICE_DAY_SHORT_LABELS,
} from "@waste/domain/route-schemes/recurrence"
import { cn } from "@/lib/utils"

import { GroupEditor, type GroupEditorState } from "./group-editor"
import { LoadMeter } from "./load-meter"
import type { WizardRecords } from "./use-wizard-records"
import type { WizardModel } from "./wizard-model"
import type { WizardStepId } from "./wizard-options"

export function StepGroups({
  data,
  update,
  model,
  records,
  go,
}: {
  data: GuidedSchemeData
  update: (patch: Partial<GuidedSchemeData>) => void
  model: WizardModel
  records: WizardRecords
  go: (step: WizardStepId) => void
}) {
  const [editor, setEditor] = useState<GroupEditorState | null>(null)
  const { serviceDays, issues, groups } = model
  const coverage = serviceDays.map((day) => ({
    day,
    count: data.groups.filter((group) => group.days.includes(day)).length,
  }))

  const save = (group: CollectionGroup) => {
    update({
      groups: data.groups.some((candidate) => candidate.id === group.id)
        ? data.groups.map((candidate) => (candidate.id === group.id ? group : candidate))
        : [...data.groups, group],
    })
    setEditor(null)
  }
  const remove = (id: string) =>
    update({ groups: data.groups.filter((group) => group.id !== id) })

  const addButton = (variant: "default" | "outline") => (
    <Button
      variant={variant}
      className="rounded-xl"
      disabled={serviceDays.length === 0}
      onClick={() => setEditor({ mode: "add" })}
    >
      <Plus /> Add collection group
    </Button>
  )

  return (
    <div className="space-y-5">
      {/* The scope every group inherits — fraction and service type — with
          its own way back to step 1. */}
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span>
          {[data.wasteFraction, data.serviceType].filter(Boolean).join(" · ") || "—"}
        </span>
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => go(1)}>
          Change
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2" aria-label="Service day coverage">
          {coverage.map(({ day, count }) => (
            <Badge
              key={day}
              variant="secondary"
              className={cn("h-7 gap-1.5 px-3", count === 0 && "bg-amber-50 text-amber-800")}
            >
              {count > 0 ? <Check className="size-3" /> : null}
              {SERVICE_DAY_SHORT_LABELS[day]} · {count}
            </Badge>
          ))}
        </div>
        {addButton("default")}
      </div>

      {model.notice !== null && (
        <Alert className="rounded-2xl">
          <AlertDescription>{model.notice}</AlertDescription>
        </Alert>
      )}

      {issues.length > 0 && (
        <Alert className="rounded-2xl border-amber-200 bg-amber-50 text-amber-800">
          <AlertDescription className="text-amber-800">
            <ul className="list-disc space-y-1 pl-5">
              {issues.map((issue) => (
                <li key={issue.text}>{issue.text}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {groups.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-2xl border border-dashed border-border">
          {addButton("outline")}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="pl-4">Collection group</TableHead>
                <TableHead>Service days</TableHead>
                <TableHead>Vehicle</TableHead>
                <TableHead>Default driver</TableHead>
                <TableHead>Containers</TableHead>
                <TableHead>Est. load per route</TableHead>
                <TableHead className="pr-3 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((summary) => {
                const { group, vehicle, driver, estimate, color, fallbackWeight } = summary
                const clash = issues.some(
                  (issue) => issue.kind === "vehicle" && issue.groupIds.includes(group.id),
                )
                return (
                  <TableRow key={group.id}>
                    <TableCell className="pl-4 font-medium">
                      <span className="inline-flex items-center gap-2">
                        <span className="size-2.5 rounded-full" style={{ background: color }} />
                        {group.name}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {serviceDays.map((day) => {
                          const on = group.days.includes(day)
                          return (
                            <span
                              key={day}
                              aria-label={`${SERVICE_DAY_LABELS[day]}${on ? "" : " off"}`}
                              className={cn(
                                "inline-flex size-7 items-center justify-center rounded-full text-xs",
                                on
                                  ? "bg-foreground text-background"
                                  : "bg-muted text-muted-foreground/60",
                              )}
                            >
                              {SERVICE_DAY_SHORT_LABELS[day][0]}
                            </span>
                          )
                        })}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className={cn(clash && "text-amber-800")}>
                        {vehicle?.callsign ?? group.vehicleId ?? "—"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {vehicle
                          ? [vehicle.type, vehicle.capacityT !== null ? `${vehicle.capacityT} t` : null]
                              .filter(Boolean)
                              .join(" · ")
                          : ""}
                      </div>
                    </TableCell>
                    <TableCell>
                      {driver ? driver.name : <span className="text-amber-800">Unassigned</span>}
                    </TableCell>
                    <TableCell>
                      <div className="tabular-nums">{summary.stops.toLocaleString("en-GB")}</div>
                      <div className="text-xs text-muted-foreground">
                        {[
                          group.fractions.join(", "),
                          (group.containerTypes ?? []).map(containerTypeShortLabel).join(", "),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </TableCell>
                    <TableCell>
                      <LoadMeter estimate={estimate} />
                      {fallbackWeight && (
                        <Badge variant="secondary" className="mt-1.5 bg-amber-50 text-amber-800">
                          Fallback weight
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="pr-3 text-right">
                      <div className="inline-flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Edit ${group.name}`}
                          onClick={() => setEditor({ mode: "edit", group })}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${group.name}`}
                          onClick={() => remove(group.id)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {editor && (
        <GroupEditor
          editor={editor}
          data={data}
          model={model}
          records={records}
          onClose={() => setEditor(null)}
          onSave={save}
          onChangeScope={() => {
            setEditor(null)
            go(1)
          }}
        />
      )}
    </div>
  )
}
