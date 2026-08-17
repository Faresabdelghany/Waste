"use client"

import Link from "next/link"
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import {
  ArrowSquareOut,
  CaretDown,
  DownloadSimple,
  Gear,
  Info,
  MagnifyingGlass,
  Plus,
  ShieldCheck,
} from "@phosphor-icons/react/dist/ssr"

import {
  businessWorkspaces,
  FIXTURE_COMPANY_ID,
  FIXTURE_PROJECT_IDS,
  getWorkspaceDefinition,
  type BusinessRecord,
  type ModuleDefinition,
  type WorkspaceDefinition,
  type WorkspaceId,
} from "@/lib/data/business-modules"
import { getBusinessFormSchema } from "@/lib/data/business-form-schemas"
import type {
  BusinessFormField,
  BusinessFormOption,
  BusinessFormSchema,
  BusinessFormValues,
} from "@/lib/data/business-form-types"
import {
  getBusinessModuleHref,
  resolveBusinessRelation,
} from "@/lib/data/business-links"
import type { TimelineTask } from "@/lib/data/project-details"
import { cn } from "@/lib/utils"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Badge } from "@/components/ui/badge"
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Textarea } from "@/components/ui/textarea"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ChipOverflow } from "@/components/chip-overflow"
import { StatRow } from "@/components/projects/StatRow"
import { TimelineGantt } from "@/components/projects/TimelineGantt"
import { ProgressCircle } from "@/components/progress-circle"
import { TaskRowBase } from "@/components/tasks/TaskRowBase"
import {
  BusinessFilterPopover,
  type BusinessFilters,
} from "@/components/wastehero/business-filter-popover"
import {
  BusinessViewOptionsPopover,
  defaultBusinessViewOptions,
  type BusinessViewOptions,
} from "@/components/wastehero/business-view-options-popover"
import { BusinessRecordFormDialog } from "@/components/wastehero/business-record-form-dialog"
import { useBusinessRecordStore } from "@/components/wastehero/business-record-store"
import {
  useAssetManagementStore,
  type MeasurementSetting,
  type ContainerType,
  type WasteFraction,
} from "@/components/settings/asset-management-store"
import { ContractorDetailsPage } from "@/components/wastehero/contractor-details-page"
import { ContainerDetailsSheet } from "@/components/wastehero/containers-assets-register"
import { RouteDetailsPage } from "@/components/wastehero/route-details-page"
import { TicketDetailsDialog } from "@/components/tickets/TicketDetailsDialog"

type BusinessWorkspaceProps = {
  workspaceId: WorkspaceId
  initialModuleId?: string
  allowedModuleIds?: readonly string[]
  allowedRecordIds?: readonly string[]
  workspaceLabel?: string
  workspaceDescription?: string
  fixedProjectScope?: ProjectScope
  fixedScopeLabel?: string
  showDeepLinks?: boolean
  showExportAction?: boolean
  showPrimaryAction?: boolean
  showFilters?: boolean
  navigationBasePath?: string
}

type ProjectScope = "copenhagen" | "harbor" | "all"

const emptyBusinessFilters: BusinessFilters = {
  statuses: [],
  sources: [],
  freshness: [],
  containerTypes: [],
  wasteFractions: [],
  vehicles: [],
  pickupSettings: [],
  routeSchemes: [],
  collectionCalendars: [],
  propertyTypes: [],
  contractAreas: [],
  serviceScopes: [],
  reliabilityBands: [],
}

const filterFieldByChipLabel: Record<string, keyof BusinessFilters> = {
  Status: "statuses",
  Source: "sources",
  Freshness: "freshness",
  "Container type": "containerTypes",
  "Waste fraction": "wasteFractions",
  Vehicle: "vehicles",
  "Pickup setting": "pickupSettings",
  "Route scheme": "routeSchemes",
  "Collection calendar": "collectionCalendars",
  "Property type": "propertyTypes",
  "Contract area": "contractAreas",
  "Service scope": "serviceScopes",
  Reliability: "reliabilityBands",
}

type AuditEvent = {
  id: string
  action: string
  actor: string
  at: string
  reason: string
  before: string
  after: string
  evidence: string
}

type PendingAction = {
  record: BusinessRecord
  action: string
}

function localDateInputValue(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-")
}

type RelatedCreateTarget = {
  workspaceId: WorkspaceId
  moduleId: string
  initialValues: BusinessFormValues
  schemaOverride?: BusinessFormSchema
}

function configuredAssetFormSchema(
  schema: BusinessFormSchema | undefined,
  containerTypes: readonly ContainerType[],
  wasteFractions: readonly WasteFraction[],
  measurementSettings: readonly MeasurementSetting[],
  projectScope: ProjectScope,
) {
  if (schema?.key !== "resources.containers") return schema
  const selectedProjectId =
    projectScope === "all"
      ? null
      : projectScope === "harbor"
        ? FIXTURE_PROJECT_IDS.harbor
        : FIXTURE_PROJECT_IDS.copenhagen
  const availableInProject = (projectIds: readonly string[]) =>
    projectIds.length === 0 ||
    selectedProjectId === null ||
    projectIds.includes(selectedProjectId)
  const optionsByField: Record<string, readonly BusinessFormOption[]> = {
    containerType: containerTypes
      .filter(
        (item) =>
          item.lifecycleStatus === "Active" && availableInProject(item.projectIds),
      )
      .map((item) => ({ value: item.id, label: item.name })),
    wasteFraction: wasteFractions
      .filter(
        (item) => item.status === "Active" && availableInProject(item.projectIds),
      )
      .map((item) => ({ value: item.id, label: item.name })),
    secondaryWasteFraction: wasteFractions
      .filter(
        (item) => item.status === "Active" && availableInProject(item.projectIds),
      )
      .map((item) => ({ value: item.id, label: item.name })),
    measurementSetting: measurementSettings
      .filter(
        (item) =>
          item.active &&
          (selectedProjectId === null || item.projectId === selectedProjectId),
      )
      .map((item) => ({ value: item.id, label: item.name })),
  }

  return {
    ...schema,
    sections: schema.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) =>
        optionsByField[field.id]
          ? { ...field, options: optionsByField[field.id] }
          : field,
      ),
    })),
  }
}

function WorkspaceQuerySync({
  workspace,
  onModuleChange,
  onRecordOpen,
  resolveRecord,
}: {
  workspace: WorkspaceDefinition
  onModuleChange: (moduleId: string) => void
  onRecordOpen: (record: BusinessRecord | null) => void
  resolveRecord: (moduleId: string, recordId: string) => BusinessRecord | null
}) {
  const searchParams = useSearchParams()
  const requestedModuleId = searchParams.get("module")
  const requestedRecordId = searchParams.get("record")

  useEffect(() => {
    const requestedModule = requestedModuleId
      ? workspace.modules.find((module) => module.id === requestedModuleId)
      : requestedRecordId
        ? workspace.modules.find((module) =>
            Boolean(resolveRecord(module.id, requestedRecordId)),
          )
        : undefined

    if (requestedModule) onModuleChange(requestedModule.id)

    if (requestedRecordId) {
      const requestedRecord = requestedModule
        ? resolveRecord(requestedModule.id, requestedRecordId)
        : null
      onRecordOpen(requestedRecord ?? null)
    } else if (requestedModuleId) {
      onRecordOpen(null)
    }
  }, [
    onModuleChange,
    onRecordOpen,
    resolveRecord,
    requestedModuleId,
    requestedRecordId,
    workspace,
  ])

  return null
}

function recordProject(record: BusinessRecord): ProjectScope {
  if (!record.projectIds || record.projectIds.length !== 1) return "all"
  if (record.projectIds[0] === FIXTURE_PROJECT_IDS.harbor) return "harbor"
  if (record.projectIds[0] === FIXTURE_PROJECT_IDS.copenhagen) return "copenhagen"
  return "all"
}

function matchesFactFilter(
  record: BusinessRecord,
  selections: readonly string[],
  factLabel: string,
  splitValues = false,
) {
  if (selections.length === 0) return true
  const factValue = record.facts[factLabel]
  if (!factValue) return false
  const values = splitValues
    ? factValue.split(" · ").map((value) => value.trim())
    : [factValue]
  return selections.some((selection) => values.includes(selection))
}

function getWorkspaceNavigationHref(
  navigationBasePath: string | undefined,
  workspaceId: WorkspaceId,
  moduleId: string,
  recordId?: string,
): string {
  if (!navigationBasePath) {
    return getBusinessModuleHref(workspaceId, moduleId, recordId)
  }

  const params = new URLSearchParams({ module: moduleId })
  if (recordId) params.set("record", recordId)
  return `${navigationBasePath}?${params.toString()}`
}

const allocationMonthIndexes: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
}

function allocationDate(record: BusinessRecord, fallbackOffset: number) {
  const match = record.name.match(/^(\d{1,2})\s+([a-z]{3})/i)
  const month = match ? allocationMonthIndexes[match[2].toLowerCase()] : undefined

  if (match && month !== undefined) {
    return new Date(2026, month, Number(match[1]), 12)
  }

  return new Date(2026, 6, 26 + fallbackOffset, 12)
}

function matchingLifecycleState(module: ModuleDefinition, candidates: string[]): string | undefined {
  return module.lifecycle.find((state) =>
    candidates.some((candidate) => state.toLowerCase() === candidate.toLowerCase()),
  )
}

function actionOutcome(module: ModuleDefinition, action: string, currentStatus: string): string {
  const direct = matchingLifecycleState(module, [action])
  if (direct) return direct

  const normalized = action.toLowerCase()
  const candidates =
    normalized.includes("approve")
      ? ["Approved"]
      : normalized.includes("reject")
        ? ["Rejected"]
      : normalized.includes("complete")
          ? ["Completed", "Closed"]
          : normalized.includes("start")
            ? ["Active", "In progress"]
          : normalized.includes("resolve")
            ? ["Resolved", "Completed"]
            : normalized.includes("reopen")
              ? ["Reopened", "Open"]
              : normalized.includes("close")
                ? ["Closed", "Completed"]
                : normalized.includes("pause") || normalized.includes("suspend")
                  ? ["Paused", "Suspended", "On hold"]
                  : normalized.includes("cancel")
                    ? ["Cancelled"]
                    : normalized.includes("deactivate") || normalized.includes("disable")
                        ? ["Inactive", "Deactivated", "Disabled"]
                      : normalized.includes("activate")
                        ? ["Active", "Activated"]
                        : normalized.includes("archive")
                          ? ["Archived"]
                          : normalized.includes("decommission")
                            ? ["Decommissioned", "Retired"]
                            : normalized.includes("retract")
                              ? ["Retracted"]
                              : normalized === "apply" || normalized.startsWith("apply ")
                                ? ["Applied"]
                          : normalized.includes("publish")
                            ? ["Published"]
                            : normalized.includes("certify")
                              ? ["Certified"]
                              : normalized.includes("issue")
                                ? ["Issued"]
                                : normalized.includes("submit")
                                  ? ["Submitted", "Awaiting approval", "Pending"]
                                    : normalized.includes("schedule")
                                      ? ["Scheduled"]
                                      : normalized.includes("start")
                                        ? ["Started", "In progress", "Running"]
                                        : normalized.includes("confirm")
                                          ? ["Confirmed", "Active"]
                                          : normalized.includes("allocate")
                                            ? ["Allocated", "Planned"]
                                    : normalized.includes("retry") || normalized.includes("run")
                                      ? ["Running", "Processing", "In progress"]
                                      : normalized.includes("expire")
                                        ? ["Expired"]
                                        : normalized.includes("renew")
                                          ? ["Active", "Renewed"]
                                          : normalized.includes("release")
                                            ? ["Released", "Available"]
                                            : []

  return matchingLifecycleState(module, candidates) ?? currentStatus
}

