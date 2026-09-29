"use client"

// Settings → Operations → Areas & Zones: the management surface for planning
// areas and notification zones (moved from the Plan workspace 2026-09-03,
// D37). Rendered in the same full-page panel style as Asset management and
// the Commercial registries (AssetPanelShell + toolbar + records table +
// dialogs). The records stay business records under configure.areas so Route
// Schemes, containers, and Service Areas keep referencing them; the record
// shape written here is lib/data/planning-areas.ts's.

import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { PencilSimple, Plus } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import {
  AssetPanelShell,
  AssetToolbar,
  EmptyRow,
  RecordsSection,
  defaultAssetView,
  sortByView,
  type AssetView,
} from "@/components/settings/asset-management-settings"
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
import {
  TablePagination,
  useTablePagination,
} from "@/components/ui/table-pagination"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import {
  useBusinessRecordStore,
  useBusinessRecordsHydrated,
  useModuleRecords,
} from "@/components/waste/business-record-store"
import { statusClasses } from "@/components/waste/business-record-views"
import type {
  BusinessFormField,
  BusinessFormOption,
  BusinessFormValues,
} from "@/lib/data/business-form-types"
import {
  getModuleDefinition,
  type BusinessRecord,
  type ModuleLocation,
} from "@/lib/data/business-modules"
import {
  PLANNING_AREAS_MODULE,
  createPlanningAreaRecord,
  planningAreaFormValues,
  planningAreaPurposeOptions,
  planningAreaSchema,
  planningAreaTableRow,
  planningAreasModule,
  updatePlanningAreaRecord,
  type PlanningAreaLookups,
} from "@/lib/data/planning-areas"
import { isSoftDeleted } from "@waste/domain/record-visibility"
import { todayIso } from "@waste/domain/route-schemes/recurrence"
import { cn } from "@/lib/utils"

const ACTOR_NAME = "Olivia Larsen"

const ORGANISATION_MODULE = getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })

const isAreasModule = (location: ModuleLocation) =>
  location.workspaceId === PLANNING_AREAS_MODULE.workspaceId && location.moduleId === PLANNING_AREAS_MODULE.moduleId

