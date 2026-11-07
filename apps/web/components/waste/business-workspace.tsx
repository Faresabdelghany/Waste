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
  type ReactNode,
} from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import {
  ArrowSquareOut,
  CalendarCheck,
  CaretDown,
  DownloadSimple,
  Gear,
  Info,
  PencilSimple,
  Plus,
  PushPin,
  ShieldCheck,
  Star,
} from "@phosphor-icons/react/dist/ssr"

import {
  businessWorkspaces,
  FIXTURE_PROJECT_IDS,
  getModuleDefinition,
  getWorkspaceDefinition,
  type BusinessRecord,
  type ModuleDefinition,
  type ModuleLocation,
  type WorkspaceDefinition,
  type WorkspaceId,
} from "@/lib/data/business-modules"
import { actionDecisionShape, actionRecordedSentence } from "@/lib/data/action-decision"
import { COLLECTION_CALENDARS_MODULE } from "@/lib/data/collection-calendars"
import { PLANNING_AREAS_MODULE } from "@/lib/data/planning-areas"
import { readableKey } from "@/lib/data/record-key"
import { planAheadToggledSentence, ROUTE_SCHEMES_MODULE, schemeValuesOfDraft, validationWhenUnplaced } from "@/lib/data/route-schemes"
import {
  clearedFactKeys,
  deriveFormRecord,
  displayFormValue as displayFormRecordValue,
  type FormRecordResolvers,
} from "@/lib/data/business-form-records"
import { migrateLegacyId, migrateLegacyModuleId } from "@/lib/data/legacy-ids"
import { getBusinessFormSchema } from "@/lib/data/business-form-schemas"
import { MASTER_DATA_MODULE, masterDataKindForField, masterDataKindOf } from "@/lib/data/master-data"
import {
  collectFactColumnOptions,
  defaultFactColumns,
  moduleOffersRowActions,
  resolveModuleViewKind,
} from "@/lib/data/business-view-kinds"
import {
  calendarRowSummary,
  withDerivedCalendarValue,
  type CalendarRowSummary,
} from "@/lib/prototype/route-schemes/calendar-list"
import { SCHEME_EDIT_POLICY_LABELS } from "@/lib/prototype/route-schemes/creation"
import type { Action } from "@waste/domain/access/modules"
import { draftGroups } from "@/lib/prototype/route-schemes/draft"
import { driverFormOptions } from "@/lib/data/driver-form-options"
import { NO_HOLIDAY_LIST_LABEL, resolveProjectCalendar } from "@/lib/prototype/route-schemes/project-calendar"
import { HOLIDAY_POLICY_LABELS } from "@waste/domain/planning/occurrences"
import {
  schemeAttention,
  schemeCanGenerateRoutes,
  withEffectiveSchemeStatus,
} from "@/lib/prototype/route-schemes/lifecycle"
import {
  isPlanAheadEnabled,
  setPlanAhead,
} from "@/lib/prototype/route-schemes/plan-ahead"
import {
  GROUP_OWNED_SCHEME_FIELD_IDS,
  QUICK_SCHEME_DRAFT_FIELD_IDS,
  applySchemeWasteFraction,
  quickDriverIssue,
  quickSchemeDraftFromValues,
  seedSchemeEditValues,
} from "@/lib/prototype/route-schemes/quick-create"
import {
  collectionGroupSummary,
  collectionGroupsOf,
  collectionGroupsToValues,
  hasExplicitCollectionGroups,
  sharedServiceProvider,
  type CollectionGroup,
} from "@/lib/prototype/route-schemes/groups"
import {
  schemeRowSummary,
  withDerivedSchemeContext,
  type SchemeRowSummary,
} from "@/lib/prototype/route-schemes/scheme-list"
import { recurrenceFromValues, recurrenceSentence, serviceDaysFromValues, todayIso } from "@waste/domain/planning/recurrence"
import { PARAGRAPH_MAX } from "@waste/domain/text"
import { formatShortDay, SERVICE_DAY_SHORT_LABELS } from "@waste/domain/days"
import {
  effectiveDayRules,
  matchPlansFromValues,
  stopRuleSummary,
  stopSelectionMode,
} from "@/lib/prototype/route-schemes/matching"
import { dayPlanCountSummary } from "@/lib/prototype/route-schemes/validation"
import type {
  BusinessFormField,
  BusinessFormOption,
  BusinessFormSchema,
  BusinessFormValues,
} from "@/lib/data/business-form-types"
import { isSoftDeleted, softDeletedRecord } from "@/lib/prototype/record-visibility"
import { resolveBusinessRelation } from "@/lib/data/business-links"
import { workspaceHref } from "@/lib/data/workspace-href"
import {
  agreementFormSchemaOnApi,
  agreementPriceListOptions,
  AGREEMENTS_MODULE,
  isAgreementRecord,
  isSubscriptionRecord,
  SUBSCRIPTION_RECORD_KIND,
  subscriptionEditSchema,
  subscriptionFormSchemaFor,
  subscriptionInitialValues,
  subscriptionProductOptions,
} from "@/lib/data/agreements"
import { awaitedRowsSentence, recordCountLabel } from "@/lib/table-copy"
import { cn, slugify } from "@/lib/utils"
import { createModuleSync } from "@/lib/url/module-sync"
import { PageActions, PageTopBar, TableCard } from "@/components/page-layout"
import { Breadcrumbs } from "@/components/ui/breadcrumbs"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/ui/status-badge"
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
import { StatRow } from "@/components/ui/stat-row"
import { WeekTimeline, type TimelineItem } from "@/components/ui/week-timeline"
import { ProgressCircle } from "@/components/progress-circle"
import { CheckRow } from "@/components/ui/check-row"
import {
  BusinessFilterPopover,
  canonicalCalendarName,
} from "@/components/waste/business-filter-popover"
import {
  businessFilterChips,
  matchesBusinessFilters,
  matchesBusinessQuery,
  removeBusinessFilterValue,
  type BusinessFilterKey,
  type BusinessFilters,
} from "@/lib/prototype/business-filters"
import { RecordHistory } from "@/components/waste/record-history"
import { RecordSearchInput } from "@/components/waste/record-search-input"
import {
  canonicalServiceFrequencyName,
} from "@/lib/prototype/service-frequencies"
import {
  BusinessViewOptionsPopover,
  defaultBusinessViewOptions,
  type BusinessGroupOption,
  type BusinessViewOptions,
  type BusinessViewType,
} from "@/components/waste/business-view-options-popover"
import {
  BusinessRecordBoardView,
  BusinessRecordCardsView,
  BusinessRecordDayTimeline,
  NoRecordsShown,
  RecordActionsMenu,
  recordProgress,
  recordStatusTone,
  type RecordExtraAction,
} from "@/components/waste/business-record-views"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { SchemeEditPolicyDialog } from "@/components/waste/scheme-edit-policy-dialog"
import { useContainersPlaced } from "@/components/waste/use-containers-placed"
import { useSchemeEditCommit } from "@/components/waste/use-scheme-edit-commit"
import {
  SchemeCreateEntry,
  resolvedDraftPlans,
  validateGuidedScheme,
  type GuidedSchemeData,
} from "@/components/waste/scheme-create-flow"
import { CollectionGroupsEditorDialog } from "@/components/waste/collection-groups-editor"
import { SchemeDetailsPage } from "@/components/waste/scheme-details-page"
import { useBusinessRecordStore, useModuleRecords, useServerModuleState, whenSaved } from "@/components/waste/business-record-store"
import { useApiConfigured, useApiSession } from "@/components/waste/api-session-store"
import { commandSurfaceFor, genericEditOffered, initialFiltersOf, listShows, primaryGranted, primaryOf } from "@/components/waste/commands/command-surfaces"
import { answered, writeGate } from "@/lib/api/records/write-gate"
import { projectScopeOfMe } from "@/lib/api/records/me-projects"
import { isServerBacked, serverModuleOf } from "@/lib/api/records/modules"
import { spellsStatus, type WriteOutcome } from "@/lib/api/records/server-records"
import { useActiveRoutes } from "@/components/waste/active-routes-store"
import { PRICE_ROWS_MODULE, PRODUCTS_MODULE } from "@/lib/data/commercial"
import { ServiceProviderDetailsPage } from "@/components/waste/service-provider-details-page"
import { MapPlanningView } from "@/components/waste/map-planning/map-planning-view"
import { SERVICE_AREAS_MODULE } from "@/lib/data/service-areas"
import { serviceAreaKindForField, serviceAreaKindOf } from "@/lib/data/provider-money"
import { pilotProviderCreate, pilotServiceAreaCreate } from "@/lib/data/provider-money-forms"
import { settingsHref } from "@/lib/data/settings-panes"
import { exportShownRows } from "@/lib/data/workspace-export"
import {
  isInProjectScope,
  isProjectRecordId,
  pinnedProjectId,
  projectRecordsOf,
  projectScopeLabel,
  selectedProjectIds,
  type ProjectScope,
} from "@/lib/data/project-scope"
import { RouteDetailsOnApi } from "@/components/waste/route-page-on-api"
import { LiveTicketDetailsDialog } from "@/components/tickets/ticket-details-live"
import { useGrants } from "@/components/auth/use-grants"
import { mayOn } from "@/lib/api/grants"
import { moduleKeyOf } from "@/lib/api/records/adapter"

type BusinessWorkspaceProps = {
  workspaceId: WorkspaceId
  initialModuleId?: string
  allowedModuleIds?: readonly string[]
  allowedRecordIds?: readonly string[]
  workspaceLabel?: string
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
   * belonging to other service providers are excluded. On the Pilot a
   * switched module's rows are the API's, which fences them to the
   * provider itself (#291 C24), so the scope filters only the rest.
   */
  serviceProviderScopeId?: string
  /** Name written as owner/actor on audit events and created records. */
  actorName?: string
}

// The header no longer offers a project switcher; generic workspaces run in the
// default project (the sidebar identity "Copenhagen Central") unless a restricted
// shell pins a scope via fixedProjectScope. The scope vocabulary is the
// configure.organization project records (issue #44, lib/data/project-scope),
// so the default is a project record's id, not a name of its own.
const DEFAULT_PROJECT_SCOPE: ProjectScope = FIXTURE_PROJECT_IDS.copenhagen

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
  /** Stored on the created record without a form field — e.g. a map-drawn polygon. */
  extraValues?: BusinessFormValues
}

