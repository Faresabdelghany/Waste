"use client"

// Route Scheme create flow for the Route Schemes module (spec FR-1/FR-2/FR-5/
// FR-14/FR-15, tickets #5/#6). "New route scheme" opens a chooser between
// Quick create (the schema-driven dialog, opened via onQuickCreate) and Guided
// Setup — a seven-step wizard (issue #32): scheme & scope, collection
// calendar, recurrence, assignment, per-day container plans, route map, and
// review & create. Guided completion hands the collected values to
// onGuidedCreate, which owns record creation and the Validated/Draft decision.

import { useEffect, useMemo, useState } from "react"
import {
  CaretLeft,
  CaretRight,
  Check,
  MagnifyingGlass,
  Plus,
  X,
} from "@phosphor-icons/react/dist/ssr"

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
import { Stepper } from "@/components/project-wizard/Stepper"
import { StepMode } from "@/components/project-wizard/steps/StepMode"
import type { ProjectMode } from "@/components/project-wizard/types"
import {
  SchemeRouteMap,
  useModuleRecords,
} from "@/components/wastehero/scheme-route-map"
import type { BusinessRecord } from "@/lib/data/business-modules"
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
  EMPTY_STOP_MATCH_RULE,
  STOP_MATCH_VEHICLE_TYPES,
  effectiveDayRules,
  resolveStopMatches,
  schemeStopRuleSources,
  stopRuleSummary,
  vehicleTypeOfRecord,
  type SchemeMatchPlans,
  type StopMatchRule,
} from "@/lib/route-schemes/matching"
import {
  allocationConflictSources,
  dayPlanCountSummary,
  effectiveDayPlans,
  schemeDefaultsFromValues,
  validateScheme,
  type SchemeDayPlan,
  type SchemeDayPlans,
  type SchemeFrequencyPromise,
  type SchemeValidationResult,
} from "@/lib/route-schemes/validation"
import { schemesInPlanning } from "@/lib/route-schemes/lifecycle"
import type { GuidedSchemeData } from "@/lib/route-schemes/quick-create"
import { cn } from "@/lib/utils"

// The wizard's draft shape lives in lib/route-schemes/quick-create (issue
// #31) so Quick Create's value mapping and the harness share it without
// pulling in UI code; re-exported here for the existing import sites.
export type { GuidedSchemeData }

export function schemeDayPlans(data: GuidedSchemeData): SchemeDayPlans {
  return {
    // The per-day toggle is only offered for multi-day schemes, so with fewer
    // than two service days the picker edits the shared list even while a
    // stale per-day choice lingers in the draft — plans must read that same
    // shared list or validation would judge a list the picker never showed.
    sameAllDays: data.sameAllDays || data.serviceDays.length < 2,
    sharedContainerIds: data.sharedContainerIds,
    containersByDay: data.containersByDay,
  }
}

/** The rule-mode counterpart of schemeDayPlans (same sameAllDays forcing). */
export function schemeMatchPlans(data: GuidedSchemeData): SchemeMatchPlans {
  return {
    sameAllDays: data.sameAllDays || data.serviceDays.length < 2,
    sharedRule: data.matchRule,
    rulesByDay: data.matchRulesByDay,
  }
}

const draftProjectIds = (data: GuidedSchemeData): string[] | undefined =>
  data.projectId ? [data.projectId] : undefined

/**
 * The per-day stop lists the draft currently resolves to: the picked lists in
 * manual mode, the rule matches (against the live container records) in rule
 * mode — the same seam generation uses once the scheme is saved.
 */
export function resolvedDraftPlans(
  data: GuidedSchemeData,
  containers: readonly BusinessRecord[],
): SchemeDayPlan[] {
  if (data.stopSelection === "manual") {
    return effectiveDayPlans(data.serviceDays, schemeDayPlans(data))
  }
  return effectiveDayRules(data.serviceDays, schemeMatchPlans(data)).map(
    ({ day, rule }) => ({
      day,
      containerIds: resolveStopMatches({
        rule,
        areaId: data.planningAreaId,
        projectIds: draftProjectIds(data),
        containers,
      }).matched.map((profile) => profile.id),
    }),
  )
}

