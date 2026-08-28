"use client"

// Route Scheme create flow for the Route Schemes module (spec FR-1/FR-2/FR-5/
// FR-14/FR-15, tickets #5/#6). "New route scheme" opens a chooser between
// Quick create (the schema-driven dialog, opened via onQuickCreate) and Guided
// Setup — a six-step wizard: scheme & scope, recurrence, assignment, per-day
// container plans, route map, and review & create. Guided completion hands the
// collected values to onGuidedCreate, which owns record creation and the
// Validated/Draft decision.

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
import {
  calendarFromRecord,
  type CollectionCalendar,
} from "@/lib/route-schemes/calendar"
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
  dayPlanCountSummary,
  effectiveDayPlans,
  schemeDefaultsFromValues,
  validateScheme,
  type SchemeDayPlans,
  type SchemeValidationResult,
} from "@/lib/route-schemes/validation"
import { cn } from "@/lib/utils"

export interface GuidedSchemeData {
  schemeName: string
  projectId?: string
  planningAreaId?: string
  calendarId?: string
  frequency: RecurrenceFrequency
  weekRotation: WeekRotation
  serviceDays: ServiceDay[]
  effectiveFrom: string
  effectiveTo: string
  plannedStartTime: string
  contractorId?: string
  plannedVehicleId?: string
  plannedDriverId?: string
  depotId?: string
  unloadingStationId?: string
  sameAllDays: boolean
  sharedContainerIds: string[]
  containersByDay: Partial<Record<ServiceDay, string[]>>
}

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

/**
 * FR-5 over the wizard draft plus every existing scheme's defaults; the
 * selected Collection Calendar adds non-blocking warnings (Q6/Q7).
 */