function nextAllowedTransitions(module: ModuleDefinition, status: string): string[] {
  const terminalStates = new Set([
    "approved",
    "rejected",
    "cancelled",
    "credited",
    "decommissioned",
    "expired",
    "issued",
    "paid",
    "retracted",
    "retired",
    "terminated",
  ])
  if (terminalStates.has(status.toLowerCase())) return []

  const currentIndex = module.lifecycle.findIndex(
    (lifecycleState) => lifecycleState.toLowerCase() === status.toLowerCase(),
  )
  if (currentIndex < 0) return []
  return module.lifecycle.slice(currentIndex + 1, currentIndex + 3)
}

function createsCorrection(action: string): boolean {
  const normalized = action.toLowerCase()
  return normalized.includes("credit") || normalized.includes("correct")
}

function createsImmutableCompanion(module: ModuleDefinition, action: string): boolean {
  const normalized = action.toLowerCase()
  if (createsCorrection(action)) return true
  if (module.id === "studio" && (normalized.includes("generate plan") || normalized.includes("promote"))) {
    return true
  }
  if (
    (module.id === "inventory" || module.id === "warehouses") &&
    ["receive", "transfer", "reserve", "adjust", "release", "issue"].some((verb) =>
      normalized.includes(verb),
    )
  ) {
    return true
  }
  return normalized.startsWith("create ") || normalized.startsWith("generate ")
}

function companionLabel(module: ModuleDefinition, action: string, record: BusinessRecord): string {
  const normalized = action.toLowerCase()
  if (createsCorrection(action)) return `Correction for ${record.name}`
  if (module.id === "studio" && normalized.includes("promote")) return `Promotion · ${record.name}`
  if (module.id === "studio" && normalized.includes("generate plan")) return `Immutable plan · ${record.name}`
  if (module.id === "inventory" || module.id === "warehouses") {
    return `${action} ledger entry · ${record.name}`
  }
  return `${action.replace(/^Create\s+/i, "")} · ${record.name}`
}

function statusClasses(status: string): string {
  const normalized = status.toLowerCase()

  if (
    normalized.includes("inactive") ||
    normalized.includes("deactivated") ||
    normalized.includes("disabled") ||
    normalized.includes("unavailable")
  ) {
    return "border-transparent bg-muted text-muted-foreground"
  }

  if (
    normalized.includes("active") ||
    normalized.includes("ready") ||
    normalized.includes("completed") ||
    normalized.includes("approved") ||
    normalized.includes("healthy") ||
    normalized.includes("certified") ||
    normalized.includes("published") ||
    normalized.includes("open")
  ) {
    return "bg-teal-50 text-teal-700 border-transparent dark:bg-teal-500/15 dark:text-teal-100"
  }

  if (
    normalized.includes("critical") ||
    normalized.includes("failed") ||
    normalized.includes("blocked") ||
    normalized.includes("conflict") ||
    normalized.includes("out of stock") ||
    normalized.includes("expired") ||
    normalized.includes("issue")
  ) {
    return "bg-rose-50 text-rose-700 border-transparent dark:bg-rose-500/15 dark:text-rose-100"
  }

  if (
    normalized.includes("warning") ||
    normalized.includes("pending") ||
    normalized.includes("review") ||
    normalized.includes("delayed") ||
    normalized.includes("stale") ||
    normalized.includes("draft") ||
    normalized.includes("scheduled") ||
    normalized.includes("low") ||
    normalized.includes("expiring") ||
    normalized.includes("partial") ||
    normalized.includes("attention")
  ) {
    return "bg-amber-50 text-amber-700 border-transparent dark:bg-amber-500/15 dark:text-amber-100"
  }

  return "border-transparent bg-muted text-muted-foreground"
}

function recordProgress(record: BusinessRecord): number | null {
  const percentage = record.value.match(/(\d+)%/)
  if (percentage) return Math.min(100, Number(percentage[1]))
  const fraction = record.value.match(/(\d+)\s*\/\s*(\d+)/)
  if (fraction && Number(fraction[2]) > 0) {
    return Math.min(100, Math.round((Number(fraction[1]) / Number(fraction[2])) * 100))
  }
  if (record.status.toLowerCase().includes("completed")) return 100
  return null
}

const queueModuleIds = new Set(["exceptions", "tickets", "approvals"])

const primaryModuleIdsByWorkspace: Partial<Record<WorkspaceId, readonly string[]>> = {
  operate: ["tickets", "exceptions"],
  plan: ["studio", "calendars", "areas", "approvals"],
  "route-studio": ["live", "schemes", "routes", "pickups", "weights"],
  customers: ["properties", "groups", "shared", "agreements"],
  resources: ["containers", "inventory", "warehouses", "depots"],
  fleet: ["vehicles", "drivers", "vehicle-planning"],
  contractors: ["contractors", "contract-areas", "activities"],
  commercial: ["products", "pricing", "settlements", "events"],
  improve: ["intelligence", "analytics", "autopilot", "performance"],
  configure: ["organization", "access", "master", "finance"],
}

function RecordValue({ record }: { record: BusinessRecord }) {
  const progress = recordProgress(record)

  return (
    <div className="flex items-center gap-2">
      {progress !== null && (
        <ProgressCircle progress={progress} color="var(--chart-3)" size={22} />
      )}
      <span className="text-sm text-foreground">{record.value}</span>
    </div>
  )
}

function recordFactValue(
  record: BusinessRecord,
  label: string,
  fallback = "—",
) {
  const value = record.facts[label]?.trim()
  return value || fallback
}

function ContainerSensorState({ record }: { record: BusinessRecord }) {
  const sensor = recordFactValue(record, "Sensor", "Not fitted")
  const hasSensor = !/^(none|not fitted|no sensor|—)$/i.test(sensor)
  const fillLevel = recordFactValue(record, "Fill level", record.value)

  return (
    <div className="space-y-1">
      <p className="whitespace-nowrap text-sm font-medium text-foreground">
        {hasSensor ? fillLevel : "No sensor"}
      </p>
      <p className="max-w-[170px] truncate text-xs text-muted-foreground">
        {hasSensor ? sensor : "No measurements"}
      </p>
    </div>
  )
}

function resolveFormModule(workspaceId: WorkspaceId, moduleId: string) {
  const requestedWorkspace = getWorkspaceDefinition(workspaceId)
  const directModule = requestedWorkspace.modules.find(
    (module) => module.id === moduleId,
  )
  if (directModule) {
    return { workspaceId, module: directModule }
  }

  for (const candidateWorkspace of Object.values(businessWorkspaces)) {
    const candidateModule = candidateWorkspace.modules.find(
      (module) => module.id === moduleId,
    )
    if (candidateModule) {
      return {
        workspaceId: candidateWorkspace.id,
        module: candidateModule,
      }
    }
  }

  return null
}

function selectedProjectIds(
  projectScope: ProjectScope,
  values: BusinessFormValues,
): string[] {
  const selectedProjectId =
    typeof values.projectId === "string" ? values.projectId : ""
  if (
    selectedProjectId === FIXTURE_PROJECT_IDS.copenhagen ||
    selectedProjectId === FIXTURE_PROJECT_IDS.harbor
  ) {
    return [selectedProjectId]
  }
  if (projectScope === "all") {
    return [FIXTURE_PROJECT_IDS.copenhagen, FIXTURE_PROJECT_IDS.harbor]
  }
  return [
    projectScope === "harbor"
      ? FIXTURE_PROJECT_IDS.harbor
      : FIXTURE_PROJECT_IDS.copenhagen,
  ]
}

function projectScopeLabel(projectIds: readonly string[]) {
  if (projectIds.length > 1) return "All permitted projects"
  if (projectIds[0] === FIXTURE_PROJECT_IDS.harbor) return "Harbor Commercial"
  return "Copenhagen Central"
}

function normalizedLifecycleValue(value: string) {
  return value.toLowerCase().replace(/[\s_]+/g, "-")
}

function initialFormStatus(
  module: ModuleDefinition,
  schema: BusinessFormSchema,
  values: BusinessFormValues,
) {
  if (schema.execution?.initialStatus) return schema.execution.initialStatus

  for (const fieldId of [
    "eventState",
    "initialState",
    "allocationStatus",
    "decision",
    "recordState",
    "status",
  ]) {
    const value = values[fieldId]
    if (typeof value !== "string" || !value) continue
    const lifecycleStatus = module.lifecycle.find(
      (state) =>
        normalizedLifecycleValue(state) === normalizedLifecycleValue(value),
    )
    if (lifecycleStatus) return lifecycleStatus
  }

  const currentStatus = module.lifecycle[0] ?? "Draft"
  for (const actionFieldId of ["decision", "actionType", "allocationAction"]) {
    const actionValue = values[actionFieldId]
    if (typeof actionValue !== "string" || !actionValue) continue
    const outcome = actionOutcome(module, actionValue, currentStatus)
    if (outcome !== currentStatus) return outcome
  }

  return currentStatus
}

