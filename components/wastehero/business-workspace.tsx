"use client"

import Link from "next/link"
import {
  Fragment,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import {
  ArrowSquareOut,
  CalendarCheck,
  CaretDown,
  ArrowsClockwise,
  DownloadSimple,
  Gear,
  Info,
  MagnifyingGlass,
  Plus,
  PushPin,
  ShieldCheck,
  Star,
} from "@phosphor-icons/react/dist/ssr"

import {
  businessWorkspaces,
  FIXTURE_COMPANY_ID,
  FIXTURE_PROJECT_IDS,
  getWorkspaceDefinition,
  type BusinessRecord,
  type ModuleDefinition,
  type ModuleMetric,
  type WorkspaceDefinition,
  type WorkspaceId,
} from "@/lib/data/business-modules"
import { migrateLegacyId, migrateLegacyModuleId } from "@/lib/data/legacy-ids"
import { getBusinessFormSchema } from "@/lib/data/business-form-schemas"
import {
  collectFactColumnOptions,
  defaultFactColumns,
  moduleOffersRowActions,
  resolveModuleViewKind,
} from "@/lib/data/business-view-kinds"
import { calendarFromRecord } from "@/lib/route-schemes/calendar"
import {
  calendarKpis,
  calendarRowSummary,
  withDerivedCalendarValue,
  type CalendarRowSummary,
} from "@/lib/route-schemes/calendar-list"
import { planSchemeCreation } from "@/lib/route-schemes/creation"
import {
  planSchemeEditReconciliation,
  type SchemeEditReconciliationPlan,
} from "@/lib/route-schemes/edit"
import {
  schemeAttention,
  schemeCanGenerateRoutes,
  withEffectiveSchemeStatus,
} from "@/lib/route-schemes/lifecycle"
import {
  isPlanAheadEnabled,
  setPlanAhead,
} from "@/lib/route-schemes/plan-ahead"
import {
  QUICK_SCHEME_DRAFT_FIELD_IDS,
  quickSchemeDraftFromValues,
} from "@/lib/route-schemes/quick-create"
import {
  schemeRowSummary,
  withDerivedSchemeContext,
  type SchemeRowSummary,
} from "@/lib/route-schemes/scheme-list"
import {
  SERVICE_DAY_SHORT_LABELS,
  formatServiceDate,
  parseServiceDays,
  recurrenceFromValues,
  recurrenceSentence,
  serviceDaysFromValues,
  todayIso,
} from "@/lib/route-schemes/recurrence"
import {
  effectiveDayRules,
  matchPlansFromValues,
  matchPlansToValues,
  stopRuleSummary,
  stopSelectionMode,
} from "@/lib/route-schemes/matching"
import {
  dayPlanCountSummary,
  dayPlansToValues,
} from "@/lib/route-schemes/validation"
import type {
  BusinessFormField,
  BusinessFormOption,
  BusinessFormSchema,
  BusinessFormValues,
} from "@/lib/data/business-form-types"
import {
  applyIndexToRate,
  serviceProviderPriceToRecord,
  deriveServiceProviderPriceStatus,
  encodeHistory,
  isSoftDeleted,
  money,
  PRICING_REFERENCE_DATE,
  priceRowToRecord,
  PRODUCT_FACTS,
  RATE_FACTS,
  recordToServiceProviderPrice,
  recordToPriceRow,
  ROW_FACTS,
  rowDisplayName,
  syncProductPricingFacts,
  unitSuffix,
  type PriceRowModel,
  type PriceUnit,
} from "@/lib/commercial/price-model"
import {
  getBusinessModuleHref,
  resolveBusinessRelation,
} from "@/lib/data/business-links"
import type { TimelineTask } from "@/lib/data/project-details"
import { cn } from "@/lib/utils"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Breadcrumbs } from "@/components/projects/Breadcrumbs"
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
import { TablePagination, useTablePagination } from "@/components/ui/table-pagination"
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
  canonicalCalendarName,
} from "@/components/wastehero/business-filter-popover"
import {
  canonicalServiceFrequencyName,
  resolveServiceFrequencyValue,
  serviceFrequencyById,
  serviceFrequencyOfRecord,
} from "@/lib/data/service-frequencies"
import {
  BusinessViewOptionsPopover,
  defaultBusinessViewOptions,
  type BusinessGroupOption,
  type BusinessViewOptions,
  type BusinessViewType,
} from "@/components/wastehero/business-view-options-popover"
import {
  BusinessRecordBoardView,
  BusinessRecordCardsView,
  BusinessRecordDayTimeline,
  RecordActionsMenu,
  recordProgress,
  statusClasses,
  type RecordExtraAction,
} from "@/components/wastehero/business-record-views"
import { BusinessRecordFormDialog } from "@/components/wastehero/business-record-form-dialog"
import {
  RouteCreateEntry,
  type GuidedRouteData,
} from "@/components/wastehero/route-create-flow"
import {
  SchemeCreateEntry,
  resolvedDraftPlans,
  schemeDayPlans,
  schemeMatchPlans,
  validateGuidedScheme,
  type GuidedSchemeData,
} from "@/components/wastehero/scheme-create-flow"
import { SchemeGenerateRoutesDialog } from "@/components/wastehero/scheme-generate-routes"
import { SchemeDetailsPage } from "@/components/wastehero/scheme-details-page"
import { SchemePlanAheadRunner } from "@/components/wastehero/scheme-plan-ahead"
import { useBusinessRecordStore } from "@/components/wastehero/business-record-store"
import { useActiveRoutes } from "@/components/wastehero/active-routes-store"
import {
  useAssetManagementStore,
  type MeasurementSetting,
  type ContainerType,
  type WasteFraction,
} from "@/components/settings/asset-management-store"
import {
  useCommercialRegistriesStore,
  type CustomerTypeEntry,
  type PriceListEntry,
  type PricingZone,
  type ServiceLevel,
} from "@/components/settings/commercial-registries-store"
import { ServiceProviderDetailsPage } from "@/components/wastehero/service-provider-details-page"
import { ContainerDetailsSheet } from "@/components/wastehero/containers-assets-register"
import { RouteDetailsPage } from "@/components/wastehero/route-details-page"
import { TicketDetailsDialog } from "@/components/tickets/TicketDetailsDialog"
import { useOrganizationStore } from "@/components/settings/organization-store"
import {
  effectiveRoleAccess,
  type RoleAccessMap,
  type RolePermissionAction,
} from "@/lib/data/role-permissions"

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
  /**
   * Isolates the workspace to one service provider: only records attributed to it
   * are visible, created records are stamped with it, and relation options
   * belonging to other service providers are excluded.
   */
  serviceProviderScopeId?: string
  /**
   * Resolves view/edit/create/delete per module from this organization
   * role's effective access map (Settings → role permissions). Absent means
   * the office workspace default: everything permitted.
   */
  permissionsRoleId?: string
  /** Name written as owner/actor on audit events and created records. */
  actorName?: string
}

type ProjectScope = "copenhagen" | "harbor" | "all"

const emptyBusinessFilters: BusinessFilters = {
  statuses: [],
  sources: [],
  freshness: [],
  containerTypes: [],
  wasteFractions: [],
  vehicles: [],
  serviceFrequencies: [],
  routeSchemes: [],
  collectionCalendars: [],
  propertyTypes: [],
  serviceAreas: [],
  serviceScopes: [],
  reliabilityBands: [],
  roles: [],
  ticketTypes: [],
  priorities: [],
  teams: [],
}