export function validateGuidedScheme(
  data: GuidedSchemeData,
  existingSchemes: readonly BusinessRecord[],
  calendar?: CollectionCalendar | null,
): SchemeValidationResult {
  return validateScheme(
    {
      serviceDays: data.serviceDays,
      effectiveFrom: data.effectiveFrom,
      effectiveTo: data.effectiveTo,
      plans: schemeDayPlans(data),
      plannedVehicleId: data.plannedVehicleId,
      plannedDriverId: data.plannedDriverId,
      calendar,
    },
    existingSchemes
      .map((record) => schemeDefaultsFromValues(record.name, record.submittedValues))
      .filter((source): source is NonNullable<typeof source> => source !== null),
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
  "Assignment",
  "Containers",
  "Route map",
  "Review & create",
]

const GUIDED_STEP_TITLES: Record<number, string> = {
  1: "Which scope does this scheme plan for?",
  2: "When does this scheme collect?",
  3: "Which defaults run the generated routes?",
  4: "Which containers does each service day serve?",
  5: "How do the generated routes look?",
  6: "Review route scheme setup",
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
    sameAllDays: true,
    sharedContainerIds: [],
    containersByDay: {},
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
            {step === 1 && <StepSchemeScope data={data} updateData={updateData} />}
            {step === 2 && <StepRecurrence data={data} updateData={updateData} />}
            {step === 3 && <StepAssignment data={data} updateData={updateData} />}
            {step === 4 && <StepDayContainers data={data} updateData={updateData} />}
            {step === 5 && <StepRouteMap data={data} />}
            {step === 6 && <StepSchemeReview data={data} onEditStep={goToStep} />}
          </div>

          <div className="flex items-center justify-between bg-background p-6">
            <Button
              variant="outline"
              onClick={() => (step === 1 ? onClose() : setStep(step - 1))}
            >
              <CaretLeft className="h-4 w-4" />
              {step === 1 ? "Cancel" : "Back"}
            </Button>
            {step === 6 ? (
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
  const calendars = useModuleRecords("plan", "calendars")

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
      <RecordSelect
        label="Collection calendar"
        placeholder="Select collection calendar"
        records={calendars}
        value={data.calendarId}
        onChange={(calendarId) => updateData({ calendarId })}
      />
    </div>
  )
}

// Step 2 — Recurrence

function StepRecurrence({ data, updateData }: GuidedStepProps) {
  const recurrence = draftRecurrence(data)
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
          <Label>Effective to</Label>
          <Input
            type="date"
            value={data.effectiveTo}
            min={data.effectiveFrom || undefined}
            onChange={(event) => updateData({ effectiveTo: event.target.value })}
          />
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
            {previewDates.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {previewDates.map((date) => (
                  <span
                    key={date}
                    className="rounded-md border border-border/60 bg-background px-2 py-1 text-xs font-medium"
                  >
                    {formatServiceDate(date)}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                No upcoming service dates fall inside the effective window.
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

// Step 3 — Assignment

function StepAssignment({ data, updateData }: GuidedStepProps) {
  const contractors = useModuleRecords("contractors", "contractors")
  const vehicles = useModuleRecords("fleet", "vehicles")
  const drivers = useModuleRecords("fleet", "drivers")
  const depots = useModuleRecords("resources", "depots")

  return (
    <div className="max-w-md space-y-6">
      <p className="text-sm text-muted-foreground">
        Defaults only — every generated route can be reassigned individually.
      </p>
      <RecordSelect
        label="Responsible contractor (optional)"
        placeholder="Keep in-house"
        records={contractors}
        value={data.contractorId}
        onChange={(contractorId) => updateData({ contractorId })}
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

// Step 4 — Containers, per-day service plans (FR-14)

function StepDayContainers({ data, updateData }: GuidedStepProps) {
  const containers = useModuleRecords("resources", "containers")
  const projects = useModuleRecords("configure", "organization")
  const days = sortServiceDays(data.serviceDays)
  const isMultiDay = days.length > 1
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

  // Switching to per-day seeds each service day with the shared list so the
  // planner edits per day instead of restarting from zero.
  const enablePerDay = () => {
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

  return (
    <div className="space-y-4">
      {isMultiDay && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={data.sameAllDays ? "secondary" : "outline"}
            onClick={() => updateData({ sameAllDays: true })}
          >
            Same containers every day
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
              const count = (data.containersByDay[day] ?? []).length
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
            Picking the route for{" "}
            <span className="font-semibold text-foreground">
              {SERVICE_DAY_SHORT_LABELS[activeDay]}
            </span>{" "}
            — each service day generates its own route with its own stops.
          </p>
        </>
      )}
      <SchemeContainerPicker
        containers={containers}
        defaultProject={schemeProjectName}
        pickedIds={pickedIds}
        onPick={setPickedIds}
      />
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

// Step 5 — Route map (FR-15): one colored route line + pins per service day

function StepRouteMap({ data }: { data: GuidedSchemeData }) {
  const containers = useModuleRecords("resources", "containers")
  const plans = effectiveDayPlans(data.serviceDays, schemeDayPlans(data))

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Each service day generates its own route in picked order — filter a day
        to isolate its line.
      </p>
      <SchemeRouteMap plans={plans} containers={containers} />
    </div>
  )
}

// Step 6 — Review & create

function StepSchemeReview({
  data,
  onEditStep,
}: {
  data: GuidedSchemeData
  onEditStep: (step: number) => void
}) {
  const projects = useModuleRecords("configure", "organization")
  const areas = useModuleRecords("plan", "areas")
  const calendars = useModuleRecords("plan", "calendars")
  const contractors = useModuleRecords("contractors", "contractors")
  const vehicles = useModuleRecords("fleet", "vehicles")
  const drivers = useModuleRecords("fleet", "drivers")
  const depots = useModuleRecords("resources", "depots")
  const existingSchemes = useModuleRecords("route-studio", "schemes")

  const calendar = calendarFromRecord(
    calendars.find((record) => record.id === data.calendarId),
  )
  const validation = validateGuidedScheme(data, existingSchemes, calendar)
  const recurrence = draftRecurrence(data)
  const normalizedPlans = schemeDayPlans(data)
  const plans = effectiveDayPlans(data.serviceDays, normalizedPlans)

  const nameOf = (records: BusinessRecord[], id?: string) =>
    records.find((record) => record.id === id)?.name ?? "Not specified"

  const sections: {
    title: string
    step: number
    rows: { label: string; value: string }[]
  }[] = [
    {
      title: "Scheme & scope",
      step: 1,
      rows: [
        { label: "Name", value: data.schemeName.trim() || "Not specified" },
        { label: "Project", value: nameOf(projects, data.projectId) },
        { label: "Planning area", value: nameOf(areas, data.planningAreaId) },
        { label: "Collection calendar", value: nameOf(calendars, data.calendarId) },
      ],
    },
    {
      title: "Recurrence",
      step: 2,
      rows: [
        {
          label: "Cadence",
          value: recurrence ? recurrenceSentence(recurrence) : "Not specified",
        },
        {
          label: "Effective window",
          value:
            data.effectiveFrom && data.effectiveTo
              ? `${data.effectiveFrom} → ${data.effectiveTo}`
              : "Not specified",
        },
        { label: "Planned start", value: data.plannedStartTime || "Not specified" },
      ],
    },
    {
      title: "Assignment",
      step: 3,
      rows: [
        {
          label: "Contractor",
          value: data.contractorId
            ? nameOf(contractors, data.contractorId)
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
      step: 4,
      rows: [
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
          <div>
            <p className="text-sm font-semibold text-green-700 dark:text-green-400">
              All checks passed
            </p>
            <p className="text-xs text-green-700/80 dark:text-green-400/80">
              The scheme will be created as Validated.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
          <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
            The scheme will be created as Draft
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-400">
            {validation.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      {validation.warnings.length > 0 && (
        <div className="space-y-1.5 rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
            Calendar warnings — the scheme can still be created
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-400">
            {validation.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