function preferredReason(values: BusinessFormValues) {
  for (const fieldId of [
    "decisionReason",
    "changeReason",
    "overrideReason",
    "exceptionReason",
    "deviationReason",
    "reason",
    "notes",
    "message",
  ]) {
    const value = values[fieldId]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return "Submitted through the governed module form"
}

export function BusinessWorkspace({
  workspaceId,
  initialModuleId,
  allowedModuleIds,
  allowedRecordIds,
  workspaceLabel,
  fixedProjectScope,
  fixedScopeLabel,
  showDeepLinks = true,
  showExportAction = false,
  showPrimaryAction = true,
  showFilters = true,
  navigationBasePath,
}: BusinessWorkspaceProps) {
  const sourceWorkspace = getWorkspaceDefinition(workspaceId)
  const { getRecords, upsertRecord } = useBusinessRecordStore()
  const { containerTypes, wasteFractions, measurementSettings } =
    useAssetManagementStore()
  const router = useRouter()
  const workspace = useMemo<WorkspaceDefinition>(() => {
    const allowedModules = allowedModuleIds ? new Set(allowedModuleIds) : null
    const allowedRecords = allowedRecordIds ? new Set(allowedRecordIds) : null
    const modules = sourceWorkspace.modules
      .filter((module) => !allowedModules || allowedModules.has(module.id))
      .map((module) =>
        allowedRecords
          ? {
              ...module,
              records: module.records.filter((record) => allowedRecords.has(record.id)),
            }
          : module,
      )

    if (modules.length === 0) {
      throw new Error(`No permitted modules are available in ${sourceWorkspace.id}`)
    }

    return {
      ...sourceWorkspace,
      modules,
    }
  }, [allowedModuleIds, allowedRecordIds, sourceWorkspace])
  const tabsScrollRef = useRef<HTMLDivElement>(null)
  const [activeModuleId, setActiveModuleId] = useState(
    workspace.modules.some((module) => module.id === initialModuleId)
      ? initialModuleId!
      : workspace.modules[0].id,
  )
  const [query, setQuery] = useState("")
  const [businessFilters, setBusinessFilters] =
    useState<BusinessFilters>(emptyBusinessFilters)
  const [viewOptions, setViewOptions] = useState<BusinessViewOptions>(
    defaultBusinessViewOptions,
  )
  const [selectedProjectScope, setSelectedProjectScope] =
    useState<ProjectScope>("copenhagen")
  const projectScope = fixedProjectScope ?? selectedProjectScope
  const [selectedRecord, setSelectedRecord] = useState<BusinessRecord | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [relatedCreateTarget, setRelatedCreateTarget] =
    useState<RelatedCreateTarget | null>(null)
  const [auditEvents, setAuditEvents] = useState<Record<string, AuditEvent[]>>({})

  const activeModule =
    workspace.modules.find((module) => module.id === activeModuleId) ?? workspace.modules[0]
  const isContainersAssetsView =
    workspace.id === "resources" && activeModule.id === "containers"
  const primaryModuleIds =
    primaryModuleIdsByWorkspace[workspace.id] ??
    workspace.modules.slice(0, 4).map((module) => module.id)
  const primaryModules = workspace.modules.filter((module) =>
    primaryModuleIds.includes(module.id),
  )
  const secondaryModules = workspace.modules.filter(
    (module) => !primaryModuleIds.includes(module.id),
  )
  const activeSecondaryModule = secondaryModules.find(
    (module) => module.id === activeModule.id,
  )
  const activeModuleFormSchema = useMemo(
    () =>
      configuredAssetFormSchema(
        getBusinessFormSchema(workspace.id, activeModule.id),
        containerTypes,
        wasteFractions,
        measurementSettings,
        projectScope,
      ),
    [
      activeModule.id,
      containerTypes,
      measurementSettings,
      projectScope,
      wasteFractions,
      workspace.id,
    ],
  )
  const relatedCreateModule = relatedCreateTarget
    ? resolveFormModule(
        relatedCreateTarget.workspaceId,
        relatedCreateTarget.moduleId,
      )
    : null
  const formSchema = useMemo(
    () =>
      relatedCreateTarget?.schemaOverride ?? (relatedCreateModule
        ? configuredAssetFormSchema(
            getBusinessFormSchema(
              relatedCreateModule.workspaceId,
              relatedCreateModule.module.id,
            ),
            containerTypes,
            wasteFractions,
            measurementSettings,
            projectScope,
          )
        : activeModuleFormSchema),
    [
      activeModuleFormSchema,
      containerTypes,
      measurementSettings,
      projectScope,
      relatedCreateModule,
      relatedCreateTarget?.schemaOverride,
      wasteFractions,
    ],
  )
  const canOpenBusinessForm =
    Boolean(activeModuleFormSchema?.execution) &&
    activeModuleFormSchema?.mode !== "disabled"
  const activeRecords = useMemo(
    () =>
      getRecords(
        workspace.id,
        activeModule.id,
        activeModule.records,
      ),
    [activeModule, getRecords, workspace.id],
  )
  const formTargetRecords = useMemo(
    () =>
      relatedCreateModule
        ? getRecords(
            relatedCreateModule.workspaceId,
            relatedCreateModule.module.id,
            relatedCreateModule.module.records,
          )
        : activeRecords,
    [activeRecords, getRecords, relatedCreateModule],
  )
  const isRouteDetails =
    workspace.id === "route-studio" &&
    activeModule.id === "routes" &&
    Boolean(selectedRecord)
  const isContractorDetails =
    workspace.id === "contractors" &&
    activeModule.id === "contractors" &&
    Boolean(selectedRecord)
  const isTicketDetails =
    workspace.id === "operate" &&
    activeModule.id === "tickets" &&
    Boolean(selectedRecord)
  const selectedRouteReference = selectedRecord?.name.split(" · ")[0] ?? ""
  const relatedRouteTickets = useMemo(() => {
    if (!selectedRouteReference) return []
    const operateWorkspace = getWorkspaceDefinition("operate")
    const ticketsModule = operateWorkspace.modules.find(
      (module) => module.id === "tickets",
    )
    if (!ticketsModule) return []
    return getRecords("operate", ticketsModule.id, ticketsModule.records).filter(
      (ticket) =>
        [ticket.name, ticket.context, ...ticket.related]
          .join(" ")
          .includes(selectedRouteReference),
    )
  }, [getRecords, selectedRouteReference])
  const relatedRouteSessions = useMemo(() => {
    if (!selectedRouteReference) return []
    const operateWorkspace = getWorkspaceDefinition("operate")
    const sessionsModule = operateWorkspace.modules.find(
      (module) => module.id === "driver-app",
    )
    if (!sessionsModule) return []
    return getRecords(
      "operate",
      sessionsModule.id,
      sessionsModule.records,
    ).filter((session) =>
      [session.name, session.context, ...session.related]
        .join(" ")
        .includes(selectedRouteReference),
    )
  }, [getRecords, selectedRouteReference])
  const selectedContractorId = isContractorDetails ? selectedRecord?.id ?? "" : ""
  const relatedContractorUsers = useMemo(() => {
    if (!selectedContractorId) return []
    const contractorWorkspace = getWorkspaceDefinition("contractors")
    const usersModule = contractorWorkspace.modules.find(
      (module) => module.id === "contractor-workspace",
    )
    if (!usersModule) return []
    return getRecords(
      "contractors",
      usersModule.id,
      usersModule.records,
    ).filter((record) => record.contractorId === selectedContractorId)
  }, [getRecords, selectedContractorId])
  const relatedContractorVehicles = useMemo(() => {
    if (!selectedContractorId) return []
    const fleetWorkspace = getWorkspaceDefinition("fleet")
    const vehiclesModule = fleetWorkspace.modules.find(
      (module) => module.id === "vehicles",
    )
    if (!vehiclesModule) return []
    return getRecords("fleet", vehiclesModule.id, vehiclesModule.records).filter(
      (record) => record.contractorId === selectedContractorId,
    )
  }, [getRecords, selectedContractorId])
  const relatedContractorDrivers = useMemo(() => {
    if (!selectedContractorId) return []
    const fleetWorkspace = getWorkspaceDefinition("fleet")
    const driversModule = fleetWorkspace.modules.find(
      (module) => module.id === "drivers",
    )
    if (!driversModule) return []
    return getRecords("fleet", driversModule.id, driversModule.records).filter(
      (record) => record.contractorId === selectedContractorId,
    )
  }, [getRecords, selectedContractorId])
  const relatedContractAreas = useMemo(() => {
    if (!selectedContractorId) return []
    const contractorWorkspace = getWorkspaceDefinition("contractors")
    const contractAreasModule = contractorWorkspace.modules.find(
      (module) => module.id === "contract-areas",
    )
    if (!contractAreasModule) return []
    return getRecords(
      "contractors",
      contractAreasModule.id,
      contractAreasModule.records,
    ).filter((record) => record.contractorId === selectedContractorId)
  }, [getRecords, selectedContractorId])
  const scopedRecords = useMemo(
    () =>
      projectScope === "all"
        ? activeRecords
        : activeRecords.filter((record) => {
            const recordScope = recordProject(record)
            return recordScope === "all" || recordScope === projectScope
          }),
    [activeRecords, projectScope],
  )
  const visibleScopedRecords = useMemo(
    () =>
      scopedRecords.filter(
        (record) => record.facts["Registry visibility"] !== "Soft deleted",
      ),
    [scopedRecords],
  )

  const filteredRecords = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    const matchingRecords = visibleScopedRecords.filter((record) => {
      const matchesStatus =
        businessFilters.statuses.length === 0 ||
        businessFilters.statuses.includes(record.status)
      const matchesSource =
        businessFilters.sources.length === 0 ||
        businessFilters.sources.includes(record.source)
      const matchesFreshness =
        businessFilters.freshness.length === 0 ||
        businessFilters.freshness.includes(record.freshness)
      const matchesContainerType = matchesFactFilter(
        record,
        businessFilters.containerTypes,
        "Container type",
      )
      const matchesWasteFraction = matchesFactFilter(
        record,
        businessFilters.wasteFractions,
        "Waste fractions",
        true,
      )
      const matchesVehicle = matchesFactFilter(
        record,
        businessFilters.vehicles,
        "Vehicle",
      )
      const matchesPickupSetting = matchesFactFilter(
        record,
        businessFilters.pickupSettings,
        "Pickup setting",
      )
      const matchesRouteScheme = matchesFactFilter(
        record,
        businessFilters.routeSchemes,
        "Route scheme",
      )
      const matchesCollectionCalendar = matchesFactFilter(
        record,
        businessFilters.collectionCalendars,
        "Collection calendar",
      )
      const matchesPropertyType = matchesFactFilter(
        record,
        businessFilters.propertyTypes,
        "Property type",
      )
      const matchesContractArea = matchesFactFilter(
        record,
        businessFilters.contractAreas,
        "Contract area",
      )
      const matchesServiceScope = matchesFactFilter(
        record,
        businessFilters.serviceScopes,
        "Service scope",
        true,
      )
      const matchesReliability = matchesFactFilter(
        record,
        businessFilters.reliabilityBands,
        "Reliability band",
      )
      const matchesQuery =
        !normalizedQuery ||
        [
          record.name,
          record.context,
          record.status,
          record.value,
          record.description,
          ...Object.values(record.facts),
          ...record.related,
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery)

      return (
        matchesStatus &&
        matchesSource &&
        matchesFreshness &&
        matchesContainerType &&
        matchesWasteFraction &&
        matchesVehicle &&
        matchesPickupSetting &&
        matchesRouteScheme &&
        matchesCollectionCalendar &&
        matchesPropertyType &&
        matchesContractArea &&
        matchesServiceScope &&
        matchesReliability &&
        matchesQuery
      )
    })
    if (viewOptions.ordering === "name") {
      return matchingRecords.sort((left, right) =>
        left.name.localeCompare(right.name),
      )
    }
    if (viewOptions.ordering === "status") {
      return matchingRecords.sort((left, right) =>
        left.status.localeCompare(right.status),
      )
    }
    return matchingRecords
  }, [businessFilters, query, viewOptions.ordering, visibleScopedRecords])
  const activeFilterChips = useMemo(() => {
    const chips: Array<{ key: string; value: string }> = []
    businessFilters.statuses.forEach((value) =>
      chips.push({ key: "Status", value }),
    )
    businessFilters.sources.forEach((value) =>
      chips.push({ key: "Source", value }),
    )
    businessFilters.freshness.forEach((value) =>
      chips.push({ key: "Freshness", value }),
    )
    businessFilters.containerTypes.forEach((value) =>
      chips.push({ key: "Container type", value }),
    )
    businessFilters.wasteFractions.forEach((value) =>
      chips.push({ key: "Waste fraction", value }),
    )
    businessFilters.vehicles.forEach((value) =>
      chips.push({ key: "Vehicle", value }),
    )
    businessFilters.pickupSettings.forEach((value) =>
      chips.push({ key: "Pickup setting", value }),
    )
    businessFilters.routeSchemes.forEach((value) =>
      chips.push({ key: "Route scheme", value }),
    )
    businessFilters.collectionCalendars.forEach((value) =>
      chips.push({ key: "Collection calendar", value }),
    )
    businessFilters.propertyTypes.forEach((value) =>
      chips.push({ key: "Property type", value }),
    )
    businessFilters.contractAreas.forEach((value) =>
      chips.push({ key: "Contract area", value }),
    )
    businessFilters.serviceScopes.forEach((value) =>
      chips.push({ key: "Service scope", value }),
    )
    businessFilters.reliabilityBands.forEach((value) =>
      chips.push({ key: "Reliability", value }),
    )
    if (!fixedProjectScope && projectScope !== "copenhagen") {
      chips.push({
        key: "Project",
        value: projectScope === "harbor" ? "Harbor Commercial" : "All permitted projects",
      })
    }
    return chips
  }, [businessFilters, fixedProjectScope, projectScope])
  const isQueueView = queueModuleIds.has(activeModule.id)
  const visibleTableColumnCount = isContainersAssetsView
    ? 2 +
      Number(viewOptions.showContainerType) +
      Number(viewOptions.showWasteFraction) +
      Number(viewOptions.showAddress) +
      Number(viewOptions.showFillLevel) +
      Number(viewOptions.showNextCollection) +
      Number(viewOptions.showProject)
    : 3 +
      Number(viewOptions.showContext) +
      Number(viewOptions.showUpdated)
  const isFleetPlanningView =
    workspace.id === "fleet" && activeModule.id === "vehicle-planning"
  const fleetPlanningTasks = useMemo<TimelineTask[]>(
    () =>
      isFleetPlanningView
        ? filteredRecords.map((record, index) => {
            const date = allocationDate(record, index)
            return {
              id: record.id,
              name: `${record.name} · ${record.context}`,
              startDate: date,
              endDate: date,
              status: /confirmed/i.test(record.status)
                ? "done"
                : /(conflict|attention|unavailable)/i.test(record.status)
                  ? "in-progress"
                  : "planned",
            }
          })
        : [],
    [filteredRecords, isFleetPlanningView],
  )

  useEffect(() => {
    const activeTab = tabsScrollRef.current?.querySelector<HTMLElement>('[data-state="active"]')
    activeTab?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" })
  }, [activeModuleId])

  const removeFilterChip = (key: string, value: string) => {
    const filterField = filterFieldByChipLabel[key]
    if (filterField) {
      setBusinessFilters((current) => ({
        ...current,
        [filterField]: current[filterField].filter(
          (candidate) => candidate !== value,
        ),
      }))
    }
    if (key === "Project") setSelectedProjectScope("copenhagen")
  }

  const handleModuleChange = (moduleId: string) => {
    setActiveModuleId(moduleId)
    setQuery("")
    setBusinessFilters(emptyBusinessFilters)
    setSelectedRecord(null)
    setPendingAction(null)
    setIsCreateOpen(false)
    router.push(
      getWorkspaceNavigationHref(navigationBasePath, workspace.id, moduleId),
      { scroll: false },
    )
  }

  const syncModuleFromQuery = useCallback((moduleId: string) => {
    setActiveModuleId(moduleId)
    setQuery("")
    setBusinessFilters(emptyBusinessFilters)
    setPendingAction(null)
    setIsCreateOpen(false)
  }, [])

  const resolveWorkspaceRecord = useCallback(
    (moduleId: string, recordId: string) => {
      const module = workspace.modules.find(
        (candidate) => candidate.id === moduleId,
      )
      if (!module) return null
      return (
        getRecords(workspace.id, module.id, module.records).find(
          (record) => record.id === recordId,
        ) ?? null
      )
    },
    [getRecords, workspace],
  )

  const openRecord = (record: BusinessRecord) => {
    setSelectedRecord(record)
    router.push(
      getWorkspaceNavigationHref(
        navigationBasePath,
        workspace.id,
        activeModule.id,
        record.id,
      ),
      { scroll: false },
    )
  }

  const closeRecord = () => {
    setSelectedRecord(null)
    router.replace(
      getWorkspaceNavigationHref(navigationBasePath, workspace.id, activeModule.id),
      { scroll: false },
    )
  }

  const updateRecord = (nextRecord: BusinessRecord) => {
    upsertRecord(workspace.id, activeModule.id, nextRecord)
    setSelectedRecord(nextRecord)
  }

  const requestRecordAction = (action: string) => {
    if (!selectedRecord) return
    setPendingAction({ record: selectedRecord, action })
  }

  const commitRecordAction = ({
    reason,
    effectiveDate,
  }: {
    reason: string
    effectiveDate: string
  }) => {
    if (!pendingAction) return

    const { record, action } = pendingAction
    const nextStatus = actionOutcome(activeModule, action, record.status)
    const createsCompanion = createsImmutableCompanion(activeModule, action)
    const event: AuditEvent = {
      id: `audit-${Date.now()}`,
      action,
      actor: "Olivia Larsen",
      at: "Now",
      reason,
      before: record.status,
      after: createsCompanion ? record.status : nextStatus,
      evidence: effectiveDate
        ? `Effective ${effectiveDate} · company and project scope validated`
        : "Company and project scope validated",
    }

    setAuditEvents((current) => ({
      ...current,
      [record.id]: [event, ...(current[record.id] ?? [])],
    }))

    if (
      workspace.id === "resources" &&
      activeModule.id === "containers" &&
      action.toLowerCase().includes("delete")
    ) {
      upsertRecord(workspace.id, activeModule.id, {
        ...record,
        updated: "Now",
        facts: {
          ...record.facts,
          "Registry visibility": "Soft deleted",
          "Deletion reason": reason,
          "Deleted by": "Olivia Larsen",
        },
        related: [`Deletion log ${event.id}`, ...record.related],
      })
      setSelectedRecord(null)
      setPendingAction(null)
      router.replace(
        getWorkspaceNavigationHref(
          navigationBasePath,
          workspace.id,
          activeModule.id,
        ),
        { scroll: false },
      )
      toast.success(`${record.name} soft-deleted`, {
        description: "The structured reason and actor were written to the deletion log.",
      })
      return
    }

    if (createsCompanion) {
      const isCorrection = createsCorrection(action)
      const companion: BusinessRecord = {
        id: `${activeModule.id}-${isCorrection ? "correction" : "event"}-${Date.now()}`,
        name: companionLabel(activeModule, action, record),
        context: record.context,
        status: activeModule.lifecycle[0] ?? "Draft",
        owner: "Olivia Larsen",
        value: isCorrection ? "Pending amount validation" : action,
        updated: "Now",
        description: isCorrection
          ? "Separate correction record created; the issued source document remains unchanged."
          : `Controlled ${action.toLowerCase()} record created without mutating its source.`,
        facts: {
          "Source record": record.id,
          "Requested by": "Olivia Larsen",
          Reason: reason,
          "Effective date": effectiveDate || "Immediate after validation",
          Integrity: isCorrection
            ? "Original document preserved"
            : activeModule.id === "studio"
              ? "Scenario and immutable plan remain separate"
              : "Append-only movement or child record",
        },
        related: [record.name, `Audit ${event.id}`],
        source: "Controlled workflow",
        freshness: "Now",
        allowedTransitions: activeModule.lifecycle.slice(1, 3),
        companyId: record.companyId ?? FIXTURE_COMPANY_ID,
        projectIds:
          record.projectIds ?? selectedProjectIds(projectScope, {}),
        recordKind: isCorrection ? "Correction" : "Controlled child record",
        relationRefs: [
          {
            fieldId: "sourceRecord",
            workspaceId: workspace.id,
            moduleId: activeModule.id,
            recordId: record.id,
            label: record.name,
          },
        ],
      }

      upsertRecord(workspace.id, activeModule.id, companion)
      setAuditEvents((current) => ({
        ...current,
        [companion.id]: [
          {
            ...event,
            id: `audit-companion-${Date.now()}`,
            before: "Absent",
            after: companion.status,
            evidence: `Created from ${record.id} · ${event.evidence}`,
          },
        ],
      }))
      toast.success(`${companion.name} created`, {
        description: isCorrection
          ? "The issued source record was preserved."
          : "A separate governed record and audit event were added.",
      })
    } else {
      const nextRecord: BusinessRecord = {
        ...record,
        status: nextStatus,
        updated: "Now",
        facts: {
          ...record.facts,
          "Last controlled action": action,
          "Action reason": reason,
          "Action actor": "Olivia Larsen",
          ...(effectiveDate ? { "Effective date": effectiveDate } : {}),
        },
        related: [`Audit ${event.id}`, ...record.related.filter((item) => item !== `Audit ${event.id}`)],
        allowedTransitions:
          nextStatus === record.status
            ? record.allowedTransitions
            : nextAllowedTransitions(activeModule, nextStatus),
      }
      updateRecord(nextRecord)
      toast.success(`${action} recorded`, {
        description:
          nextStatus === record.status
            ? "The action and evidence were appended without bypassing the lifecycle."
            : `${record.status} → ${nextStatus} · audit history updated`,
      })
    }

    setPendingAction(null)
  }

  const getFormRelationOptions = useCallback(
    (
      field: BusinessFormField,
      values: BusinessFormValues,
    ): readonly BusinessFormOption[] => {
      if (!field.relation) return field.options ?? []
      const resolved = resolveFormModule(
        field.relation.workspaceId,
        field.relation.moduleId,
      )
      if (!resolved) return []

      const permittedIds = field.relation.allowedRecordIds
        ? new Set(field.relation.allowedRecordIds)
        : null
      const permittedStatuses = field.relation.allowedStatuses
        ? new Set(
            field.relation.allowedStatuses.map((status) =>
              status.toLowerCase(),
            ),
          )
        : null
      const selectedProjectId =
        typeof values.projectId === "string" ? values.projectId : ""
      const relationRecords = getRecords(
        resolved.workspaceId,
        resolved.module.id,
        resolved.module.records,
      )

      return relationRecords
        .filter((record) => {
          if (
            formSchema?.recordKind === "Contract area assignment" &&
            field.id === "contractAreaId"
          ) {
            const assignedContractorId =
              typeof values.contractorId === "string" ? values.contractorId : ""
            return record.contractorId !== assignedContractorId
          }
          return true
        })
        .filter((record) => !permittedIds || permittedIds.has(record.id))
        .filter(
          (record) =>
            !permittedStatuses ||
            permittedStatuses.has(record.status.toLowerCase()),
        )
        .filter((record) => {
          if (
            field.id === "scheduleId" &&
            resolved.module.id === "finance"
          ) {
            if (!record.id.startsWith("billing-schedule-")) return false
          }
          if (
            field.id === "templateId" &&
            resolved.module.id === "templates"
          ) {
            if (!record.id.startsWith("template-")) return false
          }
          if (field.id === "projectId") {
            if (!record.id.startsWith("project-")) return false
            if (projectScope === "all") return true
            return record.id ===
              (projectScope === "harbor"
                ? FIXTURE_PROJECT_IDS.harbor
                : FIXTURE_PROJECT_IDS.copenhagen)
          }
          if (/(company|tenant)Id$/i.test(field.id)) {
            if (
              !record.id.startsWith("company-") &&
              record.submittedValues?.partyType !== "company"
            ) {
              return false
            }
          }
          if (resolved.module.id === "contacts") {
            const createdPartyType = record.submittedValues?.partyType
            const isCompany =
              record.id.startsWith("company-") || createdPartyType === "company"
            const isPerson =
              record.id.startsWith("contact-") || createdPartyType === "person"

            if (
              [
                "customerId",
                "payerId",
                "ownerCustomerId",
                "payerCustomerId",
                "connectedCompanyId",
              ].includes(field.id)
            ) {
              if (!isCompany) return false
            }
            if (
              (field.id === "recipientContactId" ||
                /ContactId$/i.test(field.id)) &&
              !isPerson
            ) {
              return false
            }
          }

          if (
            resolved.workspaceId === "fleet" &&
            resolved.module.id === "vehicles"
          ) {
            const resourceKind = record.submittedValues?.resourceKind
            const isTrailer =
              resourceKind === "trailer" || record.id.startsWith("trailer-")
            if (field.id === "trailerId" && !isTrailer) return false
            if (field.id === "vehicleId" && isTrailer) return false
          }

          if (
            selectedProjectId &&
            record.projectIds?.length &&
            !record.projectIds.includes(selectedProjectId)
          ) {
            return false
          }

          if (projectScope !== "all" && record.projectIds?.length) {
            const requiredProjectId =
              projectScope === "harbor"
                ? FIXTURE_PROJECT_IDS.harbor
                : FIXTURE_PROJECT_IDS.copenhagen
            return record.projectIds.includes(requiredProjectId)
          }
          return true
        })
        .map((record) => ({
          value: record.id,
          label: `${record.name} · ${record.context} · ${record.status}`,
        }))
    },
    [formSchema?.recordKind, getRecords, projectScope],
  )

  const formInitialValues = useMemo<BusinessFormValues>(
    () => ({
      companyId: FIXTURE_COMPANY_ID,
      ...(projectScope === "all"
        ? {}
        : {
            projectId:
              projectScope === "harbor"
                ? FIXTURE_PROJECT_IDS.harbor
                : FIXTURE_PROJECT_IDS.copenhagen,
          }),
      ...(relatedCreateTarget?.initialValues ?? {}),
    }),
    [projectScope, relatedCreateTarget],
  )

  const validateFormValues = useCallback(
    (values: BusinessFormValues) => {
      if (!formSchema) return {}
      const errors: Record<string, string> = {}
      const fields = formSchema.sections.flatMap((section) => section.fields)
      const uniqueFields = fields.filter(
        (field) =>
          field.id === formSchema.nameField ||
          field.id === "barcode" ||
          /(code|reference|registrationNumber|externalId)$/i.test(field.id),
      )

      for (const field of uniqueFields) {
        const value = values[field.id]
        if (typeof value !== "string" || !value.trim()) continue
        const normalizedValue = value.trim().toLowerCase()
        const duplicate = formTargetRecords.some((record) => {
          const submittedValue = record.submittedValues?.[field.id]
          if (
            typeof submittedValue === "string" &&
            submittedValue.trim().toLowerCase() === normalizedValue
          ) {
            return true
          }
          const fixtureValue = record.facts[field.label]
          if (
            typeof fixtureValue === "string" &&
            fixtureValue.trim().toLowerCase() === normalizedValue
          ) {
            return true
          }
          return (
            field.id === formSchema.nameField &&
            record.name.trim().toLowerCase() === normalizedValue
          )
        })
        if (duplicate) {
          errors[field.id] = `${field.label} already exists in this module.`
        }
      }

      const selectedProjectId = values.projectId
      if (
        typeof selectedProjectId === "string" &&
        projectScope !== "all" &&
        selectedProjectId !==
          (projectScope === "harbor"
            ? FIXTURE_PROJECT_IDS.harbor
            : FIXTURE_PROJECT_IDS.copenhagen)
      ) {
        errors.projectId = "The selected project is outside the current workspace scope."
      }

      if (
        formSchema.key === "resources.containers" &&
        typeof selectedProjectId === "string"
      ) {
        const selectedContainerType =
          typeof values.containerType === "string"
            ? containerTypes.find((item) => item.id === values.containerType)
            : undefined
        if (
          selectedContainerType?.projectIds.length &&
          !selectedContainerType.projectIds.includes(selectedProjectId)
        ) {
          errors.containerType =
            "This container type is not available in the selected project."
        }

        for (const fieldId of ["wasteFraction", "secondaryWasteFraction"]) {
          const fractionId = values[fieldId]
          const selectedFraction =
            typeof fractionId === "string"
              ? wasteFractions.find((item) => item.id === fractionId)
              : undefined
          if (
            selectedFraction?.projectIds.length &&
            !selectedFraction.projectIds.includes(selectedProjectId)
          ) {
            errors[fieldId] =
              "This waste fraction is not available in the selected project."
          }
        }

        const selectedMeasurementSetting =
          typeof values.measurementSetting === "string"
            ? measurementSettings.find(
                (item) => item.id === values.measurementSetting,
              )
            : undefined
        if (
          selectedMeasurementSetting &&
          selectedMeasurementSetting.projectId !== selectedProjectId
        ) {
          errors.measurementSetting =
            "This measurement setting belongs to another project."
        }
      }

      if (
        formSchema.key === "customers.contacts" &&
        values.partyType === "person" &&
        !values.email &&
        !values.phone
      ) {
        errors.email = "A person needs an email address or phone number."
      }

      if (
        formSchema.key === "fleet.vehicle-planning" &&
        (values.allocationAction === "allocate" ||
          values.allocationAction === "change")
      ) {
        const hasRoute = typeof values.routeId === "string" && Boolean(values.routeId)
        const hasScheme =
          typeof values.schemeId === "string" && Boolean(values.schemeId)
        if (hasRoute === hasScheme) {
          errors.routeId = "Select either one route or one route scheme."
          errors.schemeId = "Select either one route or one route scheme."
        }
      }

      return errors
    },
    [
      containerTypes,
      formSchema,
      formTargetRecords,
      measurementSettings,
      projectScope,
      wasteFractions,
    ],
  )

  const getFormReviewSummary = useCallback(
    (values: BusinessFormValues) => {
      if (!formSchema?.execution) return []
      const projectIds = selectedProjectIds(projectScope, values)

      if (formSchema.key === "commercial.billing") {
        const eventsTarget = resolveFormModule("commercial", "events")
        const events = eventsTarget
          ? getRecords(
              eventsTarget.workspaceId,
              eventsTarget.module.id,
              eventsTarget.module.records,
            ).filter(
              (record) =>
                !record.projectIds?.length ||
                record.projectIds.some((projectId) =>
                  projectIds.includes(projectId),
                ),
            )
          : []
        const eligible = events.filter((record) =>
          /ready/i.test(record.status),
        ).length
        const blocked = events.filter((record) =>
          /blocked|failed/i.test(record.status),
        ).length

        return [
          { label: "Eligible billable events", value: String(eligible) },
          { label: "Blocked or failed events", value: String(blocked) },
          {
            label: "Execution",
            value: values.dryRun === true ? "Preview only" : "Create draft invoices",
          },
        ]
      }

      const linkedRecordCount = formSchema.sections
        .flatMap((section) => section.fields)
        .filter(
          (field) =>
            field.relation &&
            typeof values[field.id] === "string" &&
            Boolean(values[field.id]),
        ).length

      return [
        { label: "Linked records", value: String(linkedRecordCount) },
        { label: "Project scope", value: projectScopeLabel(projectIds) },
        {
          label: "Execution policy",
          value: formSchema.execution.kind.replaceAll("-", " "),
        },
      ]
    },
    [formSchema, getRecords, projectScope],
  )

  const handleFormSubmit = (values: BusinessFormValues) => {
    if (!formSchema?.execution) return

    if (formSchema.recordKind === "Contract area assignment") {
      const contractAreaId =
        typeof values.contractAreaId === "string" ? values.contractAreaId : ""
      const contractorId =
        typeof values.contractorId === "string" ? values.contractorId : ""
      const contractAreaTarget = resolveFormModule("contractors", "contract-areas")
      const contractorTarget = resolveFormModule("contractors", "contractors")
      const contractArea = contractAreaTarget
        ? getRecords(
            contractAreaTarget.workspaceId,
            contractAreaTarget.module.id,
            contractAreaTarget.module.records,
          ).find((record) => record.id === contractAreaId)
        : undefined
      const contractor = contractorTarget
        ? getRecords(
            contractorTarget.workspaceId,
            contractorTarget.module.id,
            contractorTarget.module.records,
          ).find((record) => record.id === contractorId)
        : undefined

      if (!contractAreaTarget || !contractArea || !contractor) {
        toast.error("Select an available contract area.")
        return
      }

      const previousContractor = contractArea.facts.Contractor || "Unassigned"
      const effectiveFrom =
        typeof values.effectiveFrom === "string" ? values.effectiveFrom : "Now"
      const assignmentReason =
        typeof values.reason === "string" ? values.reason : "Contract assignment"
      const updatedArea: BusinessRecord = {
        ...contractArea,
        context: contractArea.context.replace(previousContractor, contractor.name),
        updated: "Now",
        freshness: "Now",
        contractorId,
        facts: {
          ...contractArea.facts,
          Contractor: contractor.name,
          "Previous contractor": previousContractor,
          "Assignment effective from": effectiveFrom,
          "Assignment reason": assignmentReason,
        },
        related: [
          `Contractor ${contractor.name}`,
          ...contractArea.related.filter((item) => !item.startsWith("Contractor ")),
        ],
        submittedValues: {
          ...contractArea.submittedValues,
          contractorId,
          effectiveFrom: values.effectiveFrom,
          reason: values.reason,
        },
        relationRefs: [
          ...(contractArea.relationRefs ?? []).filter(
            (relation) => relation.fieldId !== "contractorId",
          ),
          {
            fieldId: "contractorId",
            workspaceId: "contractors",
            moduleId: "contractors",
            recordId: contractor.id,
            label: contractor.name,
          },
        ],
      }
      const assignmentEvent: AuditEvent = {
        id: `audit-contract-area-assignment-${Date.now()}`,
        action: "Assign contract area",
        actor: "Olivia Larsen",
        at: "Now",
        reason: assignmentReason,
        before: previousContractor,
        after: contractor.name,
        evidence: `Effective ${effectiveFrom} · existing Contract Area retained`,
      }

      upsertRecord("contractors", "contract-areas", updatedArea)
      setAuditEvents((current) => ({
        ...current,
        [updatedArea.id]: [assignmentEvent, ...(current[updatedArea.id] ?? [])],
      }))
      setIsCreateOpen(false)
      setRelatedCreateTarget(null)
      toast.success("Contract area assigned", {
        description: `${contractArea.name} is now assigned to ${contractor.name}.`,
      })
      return
    }

    if (formSchema.execution.kind === "preview") {
      setIsCreateOpen(false)
      setRelatedCreateTarget(null)
      toast.success(formSchema.recordKind, {
        description: formSchema.execution.completionMessage,
      })
      if (formSchema.key === "customers.citizen-portal") {
        router.push("/portal")
      }
      return
    }

    const requestedTarget =
      formSchema.execution.target ??
      ({
        workspaceId: relatedCreateModule?.workspaceId ?? workspace.id,
        moduleId: relatedCreateModule?.module.id ?? activeModule.id,
      } as const)
    const resolvedTarget = resolveFormModule(
      requestedTarget.workspaceId,
      requestedTarget.moduleId,
    )
    if (!resolvedTarget) {
      toast.error("This workflow target is not available.")
      return
    }

    const fields = formSchema.sections.flatMap((section) => section.fields)
    const fieldById = new Map(fields.map((field) => [field.id, field]))
    const relationRefs: NonNullable<BusinessRecord["relationRefs"]> = []
    const facts: Record<string, string> = {}

    const splitMultiValue = (value: string) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)

    const displayFormValue = (field: BusinessFormField, value: string | boolean) => {
      if (typeof value === "boolean") return value ? "Yes" : "No"
      const options = field.relation
        ? getFormRelationOptions(field, values)
        : field.options ?? []
      if (field.type === "multiselect") {
        return splitMultiValue(value)
          .map(
            (item) =>
              options.find((option) => option.value === item)?.label ?? item,
          )
          .join(" · ")
      }
      return options.find((option) => option.value === value)?.label ?? value
    }

    for (const field of fields) {
      const value = values[field.id]
      if (value === undefined || value === "") continue
      const displayValue = displayFormValue(field, value)
      facts[field.label] = displayValue

      if (field.relation && typeof value === "string") {
        const relationTarget = resolveFormModule(
          field.relation.workspaceId,
          field.relation.moduleId,
        )
        const relationOptions = getFormRelationOptions(field, values)
        const relationRecordIds =
          field.type === "multiselect" ? splitMultiValue(value) : [value]
        for (const recordId of relationRecordIds) {
          relationRefs.push({
            fieldId: field.id,
            workspaceId: relationTarget?.workspaceId ?? field.relation.workspaceId,
            moduleId: relationTarget?.module.id ?? field.relation.moduleId,
            recordId,
            label:
              relationOptions.find((option) => option.value === recordId)
                ?.label ?? recordId,
          })
        }
      }
    }

    const now = Date.now()
    const nameField = formSchema.nameField
      ? fieldById.get(formSchema.nameField)
      : undefined
    const submittedNameValue =
      nameField && values[nameField.id] !== undefined
        ? displayFormValue(nameField, values[nameField.id])
        : ""
    const nameValue =
      submittedNameValue ||
      (formSchema.key === "resources.containers"
        ? `BIN-${String(now).slice(-5)}`
        : "")
    if (
      formSchema.key === "resources.containers" &&
      nameField &&
      !submittedNameValue
    ) {
      facts[nameField.label] = nameValue
    }
    const routeSchemeField =
      formSchema.key === "route-studio.routes" ? fieldById.get("schemeId") : undefined
    const routeSchemeName =
      routeSchemeField && values.schemeId !== undefined
        ? displayFormValue(routeSchemeField, values.schemeId)
        : ""
    const routeDate =
      typeof values.operatingDate === "string" ? values.operatingDate : ""
    const recordName =
      formSchema.key === "route-studio.routes"
        ? `${routeSchemeName || "Route"} · ${routeDate || "scheduled"}`
        : formSchema.mode === "action"
        ? `${formSchema.recordKind} · ${nameValue || "submitted"}`
        : nameValue || `${formSchema.recordKind} · ${Date.now()}`
    const contextValues = (formSchema.contextFieldIds ?? [])
      .map((fieldId) => {
        const field = fieldById.get(fieldId)
        const value = values[fieldId]
        if (!field || value === undefined || value === "") return ""
        return displayFormValue(field, value)
      })
      .filter(Boolean)
    const projectIds = selectedProjectIds(projectScope, values)
    const newRecord: BusinessRecord = {
      id: `${resolvedTarget.module.id}-${formSchema.recordKind
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")}-${now}`,
      name: recordName,
      context: contextValues.join(" · ") || projectScopeLabel(projectIds),
      status: initialFormStatus(resolvedTarget.module, formSchema, values),
      owner: "Olivia Larsen",
      value: formSchema.execution.resultValue ?? formSchema.submitLabel,
      updated: "Now",
      description: formSchema.description,
      facts: {
        Scope: projectScopeLabel(projectIds),
        "Record kind": formSchema.recordKind,
        "Execution policy": formSchema.execution.kind.replaceAll("-", " "),
        "Submitted by": "Olivia Larsen",
        ...facts,
      },
      related: [
        ...relationRefs.map((relation) => relation.label),
        "Audit history created",
      ],
      source:
        formSchema.execution.kind === "send-message"
          ? "Customer communication workflow"
          : formSchema.execution.kind === "append-event"
            ? "Controlled operational action"
            : formSchema.execution.kind === "start-workflow"
              ? "Governed workflow"
              : "Office workspace",
      freshness: "Now",
      allowedTransitions: resolvedTarget.module.lifecycle.slice(1, 3),
      companyId: FIXTURE_COMPANY_ID,
      projectIds,
      contractorId:
        typeof values.contractorId === "string" && values.contractorId
          ? values.contractorId
          : undefined,
      recordKind: formSchema.recordKind,
      submittedValues: values,
      relationRefs,
    }
    const creationEvent: AuditEvent = {
      id: `audit-form-${now}`,
      action: formSchema.submitLabel,
      actor: "Olivia Larsen",
      at: "Now",
      reason: preferredReason(values),
      before: "Absent",
      after: newRecord.status,
      evidence: `${relationRefs.length} linked records · ${projectScopeLabel(
        projectIds,
      )} scope validated`,
    }

    upsertRecord(resolvedTarget.workspaceId, resolvedTarget.module.id, newRecord)
    setAuditEvents((current) => ({
      ...current,
      [newRecord.id]: [creationEvent],
    }))
    setIsCreateOpen(false)
    setRelatedCreateTarget(null)

    if (
      resolvedTarget.workspaceId === workspace.id &&
      resolvedTarget.module.id === activeModule.id
    ) {
      setSelectedRecord(newRecord)
      router.push(
        getWorkspaceNavigationHref(
          navigationBasePath,
          workspace.id,
          activeModule.id,
          newRecord.id,
        ),
        { scroll: false },
      )
    }

    toast.success(
      formSchema.mode === "action"
        ? `${formSchema.recordKind} recorded`
        : `${formSchema.recordKind} created`,
      { description: formSchema.execution.completionMessage },
    )
  }

  const requestContractorRelatedCreate = (
    target: "user" | "vehicle" | "driver" | "contract-area",
  ) => {
    if (!selectedRecord) return
    const contractorId = selectedRecord.id

    if (target === "user") {
      setRelatedCreateTarget({
        workspaceId: "contractors",
        moduleId: "contractor-workspace",
        initialValues: {
          contractorId,
          contractAreaId: relatedContractAreas[0]?.id ?? "",
          invitedBy: "Olivia Larsen",
        },
      })
      return
    }

    if (target === "vehicle") {
      setRelatedCreateTarget({
        workspaceId: "fleet",
        moduleId: "vehicles",
        initialValues: {
          contractorId,
          ownershipType: "contractor",
          resourceKind: "powered-vehicle",
        },
      })
      return
    }

    if (target === "driver") {
      setRelatedCreateTarget({
        workspaceId: "fleet",
        moduleId: "drivers",
        initialValues: {
          contractorId,
          employmentType: "contractor",
        },
      })
      return
    }

    setRelatedCreateTarget({
      workspaceId: "contractors",
      moduleId: "contract-areas",
      initialValues: {
        contractorId,
        effectiveFrom: localDateInputValue(),
      },
      schemaOverride: {
        key: "contractors.contract-areas",
        mode: "action",
        recordKind: "Contract area assignment",
        title: "Assign contract area",
        description:
          `Link an existing contract area to ${selectedRecord.name}. The contract area remains the same record; this updates its effective contractor relationship.`,
        submitLabel: "Assign contract area",
        contextFieldIds: ["contractorId", "contractAreaId", "effectiveFrom"],
        execution: {
          kind: "append-event",
          sourceField: "contractAreaId",
          reviewBeforeSubmit: true,
          completionMessage: "The contract area relationship was updated with audit history.",
        },
        sections: [
          {
            id: "assignment",
            title: "Contract area relationship",
            description:
              "The contractor is fixed from the current page. Choose an existing area that is not already assigned to this contractor.",
            fields: [
              {
                id: "contractorId",
                label: "Contractor",
                type: "select",
                required: true,
                readOnly: true,
                relation: { workspaceId: "contractors", moduleId: "contractors" },
              },
              {
                id: "contractAreaId",
                label: "Contract area",
                type: "select",
                required: true,
                relation: { workspaceId: "contractors", moduleId: "contract-areas" },
              },
              {
                id: "effectiveFrom",
                label: "Effective from",
                type: "date",
                required: true,
              },
              {
                id: "reason",
                label: "Assignment reason",
                type: "textarea",
                required: true,
                placeholder: "Why is this area being assigned or transferred?",
              },
            ],
          },
        ],
      },
    })
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 bg-background mx-2 my-2 border border-sidebar rounded-lg min-w-0">
      {isRouteDetails && selectedRecord ? (
        <RouteDetailsPage
          module={activeModule}
          record={selectedRecord}
          tickets={relatedRouteTickets}
          sessions={relatedRouteSessions}
          onBack={closeRecord}
          onAction={requestRecordAction}
        />
      ) : isContractorDetails && selectedRecord ? (
        <ContractorDetailsPage
          record={selectedRecord}
          users={relatedContractorUsers}
          vehicles={relatedContractorVehicles}
          drivers={relatedContractorDrivers}
          contractAreas={relatedContractAreas}
          onBack={closeRecord}
          onCreate={requestContractorRelatedCreate}
        />
      ) : (
        <>
      <header className="flex flex-col border-b border-border/40">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
          <div className="flex items-center gap-3 min-w-0">
            <SidebarTrigger className="h-8 w-8 rounded-lg hover:bg-accent text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-base font-medium text-foreground">
                {workspaceLabel ?? workspace.label}
              </p>
            </div>
          </div>
          {(isContainersAssetsView ||
            showExportAction ||
            (showPrimaryAction && canOpenBusinessForm)) && (
            <div className="flex items-center gap-2">
              {isContainersAssetsView && (
                <Button variant="outline" size="sm" asChild>
                  <Link href="/settings?pane=asset-management&from=%2Fresources%3Fmodule%3Dcontainers">
                    <Gear className="h-4 w-4" />
                    <span className="hidden sm:inline">Asset settings</span>
                  </Link>
                </Button>
              )}
              {showExportAction && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    toast.success("Export queued", {
                      description: `${activeModule.title} · current filters · audit recorded`,
                    })
                  }
                >
                  <DownloadSimple className="h-4 w-4" />
                  <span className="hidden sm:inline">Export</span>
                </Button>
              )}
              {showPrimaryAction && canOpenBusinessForm && formSchema && (
                <Button size="sm" onClick={() => setIsCreateOpen(true)}>
                  <Plus className="h-4 w-4" weight="bold" />
                  <span className="hidden sm:inline">{formSchema.submitLabel}</span>
                  <span className="sm:hidden">Action</span>
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 px-4 py-3">
          {workspace.modules.length > 1 && (
            <div
              ref={tabsScrollRef}
              className="flex items-center gap-1 overflow-x-auto pb-1"
            >
              <Tabs value={activeModule.id} onValueChange={handleModuleChange}>
                <TabsList className="inline-flex h-8 bg-muted rounded-full px-1 py-0.5 text-xs border border-border/50">
                  {primaryModules.map((module) => (
                    <TabsTrigger
                      key={module.id}
                      value={module.id}
                      className="rounded-full px-3 whitespace-nowrap"
                    >
                      {module.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              {secondaryModules.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-8 shrink-0 rounded-full border border-border/50 px-3 text-xs font-normal",
                        activeSecondaryModule && "bg-muted font-medium text-foreground",
                      )}
                    >
                      {activeSecondaryModule?.label ?? "More"}
                      <CaretDown className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-56">
                    {secondaryModules.map((module) => (
                      <DropdownMenuItem
                        key={module.id}
                        className={cn(
                          module.id === activeModule.id && "bg-accent font-medium",
                        )}
                        onSelect={() => handleModuleChange(module.id)}
                      >
                        {module.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}

          {showFilters && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-1 flex-wrap items-center gap-2 min-w-[260px]">
                <div className="relative min-w-[220px] max-w-sm flex-1">
                  <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={`Search ${activeModule.entityLabel.toLowerCase()}s`}
                    className="h-8 pl-9 text-sm"
                  />
                </div>
                <BusinessFilterPopover
                  records={visibleScopedRecords}
                  value={businessFilters}
                  onChange={setBusinessFilters}
                  variant={
                    isContainersAssetsView
                      ? "containers"
                      : workspace.id === "contractors" &&
                          activeModule.id === "contractors"
                        ? "contractors"
                        : "default"
                  }
                />
                <BusinessViewOptionsPopover
                  value={viewOptions}
                  onChange={setViewOptions}
                  variant={isContainersAssetsView ? "containers" : "default"}
                />
              </div>

              <div className="flex items-center gap-2">
                {!fixedProjectScope && (
                  <Select
                    value={projectScope}
                    onValueChange={(value: ProjectScope) => {
                      setSelectedProjectScope(value)
                      setBusinessFilters(emptyBusinessFilters)
                    }}
                  >
                    <SelectTrigger className="h-8 w-[190px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="copenhagen">Copenhagen Central</SelectItem>
                      <SelectItem value="harbor">Harbor Commercial</SelectItem>
                      <SelectItem value="all">All permitted projects</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                {showDeepLinks && activeModule.deepLink && (
                  <Button variant="outline" size="sm" asChild>
                    <Link href={activeModule.deepLink}>
                      Open full view
                      <ArrowSquareOut className="h-4 w-4" />
                    </Link>
                  </Button>
                )}
              </div>
            </div>
          )}
          {showFilters && (
            <ChipOverflow
              chips={activeFilterChips}
              onRemove={removeFilterChip}
              maxVisible={4}
            />
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <div className="mx-auto max-w-[1500px] space-y-4">
          <section className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">{activeModule.title}</h1>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`About ${activeModule.title}`}
                  >
                    <Info className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm text-xs">
                  {activeModule.description}
                </TooltipContent>
              </Tooltip>
            </div>
            {showPrimaryAction &&
              formSchema?.mode === "disabled" &&
              formSchema.disabledReason && (
                <p className="mt-2 flex max-w-4xl items-start gap-2 border-l-2 border-border pl-3 text-xs leading-5 text-muted-foreground">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                  {formSchema.disabledReason}
                </p>
              )}
          </section>

          <section className="overflow-hidden rounded-xl border border-border/60">
            <div className="border-b border-border px-4 py-2">
              <p className="text-xs text-muted-foreground">
                {filteredRecords.length === visibleScopedRecords.length
                  ? `${filteredRecords.length} records`
                  : `${filteredRecords.length} of ${visibleScopedRecords.length} records`}
                {fixedScopeLabel ? ` · ${fixedScopeLabel}` : ""}
              </p>
            </div>

            {isFleetPlanningView ? (
              <div className="p-4">
                <TimelineGantt
                  title="Availability and allocation"
                  emptyLabel="No allocations match the current filters"
                  tasks={fleetPlanningTasks}
                  onTaskSelect={(taskId) => {
                    const record = filteredRecords.find((item) => item.id === taskId)
                    if (record) openRecord(record)
                  }}
                />
              </div>
            ) : isQueueView ? (
              <div className="divide-y divide-border/60 p-1">
                {filteredRecords.length === 0 ? (
                  <div className="flex h-52 flex-col items-center justify-center gap-2 text-center">
                    <MagnifyingGlass className="h-6 w-6 text-muted-foreground" />
                    <p className="text-sm font-medium">No matching records</p>
                    <p className="text-xs text-muted-foreground">
                      Try a different search or status filter.
                    </p>
                  </div>
                ) : (
                  filteredRecords.map((record) => (
                    <TaskRowBase
                      key={record.id}
                      checked={/(completed|resolved|approved|closed|certified)/i.test(record.status)}
                      title={record.name}
                      subtitle={[
                        viewOptions.showContext ? record.context : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      titleSuffix={
                        <Badge
                          variant="outline"
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[11px] font-medium",
                            statusClasses(record.status),
                          )}
                        >
                          {record.status}
                        </Badge>
                      }
                      meta={viewOptions.showUpdated ? (
                        <span className="hidden text-muted-foreground sm:inline">{record.updated}</span>
                      ) : undefined}
                      className={cn(
                        "rounded-none px-3",
                        viewOptions.density === "compact" ? "py-2" : "py-3",
                      )}
                      onClick={() => openRecord(record)}
                    />
                  ))
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      {isContainersAssetsView ? (
                        <>
                          <TableHead>Container ID</TableHead>
                          <TableHead>Status</TableHead>
                          {viewOptions.showContainerType && (
                            <TableHead>Container type</TableHead>
                          )}
                          {viewOptions.showWasteFraction && (
                            <TableHead>Waste fraction</TableHead>
                          )}
                          {viewOptions.showAddress && (
                            <TableHead>Address / location</TableHead>
                          )}
                          {viewOptions.showFillLevel && (
                            <TableHead>Fill level / sensor</TableHead>
                          )}
                          {viewOptions.showNextCollection && (
                            <TableHead>Next collection</TableHead>
                          )}
                          {viewOptions.showProject && <TableHead>Project</TableHead>}
                        </>
                      ) : (
                        <>
                          <TableHead>{activeModule.entityLabel}</TableHead>
                          {viewOptions.showContext && (
                            <TableHead>{activeModule.contextLabel}</TableHead>
                          )}
                          <TableHead>Status</TableHead>
                          <TableHead>{activeModule.valueLabel}</TableHead>
                          {viewOptions.showUpdated && <TableHead>Updated</TableHead>}
                        </>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredRecords.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={visibleTableColumnCount}
                          className="h-52 text-center"
                        >
                          <div className="flex flex-col items-center gap-2">
                            <MagnifyingGlass className="h-6 w-6 text-muted-foreground" />
                            <p className="text-sm font-medium">No matching records</p>
                            <p className="text-xs text-muted-foreground">
                              Try a different search or status filter.
                            </p>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredRecords.map((record) => (
                        <TableRow
                          key={record.id}
                          role="button"
                          tabIndex={0}
                          aria-label={`Open ${record.name}`}
                          className="cursor-pointer hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                          onClick={() => openRecord(record)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault()
                              openRecord(record)
                            }
                          }}
                        >
                          {isContainersAssetsView ? (
                            <>
                              <TableCell
                                className={cn(
                                  "min-w-[170px]",
                                  viewOptions.density === "compact" && "py-2",
                                )}
                              >
                                <div className="space-y-1">
                                  <p className="whitespace-nowrap text-sm font-medium text-foreground">
                                    {recordFactValue(record, "Container ID", record.name)}
                                  </p>
                                  {viewOptions.showDescription && (
                                    <p className="max-w-[240px] truncate text-xs text-muted-foreground">
                                      {record.description}
                                    </p>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    "whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
                                    statusClasses(record.status),
                                  )}
                                >
                                  {record.status}
                                </Badge>
                              </TableCell>
                              {viewOptions.showContainerType && (
                                <TableCell className="min-w-[190px] text-sm text-muted-foreground">
                                  {recordFactValue(record, "Container type")}
                                </TableCell>
                              )}
                              {viewOptions.showWasteFraction && (
                                <TableCell className="min-w-[130px] text-sm text-muted-foreground">
                                  {recordFactValue(record, "Waste fractions")}
                                </TableCell>
                              )}
                              {viewOptions.showAddress && (
                                <TableCell className="min-w-[230px]">
                                  <div className="space-y-1">
                                    <p className="text-sm text-foreground">
                                      {recordFactValue(record, "Address", record.context)}
                                    </p>
                                    {recordFactValue(record, "Curb location") !== "—" && (
                                      <p className="text-xs text-muted-foreground">
                                        {recordFactValue(record, "Curb location")}
                                      </p>
                                    )}
                                  </div>
                                </TableCell>
                              )}
                              {viewOptions.showFillLevel && (
                                <TableCell className="min-w-[150px]">
                                  <ContainerSensorState record={record} />
                                </TableCell>
                              )}
                              {viewOptions.showNextCollection && (
                                <TableCell className="min-w-[145px] whitespace-nowrap text-sm text-muted-foreground">
                                  {recordFactValue(record, "Next collection")}
                                </TableCell>
                              )}
                              {viewOptions.showProject && (
                                <TableCell className="min-w-[165px] whitespace-nowrap text-sm text-muted-foreground">
                                  {recordFactValue(record, "Project")}
                                </TableCell>
                              )}
                            </>
                          ) : (
                            <>
                              <TableCell
                                className={cn(
                                  "min-w-[240px]",
                                  viewOptions.density === "compact" && "py-2",
                                )}
                              >
                                <div className="space-y-1">
                                  <p className="text-sm font-medium text-foreground">{record.name}</p>
                                  {viewOptions.showDescription && (
                                    <p className="max-w-[340px] truncate text-xs text-muted-foreground">
                                      {record.description}
                                    </p>
                                  )}
                                </div>
                              </TableCell>
                              {viewOptions.showContext && (
                                <TableCell className="min-w-[220px] text-sm text-muted-foreground">
                                  {record.context}
                                </TableCell>
                              )}
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    "rounded-full px-2 py-0.5 text-[11px] font-medium",
                                    statusClasses(record.status),
                                  )}
                                >
                                  {record.status}
                                </Badge>
                              </TableCell>
                              <TableCell className="min-w-[150px]">
                                <RecordValue record={record} />
                              </TableCell>
                              {viewOptions.showUpdated && (
                                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                                  {record.updated}
                                </TableCell>
                              )}
                            </>
                          )}
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>

        </div>
      </div>

      {isTicketDetails && selectedRecord ? (
        <TicketDetailsDialog record={selectedRecord} onClose={closeRecord} />
      ) : isContainersAssetsView ? (
        <ContainerDetailsSheet
          key={selectedRecord?.id ?? "closed-container"}
          module={activeModule}
          record={selectedRecord}
          onClose={closeRecord}
          onAction={requestRecordAction}
        />
      ) : (
        <RecordDetailsDialog
          module={activeModule}
          record={selectedRecord}
          onClose={closeRecord}
          onAction={requestRecordAction}
          showDeepLinks={showDeepLinks}
        />
      )}
        </>
      )}
      <ActionDecisionDialog
        module={activeModule}
        pendingAction={pendingAction}
        onOpenChange={(open) => !open && setPendingAction(null)}
        onConfirm={commitRecordAction}
      />
      {!relatedCreateTarget &&
        activeModuleFormSchema?.execution &&
        activeModuleFormSchema.mode !== "disabled" && (
        <BusinessRecordFormDialog
          schema={activeModuleFormSchema}
          open={isCreateOpen}
          onOpenChange={setIsCreateOpen}
          onSubmit={handleFormSubmit}
          relationOptions={getFormRelationOptions}
          initialValueOverrides={formInitialValues}
          validateValues={validateFormValues}
          reviewSummary={getFormReviewSummary}
        />
      )}
      {relatedCreateTarget &&
        formSchema?.execution &&
        formSchema.mode !== "disabled" && (
          <BusinessRecordFormDialog
            schema={formSchema}
            open
            onOpenChange={(open) => {
              if (!open) setRelatedCreateTarget(null)
            }}
            onSubmit={handleFormSubmit}
            relationOptions={getFormRelationOptions}
            initialValueOverrides={formInitialValues}
            validateValues={validateFormValues}
            reviewSummary={getFormReviewSummary}
          />
        )}
      <Suspense fallback={null}>
        <WorkspaceQuerySync
          workspace={workspace}
          onModuleChange={syncModuleFromQuery}
          onRecordOpen={setSelectedRecord}
          resolveRecord={resolveWorkspaceRecord}
        />
      </Suspense>
    </div>
  )
}

function RecordDetailsDialog({
  module,
  record,
  onClose,
  onAction,
  showDeepLinks,
}: {
  module: ModuleDefinition
  record: BusinessRecord | null
  onClose: () => void
  onAction: (action: string) => void
  showDeepLinks: boolean
}) {
  return (
    <Sheet open={Boolean(record)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-2xl">
        {record && (
          <>
            <SheetHeader className="border-b border-border px-5 py-4 pr-12 text-left">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn("rounded-full text-[11px]", statusClasses(record.status))}
                >
                  {record.status}
                </Badge>
                <Badge variant="outline" className="rounded-full text-[11px] font-normal">
                  {record.id}
                </Badge>
              </div>
              <SheetTitle className="pt-1 text-xl">{record.name}</SheetTitle>
              <SheetDescription>{record.description}</SheetDescription>
            </SheetHeader>

            <div className="flex-1 space-y-8 overflow-y-auto px-5 py-6">
              <section className="space-y-4">
                <h3 className="text-sm font-semibold">Business record</h3>
                <div className="divide-y divide-border/60 border-y border-border/60 py-1">
                  {Object.entries(record.facts).map(([label, value]) => (
                    <StatRow key={label} label={label} value={value} className="py-3" />
                  ))}
                </div>
              </section>

              <section className="space-y-4">
                <h3 className="text-sm font-semibold">Lifecycle</h3>
                {!module.lifecycle.includes(record.status) && (
                  <Badge
                    variant="outline"
                    className={cn("rounded-full text-[11px]", statusClasses(record.status))}
                  >
                    Operational flag · {record.status}
                  </Badge>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {module.lifecycle.map((state, index) => {
                    const isCurrent = state === record.status
                    return (
                      <div key={state} className="flex items-center gap-2">
                        <span
                          className={cn(
                            "flex h-7 items-center rounded-full border px-3 text-xs",
                            isCurrent
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border text-muted-foreground",
                          )}
                        >
                          {state}
                        </span>
                        {index < module.lifecycle.length - 1 && (
                          <span className="h-px w-3 bg-border" />
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>

              <section className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Related context</h3>
                  {showDeepLinks && record.deepLink && (
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={record.deepLink}>
                        Open dedicated view
                        <ArrowSquareOut className="h-4 w-4" />
                      </Link>
                    </Button>
                  )}
                </div>
                <div className="divide-y divide-border border-y border-border/60">
                  {record.related.map((item) => {
                    const relatedLink = showDeepLinks
                      ? resolveBusinessRelation(item)
                      : null

                    if (!relatedLink) {
                      return (
                        <div key={item} className="flex items-center py-3">
                          <span className="text-sm">{item}</span>
                        </div>
                      )
                    }

                    return (
                      <Link
                        key={item}
                        href={relatedLink.href}
                        className="group flex items-center justify-between py-3 text-sm hover:text-primary"
                        aria-label={`Open ${item}`}
                      >
                        <span>{item}</span>
                        <ArrowSquareOut
                          aria-hidden="true"
                          className="h-4 w-4 text-muted-foreground group-hover:text-primary"
                        />
                      </Link>
                    )
                  })}
                </div>
              </section>

            </div>

            <SheetFooter className="flex-row items-center justify-between border-t border-border px-5 py-4">
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <div className="flex flex-wrap justify-end gap-2">
                {(record.allowedTransitions ?? module.lifecycle.slice(1, 3)).map((action) => (
                  <Button
                    key={action}
                    variant={action === "Rejected" || action === "Cancelled" ? "outline" : "default"}
                    onClick={() => onAction(action)}
                  >
                    {action}
                  </Button>
                ))}
              </div>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function ActionDecisionDialog({
  module,
  pendingAction,
  onOpenChange,
  onConfirm,
}: {
  module: ModuleDefinition
  pendingAction: PendingAction | null
  onOpenChange: (open: boolean) => void
  onConfirm: (decision: { reason: string; effectiveDate: string }) => void
}) {
  const [reason, setReason] = useState("")
  const [effectiveDate, setEffectiveDate] = useState("")
  const [deletionCategory, setDeletionCategory] = useState("")
  const action = pendingAction?.action ?? ""
  const isDeleteAction = action.toLowerCase().includes("delete")
  const createsCompanion = pendingAction
    ? createsImmutableCompanion(module, action)
    : false
  const outcome = pendingAction
    ? actionOutcome(module, action, pendingAction.record.status)
    : ""

  const close = () => {
    setReason("")
    setEffectiveDate("")
    setDeletionCategory("")
    onOpenChange(false)
  }

  const confirm = () => {
    onConfirm({
      reason: isDeleteAction
        ? `${deletionCategory}: ${reason.trim()}`
        : reason.trim(),
      effectiveDate,
    })
    setReason("")
    setEffectiveDate("")
    setDeletionCategory("")
  }

  return (
    <Dialog open={Boolean(pendingAction)} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-xl">
        {pendingAction && (
          <>
            <DialogHeader>
              <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <DialogTitle>{action}</DialogTitle>
              <DialogDescription>
                {pendingAction.record.name} · {module.title}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="grid gap-2 rounded-xl border border-border/60 bg-muted/20 p-4 text-xs sm:grid-cols-2">
                <div>
                  <p className="text-muted-foreground">Current state</p>
                  <p className="mt-1 font-medium">{pendingAction.record.status}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">
                    {createsCompanion ? "Controlled outcome" : "Validated next state"}
                  </p>
                  <p className="mt-1 font-medium">
                    {createsCompanion ? "Create separate record" : outcome}
                  </p>
                </div>
              </div>

              {isDeleteAction && (
                <div className="space-y-2">
                  <Label htmlFor="deletion-category">Deletion category</Label>
                  <Select value={deletionCategory} onValueChange={setDeletionCategory}>
                    <SelectTrigger id="deletion-category">
                      <SelectValue placeholder="Select a structured reason" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Duplicate record">Duplicate record</SelectItem>
                      <SelectItem value="Created in error">Created in error</SelectItem>
                      <SelectItem value="Never deployed">Never deployed</SelectItem>
                      <SelectItem value="Data correction">Data correction</SelectItem>
                      <SelectItem value="Other approved reason">Other approved reason</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Containers are soft-deleted and the category, explanation, actor, and time are written to the central deletion log.
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="action-reason">Decision or action reason</Label>
                <Textarea
                  id="action-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Explain why this action is appropriate and note the evidence reviewed."
                  className="min-h-24 resize-none"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="action-effective-date">Effective date</Label>
                <Input
                  id="action-effective-date"
                  type="date"
                  value={effectiveDate}
                  onChange={(event) => setEffectiveDate(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty for an immediate governed action. Future-dated changes stay separate
                  from the current active version.
                </p>
              </div>

              <div className="rounded-xl border border-border/60 p-3">
                <p className="text-xs leading-5 text-muted-foreground">
                  {createsCompanion
                    ? "The source record remains unchanged. A linked correction, immutable plan, promotion, child record, or ledger entry will be created."
                    : "Company, project, capability, lifecycle, and effective-date checks run before the action is recorded. Actor, reason, before/after state, and evidence are appended to audit history."}
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button
                onClick={confirm}
                disabled={!reason.trim() || (isDeleteAction && !deletionCategory)}
              >
                Confirm {action.toLowerCase()}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