export function PlanningAreasSettings() {
  const { getRecords, upsertRecord } = useBusinessRecordStore()
  const hydrated = useBusinessRecordsHydrated()
  const searchParams = useSearchParams()
  const [query, setQuery] = useState("")
  const [statuses, setStatuses] = useState<string[]>([])
  const [purposes, setPurposes] = useState<string[]>([])
  const [view, setView] = useState<AssetView>(defaultAssetView)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [editingArea, setEditingArea] = useState<BusinessRecord | null>(null)

  const schema = planningAreaSchema()
  const areasModule = planningAreasModule()
  const purposeOptions = planningAreaPurposeOptions()

  // Live records of any module (fixtures merged with stored records) — the
  // relation targets the form offers and the names the facts display.
  const relationRecords = (location: ModuleLocation): BusinessRecord[] => {
    const module = getModuleDefinition(location)
    return module
      ? getRecords(location.workspaceId, module.id, module.records).filter(
          (record) => !isSoftDeleted(record),
        )
      : []
  }

  // The pane's own module and the projects it names: on the Pilot, the API's
  // rows once they are here and nothing before (Issue #175).
  const areas = useModuleRecords(PLANNING_AREAS_MODULE.workspaceId, PLANNING_AREAS_MODULE.moduleId, areasModule.records)
  const areaRecords = areas.records.filter((record) => !isSoftDeleted(record))
  const organisation = useModuleRecords("configure", "organization", ORGANISATION_MODULE?.records ?? [])
  const projectRecords = organisation.records.filter(
    (record) => !isSoftDeleted(record) && record.id.startsWith("project-"),
  )

  const lookups: PlanningAreaLookups = {
    projectName: (projectId) =>
      projectRecords.find((record) => record.id === projectId)?.name,
    recordName: (relation, recordId) =>
      relationRecords(relation).find((record) => record.id === recordId)?.name,
  }

  const relationOptions = (field: BusinessFormField): readonly BusinessFormOption[] => {
    if (!field.relation) return field.options ?? []
    const records =
      field.id === "projectId"
        ? projectRecords
        : (isAreasModule(field.relation) ? areaRecords : relationRecords(field.relation)).filter(
            // A version cannot supersede itself.
            (record) => !(field.id === "previousVersionId" && record.id === editingArea?.id),
          )
    return records.map((record) => ({ value: record.id, label: record.name }))
  }

  const editSchema = useMemo(
    () => ({
      ...schema,
      title: "Edit planning area",
      submitLabel: "Save changes",
      description:
        "Update this planning area. Changes apply immediately to every scheme, container, and service area that references it.",
    }),
    [schema],
  )

  // A deep link (/settings?pane=areas&record=…) opens that area for editing —
  // once the store has loaded, so a user-created area is found too (before
  // hydration only fixtures exist). Later edits keep their own state, so the
  // records list is deliberately not a dependency.
  const requestedRecordId = searchParams.get("record")
  useEffect(() => {
    if (!hydrated || !requestedRecordId) return
    const record = areaRecords.find((candidate) => candidate.id === requestedRecordId)
    if (record) setEditingArea(record)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, requestedRecordId])

  const rows = areaRecords.map((record) => ({
    record,
    row: planningAreaTableRow(record, lookups),
  }))
  const statusOptions = Array.from(
    new Set([...areasModule.lifecycle, ...areaRecords.map((record) => record.status)]),
  )
  const filtered = sortByView(
    rows
      .filter(({ record, row }) =>
        [record.name, record.context, row.code, row.purpose, row.project]
          .join(" ")
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
      .filter(({ record }) => statuses.length === 0 || statuses.includes(record.status))
      .filter(({ row }) => purposes.length === 0 || purposes.includes(row.purpose)),
    view,
    ({ record }) => record.name,
    // Records carry a fuzzy "updated" label, not a sortable timestamp — the
    // "Last updated" ordering keeps the store's order instead of inventing one.
    () => "",
  )
  const { page, setPage, pageCount, pageRows, totalCount } = useTablePagination(filtered)

  // On the Pilot the store answers the write's outcome once the API has, so
  // the success is said then and a refusal by the store, in the API's words;
  // on the browser's own path there is nothing to wait for.
  const whenSaved = (outcome: ReturnType<typeof upsertRecord>, done: () => void) => {
    if (outcome === undefined) done()
    else void outcome.then((result) => result.kind !== "refused" && done())
  }

  const handleCreate = (values: BusinessFormValues) => {
    const record = createPlanningAreaRecord(values, {
      now: Date.now(),
      actorName: ACTOR_NAME,
      lookups,
    })
    whenSaved(upsertRecord(PLANNING_AREAS_MODULE.workspaceId, PLANNING_AREAS_MODULE.moduleId, record), () =>
      toast.success("Planning area created", {
        description: `${record.name} is available to route schemes, containers, and service areas.`,
      }),
    )
    setIsCreateOpen(false)
  }

  const handleEdit = (values: BusinessFormValues) => {
    if (!editingArea) return
    const record = updatePlanningAreaRecord(editingArea, values, lookups)
    whenSaved(upsertRecord(PLANNING_AREAS_MODULE.workspaceId, PLANNING_AREAS_MODULE.moduleId, record), () =>
      toast.success("Planning area updated", { description: `${record.name} was updated.` }),
    )
    setEditingArea(null)
  }

  const emptyMessage = areas.pending
    ? "Reading the planning areas from the API…"
    : areas.problem
      ? `The planning areas could not be read from the API: ${areas.problem.detail ?? areas.problem.title}`
      : "No planning areas match this search."

  return (
    <AssetPanelShell
      heading="Operations"
      title={areasModule.label}
      description={areasModule.description}
      action={
        <Button size="sm" onClick={() => setIsCreateOpen(true)} disabled={!areas.ready}>
          <Plus className="h-4 w-4" weight="bold" />
          {areasModule.primaryAction}
        </Button>
      }
      toolbar={
        <AssetToolbar
          searchPlaceholder="Search planning areas"
          query={query}
          onQueryChange={setQuery}
          statuses={statuses}
          onStatusesChange={setStatuses}
          statusOptions={statusOptions}
          extraFilters={[
            {
              label: "Purpose",
              options: purposeOptions.map((option) => option.label),
              value: purposes,
              onChange: setPurposes,
            },
          ]}
          view={view}
          onViewChange={setView}
        />
      }
    >
      <RecordsSection shown={filtered.length} total={areaRecords.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[1080px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Name</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Purpose</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead>Coverage</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <EmptyRow colSpan={8} message={emptyMessage} />
              ) : (
                pageRows.map(({ record, row }) => (
                  <TableRow key={record.id}>
                    <TableCell className="min-w-[220px]">
                      <p className="text-sm font-medium text-foreground">{record.name}</p>
                      {view.showDetails && (
                        <p className="text-xs text-muted-foreground">{record.context}</p>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {row.code}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[11px] font-normal">
                        {row.purpose}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {row.project}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {row.effective}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {row.coverage}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11px] font-medium",
                          statusClasses(row.status),
                        )}
                      >
                        {row.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setEditingArea(record)}
                        aria-label={`Edit ${record.name}`}
                      >
                        <PencilSimple className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <TablePagination
          page={page}
          pageCount={pageCount}
          totalCount={totalCount}
          onPageChange={setPage}
        />
      </RecordsSection>

      <BusinessRecordFormDialog
        schema={schema}
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onSubmit={handleCreate}
        relationOptions={relationOptions}
      />
      {editingArea && (
        <BusinessRecordFormDialog
          schema={editSchema}
          open
          onOpenChange={(open) => {
            if (!open) setEditingArea(null)
          }}
          onSubmit={handleEdit}
          relationOptions={relationOptions}
          initialValueOverrides={planningAreaFormValues(editingArea, todayIso())}
        />
      )}
    </AssetPanelShell>
  )
}