const filterFieldByChipLabel: Record<string, keyof BusinessFilters> = {
  Status: "statuses",
  Source: "sources",
  Freshness: "freshness",
  "Container type": "containerTypes",
  "Waste fraction": "wasteFractions",
  Vehicle: "vehicles",
  "Service frequency": "serviceFrequencies",
  "Route scheme": "routeSchemes",
  "Collection calendar": "collectionCalendars",
  "Property type": "propertyTypes",
  "Service area": "serviceAreas",
  "Service scope": "serviceScopes",
  Reliability: "reliabilityBands",
  Role: "roles",
  Type: "ticketTypes",
  Priority: "priorities",
  "Assigned team": "teams",
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

// Same idea for the Commercial forms: the Add price conditions (zone,
// customer type), its price-list tag, and the product form's service levels
// offer whatever the Settings → Commercial registries currently hold, not
// the fixture options baked into the schema. Registry NAMES are the stored
// values — price-row conditions/tags and product facts reference them as
// plain strings.
function configuredCommercialFormSchema(
  schema: BusinessFormSchema | undefined,
  zones: readonly PricingZone[],
  serviceLevels: readonly ServiceLevel[],
  customerTypes: readonly CustomerTypeEntry[],
  priceLists: readonly PriceListEntry[],
) {
  if (
    schema?.key !== "commercial.price-rows" &&
    schema?.key !== "commercial.products"
  ) {
    return schema
  }
  const toOptions = (names: readonly string[]): BusinessFormOption[] =>
    names.map((name) => ({ value: name, label: name }))
  const activeNames = <T extends { name: string; status: string }>(
    items: readonly T[],
  ) => items.filter((item) => item.status === "Active").map((item) => item.name)
  const optionsByField: Record<string, readonly BusinessFormOption[]> =
    schema.key === "commercial.price-rows"
      ? {
          zone: toOptions(activeNames(zones)),
          customerType: toOptions(activeNames(customerTypes)),
          // Active includes scheduled lists (future effective-from) — rows
          // for next year's tariff are added before it starts applying.
          tag: toOptions(activeNames(priceLists)),
        }
      : {
          serviceLevels: toOptions(activeNames(serviceLevels)),
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
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // Old bookmarks may still carry pre-rename ids (see lib/data/legacy-ids.ts).
  const rawModuleId = searchParams.get("module")
  const rawRecordId = searchParams.get("record")
  const requestedModuleId = rawModuleId ? migrateLegacyModuleId(rawModuleId) : rawModuleId
  const requestedRecordId = rawRecordId ? migrateLegacyId(rawRecordId) : rawRecordId
  const hasLegacyParams =
    requestedModuleId !== rawModuleId || requestedRecordId !== rawRecordId

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

  // Once retired ids have resolved, rewrite the address bar so a URL
  // bookmarked or shared from here carries the canonical ids only. Other
  // params are preserved; the replace re-renders with canonical params, where
  // nothing is left to rewrite.
  useEffect(() => {
    if (!hasLegacyParams) return
    const params = new URLSearchParams(searchParams.toString())
    if (requestedModuleId) params.set("module", requestedModuleId)
    if (requestedRecordId) params.set("record", requestedRecordId)
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }, [
    hasLegacyParams,
    pathname,
    requestedModuleId,
    requestedRecordId,
    router,
    searchParams,
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
  factLabel: string | readonly string[],
  splitValues = false,
  normalizeValue?: (value: string) => string | undefined,
) {
  if (selections.length === 0) return true
  const factLabels = typeof factLabel === "string" ? [factLabel] : factLabel
  const factValue = factLabels
    .map((label) => record.facts[label])
    .find(Boolean)
  if (!factValue) return false
  const values = (splitValues
    ? factValue.split(" · ").map((value) => value.trim())
    : [factValue]
  ).map((value) => normalizeValue?.(value) ?? value)
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
  // Collection Deviations continue past Approved (Approved → Notified →
  // Executed); the generic approved-is-terminal heuristic would strand them
  // with an empty action list — and, since the portal shows Approved
  // deviations, a permanently un-notifiable customer notice.
  if (
    module.id === "collection-deviations" &&
    status.toLowerCase() === "approved"
  ) {
    return ["Notified", "Cancelled"]
  }
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
  if (module.id === "inventory" || module.id === "warehouses") {
    return `${action} ledger entry · ${record.name}`
  }
  return `${action.replace(/^Create\s+/i, "")} · ${record.name}`
}

// Records of these modules are operated by a specific party, so a service provider
// scope offers only its own — unlike shared registries (projects, depots,
// ticket types), where unattributed records stay selectable.
const serviceProviderOperatedRelationModuleIds = new Set([
  "routes",
  "vehicles",
  "drivers",
  "service-provider-workspace",
  "service-areas",
  "service-provider-prices",
  "settlements",
  "service-providers",
])

const primaryModuleIdsByWorkspace: Partial<Record<WorkspaceId, readonly string[]>> = {
  operate: ["tickets", "exceptions"],
  plan: ["collection-deviations", "calendars", "areas"],
  "route-studio": ["live", "schemes", "routes", "pickups", "weights"],
  customers: ["properties", "groups", "shared", "agreements"],
  resources: ["containers", "inventory", "warehouses", "depots"],
  fleet: ["vehicles", "drivers", "vehicle-planning"],
  "service-providers": ["service-providers", "service-areas", "activities"],
  commercial: ["products", "price-rows", "service-provider-prices", "settlements", "events"],
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

// The derived KPI tile row above the Collection Calendars list (issue #27,
// D13). Values arrive already computed from real records — this component
// only lays them out; tones follow the status-badge palette.
const KPI_TONE_CLASSES: Record<NonNullable<ModuleMetric["tone"]>, string> = {
  positive: "text-teal-700 dark:text-teal-300",
  warning: "text-amber-700 dark:text-amber-300",
  danger: "text-rose-700 dark:text-rose-300",
  neutral: "text-muted-foreground",
}

function ModuleKpiTiles({ tiles }: { tiles: ModuleMetric[] }) {
  if (tiles.length === 0) return null
  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className="rounded-xl border border-border/60 bg-card px-4 py-3"
        >
          <p className="text-xs text-muted-foreground">{tile.label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {tile.value}
          </p>
          <p
            className={cn(
              "mt-1 text-xs",
              KPI_TONE_CLASSES[tile.tone ?? "neutral"],
            )}
          >
            {tile.helper}
          </p>
        </div>
      ))}
    </section>
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

// A service provider-scoped workspace already knows which service provider, project,
// service area, and signed-in manager it belongs to, so the invite form must
// not ask for any of them: all four are stamped from the account and its
// fixed scope at submit time, leaving only the person's own details.
const SERVICE_PROVIDER_ACCOUNT_FIELD_IDS = [
  "serviceProviderId",
  "projectId",
  "serviceAreaId",
  "invitedBy",
] as const

// A service provider manager raises tickets on their own work for the office to
// resolve, so the office-side fields disappear: Project and Source are known
// from the account, response SLAs, parent tickets, and the customer/internal
// communication split are the office's to manage, and Category comes from the
// selected Ticket type. Evidence is uploaded directly instead of referenced.
const SERVICE_PROVIDER_TICKET_HIDDEN_FIELD_IDS: readonly string[] = [
  "projectId",
  "responseDueAt",
  "occurredAt",
  "parentTicketId",
  "internalComment",
  "customerMessage",
  "source",
  "category",
]

const serviceProviderTicketSectionDescriptions: Record<string, string> = {
  classification:
    "Validation: a configured Ticket type and priority are required. New Tickets start Created; the office drives later states.",
  "business-context":
    "Validation: at least one permitted customer, Property, Shared Collection Point, Container, or Route relationship is required.",
  "content-visibility":
    "Describe the case and upload photos or documents as evidence.",
}

function serviceProviderScopedFormSchema(
  schema: BusinessFormSchema | undefined,
  serviceProviderScopeId: string | undefined,
): BusinessFormSchema | undefined {
  if (!schema || !serviceProviderScopeId) return schema
  if (schema.key === "service-providers.service-provider-workspace") {
    const hiddenFieldIds: readonly string[] = SERVICE_PROVIDER_ACCOUNT_FIELD_IDS
    return {
      ...schema,
      description: "Add a user with access limited to your service provider.",
      contextFieldIds: schema.contextFieldIds?.filter(
        (fieldId) => !hiddenFieldIds.includes(fieldId),
      ),
      sections: schema.sections.map((section) => ({
        ...section,
        fields: section.fields.filter(
          (field) => !hiddenFieldIds.includes(field.id),
        ),
      })),
    }
  }
  if (schema.key === "operate.tickets") {
    return {
      ...schema,
      description:
        "Raise a scoped case on your own work for the office to resolve. Assignment and resolution history remain separate parts of the Ticket.",
      contextFieldIds: schema.contextFieldIds?.filter(
        (fieldId) => !SERVICE_PROVIDER_TICKET_HIDDEN_FIELD_IDS.includes(fieldId),
      ),
      sections: schema.sections.map((section) => ({
        ...section,
        description:
          serviceProviderTicketSectionDescriptions[section.id] ?? section.description,
        fields: section.fields
          .filter(
            (field) => !SERVICE_PROVIDER_TICKET_HIDDEN_FIELD_IDS.includes(field.id),
          )
          .map((field) =>
            field.id === "attachmentReferences"
              ? {
                  ...field,
                  type: "file" as const,
                  label: "Attachments",
                  description: undefined,
                  placeholder: undefined,
                }
              : field,
          ),
      })),
    }
  }
  return schema
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
  serviceProviderScopeId,
  permissionsRoleId,
  actorName = "Olivia Larsen",
}: BusinessWorkspaceProps) {
  const sourceWorkspace = getWorkspaceDefinition(workspaceId)
  const { getRecords, upsertRecord } = useBusinessRecordStore()
  const { isRouteStarred, toggleRouteStarred } = useActiveRoutes(
    serviceProviderScopeId ? "service-provider" : "operator",
  )
  const { containerTypes, wasteFractions, measurementSettings } =
    useAssetManagementStore()
  const { zones, serviceLevels, customerTypes, priceLists } =
    useCommercialRegistriesStore()
  const { roles: organizationRoles } = useOrganizationStore()
  const router = useRouter()
  // The live grants for the restricting role — Settings edits apply on the
  // next render. Null means no role restriction (office default).
  const roleAccess = useMemo<RoleAccessMap | null>(() => {
    if (!permissionsRoleId) return null
    const role = organizationRoles.find(
      (candidate) => candidate.id === permissionsRoleId,
    )
    return effectiveRoleAccess(role ?? { id: permissionsRoleId })
  }, [organizationRoles, permissionsRoleId])
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

    // A restricting role hides modules it cannot view. When it can view none,
    // the configured modules are kept so the workspace can still render its
    // frame around the access notice instead of crashing.
    const viewableModules = roleAccess
      ? modules.filter((module) =>
          (roleAccess[`${sourceWorkspace.id}.${module.id}`] ?? []).includes(
            "view",
          ),
        )
      : modules

    return {
      ...sourceWorkspace,
      modules: viewableModules.length > 0 ? viewableModules : modules,
    }
  }, [allowedModuleIds, allowedRecordIds, roleAccess, sourceWorkspace])
  const hasRoleViewableModules =
    !roleAccess ||
    workspace.modules.some((module) =>
      (roleAccess[`${workspace.id}.${module.id}`] ?? []).includes("view"),
    )
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
  const [editingRecord, setEditingRecord] = useState<BusinessRecord | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [generateSchemeRecord, setGenerateSchemeRecord] =
    useState<BusinessRecord | null>(null)
  const [relatedCreateTarget, setRelatedCreateTarget] =
    useState<RelatedCreateTarget | null>(null)
  const [auditEvents, setAuditEvents] = useState<Record<string, AuditEvent[]>>({})

  const activeModule =
    workspace.modules.find((module) => module.id === activeModuleId) ?? workspace.modules[0]
  const activeModuleGrants = roleAccess
    ? roleAccess[`${workspace.id}.${activeModule.id}`] ?? []
    : null
  const hasGrant = (action: RolePermissionAction) =>
    activeModuleGrants === null || activeModuleGrants.includes(action)
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
      serviceProviderScopedFormSchema(
        configuredCommercialFormSchema(
          configuredAssetFormSchema(
            getBusinessFormSchema(workspace.id, activeModule.id),
            containerTypes,
            wasteFractions,
            measurementSettings,
            projectScope,
          ),
          zones,
          serviceLevels,
          customerTypes,
          priceLists,
        ),
        serviceProviderScopeId,
      ),
    [
      activeModule.id,
      containerTypes,
      serviceProviderScopeId,
      customerTypes,
      measurementSettings,
      priceLists,
      projectScope,
      serviceLevels,
      wasteFractions,
      workspace.id,
      zones,
    ],
  )
  const relatedCreateModule = relatedCreateTarget
    ? resolveFormModule(
        relatedCreateTarget.workspaceId,
        relatedCreateTarget.moduleId,
      )
    : null
  // The Price Engine's Products header button opens Add price — a price-row
  // create targeting commercial.price-rows — instead of the module's
  // registered create schema: product creation lives in Settings →
  // Commercial → Products, and pricing a product is the module's real action.
  const isPriceEngineProducts =
    workspace.id === "commercial" && activeModule.id === "products"
  const formSchema = useMemo(
    () =>
      relatedCreateTarget?.schemaOverride ?? (relatedCreateModule
        ? configuredCommercialFormSchema(
            configuredAssetFormSchema(
              getBusinessFormSchema(
                relatedCreateModule.workspaceId,
                relatedCreateModule.module.id,
              ),
              containerTypes,
              wasteFractions,
              measurementSettings,
              projectScope,
            ),
            zones,
            serviceLevels,
            customerTypes,
            priceLists,
          )
        : activeModuleFormSchema),
    [
      activeModuleFormSchema,
      containerTypes,
      customerTypes,
      measurementSettings,
      priceLists,
      projectScope,
      relatedCreateModule,
      relatedCreateTarget?.schemaOverride,
      serviceLevels,
      wasteFractions,
      zones,
    ],
  )
  const canOpenBusinessForm =
    Boolean(activeModuleFormSchema?.execution) &&
    activeModuleFormSchema?.mode !== "disabled"
  // Routes get a chooser between Quick create and the Guided Setup wizard.
  const isRouteCreateFlow =
    activeModuleFormSchema?.key === "route-studio.routes"
  // Route Schemes get the same chooser with their own guided wizard.
  const isSchemeCreateFlow =
    activeModuleFormSchema?.key === "route-studio.schemes"
  const activeRecords = useMemo(() => {
    let records = getRecords(
      workspace.id,
      activeModule.id,
      activeModule.records,
    )
    // Scheme status is always the derived lifecycle status (issue #25) —
    // no surface renders the raw stored string, so every downstream reader
    // (table, filters, grouping, detail, row actions) sees one truth. The
    // row context is likewise derived (issue #30, D15): real stored
    // area/project names plus structured service days, never the fixture
    // display copy.
    if (activeModule.id === "schemes") {
      const today = todayIso()
      const areasModule = getWorkspaceDefinition("plan").modules.find(
        (candidate) => candidate.id === "areas",
      )
      const areas = areasModule
        ? getRecords("plan", areasModule.id, areasModule.records)
        : []
      records = records.map((record) =>
        withDerivedSchemeContext(
          withEffectiveSchemeStatus(record, today),
          areas,
          // No stored project scope → no invented one (D22-style honesty);
          // the context then falls back to the structured service days.
          record.projectIds?.length ? projectScopeLabel(record.projectIds) : "",
        ),
      )
    }
    // A calendar's "Next holiday" value is always derived from its structured
    // holiday dates plus today (issue #27, D13) — stored display copies and
    // form-submit placeholders are never rendered.
    if (activeModule.id === "calendars") {
      const today = todayIso()
      records = records.map((record) => withDerivedCalendarValue(record, today))
    }
    // Service provider isolation covers user-created records too, which a static
    // fixture-id allowlist cannot.
    return serviceProviderScopeId
      ? records.filter((record) => record.serviceProviderId === serviceProviderScopeId)
      : records
  }, [activeModule, serviceProviderScopeId, getRecords, workspace.id])
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
  // Scheme detail is a dedicated full page (issue #29, D8) — same routing
  // contract as the record sheet (?module=schemes&record=), rendered instead
  // of it. Re-resolved from activeRecords so the page always shows the live
  // canonical record (derived status included), never a stale click snapshot.
  const schemeDetailRecord =
    workspace.id === "route-studio" &&
    activeModule.id === "schemes" &&
    selectedRecord
      ? (activeRecords.find((candidate) => candidate.id === selectedRecord.id) ??
        selectedRecord)
      : null
  const isServiceProviderDetails =
    workspace.id === "service-providers" &&
    activeModule.id === "service-providers" &&
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
  const selectedServiceProviderId = isServiceProviderDetails ? selectedRecord?.id ?? "" : ""
  const relatedServiceProviderUsers = useMemo(() => {
    if (!selectedServiceProviderId) return []
    const serviceProviderWorkspace = getWorkspaceDefinition("service-providers")
    const usersModule = serviceProviderWorkspace.modules.find(
      (module) => module.id === "service-provider-workspace",
    )
    if (!usersModule) return []
    return getRecords(
      "service-providers",
      usersModule.id,
      usersModule.records,
    ).filter(
      (record) =>
        record.serviceProviderId === selectedServiceProviderId && !isSoftDeleted(record),
    )
  }, [getRecords, selectedServiceProviderId])
  const relatedServiceProviderVehicles = useMemo(() => {
    if (!selectedServiceProviderId) return []
    const fleetWorkspace = getWorkspaceDefinition("fleet")
    const vehiclesModule = fleetWorkspace.modules.find(
      (module) => module.id === "vehicles",
    )
    if (!vehiclesModule) return []
    return getRecords("fleet", vehiclesModule.id, vehiclesModule.records).filter(
      (record) =>
        record.serviceProviderId === selectedServiceProviderId && !isSoftDeleted(record),
    )
  }, [getRecords, selectedServiceProviderId])
  const relatedServiceProviderDrivers = useMemo(() => {
    if (!selectedServiceProviderId) return []
    const fleetWorkspace = getWorkspaceDefinition("fleet")
    const driversModule = fleetWorkspace.modules.find(
      (module) => module.id === "drivers",
    )
    if (!driversModule) return []
    return getRecords("fleet", driversModule.id, driversModule.records).filter(
      (record) =>
        record.serviceProviderId === selectedServiceProviderId && !isSoftDeleted(record),
    )
  }, [getRecords, selectedServiceProviderId])
  const relatedServiceAreas = useMemo(() => {
    if (!selectedServiceProviderId) return []
    const serviceProviderWorkspace = getWorkspaceDefinition("service-providers")
    const serviceAreasModule = serviceProviderWorkspace.modules.find(
      (module) => module.id === "service-areas",
    )
    if (!serviceAreasModule) return []
    return getRecords(
      "service-providers",
      serviceAreasModule.id,
      serviceAreasModule.records,
    ).filter(
      (record) =>
        record.serviceProviderId === selectedServiceProviderId && !isSoftDeleted(record),
    )
  }, [getRecords, selectedServiceProviderId])
  const relatedServiceProviderPrices = useMemo(() => {
    if (!selectedServiceProviderId) return []
    const commercialWorkspace = getWorkspaceDefinition("commercial")
    const ratesModule = commercialWorkspace.modules.find((module) => module.id === "service-provider-prices")
    if (!ratesModule) return []
    return getRecords("commercial", ratesModule.id, ratesModule.records).filter(
      (record) =>
        record.serviceProviderId === selectedServiceProviderId && !isSoftDeleted(record),
    )
  }, [getRecords, selectedServiceProviderId])
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
      const matchesServiceFrequency = matchesFactFilter(
        record,
        businessFilters.serviceFrequencies,
        // Legacy fallback: pre-rename user-created records keep the retired key.
        ["Service frequency", "Pickup setting"],
        false,
        // Legacy fallback: pre-#20 records carry fused display strings
        // ("Organic · 14-day service") — fold them onto catalog names.
        canonicalServiceFrequencyName,
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
        false,
        // Legacy fallback: pre-rename records carry the drifted calendar name.
        canonicalCalendarName,
      )
      const matchesPropertyType = matchesFactFilter(
        record,
        businessFilters.propertyTypes,
        "Property type",
      )
      const matchesServiceArea = matchesFactFilter(
        record,
        businessFilters.serviceAreas,
        "Service area",
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
      // Service provider users created before the Role field rename carry the fact
      // under "Service provider role", so check both keys.
      const matchesRole =
        businessFilters.roles.length === 0 ||
        businessFilters.roles.includes(
          (record.facts.Role ?? record.facts["Service provider role"] ?? "").trim(),
        )
      // Fixture tickets store classification as Type/Team; tickets created
      // through the form store the field labels Ticket type/Assigned team.
      const matchesTicketType =
        businessFilters.ticketTypes.length === 0 ||
        businessFilters.ticketTypes.includes(
          (record.facts.Type ?? record.facts["Ticket type"] ?? "").trim(),
        )
      const matchesPriority =
        businessFilters.priorities.length === 0 ||
        businessFilters.priorities.includes(
          (record.facts.Priority ?? "").trim(),
        )
      const matchesTeam =
        businessFilters.teams.length === 0 ||
        businessFilters.teams.includes(
          (record.facts.Team ?? record.facts["Assigned team"] ?? "").trim(),
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
        matchesServiceFrequency &&
        matchesRouteScheme &&
        matchesCollectionCalendar &&
        matchesPropertyType &&
        matchesServiceArea &&
        matchesServiceScope &&
        matchesReliability &&
        matchesRole &&
        matchesTicketType &&
        matchesPriority &&
        matchesTeam &&
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
    businessFilters.serviceFrequencies.forEach((value) =>
      chips.push({ key: "Service frequency", value }),
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
    businessFilters.serviceAreas.forEach((value) =>
      chips.push({ key: "Service area", value }),
    )
    businessFilters.serviceScopes.forEach((value) =>
      chips.push({ key: "Service scope", value }),
    )
    businessFilters.reliabilityBands.forEach((value) =>
      chips.push({ key: "Reliability", value }),
    )
    businessFilters.roles.forEach((value) =>
      chips.push({ key: "Role", value }),
    )
    businessFilters.ticketTypes.forEach((value) =>
      chips.push({ key: "Type", value }),
    )
    businessFilters.priorities.forEach((value) =>
      chips.push({ key: "Priority", value }),
    )
    businessFilters.teams.forEach((value) =>
      chips.push({ key: "Assigned team", value }),
    )
    if (!fixedProjectScope && projectScope !== "copenhagen") {
      chips.push({
        key: "Project",
        value: projectScope === "harbor" ? "Harbor Commercial" : "All permitted projects",
      })
    }
    return chips
  }, [businessFilters, fixedProjectScope, projectScope])
  // Queue vs rich vs standard table is a property of the module, never of the
  // viewing persona (lib/data/business-view-kinds.ts) — the operator's Tickets
  // page and the service provider workspace render the same rich record table.
  const moduleViewKind = resolveModuleViewKind(activeModule.id)
  const isQueueView = moduleViewKind === "queue"
  const isTicketsView = activeModule.id === "tickets"
  const isRoutesView = activeModule.id === "routes"
  // Collection Calendars list (issue #27, D28iii): artboard columns with
  // Working days / Holidays / Validity / Next holiday derived per record.
  const isCalendarsView = activeModule.id === "calendars"
  // Operators and service provider managers pin route days to their own sidebar's
  // Active Routes group from a star column on the routes table.
  const showRouteStarColumn = isRoutesView
  const isServiceProviderUsersView = activeModule.id === "service-provider-workspace"
  const isRichRecordView = moduleViewKind === "rich"
  const moduleViewTypes: readonly BusinessViewType[] = isRichRecordView
    ? ["table", "list", "board", "timeline"]
    : ["table"]
  const activeViewType: BusinessViewType = isRichRecordView
    ? viewOptions.viewType
    : "table"
  const effectiveShowPrimaryAction = showPrimaryAction && hasGrant("create")
  const canCreateFromView =
    effectiveShowPrimaryAction &&
    canOpenBusinessForm &&
    Boolean(formSchema) &&
    !isPriceEngineProducts
  // Generic row Edit/Delete: a rich module that exposes them (tickets do not —
  // they are worked through lifecycle transitions and the details view), the
  // viewer's grants, and for edits a form execution policy.
  const offersRowActions = moduleOffersRowActions(activeModule.id)
  const canEditRecords =
    offersRowActions &&
    Boolean(activeModuleFormSchema?.execution) &&
    hasGrant("edit")
  const canDeleteRecords = offersRowActions && hasGrant("delete")
  const canRunRecordActions = hasGrant("edit")
  // Generate routes (spec FR-6, ticket #7) and the Plan Ahead toggle (FR-11,
  // ticket #8) on a scheme: row menu + detail view, only for schemes whose
  // recurrence is structured enough to generate.
  const isSchemesView = activeModule.id === "schemes"
  // Per-scheme derived row presentation, one pass over one related-records
  // load: the live Attention warnings (issue #25, D5/D20 — recomputed from
  // canonical stored configuration, never read from persisted "Validation
  // warnings" facts) plus the Recurrence / Collection calendar cells (issue
  // #30, D15 — derived from structured submittedValues and the live calendar
  // records, so editing a scheme changes them with no stored display string
  // involved).
  const schemeRowsById = useMemo(() => {
    if (!isSchemesView) {
      return new Map<string, SchemeRowSummary & { attention: string[] }>()
    }
    const relatedModuleRecords = (workspaceId: WorkspaceId, moduleId: string) => {
      const module = getWorkspaceDefinition(workspaceId).modules.find(
        (candidate) => candidate.id === moduleId,
      )
      return module ? getRecords(workspaceId, module.id, module.records) : []
    }
    const related = {
      schemes: activeRecords,
      calendars: relatedModuleRecords("plan", "calendars"),
      allocations: relatedModuleRecords("fleet", "vehicle-planning"),
      containers: relatedModuleRecords("resources", "containers"),
      vehicles: relatedModuleRecords("fleet", "vehicles"),
    }
    return new Map(
      activeRecords.map((record) => [
        record.id,
        {
          ...schemeRowSummary(record, related.calendars),
          attention: schemeAttention(record, related),
        },
      ]),
    )
  }, [activeRecords, getRecords, isSchemesView])
  // Derived Collection Calendars presentation (issue #27, D13/D28iii): the
  // KPI tiles compute from the same records the list shows — scope-filtered
  // but not search-filtered — and the table's Working days / Holidays /
  // Validity cells derive from each record's structured submittedValues.
  const calendarRowsById = useMemo(() => {
    if (!isCalendarsView) return new Map<string, CalendarRowSummary>()
    const today = todayIso()
    return new Map(
      activeRecords.map((record) => [record.id, calendarRowSummary(record, today)]),
    )
  }, [activeRecords, isCalendarsView])
  const calendarKpiTiles = useMemo(
    () => (isCalendarsView ? calendarKpis(visibleScopedRecords, todayIso()) : null),
    [isCalendarsView, visibleScopedRecords],
  )
  const schemeExtraActions = useCallback(
    (record: BusinessRecord): RecordExtraAction[] | undefined =>
      isSchemesView &&
      canRunRecordActions &&
      schemeCanGenerateRoutes(record, todayIso())
        ? [
            {
              label: "Generate routes",
              icon: <ArrowsClockwise className="h-4 w-4" />,
              onSelect: (target: BusinessRecord) => setGenerateSchemeRecord(target),
            },
            {
              label: isPlanAheadEnabled(record)
                ? "Turn off Plan Ahead"
                : "Turn on Plan Ahead",
              icon: <CalendarCheck className="h-4 w-4" />,
              onSelect: (target: BusinessRecord) => {
                const enabled = !isPlanAheadEnabled(target)
                // Persist against the stored record, not the derived display
                // row: the status/context seams (issues #25/#30) are
                // render-time and must never be frozen into the store.
                const stored =
                  getRecords("route-studio", "schemes", activeModule.records).find(
                    (candidate) => candidate.id === target.id,
                  ) ?? target
                upsertRecord("route-studio", "schemes", setPlanAhead(stored, enabled))
                toast.success(
                  enabled ? "Plan Ahead turned on" : "Plan Ahead turned off",
                  {
                    description: enabled
                      ? `${target.name} generates its next 7 days automatically when Route Studio loads.`
                      : `${target.name} stops auto-generating; already-generated routes remain.`,
                  },
                )
              },
            },
          ]
        : undefined,
    [activeModule.records, canRunRecordActions, getRecords, isSchemesView, upsertRecord],
  )
  const factColumnOptions = useMemo(
    () => collectFactColumnOptions(activeModule.id, visibleScopedRecords),
    [activeModule.id, visibleScopedRecords],
  )
  const activeStaticColumns = useMemo(
    () =>
      viewOptions.staticColumns.filter((column) =>
        factColumnOptions.includes(column),
      ),
    [factColumnOptions, viewOptions.staticColumns],
  )
  const activeFactColumns = useMemo(
    () =>
      viewOptions.factColumns.filter(
        (column) =>
          factColumnOptions.includes(column) &&
          !activeStaticColumns.includes(column),
      ),
    [activeStaticColumns, factColumnOptions, viewOptions.factColumns],
  )
  const recordGroupOptions = useMemo<BusinessGroupOption[]>(() => {
    if (!isRichRecordView) return []
    const distinctCount = (
      getValue: (record: BusinessRecord) => string,
      noun: string,
    ) => {
      const count = new Set(
        visibleScopedRecords.map(getValue).filter((value) => Boolean(value)),
      ).size
      return `${count} ${count === 1 ? noun : `${noun}s`}`
    }
    return [
      { value: "none", label: "None" },
      {
        value: "status",
        label: "Status",
        count: distinctCount((record) => record.status, "state"),
      },
      ...(isRoutesView
        ? ["Project", "Area"]
        : isServiceProviderUsersView
          ? ["Role"]
          : []
      ).map((label) => ({
        value: label,
        label,
        count: distinctCount(
          (record) => record.facts[label]?.trim() ?? "",
          "value",
        ),
      })),
      ...factColumnOptions.map((label) => ({
        value: label,
        label,
        count: distinctCount(
          (record) => record.facts[label]?.trim() ?? "",
          "value",
        ),
      })),
    ]
  }, [
    isServiceProviderUsersView,
    isRichRecordView,
    isRoutesView,
    factColumnOptions,
    visibleScopedRecords,
  ])
  const visibleTableColumnCount = isContainersAssetsView
    ? 2 +
      Number(viewOptions.showContainerType) +
      Number(viewOptions.showWasteFraction) +
      Number(viewOptions.showAddress) +
      Number(viewOptions.showFillLevel) +
      Number(viewOptions.showNextCollection) +
      Number(viewOptions.showProject)
    : isRichRecordView
      ? 3 +
        // Recurrence + Collection calendar replace the value column (#30).
        (isSchemesView ? 1 : 0) +
        Number(showRouteStarColumn) +
        (isRoutesView
          ? Number(viewOptions.showProject) + Number(viewOptions.showArea)
          : // Email, Phone number, and Role replace the context and value
            // columns (net +2).
            isServiceProviderUsersView
            ? 2
            : Number(viewOptions.showContext)) +
        Number(viewOptions.showUpdated) +
        activeStaticColumns.length +
        activeFactColumns.length +
        1
      : 3 +
        // Working days / Holidays / Validity on the calendars table (#27).
        (isCalendarsView ? 3 : 0) +
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
  const {
    page: tablePage,
    setPage: setTablePage,
    pageCount: tablePageCount,
    pageRows: pagedRecords,
    totalCount: tableTotalCount,
  } = useTablePagination(filteredRecords)
  const tableRecordGroups = useMemo<
    Array<{ label: string | null; records: BusinessRecord[] }>
  >(() => {
    const groupBy = isRichRecordView ? viewOptions.groupBy : "none"
    if (groupBy === "none") return [{ label: null, records: pagedRecords }]
    const groups = new Map<string, BusinessRecord[]>()
    for (const record of pagedRecords) {
      const label =
        groupBy === "status"
          ? record.status
          : record.facts[groupBy]?.trim() || `No ${groupBy.toLowerCase()}`
      const group = groups.get(label)
      if (group) group.push(record)
      else groups.set(label, [record])
    }
    return Array.from(groups.entries()).map(([label, records]) => ({
      label,
      records,
    }))
  }, [pagedRecords, isRichRecordView, viewOptions.groupBy])

  useEffect(() => {
    const activeTab = tabsScrollRef.current?.querySelector<HTMLElement>('[data-state="active"]')
    activeTab?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" })
  }, [activeModuleId])

  // Layout, grouping, and fact columns are module-specific choices; reseed them
  // with the module's defaults whenever the active module changes.
  useEffect(() => {
    setViewOptions((current) => ({
      ...current,
      viewType: "table",
      groupBy: "none",
      factColumns: defaultFactColumns(
        activeModuleId,
        defaultBusinessViewOptions.factColumns,
      ),
      staticColumns: [],
    }))
    setTablePage(1)
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
      let record =
        getRecords(workspace.id, module.id, module.records).find(
          (candidate) => candidate.id === recordId,
        ) ?? null
      // Deep-linked schemes show the derived lifecycle status (issue #25)
      // and derived row context (issue #30) too.
      if (record && module.id === "schemes") {
        record = withEffectiveSchemeStatus(record, todayIso())
        const areasModule = getWorkspaceDefinition("plan").modules.find(
          (candidate) => candidate.id === "areas",
        )
        record = withDerivedSchemeContext(
          record,
          areasModule
            ? getRecords("plan", areasModule.id, areasModule.records)
            : [],
          record.projectIds?.length ? projectScopeLabel(record.projectIds) : "",
        )
      }
      // Deep-linked calendars show the derived Next holiday too (issue #27).
      if (record && module.id === "calendars") {
        record = withDerivedCalendarValue(record, todayIso())
      }
      // Deep links cannot escape a service provider scope.
      if (
        record &&
        serviceProviderScopeId &&
        record.serviceProviderId !== serviceProviderScopeId
      ) {
        return null
      }
      return record
    },
    [serviceProviderScopeId, getRecords, workspace],
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
    const requiresDeleteGrant = action.toLowerCase().includes("delete")
    if (requiresDeleteGrant ? !hasGrant("delete") : !hasGrant("edit")) return
    setPendingAction({ record: selectedRecord, action })
  }

  const openEditRecord = useCallback((record: BusinessRecord) => {
    setEditingRecord(record)
  }, [])

  const requestRecordDelete = useCallback(
    (record: BusinessRecord) => {
      setPendingAction({
        record,
        action: `Delete ${activeModule.entityLabel.toLowerCase()}`,
      })
    },
    [activeModule.entityLabel],
  )

  // Keeps a price row's parent product's derived facts (Price list /
  // Variations / Customer / headline value) honest after any price-row
  // write — create, edit, or (with `exclude`) delete. Component-level so
  // both handleFormSubmit (create/edit) and commitRecordAction (delete) can
  // call it; on create only, callers pass historyWhat to also append the
  // product's History entry.
  const syncProductForRow = (
    rowRecord: BusinessRecord,
    options?: { historyWhat?: string; exclude?: boolean },
  ) => {
    const row = recordToPriceRow(rowRecord)
    const productsTarget = resolveFormModule("commercial", "products")
    const rowsTarget = resolveFormModule("commercial", "price-rows")
    if (!row || !productsTarget || !rowsTarget) return
    const product = getRecords(
      productsTarget.workspaceId,
      productsTarget.module.id,
      productsTarget.module.records,
    ).find((candidate) => candidate.id === row.productId)
    if (!product) return
    const existingRowRecords = getRecords(
      rowsTarget.workspaceId,
      rowsTarget.module.id,
      rowsTarget.module.records,
    )
    // Delete is a soft delete (the row stays in the store with a "Registry
    // visibility" fact) and this runs before that write lands, so the row
    // would otherwise still be read back as live — exclude it explicitly
    // instead of relying on the store to have already dropped it.
    const allRowRecords = options?.exclude
      ? existingRowRecords.filter((candidate) => candidate.id !== rowRecord.id)
      : existingRowRecords.some((candidate) => candidate.id === rowRecord.id)
        ? existingRowRecords.map((candidate) => (candidate.id === rowRecord.id ? rowRecord : candidate))
        : [...existingRowRecords, rowRecord]
    const rows = allRowRecords
      .map(recordToPriceRow)
      .filter((candidate): candidate is PriceRowModel => candidate !== null)
    const synced = syncProductPricingFacts(product, rows)
    upsertRecord("commercial", "products", {
      ...synced,
      updated: "Now",
      related: options?.historyWhat
        ? [
            encodeHistory({ at: PRICING_REFERENCE_DATE, who: actorName, what: options.historyWhat }),
            ...synced.related,
          ]
        : synced.related,
    })
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
      actor: actorName,
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

    if (action.toLowerCase().includes("delete")) {
      upsertRecord(workspace.id, activeModule.id, {
        ...record,
        updated: "Now",
        facts: {
          ...record.facts,
          "Registry visibility": "Soft deleted",
          "Deletion reason": reason,
          "Deleted by": actorName,
        },
        related: [`Deletion log ${event.id}`, ...record.related],
      })
      if (workspace.id === "commercial" && activeModule.id === "price-rows") {
        // Soft delete leaves the row in the store (marked, not removed), so
        // the product's derived facts must be recomputed with this row
        // explicitly excluded rather than relying on the store to have
        // already dropped it.
        syncProductForRow(record, { exclude: true })
      }
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
        owner: actorName,
        value: isCorrection ? "Pending amount validation" : action,
        updated: "Now",
        description: isCorrection
          ? "Separate correction record created; the issued source document remains unchanged."
          : `Controlled ${action.toLowerCase()} record created without mutating its source.`,
        facts: {
          "Source record": record.id,
          "Requested by": actorName,
          Reason: reason,
          "Effective date": effectiveDate || "Immediate after validation",
          Integrity: isCorrection
            ? "Original document preserved"
            : "Append-only movement or child record",
        },
        related: [record.name, `Audit ${event.id}`],
        source: "Controlled workflow",
        freshness: "Now",
        allowedTransitions: activeModule.lifecycle.slice(1, 3),
        companyId: record.companyId ?? FIXTURE_COMPANY_ID,
        projectIds:
          record.projectIds ?? selectedProjectIds(projectScope, {}),
        serviceProviderId: record.serviceProviderId ?? serviceProviderScopeId,
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
          "Action actor": actorName,
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
            formSchema?.recordKind === "Service area assignment" &&
            field.id === "serviceAreaId"
          ) {
            const assignedServiceProviderId =
              typeof values.serviceProviderId === "string" ? values.serviceProviderId : ""
            return record.serviceProviderId !== assignedServiceProviderId
          }
          // A service provider price belongs inside one of the service provider's own
          // awarded areas; until a service provider is picked, every area shows.
          if (
            formSchema?.recordKind === "Service provider price" &&
            field.id === "serviceAreaId"
          ) {
            const selectedServiceProviderId =
              typeof values.serviceProviderId === "string" ? values.serviceProviderId : ""
            return !selectedServiceProviderId || record.serviceProviderId === selectedServiceProviderId
          }
          return true
        })
        .filter((record) => !permittedIds || permittedIds.has(record.id))
        .filter(
          (record) =>
            !permittedStatuses ||
            permittedStatuses.has(record.status.toLowerCase()),
        )
        // Inside a service provider scope, records attributed to another service provider
        // are never offered. Service provider-operated entities must match the
        // scope exactly — company-operated ones are not the service provider's to
        // reference — while shared registries without attribution remain.
        .filter((record) => {
          if (!serviceProviderScopeId) return true
          if (serviceProviderOperatedRelationModuleIds.has(resolved.module.id)) {
            return record.serviceProviderId === serviceProviderScopeId
          }
          return (
            !record.serviceProviderId || record.serviceProviderId === serviceProviderScopeId
          )
        })
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
          label: record.name,
        }))
    },
    [serviceProviderScopeId, formSchema?.recordKind, getRecords, projectScope],
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
      ...(serviceProviderScopeId
        ? { serviceProviderId: serviceProviderScopeId, invitedBy: actorName }
        : {}),
      ...(relatedCreateTarget?.initialValues ?? {}),
    }),
    [actorName, serviceProviderScopeId, projectScope, relatedCreateTarget],
  )

  const editInitialValues = useMemo<BusinessFormValues>(() => {
    if (!editingRecord || !activeModuleFormSchema) return formInitialValues
    if (editingRecord.submittedValues) {
      const seeded = { ...formInitialValues, ...editingRecord.submittedValues }
      // Schemes saved before recurrence became structured hold values the
      // form can no longer offer: capitalized textarea day names, and the
      // retired biweekly/four-week/calendar-rule frequencies. Seed the
      // multiselect with the tokens that survive, map biweekly onto its
      // successor, and blank frequencies with no equivalent cadence so the
      // planner re-picks instead of hitting an unfixable validation error.
      if (activeModuleFormSchema.key === "route-studio.schemes") {
        if (typeof seeded.serviceDays === "string") {
          seeded.serviceDays = parseServiceDays(seeded.serviceDays).join(", ")
        }
        if (seeded.frequency === "biweekly") seeded.frequency = "every-2-weeks"
        if (seeded.frequency === "four-week" || seeded.frequency === "calendar-rule") {
          seeded.frequency = ""
        }
        // A legacy scheme without a planned start time must stay without one
        // (issue #32): seed the empty value explicitly, or the schema's
        // create-time default ("06:30") would silently re-inject a time the
        // planner never chose on any unrelated edit.
        if (typeof seeded.plannedStartTime !== "string") {
          seeded.plannedStartTime = ""
        }
      }
      // The frequency select keeps the retired `pickupSetting` field id
      // (issue #13) while records store the typed serviceFrequencyId (issue
      // #20) — and pre-#20 records hold option ids the select no longer
      // offers. Seed the select from whatever resolves so the dialog shows
      // the stored cadence instead of an empty select.
      if (activeModuleFormSchema.key === "resources.containers") {
        const stored =
          typeof seeded.pickupSetting === "string" ? seeded.pickupSetting : ""
        if (!serviceFrequencyById.has(stored)) {
          const definition = serviceFrequencyOfRecord(editingRecord)
          seeded.pickupSetting = definition?.id ?? ""
        }
      }
      // Scheme-generated routes store generation stamps (schemeId/serviceDate/
      // actualDate/appliedVehicle/appliedDriver — generation.ts), not the
      // quick form's field ids, so every field but Route Scheme would open
      // empty — and Project would show the workspace scope default instead of
      // the route's own project (issue #23). Map the stamps and the current
      // assignment facts onto the form fields; quick-created routes already
      // carry the form keys and are left alone.
      if (activeModuleFormSchema.key === "route-studio.routes") {
        if (typeof seeded.operatingDate !== "string" || !seeded.operatingDate) {
          const stampedDate =
            (typeof seeded.actualDate === "string" && seeded.actualDate) ||
            (typeof seeded.serviceDate === "string" && seeded.serviceDate) ||
            ""
          if (stampedDate) seeded.operatingDate = stampedDate
        }
        if (
          !editingRecord.submittedValues.projectId &&
          editingRecord.projectIds?.length
        ) {
          seeded.projectId = editingRecord.projectIds[0]
        }
        const resolveFleetRecordId = (
          moduleId: "vehicles" | "drivers",
          label: string | undefined,
        ) => {
          if (!label || /^unassigned$/i.test(label)) return ""
          const resolved = resolveFormModule("fleet", moduleId)
          if (!resolved) return ""
          // Route facts hold the vehicle callsign ("WH-31"), the registry
          // name carries the plate after it.
          return (
            getRecords(
              resolved.workspaceId,
              resolved.module.id,
              resolved.module.records,
            ).find(
              (candidate) =>
                candidate.name === label ||
                candidate.name.split(" · ")[0] === label,
            )?.id ?? ""
          )
        }
        // The facts are the current assignment — a Reassign writes facts
        // only, on purpose, so a previously-edited route's stored
        // vehicleId/driverId can be stale. Resolve from facts first and fall
        // back to whatever the record stored.
        const vehicleId = resolveFleetRecordId(
          "vehicles",
          editingRecord.facts.Vehicle ??
            (typeof seeded.appliedVehicle === "string"
              ? seeded.appliedVehicle
              : undefined),
        )
        if (vehicleId) seeded.vehicleId = vehicleId
        const driverId = resolveFleetRecordId(
          "drivers",
          editingRecord.facts.Driver ??
            (typeof seeded.appliedDriver === "string"
              ? seeded.appliedDriver
              : undefined),
        )
        if (driverId) seeded.driverId = driverId
      }
      return seeded
    }

    // Fixture records carry display facts only, so map them back onto the
    // form's fields by matching each fact against the permitted options.
    const values: BusinessFormValues = { ...formInitialValues }
    if (editingRecord.projectIds?.length === 1) {
      values.projectId = editingRecord.projectIds[0]
    }
    const fields = activeModuleFormSchema.sections.flatMap(
      (section) => section.fields,
    )
    const nameField = activeModuleFormSchema.nameField
      ? fields.find((field) => field.id === activeModuleFormSchema.nameField)
      : undefined
    if (
      nameField?.type === "text" &&
      !(typeof values[nameField.id] === "string" && values[nameField.id])
    ) {
      values[nameField.id] = editingRecord.name
    }
    for (const field of fields) {
      if (typeof values[field.id] === "string" && values[field.id]) continue
      const factValue = editingRecord.facts[field.label]?.trim()

      if (field.type === "date") {
        if (factValue && /^\d{4}-\d{2}-\d{2}$/.test(factValue)) {
          values[field.id] = factValue
        } else if (field.required) {
          // Only a required date needs a same-page fallback so the form
          // isn't born invalid. An optional date with no matching fact (e.g.
          // a price row's Effective to / Scheduled revert on) must stay
          // empty — defaulting it to today would silently write a real
          // value the record never had (ending the row's effective period,
          // or reverting a schedule before it starts).
          values[field.id] = localDateInputValue()
        }
        continue
      }

      if (!field.relation) {
        if (factValue) {
          // Facts store the option's display label; the select needs its value.
          const optionMatch = field.options?.find(
            (option) =>
              option.value === factValue ||
              option.label.toLowerCase() === factValue.toLowerCase(),
          )
          values[field.id] = optionMatch ? optionMatch.value : factValue
        } else if (field.id === "status" && isPriceEngineProducts) {
          // Products never carry a separate "Status" fact (top-level status
          // is the only source of truth), so falling through to the
          // schema's first option here would show every fixture product as
          // Active in the edit dialog and silently promote it on save.
          values[field.id] = editingRecord.status
        }
        continue
      }

      // Some records link a relation only through relationRefs and never
      // duplicate it as a display fact (e.g. a price row's Product) — prefer
      // that authoritative link over fuzzy label-matching when it names this
      // exact field. Multiselect fields can carry several refs per fieldId,
      // so they keep using the fact-based candidate matching below.
      if (field.type !== "multiselect") {
        const relationRef = editingRecord.relationRefs?.find(
          (ref) => ref.fieldId === field.id,
        )
        if (relationRef) {
          values[field.id] = relationRef.recordId
          continue
        }
      }

      const candidate =
        factValue ??
        (field.id === "schemeId"
          ? editingRecord.source.replace(/^route scheme\s*/i, "").trim()
          : undefined)
      if (!candidate || /^(unassigned|none|—)$/i.test(candidate)) continue

      const normalized = candidate.toLowerCase()
      const options = getFormRelationOptions(field, values)
      const match =
        options.find((option) =>
          option.label.toLowerCase().includes(normalized),
        ) ??
        options.find((option) => {
          const head = option.label.split("·")[0]?.trim().toLowerCase() ?? ""
          return (
            head.length > 0 &&
            (normalized.startsWith(head) || head.startsWith(normalized))
          )
        })
      if (match) values[field.id] = match.value
    }
    return values
  }, [
    activeModuleFormSchema,
    editingRecord,
    formInitialValues,
    getFormRelationOptions,
    getRecords,
    isPriceEngineProducts,
  ])

  const editFormSchema = useMemo<BusinessFormSchema | undefined>(() => {
    if (!editingRecord || !activeModuleFormSchema?.execution) return undefined
    const entity = activeModule.entityLabel
    return {
      ...activeModuleFormSchema,
      title: `Edit ${entity.toLowerCase()}`,
      description: `Update the linked records and details of ${editingRecord.name}. Changes are recorded with audit history.`,
      submitLabel: "Save changes",
      execution: {
        ...activeModuleFormSchema.execution,
        completionMessage: `The ${entity.toLowerCase()} was updated and its audit history extended.`,
      },
    }
  }, [activeModule.entityLabel, activeModuleFormSchema, editingRecord])

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
          if (record.id === editingRecord?.id) return false
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

      if (formSchema.key === "commercial.service-provider-prices") {
        const selectedServiceProviderId =
          typeof values.serviceProviderId === "string" ? values.serviceProviderId : ""
        const selectedRateProductId =
          typeof values.productId === "string" ? values.productId : ""
        const selectedAreaId =
          typeof values.serviceAreaId === "string" ? values.serviceAreaId : ""
        const validFrom = typeof values.validFrom === "string" ? values.validFrom : ""
        const validUntil = typeof values.validUntil === "string" ? values.validUntil : ""
        if (selectedServiceProviderId && selectedRateProductId && selectedAreaId && validFrom) {
          const areasTarget = resolveFormModule("service-providers", "service-areas")
          const areaName = areasTarget
            ? getRecords(
                areasTarget.workspaceId,
                areasTarget.module.id,
                areasTarget.module.records,
              ).find((record) => record.id === selectedAreaId)?.name
            : undefined
          // Fixture rates store the area code ("CA-Ø-2"); created rates store
          // the area record's full name ("CA-Ø-2 · Østerbro") — compare by code.
          const areaCode = areaName?.split(" · ")[0]?.trim()
          const overlapping = formTargetRecords.find((record) => {
            if (record.id === editingRecord?.id) return false
            if (record.recordKind !== "Service provider price") return false
            if (isSoftDeleted(record)) return false
            if (record.serviceProviderId !== selectedServiceProviderId) return false
            const recordProductId = record.relationRefs?.find(
              (ref) => ref.fieldId === "productId",
            )?.recordId
            if (recordProductId !== selectedRateProductId) return false
            const recordAreaCode = record.facts[RATE_FACTS.serviceArea]
              ?.split(" · ")[0]
              ?.trim()
            if (!areaCode || !recordAreaCode || recordAreaCode !== areaCode) return false
            const recordFrom = record.facts[RATE_FACTS.validFrom] ?? ""
            const recordUntil = record.facts[RATE_FACTS.validUntil] ?? ""
            const startsBeforeExistingEnds = !recordUntil || validFrom <= recordUntil
            const existingStartsBeforeNewEnds =
              !validUntil || !recordFrom || recordFrom <= validUntil
            return startsBeforeExistingEnds && existingStartsBeforeNewEnds
          })
          if (overlapping) {
            errors.validFrom = `Overlaps ${overlapping.name} (${
              overlapping.facts[RATE_FACTS.validFrom] ?? "?"
            } → ${
              overlapping.facts[RATE_FACTS.validUntil] ?? "open"
            }) for the same service provider, product, and service area.`
          }
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
      editingRecord?.id,
      formSchema,
      formTargetRecords,
      getRecords,
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

    if (formSchema.recordKind === "Service provider price indexation") {
      const ratesTarget = resolveFormModule("commercial", "service-provider-prices")
      if (!ratesTarget) return
      const rateRecords = getRecords("commercial", "service-provider-prices", ratesTarget.module.records)
      const pickedIds =
        typeof values.rateIds === "string" && values.rateIds
          ? values.rateIds.split(",").map((item) => item.trim()).filter(Boolean)
          : []
      const label = typeof values.indexLabel === "string" ? values.indexLabel.trim() : ""
      const percent = Number(values.percent)
      const base = values.base === "bid" ? ("bid" as const) : ("current fee" as const)
      const from = typeof values.effectiveFrom === "string" ? values.effectiveFrom : PRICING_REFERENCE_DATE
      if (pickedIds.length === 0 || !label || !Number.isFinite(percent)) {
        toast.error("Pick service provider prices, an index label, and a percent.")
        return
      }
      let indexed = 0
      for (const rateRecord of rateRecords) {
        if (!pickedIds.includes(rateRecord.id)) continue
        const updated = applyIndexToRate(recordToServiceProviderPrice(rateRecord), { label, percent, from, base })
        upsertRecord("commercial", "service-provider-prices", serviceProviderPriceToRecord(updated, rateRecord))
        indexed += 1
      }
      setIsCreateOpen(false)
      setRelatedCreateTarget(null)
      toast.success("Index applied", {
        description: `${indexed} service provider price${indexed === 1 ? "" : "s"} recomputed from ${base} (${label} +${percent}%). Bids untouched.`,
      })
      return
    }

    if (formSchema.recordKind === "Service area assignment") {
      const serviceAreaId =
        typeof values.serviceAreaId === "string" ? values.serviceAreaId : ""
      const serviceProviderId =
        typeof values.serviceProviderId === "string" ? values.serviceProviderId : ""
      const serviceAreaTarget = resolveFormModule("service-providers", "service-areas")
      const serviceProviderTarget = resolveFormModule("service-providers", "service-providers")
      const serviceArea = serviceAreaTarget
        ? getRecords(
            serviceAreaTarget.workspaceId,
            serviceAreaTarget.module.id,
            serviceAreaTarget.module.records,
          ).find((record) => record.id === serviceAreaId)
        : undefined
      const serviceProvider = serviceProviderTarget
        ? getRecords(
            serviceProviderTarget.workspaceId,
            serviceProviderTarget.module.id,
            serviceProviderTarget.module.records,
          ).find((record) => record.id === serviceProviderId)
        : undefined

      if (!serviceAreaTarget || !serviceArea || !serviceProvider) {
        toast.error("Select an available service area.")
        return
      }

      const previousServiceProvider = serviceArea.facts["Service provider"] || "Unassigned"
      const effectiveFrom =
        typeof values.effectiveFrom === "string" ? values.effectiveFrom : "Now"
      const assignmentReason =
        typeof values.reason === "string" ? values.reason : "Contract assignment"
      const updatedArea: BusinessRecord = {
        ...serviceArea,
        context: serviceArea.context.replace(previousServiceProvider, serviceProvider.name),
        updated: "Now",
        freshness: "Now",
        serviceProviderId,
        facts: {
          ...serviceArea.facts,
          "Service provider": serviceProvider.name,
          "Previous service provider": previousServiceProvider,
          "Assignment effective from": effectiveFrom,
          "Assignment reason": assignmentReason,
        },
        related: [
          `Service provider ${serviceProvider.name}`,
          ...serviceArea.related.filter((item) => !item.startsWith("Service provider ")),
        ],
        submittedValues: {
          ...serviceArea.submittedValues,
          serviceProviderId,
          effectiveFrom: values.effectiveFrom,
          reason: values.reason,
        },
        relationRefs: [
          ...(serviceArea.relationRefs ?? []).filter(
            (relation) => relation.fieldId !== "serviceProviderId",
          ),
          {
            fieldId: "serviceProviderId",
            workspaceId: "service-providers",
            moduleId: "service-providers",
            recordId: serviceProvider.id,
            label: serviceProvider.name,
          },
        ],
      }
      const assignmentEvent: AuditEvent = {
        id: `audit-service-area-assignment-${Date.now()}`,
        action: "Assign service area",
        actor: actorName,
        at: "Now",
        reason: assignmentReason,
        before: previousServiceProvider,
        after: serviceProvider.name,
        evidence: `Effective ${effectiveFrom} · existing service area retained`,
      }

      upsertRecord("service-providers", "service-areas", updatedArea)
      setAuditEvents((current) => ({
        ...current,
        [updatedArea.id]: [assignmentEvent, ...(current[updatedArea.id] ?? [])],
      }))
      setIsCreateOpen(false)
      setRelatedCreateTarget(null)
      toast.success("Service area assigned", {
        description: `${serviceArea.name} is now assigned to ${serviceProvider.name}.`,
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

    // Stored facts and context show the linked record's name, not the full
    // "name · context · status" option label used inside the dropdowns.
    const relationRecordName = (field: BusinessFormField, recordId: string) => {
      if (!field.relation) return undefined
      const resolved = resolveFormModule(
        field.relation.workspaceId,
        field.relation.moduleId,
      )
      if (!resolved) return undefined
      const name = getRecords(
        resolved.workspaceId,
        resolved.module.id,
        resolved.module.records,
      ).find((candidate) => candidate.id === recordId)?.name
      if (!name) return undefined
      // Vehicle names carry the registration plate; facts show the callsign.
      return resolved.workspaceId === "fleet" && resolved.module.id === "vehicles"
        ? name.split(" · ")[0]
        : name
    }

    const displayFormValue = (field: BusinessFormField, value: string | boolean) => {
      if (typeof value === "boolean") return value ? "Yes" : "No"
      const options = field.relation
        ? getFormRelationOptions(field, values)
        : field.options ?? []
      const optionLabel = (item: string) =>
        options.find((option) => option.value === item)?.label ?? item
      if (field.type === "multiselect") {
        return splitMultiValue(value)
          .map((item) => relationRecordName(field, item) ?? optionLabel(item))
          .join(" · ")
      }
      return relationRecordName(field, value) ?? optionLabel(value)
    }

    // Quick Create parity for Route Schemes (issue #31, D19/D29/P1): map the
    // form values onto the wizard's draft shape and share the guided path
    // end-to-end — same validateScheme, same canonical record shape, same
    // creation orchestration — instead of the generic record builder below
    // (whose facts/relations prelude is skipped entirely; the guided builder
    // writes the canonical shape itself). Every schema field the draft does
    // not consume is a quick-only extra carried onto the record verbatim:
    // submitted value, display fact, and relation ref.
    if (
      !editingRecord &&
      formSchema.key === "route-studio.schemes" &&
      activeModule.id === "schemes"
    ) {
      const extraValues: BusinessFormValues = {}
      const extraFacts: Record<string, string> = {}
      const extraRelations: NonNullable<BusinessRecord["relationRefs"]> = []
      for (const field of fields) {
        if (QUICK_SCHEME_DRAFT_FIELD_IDS.has(field.id)) continue
        const value = values[field.id]
        if (value === undefined || value === "") continue
        extraValues[field.id] = value
        extraFacts[field.label] = displayFormValue(field, value)
        if (field.relation && typeof value === "string") {
          const relationTarget = resolveFormModule(
            field.relation.workspaceId,
            field.relation.moduleId,
          )
          extraRelations.push({
            fieldId: field.id,
            workspaceId: relationTarget?.workspaceId ?? field.relation.workspaceId,
            moduleId: relationTarget?.module.id ?? field.relation.moduleId,
            recordId: value,
            label: relationRecordName(field, value) ?? value,
          })
        }
      }
      createSchemeFromDraft(quickSchemeDraftFromValues(values), {
        method: "Quick create",
        extraValues,
        extraFacts,
        extraRelations,
      })
      setIsCreateOpen(false)
      setRelatedCreateTarget(null)
      return
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
              relationRecordName(field, recordId) ??
              relationOptions.find((option) => option.value === recordId)
                ?.label ??
              recordId,
          })
        }
      }
    }

    // The service provider-scoped invite form omits Service provider, Allowed
    // service area, and Invited by, so stamp them onto the record from the signed-in
    // account instead. The project comes from the fixed workspace scope via
    // selectedProjectIds below.
    if (
      serviceProviderScopeId &&
      formSchema.key === "service-providers.service-provider-workspace" &&
      !editingRecord &&
      !values.serviceProviderId
    ) {
      const serviceProviderTarget = resolveFormModule("service-providers", "service-providers")
      const serviceProviderName = serviceProviderTarget
        ? getRecords(
            serviceProviderTarget.workspaceId,
            serviceProviderTarget.module.id,
            serviceProviderTarget.module.records,
          ).find((record) => record.id === serviceProviderScopeId)?.name
        : undefined
      if (serviceProviderName) {
        facts["Service provider"] = serviceProviderName
        relationRefs.push({
          fieldId: "serviceProviderId",
          workspaceId: "service-providers",
          moduleId: "service-providers",
          recordId: serviceProviderScopeId,
          label: serviceProviderName,
        })
      }
      const areaTarget = resolveFormModule("service-providers", "service-areas")
      const serviceProviderAreas = areaTarget
        ? getRecords(
            areaTarget.workspaceId,
            areaTarget.module.id,
            areaTarget.module.records,
          ).filter((record) => record.serviceProviderId === serviceProviderScopeId)
        : []
      if (serviceProviderAreas.length === 1) {
        facts["Allowed service area"] = serviceProviderAreas[0].name
        relationRefs.push({
          fieldId: "serviceAreaId",
          workspaceId: "service-providers",
          moduleId: "service-areas",
          recordId: serviceProviderAreas[0].id,
          label: serviceProviderAreas[0].name,
        })
      }
      facts["Invited by"] = actorName
    }

    const now = Date.now()
    const nameField = formSchema.nameField
      ? fieldById.get(formSchema.nameField)
      : undefined
    const submittedNameValue =
      nameField && values[nameField.id] !== undefined
        ? displayFormValue(nameField, values[nameField.id])
        : ""
    // Service provider users are captured as First/Last name fields; the record
    // name is the composed full name.
    const serviceProviderUserName =
      formSchema.key === "service-providers.service-provider-workspace"
        ? [values.firstName, values.lastName]
            .filter(
              (part): part is string =>
                typeof part === "string" && part.trim().length > 0,
            )
            .map((part) => part.trim())
            .join(" ")
        : ""
    const nameValue =
      submittedNameValue ||
      serviceProviderUserName ||
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
    const recordName =
      formSchema.key === "route-studio.routes"
        ? // Routes carry no user-entered name; the system issues the Route ID.
          `RC-${String(now).slice(-4)}`
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

    // The generic path stores select-field facts as their display label
    // (e.g. Unit → "€ per pickup"), but a price row's Unit fact must stay the
    // raw PriceUnit enum ("pickup") for recordToPriceRow/unitSuffix to read
    // it back correctly — normalize it here, then derive the row's display
    // name and headline value the same way both on create and on edit.
    const normalizePriceRowRecord = (record: BusinessRecord): BusinessRecord => {
      const submittedUnit = typeof values.unit === "string" ? values.unit : undefined
      const withUnit = submittedUnit
        ? { ...record, facts: { ...record.facts, [ROW_FACTS.unit]: submittedUnit } }
        : record
      const row = recordToPriceRow(withUnit)
      return row
        ? { ...withUnit, name: rowDisplayName(row), value: `${money(row.amount)}${unitSuffix(row.unit)}` }
        : withUnit
    }

    // Same class of bug on the products module's generic edit path (row
    // Actions → Edit): the Unit field's LABEL ("€ per pickup") lands in the
    // Unit fact instead of the raw enum, the VAT rate field's label lands
    // under its own field label "VAT rate" instead of the product's "VAT"
    // fact, and — unlike create, which derives status via initialFormStatus
    // — a generic edit never re-derives top-level status at all, so it can
    // drift from a Status-shaped fact the form also writes. Fix all three so
    // the generic path agrees with the Settings product editor's fact shape;
    // top-level status is the source of truth, so no separate Status fact
    // is kept.
    const normalizeProductRecord = (record: BusinessRecord): BusinessRecord => {
      const submittedUnit = typeof values.priceUnit === "string" ? values.priceUnit : undefined
      const submittedStatus =
        typeof values.status === "string" && values.status ? values.status : undefined
      const nextFacts = { ...record.facts }
      if (submittedUnit) nextFacts[PRODUCT_FACTS.unit] = submittedUnit
      // The generic path stores the multiselect fact as its display join
      // ("A · B"), but splitList consumers of the Service levels fact parse a
      // comma-separated list — rewrite it from the raw submitted value, and
      // treat an emptied selection as clearing the fact.
      if (typeof values.serviceLevels === "string") {
        const levels = values.serviceLevels
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
        if (levels.length > 0) nextFacts[PRODUCT_FACTS.serviceLevels] = levels.join(", ")
        else delete nextFacts[PRODUCT_FACTS.serviceLevels]
      }
      delete nextFacts["VAT rate"]
      delete nextFacts["Status"]
      // Field labels that are not product facts: the name duplicates the
      // record's own name, and Default price / Effective from describe the
      // product's no-conditions price row, not the product. The edit host no
      // longer offers the price fields, so this also scrubs the strays left
      // behind on records edited before that section was dropped.
      delete nextFacts["Product name"]
      delete nextFacts["Default price"]
      delete nextFacts["Effective from"]
      // contextFieldIds names two of those dropped price fields, so derive the
      // context line from the product's own facts — the same shape the
      // Settings product editor writes — instead of letting it degrade to the
      // product type alone.
      const unit = (nextFacts[PRODUCT_FACTS.unit] as PriceUnit) || "pickup"
      const productType = nextFacts[PRODUCT_FACTS.type]
      return {
        ...record,
        context: productType ? `${productType} · ${unitSuffix(unit)}` : record.context,
        facts: nextFacts,
        status: submittedStatus ?? record.status,
      }
    }

    // Service provider prices get the same treatment: the Unit fact must stay the
    // raw PriceUnit enum, the current fee tracks the locked bid until the
    // first Apply index run, and name/context/status/value are derived the
    // way the fixture rates shape them.
    const normalizeServiceProviderPriceRecord = (
      record: BusinessRecord,
    ): BusinessRecord => {
      const submittedUnit = typeof values.unit === "string" ? values.unit : undefined
      const nextFacts = { ...record.facts }
      if (submittedUnit) nextFacts[RATE_FACTS.unit] = submittedUnit
      const bid = Number(nextFacts[RATE_FACTS.bid])
      if (Number.isFinite(bid)) {
        nextFacts[RATE_FACTS.bid] = bid.toFixed(2)
        // An already-indexed rate keeps its recomputed current fee.
        if (!nextFacts[RATE_FACTS.lastIndexed]) {
          nextFacts[RATE_FACTS.currentFee] = bid.toFixed(2)
        }
      }
      const rate = recordToServiceProviderPrice({ ...record, facts: nextFacts })
      return {
        ...record,
        name:
          rate.serviceProvider && rate.productName
            ? `${rate.serviceProvider} · ${rate.productName}`
            : record.name,
        context: [
          rate.serviceArea,
          rate.validUntil ? `${rate.validFrom} → ${rate.validUntil}` : rate.validFrom,
        ]
          .filter(Boolean)
          .join(" · "),
        status: deriveServiceProviderPriceStatus(
          rate.validFrom,
          rate.validUntil || undefined,
        ),
        value: `${money(rate.currentFee)}${unitSuffix(rate.unit)}`,
        description: `Service provider price: locked bid ${money(rate.bid)}, current fee ${money(rate.currentFee)}.`,
        source: "Contract management",
        facts: nextFacts,
      }
    }

    // A scheme's recurrence is machine-readable in submittedValues (frequency,
    // serviceDays, weekRotation, effectiveFrom/To, plannedStartTime — the shape
    // lib/route-schemes/recurrence reads); the facts get the one-line summary
    // the record detail shows.
    const normalizeRouteSchemeRecord = (record: BusinessRecord): BusinessRecord => {
      const nextFacts = { ...record.facts }
      // Keep the stop-selection facts in sync with the merged values
      // (issue #19): the quick edit form can flip the mode or change the
      // shared rule, and the facts must follow the stopSelection flag —
      // stale rule facts on a manual scheme (or vice versa) would misstate
      // where its stops come from.
      const mergedValues = { ...record.submittedValues }
      // The quick form's label-keyed facts duplicate the canonical
      // "Container selection" / "Stop matching" / "Planned start" keys.
      delete nextFacts["Stop selection"]
      delete nextFacts["Waste fractions to match"]
      delete nextFacts["Vehicle type"]
      delete nextFacts["Planned start time"]
      // Keep the canonical fact in step with the merged value: an edit that
      // clears the planned start time really clears it (issue #32) — a stale
      // fact would resurrect the old time in generation and the detail page.
      const plannedStartTime =
        typeof mergedValues.plannedStartTime === "string"
          ? mergedValues.plannedStartTime.trim()
          : ""
      if (plannedStartTime) nextFacts["Planned start"] = plannedStartTime
      else delete nextFacts["Planned start"]
      if (stopSelectionMode(mergedValues) === "rule") {
        const matchPlans = matchPlansFromValues(mergedValues)
        nextFacts["Container selection"] = "Matched by rule"
        nextFacts["Stop matching"] = matchPlans.sameAllDays
          ? stopRuleSummary(matchPlans.sharedRule)
          : effectiveDayRules(serviceDaysFromValues(mergedValues), matchPlans)
              .map(
                ({ day, rule }) =>
                  `${SERVICE_DAY_SHORT_LABELS[day]}: ${stopRuleSummary(rule)}`,
              )
              .join(" · ")
      } else if (nextFacts["Stop matching"]) {
        delete nextFacts["Stop matching"]
        nextFacts["Container selection"] =
          mergedValues.sameAllDays !== false
            ? "Same containers every day"
            : "Different per day"
      }
      const recurrence = recurrenceFromValues(values)
      if (!recurrence) return { ...record, facts: nextFacts }
      // The retired free-text cadence field, and — when the frequency moved
      // away from every-2-weeks — the rotation fact the edit merge would
      // otherwise carry forward against the new Recurrence line.
      delete nextFacts["Collection weeks or rule"]
      if (recurrence.frequency !== "every-2-weeks") delete nextFacts["Week rotation"]
      return {
        ...record,
        facts: { ...nextFacts, Recurrence: recurrenceSentence(recurrence) },
      }
    }

    // Route facts use the generation keys ("Operating date", "Route scheme" —
    // generation.ts); the quick form writes its own field labels ("Date",
    // "Route Scheme") beside them, so an edited generated route would carry
    // both spellings with diverging values (issue #23). Fold the label-keyed
    // facts onto the canonical keys and keep the generated "Project · Area"
    // context line instead of the form's full field dump.
    const normalizeRouteRecord = (record: BusinessRecord): BusinessRecord => {
      const nextFacts = { ...record.facts }
      const nextValues = { ...record.submittedValues }
      if (nextFacts.Date) {
        nextFacts["Operating date"] = /^\d{4}-\d{2}-\d{2}$/.test(nextFacts.Date)
          ? formatServiceDate(nextFacts.Date)
          : nextFacts.Date
        delete nextFacts.Date
      }
      if (nextFacts["Route Scheme"]) {
        nextFacts["Route scheme"] = nextFacts["Route Scheme"]
        delete nextFacts["Route Scheme"]
      }
      const operatingDate =
        typeof values.operatingDate === "string" ? values.operatingDate : ""
      const isSchemeGenerated =
        typeof nextValues.schemeId === "string" &&
        typeof nextValues.serviceDate === "string" &&
        Boolean(nextValues.serviceDate)
      // The (schemeId, serviceDate) pair is the regeneration identity and the
      // record id encodes it, so serviceDate must never move — regeneration
      // would otherwise resurrect the old date under this route's id and
      // cancel the edited one. An edited date is a manual move of when the
      // route actually runs, the same shape as a deviation: actualDate only.
      if (operatingDate && isSchemeGenerated) {
        nextValues.actualDate = operatingDate
      }
      const generatedContext = [nextFacts.Project, nextFacts.Area]
        .filter(Boolean)
        .join(" · ")
      return {
        ...record,
        ...(isSchemeGenerated && generatedContext
          ? { context: generatedContext }
          : {}),
        facts: nextFacts,
        submittedValues: nextValues,
      }
    }

    // Tickets keep their classification facts under the fixture keys (Type,
    // Team) so table columns and filters read one shape regardless of whether
    // a ticket was seeded or submitted, and the record description is the
    // submitted case description rather than the form's boilerplate.
    const normalizeTicketRecord = (record: BusinessRecord): BusinessRecord => {
      const nextFacts = { ...record.facts }
      if (nextFacts["Ticket type"] && !nextFacts.Type) {
        nextFacts.Type = nextFacts["Ticket type"]
      }
      delete nextFacts["Ticket type"]
      if (nextFacts["Assigned team"] && !nextFacts.Team) {
        nextFacts.Team = nextFacts["Assigned team"]
      }
      delete nextFacts["Assigned team"]
      const caseDescription =
        typeof values.description === "string" ? values.description.trim() : ""
      return {
        ...record,
        description: caseDescription || record.description,
        facts: nextFacts,
      }
    }

    // Containers migrated their cadence fact off the retired "Pickup
    // setting" key (issue #13); the edit merge would otherwise carry the
    // stale retired key (and the drifted calendar name) forward forever.
    // Since issue #20 the cadence is a typed reference: saving also resolves
    // whatever shape the record carries (the form's retained `pickupSetting`
    // value, a legacy option id, or a legacy fact string) onto
    // submittedValues.serviceFrequencyId and re-derives the display fact.
    const normalizeContainerRecord = (record: BusinessRecord): BusinessRecord => {
      const nextFacts = { ...record.facts }
      if (nextFacts["Pickup setting"] && !nextFacts["Service frequency"]) {
        nextFacts["Service frequency"] = nextFacts["Pickup setting"]
      }
      delete nextFacts["Pickup setting"]
      const calendar = canonicalCalendarName(nextFacts["Collection calendar"])
      if (calendar) nextFacts["Collection calendar"] = calendar
      const nextValues = { ...record.submittedValues }
      // The just-submitted form value wins over a stale serviceFrequencyId
      // carried forward by the edit merge; the fact string recovers records
      // whose select prefilled empty (pre-#20 option ids are not options).
      const submittedFrequency =
        typeof values.pickupSetting === "string" ? values.pickupSetting : ""
      const definition =
        resolveServiceFrequencyValue(submittedFrequency) ??
        resolveServiceFrequencyValue(nextFacts["Service frequency"]) ??
        serviceFrequencyOfRecord({ facts: nextFacts, submittedValues: nextValues })
      if (definition) {
        nextValues.serviceFrequencyId = definition.id
        // The retained form field id mirrors the typed key so the edit
        // dialog's select prefills on the next open.
        nextValues.pickupSetting = definition.id
        nextFacts["Service frequency"] = definition.name
      }
      return { ...record, facts: nextFacts, submittedValues: nextValues }
    }

    // Agreements store no frequency of their own (issue #20): the promise
    // lives on the assigned container's frequency record, and the agreement
    // displays what it inherits. Saving derives the fact from the linked
    // container — "—" when that container promises no cadence, so a
    // reassignment never carries the previous container's promise forward —
    // and drops the retired free-text value. Records whose link cannot be
    // resolved (no container, or a deleted one) keep their stored fact.
    const normalizeAgreementRecord = (record: BusinessRecord): BusinessRecord => {
      const containerId =
        (typeof record.submittedValues?.containerId === "string"
          ? record.submittedValues.containerId
          : "") ||
        record.relationRefs?.find((ref) => ref.fieldId === "containerId")?.recordId
      if (!containerId) return record
      const resolved = resolveFormModule("resources", "containers")
      const container = resolved
        ? getRecords(resolved.workspaceId, resolved.module.id, resolved.module.records).find(
            (candidate) => candidate.id === containerId,
          )
        : undefined
      if (!container) return record
      const nextValues = { ...record.submittedValues }
      delete nextValues.serviceFrequency
      return {
        ...record,
        facts: {
          ...record.facts,
          "Service frequency": serviceFrequencyOfRecord(container)?.name ?? "—",
        },
        submittedValues: nextValues,
      }
    }

    // The inherited fact would otherwise go stale when the container's own
    // frequency changes: a container save re-derives it on every agreement
    // linked to that container (the updated copy shadows a fixture record).
    const syncAgreementsForContainer = (container: BusinessRecord) => {
      const resolved = resolveFormModule("customers", "agreements")
      if (!resolved) return
      const derived = serviceFrequencyOfRecord(container)?.name ?? "—"
      for (const agreement of getRecords(
        resolved.workspaceId,
        resolved.module.id,
        resolved.module.records,
      )) {
        const linkedId =
          (typeof agreement.submittedValues?.containerId === "string"
            ? agreement.submittedValues.containerId
            : "") ||
          agreement.relationRefs?.find((ref) => ref.fieldId === "containerId")?.recordId
        if (linkedId !== container.id) continue
        if (agreement.facts["Service frequency"] === derived) continue
        upsertRecord(resolved.workspaceId, resolved.module.id, {
          ...agreement,
          facts: { ...agreement.facts, "Service frequency": derived },
        })
      }
    }

    if (editingRecord) {
      let updatedRecord: BusinessRecord = {
        ...editingRecord,
        // Only user-named records can be renamed; system-issued and
        // action-derived names stay untouched.
        name:
          serviceProviderUserName ||
          (nameField?.type === "text" && submittedNameValue
            ? submittedNameValue
            : editingRecord.name),
        context: contextValues.join(" · ") || editingRecord.context,
        updated: "Now",
        freshness: "Now",
        facts: { ...editingRecord.facts, ...facts },
        submittedValues: { ...editingRecord.submittedValues, ...values },
        relationRefs,
        projectIds,
      }
      if (resolvedTarget.module.id === "price-rows") {
        updatedRecord = normalizePriceRowRecord(updatedRecord)
      }
      if (resolvedTarget.module.id === "products") {
        updatedRecord = normalizeProductRecord(updatedRecord)
      }
      if (resolvedTarget.module.id === "service-provider-prices") {
        updatedRecord = normalizeServiceProviderPriceRecord(updatedRecord)
      }
      if (resolvedTarget.module.id === "tickets") {
        updatedRecord = normalizeTicketRecord(updatedRecord)
      }
      if (resolvedTarget.module.id === "routes") {
        updatedRecord = normalizeRouteRecord(updatedRecord)
      }
      let schemeEdit: SchemeEditReconciliationPlan | null = null
      if (resolvedTarget.module.id === "schemes") {
        updatedRecord = normalizeRouteSchemeRecord(updatedRecord)
        // Edit-save reconciliation (issue #33, D31): the lifecycle seam
        // revalidates the edited scheme and reshapes the future planning
        // window — this handler only applies the returned upserts.
        const moduleRecords = (
          workspaceId: WorkspaceId,
          moduleId: string,
        ): BusinessRecord[] => {
          const module = businessWorkspaces[workspaceId].modules.find(
            (candidate) => candidate.id === moduleId,
          )
          return module ? getRecords(workspaceId, module.id, module.records) : []
        }
        schemeEdit = planSchemeEditReconciliation(
          {
            before: editingRecord,
            after: updatedRecord,
            today: todayIso(),
            actorName,
          },
          {
            schemes: getRecords(
              resolvedTarget.workspaceId,
              resolvedTarget.module.id,
              resolvedTarget.module.records,
            ),
            existingRoutes: moduleRecords("route-studio", "routes"),
            existingPickups: moduleRecords("route-studio", "pickups"),
            containers: moduleRecords("resources", "containers"),
            vehicles: moduleRecords("fleet", "vehicles"),
            allocations: moduleRecords("fleet", "vehicle-planning"),
            calendarRecords: moduleRecords("plan", "calendars"),
            deviationRecords: moduleRecords("plan", "collection-deviations"),
          },
        )
        updatedRecord = schemeEdit.scheme
      }
      if (resolvedTarget.module.id === "containers") {
        updatedRecord = normalizeContainerRecord(updatedRecord)
      }
      if (resolvedTarget.module.id === "agreements") {
        updatedRecord = normalizeAgreementRecord(updatedRecord)
      }
      const editEvent: AuditEvent = {
        id: `audit-edit-${now}`,
        action: `Edit ${activeModule.entityLabel.toLowerCase()}`,
        actor: actorName,
        at: "Now",
        reason: preferredReason(values),
        before: editingRecord.status,
        after: updatedRecord.status,
        evidence: `${relationRefs.length} linked records · ${projectScopeLabel(
          projectIds,
        )} scope validated`,
      }

      upsertRecord(
        resolvedTarget.workspaceId,
        resolvedTarget.module.id,
        updatedRecord,
      )
      if (schemeEdit) {
        for (const route of schemeEdit.routes) {
          upsertRecord("route-studio", "routes", route)
        }
        for (const pickup of schemeEdit.pickups) {
          upsertRecord("route-studio", "pickups", pickup)
        }
      }
      if (resolvedTarget.module.id === "price-rows") {
        syncProductForRow(updatedRecord)
      }
      if (resolvedTarget.module.id === "containers") {
        syncAgreementsForContainer(updatedRecord)
      }
      setAuditEvents((current) => ({
        ...current,
        [updatedRecord.id]: [editEvent, ...(current[updatedRecord.id] ?? [])],
      }))
      if (selectedRecord?.id === updatedRecord.id) {
        setSelectedRecord(updatedRecord)
      }
      setEditingRecord(null)
      if (schemeEdit) {
        // The reconciliation consequence line replaces the generic edit toast
        // (issue #33): saving IS the action that reshaped future routes.
        if (schemeEdit.outcome === "draft") {
          toast.warning(`${updatedRecord.name} saved as Draft`, {
            description: schemeEdit.message,
          })
        } else if (schemeEdit.outcome === "generation-failed") {
          toast.warning(`${updatedRecord.name} updated`, {
            description: schemeEdit.message,
          })
        } else {
          toast.success(`${updatedRecord.name} updated`, {
            description: schemeEdit.message,
          })
        }
        return
      }
      toast.success(`${formSchema.recordKind} updated`, {
        description: `${updatedRecord.name} was updated and its audit history extended.`,
      })
      return
    }

    let newRecord: BusinessRecord = {
      id: `${resolvedTarget.module.id}-${formSchema.recordKind
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")}-${now}`,
      name: recordName,
      context: contextValues.join(" · ") || projectScopeLabel(projectIds),
      status: initialFormStatus(resolvedTarget.module, formSchema, values),
      owner: actorName,
      value: formSchema.execution.resultValue ?? formSchema.submitLabel,
      updated: "Now",
      description: formSchema.description,
      facts: {
        Scope: projectScopeLabel(projectIds),
        "Record kind": formSchema.recordKind,
        "Execution policy": formSchema.execution.kind.replaceAll("-", " "),
        "Submitted by": actorName,
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
      serviceProviderId:
        typeof values.serviceProviderId === "string" && values.serviceProviderId
          ? values.serviceProviderId
          : serviceProviderScopeId,
      recordKind: formSchema.recordKind,
      submittedValues: values,
      relationRefs,
    }
    if (resolvedTarget.module.id === "price-rows") {
      newRecord = normalizePriceRowRecord(newRecord)
    }
    if (resolvedTarget.module.id === "products") {
      newRecord = normalizeProductRecord(newRecord)
    }
    if (resolvedTarget.module.id === "service-provider-prices") {
      newRecord = normalizeServiceProviderPriceRecord(newRecord)
    }
    if (resolvedTarget.module.id === "tickets") {
      newRecord = normalizeTicketRecord(newRecord)
    }
    if (resolvedTarget.module.id === "routes") {
      newRecord = normalizeRouteRecord(newRecord)
    }
    if (resolvedTarget.module.id === "schemes") {
      newRecord = normalizeRouteSchemeRecord(newRecord)
    }
    if (resolvedTarget.module.id === "containers") {
      newRecord = normalizeContainerRecord(newRecord)
    }
    if (resolvedTarget.module.id === "agreements") {
      newRecord = normalizeAgreementRecord(newRecord)
    }
    const creationEvent: AuditEvent = {
      id: `audit-form-${now}`,
      action: formSchema.submitLabel,
      actor: actorName,
      at: "Now",
      reason: preferredReason(values),
      before: "Absent",
      after: newRecord.status,
      evidence: `${relationRefs.length} linked records · ${projectScopeLabel(
        projectIds,
      )} scope validated`,
    }

    upsertRecord(resolvedTarget.workspaceId, resolvedTarget.module.id, newRecord)
    if (resolvedTarget.module.id === "price-rows") {
      const createdRow = recordToPriceRow(newRecord)
      syncProductForRow(newRecord, {
        historyWhat: createdRow?.negotiatedCustomer
          ? `Negotiated deal added for ${createdRow.negotiatedCustomer}`
          : "Variation added",
      })
    }
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

  const handleGuidedRouteCreate = (data: GuidedRouteData) => {
    const now = Date.now()
    const relationRefs: NonNullable<BusinessRecord["relationRefs"]> = []
    const linkRecord = (
      fieldId: string,
      workspaceId: WorkspaceId,
      moduleId: string,
      recordId?: string,
    ) => {
      if (!recordId) return undefined
      const resolved = resolveFormModule(workspaceId, moduleId)
      if (!resolved) return undefined
      const record = getRecords(
        resolved.workspaceId,
        resolved.module.id,
        resolved.module.records,
      ).find((candidate) => candidate.id === recordId)
      if (!record) return undefined
      relationRefs.push({
        fieldId,
        workspaceId: resolved.workspaceId,
        moduleId: resolved.module.id,
        recordId,
        label: record.name,
      })
      return record
    }

    const project = linkRecord("projectId", "configure", "organization", data.projectId)
    const serviceProvider = linkRecord(
      "serviceProviderId",
      "service-providers",
      "service-providers",
      data.serviceProviderId,
    )
    const vehicle = linkRecord("vehicleId", "fleet", "vehicles", data.vehicleId)
    const driver = linkRecord("driverId", "fleet", "drivers", data.driverId)
    const containerRecords = data.containerIds
      .map((containerId) =>
        linkRecord("containerIds", "resources", "containers", containerId),
      )
      .filter((record): record is BusinessRecord => Boolean(record))

    const projectIds = selectedProjectIds(projectScope, {
      projectId: data.projectId ?? "",
    })
    // Vehicle names carry the registration plate; facts show the callsign.
    const vehicleName = vehicle?.name.split(" · ")[0]
    const facts: Record<string, string> = {
      Scope: projectScopeLabel(projectIds),
      "Record kind": "Route",
      "Execution policy": "create record",
      "Submitted by": actorName,
      ...(project ? { Project: project.name } : {}),
      // The canonical date fact key routes share with generation (issue #23).
      ...(data.date ? { "Operating date": formatServiceDate(data.date) } : {}),
      ...(serviceProvider ? { "Service provider": serviceProvider.name } : {}),
      ...(data.homeDepot ? { "Home depot": data.homeDepot } : {}),
      ...(data.wasteStation ? { "Waste station": data.wasteStation } : {}),
      Vehicle: vehicleName ?? "Unassigned",
      Driver: driver?.name ?? "Unassigned",
      ...(data.wasteFraction ? { "Waste fraction": data.wasteFraction } : {}),
      ...(data.containerType ? { "Container type": data.containerType } : {}),
      ...(containerRecords.length
        ? {
            Containers: containerRecords
              .map((record) => record.name)
              .join(" · "),
          }
        : {}),
    }

    const newRecord: BusinessRecord = {
      id: `${activeModule.id}-route-${now}`,
      // Routes carry no user-entered name; the system issues the Route ID.
      name: `RC-${String(now).slice(-4)}`,
      context:
        [project?.name, data.date, serviceProvider?.name].filter(Boolean).join(" · ") ||
        projectScopeLabel(projectIds),
      status:
        activeModuleFormSchema?.execution?.initialStatus ??
        activeModule.lifecycle[0] ??
        "Planned",
      owner: actorName,
      value:
        activeModuleFormSchema?.execution?.resultValue ??
        "Stops pending generation",
      updated: "Now",
      description:
        "Created with Guided Setup covering project, date, responsibility, fleet, locations, and containers.",
      facts,
      related: [
        ...relationRefs.map((relation) => relation.label),
        "Audit history created",
      ],
      source: "Office workspace",
      freshness: "Now",
      allowedTransitions: activeModule.lifecycle.slice(1, 3),
      companyId: FIXTURE_COMPANY_ID,
      projectIds,
      serviceProviderId: data.serviceProviderId ?? serviceProviderScopeId,
      recordKind: "Route",
      submittedValues: {
        projectId: data.projectId ?? "",
        operatingDate: data.date ?? "",
        serviceProviderId: data.serviceProviderId ?? "",
        homeDepot: data.homeDepot ?? "",
        wasteStation: data.wasteStation ?? "",
        vehicleId: data.vehicleId ?? "",
        driverId: data.driverId ?? "",
        wasteFraction: data.wasteFraction ?? "",
        containerType: data.containerType ?? "",
        containerIds: data.containerIds.join(","),
      },
      relationRefs,
    }
    const creationEvent: AuditEvent = {
      id: `audit-guided-route-${now}`,
      action: "Create route · Guided Setup",
      actor: actorName,
      at: "Now",
      reason: "Guided Setup",
      before: "Absent",
      after: newRecord.status,
      evidence: `${relationRefs.length} linked records · ${projectScopeLabel(
        projectIds,
      )} scope validated`,
    }

    upsertRecord(workspace.id, activeModule.id, newRecord)
    setAuditEvents((current) => ({
      ...current,
      [newRecord.id]: [creationEvent],
    }))
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
    toast.success("Route created", {
      description: `${newRecord.name} was created with Guided Setup.`,
    })
  }

  // Route Scheme creation shared by both create paths (spec FR-2/FR-5/FR-14;
  // issue #31, D19/P1): builds the record from the draft, decides Validated vs
  // Draft with the blocking checks, keeps submittedValues in the shape the
  // recurrence engine and per-day plan readers consume, and applies the
  // creation orchestration. Guided Setup hands the wizard draft in directly;
  // Quick Create maps its form values onto the same draft shape
  // (quickSchemeDraftFromValues) — one path, so the two cannot drift.
  const createSchemeFromDraft = (
    data: GuidedSchemeData,
    origin: {
      method: "Guided Setup" | "Quick create"
      /** Quick-form fields outside the canonical draft, carried verbatim. */
      extraValues?: BusinessFormValues
      extraFacts?: Record<string, string>
      extraRelations?: NonNullable<BusinessRecord["relationRefs"]>
    },
  ) => {
    const now = Date.now()
    const relationRefs: NonNullable<BusinessRecord["relationRefs"]> = []
    const linkRecord = (
      fieldId: string,
      workspaceId: WorkspaceId,
      moduleId: string,
      recordId?: string,
    ) => {
      if (!recordId) return undefined
      const resolved = resolveFormModule(workspaceId, moduleId)
      if (!resolved) return undefined
      const record = getRecords(
        resolved.workspaceId,
        resolved.module.id,
        resolved.module.records,
      ).find((candidate) => candidate.id === recordId)
      if (!record) return undefined
      relationRefs.push({
        fieldId,
        workspaceId: resolved.workspaceId,
        moduleId: resolved.module.id,
        recordId,
        label: record.name,
      })
      return record
    }

    const project = linkRecord("projectId", "configure", "organization", data.projectId)
    const area = linkRecord("planningAreaId", "plan", "areas", data.planningAreaId)
    const calendar = linkRecord("calendarId", "plan", "calendars", data.calendarId)
    const serviceProvider = linkRecord(
      "serviceProviderId",
      "service-providers",
      "service-providers",
      data.serviceProviderId,
    )
    const vehicle = linkRecord("plannedVehicleId", "fleet", "vehicles", data.plannedVehicleId)
    const driver = linkRecord("plannedDriverId", "fleet", "drivers", data.plannedDriverId)
    const depot = linkRecord("depotId", "resources", "depots", data.depotId)
    const unloadingStation = linkRecord(
      "unloadingStationId",
      "resources",
      "depots",
      data.unloadingStationId,
    )

    const isRuleScheme = data.stopSelection === "rule"
    const containersModule = businessWorkspaces.resources.modules.find(
      (candidate) => candidate.id === "containers",
    )
    const containerRecords = containersModule
      ? getRecords("resources", containersModule.id, containersModule.records)
      : []
    const vehiclesModule = businessWorkspaces.fleet.modules.find(
      (candidate) => candidate.id === "vehicles",
    )
    const vehicleRecords = vehiclesModule
      ? getRecords("fleet", vehiclesModule.id, vehiclesModule.records)
      : []

    const normalizedPlans = schemeDayPlans(data)
    const normalizedMatchPlans = schemeMatchPlans(data)
    // Rule mode resolves the rule at creation time for the display counts;
    // manual mode expands the picked lists. Only manual picks become
    // container relationRefs — a rule-mode scheme stores the rule, never the
    // resolved result (issue #19), so generation re-resolves each run.
    const dayPlans = resolvedDraftPlans(data, containerRecords)
    if (!isRuleScheme) {
      for (const containerId of new Set(
        dayPlans.flatMap((plan) => plan.containerIds),
      )) {
        linkRecord("containerIds", "resources", "containers", containerId)
      }
    }
    if (origin.extraRelations) relationRefs.push(...origin.extraRelations)

    // Conflicts (FR-5d) are checked against every scheme, not just the ones a
    // service provider-scoped view can see — a double-booked default is real either
    // way, and the review step's preview uses the same unscoped set. Vehicle
    // Planning allocations join the check the same way (issue #11).
    const allocationModule = businessWorkspaces.fleet.modules.find(
      (candidate) => candidate.id === "vehicle-planning",
    )
    const validation = validateGuidedScheme(
      data,
      getRecords(workspace.id, activeModule.id, activeModule.records),
      calendarFromRecord(calendar),
      allocationModule
        ? getRecords("fleet", allocationModule.id, allocationModule.records)
        : [],
      containerRecords,
      vehicleRecords,
    )

    const submittedValues: NonNullable<BusinessRecord["submittedValues"]> = {
      ...(origin.extraValues ?? {}),
      schemeName: data.schemeName.trim(),
      projectId: data.projectId ?? "",
      planningAreaId: data.planningAreaId ?? "",
      calendarId: data.calendarId ?? "",
      frequency: data.frequency,
      weekRotation: data.frequency === "every-2-weeks" ? data.weekRotation : "",
      serviceDays: data.serviceDays.join(", "),
      effectiveFrom: data.effectiveFrom,
      effectiveTo: data.effectiveTo,
      plannedStartTime: data.plannedStartTime,
      serviceProviderId: data.serviceProviderId ?? "",
      plannedVehicleId: data.plannedVehicleId ?? "",
      plannedDriverId: data.plannedDriverId ?? "",
      depotId: data.depotId ?? "",
      unloadingStationId: data.unloadingStationId ?? "",
      stopSelection: data.stopSelection,
      // The scheme stores the selection rule OR the picked lists, never both
      // (issue #19) — the stopSelection flag is the single source of truth.
      ...(isRuleScheme
        ? {
            sameAllDays: normalizedMatchPlans.sameAllDays,
            ...matchPlansToValues(normalizedMatchPlans),
          }
        : dayPlansToValues(normalizedPlans)),
    }
    const recurrence = recurrenceFromValues(submittedValues)

    const projectIds = selectedProjectIds(projectScope, {
      projectId: data.projectId ?? "",
    })
    // Vehicle names carry the registration plate; facts show the callsign.
    const vehicleName = vehicle?.name.split(" · ")[0]
    const totalStops = dayPlans.reduce(
      (sum, plan) => sum + plan.containerIds.length,
      0,
    )
    const facts: Record<string, string> = {
      Scope: projectScopeLabel(projectIds),
      "Record kind": "Route Scheme",
      "Execution policy": "create record",
      "Submitted by": actorName,
      Version: "v1",
      ...(project ? { Project: project.name } : {}),
      ...(area ? { "Planning area": area.name } : {}),
      ...(calendar ? { "Collection calendar": calendar.name } : {}),
      ...(recurrence ? { Recurrence: recurrenceSentence(recurrence) } : {}),
      ...(data.effectiveFrom
        ? {
            Effective: `${data.effectiveFrom} → ${data.effectiveTo || "ongoing"}`,
          }
        : {}),
      // Absent = no estimated start (issue #32) — the detail page shows "—".
      ...(data.plannedStartTime.trim()
        ? { "Planned start": data.plannedStartTime.trim() }
        : {}),
      ...(serviceProvider ? { "Service provider": serviceProvider.name } : {}),
      Vehicle: vehicleName ?? "Unassigned",
      Driver: driver?.name ?? "Unassigned",
      ...(depot ? { "Departure depot": depot.name } : {}),
      ...(unloadingStation
        ? { "Unloading station": unloadingStation.name }
        : {}),
      "Container selection": isRuleScheme
        ? "Matched by rule"
        : normalizedPlans.sameAllDays
          ? "Same containers every day"
          : "Different per day",
      ...(isRuleScheme
        ? {
            "Stop matching": normalizedMatchPlans.sameAllDays
              ? stopRuleSummary(data.matchRule)
              : effectiveDayRules(data.serviceDays, normalizedMatchPlans)
                  .map(
                    ({ day, rule }) =>
                      `${SERVICE_DAY_SHORT_LABELS[day]}: ${stopRuleSummary(rule)}`,
                  )
                  .join(" · "),
          }
        : {}),
      Containers: dayPlanCountSummary(dayPlans),
      ...(origin.extraFacts ?? {}),
      ...(validation.issues.length > 0
        ? { "Validation issues": validation.issues.join(" · ") }
        : {}),
      ...(validation.warnings.length > 0
        ? { "Validation warnings": validation.warnings.join(" · ") }
        : {}),
    }

    const newRecord: BusinessRecord = {
      id: `${activeModule.id}-route-scheme-${now}`,
      name: data.schemeName.trim() || "Untitled scheme",
      context:
        [project?.name, area?.name].filter(Boolean).join(" · ") ||
        projectScopeLabel(projectIds),
      status: validation.status,
      owner: actorName,
      value: `${totalStops} planned stops`,
      updated: "Now",
      description: isRuleScheme
        ? `Created with ${origin.method} — stops are matched by the scheme's declarative rule at every generation.`
        : origin.method === "Guided Setup"
          ? "Created with Guided Setup covering scope, recurrence, assignment defaults, and per-day container plans."
          : "Created with Quick create — manual container lists are picked in Guided Setup.",
      facts,
      related: [
        ...relationRefs.map((relation) => relation.label),
        "Audit history created",
      ],
      source: "Office workspace",
      freshness: "Now",
      allowedTransitions: activeModule.lifecycle.slice(1, 3),
      companyId: FIXTURE_COMPANY_ID,
      projectIds,
      serviceProviderId: data.serviceProviderId ?? serviceProviderScopeId,
      recordKind: "Route Scheme",
      submittedValues,
      relationRefs,
    }
    // Self-contained creation (issue #28, D18/D24/D25): the orchestration
    // planner decides everything past "Create" — a Validated scheme generates
    // its initial window with Plan Ahead on and becomes Scheduled; this
    // handler only applies the returned upserts.
    const routesModule = businessWorkspaces["route-studio"].modules.find(
      (candidate) => candidate.id === "routes",
    )
    const pickupsModule = businessWorkspaces["route-studio"].modules.find(
      (candidate) => candidate.id === "pickups",
    )
    const deviationsModule = businessWorkspaces.plan.modules.find(
      (candidate) => candidate.id === "collection-deviations",
    )
    const calendarsModule = businessWorkspaces.plan.modules.find(
      (candidate) => candidate.id === "calendars",
    )
    const creation = planSchemeCreation(
      { scheme: newRecord, today: todayIso(), actorName },
      {
        existingRoutes: routesModule
          ? getRecords("route-studio", routesModule.id, routesModule.records)
          : [],
        existingPickups: pickupsModule
          ? getRecords("route-studio", pickupsModule.id, pickupsModule.records)
          : [],
        containers: containerRecords,
        deviationRecords: deviationsModule
          ? getRecords("plan", deviationsModule.id, deviationsModule.records)
          : [],
        calendarRecords: calendarsModule
          ? getRecords("plan", calendarsModule.id, calendarsModule.records)
          : [],
      },
    )
    const creationEvent: AuditEvent = {
      id: `audit-scheme-create-${now}`,
      action: `Create route scheme · ${origin.method}`,
      actor: actorName,
      at: "Now",
      reason: origin.method,
      before: "Absent",
      after: creation.scheme.status,
      evidence: `${relationRefs.length} linked records · ${projectScopeLabel(
        projectIds,
      )} scope validated`,
    }

    upsertRecord(workspace.id, activeModule.id, creation.scheme)
    for (const route of creation.routes) {
      upsertRecord("route-studio", "routes", route)
    }
    for (const pickup of creation.pickups) {
      upsertRecord("route-studio", "pickups", pickup)
    }
    setAuditEvents((current) => ({
      ...current,
      [newRecord.id]: [creationEvent],
    }))
    setSelectedRecord(creation.scheme)
    router.push(
      getWorkspaceNavigationHref(
        navigationBasePath,
        workspace.id,
        activeModule.id,
        newRecord.id,
      ),
      { scroll: false },
    )
    if (creation.outcome === "scheduled") {
      toast.success(`Route scheme created — ${newRecord.name}`, {
        description: creation.message,
      })
    } else if (creation.outcome === "generation-failed") {
      toast.warning(`Route scheme created as Validated — ${newRecord.name}`, {
        description: creation.message,
      })
    } else {
      toast.warning(`Route scheme created as Draft — ${newRecord.name}`, {
        description: `${creation.message} ${validation.issues.length} open issue${
          validation.issues.length === 1 ? "" : "s"
        }: ${validation.issues.join(" · ")}`,
      })
    }
  }

  const handleGuidedSchemeCreate = (data: GuidedSchemeData) =>
    createSchemeFromDraft(data, { method: "Guided Setup" })

  const requestServiceProviderRelatedCreate = (
    target: "user" | "vehicle" | "driver" | "service-area" | "service-provider-price",
  ) => {
    if (!selectedRecord) return
    const serviceProviderId = selectedRecord.id

    if (target === "user") {
      setRelatedCreateTarget({
        workspaceId: "service-providers",
        moduleId: "service-provider-workspace",
        initialValues: {
          serviceProviderId,
          serviceAreaId: relatedServiceAreas[0]?.id ?? "",
          invitedBy: actorName,
        },
      })
      return
    }

    if (target === "vehicle") {
      setRelatedCreateTarget({
        workspaceId: "fleet",
        moduleId: "vehicles",
        initialValues: {
          serviceProviderId,
          ownershipType: "service-provider",
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
          serviceProviderId,
          employmentType: "service-provider",
        },
      })
      return
    }

    if (target === "service-provider-price") {
      // Opens the module's New service provider price create form with the
      // service provider fixed from the current page — we are adding a price for
      // this service provider. The bulk Apply index workflow stays on the Price
      // Engine module header.
      setRelatedCreateTarget({
        workspaceId: "commercial",
        moduleId: "service-provider-prices",
        initialValues: {
          serviceProviderId,
          validFrom: localDateInputValue(),
        },
      })
      return
    }

    setRelatedCreateTarget({
      workspaceId: "service-providers",
      moduleId: "service-areas",
      initialValues: {
        serviceProviderId,
        effectiveFrom: localDateInputValue(),
      },
      schemaOverride: {
        key: "service-providers.service-areas",
        mode: "action",
        recordKind: "Service area assignment",
        title: "Assign service area",
        description:
          `Link an existing service area to ${selectedRecord.name}. The service area remains the same record; this updates its effective service provider relationship.`,
        submitLabel: "Assign service area",
        contextFieldIds: ["serviceProviderId", "serviceAreaId", "effectiveFrom"],
        execution: {
          kind: "append-event",
          sourceField: "serviceAreaId",
          reviewBeforeSubmit: true,
          completionMessage: "The service area relationship was updated with audit history.",
        },
        sections: [
          {
            id: "assignment",
            title: "Service area relationship",
            description:
              "The service provider is fixed from the current page. Choose an existing area that is not already assigned to this service provider.",
            fields: [
              {
                id: "serviceProviderId",
                label: "Service provider",
                type: "select",
                required: true,
                readOnly: true,
                relation: { workspaceId: "service-providers", moduleId: "service-providers" },
              },
              {
                id: "serviceAreaId",
                label: "Service area",
                type: "select",
                required: true,
                relation: { workspaceId: "service-providers", moduleId: "service-areas" },
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

  if (!hasRoleViewableModules) {
    return (
      <div className="flex flex-1 flex-col min-h-0 bg-background mx-2 my-2 border border-sidebar rounded-lg min-w-0">
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <SidebarTrigger className="h-8 w-8 rounded-lg hover:bg-accent text-muted-foreground" />
          <Breadcrumbs items={[{ label: workspaceLabel ?? workspace.label }]} />
        </header>
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-sm text-center">
            <p className="text-sm font-medium">No permitted modules</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Your role has no view access to this area. Ask an administrator
              to review its permissions.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 bg-background mx-2 my-2 border border-sidebar rounded-lg min-w-0">
      {schemeDetailRecord ? (
        <SchemeDetailsPage
          module={activeModule}
          record={schemeDetailRecord}
          onBack={closeRecord}
          onEdit={
            canEditRecords ? () => openEditRecord(schemeDetailRecord) : undefined
          }
          onDelete={
            canDeleteRecords
              ? () => requestRecordDelete(schemeDetailRecord)
              : undefined
          }
          onGenerateRoutes={
            canRunRecordActions
              ? () => setGenerateSchemeRecord(schemeDetailRecord)
              : undefined
          }
          readOnly={!canRunRecordActions}
        />
      ) : isRouteDetails && selectedRecord ? (
        <RouteDetailsPage
          module={activeModule}
          record={selectedRecord}
          tickets={relatedRouteTickets}
          sessions={relatedRouteSessions}
          onBack={closeRecord}
          onAction={requestRecordAction}
          onEdit={canEditRecords ? () => openEditRecord(selectedRecord) : undefined}
          onDelete={canDeleteRecords ? () => requestRecordDelete(selectedRecord) : undefined}
          onReassign={
            canRunRecordActions
              ? (updated, reassignedPickups) => {
                  upsertRecord(workspace.id, activeModule.id, updated)
                  for (const pickup of reassignedPickups) {
                    upsertRecord("route-studio", "pickups", pickup)
                  }
                  setSelectedRecord(updated)
                }
              : undefined
          }
          readOnly={!canRunRecordActions}
        />
      ) : isServiceProviderDetails && selectedRecord ? (
        <ServiceProviderDetailsPage
          record={selectedRecord}
          users={relatedServiceProviderUsers}
          vehicles={relatedServiceProviderVehicles}
          drivers={relatedServiceProviderDrivers}
          serviceAreas={relatedServiceAreas}
          serviceProviderPrices={relatedServiceProviderPrices}
          onBack={closeRecord}
          onCreate={requestServiceProviderRelatedCreate}
        />
      ) : (
        <>
      <header className="flex flex-col border-b border-border/40">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
          <div className="flex items-center gap-3 min-w-0">
            <SidebarTrigger className="h-8 w-8 rounded-lg hover:bg-accent text-muted-foreground" />
            <div className="min-w-0">
              <Breadcrumbs
                items={
                  workspace.modules.length > 1 &&
                  activeModule.label !== (workspaceLabel ?? workspace.label)
                    ? [
                        {
                          label: workspaceLabel ?? workspace.label,
                          onClick: () =>
                            handleModuleChange(workspace.modules[0].id),
                        },
                        { label: activeModule.label },
                      ]
                    : [{ label: workspaceLabel ?? workspace.label }]
                }
              />
            </div>
          </div>
          {(isContainersAssetsView ||
            showExportAction ||
            (effectiveShowPrimaryAction && canOpenBusinessForm)) && (
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
              {effectiveShowPrimaryAction && canOpenBusinessForm && formSchema && (
                isPriceEngineProducts ? (
                  <Button
                    size="sm"
                    onClick={() =>
                      setRelatedCreateTarget({
                        workspaceId: "commercial",
                        moduleId: "price-rows",
                        initialValues: {},
                      })
                    }
                  >
                    <Plus className="h-4 w-4" weight="bold" />
                    <span className="hidden sm:inline">Add price</span>
                    <span className="sm:hidden">Action</span>
                  </Button>
                ) : isRouteCreateFlow ? (
                  <RouteCreateEntry
                    submitLabel={formSchema.submitLabel}
                    onQuickCreate={() => setIsCreateOpen(true)}
                    onGuidedCreate={handleGuidedRouteCreate}
                  />
                ) : isSchemeCreateFlow ? (
                  <SchemeCreateEntry
                    submitLabel={formSchema.submitLabel}
                    onQuickCreate={() => setIsCreateOpen(true)}
                    onGuidedCreate={handleGuidedSchemeCreate}
                  />
                ) : (
                  <Button size="sm" onClick={() => setIsCreateOpen(true)}>
                    <Plus className="h-4 w-4" weight="bold" />
                    <span className="hidden sm:inline">{formSchema.submitLabel}</span>
                    <span className="sm:hidden">Action</span>
                  </Button>
                )
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
                      : workspace.id === "service-providers" &&
                          activeModule.id === "service-providers"
                        ? "service-providers"
                        : isServiceProviderUsersView
                          ? "service-provider-users"
                          : isTicketsView
                            ? "tickets"
                            : "default"
                  }
                />
                <BusinessViewOptionsPopover
                  value={viewOptions}
                  onChange={setViewOptions}
                  variant={
                    isContainersAssetsView
                      ? "containers"
                      : isRichRecordView
                        ? "records"
                        : "default"
                  }
                  allowedViewTypes={moduleViewTypes}
                  columnOptions={factColumnOptions}
                  groupOptions={recordGroupOptions}
                  columnsStyle={
                    activeModule.id === "pickups" ? "display" : "chips"
                  }
                  fixedColumnChips={
                    isServiceProviderUsersView
                      ? ["Full name", "Email", "Phone number", "Role", "Status"]
                      : undefined
                  }
                  builtinColumnChips={
                    isRichRecordView && !isRoutesView
                      ? isServiceProviderUsersView
                        ? // Full name, Email, Phone number, Role, and Status
                          // are fixed columns and the description is never
                          // shown, so only Updated toggles.
                          [{ key: "showUpdated", label: "Updated" }]
                        : [
                            { key: "showDescription", label: "Description" },
                            { key: "showContext", label: activeModule.contextLabel },
                            { key: "showUpdated", label: "Updated" },
                          ]
                      : undefined
                  }
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

          {calendarKpiTiles && <ModuleKpiTiles tiles={calendarKpiTiles} />}

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
            ) : activeViewType === "list" ? (
              <BusinessRecordCardsView
                records={filteredRecords}
                entityLabel={activeModule.entityLabel}
                onOpenRecord={openRecord}
                onCreateRecord={
                  canCreateFromView ? () => setIsCreateOpen(true) : undefined
                }
                onEditRecord={canEditRecords ? openEditRecord : undefined}
                onDeleteRecord={canDeleteRecords ? requestRecordDelete : undefined}
              />
            ) : activeViewType === "board" ? (
              <BusinessRecordBoardView
                records={filteredRecords}
                lifecycle={activeModule.lifecycle}
                entityLabel={activeModule.entityLabel}
                onOpenRecord={openRecord}
                onCreateRecord={
                  canCreateFromView ? () => setIsCreateOpen(true) : undefined
                }
                onEditRecord={canEditRecords ? openEditRecord : undefined}
                onDeleteRecord={canDeleteRecords ? requestRecordDelete : undefined}
              />
            ) : activeViewType === "timeline" ? (
              <BusinessRecordDayTimeline
                records={filteredRecords}
                onOpenRecord={openRecord}
              />
            ) : (
              <>
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
                            {showRouteStarColumn && (
                              <TableHead className="w-8 pr-0">
                                <span className="sr-only">Pin to Active Routes</span>
                              </TableHead>
                            )}
                            <TableHead>
                              {isRoutesView
                                ? "Route ID"
                                : isServiceProviderUsersView
                                  ? "Full name"
                                  : activeModule.entityLabel}
                            </TableHead>
                            {isRichRecordView &&
                              activeStaticColumns.map((column, index) => (
                                <TableHead
                                  key={column}
                                  className={cn(
                                    index === activeStaticColumns.length - 1 &&
                                      "border-r border-border/60",
                                  )}
                                >
                                  <span className="flex items-center gap-1.5">
                                    <PushPin className="h-3.5 w-3.5 text-muted-foreground" />
                                    {column}
                                  </span>
                                </TableHead>
                              ))}
                            {isRoutesView ? (
                              <>
                                {viewOptions.showProject && (
                                  <TableHead>Project</TableHead>
                                )}
                                {viewOptions.showArea && <TableHead>Area</TableHead>}
                              </>
                            ) : isServiceProviderUsersView ? (
                              <>
                                <TableHead>Email</TableHead>
                                <TableHead>Phone number</TableHead>
                                <TableHead>Role</TableHead>
                              </>
                            ) : (
                              viewOptions.showContext && (
                                <TableHead>{activeModule.contextLabel}</TableHead>
                              )
                            )}
                            <TableHead>Status</TableHead>
                            {isCalendarsView && (
                              <>
                                <TableHead>Working days</TableHead>
                                <TableHead>Holidays</TableHead>
                                <TableHead>Validity</TableHead>
                              </>
                            )}
                            {/* Schemes swap the generic value column (Demand)
                                for the derived Recurrence / Collection
                                calendar pair (issue #30, D15). */}
                            {isSchemesView ? (
                              <>
                                <TableHead>Recurrence</TableHead>
                                <TableHead>Collection calendar</TableHead>
                              </>
                            ) : (
                              !isServiceProviderUsersView && (
                                <TableHead>{activeModule.valueLabel}</TableHead>
                              )
                            )}
                            {isRichRecordView &&
                              activeFactColumns.map((column) => (
                                <TableHead key={column}>{column}</TableHead>
                              ))}
                            {viewOptions.showUpdated && <TableHead>Updated</TableHead>}
                            {isRichRecordView && (
                              <TableHead className="w-10">
                                <span className="sr-only">Actions</span>
                              </TableHead>
                            )}
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
                        tableRecordGroups.map((group) => (
                          <Fragment key={group.label ?? "all-records"}>
                            {group.label !== null && (
                              <TableRow className="bg-muted/30 hover:bg-muted/30">
                                <TableCell
                                  colSpan={visibleTableColumnCount}
                                  className="py-2"
                                >
                                  <div className="flex items-center gap-2">
                                    {viewOptions.groupBy === "status" ? (
                                      <Badge
                                        variant="outline"
                                        className={cn(
                                          "rounded-full px-2 py-0.5 text-[11px] font-medium",
                                          statusClasses(group.label),
                                        )}
                                      >
                                        {group.label}
                                      </Badge>
                                    ) : (
                                      <span className="text-xs font-semibold text-foreground">
                                        {group.label}
                                      </span>
                                    )}
                                    <span className="text-xs text-muted-foreground">
                                      {group.records.length}{" "}
                                      {group.records.length === 1
                                        ? activeModule.entityLabel.toLowerCase()
                                        : `${activeModule.entityLabel.toLowerCase()}s`}
                                    </span>
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}
                            {group.records.map((record) => (
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
                                {showRouteStarColumn && (
                                  <TableCell
                                    className={cn(
                                      "w-8 pr-0",
                                      viewOptions.density === "compact" && "py-2",
                                    )}
                                    onClick={(event) => event.stopPropagation()}
                                    onKeyDown={(event) => event.stopPropagation()}
                                  >
                                    <button
                                      type="button"
                                      aria-pressed={isRouteStarred(record.id)}
                                      aria-label={
                                        isRouteStarred(record.id)
                                          ? `Remove ${record.name} from Active Routes`
                                          : `Add ${record.name} to Active Routes`
                                      }
                                      className="flex h-6 w-6 cursor-pointer items-center justify-center rounded hover:bg-muted"
                                      onClick={() => toggleRouteStarred(record.id)}
                                    >
                                      <Star
                                        weight={
                                          isRouteStarred(record.id) ? "fill" : "regular"
                                        }
                                        className={cn(
                                          "h-4 w-4",
                                          isRouteStarred(record.id)
                                            ? "text-amber-500"
                                            : "text-muted-foreground/60 hover:text-foreground",
                                        )}
                                      />
                                    </button>
                                  </TableCell>
                                )}
                                <TableCell
                                  className={cn(
                                    "min-w-[240px]",
                                    viewOptions.density === "compact" && "py-2",
                                  )}
                                >
                                  <div className="space-y-1">
                                    <p className="text-sm font-medium text-foreground">{record.name}</p>
                                    {viewOptions.showDescription &&
                                      !isServiceProviderUsersView && (
                                        <p className="max-w-[340px] truncate text-xs text-muted-foreground">
                                          {record.description}
                                        </p>
                                      )}
                                  </div>
                                </TableCell>
                                {isRichRecordView &&
                                  activeStaticColumns.map((column, index) => (
                                    <TableCell
                                      key={column}
                                      className={cn(
                                        "min-w-[140px] whitespace-nowrap text-sm text-muted-foreground",
                                        index === activeStaticColumns.length - 1 &&
                                          "border-r border-border/60",
                                      )}
                                    >
                                      {recordFactValue(record, column)}
                                    </TableCell>
                                  ))}
                                {isRoutesView ? (
                                  <>
                                    {viewOptions.showProject && (
                                      <TableCell className="min-w-[160px] whitespace-nowrap text-sm text-muted-foreground">
                                        {recordFactValue(record, "Project")}
                                      </TableCell>
                                    )}
                                    {viewOptions.showArea && (
                                      <TableCell className="min-w-[120px] whitespace-nowrap text-sm text-muted-foreground">
                                        {recordFactValue(record, "Area")}
                                      </TableCell>
                                    )}
                                  </>
                                ) : isServiceProviderUsersView ? (
                                  <>
                                    <TableCell className="min-w-[200px] whitespace-nowrap text-sm text-muted-foreground">
                                      {recordFactValue(
                                        record,
                                        "Email",
                                        recordFactValue(record, "User email"),
                                      )}
                                    </TableCell>
                                    <TableCell className="min-w-[140px] whitespace-nowrap text-sm text-muted-foreground">
                                      {recordFactValue(record, "Phone number")}
                                    </TableCell>
                                    <TableCell className="min-w-[140px] whitespace-nowrap text-sm text-muted-foreground">
                                      {recordFactValue(
                                        record,
                                        "Role",
                                        recordFactValue(record, "Service provider role"),
                                      )}
                                    </TableCell>
                                  </>
                                ) : isCalendarsView ? (
                                  // Calendars are project-scoped (D22): the
                                  // context cell renders the real project
                                  // scope, never an invented customer split.
                                  viewOptions.showContext && (
                                    <TableCell className="min-w-[160px] whitespace-nowrap text-sm text-muted-foreground">
                                      {record.projectIds?.length
                                        ? projectScopeLabel(record.projectIds)
                                        : "—"}
                                    </TableCell>
                                  )
                                ) : (
                                  viewOptions.showContext && (
                                    <TableCell className="min-w-[220px] text-sm text-muted-foreground">
                                      {record.context}
                                    </TableCell>
                                  )
                                )}
                                <TableCell>
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <Badge
                                      variant="outline"
                                      className={cn(
                                        "rounded-full px-2 py-0.5 text-[11px] font-medium",
                                        statusClasses(record.status),
                                      )}
                                    >
                                      {record.status}
                                    </Badge>
                                    <SchemeAttentionBadge
                                      warnings={schemeRowsById.get(record.id)?.attention}
                                    />
                                  </div>
                                </TableCell>
                                {isCalendarsView && (
                                  <>
                                    <TableCell className="min-w-[110px] whitespace-nowrap text-sm text-muted-foreground">
                                      {calendarRowsById.get(record.id)?.workingDays ?? "—"}
                                    </TableCell>
                                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                                      {calendarRowsById.get(record.id)?.holidays ?? "—"}
                                    </TableCell>
                                    <TableCell className="min-w-[170px] whitespace-nowrap text-sm text-muted-foreground">
                                      {calendarRowsById.get(record.id)?.validity ?? "—"}
                                    </TableCell>
                                  </>
                                )}
                                {isSchemesView ? (
                                  <>
                                    <TableCell className="min-w-[170px] whitespace-nowrap text-sm text-muted-foreground">
                                      {schemeRowsById.get(record.id)?.recurrence ?? "—"}
                                    </TableCell>
                                    <TableCell className="min-w-[180px] whitespace-nowrap text-sm text-muted-foreground">
                                      {schemeRowsById.get(record.id)?.calendar ?? "—"}
                                    </TableCell>
                                  </>
                                ) : (
                                  !isServiceProviderUsersView && (
                                    <TableCell className="min-w-[150px]">
                                      <RecordValue record={record} />
                                    </TableCell>
                                  )
                                )}
                                {isRichRecordView &&
                                  activeFactColumns.map((column) => (
                                    <TableCell
                                      key={column}
                                      className="min-w-[130px] whitespace-nowrap text-sm text-muted-foreground"
                                    >
                                      {recordFactValue(record, column)}
                                    </TableCell>
                                  ))}
                                {viewOptions.showUpdated && (
                                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                                    {record.updated}
                                  </TableCell>
                                )}
                                {isRichRecordView && (
                                  <TableCell className="w-10 pr-3 text-right">
                                    <RecordActionsMenu
                                      record={record}
                                      entityLabel={activeModule.entityLabel}
                                      onEdit={canEditRecords ? openEditRecord : undefined}
                                      onDelete={canDeleteRecords ? requestRecordDelete : undefined}
                                      extraActions={schemeExtraActions(record)}
                                    />
                                  </TableCell>
                                )}
                              </>
                            )}
                          </TableRow>
                            ))}
                          </Fragment>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
                <TablePagination
                  page={tablePage}
                  pageCount={tablePageCount}
                  totalCount={tableTotalCount}
                  onPageChange={setTablePage}
                />
              </>
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
          onEdit={canEditRecords ? openEditRecord : undefined}
          onDelete={canDeleteRecords ? requestRecordDelete : undefined}
          showActions={canRunRecordActions}
          extraActions={selectedRecord ? schemeExtraActions(selectedRecord) : undefined}
          attention={
            isSchemesView && selectedRecord
              ? schemeRowsById.get(selectedRecord.id)?.attention
              : undefined
          }
        />
      )}
        </>
      )}
      {/* Shared with the scheme detail page (issue #29) — rendered outside
          the list branch so both surfaces can open it. */}
      <SchemeGenerateRoutesDialog
        scheme={generateSchemeRecord}
        actorName={actorName}
        onClose={() => setGenerateSchemeRecord(null)}
      />
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
      {editingRecord && editFormSchema && (
        <BusinessRecordFormDialog
          schema={editFormSchema}
          open
          onOpenChange={(open) => {
            if (!open) setEditingRecord(null)
          }}
          onSubmit={handleFormSubmit}
          relationOptions={getFormRelationOptions}
          initialValueOverrides={editInitialValues}
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
      {/* Plan Ahead auto-generation fires when Route Studio loads (FR-11) —
          operator-side automation, so never inside a service provider scope, and
          never on behalf of a viewer whose role could not run the manual
          Generate routes action. */}
      {workspace.id === "route-studio" &&
        !serviceProviderScopeId &&
        canRunRecordActions && <SchemePlanAheadRunner actorName={actorName} />}
    </div>
  )
}

/**
 * The live Attention overlay (issue #25, D5/D20): an amber badge beside the
 * lifecycle status when current validation/reconciliation warnings exist.
 * A warning condition, never a status value.
 */
function SchemeAttentionBadge({ warnings }: { warnings?: string[] }) {
  if (!warnings || warnings.length === 0) return null
  return (
    <Badge
      variant="outline"
      title={warnings.join("\n")}
      className="rounded-full border-transparent bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-100"
    >
      Attention
    </Badge>
  )
}

function RecordDetailsDialog({
  module,
  record,
  onClose,
  onAction,
  showDeepLinks,
  onEdit,
  onDelete,
  showActions = true,
  extraActions,
  attention,
}: {
  module: ModuleDefinition
  record: BusinessRecord | null
  onClose: () => void
  onAction: (action: string) => void
  showDeepLinks: boolean
  onEdit?: (record: BusinessRecord) => void
  onDelete?: (record: BusinessRecord) => void
  showActions?: boolean
  extraActions?: RecordExtraAction[]
  /** Live scheme Attention warnings; renders the amber overlay badge. */
  attention?: string[]
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
                <SchemeAttentionBadge warnings={attention} />
                <Badge variant="outline" className="rounded-full text-[11px] font-normal">
                  {record.id}
                </Badge>
                <RecordActionsMenu
                  record={record}
                  entityLabel={module.entityLabel}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  extraActions={extraActions}
                  className="ml-auto"
                />
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
                {extraActions?.map((action) => (
                  <Button
                    key={action.label}
                    variant="outline"
                    onClick={() => action.onSelect(record)}
                  >
                    {action.label}
                  </Button>
                ))}
                {showActions &&
                  (record.allowedTransitions ?? module.lifecycle.slice(1, 3)).map((action) => (
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
                    Records are soft-deleted and the category, explanation, actor, and time are written to the central deletion log.
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