function WorkspaceQuerySync({
  workspace,
  landingModuleId,
  onModuleChange,
  onRecordOpen,
  resolveRecord,
}: {
  workspace: WorkspaceDefinition
  landingModuleId: string
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
    // A bare address — the sidebar's link — is the workspace's landing. The
    // page stays mounted across client navigations, so without this a record
    // opened before leaving would still be shown on coming back.
    else if (!requestedModuleId && !requestedRecordId) onModuleChange(landingModuleId)

    if (requestedRecordId) {
      const requestedRecord = requestedModule
        ? resolveRecord(requestedModule.id, requestedRecordId)
        : null
      onRecordOpen(requestedRecord ?? null)
    } else {
      onRecordOpen(null)
    }
  }, [
    landingModuleId,
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
  // The typed start where the allocation has one (a server allocation's, on
  // its project's clock, Issue #181), since its name carries no year.
  const start = record.submittedValues?.plannedStart
  const typedDay = typeof start === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(start) : null
  if (typedDay) return new Date(Number(typedDay[1]), Number(typedDay[2]) - 1, Number(typedDay[3]), 12)
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

/**
 * The transitions a record's detail view offers: the record's own, else the
 * lifecycle's next two. On a module the server backs (Issue #81) only those
 * whose outcome is a status the wire can carry — the store refuses every
 * other move before the API sees it (`writeRecord`), and a button that is
 * always refused is no button. An action that leaves the status where it is
 * (Merge, Create version) is dropped there too: it would change facts alone,
 * which the wire does not carry.
 */
function offeredTransitions(
  workspaceId: WorkspaceId,
  module: ModuleDefinition,
  record: BusinessRecord,
): string[] {
  const transitions = record.allowedTransitions ?? module.lifecycle.slice(1, 3)
  // Only where the module reads the API: on a module on fixtures every transition stands (#179).
  const server = serverModuleOf(workspaceId, module.id)
  if (server === undefined) return transitions
  return transitions.filter((action) => {
    const outcome = actionOutcome(module, action, record.status)
    return outcome !== record.status && spellsStatus(server, record, outcome)
  })
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
  plan: ["map-planning"],
  "route-studio": ["live", "schemes", "routes", "pickups", "weights"],
  customers: ["properties", "groups", "shared", "agreements"],
  resources: ["containers", "inventory", "warehouses", "depots"],
  fleet: ["vehicles", "drivers", "vehicle-planning"],
  "service-providers": ["service-providers", "service-areas", "activities"],
  commercial: ["products", "price-rows", "events", "billing", "invoices"],
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

type SchemeStoredValues = Record<string, string | boolean | undefined>

/**
 * Keeps a Route Scheme's stop-selection and assignment facts in step with its
 * stored values (issue #19; collection groups D33/D36). Explicit groups own
 * the assignment and the stops, so the record-level Vehicle/Driver facts read
 * "Per collection group" and a "Collection groups" fact carries one summary
 * per group; the legacy single-assignment shape keeps the rule / manual facts
 * and folds the quick form's label-keyed assignment facts onto the canonical
 * keys generation and the detail page read.
 */
function withSchemeGroupFacts(
  facts: Record<string, string>,
  values: SchemeStoredValues,
  /**
   * The groups as just edited, with their denormalized names — the legacy
   * single-assignment shape stores ids only, so without these the Vehicle /
   * Driver facts (which generation stamps on the implicit group's routes)
   * would go stale on an "Edit collection groups" save.
   */
  editedGroups?: readonly CollectionGroup[],
): Record<string, string> {
  const nextFacts = { ...facts }
  const promote = (label: string, key: string) => {
    if (nextFacts[label]) {
      nextFacts[key] = nextFacts[label]
      delete nextFacts[label]
    }
  }
  promote("Planned vehicle", "Vehicle")
  promote("Planned driver", "Driver")
  promote("Responsible service provider", "Service provider")
  const serviceDays = serviceDaysFromValues(values)
  const groups = editedGroups ?? collectionGroupsOf(values, { serviceDays, facts: nextFacts })
  if (hasExplicitCollectionGroups(values)) {
    nextFacts["Container selection"] =
      groups.length === 0 ? "No collection groups" : "Per collection group"
    nextFacts["Collection groups"] = groups.map(collectionGroupSummary).join(" · ")
    nextFacts.Vehicle = "Per collection group"
    nextFacts.Driver = "Per collection group"
    const shared = sharedServiceProvider(groups)
    if (shared.name) {
      nextFacts["Service provider"] = shared.name
    } else if (groups.some((group) => group.serviceProviderName)) {
      nextFacts["Service provider"] = "Per collection group"
    } else {
      delete nextFacts["Service provider"]
    }
    delete nextFacts["Stop matching"]
    return nextFacts
  }
  delete nextFacts["Collection groups"]
  const [single] = groups
  if (single) {
    nextFacts.Vehicle = single.vehicleName ?? "Unassigned"
    nextFacts.Driver = single.driverName ?? "Unassigned"
    if (single.serviceProviderName) nextFacts["Service provider"] = single.serviceProviderName
    else delete nextFacts["Service provider"]
  }
  if (stopSelectionMode(values) === "rule") {
    const matchPlans = matchPlansFromValues(values)
    nextFacts["Container selection"] = "Matched by rule"
    nextFacts["Stop matching"] = matchPlans.sameAllDays
      ? stopRuleSummary(matchPlans.sharedRule)
      : effectiveDayRules(serviceDays, matchPlans)
          .map(({ day, rule }) => `${SERVICE_DAY_SHORT_LABELS[day]}: ${stopRuleSummary(rule)}`)
          .join(" · ")
  } else if (nextFacts["Stop matching"]) {
    delete nextFacts["Stop matching"]
    nextFacts["Container selection"] =
      values.sameAllDays !== false ? "Same containers every day" : "Different per day"
  }
  return nextFacts
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
  actorName = "Olivia Larsen",
}: BusinessWorkspaceProps) {
  const sourceWorkspace = getWorkspaceDefinition(workspaceId)
  const { getRecords, upsertRecord } = useBusinessRecordStore()
  // Whether a guided scheme's zero match is evidence: the API's containers placed (#207).
  const containersPlaced = useContainersPlaced()
  // Whether the adapter is on (Issue #81): what the switched modules' own surfaces show, and fixture mode does not.
  const apiConfigured = useApiConfigured()
  // Whether the API fences a module's rows to the signed-in account (#291 C24):
  // a switched module answers a provider's account its own rows alone,
  // whatever provider a row's mapping names, so no scope filters it again.
  const fencedByApi = isServerBacked
  // The records of any workspace module, as the store answers them — what the
  // scheme lifecycle planners read their related records from.
  const moduleRecords = useCallback(
    (targetWorkspaceId: WorkspaceId, targetModuleId: string): BusinessRecord[] => {
      const module = getModuleDefinition({
        workspaceId: targetWorkspaceId,
        moduleId: targetModuleId,
      })
      return module
        ? getRecords(targetWorkspaceId, module.id)
        : []
    },
    [getRecords],
  )
  const { isRouteStarred, toggleRouteStarred } = useActiveRoutes(
    serviceProviderScopeId ? "service-provider" : "operator",
  )
  const router = useRouter()
  // What the account signed in may do, office and provider alike (`useGrants`).
  const grants = useGrants()
  const workspace = useMemo<WorkspaceDefinition>(() => {
    const allowedModules = allowedModuleIds ? new Set(allowedModuleIds) : null
    const modules = sourceWorkspace.modules.filter((module) => !allowedModules || allowedModules.has(module.id))

    if (modules.length === 0) {
      throw new Error(`No permitted modules are available in ${sourceWorkspace.id}`)
    }

    // A role hides the modules it cannot view. When it can view none, the
    // configured modules are kept so the workspace can still render its
    // frame around the access notice instead of crashing.
    const viewableModules = modules.filter((module) =>
      mayOn(grants, moduleKeyOf(sourceWorkspace.id, module.id), "view"),
    )

    return {
      ...sourceWorkspace,
      modules: viewableModules.length > 0 ? viewableModules : modules,
    }
  }, [allowedModuleIds, grants, sourceWorkspace])
  // The records a restricted shell shows, of all its module holds (the citizen portal's one property).
  const recordAllowed = useCallback((record: BusinessRecord) => allowedRecordIds === undefined || allowedRecordIds.includes(record.id), [allowedRecordIds])
  const hasRoleViewableModules = workspace.modules.some((module) =>
    mayOn(grants, moduleKeyOf(workspace.id, module.id), "view"),
  )
  const tabsScrollRef = useRef<HTMLDivElement>(null)
  // The module a bare address opens on: the page's own, else the workspace's first.
  const landingModuleId = workspace.modules.some((module) => module.id === initialModuleId)
    ? initialModuleId!
    : workspace.modules[0].id
  const [activeModuleId, setActiveModuleId] = useState(landingModuleId)
  const [query, setQuery] = useState("")
  // A module opens on its list's filters on the Pilot (the registry's `list`), applied when it becomes active and only then.
  const [businessFilters, setBusinessFilters] = useState<BusinessFilters>(() =>
    initialFiltersOf(commandSurfaceFor(workspace.id, activeModuleId)),
  )
  const [viewOptions, setViewOptions] = useState<BusinessViewOptions>(
    defaultBusinessViewOptions,
  )
  // On the Pilot the pinned scope derives from `/me`'s projects (Issue #217, the plan on #81).
  const { me } = useApiSession()
  const projectScope =
    fixedProjectScope ??
    (apiConfigured
      ? projectScopeOfMe(me?.projects)
      : DEFAULT_PROJECT_SCOPE)
  // The scope vocabulary: the organisation module's project records, fixture
  // and created alike (issue #44) — what a scope is compared against, what a
  // created record is stamped with, and where a scope's label is read.
  const projectRecords = useMemo(
    () => projectRecordsOf(moduleRecords("configure", "organization")),
    [moduleRecords],
  )
  const [selectedRecord, setSelectedRecord] = useState<BusinessRecord | null>(null)
  const [editingRecord, setEditingRecord] = useState<BusinessRecord | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  // A governed action's write out to the API: its dialog's confirm waits (#210).
  const [actionSaving, setActionSaving] = useState(false)
  // A generic form's create or edit out to the API (#239): its dialog waits,
  // open, its submit held. A write belongs to the form it was made in — a
  // person leaving a dialog starts another (`leaveForm`) — so its answer
  // closes, opens and holds only its own dialog, never one opened since.
  const formSession = useRef(0)
  const [openFormSession, setOpenFormSession] = useState(0)
  const [savingSession, setSavingSession] = useState<number | null>(null)
  const formSaving = savingSession === openFormSession
  const leaveForm = () => {
    formSession.current += 1
    setOpenFormSession(formSession.current)
  }
  /** A write of the form open now: held while out, its answer for `landed` only while the form is still the one it was made in. */
  const formWrite = (outcome: Promise<WriteOutcome> | undefined, record: BusinessRecord, landed: (stillOpen: boolean) => void) => {
    const session = formSession.current
    setSavingSession(session)
    whenSaved(
      answered(outcome, record.id, () => toast.error(`${record.name} was not saved`, { description: "The write did not complete; try again." })),
      () => landed(formSession.current === session),
      () => setSavingSession((current) => (current === session ? null : current)),
    )
  }
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [groupsEditorScheme, setGroupsEditorScheme] =
    useState<BusinessRecord | null>(null)
  const [relatedCreateTarget, setRelatedCreateTarget] =
    useState<RelatedCreateTarget | null>(null)
  // The one edit-save of a route scheme (issue #33; the edit policy of issue
  // #38) — both edit doors save through it, and the "Ask each time" question
  // it may raise is answered by the commit of the render that answers.
  const { commitSchemeEdit, pendingSchemeEdit, answerPendingSchemeEdit, dismissPendingSchemeEdit } =
    useSchemeEditCommit({ moduleRecords, upsertRecord, setSelectedRecord })

  const activeModule =
    workspace.modules.find((module) => module.id === activeModuleId) ?? workspace.modules[0]
  // The active module's load on the Pilot (null for a module on fixtures): a governed action waits for it (#210).
  const activeModuleOnApi = useServerModuleState(workspace.id, activeModule.id)
  // Agreements and subscriptions (slice 9a of #81): the module holds two
  // kinds, its form is the registry's trimmed to what the wire takes, and a
  // standard view offers no row Edit, so the sheet's actions carry the edit
  // and the subscription's own create.
  const isAgreementsView =
    workspace.id === AGREEMENTS_MODULE.workspaceId &&
    activeModule.id === AGREEMENTS_MODULE.moduleId
  // What an agreement's price list and a subscription's product are picked
  // from there (#291): the server's rows alone — a fixture row offered on the
  // Pilot is a row the API does not hold — and whether the role reads them.
  const agreementPriceRows = useModuleRecords(PRICE_ROWS_MODULE.workspaceId, PRICE_ROWS_MODULE.moduleId)
  const agreementProducts = useModuleRecords(PRODUCTS_MODULE.workspaceId, PRODUCTS_MODULE.moduleId)
  const productsViewed = !agreementProducts.notGranted
  const hasGrant = (action: Action) => mayOn(grants, moduleKeyOf(workspace.id, activeModule.id), action)
  // A grant on another module — Map Planning creates Service Areas, so it
  // follows the Service Areas module's create grant, not Plan's.
  const hasGrantOn = (location: ModuleLocation, action: Action) => mayOn(grants, moduleKeyOf(location.workspaceId, location.moduleId), action)
  const isContainersAssetsView =
    workspace.id === "resources" && activeModule.id === "containers"
  // How a switched module is operated beyond its own forms (Issue #181): what
  // stands in for its primary action, and its rows' commands in their details.
  const commandSurface = commandSurfaceFor(workspace.id, activeModule.id)
  const formIsPrimary = commandSurface === undefined || commandSurface.primary === "form"
  const PrimarySurface = commandSurface && commandSurface.primary !== "form" ? commandSurface.primary : null
  const RowSurface = commandSurface?.rowActions
  const WhileShown = commandSurface?.whileShown
  // Its list's categories, read for the person looking ("Mine" is `/me`'s account): the popover offers them and the rows match through them.
  const viewerAccountId = me?.user.id ?? null
  const listReaders = useMemo(() => commandSurface?.list?.readers({ accountId: viewerAccountId }), [commandSurface, viewerAccountId])
  // A command replaces its row in the store: details with a row surface read
  // the live row, so what the API answered shows at once.
  const detailsRecord =
    RowSurface && selectedRecord
      ? (moduleRecords(workspace.id, activeModule.id).find((record) => record.id === selectedRecord.id) ?? selectedRecord)
      : selectedRecord
  // Map Planning (2026-09-16) renders its own page below the header: no
  // search, filter, or table rows — the map owns its toolbar.
  const isMapPlanningView = workspace.id === "plan" && activeModule.id === "map-planning"
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
  const activeModuleFormSchema = useMemo(() => {
    const registered = getBusinessFormSchema(workspace.id, activeModule.id)
    return serviceProviderScopedFormSchema(
      // The agreement form as the API takes it: the fields the wire has no home for gone (lib/data/agreements.ts).
      isAgreementsView && registered ? agreementFormSchemaOnApi(registered) : registered,
      serviceProviderScopeId,
    )
  }, [activeModule.id, isAgreementsView, serviceProviderScopeId, workspace.id])
  const relatedCreateModule = relatedCreateTarget
    ? resolveFormModule(
        relatedCreateTarget.workspaceId,
        relatedCreateTarget.moduleId,
      )
    : null
  const formSchema = useMemo(
    () =>
      relatedCreateTarget?.schemaOverride ??
      (relatedCreateModule ? getBusinessFormSchema(relatedCreateModule.workspaceId, relatedCreateModule.module.id) : activeModuleFormSchema),
    [activeModuleFormSchema, relatedCreateModule, relatedCreateTarget?.schemaOverride],
  )
  const canOpenBusinessForm =
    Boolean(activeModuleFormSchema?.execution) &&
    activeModuleFormSchema?.mode !== "disabled"
  // The module the open form writes to, which handleFormSubmit writes to, and its read on the Pilot: a write waits for it (#239).
  const formWriteRequest = formSchema?.execution?.target ?? {
    workspaceId: relatedCreateModule?.workspaceId ?? workspace.id,
    moduleId: relatedCreateModule?.module.id ?? activeModule.id,
  }
  const formWriteTarget = resolveFormModule(formWriteRequest.workspaceId, formWriteRequest.moduleId)
  const formTargetOnApi = useServerModuleState(formWriteTarget?.workspaceId ?? workspace.id, formWriteTarget?.module.id ?? activeModule.id)
  // Route Schemes get a chooser between Quick create and the Guided Setup wizard.
  const isSchemeCreateFlow =
    activeModuleFormSchema?.key === "route-studio.schemes"
  const activeRecords = useMemo(() => {
    let records = getRecords(workspace.id, activeModule.id).filter(recordAllowed)
    // Scheme status is always the derived lifecycle status (issue #25) —
    // no surface renders the raw stored string, so every downstream reader
    // (table, filters, grouping, detail, row actions) sees one truth. The
    // row context is likewise derived (issue #30, D15): real stored
    // area/project names plus structured service days, never the fixture
    // display copy.
    if (activeModule.id === "schemes") {
      const today = todayIso()
      const areas = moduleRecords(
        PLANNING_AREAS_MODULE.workspaceId,
        PLANNING_AREAS_MODULE.moduleId,
      )
      records = records.map((record) =>
        withDerivedSchemeContext(
          withEffectiveSchemeStatus(record, today),
          areas,
          // No stored project scope → no invented one (D22-style honesty);
          // the context then falls back to the structured service days.
          record.projectIds?.length ? projectScopeLabel(record.projectIds, projectRecords) : "",
        ),
      )
    }
    // A calendar's value is always derived from its structured validity
    // (issue #27, D13; a calendar carries no holidays since 2026-11-05) —
    // stored display copies and form-submit placeholders are never rendered.
    if (activeModule.id === "calendars") {
      records = records.map((record) => withDerivedCalendarValue(record))
    }
    // Service provider isolation covers user-created records too, which a static
    // fixture-id allowlist cannot. A module the API fences is the API's rows alone.
    return serviceProviderScopeId && !fencedByApi(workspace.id, activeModule.id)
      ? records.filter((record) => record.serviceProviderId === serviceProviderScopeId)
      : records
  }, [activeModule, serviceProviderScopeId, fencedByApi, getRecords, moduleRecords, projectRecords, recordAllowed, workspace.id])
  const formTargetRecords = useMemo(
    () =>
      relatedCreateModule
        ? getRecords(
            relatedCreateModule.workspaceId,
            relatedCreateModule.module.id)
        : activeRecords,
    [activeRecords, getRecords, relatedCreateModule],
  )
  // A route opens its own page over its command surface (RouteDetailsOnApi):
  // its stops first, its facts and History beside them.
  const isRoutePageOnApi =
    workspace.id === "route-studio" &&
    activeModule.id === "routes" &&
    Boolean(selectedRecord) &&
    RowSurface !== undefined
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
      usersModule.id).filter(
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
    return getRecords("fleet", vehiclesModule.id).filter(
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
    return getRecords("fleet", driversModule.id).filter(
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
      serviceAreasModule.id).filter(
      (record) =>
        record.serviceProviderId === selectedServiceProviderId && !isSoftDeleted(record),
    )
  }, [getRecords, selectedServiceProviderId])
  const relatedServiceProviderPrices = useMemo(() => {
    if (!selectedServiceProviderId) return []
    const commercialWorkspace = getWorkspaceDefinition("commercial")
    const ratesModule = commercialWorkspace.modules.find((module) => module.id === "service-provider-prices")
    if (!ratesModule) return []
    return getRecords("commercial", ratesModule.id).filter(
      (record) =>
        record.serviceProviderId === selectedServiceProviderId && !isSoftDeleted(record),
    )
  }, [getRecords, selectedServiceProviderId])
  // Record scoping compares against the selected project record's id, so a
  // project the fixture union never knew shows exactly its own records and
  // leaks into no other scope (issue #44).
  const scopedRecords = useMemo(
    () => activeRecords.filter((record) => isInProjectScope(record, projectScope)),
    [activeRecords, projectScope],
  )
  // A module holding two shapes lists one on the Pilot (the list's `shows`): the count, the filter values and the columns are that one's.
  const visibleScopedRecords = useMemo(
    () =>
      scopedRecords.filter(
        (record) => record.facts["Registry visibility"] !== "Soft deleted" && listShows(commandSurface?.list, record),
      ),
    [commandSurface?.list, scopedRecords],
  )
  // Map Planning reads other modules' records: every container in the
  // registry (the map is geographic — each planning area shows the
  // containers the system holds for it, whichever project they bill to),
  // the planning areas its Layers control outlines, the service areas its
  // Selected area panel reports coverage from, and the routes and pickups
  // its collection window, quantities, and "Existing routes in this area"
  // consult.
  const mapPlanningRecords = useMemo(() => {
    if (!isMapPlanningView) return null
    return {
      // On the Pilot a server container stands where its placement in force
      // today is delivered at, which its record carries (#184, lib/api/records/container-places.ts).
      containers: moduleRecords("resources", "containers"),
      planningAreas: moduleRecords(PLANNING_AREAS_MODULE.workspaceId, PLANNING_AREAS_MODULE.moduleId),
      serviceAreas: moduleRecords("service-providers", "service-areas"),
      routes: moduleRecords("route-studio", "routes"),
      pickups: moduleRecords("route-studio", "pickups"),
      schemes: moduleRecords("route-studio", "schemes"),
    }
  }, [isMapPlanningView, moduleRecords])

  const filteredRecords = useMemo(() => {
    const matchingRecords = visibleScopedRecords.filter((record) => {
      // A module with a list on the Pilot is matched through its readers alone.
      if (listReaders) return matchesBusinessFilters(record, businessFilters, listReaders) && matchesBusinessQuery(record, query)
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
        ["Holiday list", "Collection calendar"],
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
      const matchesQuery = matchesBusinessQuery(record, query)

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
  }, [businessFilters, listReaders, query, viewOptions.ordering, visibleScopedRecords])
  // The module has rows, so an empty list means the search or filters hide them: only then is another search worth suggesting.
  const narrowed = visibleScopedRecords.length > 0
  // A switched module's rows are the API's alone: the empty table says they are loading, why they are not, or that the API keeps them.
  const rowsAwaited = awaitedRowsSentence(activeModuleOnApi)
  // Where no API is configured a switched module has nothing to show or make: its table says so, and no action stands over it.
  const keptOnApi = activeModuleOnApi?.status === "kept-on-api"
  const activeFilterChips = useMemo(
    () => businessFilterChips(businessFilters),
    [businessFilters],
  )
  // Queue vs rich vs standard table is a property of the module, never of the
  // viewing persona (lib/data/business-view-kinds.ts) — the operator's Tickets
  // page and the service provider workspace render the same rich record table.
  const moduleViewKind = resolveModuleViewKind(activeModule.id)
  const isQueueView = moduleViewKind === "queue"
  const isTicketsView = activeModule.id === "tickets"
  const isRoutesView = activeModule.id === "routes"
  // Collection Calendars list (issue #27, D28iii): the project and the
  // validity, derived per record.
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
  const effectiveShowPrimaryAction = showPrimaryAction && hasGrant("create") && !keptOnApi
  // A surface's own dialog stands with its actions' grants — the create grant unless it names others — whatever the fixture form (#186: Settlements').
  const primary = primaryOf(
    commandSurface,
    showPrimaryAction && !keptOnApi && primaryGranted(commandSurface, { workspaceId: workspace.id, moduleId: activeModule.id }, grants),
    canOpenBusinessForm && Boolean(formSchema),
  )
  const canCreateFromView =
    effectiveShowPrimaryAction &&
    formIsPrimary &&
    canOpenBusinessForm &&
    Boolean(formSchema)
  // Generic row Edit/Delete: a rich module that exposes them (tickets do not —
  // they are worked through lifecycle transitions and the details view), the
  // viewer's grants, and for edits a form execution policy.
  // A module with a row surface on the Pilot is changed through it (#179: a
  // route or a stop moves by its commands), so the generic Edit is not
  // offered — unless the surface says the row keeps it (O6 of #290: the
  // fleet's absences sit beside the driver's and the vehicle's own form).
  const offersRowActions = moduleOffersRowActions(activeModule.id)
  const canEditRecords =
    offersRowActions &&
    Boolean(activeModuleFormSchema?.execution) &&
    hasGrant("edit") &&
    (RowSurface === undefined || commandSurface?.genericEdit === true)
  // M7 of #293: a surface whose rule keeps the generic Edit for some rows (an
  // Application while undecided) offers it in the row's details alone, where
  // the row the rule reads is known.
  const canEditSomeRecords =
    offersRowActions &&
    Boolean(activeModuleFormSchema?.execution) &&
    hasGrant("edit") &&
    typeof commandSurface?.genericEdit === "function"
  // The API has no delete (Issue #81): a switched module's record is
  // deactivated or moved to another status, never soft-deleted, so the
  // action is not offered there — and the store refuses one that arrives
  // another way. A module on fixtures deletes as it always did.
  const canDeleteRecords =
    offersRowActions && hasGrant("delete") && !isServerBacked(workspace.id, activeModule.id)
  const canRunRecordActions = hasGrant("edit")
  // The Plan Ahead toggle (FR-11, ticket #8) on a scheme's row menu, only for
  // schemes whose recurrence is structured enough to generate.
  const isSchemesView = activeModule.id === "schemes"
  // Per-scheme derived row presentation, one pass over one related-records
  // load: the live Attention warnings (issue #25, D5/D20 — recomputed from
  // canonical stored configuration, never read from persisted "Validation
  // warnings" facts) plus the Recurrence / Waste fraction cells (issue #30,
  // D15 — derived from structured submittedValues, so editing a scheme
  // changes them with no stored display string involved).
  const schemeRowsById = useMemo(() => {
    if (!isSchemesView) {
      return new Map<string, SchemeRowSummary & { attention: string[] }>()
    }
    const relatedModuleRecords = (workspaceId: WorkspaceId, moduleId: string) => {
      const module = getWorkspaceDefinition(workspaceId).modules.find(
        (candidate) => candidate.id === moduleId,
      )
      return module ? getRecords(workspaceId, module.id) : []
    }
    const related = {
      schemes: activeRecords,
      allocations: relatedModuleRecords("fleet", "vehicle-planning"),
      containers: relatedModuleRecords("resources", "containers"),
      vehicles: relatedModuleRecords("fleet", "vehicles"),
    }
    return new Map(
      activeRecords.map((record) => [
        record.id,
        {
          ...schemeRowSummary(record),
          attention: schemeAttention(record, related),
        },
      ]),
    )
  }, [activeRecords, getRecords, isSchemesView])
  // Derived Collection Calendars presentation (issue #27, D28iii): the table's
  // Validity cell derives from each record's structured submittedValues.
  const calendarRowsById = useMemo(() => {
    if (!isCalendarsView) return new Map<string, CalendarRowSummary>()
    return new Map(activeRecords.map((record) => [record.id, calendarRowSummary(record)]))
  }, [activeRecords, isCalendarsView])
  const schemeExtraActions = useCallback(
    (record: BusinessRecord): RecordExtraAction[] | undefined =>
      isSchemesView &&
      canRunRecordActions &&
      schemeCanGenerateRoutes(record, todayIso())
        ? [
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
                  getRecords("route-studio", "schemes").find(
                    (candidate) => candidate.id === target.id,
                  ) ?? target
                whenSaved(upsertRecord("route-studio", "schemes", setPlanAhead(stored, enabled)), () =>
                  toast.success(enabled ? "Plan Ahead turned on" : "Plan Ahead turned off", { description: planAheadToggledSentence(stored, enabled) }),
                )
              },
            },
          ]
        : undefined,
    [canRunRecordActions, getRecords, isSchemesView, upsertRecord],
  )
  // The agreements module's sheet actions on the API (slice 9a of #81): the
  // edit a standard view offers no row action for — an agreement's period
  // and notes, a subscription's quantity and period — and Add subscription
  // on an agreement, which opens the subscription form under it for the
  // agreement's own period. Nothing in fixture mode, which never had either.
  const canEditAgreements = isAgreementsView && hasGrant("edit")
  const canAddSubscriptions = isAgreementsView && hasGrant("create")
  const agreementExtraActions = useCallback(
    (record: BusinessRecord): RecordExtraAction[] | undefined => {
      const actions: RecordExtraAction[] = []
      if (canEditAgreements) {
        actions.push({
          label: isSubscriptionRecord(record) ? "Edit subscription" : "Edit agreement",
          icon: <PencilSimple className="h-4 w-4" />,
          onSelect: (target: BusinessRecord) => setEditingRecord(target),
        })
      }
      if (canAddSubscriptions && isAgreementRecord(record)) {
        actions.push({
          label: "Add subscription",
          icon: <Plus className="h-4 w-4" />,
          onSelect: (target: BusinessRecord) =>
            setRelatedCreateTarget({
              workspaceId: AGREEMENTS_MODULE.workspaceId,
              moduleId: AGREEMENTS_MODULE.moduleId,
              initialValues: subscriptionInitialValues(target),
              schemaOverride: subscriptionFormSchemaFor(productsViewed),
            }),
        })
      }
      return actions.length === 0 ? undefined : actions
    },
    [canAddSubscriptions, canEditAgreements, productsViewed],
  )
  /** The module-specific actions a row and its sheet offer: the schemes' or the agreements', never both. */
  const recordExtraActions = useCallback(
    (record: BusinessRecord): RecordExtraAction[] | undefined => schemeExtraActions(record) ?? agreementExtraActions(record),
    [agreementExtraActions, schemeExtraActions],
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
        // Recurrence + Waste fraction replace the value column (#30).
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
        // The calendars' Validity stands in place of the value (#27).
        Number(viewOptions.showContext) +
        Number(viewOptions.showUpdated)
  const isFleetPlanningView =
    workspace.id === "fleet" && activeModule.id === "vehicle-planning"
  const fleetPlanningItems = useMemo<TimelineItem[]>(
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

  const removeFilterChip = (key: BusinessFilterKey, value: string) => {
    setBusinessFilters((current) => removeBusinessFilterValue(current, key, value))
  }

  // The address bar's module is applied once per change, not on every
  // record-store change that makes WorkspaceQuerySync ask again
  // (lib/url/module-sync.ts); a tab click is a module applied.
  const [moduleSync] = useState(createModuleSync)
  // A module of this workspace, and a record in it, on the page it is shown on: a restricted shell's own.
  const moduleHref = (moduleId: string, recordId?: string) => workspaceHref({ workspaceId: workspace.id, moduleId }, recordId, { page: navigationBasePath })

  const handleModuleChange = (moduleId: string) => {
    moduleSync.record(moduleId)
    setActiveModuleId(moduleId)
    setQuery("")
    setBusinessFilters(initialFiltersOf(commandSurfaceFor(workspace.id, moduleId)))
    setSelectedRecord(null)
    setPendingAction(null)
    setIsCreateOpen(false)
    router.push(
      moduleHref(moduleId),
      { scroll: false },
    )
  }

  const syncModuleFromQuery = useCallback((moduleId: string) => {
    if (!moduleSync.apply(moduleId)) return
    setActiveModuleId(moduleId)
    setQuery("")
    setBusinessFilters(initialFiltersOf(commandSurfaceFor(workspace.id, moduleId)))
    setPendingAction(null)
    setIsCreateOpen(false)
  }, [moduleSync, workspace.id])

  const resolveWorkspaceRecord = useCallback(
    (moduleId: string, recordId: string) => {
      const module = workspace.modules.find(
        (candidate) => candidate.id === moduleId,
      )
      if (!module) return null
      let record =
        getRecords(workspace.id, module.id).find(
          (candidate) => candidate.id === recordId && recordAllowed(candidate),
        ) ?? null
      // Deep-linked schemes show the derived lifecycle status (issue #25)
      // and derived row context (issue #30) too.
      if (record && module.id === "schemes") {
        record = withEffectiveSchemeStatus(record, todayIso())
        record = withDerivedSchemeContext(
          record,
          moduleRecords(PLANNING_AREAS_MODULE.workspaceId, PLANNING_AREAS_MODULE.moduleId),
          record.projectIds?.length ? projectScopeLabel(record.projectIds, projectRecords) : "",
        )
      }
      // Deep-linked calendars show the derived validity too (issue #27).
      if (record && module.id === "calendars") {
        record = withDerivedCalendarValue(record)
      }
      // Deep links cannot escape a service provider scope; the API's own fence holds a switched module's.
      if (
        record &&
        serviceProviderScopeId &&
        !fencedByApi(workspace.id, module.id) &&
        record.serviceProviderId !== serviceProviderScopeId
      ) {
        return null
      }
      return record
    },
    [serviceProviderScopeId, fencedByApi, getRecords, moduleRecords, projectRecords, recordAllowed, workspace],
  )

  const openRecord = (record: BusinessRecord) => {
    setSelectedRecord(record)
    router.push(
      moduleHref(activeModule.id, record.id),
      { scroll: false },
    )
  }

  const closeRecord = () => {
    setSelectedRecord(null)
    router.replace(
      moduleHref(activeModule.id),
      { scroll: false },
    )
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

  const commitRecordAction = ({
    reason,
    effectiveDate,
  }: {
    reason: string
    effectiveDate: string
  }) => {
    if (!pendingAction) return

    const { record, action } = pendingAction
    // A switched module the API has not answered for — still loading, its
    // load failed, or no API is configured — has nowhere to send the change:
    // say so and keep the dialog, rather than report an action that went
    // nowhere (#210).
    const gate = writeGate({ target: activeModuleOnApi, label: activeModule.label, when: "the action can be confirmed" })
    if (gate.kind === "held") {
      toast.error(`${record.name} was not changed`, { description: gate.description })
      return
    }
    const nextStatus = actionOutcome(activeModule, action, record.status)
    const createsCompanion = createsImmutableCompanion(activeModule, action)
    // The id the browser's deletion log and a companion's link name the action by.
    const auditId = `audit-${Date.now()}`

    if (action.toLowerCase().includes("delete")) {
      const deletion = { reason, actorName, deletionLogId: auditId }
      upsertRecord(
        workspace.id,
        activeModule.id,
        softDeletedRecord(record, deletion),
      )
      setSelectedRecord(null)
      setPendingAction(null)
      router.replace(
        moduleHref(activeModule.id),
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
        related: [record.name, `Audit ${auditId}`],
        source: "Controlled workflow",
        freshness: "Now",
        allowedTransitions: activeModule.lifecycle.slice(1, 3),
        projectIds:
          record.projectIds ?? selectedProjectIds(projectScope, {}, projectRecords),
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

      // On a module the API holds, the action has happened once the API has
      // answered (#210): the dialog stays open, its confirm held, its word
      // waiting for the write's outcome, and a refusal is the store's toast
      // alone over the dialog still holding what was typed. On a module on
      // fixtures there is nothing to wait for, and all of it runs at once.
      setActionSaving(true)
      whenSaved(upsertRecord(workspace.id, activeModule.id, companion), () => {
        // This action's dialog, unless another has been opened since.
        setPendingAction((current) => (current === pendingAction ? null : current))
        toast.success(`${companion.name} created`, {
          description: isCorrection
            ? "The issued source record was preserved."
            : "A separate governed record and audit event were added.",
        })
      }, () => setActionSaving(false))
    } else {
      // On a module the API holds, the status is all the wire takes (#251) and the API's audit log keeps the change: no action facts, no browser row, the reason in the write's change-reason header (#291).
      const onApi = activeModuleOnApi !== null
      const { keepsBrowserAudit } = actionDecisionShape({ onApi, createsCompanion })
      const nextRecord: BusinessRecord = {
        ...record,
        status: nextStatus,
        updated: "Now",
        ...(keepsBrowserAudit
          ? {
              facts: {
                ...record.facts,
                "Last controlled action": action,
                "Action reason": reason,
                "Action actor": actorName,
                ...(effectiveDate ? { "Effective date": effectiveDate } : {}),
              },
              related: [`Audit ${auditId}`, ...record.related.filter((item) => item !== `Audit ${auditId}`)],
            }
          : {}),
        allowedTransitions:
          nextStatus === record.status
            ? record.allowedTransitions
            : nextAllowedTransitions(activeModule, nextStatus),
      }
      // As above (#210): the dialog closes, the audit gains its row, the
      // details move to the new row — where they still show this one and
      // read the selected row; a module with a row surface reads the store's
      // live row, which moves at once and back on a refusal — and the person
      // is told, all once the write has landed.
      setActionSaving(true)
      const said = reason.trim()
      whenSaved(upsertRecord(workspace.id, activeModule.id, nextRecord, onApi && said !== "" ? { reason: said } : undefined), () => {
        // This action's dialog, unless another has been opened since.
        setPendingAction((current) => (current === pendingAction ? null : current))
        setSelectedRecord((current) => (current?.id === record.id ? nextRecord : current))
        toast.success(`${action} recorded`, { description: actionRecordedSentence({ onApi, before: record.status, after: nextStatus }) })
      }, () => setActionSaving(false))
    }
  }

  /** The agreement form (slice 9a of #81): the API holds the number's rule, so the workspace's uniqueness check stands aside. */
  const agreementsOnApi = formSchema?.key === `${AGREEMENTS_MODULE.workspaceId}.${AGREEMENTS_MODULE.moduleId}`
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
      // The scheme form offers only rows the store reads from the API: a
      // module on fixtures offers nothing, since a fixture row names nothing
      // the API holds, and a value the scheme already names stays as its id chip.
      if (
        formSchema?.key === "route-studio.schemes" &&
        !isServerBacked(resolved.workspaceId, resolved.module.id)
      ) {
        const current = values[field.id]
        return typeof current === "string" && current !== "" ? [{ value: current, label: current }] : []
      }

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
        resolved.module.id)
      // On the API an agreement's price list is one of its project's lists in
      // its currency, the project's default list first, and a subscription's
      // product one of its agreement's project's (#291, lib/data/agreements.ts).
      if (isAgreementsView && field.id === "priceListId") {
        return agreementPriceListOptions(agreementPriceRows.records, values)
      }
      if (isAgreementsView && formSchema?.recordKind === SUBSCRIPTION_RECORD_KIND && field.id === "productId") {
        return subscriptionProductOptions(agreementProducts.records, values)
      }

      const permittedRecords = relationRecords
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
          if (!serviceProviderScopeId || fencedByApi(resolved.workspaceId, resolved.module.id)) return true
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
          // A picker at the master data module gets the kind its field asks
          // for (slice 2 of #81): the rule is the adapters' own ownership —
          // the id's prefix, then the typed kind — so a renamed row stays in
          // its list. A field that names no kind (an outcome reason, a fuel
          // type) has no list on the API yet, so it sees only the rows of no
          // kind: the fixtures' master-data sets, as before the switch.
          if (
            resolved.workspaceId === MASTER_DATA_MODULE.workspaceId &&
            resolved.module.id === MASTER_DATA_MODULE.moduleId
          ) {
            const kind = masterDataKindOf(record)
            if (kind !== null && kind !== masterDataKindForField(field.id)) return false
          }
          // A picker at the agreements module offers the agreements alone
          // (slice 9a of #81): on the API the module holds the subscriptions
          // too, and a field that names an agreement names no subscription.
          // A `subscriptionId` (M7 of #293: an Application's) names a
          // subscription, and offers the subscriptions alone.
          if (
            resolved.workspaceId === AGREEMENTS_MODULE.workspaceId &&
            resolved.module.id === AGREEMENTS_MODULE.moduleId &&
            !(field.id === "subscriptionId" ? isSubscriptionRecord(record) : isAgreementRecord(record))
          ) {
            return false
          }
          // A picker at the service areas module offers the kind its field
          // names (slice 11 of #81): the module holds the awards and their
          // assignments, and a price names an assignment, never an award.
          if (
            resolved.workspaceId === SERVICE_AREAS_MODULE.workspaceId &&
            resolved.module.id === SERVICE_AREAS_MODULE.moduleId
          ) {
            const kind = serviceAreaKindForField(field.id)
            if (kind !== null && serviceAreaKindOf(record) !== kind) return false
          }
          if (field.id === "projectId") {
            if (!isProjectRecordId(record.id)) return false
            const pinned = pinnedProjectId(projectScope)
            return pinned === null || record.id === pinned
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
            const isPerson =
              record.id.startsWith("contact-") || createdPartyType === "person"
            // A customer field names a Customer in the glossary's sense — a
            // person or an organisation alike (the seed's private owners hold
            // agreements and own properties) — so it offers both.
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

          const pinnedProject = pinnedProjectId(projectScope)
          if (pinnedProject !== null && record.projectIds?.length) {
            return record.projectIds.includes(pinnedProject)
          }
          return true
        })
      // The route scheme quick form's driver select goes through the same
      // licence rule as the wizard's group editor (quickDriverOptions, issue
      // #37): every driver listed, an ineligible one disabled with the
      // reason, an unknown licence never eligible.
      if (formSchema?.key === "route-studio.schemes" && field.id === "plannedDriverId") {
        const vehicles = resolveFormModule("fleet", "vehicles")
        return driverFormOptions(
          values,
          permittedRecords,
          vehicles
            ? getRecords(vehicles.workspaceId, vehicles.module.id)
            : [],
        )
      }
      // A picker hides no row by status (#79: a status gates a new reference,
      // never an existing one, and the API's 409 says so); a customer picker
      // shows a row's status beside its name, so a person sees the refusal
      // coming.
      const showsStatus = resolved.module.id === "contacts"
      return permittedRecords.map((record) => ({
        value: record.id,
        label: showsStatus && record.status !== "Active" ? `${record.name} · ${record.status}` : record.name,
      }))
    },
    [isAgreementsView, agreementPriceRows.records, agreementProducts.records, serviceProviderScopeId, fencedByApi, formSchema?.key, formSchema?.recordKind, getRecords, projectScope],
  )

  const formInitialValues = useMemo<BusinessFormValues>(() => {
    const pinnedProject = pinnedProjectId(projectScope)
    return {
      ...(pinnedProject === null ? {} : { projectId: pinnedProject }),
      ...(serviceProviderScopeId
        ? { serviceProviderId: serviceProviderScopeId, invitedBy: actorName }
        : {}),
      ...(relatedCreateTarget?.initialValues ?? {}),
    }
  }, [actorName, serviceProviderScopeId, projectScope, relatedCreateTarget])

  const editInitialValues = useMemo<BusinessFormValues>(() => {
    if (!editingRecord || !activeModuleFormSchema) return formInitialValues
    if (editingRecord.submittedValues) {
      // The scheme edit seed is a lib seam (issue #35): stored values are the
      // truth and the schema's create-time defaults never speak for a record
      // that predates a field — stop selection reads through
      // stopSelectionMode (a scheme without the flag IS manual), retired
      // recurrence shapes map onto today's options, and a missing planned
      // start time stays missing (issue #32).
      const seeded: BusinessFormValues =
        activeModuleFormSchema.key === "route-studio.schemes"
          ? {
              ...formInitialValues,
              ...seedSchemeEditValues(editingRecord.submittedValues),
            }
          : { ...formInitialValues, ...editingRecord.submittedValues }
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
              resolved.module.id).find(
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
      // A fixture that carries typed values beside its display facts (a
      // driver's licence class, a vehicle's required class, a project's
      // weekend) has no name field among them, so seed it from the record
      // name as the fixture path below does — the dialog must not open
      // nameless. A created record always carries its name field, so this
      // changes nothing for it.
      const seededNameField = activeModuleFormSchema.nameField
        ? activeModuleFormSchema.sections
            .flatMap((section) => section.fields)
            .find((field) => field.id === activeModuleFormSchema.nameField)
        : undefined
      if (
        seededNameField?.type === "text" &&
        !(typeof seeded[seededNameField.id] === "string" && seeded[seededNameField.id])
      ) {
        seeded[seededNameField.id] = editingRecord.name
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
  ])

  const editFormSchema = useMemo<BusinessFormSchema | undefined>(() => {
    if (!editingRecord || !activeModuleFormSchema?.execution) return undefined
    // A subscription is the agreements module's second kind (slice 9a of
    // #81): its own form, not the agreement's, edits it.
    if (isAgreementsView && isSubscriptionRecord(editingRecord)) return subscriptionEditSchema
    const entity = activeModule.entityLabel
    // A multi-group scheme's groups own its assignment and stop selection
    // (D36): the schema dialog edits scheme-level fields only — the groups
    // are edited on the scheme page — so those fields are hidden here.
    const hidesGroupFields =
      activeModuleFormSchema.key === "route-studio.schemes" &&
      hasExplicitCollectionGroups(editingRecord.submittedValues)
    const sections = hidesGroupFields
      ? activeModuleFormSchema.sections
          .map((section) => ({
            ...section,
            fields: section.fields.filter(
              (field) => !GROUP_OWNED_SCHEME_FIELD_IDS.has(field.id),
            ),
          }))
          .filter((section) => section.fields.length > 0)
      : activeModuleFormSchema.sections
    return {
      ...activeModuleFormSchema,
      sections,
      title: `Edit ${entity.toLowerCase()}`,
      submitLabel: "Save changes",
      execution: {
        ...activeModuleFormSchema.execution,
        completionMessage: `The ${entity.toLowerCase()} was updated and its audit history extended.`,
      },
    }
  }, [activeModule.entityLabel, activeModuleFormSchema, editingRecord, isAgreementsView])

  const validateFormValues = useCallback(
    (values: BusinessFormValues) => {
      if (!formSchema) return {}
      const errors: Record<string, string> = {}
      const fields = formSchema.sections.flatMap((section) => section.fields)
      const uniqueFields = fields
        .filter(
          (field) =>
            field.id === formSchema.nameField ||
            field.id === "barcode" ||
            /(code|reference|registrationNumber|externalId)$/i.test(field.id),
        )
        // An agreement's number is not unique on the API: one agreement of a
        // number is valid at a time, and the next may follow it (ADR-0005),
        // which the API refuses in its own sentence when the periods overlap.
        .filter((field) => !(agreementsOnApi && field.id === formSchema.nameField))

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

      if (formSchema.key === "route-studio.schemes") {
        // The same licence rule the select applies, at submit (issue #37):
        // a driver picked before the vehicle changed is refused with the reason.
        const vehicles = resolveFormModule("fleet", "vehicles")
        const drivers = resolveFormModule("fleet", "drivers")
        const reason = quickDriverIssue(
          values,
          drivers ? getRecords(drivers.workspaceId, drivers.module.id) : [],
          vehicles
            ? getRecords(vehicles.workspaceId, vehicles.module.id)
            : [],
        )
        if (reason) errors.plannedDriverId = reason
      }

      const selectedProjectId = values.projectId
      const pinnedProject = pinnedProjectId(projectScope)
      if (
        typeof selectedProjectId === "string" &&
        pinnedProject !== null &&
        selectedProjectId !== pinnedProject
      ) {
        errors.projectId = "The selected project is outside the current workspace scope."
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
    [agreementsOnApi, editingRecord?.id, formSchema, formTargetRecords, getRecords, projectScope],
  )

  const getFormReviewSummary = useCallback(
    (values: BusinessFormValues) => {
      if (!formSchema?.execution) return []
      const projectIds = selectedProjectIds(projectScope, values, projectRecords)

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
        { label: "Project scope", value: projectScopeLabel(projectIds, projectRecords) },
        {
          label: "Execution policy",
          value: formSchema.execution.kind.replaceAll("-", " "),
        },
      ]
    },
    [formSchema, getRecords, projectRecords, projectScope],
  )

  const handleFormSubmit = (values: BusinessFormValues) => {
    // One clock read per submission, shared by the audit event id and the
    // generated record names below.
    // eslint-disable-next-line react-hooks/purity -- submit handler, not render; the rule cannot tell through the dialogs' onSubmit prop
    const now = Date.now()
    if (!formSchema?.execution) return

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

    const resolvedTarget = formWriteTarget
    if (!resolvedTarget) {
      toast.error("This workflow target is not available.")
      return
    }
    // A switched module the API has not read yet has nowhere to send the
    // write: the dialog stays open and says when it can be saved (#239, as #210).
    const gate = writeGate({
      target: formTargetOnApi,
      label: resolvedTarget.module.label,
      when: "the form can be saved",
      editing: editingRecord === null ? undefined : { id: editingRecord.id, name: editingRecord.name },
    })
    if (gate.kind === "held") {
      toast.error(`The ${formSchema.recordKind.toLowerCase()} was not saved`, { description: gate.description })
      return
    }

    const fields = formSchema.sections.flatMap((section) => section.fields)
    const fieldById = new Map(fields.map((field) => [field.id, field]))

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
        resolved.module.id).find((candidate) => candidate.id === recordId)?.name
      if (!name) return undefined
      // Vehicle names carry the registration plate; facts show the callsign.
      return resolved.workspaceId === "fleet" && resolved.module.id === "vehicles"
        ? name.split(" · ")[0]
        : name
    }

    // The shared derivation (lib/data/business-form-records.ts) with what only
    // this workspace knows: linked-record names, the live scoped relation
    // options for labels, and where a relation target actually resolves.
    const formRecordResolvers: FormRecordResolvers = {
      relationRecordName,
      optionLabel: (field, item) =>
        (field.relation ? getFormRelationOptions(field, values) : field.options ?? []).find(
          (option) => option.value === item,
        )?.label,
      resolveRelationTarget: (relation) => {
        const resolved = resolveFormModule(relation.workspaceId, relation.moduleId)
        return resolved
          ? { workspaceId: resolved.workspaceId, moduleId: resolved.module.id }
          : undefined
      },
    }
    const displayFormValue = (field: BusinessFormField, value: string | boolean) =>
      displayFormRecordValue(field, value, formRecordResolvers)

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
      // On the Pilot the dialog closes once the API has taken the scheme, and stays open on its refusal, its submit held meanwhile.
      const draft = quickSchemeDraftFromValues(values)
      formWrite(
        createSchemeFromDraft(draft, {
          method: "Quick create",
          extraValues,
          extraFacts,
          extraRelations,
        }),
        { id: `quick-scheme-${now}`, name: draft.schemeName || "The route scheme" } as BusinessRecord,
        (stillOpen) => {
          if (!stillOpen) return
          setIsCreateOpen(false)
          setRelatedCreateTarget(null)
        },
      )
      return
    }

    const {
      facts,
      relationRefs,
      contextValues,
      nameValue: submittedNameValue,
    } = deriveFormRecord(formSchema, values, formRecordResolvers)

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
            serviceProviderTarget.module.id).find((record) => record.id === serviceProviderScopeId)?.name
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
            areaTarget.module.id).filter((record) => record.serviceProviderId === serviceProviderScopeId)
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

    const nameField = formSchema.nameField
      ? fieldById.get(formSchema.nameField)
      : undefined
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
        : nameValue || `${formSchema.recordKind} · ${now}`
    const projectIds = selectedProjectIds(projectScope, values, projectRecords)

    // A scheme's recurrence is machine-readable in submittedValues (frequency,
    // serviceDays, weekRotation, effectiveFrom/To, plannedStartTime — the shape
    // @waste/domain/planning/recurrence reads); the facts get the one-line summary
    // the record detail shows.
    const normalizeRouteSchemeRecord = (record: BusinessRecord): BusinessRecord => {
      let nextFacts = { ...record.facts }
      // Keep the stop-selection facts in sync with the merged values
      // (issue #19): the quick edit form can flip the mode or change the
      // shared rule, and the facts must follow the stopSelection flag —
      // stale rule facts on a manual scheme (or vice versa) would misstate
      // where its stops come from. The form's single Waste fraction is the
      // scheme's (issue #43): the domain writes it onto the rule, or onto
      // every explicit group, before anything reads the merged values.
      const mergedValues = applySchemeWasteFraction({ ...record.submittedValues })
      // The quick form's label-keyed facts duplicate the canonical
      // "Container selection" / "Stop matching" / "Planned start" keys.
      delete nextFacts["Stop selection"]
      delete nextFacts["Waste fractions to match"]
      delete nextFacts["Container types to match"]
      delete nextFacts["Vehicle type"]
      delete nextFacts["Planned start time"]
      // Facts of the fields retired in issue #35 — written by edit-saves
      // before the fields were removed, read by nothing.
      delete nextFacts["Route end behavior"]
      delete nextFacts["Scheme source"]
      // Keep the canonical facts in step with the merged values: an edit that
      // clears the planned start time really clears it (issue #32) — a stale
      // fact would resurrect the old time in generation and the detail page —
      // and the scope facts follow the fraction and service type the same way.
      const plannedStartTime =
        typeof mergedValues.plannedStartTime === "string"
          ? mergedValues.plannedStartTime.trim()
          : ""
      if (plannedStartTime) nextFacts["Planned start"] = plannedStartTime
      else delete nextFacts["Planned start"]
      for (const [key, label] of [
        ["wasteFraction", "Waste fraction"],
        ["serviceType", "Service type"],
      ] as const) {
        const stored = mergedValues[key]
        const value = typeof stored === "string" ? stored.trim() : ""
        if (value) nextFacts[label] = value
        else delete nextFacts[label]
      }
      nextFacts = withSchemeGroupFacts(nextFacts, mergedValues)
      const recurrence = recurrenceFromValues(values)
      if (!recurrence) return { ...record, submittedValues: mergedValues, facts: nextFacts }
      // The retired free-text cadence field, and — when the frequency moved
      // away from every-2-weeks — the rotation fact the edit merge would
      // otherwise carry forward against the new Recurrence line.
      delete nextFacts["Collection weeks or rule"]
      if (recurrence.frequency !== "every-2-weeks") delete nextFacts["Week rotation"]
      return {
        ...record,
        submittedValues: mergedValues,
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
          ? formatShortDay(nextFacts.Date)
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
      // route actually runs: actualDate only.
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

    if (editingRecord) {
      // The derived facts skip empty values and are merged over the record's,
      // so a field the person emptied would keep its old fact and a
      // condition, an Effective to or a scheduled change could never be
      // cancelled through Edit (issue #22). clearedFactKeys names the fields
      // the form opened with a value and received back empty — a deliberate
      // clearing — and nothing else, so a field that is not on this form, or
      // one the seed could not prefill, keeps its fact.
      const mergedFacts = { ...editingRecord.facts, ...facts }
      for (const key of clearedFactKeys(formSchema, values, editInitialValues)) {
        delete mergedFacts[key]
      }
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
        facts: mergedFacts,
        submittedValues: { ...editingRecord.submittedValues, ...values },
        relationRefs,
        projectIds,
      }
      if (resolvedTarget.module.id === "routes") {
        updatedRecord = normalizeRouteRecord(updatedRecord)
      }
      if (resolvedTarget.module.id === "schemes") {
        // The one scheme edit-save (issue #33, D31): commitSchemeEdit applies
        // the edit by the scheme's edit policy (issue #38) — asking first when
        // the policy says so. The dialog closes once the save is applied, so
        // an asked or refused save keeps it open.
        // The stored record is the `before`: it is what the form was seeded
        // from, and the planner reads the policy and the kept configuration
        // off it.
        const stored =
          moduleRecords("route-studio", "schemes").find(
            (candidate) => candidate.id === editingRecord.id,
          ) ?? editingRecord
        commitSchemeEdit(stored, normalizeRouteSchemeRecord(updatedRecord), () => setEditingRecord(null))
        return
      }
      // On a switched module the dialog waits for the API's answer, its
      // submit held, and stays open with what was typed on a refusal, which
      // is the store's toast in the API's words; a module on fixtures lands at once (#239).
      formWrite(upsertRecord(resolvedTarget.workspaceId, resolvedTarget.module.id, updatedRecord), updatedRecord, (stillOpen) => {
        setSelectedRecord((current) => (current?.id === updatedRecord.id ? updatedRecord : current))
        // The dialog this edit was made in, and no other the person has opened since.
        if (stillOpen) setEditingRecord(null)
        toast.success(`${formSchema.recordKind} updated`, {
          description: `${updatedRecord.name} was updated and its audit history extended.`,
        })
      })
      return
    }

    let newRecord: BusinessRecord = {
      id: `${resolvedTarget.module.id}-${slugify(formSchema.recordKind)}-${now}`,
      name: recordName,
      context: contextValues.join(" · ") || projectScopeLabel(projectIds, projectRecords),
      status: initialFormStatus(resolvedTarget.module, formSchema, values),
      owner: actorName,
      value: formSchema.execution.resultValue ?? formSchema.submitLabel,
      updated: "Now",
      description: formSchema.description,
      facts: {
        Scope: projectScopeLabel(projectIds, projectRecords),
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
      projectIds,
      serviceProviderId:
        typeof values.serviceProviderId === "string" && values.serviceProviderId
          ? values.serviceProviderId
          : serviceProviderScopeId,
      recordKind: formSchema.recordKind,
      submittedValues: { ...values, ...(relatedCreateTarget?.extraValues ?? {}) },
      relationRefs,
    }
    if (resolvedTarget.module.id === "routes") {
      newRecord = normalizeRouteRecord(newRecord)
    }
    if (resolvedTarget.module.id === "schemes") {
      newRecord = normalizeRouteSchemeRecord(newRecord)
    }
    // On a switched module the dialog waits for the API's answer, its submit
    // held: the row is opened and said to be made only once the API has
    // taken it, and a refusal — the store's toast, in the API's words —
    // leaves the dialog open with what was typed. A person who left the
    // dialog meanwhile is not taken back to the row. A module on fixtures lands at once (#239).
    // Read before the answer: `newRecord` is reassigned above, and `execution` is not narrowed inside the callback.
    const createdRecord = newRecord
    const { completionMessage } = formSchema.execution
    formWrite(upsertRecord(resolvedTarget.workspaceId, resolvedTarget.module.id, createdRecord), createdRecord, (stillOpen) => {
      if (stillOpen) {
        setIsCreateOpen(false)
        setRelatedCreateTarget(null)
        if (resolvedTarget.workspaceId === workspace.id && resolvedTarget.module.id === activeModule.id) {
          setSelectedRecord(createdRecord)
          router.push(
            moduleHref(activeModule.id, createdRecord.id),
            { scroll: false },
          )
        }
      }
      toast.success(
        formSchema.mode === "action"
          ? `${formSchema.recordKind} recorded`
          : `${formSchema.recordKind} created`,
        { description: completionMessage },
      )
    })
  }

  // Route Scheme creation shared by both create paths (spec FR-2/FR-5/FR-14;
  // issue #31, D19/P1): builds the record from the draft, decides Validated vs
  // Draft with the blocking checks, keeps submittedValues in the shape the
  // recurrence engine and per-day plan readers consume, and writes it.
  // Guided Setup hands the wizard draft in directly;
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
  ): Promise<WriteOutcome> | undefined => {
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
        resolved.module.id).find((candidate) => candidate.id === recordId)
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
    const area = linkRecord(
      "planningAreaId",
      PLANNING_AREAS_MODULE.workspaceId,
      PLANNING_AREAS_MODULE.moduleId,
      data.planningAreaId,
    )
    const depot = linkRecord("depotId", "resources", "depots", data.depotId)
    const unloadingStation = linkRecord(
      "unloadingStationId",
      "resources",
      "depots",
      data.unloadingStationId,
    )

    const containersModule = businessWorkspaces.resources.modules.find(
      (candidate) => candidate.id === "containers",
    )
    const containerRecords = containersModule
      ? getRecords("resources", containersModule.id)
      : []
    const vehiclesModule = businessWorkspaces.fleet.modules.find(
      (candidate) => candidate.id === "vehicles",
    )
    const vehicleRecords = vehiclesModule
      ? getRecords("fleet", vehiclesModule.id)
      : []

    // Collection groups (D33): each group links its own vehicle, driver, and
    // service provider, and carries their display names so generation stamps
    // them without a record lookup. Linking dedupes across groups.
    const linkedIds = new Set<string>()
    const linkOnce = (
      fieldId: string,
      workspaceId: WorkspaceId,
      moduleId: string,
      recordId?: string,
    ) => {
      if (!recordId) return undefined
      const key = `${fieldId}:${recordId}`
      if (linkedIds.has(key)) {
        return moduleRecords(workspaceId, moduleId).find(
          (candidate) => candidate.id === recordId,
        )
      }
      linkedIds.add(key)
      return linkRecord(fieldId, workspaceId, moduleId, recordId)
    }
    // Groups inherit the scheme's waste fraction (step 1) — one source of truth.
    const groups: CollectionGroup[] = draftGroups(data).map((group) => {
      const vehicle = linkOnce("plannedVehicleId", "fleet", "vehicles", group.vehicleId)
      const driver = linkOnce("plannedDriverId", "fleet", "drivers", group.driverId)
      const provider = linkOnce(
        "serviceProviderId",
        "service-providers",
        "service-providers",
        group.serviceProviderId,
      )
      return {
        ...group,
        // Vehicle names carry the registration plate; facts show the callsign.
        ...(vehicle ? { vehicleName: vehicle.name.split(" · ")[0] } : {}),
        ...(driver ? { driverName: driver.name } : {}),
        ...(provider ? { serviceProviderName: provider.name } : {}),
      }
    })
    // Only manual picks become container relationRefs — a rule group stores
    // the rule, never the resolved result (issue #19), so generation
    // re-resolves each run.
    for (const containerId of new Set(
      groups
        .filter((group) => group.stopSource === "manual")
        .flatMap((group) => group.containerIds),
    )) {
      linkRecord("containerIds", "resources", "containers", containerId)
    }
    const dayPlans = resolvedDraftPlans(data, containerRecords)
    if (origin.extraRelations) relationRefs.push(...origin.extraRelations)

    // Conflicts (FR-5d) are checked against every scheme, not just the ones a
    // service provider-scoped view can see — a double-booked default is real either
    // way, and the review step's preview uses the same unscoped set. Vehicle
    // Planning allocations join the check the same way (issue #11).
    const allocationModule = businessWorkspaces.fleet.modules.find(
      (candidate) => candidate.id === "vehicle-planning",
    )
    // With the API's containers not placed the zero-match sentence is no evidence and does not make the scheme a Draft (#207).
    const validation = validationWhenUnplaced(
      validateGuidedScheme(
        data,
        getRecords(workspace.id, activeModule.id),
        allocationModule
          ? getRecords("fleet", allocationModule.id)
          : [],
        containerRecords,
        vehicleRecords,
      ),
      containersPlaced,
    )

    const submittedValues: NonNullable<BusinessRecord["submittedValues"]> = schemeValuesOfDraft(data, groups, origin.extraValues)
    const recurrence = recurrenceFromValues(submittedValues)

    const projectIds = selectedProjectIds(
      projectScope,
      { projectId: data.projectId ?? "" },
      projectRecords,
    )
    const totalStops = dayPlans.reduce(
      (sum, plan) => sum + plan.containerIds.length,
      0,
    )
    const sharedProviderId = sharedServiceProvider(groups).id
    const facts: Record<string, string> = withSchemeGroupFacts(
      {
        Scope: projectScopeLabel(projectIds, projectRecords),
        "Record kind": "Route Scheme",
        "Execution policy": "create record",
        "Submitted by": actorName,
        Version: "v1",
        ...(project ? { Project: project.name } : {}),
        ...(area ? { "Planning area": area.name } : {}),
        ...(data.wasteFraction ? { "Waste fraction": data.wasteFraction } : {}),
        ...(data.serviceType ? { "Service type": data.serviceType } : {}),
        // Holidays follow the project (holiday model 2026-09-16): its explicit list.
        "Holiday list":
          resolveProjectCalendar(data.projectId, {
            projects: moduleRecords("configure", "organization"),
            calendars: moduleRecords(COLLECTION_CALENDARS_MODULE.workspaceId, COLLECTION_CALENDARS_MODULE.moduleId),
          }).list?.name ?? NO_HOLIDAY_LIST_LABEL,
        ...(recurrence ? { Recurrence: recurrenceSentence(recurrence) } : {}),
        ...(data.effectiveFrom
          ? {
              Effective: `${data.effectiveFrom} → ${data.effectiveTo || "ongoing"}`,
            }
          : {}),
        "Holiday policy": HOLIDAY_POLICY_LABELS[data.holidayPolicy],
        "Changes to a running scheme": SCHEME_EDIT_POLICY_LABELS[data.editPolicy],
        // Absent = no estimated start (issue #32) — the detail page shows "—".
        ...(data.plannedStartTime.trim()
          ? { "Planned start": data.plannedStartTime.trim() }
          : {}),
        ...(depot ? { "Departure depot": depot.name } : {}),
        ...(unloadingStation
          ? { "Unloading station": unloadingStation.name }
          : {}),
        Containers: dayPlanCountSummary(dayPlans),
      },
      submittedValues,
      groups,
    )
    Object.assign(facts, {
      ...(origin.extraFacts ?? {}),
      ...(validation.issues.length > 0
        ? { "Validation issues": validation.issues.join(" · ") }
        : {}),
      ...(validation.warnings.length > 0
        ? { "Validation warnings": validation.warnings.join(" · ") }
        : {}),
    })

    const newRecord: BusinessRecord = {
      id: `${activeModule.id}-route-scheme-${now}`,
      name: data.schemeName.trim() || "Untitled scheme",
      context:
        [project?.name, area?.name].filter(Boolean).join(" · ") ||
        projectScopeLabel(projectIds, projectRecords),
      status: validation.status,
      owner: actorName,
      value: `${totalStops} planned stops`,
      updated: "Now",
      description:
        groups.length > 1
          ? `Created with ${origin.method} — ${groups.length} collection groups, each generating its own routes on the days it runs.`
          : groups[0]?.stopSource === "rule"
            ? `Created with ${origin.method} — stops are matched by the scheme's declarative rule at every generation.`
            : origin.method === "Guided Setup"
              ? "Created with Guided Setup covering scope, recurrence, the collection group's assignment, and its picked containers."
              : "Created with Quick create — manual container lists are picked in Guided Setup.",
      facts,
      related: [
        ...relationRefs.map((relation) => relation.label),
        "Audit history created",
      ],
      source: "Office workspace",
      freshness: "Now",
      allowedTransitions: activeModule.lifecycle.slice(1, 3),
      projectIds,
      serviceProviderId: sharedProviderId ?? serviceProviderScopeId,
      recordKind: "Route Scheme",
      submittedValues,
      relationRefs,
    }
    // The API takes the scheme as it stands — Draft or Validated, the web's
    // validation deciding which it asks for and the API holding a validated
    // one to its structural rules — and its routes are the API's to
    // generate: nothing past the scheme is written here, and the scheme opens
    // and the toast shows once the API has answered.
    const saved = upsertRecord(ROUTE_SCHEMES_MODULE.workspaceId, ROUTE_SCHEMES_MODULE.moduleId, newRecord)
    whenSaved(saved, () => {
      if (origin.method !== "Guided Setup") {
        setSelectedRecord(newRecord)
        router.push(moduleHref(activeModule.id, newRecord.id), { scroll: false })
      }
      if (newRecord.status === "Draft") {
        toast.warning(`Route scheme created as Draft — ${newRecord.name}`, {
          description: `${validation.issues.length} open issue${validation.issues.length === 1 ? "" : "s"}: ${validation.issues.join(" · ")}`,
        })
      } else {
        toast.success(`Route scheme created — ${newRecord.name}`, {
          description: "The nightly plan-ahead run generates its routes.",
        })
      }
    })
    return saved
  }

  /**
   * "Edit collection groups" save (D36): serializes the groups onto the stored
   * scheme (legacy shape for one group covering every day, explicit
   * otherwise), refreshes the facts, and saves through the same edit-save the
   * schema dialog uses (commitSchemeEdit), which applies it by the scheme's
   * edit policy, asking first when the policy says so (issue #38).
   */
  const handleSchemeGroupsSave = (groups: CollectionGroup[]) => {
    if (!groupsEditorScheme) return
    const stored =
      moduleRecords("route-studio", "schemes").find(
        (candidate) => candidate.id === groupsEditorScheme.id,
      ) ?? groupsEditorScheme
    const serviceDays = serviceDaysFromValues(stored.submittedValues ?? {})
    const mergedValues = {
      ...stored.submittedValues,
      ...collectionGroupsToValues(groups, serviceDays),
    }
    const updatedRecord: BusinessRecord = {
      ...stored,
      updated: "Now",
      freshness: "Now",
      submittedValues: mergedValues,
      facts: withSchemeGroupFacts(stored.facts, mergedValues, groups),
      serviceProviderId: sharedServiceProvider(groups).id ?? stored.serviceProviderId,
    }
    commitSchemeEdit(stored, updatedRecord, () => setGroupsEditorScheme(null))
  }

  const handleGuidedSchemeCreate = (data: GuidedSchemeData) =>
    createSchemeFromDraft(data, { method: "Guided Setup" })

  const requestServiceProviderRelatedCreate = (
    target: "user" | "vehicle" | "driver" | "service-area" | "service-provider-price",
  ) => {
    if (!selectedRecord) return
    const serviceProviderId = selectedRecord.id

    // An award and a price are the API's forms (slice 11 of #81): an award to this provider, a price under one of its assignments.
    if (target === "service-area" || target === "service-provider-price") {
      setRelatedCreateTarget(pilotProviderCreate(target, serviceProviderId, localDateInputValue(), getRecords(SERVICE_AREAS_MODULE.workspaceId, SERVICE_AREAS_MODULE.moduleId)))
      return
    }

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
    }
  }

  if (!hasRoleViewableModules) {
    return (
      <div className="flex flex-1 flex-col min-h-0 bg-background mx-2 my-2 border border-sidebar rounded-lg min-w-0">
        <PageTopBar>
          <Breadcrumbs items={[{ label: workspaceLabel ?? workspace.label }]} />
        </PageTopBar>
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

  // A module's own actions sit in its table's header (TableCard), never in the
  // top bar, which is kept for the app-wide items (components/page-layout.tsx).
  const moduleActions =
    isContainersAssetsView || (showExportAction && !keptOnApi) || primary !== null ? (
      <>
        {isContainersAssetsView && (
          <Button variant="outline" size="sm" asChild>
            <Link href={settingsHref("master-data", { from: moduleHref("containers") })}>
              <Gear className="h-4 w-4" />
              <span className="hidden sm:inline">Asset settings</span>
            </Link>
          </Button>
        )}
        {showExportAction && !keptOnApi && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // The rows the table shows under the search, the filters and the scope, every page of them, by the columns it draws (#292).
              const rows = exportShownRows(
                filteredRecords,
                {
                  view: isContainersAssetsView ? "containers" : isRoutesView ? "routes" : isServiceProviderUsersView ? "provider-users" : isCalendarsView ? "calendars" : isSchemesView ? "schemes" : "records",
                  rich: isRichRecordView,
                  entityLabel: activeModule.entityLabel,
                  contextLabel: activeModule.contextLabel,
                  valueLabel: activeModule.valueLabel,
                  options: viewOptions,
                  staticColumns: activeStaticColumns,
                  factColumns: activeFactColumns,
                  projectScopeOf: (record) => projectScopeLabel(record.projectIds ?? [], projectRecords),
                  calendarRowOf: (record) => calendarRowsById.get(record.id),
                  schemeRowOf: (record) => schemeRowsById.get(record.id),
                },
                { workspace: workspaceLabel ?? workspace.label, module: activeModule.label, day: todayIso() },
              )
              toast.success(`Exported ${rows} ${rows === 1 ? "row" : "rows"}`, { description: `${activeModule.title} · the rows and columns shown` })
            }}
          >
            <DownloadSimple className="h-4 w-4" />
            <span className="hidden sm:inline">Export</span>
          </Button>
        )}
        {primary === "surface" && PrimarySurface && <PrimarySurface label={activeModule.primaryAction} />}
        {primary === "form" && formSchema && (
          isSchemeCreateFlow ? (
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
      </>
    ) : null

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
          onEditGroups={
            canEditRecords ? () => setGroupsEditorScheme(schemeDetailRecord) : undefined
          }
          readOnly={!canRunRecordActions}
        />
      ) : isRoutePageOnApi && detailsRecord ? (
        <RouteDetailsOnApi
          module={activeModule}
          record={detailsRecord}
          onBack={closeRecord}
          history={
            activeModuleOnApi !== null ? (
              <RecordHistory key={detailsRecord.id} workspaceId={workspace.id} moduleId={activeModule.id} record={detailsRecord} />
            ) : undefined
          }
          menu={
            <RecordActionsMenu
              record={detailsRecord}
              entityLabel={activeModule.entityLabel}
              onDelete={canDeleteRecords ? requestRecordDelete : undefined}
            />
          }
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
      {/* What a switched module does on its own while it is shown (the registry's `whileShown`): mounted with the module's view, whatever the toolbar offers. */}
      {WhileShown ? <WhileShown /> : null}
      <header className="flex flex-col border-b border-border/40">
        <PageTopBar>
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
        </PageTopBar>

        {/* The map has no table to head, so its actions get a bar of their own under the top bar. */}
        {isMapPlanningView && moduleActions && (
          <div className="flex justify-end border-b border-border/40 px-4 py-2"><PageActions>{moduleActions}</PageActions></div>
        )}

        {!isMapPlanningView && (
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

          {showFilters && !isMapPlanningView && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-1 flex-wrap items-center gap-2 min-w-[260px]">
                <RecordSearchInput
                  value={query}
                  onChange={setQuery}
                  placeholder={`Search ${activeModule.entityLabel.toLowerCase()}s`}
                />
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
                  readers={listReaders}
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
          {showFilters && !isMapPlanningView && (
            <ChipOverflow
              chips={activeFilterChips}
              onRemove={removeFilterChip}
              maxVisible={4}
            />
          )}
        </div>
        )}
      </header>

      {isMapPlanningView && mapPlanningRecords ? (
        <MapPlanningView
          containers={mapPlanningRecords.containers}
          planningAreas={mapPlanningRecords.planningAreas}
          serviceAreas={mapPlanningRecords.serviceAreas}
          routes={mapPlanningRecords.routes}
          pickups={mapPlanningRecords.pickups}
          schemes={mapPlanningRecords.schemes}
          canCreateScheme={hasGrant("create")}
          canCreateServiceArea={hasGrantOn(SERVICE_AREAS_MODULE, "create")}
          onCreateServiceArea={(seed) => {
            // The award is the planning areas the selection touches, the drawn polygon never persisted (slice 11 of #81).
            const opened = pilotServiceAreaCreate(seed)
            if ("refused" in opened) {
              toast.error("No service area to create", { description: opened.refused })
              return
            }
            setRelatedCreateTarget({
              workspaceId: SERVICE_AREAS_MODULE.workspaceId,
              moduleId: SERVICE_AREAS_MODULE.moduleId,
              ...opened,
            })
          }}
          onCreateScheme={handleGuidedSchemeCreate}
        />
      ) : (
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <div className="mx-auto max-w-[1500px] space-y-4">
          <section className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">{activeModule.title}</h1>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="unstyled"
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`About ${activeModule.title}`}
                  >
                    <Info className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm text-xs">
                  <p>{activeModule.description}</p>
                  {/* The module's rules (ModuleDefinition.rules) are the
                      integrity statements its records follow; every module
                      carries them and this is where they are read. */}
                  {activeModule.rules.length > 0 && (
                    <ul className="mt-2 list-disc space-y-1 pl-4">
                      {activeModule.rules.map((rule) => (
                        <li key={rule}>{rule}</li>
                      ))}
                    </ul>
                  )}
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

          <TableCard
            summary={`${recordCountLabel(filteredRecords.length, visibleScopedRecords.length)}${fixedScopeLabel ? ` · ${fixedScopeLabel}` : ""}`}
            actions={moduleActions}
          >
            {isFleetPlanningView ? (
              <div className="p-4">
                <WeekTimeline
                  title="Availability and allocation"
                  emptyLabel="No allocations match the current filters"
                  items={fleetPlanningItems}
                  onItemSelect={(itemId) => {
                    const record = filteredRecords.find((item) => item.id === itemId)
                    if (record) openRecord(record)
                  }}
                />
              </div>
            ) : isQueueView ? (
              <div className="divide-y divide-border/60 p-1">
                {filteredRecords.length === 0 ? (
                  <NoRecordsShown narrowed={narrowed} waiting={rowsAwaited} />
                ) : (
                  filteredRecords.map((record) => (
                    <CheckRow
                      key={record.id}
                      checked={/(completed|resolved|approved|closed|certified)/i.test(record.status)}
                      title={record.name}
                      subtitle={[
                        viewOptions.showContext ? record.context : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      titleSuffix={
                        <StatusBadge tone={recordStatusTone(record.status)} className="rounded-full px-2 py-0.5 text-[11px] font-medium">
                          {record.status}
                        </StatusBadge>
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
                narrowed={narrowed}
                waiting={rowsAwaited}
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
                narrowed={narrowed}
                waiting={rowsAwaited}
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
                narrowed={narrowed}
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
                            {isCalendarsView && <TableHead>Validity</TableHead>}
                            {/* Schemes swap the generic value column (Demand)
                                for the derived Recurrence / Waste fraction
                                pair (issue #30, D15; round 3). */}
                            {isSchemesView ? (
                              <>
                                <TableHead>Recurrence</TableHead>
                                <TableHead>Waste fraction</TableHead>
                              </>
                            ) : (
                              !isServiceProviderUsersView && !isCalendarsView && (
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
                          <TableCell colSpan={visibleTableColumnCount}>
                            <NoRecordsShown narrowed={narrowed} waiting={rowsAwaited} />
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
                                      <StatusBadge tone={recordStatusTone(group.label)} className="rounded-full px-2 py-0.5 text-[11px] font-medium">
                                        {group.label}
                                      </StatusBadge>
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
                                  <StatusBadge tone={recordStatusTone(record.status)} className="whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium">
                                    {record.status}
                                  </StatusBadge>
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
                                    <Button
                                      variant="unstyled"
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
                                          "size-4",
                                          isRouteStarred(record.id)
                                            ? "text-warning"
                                            : "text-muted-foreground/60 hover:text-foreground",
                                        )}
                                      />
                                    </Button>
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
                                        ? projectScopeLabel(record.projectIds, projectRecords)
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
                                    <StatusBadge tone={recordStatusTone(record.status)} className="rounded-full px-2 py-0.5 text-[11px] font-medium">
                                      {record.status}
                                    </StatusBadge>
                                    <SchemeAttentionBadge
                                      warnings={schemeRowsById.get(record.id)?.attention}
                                    />
                                  </div>
                                </TableCell>
                                {isCalendarsView && (
                                  <TableCell className="min-w-[170px] whitespace-nowrap text-sm text-muted-foreground">
                                    {calendarRowsById.get(record.id)?.validity ?? "—"}
                                  </TableCell>
                                )}
                                {isSchemesView ? (
                                  <>
                                    <TableCell className="min-w-[170px] whitespace-nowrap text-sm text-muted-foreground">
                                      {schemeRowsById.get(record.id)?.recurrence ?? "—"}
                                    </TableCell>
                                    <TableCell className="min-w-[140px] whitespace-nowrap text-sm text-muted-foreground">
                                      {schemeRowsById.get(record.id)?.wasteFraction ?? "—"}
                                    </TableCell>
                                  </>
                                ) : (
                                  !isServiceProviderUsersView && !isCalendarsView && (
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
                                      extraActions={recordExtraActions(record)}
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
          </TableCard>

        </div>
      </div>
      )}

      {isTicketDetails && selectedRecord ? (
        <LiveTicketDetailsDialog record={selectedRecord} onClose={closeRecord} />
      ) : (
        <RecordDetailsDialog
          module={activeModule}
          record={detailsRecord}
          onClose={closeRecord}
          onAction={requestRecordAction}
          transitions={
            detailsRecord ? offeredTransitions(workspace.id, activeModule, detailsRecord) : []
          }
          showDeepLinks={showDeepLinks}
          onEdit={canEditRecords || (canEditSomeRecords && genericEditOffered(commandSurface, detailsRecord)) ? openEditRecord : undefined}
          onDelete={canDeleteRecords ? requestRecordDelete : undefined}
          showActions={canRunRecordActions}
          extraActions={selectedRecord ? recordExtraActions(selectedRecord) : undefined}
          commands={RowSurface && detailsRecord ? <RowSurface record={detailsRecord} /> : undefined}
          history={
            activeModuleOnApi !== null && detailsRecord ? (
              <RecordHistory key={detailsRecord.id} workspaceId={workspace.id} moduleId={activeModule.id} record={detailsRecord} />
            ) : undefined
          }
          onApi={activeModuleOnApi !== null}
          attention={
            isSchemesView && selectedRecord
              ? schemeRowsById.get(selectedRecord.id)?.attention
              : undefined
          }
        />
      )}
        </>
      )}
      <CollectionGroupsEditorDialog
        scheme={groupsEditorScheme}
        onClose={() => setGroupsEditorScheme(null)}
        onSave={handleSchemeGroupsSave}
      />
      {/* "Ask each time" (issue #38): the question a scheme edit raised, over
          whichever edit door raised it — the door stays open underneath. */}
      <SchemeEditPolicyDialog
        schemeName={pendingSchemeEdit?.after.name ?? null}
        question={pendingSchemeEdit?.question ?? null}
        onClose={dismissPendingSchemeEdit}
        onChoose={answerPendingSchemeEdit}
      />
      {/* One dialog per action, so what was typed for one never opens another; it is kept while the action's write is out and after its refusal (#210). */}
      <ActionDecisionDialog
        key={pendingAction ? `${pendingAction.record.id}:${pendingAction.action}` : "none"}
        module={activeModule}
        pendingAction={pendingAction}
        saving={actionSaving}
        onApi={activeModuleOnApi !== null}
        onOpenChange={(open) => !open && setPendingAction(null)}
        onConfirm={commitRecordAction}
      />
      {!relatedCreateTarget &&
        activeModuleFormSchema?.execution &&
        activeModuleFormSchema.mode !== "disabled" && (
        <BusinessRecordFormDialog
          schema={activeModuleFormSchema}
          open={isCreateOpen}
          onOpenChange={(open) => {
            if (!open) leaveForm()
            setIsCreateOpen(open)
          }}
          onSubmit={handleFormSubmit}
          relationOptions={getFormRelationOptions}
          initialValueOverrides={formInitialValues}
          validateValues={validateFormValues}
          reviewSummary={getFormReviewSummary}
          submitting={formSaving}
        />
      )}
      {relatedCreateTarget &&
        formSchema?.execution &&
        formSchema.mode !== "disabled" && (
          <BusinessRecordFormDialog
            schema={formSchema}
            open
            onOpenChange={(open) => {
              if (open) return
              leaveForm()
              setRelatedCreateTarget(null)
            }}
            onSubmit={handleFormSubmit}
            relationOptions={getFormRelationOptions}
            initialValueOverrides={formInitialValues}
            validateValues={validateFormValues}
            reviewSummary={getFormReviewSummary}
            submitting={formSaving}
          />
        )}
      {editingRecord && editFormSchema && (
        <BusinessRecordFormDialog
          schema={editFormSchema}
          open
          onOpenChange={(open) => {
            if (open) return
            leaveForm()
            setEditingRecord(null)
          }}
          onSubmit={handleFormSubmit}
          relationOptions={getFormRelationOptions}
          initialValueOverrides={editInitialValues}
          validateValues={validateFormValues}
          reviewSummary={getFormReviewSummary}
          submitting={formSaving}
        />
      )}
      <Suspense fallback={null}>
        <WorkspaceQuerySync
          workspace={workspace}
          landingModuleId={landingModuleId}
          onModuleChange={syncModuleFromQuery}
          onRecordOpen={setSelectedRecord}
          resolveRecord={resolveWorkspaceRecord}
        />
      </Suspense>
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
      className="rounded-full border-transparent bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning-foreground"
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
  transitions,
  showDeepLinks,
  onEdit,
  onDelete,
  showActions = true,
  extraActions,
  commands,
  history,
  attention,
  onApi = false,
}: {
  module: ModuleDefinition
  record: BusinessRecord | null
  onClose: () => void
  onAction: (action: string) => void
  /** The row's commands on the Pilot (the command surfaces' `rowActions`), under its facts. */
  commands?: ReactNode
  /** The row's History on the Pilot, the API's audit log (#291), under its lifecycle. */
  history?: ReactNode
  /** The transitions offered as buttons — `offeredTransitions`, which the parent computes since it knows the workspace. */
  transitions: string[]
  showDeepLinks: boolean
  onEdit?: (record: BusinessRecord) => void
  onDelete?: (record: BusinessRecord) => void
  showActions?: boolean
  extraActions?: RecordExtraAction[]
  /** Live scheme Attention warnings; renders the amber overlay badge. */
  attention?: string[]
  /** The module is read from the API: its statuses are the wire's, which the fixture lifecycle may not list (#261). */
  onApi?: boolean
}) {
  const key = record === null ? undefined : readableKey(record.id)
  // A status the lifecycle does not list: said alone where the module's statuses are the API's, which the strip does not walk.
  const offLifecycle = record !== null && !module.lifecycle.includes(record.status)
  return (
    <Sheet open={Boolean(record)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-2xl">
        {record && (
          <>
            <SheetHeader className="border-b border-border px-5 py-4 pr-12 text-left">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={recordStatusTone(record.status)} className="rounded-full text-[11px]">
                  {record.status}
                </StatusBadge>
                <SchemeAttentionBadge warnings={attention} />
                {key !== undefined && (
                  <Badge variant="outline" className="rounded-full text-[11px] font-normal">
                    {key}
                  </Badge>
                )}
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

              {commands}

              <section className="space-y-4">
                <h3 className="text-sm font-semibold">Lifecycle</h3>
                {offLifecycle && (
                  <StatusBadge tone={recordStatusTone(record.status)} className="rounded-full text-[11px]">
                    Current status · {record.status}
                  </StatusBadge>
                )}
                {!(onApi && offLifecycle) && (
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
                )}
              </section>

              {history}

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
                  transitions.map((action) => (
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
  saving = false,
  onApi = false,
  onOpenChange,
  onConfirm,
}: {
  module: ModuleDefinition
  pendingAction: PendingAction | null
  /** The action's write is out to the API: confirm waits, and the form keeps what was typed for a refusal (#210). */
  saving?: boolean
  /** The module is one the API holds: the status alone goes out, so no reason or date is asked (#251). */
  onApi?: boolean
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
  const shape = actionDecisionShape({ onApi, createsCompanion })
  const outcome = pendingAction
    ? actionOutcome(module, action, pendingAction.record.status)
    : ""

  const close = () => {
    setReason("")
    setEffectiveDate("")
    setDeletionCategory("")
    onOpenChange(false)
  }

  // The form is not cleared here: it is one dialog per action (the parent's
  // key), closed once the action has landed and kept on a refusal (#210).
  const confirm = () => {
    onConfirm({
      reason: isDeleteAction
        ? `${deletionCategory}: ${reason.trim()}`
        : reason.trim(),
      effectiveDate,
    })
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
                  {module.id === "schemes" && (
                    <p className="text-xs text-muted-foreground">
                      Deleting a route scheme stops Plan Ahead and future
                      generation and cancels its future planned routes (kept
                      as records). Executed, active and completed routes and
                      their stops are preserved as operational history.
                    </p>
                  )}
                </div>
              )}

              {shape.asksReason && (
                <div className="space-y-2">
                  <Label htmlFor="action-reason">{shape.requiresReason ? "Decision or action reason" : "Reason (optional)"}</Label>
                  <Textarea
                    id="action-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder={shape.requiresReason ? "Explain why this action is appropriate and note the evidence reviewed." : "Why, in a sentence the history will show beside the change."}
                    className="min-h-24 resize-none"
                    maxLength={PARAGRAPH_MAX}
                  />
                </div>
              )}

              {shape.asksEffectiveDate && (
                <div className="space-y-2">
                  <Label htmlFor="action-effective-date">Effective date</Label>
                  <Input
                    id="action-effective-date"
                    type="date"
                    value={effectiveDate}
                    onChange={(event) => setEffectiveDate(event.target.value)}
                  />
                </div>
              )}

              <div className="rounded-xl border border-border/60 p-3">
                <p className="text-xs leading-5 text-muted-foreground">{shape.promise}</p>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button
                onClick={confirm}
                disabled={saving || (shape.requiresReason && !reason.trim()) || (isDeleteAction && !deletionCategory)}
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
