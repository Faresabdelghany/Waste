"use client"

// ============================================================================
// PROTOTYPE — THROWAWAY CODE. Do not ship or build on top of this.
//
// Route create flow, iterating inside the winning variant (A — mode chooser):
// "Create route" opens a Quick create / Guided Setup chooser. Quick create
// opens the real Create Route dialog (via onQuickCreate). Guided Setup walks
// route-specific steps:
//   1. Project & date
//   2. Responsibility — contractor list
//   3. Fleet & locations — Home depot, Waste station, Vehicle, Driver
//   4. Containers — waste fraction, container type, add existing containers
//      (filter by property, search by container ID or address)
//   5. Review & create
// Guided completion is a stub toast — no record is written.
// Dropdowns read fixture records straight from the business-modules registry.
// ============================================================================

import { useMemo, useState } from "react"
import { toast } from "sonner"
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
  businessWorkspaces,
  type BusinessRecord,
  type WorkspaceId,
} from "@/lib/data/business-modules"
import { cn } from "@/lib/utils"

function fixtureRecords(workspaceId: WorkspaceId, moduleId: string): BusinessRecord[] {
  const module = businessWorkspaces[workspaceId]?.modules.find(
    (candidate) => candidate.id === moduleId,
  )
  return module?.records ?? []
}

const HOME_DEPOT_OPTIONS = [
  "Nordhavn Depot",
  "Valby Depot",
  "Østerbro Depot",
  "Amager Depot",
]

const WASTE_STATION_OPTIONS = [
  "ARC Amager",
  "Vestforbrænding Glostrup",
  "Norrecco Nordhavn",
]

const WASTE_FRACTION_OPTIONS = [
  "Residual",
  "Organic",
  "Paper",
  "Glass",
  "Plastic",
  "Cardboard",
]

const CONTAINER_TYPE_OPTIONS = [
  "Two-wheel bin · 240 L",
  "Four-wheel bin · 660 L",
  "Four-wheel bin · 1100 L",
  "Underground container",
]

interface GuidedRouteData {
  projectId?: string
  date?: string
  contractorId?: string
  homeDepot?: string
  wasteStation?: string
  vehicleId?: string
  driverId?: string
  wasteFraction?: string
  containerType?: string
  containerIds: string[]
}

interface RouteCreateEntryPrototypeProps {
  submitLabel: string
  onQuickCreate: () => void
}

export function RouteCreateEntryPrototype({
  submitLabel,
  onQuickCreate,
}: RouteCreateEntryPrototypeProps) {
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
        <ModeChooserOverlay
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
        <GuidedRouteWizardOverlay onClose={() => setIsGuidedOpen(false)} />
      )}
    </>
  )
}

// --- Mode chooser (reuses the project wizard's StepMode) ---

