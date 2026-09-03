"use client"

// Route Scheme create flow for the Route Schemes module (spec FR-1/FR-2/FR-5/
// FR-14/FR-15, tickets #5/#6; collection groups: SPEC area L, D33–D36). "New
// route scheme" opens a chooser between Quick create (the schema-driven
// dialog, opened via onQuickCreate) and Guided Setup — a five-step wizard:
// scheme & scope (with the collection calendar and the operational
// defaults), recurrence, collection groups (who collects what on which
// days — the former Assignment and Containers steps folded into one
// hub-and-spoke step), route map, and review & create. Guided completion
// hands the collected values to onGuidedCreate, which owns record creation
// and the Validated/Draft decision.

import { useCallback, useEffect, useMemo, useState } from "react"
import { CaretLeft, CaretRight, Check, Plus, X } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
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
  CollectionGroupsEditor,
  RecordSelect,
  groupContainerCounts,
  newCollectionGroup,
} from "@/components/wastehero/collection-groups-editor"
import { Stepper } from "@/components/project-wizard/Stepper"
import { StepMode } from "@/components/project-wizard/steps/StepMode"
import type { ProjectMode } from "@/components/project-wizard/types"
import {
  SchemeRouteMap,
  useModuleRecords,
} from "@/components/wastehero/scheme-route-map"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { PLANNING_AREAS_MODULE } from "@/lib/data/planning-areas"
import { schemeFrequencyPromiseOfRecord } from "@/lib/data/service-frequencies"
import {
  calendarDayStatus,
  calendarFromRecord,
  dayStatusSkipsGeneration,
  type CollectionCalendar,
} from "@/lib/route-schemes/calendar"
import {
  formatValidity,
  formatWorkingDays,
  plural,
} from "@/lib/route-schemes/calendar-list"
import {
  SCHEME_DRAFT_CREATION_NOTICE,
  previewSchemeCreation,
} from "@/lib/route-schemes/creation"
import {
  RECURRENCE_FREQUENCY_LABELS,
  SERVICE_DAYS,
  SERVICE_DAY_SHORT_LABELS,
  formatServiceDate,
  nextServiceDates,
  recurrenceSentence,
  todayIso,
  type RecurrenceFrequency,
  type SchemeRecurrence,
  type ServiceDay,
  type WeekRotation,
} from "@/lib/route-schemes/recurrence"
import { sortServiceDays } from "@/lib/route-schemes/recurrence"
import {
  collectionGroupContainerIds,
  flattenGroupPlans,
  resolveCollectionGroupPlans,
  schemeAssignmentSources,
  schemeStopRuleSources,
  schemeValidationGroups,
  unattributedIssues,
  type CollectionGroupResolution,
} from "@/lib/route-schemes/groups"
import { stopRuleSummary, vehicleTypeOfRecord } from "@/lib/route-schemes/matching"
import {
  allocationConflictSources,
  dayPlanCountSummary,
  validateScheme,
  type SchemeDayPlan,
  type SchemeFrequencyPromise,
  type SchemeValidationResult,
} from "@/lib/route-schemes/validation"
import { schemesInPlanning } from "@/lib/route-schemes/lifecycle"
import type { GuidedSchemeData } from "@/lib/route-schemes/quick-create"
import { cn } from "@/lib/utils"

// The wizard's draft shape lives in lib/route-schemes/quick-create (issue
// #31) so Quick Create's value mapping can share it without pulling in UI
// code; re-exported here for the existing import sites.
export type { GuidedSchemeData }

const draftProjectIds = (data: GuidedSchemeData): string[] | undefined =>
  data.projectId ? [data.projectId] : undefined

/**
 * The draft's collection groups resolved per day against the live container
 * records — the same seam generation uses once the scheme is saved (manual
 * picks, rule matches, and the manual-beats-rule / first-rule-group-wins
 * tie-breaks between groups on a shared day).
 */