/**
 * FR-5 over the wizard draft plus every existing scheme's defaults and the
 * Vehicle Planning allocations (issue #11); the selected Collection Calendar
 * adds non-blocking warnings (Q6/Q7). Rule-mode drafts (issue #19) validate
 * their stop-matching rules instead of picked lists — the containers and
 * vehicles are needed to resolve the matches and the default vehicle's type.
 * The resolved per-day stops also feed the promised-service-frequency
 * reconciliation (issue #21): every linked container with a standing promise
 * is compared against the draft's recurrence cadence.
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
  const matchPlans = schemeMatchPlans(data)
  // In rule mode these are the rule matches, day-aligned with
  // effectiveDayRules (resolvedDraftPlans maps that same list).
  const dayPlans = resolvedDraftPlans(data, containers)
  const linkedContainerIds = new Set(dayPlans.flatMap((plan) => plan.containerIds))
  const promises = containers
    .filter((container) => linkedContainerIds.has(container.id))
    .map((container) => schemeFrequencyPromiseOfRecord(container))
    .filter((promise): promise is SchemeFrequencyPromise => promise !== null)
  return validateScheme(
    {
      serviceDays: data.serviceDays,
      effectiveFrom: data.effectiveFrom,
      effectiveTo: data.effectiveTo,
      plans: schemeDayPlans(data),
      plannedVehicleId: data.plannedVehicleId,
      plannedDriverId: data.plannedDriverId,
      calendar,
      frequencyReconciliation: { frequency: data.frequency, promises },
      ...(data.stopSelection === "rule"
        ? {
            stopMatching: {
              areaId: data.planningAreaId,
              sameAllDays: matchPlans.sameAllDays,
              dayRules: effectiveDayRules(data.serviceDays, matchPlans).map(
                ({ day, rule }, index) => ({
                  day,
                  fractions: rule.fractions,
                  vehicleType: rule.vehicleType,
                  matchedCount: dayPlans[index]?.containerIds.length ?? 0,
                }),
              ),
              plannedVehicleType: vehicleTypeOfRecord(
                vehicles.find((vehicle) => vehicle.id === data.plannedVehicleId),
              ),
            },
          }
        : {}),
    },
    siblings
      .map((record) => schemeDefaultsFromValues(record.name, record.submittedValues))
      .filter((source): source is NonNullable<typeof source> => source !== null),
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
  "Collection Calendar",
  "Recurrence",
  "Assignment",
  "Containers",
  "Route map",
  "Review & create",
]

// Named step numbers (issue #32): the render chain, the footer gates, the
// titles, and the review sections' Edit targets all address steps through
// these — renumbering the wizard is one edit here, not a hunt for literals.
const GUIDED_STEP = {
  scope: 1,
  calendar: 2,
  recurrence: 3,
  assignment: 4,
  containers: 5,
  map: 6,
  review: 7,
} as const

const GUIDED_STEP_TITLES: Record<number, string> = {
  [GUIDED_STEP.scope]: "Which scope does this scheme plan for?",
  [GUIDED_STEP.calendar]: "Which Collection Calendar governs the service dates?",
  [GUIDED_STEP.recurrence]: "When does this scheme collect?",
  [GUIDED_STEP.assignment]: "Which defaults run the generated routes?",
  [GUIDED_STEP.containers]: "Which containers does each service day serve?",
  [GUIDED_STEP.map]: "How do the generated routes look?",
  [GUIDED_STEP.review]: "Review route scheme setup",
}

/**
 * The wizard's selected Collection Calendar — one lookup shared by the
 * calendar step, the recurrence preview, and the review, so every step
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
    // Declarative stop matching is the default (issue #19); picking
    // containers by hand stays available as the small-scale mode.
    stopSelection: "rule",
    sameAllDays: true,
    sharedContainerIds: [],
    containersByDay: {},
    matchRule: EMPTY_STOP_MATCH_RULE,
    matchRulesByDay: {},
  }))

  const updateData = (updates: Partial<GuidedSchemeData>) => {
    setData((previous) => ({ ...previous, ...updates }))
  }

  const goToStep = (target: number) => {
    setStep(target)
    setMaxStepReached((reached) => Math.max(reached, target))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-[900px] overflow-hidden rounded-[24px] bg-background shadow-2xl">
        <div className="hidden w-64 border-r border-border bg-background px-6 py-7 md:flex md:flex-col md:gap-7">
          <p className="text-sm font-semibold text-foreground">New route scheme</p>
          <Stepper
            currentStep={step - 1}
            steps={GUIDED_STEPS}
            onStepClick={(target) => setStep(target + 1)}
            maxStepReached={maxStepReached - 1}
          />
        </div>

        <div className="flex max-h-[85vh] min-h-[540px] flex-1 flex-col">
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
            {step === GUIDED_STEP.calendar && (
              <StepCollectionCalendar data={data} updateData={updateData} />
            )}
            {step === GUIDED_STEP.recurrence && (
              <StepRecurrence data={data} updateData={updateData} />
            )}
            {step === GUIDED_STEP.assignment && (
              <StepAssignment data={data} updateData={updateData} />
            )}
            {step === GUIDED_STEP.containers && (
              <StepDayContainers data={data} updateData={updateData} />
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

function RecordSelect({
  label,
  placeholder,
  records,
  value,
  onChange,
  hint,
}: {
  label: string
  placeholder: string
  records: BusinessRecord[]
  value?: string
  onChange: (value: string) => void
  hint?: string
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {records.map((record) => (
            <SelectItem key={record.id} value={record.id}>
              {record.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

// Step 1 — Scheme & scope

function StepSchemeScope({ data, updateData }: GuidedStepProps) {
  const projects = useModuleRecords("configure", "organization")
  const areas = useModuleRecords("plan", "areas")

  return (
    <div className="max-w-md space-y-6">
      <p className="text-sm text-muted-foreground">
        Name the scheme and pin the operating scope its routes are generated for.
      </p>
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
      />
    </div>
  )
}

// Step 2 — Collection Calendar (issue #32): the calendar select plus the
// selected calendar's read-only operational context. The selection feeds the
// recurrence step's next-dates preview and, later, generation's holiday and
// working-day filtering — this step only chooses and explains, it never edits
// the calendar.

function StepCollectionCalendar({ data, updateData }: GuidedStepProps) {
  const { calendars, record, calendar } = useSelectedCalendar(data.calendarId)

  return (
    <div className="max-w-md space-y-6">
      <p className="text-sm text-muted-foreground">
        The Collection Calendar decides which planned dates are operationally
        valid — holidays and non-working days generate no routes.
      </p>
      <RecordSelect
        label="Collection calendar"
        placeholder="Select collection calendar"
        records={calendars}
        value={data.calendarId}
        onChange={(calendarId) => updateData({ calendarId })}
      />
      {record && (
        <div className="space-y-2 rounded-2xl border border-border/60 p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground">{record.name}</p>
            <span className="rounded-full border border-border/60 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
              {record.status}
            </span>
          </div>
          {calendar ? (
            <dl className="space-y-2 pt-1">
              {(
                [
                  ["Working days", formatWorkingDays(calendar.workingDays)],
                  [
                    "Holidays",
                    calendar.holidayDates.length > 0
                      ? `${plural(calendar.holidayDates.length, "date")} — ${calendar.holidayDates
                          .slice(0, 4)
                          .map((date) => formatServiceDate(date))
                          .join(" · ")}${calendar.holidayDates.length > 4 ? " · …" : ""}`
                      : "None recorded",
                  ],
                  ["Validity", formatValidity(calendar.validFrom, calendar.validTo)],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-6">
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                  <dd className="text-right text-sm font-medium text-foreground">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">
              This calendar record carries no structured working days, holidays,
              or validity period — it constrains nothing during generation.
            </p>
          )}
        </div>
      )}
      {!record && (
        <p className="text-xs text-muted-foreground">
          Without a calendar the scheme generates on every recurrence date — no
          holiday or working-day filtering applies.
        </p>
      )}
    </div>
  )
}

// Step 3 — Recurrence

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
    <div className="max-w-xl space-y-6">
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
      <div className="space-y-2">
        <Label>Planned start time</Label>
        <Input
          type="time"
          value={data.plannedStartTime}
          onChange={(event) => updateData({ plannedStartTime: event.target.value })}
          className="w-32"
        />
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

// Step 4 — Assignment

function StepAssignment({ data, updateData }: GuidedStepProps) {
  const serviceProviders = useModuleRecords("service-providers", "service-providers")
  const vehicles = useModuleRecords("fleet", "vehicles")
  const drivers = useModuleRecords("fleet", "drivers")
  const depots = useModuleRecords("resources", "depots")

  return (
    <div className="max-w-md space-y-6">
      <p className="text-sm text-muted-foreground">
        Defaults only — every generated route can be reassigned individually.
      </p>
      <RecordSelect
        label="Responsible service provider (optional)"
        placeholder="Keep in-house"
        records={serviceProviders}
        value={data.serviceProviderId}
        onChange={(serviceProviderId) => updateData({ serviceProviderId })}
      />
      <RecordSelect
        label="Default vehicle"
        placeholder="Select vehicle"
        records={vehicles}
        value={data.plannedVehicleId}
        onChange={(plannedVehicleId) => updateData({ plannedVehicleId })}
      />
      <RecordSelect
        label="Default driver"
        placeholder="Select driver"
        records={drivers}
        value={data.plannedDriverId}
        onChange={(plannedDriverId) => updateData({ plannedDriverId })}
      />
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
  )
}

// Step 5 — Stops: declarative matching rule (issue #19) or manually picked
// per-day service plans (FR-14). The rule is the source of truth in rule
// mode — the matched list below it is a live preview, not a stored pick.

function StepDayContainers({ data, updateData }: GuidedStepProps) {
  const containers = useModuleRecords("resources", "containers")
  const projects = useModuleRecords("configure", "organization")
  const areas = useModuleRecords("plan", "areas")
  const days = sortServiceDays(data.serviceDays)
  const isMultiDay = days.length > 1
  const isRule = data.stopSelection === "rule"
  const isPerDay = isMultiDay && !data.sameAllDays
  const [activeDay, setActiveDay] = useState<ServiceDay>(days[0] ?? "monday")

  useEffect(() => {
    if (days.length > 0 && !days.includes(activeDay)) setActiveDay(days[0])
  }, [days, activeDay])

  const pickedIds = isPerDay
    ? (data.containersByDay[activeDay] ?? [])
    : data.sharedContainerIds
  const setPickedIds = (ids: string[]) => {
    if (isPerDay) {
      updateData({ containersByDay: { ...data.containersByDay, [activeDay]: ids } })
    } else {
      updateData({ sharedContainerIds: ids })
    }
  }

  const activeRule = isPerDay
    ? (data.matchRulesByDay[activeDay] ?? EMPTY_STOP_MATCH_RULE)
    : data.matchRule
  const setActiveRule = (rule: StopMatchRule) => {
    if (isPerDay) {
      updateData({ matchRulesByDay: { ...data.matchRulesByDay, [activeDay]: rule } })
    } else {
      updateData({ matchRule: rule })
    }
  }

  // Switching to per-day seeds each service day with the shared selection so
  // the planner edits per day instead of restarting from zero.
  const enablePerDay = () => {
    if (isRule) {
      const seededRules = { ...data.matchRulesByDay }
      for (const day of days) {
        if (!seededRules[day]) seededRules[day] = { ...data.matchRule }
      }
      updateData({ sameAllDays: false, matchRulesByDay: seededRules })
      return
    }
    const seeded = { ...data.containersByDay }
    for (const day of days) {
      if (!seeded[day]) seeded[day] = [...data.sharedContainerIds]
    }
    updateData({ sameAllDays: false, containersByDay: seeded })
  }

  if (days.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Pick at least one service day in the Recurrence step first — each
        service day gets its own generated route and container plan.
      </p>
    )
  }

  const schemeProjectName = projects.find(
    (project) => project.id === data.projectId,
  )?.name
  const dayCounts = new Map(
    resolvedDraftPlans(data, containers).map((plan) => [
      plan.day,
      plan.containerIds.length,
    ]),
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={isRule ? "secondary" : "outline"}
          onClick={() => updateData({ stopSelection: "rule" })}
        >
          Match by rule
        </Button>
        <Button
          type="button"
          size="sm"
          variant={!isRule ? "secondary" : "outline"}
          onClick={() => updateData({ stopSelection: "manual" })}
        >
          Pick containers manually
        </Button>
        <p className="basis-full text-xs text-muted-foreground">
          {isRule
            ? "The scheme stores the selection rule — containers matching it are resolved every time routes are generated, so new eligible containers join automatically."
            : "The scheme stores the picked list — new containers must be added by editing the scheme."}
        </p>
      </div>
      {isMultiDay && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={data.sameAllDays ? "secondary" : "outline"}
            onClick={() => updateData({ sameAllDays: true })}
          >
            {isRule ? "Same rule every day" : "Same containers every day"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={!data.sameAllDays ? "secondary" : "outline"}
            onClick={enablePerDay}
          >
            Different per day
          </Button>
        </div>
      )}
      {isPerDay && (
        <>
          <div className="flex flex-wrap gap-1.5 border-b border-border pb-2">
            {days.map((day) => {
              const count = dayCounts.get(day) ?? 0
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => setActiveDay(day)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    day === activeDay
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {SERVICE_DAY_SHORT_LABELS[day]}
                  <span className="font-mono">{count}</span>
                </button>
              )
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {isRule ? "Setting the rule for" : "Picking the route for"}{" "}
            <span className="font-semibold text-foreground">
              {SERVICE_DAY_SHORT_LABELS[activeDay]}
            </span>{" "}
            — each service day generates its own route with its own stops.
          </p>
        </>
      )}
      {isRule ? (
        <SchemeRuleEditor
          containers={containers}
          areaName={areas.find((area) => area.id === data.planningAreaId)?.name}
          areaId={data.planningAreaId}
          projectIds={data.projectId ? [data.projectId] : undefined}
          rule={activeRule}
          onChange={setActiveRule}
        />
      ) : (
        <SchemeContainerPicker
          containers={containers}
          defaultProject={schemeProjectName}
          pickedIds={pickedIds}
          onPick={setPickedIds}
        />
      )}
    </div>
  )
}

/**
 * The declarative rule editor + live match preview (issue #19): waste
 * fraction chips, an optional vehicle-type constraint, and the containers the
 * rule currently resolves to inside the scheme's planning area — matched list,
 * near-miss exclusions with reasons, and a loud zero-match empty state.
 */