function ModeChooserOverlay({
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

// --- Guided route wizard: 5 route-specific steps ---

const GUIDED_STEPS = [
  "Project & date",
  "Responsibility",
  "Fleet & locations",
  "Containers",
  "Review & create",
]

const GUIDED_STEP_TITLES: Record<number, string> = {
  1: "Which project and date is this route for?",
  2: "Who is responsible for this route?",
  3: "Which fleet and locations run this route?",
  4: "Which containers does this route serve?",
  5: "Review route setup",
}

function GuidedRouteWizardOverlay({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(1)
  const [maxStepReached, setMaxStepReached] = useState(1)
  const [data, setData] = useState<GuidedRouteData>({ containerIds: [] })

  const updateData = (updates: Partial<GuidedRouteData>) => {
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
          <p className="text-sm font-semibold text-foreground">New Route</p>
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
            {step === 1 && <StepProjectDate data={data} updateData={updateData} />}
            {step === 2 && <StepResponsibility data={data} updateData={updateData} />}
            {step === 3 && <StepFleetLocations data={data} updateData={updateData} />}
            {step === 4 && <StepContainers data={data} updateData={updateData} />}
            {step === 5 && <StepRouteReview data={data} onEditStep={goToStep} />}
          </div>

          <div className="flex items-center justify-between bg-background p-6">
            <Button
              variant="outline"
              onClick={() => (step === 1 ? onClose() : setStep(step - 1))}
            >
              <CaretLeft className="h-4 w-4" />
              {step === 1 ? "Cancel" : "Back"}
            </Button>
            {step === 5 ? (
              <Button
                onClick={() => {
                  toast.success("Route created successfully", {
                    description: "Prototype stub — no record was saved.",
                  })
                  onClose()
                }}
              >
                Create route
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
  data: GuidedRouteData
  updateData: (updates: Partial<GuidedRouteData>) => void
}

// Step 1 — Project & date

function StepProjectDate({ data, updateData }: GuidedStepProps) {
  const projects = fixtureRecords("configure", "organization")

  return (
    <div className="max-w-md space-y-6">
      <p className="text-sm text-muted-foreground">
        Pick the operating scope and the date this route runs.
      </p>
      <div className="space-y-2">
        <Label>Project</Label>
        <Select
          value={data.projectId}
          onValueChange={(projectId) => updateData({ projectId })}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select project" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Date</Label>
        <Input
          type="date"
          value={data.date ?? ""}
          onChange={(event) => updateData({ date: event.target.value })}
        />
      </div>
    </div>
  )
}

// Step 2 — Responsibility (contractor list)

function StepResponsibility({ data, updateData }: GuidedStepProps) {
  const contractors = fixtureRecords("contractors", "contractors")

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Select the contractor responsible for executing this route.
      </p>
      <div className="space-y-2">
        {contractors.map((contractor) => {
          const isSelected = data.contractorId === contractor.id
          return (
            <button
              key={contractor.id}
              type="button"
              onClick={() => updateData({ contractorId: contractor.id })}
              className={cn(
                "flex w-full items-center justify-between rounded-2xl border border-border/60 bg-background p-4 text-left transition-all hover:shadow-md/5",
                isSelected && "border-green-600 ring-1 ring-green-600",
              )}
            >
              <div className="min-w-0 pr-4">
                <p className="truncate text-sm font-semibold text-foreground">
                  {contractor.name}
                </p>
                <p className="truncate text-sm text-muted-foreground">
                  {contractor.context}
                </p>
              </div>
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-background",
                  isSelected && "border-green-600 bg-green-600",
                )}
              >
                {isSelected && <Check className="h-4 w-4 text-primary-foreground" />}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// Step 3 — Fleet & locations

function StepFleetLocations({ data, updateData }: GuidedStepProps) {
  const vehicles = fixtureRecords("fleet", "vehicles")
  const drivers = fixtureRecords("fleet", "drivers")

  return (
    <div className="max-w-md space-y-6">
      <p className="text-sm text-muted-foreground">
        Set where the route starts and unloads, and which vehicle and driver run it.
      </p>
      <div className="space-y-2">
        <Label>Home depot</Label>
        <Select
          value={data.homeDepot}
          onValueChange={(homeDepot) => updateData({ homeDepot })}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select home depot" />
          </SelectTrigger>
          <SelectContent>
            {HOME_DEPOT_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Waste station</Label>
        <Select
          value={data.wasteStation}
          onValueChange={(wasteStation) => updateData({ wasteStation })}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select waste station" />
          </SelectTrigger>
          <SelectContent>
            {WASTE_STATION_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Vehicle</Label>
        <Select
          value={data.vehicleId}
          onValueChange={(vehicleId) => updateData({ vehicleId })}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select vehicle" />
          </SelectTrigger>
          <SelectContent>
            {vehicles.map((vehicle) => (
              <SelectItem key={vehicle.id} value={vehicle.id}>
                {vehicle.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Driver</Label>
        <Select
          value={data.driverId}
          onValueChange={(driverId) => updateData({ driverId })}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select driver" />
          </SelectTrigger>
          <SelectContent>
            {drivers.map((driver) => (
              <SelectItem key={driver.id} value={driver.id}>
                {driver.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

// Step 4 — Containers

function StepContainers({ data, updateData }: GuidedStepProps) {
  const containers = fixtureRecords("resources", "containers")
  const [propertyFilter, setPropertyFilter] = useState("all")
  const [search, setSearch] = useState("")

  const propertyOptions = useMemo(() => {
    const values = new Set<string>()
    for (const container of containers) {
      const property = container.facts?.Property
      if (property && property !== "—") values.add(property)
    }
    return Array.from(values).sort()
  }, [containers])

  const matches = useMemo(() => {
    const query = search.trim().toLowerCase()
    return containers.filter((container) => {
      const property = container.facts?.Property ?? ""
      if (propertyFilter !== "all" && property !== propertyFilter) return false
      if (!query) return true
      const address = container.facts?.Address ?? ""
      return (
        container.name.toLowerCase().includes(query) ||
        address.toLowerCase().includes(query)
      )
    })
  }, [containers, propertyFilter, search])

  const toggleContainer = (containerId: string) => {
    updateData({
      containerIds: data.containerIds.includes(containerId)
        ? data.containerIds.filter((id) => id !== containerId)
        : [...data.containerIds, containerId],
    })
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Choose what this route collects, then add the containers it serves.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Waste fraction</Label>
          <Select
            value={data.wasteFraction}
            onValueChange={(wasteFraction) => updateData({ wasteFraction })}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select waste fraction" />
            </SelectTrigger>
            <SelectContent>
              {WASTE_FRACTION_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Container type</Label>
          <Select
            value={data.containerType}
            onValueChange={(containerType) => updateData({ containerType })}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select container type" />
            </SelectTrigger>
            <SelectContent>
              {CONTAINER_TYPE_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-3 rounded-2xl border border-border/60 p-4">
        <div>
          <p className="text-sm font-semibold text-foreground">
            Add existing containers
          </p>
          <p className="text-sm text-muted-foreground">
            {data.containerIds.length} container
            {data.containerIds.length === 1 ? "" : "s"} added to this route
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">
              Filter by property (optional)
            </Label>
            <Select value={propertyFilter} onValueChange={setPropertyFilter}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All properties</SelectItem>
                {propertyOptions.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Search</Label>
            <div className="relative">
              <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by container ID or address"
                className="pl-9"
              />
            </div>
          </div>
        </div>

        <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
          {matches.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No containers match this filter.
            </p>
          ) : (
            matches.map((container) => {
              const isAdded = data.containerIds.includes(container.id)
              return (
                <div
                  key={container.id}
                  className="flex items-center justify-between gap-4 rounded-xl border border-border/60 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {container.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {container.facts?.Address ?? container.context}
                      {container.facts?.["Container type"]
                        ? ` · ${container.facts["Container type"]}`
                        : ""}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={isAdded ? "secondary" : "outline"}
                    onClick={() => toggleContainer(container.id)}
                  >
                    {isAdded ? (
                      <>
                        <Check className="h-4 w-4" /> Added
                      </>
                    ) : (
                      <>
                        <Plus className="h-4 w-4" /> Add
                      </>
                    )}
                  </Button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

// Step 5 — Review

function StepRouteReview({
  data,
  onEditStep,
}: {
  data: GuidedRouteData
  onEditStep: (step: number) => void
}) {
  const projects = fixtureRecords("configure", "organization")
  const contractors = fixtureRecords("contractors", "contractors")
  const vehicles = fixtureRecords("fleet", "vehicles")
  const drivers = fixtureRecords("fleet", "drivers")
  const containers = fixtureRecords("resources", "containers")

  const nameOf = (records: BusinessRecord[], id?: string) =>
    records.find((record) => record.id === id)?.name ?? "Not specified"

  const sections: {
    title: string
    step: number
    rows: { label: string; value: string }[]
  }[] = [
    {
      title: "Project & date",
      step: 1,
      rows: [
        { label: "Project", value: nameOf(projects, data.projectId) },
        { label: "Date", value: data.date || "Not specified" },
      ],
    },
    {
      title: "Responsibility",
      step: 2,
      rows: [
        { label: "Contractor", value: nameOf(contractors, data.contractorId) },
      ],
    },
    {
      title: "Fleet & locations",
      step: 3,
      rows: [
        { label: "Home depot", value: data.homeDepot ?? "Not specified" },
        { label: "Waste station", value: data.wasteStation ?? "Not specified" },
        { label: "Vehicle", value: nameOf(vehicles, data.vehicleId) },
        { label: "Driver", value: nameOf(drivers, data.driverId) },
      ],
    },
    {
      title: "Containers",
      step: 4,
      rows: [
        { label: "Waste fraction", value: data.wasteFraction ?? "Not specified" },
        { label: "Container type", value: data.containerType ?? "Not specified" },
        {
          label: "Containers",
          value: data.containerIds.length
            ? data.containerIds
                .map((id) => nameOf(containers, id))
                .join(", ")
            : "None added",
        },
      ],
    },
  ]

  return (
    <div className="space-y-4">
      {sections.map((section) => (
        <div
          key={section.title}
          className="rounded-2xl border border-border/60 p-4"
        >
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
    </div>
  )
}