export function resolvedDraftGroups(
  data: GuidedSchemeData,
  containers: readonly BusinessRecord[],
): CollectionGroupResolution {
  return resolveCollectionGroupPlans({
    groups: data.groups,
    serviceDays: data.serviceDays,
    areaId: data.planningAreaId,
    projectIds: draftProjectIds(data),
    containers,
  })
}

/** Day-flattened view: every stop any group serves per service day (counts line). */
export function resolvedDraftPlans(
  data: GuidedSchemeData,
  containers: readonly BusinessRecord[],
): SchemeDayPlan[] {
  return flattenGroupPlans(resolvedDraftGroups(data, containers), data.serviceDays)
}

/**
 * FR-5 over the wizard draft plus every existing scheme's planned assignments
 * and the Vehicle Planning allocations (issue #11); the selected Collection
 * Calendar adds non-blocking warnings (Q6/Q7). Groups validate their own
 * days, assignment, and stops (D33–D35) — the containers and vehicles are
 * needed to resolve the matches and each group's vehicle type. The resolved
 * stops also feed the promised-service-frequency reconciliation (issue #21):
 * every linked container with a standing promise is compared against the
 * draft's recurrence cadence.
 */
export function validateGuidedScheme(
  data: GuidedSchemeData,
  existingSchemes: readonly BusinessRecord[],
  calendar: CollectionCalendar | null | undefined,
  allocations: readonly BusinessRecord[],
  containers: readonly BusinessRecord[],
  vehicles: readonly BusinessRecord[],
): SchemeValidationResult {
  // Soft-deleted schemes have left planning (issue #34) — the same sibling
  // filter the edit path's schemeLiveValidation applies, so create and edit
  // never disagree about who can conflict.
  const siblings = schemesInPlanning(existingSchemes)
  const resolution = resolvedDraftGroups(data, containers)
  const linkedContainerIds = new Set(collectionGroupContainerIds(resolution))
  const promises = containers
    .filter((container) => linkedContainerIds.has(container.id))
    .map((container) => schemeFrequencyPromiseOfRecord(container))
    .filter((promise): promise is SchemeFrequencyPromise => promise !== null)
  return validateScheme(
    {
      serviceDays: data.serviceDays,
      effectiveFrom: data.effectiveFrom,
      effectiveTo: data.effectiveTo,
      areaId: data.planningAreaId,
      calendar,
      frequencyReconciliation: { frequency: data.frequency, promises },
      ...schemeValidationGroups(
        data.groups,
        resolution,
        (vehicleId) =>
          vehicleTypeOfRecord(vehicles.find((vehicle) => vehicle.id === vehicleId)),
        (containerId) => containers.find((container) => container.id === containerId)?.name,
      ),
    },
    siblings.flatMap((record) => schemeAssignmentSources(record.name, record.submittedValues)),
    allocationConflictSources(allocations),
    schemeStopRuleSources(siblings),
  )
}

function draftRecurrence(data: GuidedSchemeData): SchemeRecurrence | null {
  if (data.serviceDays.length === 0 || !data.effectiveFrom) return null
  return {
    frequency: data.frequency,
    serviceDays: data.serviceDays,
    ...(data.frequency === "every-2-weeks" ? { weekRotation: data.weekRotation } : {}),
    effectiveFrom: data.effectiveFrom,
    effectiveTo: data.effectiveTo,
    startTime: data.plannedStartTime,
  }
}

interface SchemeCreateEntryProps {
  submitLabel: string
  onQuickCreate: () => void
  onGuidedCreate: (data: GuidedSchemeData) => void
}