function SchemeRuleEditor({
  containers,
  areaId,
  areaName,
  projectIds,
  rule,
  onChange,
}: {
  containers: BusinessRecord[]
  areaId?: string
  areaName?: string
  projectIds?: string[]
  rule: StopMatchRule
  onChange: (rule: StopMatchRule) => void
}) {
  const fractionOptions = useMemo(() => {
    const values = new Set<string>(rule.fractions)
    for (const container of containers) {
      const fact = container.facts?.["Waste fractions"]
      if (!fact || fact === "—") continue
      for (const part of fact.split("·")) {
        const trimmed = part.trim()
        if (trimmed) values.add(trimmed)
      }
    }
    return Array.from(values).sort()
  }, [containers, rule.fractions])

  const toggleFraction = (fraction: string) => {
    onChange({
      ...rule,
      fractions: rule.fractions.includes(fraction)
        ? rule.fractions.filter((candidate) => candidate !== fraction)
        : [...rule.fractions, fraction],
    })
  }

  const result = useMemo(
    () => resolveStopMatches({ rule, areaId, projectIds, containers }),
    [rule, areaId, projectIds, containers],
  )

  return (
    <div className="space-y-3 rounded-2xl border border-border/60 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">Stop matching rule</p>
        <p className="text-sm font-medium text-primary">
          {result.matched.length} matching
        </p>
      </div>

      {areaId ? (
        <p className="text-xs text-muted-foreground">
          Matching inside{" "}
          <span className="font-semibold text-foreground">
            {areaName ?? "the selected planning area"}
          </span>{" "}
          — containers carry their planning area; the scheme&apos;s area bounds
          the rule.
        </p>
      ) : (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          No planning area selected — go back to the Scheme &amp; scope step and
          pick one. The rule matches containers inside the scheme&apos;s area.
        </p>
      )}

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Waste fractions</Label>
        <div className="flex flex-wrap gap-2">
          {fractionOptions.map((fraction) => {
            const isOn = rule.fractions.includes(fraction)
            return (
              <button
                key={fraction}
                type="button"
                onClick={() => toggleFraction(fraction)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  isOn
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground hover:border-primary/50",
                )}
              >
                {fraction}
              </button>
            )
          })}
        </div>
      </div>

      <div className="max-w-xs space-y-1.5">
        <Label className="text-xs text-muted-foreground">Vehicle type</Label>
        <Select
          value={rule.vehicleType ?? "any"}
          onValueChange={(value) =>
            onChange(
              value === "any"
                ? { fractions: rule.fractions }
                : { ...rule, vehicleType: value },
            )
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any vehicle type</SelectItem>
            {STOP_MATCH_VEHICLE_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Only containers this vehicle type can service are matched.
        </p>
      </div>

      <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
        {rule.fractions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Pick at least one waste fraction — the rule is the fraction
            selection.
          </p>
        ) : result.matched.length === 0 ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-4 text-center">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              No containers currently match this rule
            </p>
            <p className="mt-1 text-xs text-amber-700/80 dark:text-amber-400/80">
              {areaId
                ? `${result.scopeTotal} container${result.scopeTotal === 1 ? "" : "s"} in the planning area — none matches the fractions${rule.vehicleType ? ` and ${rule.vehicleType.toLowerCase()} compatibility` : ""}. The scheme cannot validate until the rule matches.`
                : "Pick a planning area first."}
            </p>
          </div>
        ) : (
          result.matched.map((profile) => {
            const container = containers.find(
              (candidate) => candidate.id === profile.id,
            )
            return (
              <div
                key={profile.id}
                className="flex w-full items-center gap-3 rounded-xl border border-border/60 px-3 py-2 text-left"
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-primary bg-primary text-primary-foreground">
                  <Check className="h-3 w-3" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {profile.name}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {profile.fractions.join(" · ")}
                    </span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {container?.facts?.Address ?? container?.context ?? ""}
                    {profile.containerType ? ` · ${profile.containerType}` : ""}
                  </p>
                </div>
              </div>
            )
          })
        )}
      </div>

      {result.excluded.length > 0 && (
        <div className="space-y-1 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
          <p className="text-xs font-medium text-muted-foreground">
            {result.excluded.length} matching-fraction container
            {result.excluded.length === 1 ? "" : "s"} excluded
          </p>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {result.excluded.slice(0, 6).map((exclusion) => (
              <li key={exclusion.id} className="truncate">
                <span className="font-medium text-foreground/80">
                  {exclusion.name}
                </span>{" "}
                — {exclusion.reason}
              </li>
            ))}
            {result.excluded.length > 6 && (
              <li>… and {result.excluded.length - 6} more</li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

function SchemeContainerPicker({
  containers,
  defaultProject,
  pickedIds,
  onPick,
}: {
  containers: BusinessRecord[]
  defaultProject?: string
  pickedIds: string[]
  onPick: (ids: string[]) => void
}) {
  const [search, setSearch] = useState("")
  const [projectFilter, setProjectFilter] = useState(defaultProject ?? "all")
  const [fractionFilter, setFractionFilter] = useState("all")
  const [typeFilter, setTypeFilter] = useState("all")

  const factOptions = (fact: string) => {
    const values = new Set<string>()
    for (const container of containers) {
      const value = container.facts?.[fact]
      if (value && value !== "—") values.add(value)
    }
    return Array.from(values).sort()
  }
  const projectOptions = useMemo(() => factOptions("Project"), [containers]) // eslint-disable-line react-hooks/exhaustive-deps
  const fractionOptions = useMemo(() => factOptions("Waste fractions"), [containers]) // eslint-disable-line react-hooks/exhaustive-deps
  const typeOptions = useMemo(() => factOptions("Container type"), [containers]) // eslint-disable-line react-hooks/exhaustive-deps

  const matches = useMemo(() => {
    const query = search.trim().toLowerCase()
    return containers.filter((container) => {
      const facts = container.facts ?? {}
      if (projectFilter !== "all" && facts.Project !== projectFilter) return false
      if (fractionFilter !== "all" && facts["Waste fractions"] !== fractionFilter) {
        return false
      }
      if (typeFilter !== "all" && facts["Container type"] !== typeFilter) return false
      if (!query) return true
      return (
        container.name.toLowerCase().includes(query) ||
        (facts.Address ?? "").toLowerCase().includes(query)
      )
    })
  }, [containers, fractionFilter, projectFilter, search, typeFilter])

  const allMatchesPicked =
    matches.length > 0 && matches.every((container) => pickedIds.includes(container.id))
  const toggleAllMatches = () => {
    onPick(
      allMatchesPicked
        ? pickedIds.filter((id) => !matches.some((container) => container.id === id))
        : Array.from(new Set([...pickedIds, ...matches.map((container) => container.id)])),
    )
  }

  const toggleContainer = (containerId: string) => {
    onPick(
      pickedIds.includes(containerId)
        ? pickedIds.filter((id) => id !== containerId)
        : [...pickedIds, containerId],
    )
  }

  const filterSelect = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: string[],
  ) => (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  return (
    <div className="space-y-3 rounded-2xl border border-border/60 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">Pick containers</p>
        <p className="text-sm font-medium text-primary">
          {pickedIds.length} picked
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {filterSelect("Project", projectFilter, setProjectFilter, projectOptions)}
        {filterSelect("Waste fraction", fractionFilter, setFractionFilter, fractionOptions)}
        {filterSelect("Container type", typeFilter, setTypeFilter, typeOptions)}
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by container ID or address"
            className="pl-9"
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={matches.length === 0}
          onClick={toggleAllMatches}
        >
          {allMatchesPicked ? "Clear filtered" : `Add all filtered (${matches.length})`}
        </Button>
      </div>

      <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
        {matches.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No containers match this filter.
          </p>
        ) : (
          matches.map((container) => {
            const isPicked = pickedIds.includes(container.id)
            return (
              <button
                key={container.id}
                type="button"
                onClick={() => toggleContainer(container.id)}
                className="flex w-full items-center gap-3 rounded-xl border border-border/60 px-3 py-2 text-left transition-colors hover:bg-muted/50"
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                    isPicked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border",
                  )}
                >
                  {isPicked && <Check className="h-3 w-3" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {container.name}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {container.facts?.["Waste fractions"] ?? ""}
                    </span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {container.facts?.Address ?? container.context}
                    {container.facts?.["Container type"]
                      ? ` · ${container.facts["Container type"]}`
                      : ""}
                  </p>
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

// Step 6 — Route map (FR-15): one colored route line + pins per service day

function StepRouteMap({ data }: { data: GuidedSchemeData }) {
  const containers = useModuleRecords("resources", "containers")
  const plans = resolvedDraftPlans(data, containers)

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {data.stopSelection === "rule"
          ? "Each service day generates its own route from the containers its rule currently matches — filter a day to isolate its line."
          : "Each service day generates its own route in picked order — filter a day to isolate its line."}
      </p>
      <SchemeRouteMap plans={plans} containers={containers} />
    </div>
  )
}

// Step 7 — Review & create

function StepSchemeReview({
  data,
  onEditStep,
}: {
  data: GuidedSchemeData
  onEditStep: (step: number) => void
}) {
  const projects = useModuleRecords("configure", "organization")
  const areas = useModuleRecords("plan", "areas")
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
  const normalizedPlans = schemeDayPlans(data)
  const plans = resolvedDraftPlans(data, containers)
  const isRule = data.stopSelection === "rule"
  const matchPlans = schemeMatchPlans(data)
  const ruleRows: { label: string; value: string }[] = isRule
    ? matchPlans.sameAllDays
      ? [{ label: "Rule", value: stopRuleSummary(data.matchRule) }]
      : effectiveDayRules(data.serviceDays, matchPlans).map(({ day, rule }) => ({
          label: `Rule · ${SERVICE_DAY_SHORT_LABELS[day]}`,
          value: stopRuleSummary(rule),
        }))
    : []

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
          dayPlans: plans,
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
      ],
    },
    {
      title: "Collection Calendar",
      step: GUIDED_STEP.calendar,
      rows: [
        { label: "Calendar", value: nameOf(calendars, data.calendarId) },
        ...(calendar
          ? [
              { label: "Working days", value: formatWorkingDays(calendar.workingDays) },
              {
                label: "Holidays",
                value:
                  calendar.holidayDates.length > 0
                    ? plural(calendar.holidayDates.length, "date")
                    : "None recorded",
              },
            ]
          : []),
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
      title: "Assignment",
      step: GUIDED_STEP.assignment,
      rows: [
        {
          label: "Service provider",
          value: data.serviceProviderId
            ? nameOf(serviceProviders, data.serviceProviderId)
            : "In-house",
        },
        { label: "Default vehicle", value: nameOf(vehicles, data.plannedVehicleId) },
        { label: "Default driver", value: nameOf(drivers, data.plannedDriverId) },
        { label: "Departure depot", value: nameOf(depots, data.depotId) },
        {
          label: "Unloading station",
          value: nameOf(depots, data.unloadingStationId),
        },
      ],
    },
    {
      title: "Containers",
      step: GUIDED_STEP.containers,
      rows: isRule
        ? [
            { label: "Stop selection", value: "Matched by rule" },
            ...ruleRows,
            { label: "Currently matching", value: dayPlanCountSummary(plans) },
          ]
        : [
            {
              label: "Container selection",
              value: normalizedPlans.sameAllDays
                ? "Same containers every day"
                : "Different per day",
            },
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
                  Creating this scheme generates routes for{" "}
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