export function SchemeCreateEntry({
  submitLabel,
  onQuickCreate,
  onGuidedCreate,
}: SchemeCreateEntryProps) {
  const [isChooserOpen, setIsChooserOpen] = useState(false)
  const [isGuidedOpen, setIsGuidedOpen] = useState(false)

  return (
    <>
      <Button size="sm" onClick={() => setIsChooserOpen(true)}>
        <Plus className="h-4 w-4" weight="bold" />
        <span className="hidden sm:inline">{submitLabel}</span>
        <span className="sm:hidden">Action</span>
      </Button>

      {isChooserOpen && (
        <SchemeModeChooserOverlay
          onClose={() => setIsChooserOpen(false)}
          onQuick={() => {
            setIsChooserOpen(false)
            onQuickCreate()
          }}
          onGuided={() => {
            setIsChooserOpen(false)
            setIsGuidedOpen(true)
          }}
        />
      )}
      {isGuidedOpen && (
        <GuidedSchemeWizardOverlay
          onClose={() => setIsGuidedOpen(false)}
          onCreate={(data) => {
            setIsGuidedOpen(false)
            onGuidedCreate(data)
          }}
        />
      )}
    </>
  )
}

function SchemeModeChooserOverlay({
  onClose,
  onQuick,
  onGuided,
}: {
  onClose: () => void
  onQuick: () => void
  onGuided: () => void
}) {
  const [mode, setMode] = useState<ProjectMode | undefined>()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-[900px] overflow-hidden rounded-[24px] bg-background shadow-2xl">
        <StepMode
          selected={mode}
          onSelect={setMode}
          onCancel={onClose}
          onClose={onClose}
          entityLabel="route scheme"
          onContinue={() => {
            if (mode === "quick") onQuick()
            if (mode === "guided") onGuided()
          }}
        />
      </div>
    </div>
  )
}

const GUIDED_STEPS = [
  "Scheme & scope",
  "Recurrence",
  "Collection groups",
  "Route map",
  "Review & create",
]

// Named step numbers (issue #32): the render chain, the footer gates, the
// titles, and the review sections' Edit targets all address steps through
// these — renumbering the wizard is one edit here, not a hunt for literals.
const GUIDED_STEP = {
  scope: 1,
  recurrence: 2,
  groups: 3,
  map: 4,
  review: 5,
} as const

const GUIDED_STEP_TITLES: Record<number, string> = {
  [GUIDED_STEP.scope]: "Which scope does this scheme plan for?",
  [GUIDED_STEP.recurrence]: "When does this scheme collect?",
  [GUIDED_STEP.groups]: "Who collects what on which service days?",
  [GUIDED_STEP.map]: "How do the generated routes look?",
  [GUIDED_STEP.review]: "Review route scheme setup",
}

/**
 * The wizard's selected Collection Calendar — one lookup shared by the
 * scope step, the recurrence preview, and the review, so every step
 * describes the same calendar.
 */
function useSelectedCalendar(calendarId: string | undefined) {
  const calendars = useModuleRecords("plan", "calendars")
  const record = calendars.find((candidate) => candidate.id === calendarId)
  return { calendars, record, calendar: calendarFromRecord(record) }
}

function GuidedSchemeWizardOverlay({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (data: GuidedSchemeData) => void
}) {
  const [step, setStep] = useState(1)
  const [maxStepReached, setMaxStepReached] = useState(1)
  const [data, setData] = useState<GuidedSchemeData>(() => ({
    schemeName: "",
    frequency: "weekly",
    weekRotation: "odd",
    serviceDays: [],
    effectiveFrom: todayIso(),
    effectiveTo: "",
    plannedStartTime: "06:30",
    // Collection groups (D33) are defined in their own step once the service
    // days are known; the step seeds one group covering every day.
    groups: [],
  }))

  const updateData = useCallback((updates: Partial<GuidedSchemeData>) => {
    setData((previous) => ({ ...previous, ...updates }))
  }, [])

  const goToStep = (target: number) => {
    setStep(target)
    setMaxStepReached((reached) => Math.max(reached, target))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      {/* Wider than the mode chooser on purpose: the Collection groups step
          lays out a three-column group editor plus a container list. */}
      <div className="flex w-full max-w-[1200px] overflow-hidden rounded-[24px] bg-background shadow-2xl">
        <div className="hidden w-64 border-r border-border bg-background px-6 py-7 md:flex md:flex-col md:gap-7">
          <p className="text-sm font-semibold text-foreground">New route scheme</p>
          <Stepper
            currentStep={step - 1}
            steps={GUIDED_STEPS}
            onStepClick={(target) => setStep(target + 1)}
            maxStepReached={maxStepReached - 1}
          />
        </div>

        <div className="flex max-h-[90vh] min-h-[600px] flex-1 flex-col">
          <div className="flex items-start justify-between px-8 pb-4 pt-6">
            <h2 className="pr-6 text-lg font-semibold tracking-tight">
              {GUIDED_STEP_TITLES[step]}
            </h2>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto px-8 pb-8 pt-0">
            {step === GUIDED_STEP.scope && (
              <StepSchemeScope data={data} updateData={updateData} />
            )}
            {step === GUIDED_STEP.recurrence && (
              <StepRecurrence data={data} updateData={updateData} />
            )}
            {step === GUIDED_STEP.groups && (
              <StepCollectionGroups data={data} updateData={updateData} />
            )}
            {step === GUIDED_STEP.map && <StepRouteMap data={data} />}
            {step === GUIDED_STEP.review && (
              <StepSchemeReview data={data} onEditStep={goToStep} />
            )}
          </div>

          <div className="flex items-center justify-between bg-background p-6">
            <Button
              variant="outline"
              onClick={() =>
                step === GUIDED_STEP.scope ? onClose() : setStep(step - 1)
              }
            >
              <CaretLeft className="h-4 w-4" />
              {step === GUIDED_STEP.scope ? "Cancel" : "Back"}
            </Button>
            {step === GUIDED_STEP.review ? (
              <Button
                disabled={!data.schemeName.trim()}
                onClick={() => onCreate(data)}
              >
                Create route scheme
              </Button>
            ) : (
              <Button onClick={() => goToStep(step + 1)}>
                Next
                <CaretRight className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

interface GuidedStepProps {
  data: GuidedSchemeData
  updateData: (updates: Partial<GuidedSchemeData>) => void
}

// Step 1 — Scheme & scope: name, scope, and the Collection Calendar. The
// calendar's read-only context (working days, holidays, validity) rides
// along as the select's hint — the selection feeds the recurrence step's
// next-dates preview and generation's holiday and working-day filtering.

function StepSchemeScope({ data, updateData }: GuidedStepProps) {
  const projects = useModuleRecords("configure", "organization")
  const areas = useModuleRecords(PLANNING_AREAS_MODULE.workspaceId, PLANNING_AREAS_MODULE.moduleId)
  const depots = useModuleRecords("resources", "depots")
  const selectedCalendar = useSelectedCalendar(data.calendarId)

  return (
    <div className="max-w-2xl space-y-6">
      <p className="text-sm text-muted-foreground">
        Name the scheme and pin the operating scope its routes are generated for.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Route scheme name</Label>
          <Input
            value={data.schemeName}
            onChange={(event) => updateData({ schemeName: event.target.value })}
            placeholder="e.g. Central weekly plan"
          />
        </div>
        <RecordSelect
          label="Project"
          placeholder="Select project"
          records={projects}
          value={data.projectId}
          onChange={(projectId) => updateData({ projectId })}
        />
        <RecordSelect
          label="Operational planning area"
          placeholder="Select planning area"
          records={areas}
          value={data.planningAreaId}
          onChange={(planningAreaId) => updateData({ planningAreaId })}
          hint="One planning area per scheme — every collection group matches its stops inside it."
        />
        <RecordSelect
          label="Collection calendar"
          placeholder="Select collection calendar"
          records={selectedCalendar.calendars}
          value={data.calendarId}
          onChange={(calendarId) => updateData({ calendarId })}
          hint={calendarHint(selectedCalendar.record, selectedCalendar.calendar)}
        />
      </div>
      <div className="space-y-4 border-t border-border/60 pt-4">
        <p className="text-xs font-medium text-muted-foreground">
          Operational defaults (optional)
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <RecordSelect
            label="Departure depot"
            placeholder="Select depot"
            records={depots}
            value={data.depotId}
            onChange={(depotId) => updateData({ depotId })}
          />
          <RecordSelect
            label="Unloading station"
            placeholder="Select unloading station"
            records={depots}
            value={data.unloadingStationId}
            onChange={(unloadingStationId) => updateData({ unloadingStationId })}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * What the selected calendar will do to the service dates, in one line —
 * the context the former dedicated calendar step showed as a card.
 */
function calendarHint(
  record: BusinessRecord | undefined,
  calendar: CollectionCalendar | null,
): string {
  if (!record) {
    return "Without a calendar the scheme generates on every recurrence date — no holiday or working-day filtering applies."
  }
  if (!calendar) {
    return "This calendar carries no structured working days, holidays, or validity period — it constrains nothing during generation."
  }
  return [
    record.status,
    `Working days ${formatWorkingDays(calendar.workingDays)}`,
    holidaySummary(calendar),
    `Valid ${formatValidity(calendar.validFrom, calendar.validTo)}`,
  ]
    .filter(Boolean)
    .join(" · ")
}

/** "11 holidays" / "No holidays recorded" — one phrase for the hint and the review. */
function holidaySummary(calendar: CollectionCalendar): string {
  return calendar.holidayDates.length > 0
    ? plural(calendar.holidayDates.length, "holiday")
    : "No holidays recorded"
}

// Step 2 — Recurrence

function StepRecurrence({ data, updateData }: GuidedStepProps) {
  const recurrence = draftRecurrence(data)
  const { calendar } = useSelectedCalendar(data.calendarId)
  const previewDates = useMemo(() => {
    if (!recurrence) return []
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const from = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`
    return nextServiceDates(recurrence, { from, count: 8 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    data.frequency,
    data.weekRotation,
    data.serviceDays,
    data.effectiveFrom,
    data.effectiveTo,
  ])
  // The selected Collection Calendar participates directly in the preview
  // (issue #32): holidays and non-working days are the dates generation will
  // skip (dayStatusSkipsGeneration — the engine's own gate), so the preview
  // marks them the same way instead of promising routes.
  const previewEntries = previewDates.map((date) => {
    const dayStatus = calendarDayStatus(calendar, date)
    return { date, dayStatus, skipped: dayStatusSkipsGeneration(dayStatus) }
  })
  const skippedCount = previewEntries.filter((entry) => entry.skipped).length

  const toggleDay = (day: ServiceDay) => {
    updateData({
      serviceDays: data.serviceDays.includes(day)
        ? data.serviceDays.filter((candidate) => candidate !== day)
        : [...data.serviceDays, day],
    })
  }

  return (
    <div className="max-w-2xl space-y-6">
      <p className="text-sm text-muted-foreground">
        Set the effective window and cadence — one route is generated per service
        day per occurrence.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Effective from</Label>
          <Input
            type="date"
            value={data.effectiveFrom}
            onChange={(event) => updateData({ effectiveFrom: event.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label>Effective to (optional)</Label>
          <Input
            type="date"
            value={data.effectiveTo}
            min={data.effectiveFrom || undefined}
            onChange={(event) => updateData({ effectiveTo: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Leave empty to run ongoing until the scheme is ended.
          </p>
        </div>
        <div className="space-y-2">
          <Label>Collection frequency</Label>
          <Select
            value={data.frequency}
            onValueChange={(frequency) =>
              updateData({ frequency: frequency as RecurrenceFrequency })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(RECURRENCE_FREQUENCY_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {data.frequency === "every-2-weeks" && (
          <div className="space-y-2">
            <Label>Week rotation</Label>
            <Select
              value={data.weekRotation}
              onValueChange={(weekRotation) =>
                updateData({ weekRotation: weekRotation as WeekRotation })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="odd">Odd ISO weeks</SelectItem>
                <SelectItem value="even">Even ISO weeks</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="space-y-2">
          <Label>Planned start time</Label>
          <Input
            type="time"
            value={data.plannedStartTime}
            onChange={(event) => updateData({ plannedStartTime: event.target.value })}
          />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label>Service days</Label>
          <div className="flex flex-wrap gap-2">
            {SERVICE_DAYS.map((day) => {
              const isOn = data.serviceDays.includes(day)
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => toggleDay(day)}
                  className={cn(
                    "rounded-full border px-4 py-2 text-sm font-medium transition-colors",
                    isOn
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:border-primary/50",
                  )}
                >
                  {SERVICE_DAY_SHORT_LABELS[day]}
                </button>
              )
            })}
          </div>
        </div>
      </div>
      <div className="rounded-lg border border-border/70 bg-muted/30 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Next dates
        </p>
        {recurrence ? (
          <>
            <p className="mt-1 text-sm font-medium">{recurrenceSentence(recurrence)}</p>
            {previewEntries.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {previewEntries.map(({ date, dayStatus, skipped }) => (
                  <span
                    key={date}
                    className={cn(
                      "rounded-md border px-2 py-1 text-xs font-medium",
                      skipped
                        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 line-through decoration-amber-700/60 dark:text-amber-400 dark:decoration-amber-400/60"
                        : "border-border/60 bg-background",
                    )}
                  >
                    {formatServiceDate(date)}
                    {skipped && (
                      // inline-block: an atomic inline is the only way to
                      // keep the annotation out of the chip's line-through.
                      <span className="ml-1 inline-block">
                        · {dayStatus === "holiday" ? "holiday" : "non-working"}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                No upcoming service dates fall inside the effective window.
              </p>
            )}
            {calendar && skippedCount > 0 && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                {plural(skippedCount, "struck-through date")}{" "}
                {skippedCount === 1 ? "is" : "are"} skipped by {calendar.name}{" "}
                (holiday or non-working day) — no routes generate there.
              </p>
            )}
          </>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            Pick at least one service day and the effective-from date to preview
            the upcoming service dates.
          </p>
        )}
      </div>
    </div>
  )
}

// Step 3 — Collection groups (D33): the hub-and-spoke editor over the
// draft's groups, with the live FR-5 outcome so group-level issues show on
// the rows as the planner works. Nothing gates Next — a scheme can always be
// saved as Draft with its issues named (D34).

function StepCollectionGroups({ data, updateData }: GuidedStepProps) {
  const existingSchemes = useModuleRecords("route-studio", "schemes")
  const allocations = useModuleRecords("fleet", "vehicle-planning")
  const containers = useModuleRecords("resources", "containers")
  const vehicles = useModuleRecords("fleet", "vehicles")
  const { calendar } = useSelectedCalendar(data.calendarId)
  const days = sortServiceDays(data.serviceDays)
  // Once the planner removes every group on purpose, the step must not
  // silently put one back (the hub's empty state explains what to do).
  const [cleared, setCleared] = useState(false)

  // The simple case stays simple: the first visit seeds one group covering
  // every service day, so a single-assignment scheme is one group's fields.
  useEffect(() => {
    if (!cleared && data.groups.length === 0 && days.length > 0) {
      updateData({
        groups: [
          {
            ...newCollectionGroup([], days),
            name: data.schemeName.trim() || "Collection",
          },
        ],
      })
    }
  }, [cleared, data.groups.length, data.schemeName, days, updateData])

  const validation = validateGuidedScheme(
    data,
    existingSchemes,
    calendar,
    allocations,
    containers,
    vehicles,
  )
  // Issues the group rows already show name a group; the rest (coverage,
  // single-group wording, dates) show once below the hub.
  const schemeLevelIssues = unattributedIssues(data.groups, validation.issues)

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Each collection group runs on some of the scheme&apos;s service days with
        its own vehicle, default driver, and containers — one generated route
        per group per day. Every service day needs at least one group; a
        vehicle, driver, or container is never on two groups the same day.
      </p>
      <CollectionGroupsEditor
        groups={data.groups}
        onChange={(groups) => {
          if (groups.length === 0) setCleared(true)
          updateData({ groups })
        }}
        serviceDays={days}
        planningAreaId={data.planningAreaId}
        projectId={data.projectId}
        issues={validation.issues}
      />
      {schemeLevelIssues.length > 0 && (
        <ul className="list-disc space-y-1 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 pl-9 text-xs text-amber-700 dark:text-amber-400">
          {schemeLevelIssues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Step 4 — Route map (FR-15): one colored route line + pins per generated
// route — one per collection group per service day.

function StepRouteMap({ data }: { data: GuidedSchemeData }) {
  const containers = useModuleRecords("resources", "containers")
  const resolution = resolvedDraftGroups(data, containers)
  const nameOf = new Map(data.groups.map((group) => [group.id, group.name]))
  const plans = resolution.plans.map((plan) => ({
    day: plan.day,
    containerIds: plan.containerIds,
    ...(data.groups.length > 1 ? { label: nameOf.get(plan.groupId) ?? plan.groupId } : {}),
  }))

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Each collection group generates its own route on every day it runs —
        rule groups from the containers they currently match, manual groups in
        picked order. Filter a day to isolate its lines.
      </p>
      <SchemeRouteMap plans={plans} containers={containers} />
    </div>
  )
}

// Step 5 — Review & create

function StepSchemeReview({
  data,
  onEditStep,
}: {
  data: GuidedSchemeData
  onEditStep: (step: number) => void
}) {
  const projects = useModuleRecords("configure", "organization")
  const areas = useModuleRecords(PLANNING_AREAS_MODULE.workspaceId, PLANNING_AREAS_MODULE.moduleId)
  const serviceProviders = useModuleRecords("service-providers", "service-providers")
  const vehicles = useModuleRecords("fleet", "vehicles")
  const drivers = useModuleRecords("fleet", "drivers")
  const depots = useModuleRecords("resources", "depots")
  const existingSchemes = useModuleRecords("route-studio", "schemes")
  const allocations = useModuleRecords("fleet", "vehicle-planning")
  const containers = useModuleRecords("resources", "containers")

  const { calendars, calendar } = useSelectedCalendar(data.calendarId)
  const validation = validateGuidedScheme(
    data,
    existingSchemes,
    calendar,
    allocations,
    containers,
    vehicles,
  )
  const recurrence = draftRecurrence(data)
  const resolution = resolvedDraftGroups(data, containers)
  const plans = resolvedDraftPlans(data, containers)

  const nameOf = (records: BusinessRecord[], id?: string) =>
    records.find((record) => record.id === id)?.name ?? "Not specified"

  // The consequence of creation (issue #28, D27): a valid scheme immediately
  // generates its initial window, so the review step previews those dates and
  // an estimated stop count through the same engine — labeled an estimate
  // because rule matches re-resolve at generation time.
  const creationPreview =
    validation.status === "Validated"
      ? previewSchemeCreation({
          today: todayIso(),
          frequency: data.frequency,
          ...(data.frequency === "every-2-weeks"
            ? { weekRotation: data.weekRotation }
            : {}),
          serviceDays: data.serviceDays,
          effectiveFrom: data.effectiveFrom,
          effectiveTo: data.effectiveTo,
          groupPlans: resolution.plans,
          calendar,
        })
      : null

  const sections: {
    title: string
    step: number
    rows: { label: string; value: string }[]
  }[] = [
    {
      title: "Scheme & scope",
      step: GUIDED_STEP.scope,
      rows: [
        { label: "Name", value: data.schemeName.trim() || "Not specified" },
        { label: "Project", value: nameOf(projects, data.projectId) },
        { label: "Planning area", value: nameOf(areas, data.planningAreaId) },
        { label: "Collection calendar", value: nameOf(calendars, data.calendarId) },
        ...(calendar
          ? [
              { label: "Working days", value: formatWorkingDays(calendar.workingDays) },
              { label: "Holidays", value: holidaySummary(calendar) },
            ]
          : []),
        { label: "Departure depot", value: nameOf(depots, data.depotId) },
        {
          label: "Unloading station",
          value: nameOf(depots, data.unloadingStationId),
        },
      ],
    },
    {
      title: "Recurrence",
      step: GUIDED_STEP.recurrence,
      rows: [
        {
          label: "Cadence",
          value: recurrence ? recurrenceSentence(recurrence) : "Not specified",
        },
        {
          label: "Effective window",
          value: data.effectiveFrom
            ? `${data.effectiveFrom} → ${data.effectiveTo || "ongoing"}`
            : "Not specified",
        },
        { label: "Planned start", value: data.plannedStartTime || "Not specified" },
      ],
    },
    {
      title: `Collection groups (${data.groups.length})`,
      step: GUIDED_STEP.groups,
      rows: [
        ...data.groups.flatMap((group) => [
          {
            label: group.name,
            value: `${group.days.map((day) => SERVICE_DAY_SHORT_LABELS[day]).join(", ") || "No days"} · ${
              group.serviceProviderId
                ? nameOf(serviceProviders, group.serviceProviderId)
                : "In-house"
            } · ${nameOf(vehicles, group.vehicleId)} · ${nameOf(drivers, group.driverId)}`,
          },
          {
            label: `${group.name} · containers`,
            value:
              group.stopSource === "rule"
                ? `Matched by rule — ${stopRuleSummary({
                    fractions: group.fractions,
                    ...(group.ruleVehicleType ? { vehicleType: group.ruleVehicleType } : {}),
                  })} · ${groupContainerCounts(group, resolution)}`
                : `Picked manually · ${groupContainerCounts(group, resolution)}`,
          },
        ]),
        { label: "Stops per day", value: dayPlanCountSummary(plans) },
      ],
    },
  ]

  return (
    <div className="space-y-4">
      {sections.map((section) => (
        <div key={section.title} className="rounded-2xl border border-border/60 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground">{section.title}</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onEditStep(section.step)}
            >
              Edit
            </Button>
          </div>
          <dl className="space-y-2">
            {section.rows.map((row) => (
              <div key={row.label} className="flex items-start justify-between gap-6">
                <dt className="text-sm text-muted-foreground">{row.label}</dt>
                <dd className="text-right text-sm font-medium text-foreground">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}

      {validation.status === "Validated" ? (
        <div className="flex items-start gap-3 rounded-2xl border border-green-600/30 bg-green-500/10 p-4">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-700 dark:text-green-400" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-green-700 dark:text-green-400">
              All checks passed — ready to schedule
            </p>
            <p className="text-xs text-green-700/80 dark:text-green-400/80">
              {creationPreview && creationPreview.routeDates.length > 0 ? (
                <>
                  Creating this scheme generates {creationPreview.routeCount} route
                  {creationPreview.routeCount === 1 ? "" : "s"} for{" "}
                  {creationPreview.routeDates
                    .map((date) => formatServiceDate(date))
                    .join(" · ")}
                  , resolves their stops (~{creationPreview.estimatedStops} stop
                  {creationPreview.estimatedStops === 1 ? "" : "s"} — an
                  estimate), and turns on Plan Ahead.
                </>
              ) : (
                <>
                  Creating this scheme turns on Plan Ahead
                  {creationPreview
                    ? ` — no service dates fall in the initial window (${formatServiceDate(
                        creationPreview.window.from,
                      )} → ${formatServiceDate(creationPreview.window.to)}), so future routes generate automatically`
                    : ""}
                  .
                </>
              )}
            </p>
            {creationPreview && creationPreview.calendarSkipped > 0 && (
              <p className="text-xs text-green-700/80 dark:text-green-400/80">
                {creationPreview.calendarSkipped} date
                {creationPreview.calendarSkipped === 1 ? " is" : "s are"}{" "}
                skipped by the Collection Calendar (holiday or non-working
                day).
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-1.5 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
          <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
            {SCHEME_DRAFT_CREATION_NOTICE}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-400">
            {validation.issues.map((issue, index) => (
              <li key={`${index}-${issue}`}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      {validation.warnings.length > 0 && (
        <div className="space-y-1.5 rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
            Warnings — the scheme can still be created
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-400">
            {validation.warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
