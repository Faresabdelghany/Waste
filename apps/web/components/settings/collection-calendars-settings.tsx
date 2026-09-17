"use client"

// Settings › Operations › Collection calendars: the per-year holiday calendar
// records of each project (moved from the Plan workspace 2026-09-16, when
// Plan became Map Planning). Every table cell derives from the record's
// typed values at render time (@waste/domain/route-schemes/calendar-list) — never
// from stored display copies. Create and edit go through the shared form
// dialog with the module's own schema; the record shape is owned by
// lib/data/collection-calendars.ts.

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
import { TablePagination, useTablePagination } from "@/components/ui/table-pagination"
import { BusinessRecordFormDialog } from "@/components/wastehero/business-record-form-dialog"
import {
  useBusinessRecordStore,
  useBusinessRecordsHydrated,
} from "@/components/wastehero/business-record-store"
import { statusClasses } from "@/components/wastehero/business-record-views"
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
  COLLECTION_CALENDARS_MODULE,
  collectionCalendarFormValues,
  collectionCalendarSchema,
  collectionCalendarsModule,
  createCollectionCalendarRecord,
  updateCollectionCalendarRecord,
  type CollectionCalendarLookups,
} from "@/lib/data/collection-calendars"
import { isSoftDeleted } from "@waste/domain/record-visibility"
import { calendarRowSummary } from "@waste/domain/route-schemes/calendar-list"
import { resolveProjectCalendar } from "@waste/domain/route-schemes/project-calendar"
import { todayIso } from "@waste/domain/route-schemes/recurrence"
import { cn } from "@/lib/utils"

const ACTOR_NAME = "Olivia Larsen"

export function CollectionCalendarsSettings() {
  const { getRecords, upsertRecord } = useBusinessRecordStore()
  const hydrated = useBusinessRecordsHydrated()
  const searchParams = useSearchParams()
  const [query, setQuery] = useState("")
  const [statuses, setStatuses] = useState<string[]>([])
  const [projects, setProjects] = useState<string[]>([])
  const [view, setView] = useState<AssetView>(defaultAssetView)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [editingCalendar, setEditingCalendar] = useState<BusinessRecord | null>(null)

  const schema = collectionCalendarSchema()
  const calendarsModule = collectionCalendarsModule()
  const today = todayIso()

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

  const calendarRecords = relationRecords(COLLECTION_CALENDARS_MODULE)
  const projectRecords = relationRecords({
    workspaceId: "configure",
    moduleId: "organization",
  }).filter((record) => record.id.startsWith("project-"))

  const lookups: CollectionCalendarLookups = {
    projectName: (projectId) =>
      projectRecords.find((record) => record.id === projectId)?.name,
    recordName: (relation, recordId) =>
      relationRecords(relation).find((record) => record.id === recordId)?.name,
  }

  const relationOptions = (field: BusinessFormField): readonly BusinessFormOption[] => {
    if (!field.relation) return field.options ?? []
    const records = field.id === "projectId" ? projectRecords : relationRecords(field.relation)
    return records.map((record) => ({ value: record.id, label: record.name }))
  }

  const editSchema = useMemo(
    () => ({
      ...schema,
      title: "Edit collection calendar",
      submitLabel: "Save changes",
      description:
        "Update this calendar. Holiday and validity changes apply to the next route generation of every scheme on the project.",
    }),
    [schema],
  )

  // A deep link (/settings?pane=collection-calendars&record=…) opens that
  // calendar for editing — once the store has loaded, so a user-created
  // calendar is found too. Later edits keep their own state, so the records
  // list is deliberately not a dependency.
  const requestedRecordId = searchParams.get("record")
  useEffect(() => {
    if (!hydrated || !requestedRecordId) return
    const record = calendarRecords.find((candidate) => candidate.id === requestedRecordId)
    if (record) setEditingCalendar(record)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, requestedRecordId])

  const projectLabel = (record: BusinessRecord): string => {
    const ids = record.projectIds ?? []
    if (ids.length === 1) return lookups.projectName(ids[0]) ?? ids[0]
    if (ids.length > 1) return "All projects"
    return "—"
  }

  const rows = calendarRecords.map((record) => {
    const projectId = record.projectIds?.length === 1 ? record.projectIds[0] : undefined
    const workingWeek = resolveProjectCalendar(projectId, {
      projects: projectRecords,
      calendars: calendarRecords,
    })
    return {
      record,
      project: projectLabel(record),
      workingDays: workingWeek.weekend.length > 0 ? workingDaysLabel(workingWeek.weekend) : "All days",
      ...calendarRowSummary(record, today),
    }
  })
  const statusOptions = Array.from(
    new Set([...calendarsModule.lifecycle, ...calendarRecords.map((record) => record.status)]),
  )
  const projectOptions = Array.from(new Set(rows.map((row) => row.project))).sort()
  const filtered = sortByView(
    rows
      .filter(({ record, project }) =>
        [record.name, record.context, project]
          .join(" ")
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
      .filter(({ record }) => statuses.length === 0 || statuses.includes(record.status))
      .filter(({ project }) => projects.length === 0 || projects.includes(project)),
    view,
    ({ record }) => record.name,
    // Records carry a fuzzy "updated" label, not a sortable timestamp — the
    // "Last updated" ordering keeps the store's order instead of inventing one.
    () => "",
  )
  const { page, setPage, pageCount, pageRows, totalCount } = useTablePagination(filtered)

  const handleCreate = (values: BusinessFormValues) => {
    const record = createCollectionCalendarRecord(values, {
      now: Date.now(),
      actorName: ACTOR_NAME,
      lookups,
    })
    upsertRecord(COLLECTION_CALENDARS_MODULE.workspaceId, COLLECTION_CALENDARS_MODULE.moduleId, record)
    toast.success("Collection calendar created", {
      description: `${record.name} is read by route generation on its project.`,
    })
    setIsCreateOpen(false)
  }

  const handleEdit = (values: BusinessFormValues) => {
    if (!editingCalendar) return
    const record = updateCollectionCalendarRecord(editingCalendar, values, lookups)
    upsertRecord(COLLECTION_CALENDARS_MODULE.workspaceId, COLLECTION_CALENDARS_MODULE.moduleId, record)
    toast.success("Collection calendar updated", { description: `${record.name} was updated.` })
    setEditingCalendar(null)
  }

  return (
    <AssetPanelShell
      heading="Operations"
      title="Collection calendars"
      description={calendarsModule.description}
      action={
        <Button size="sm" onClick={() => setIsCreateOpen(true)}>
          <Plus className="h-4 w-4" weight="bold" />
          {calendarsModule.primaryAction}
        </Button>
      }
      toolbar={
        <AssetToolbar
          searchPlaceholder="Search collection calendars"
          query={query}
          onQueryChange={setQuery}
          statuses={statuses}
          onStatusesChange={setStatuses}
          statusOptions={statusOptions}
          extraFilters={[
            {
              label: "Project",
              options: projectOptions,
              value: projects,
              onChange: setProjects,
            },
          ]}
          view={view}
          onViewChange={setView}
        />
      }
    >
      <RecordsSection shown={filtered.length} total={calendarRecords.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[1080px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Name</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Working days</TableHead>
                <TableHead>Holidays</TableHead>
                <TableHead>Validity</TableHead>
                <TableHead>Next holiday</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <EmptyRow colSpan={8} message="No collection calendars match this search." />
              ) : (
                pageRows.map((row) => (
                  <TableRow key={row.record.id}>
                    <TableCell className="min-w-[220px]">
                      <p className="text-sm font-medium text-foreground">{row.record.name}</p>
                      {view.showDetails && (
                        <p className="text-xs text-muted-foreground">{row.record.context}</p>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {row.project}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {row.workingDays}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {row.holidays}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {row.validity}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {row.nextHoliday}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11px] font-medium",
                          statusClasses(row.record.status),
                        )}
                      >
                        {row.record.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setEditingCalendar(row.record)}
                        aria-label={`Edit ${row.record.name}`}
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
      {editingCalendar && (
        <BusinessRecordFormDialog
          schema={editSchema}
          open
          onOpenChange={(open) => {
            if (!open) setEditingCalendar(null)
          }}
          onSubmit={handleEdit}
          relationOptions={relationOptions}
          initialValueOverrides={collectionCalendarFormValues(editingCalendar)}
        />
      )}
    </AssetPanelShell>
  )
}

/** "Mon–Fri" for a Saturday–Sunday weekend, via the shared formatter. */
function workingDaysLabel(weekend: readonly string[]): string {
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const
  const working = days.filter((day) => !weekend.includes(day))
  const short: Record<(typeof days)[number], string> = {
    monday: "Mon",
    tuesday: "Tue",
    wednesday: "Wed",
    thursday: "Thu",
    friday: "Fri",
    saturday: "Sat",
    sunday: "Sun",
  }
  if (working.length === 0) return "—"
  // Consecutive runs read as ranges ("Mon–Fri"), gaps as lists.
  const first = working[0]
  const last = working[working.length - 1]
  const contiguous = days.indexOf(last) - days.indexOf(first) === working.length - 1
  return contiguous && working.length > 2
    ? `${short[first]}–${short[last]}`
    : working.map((day) => short[day]).join(", ")
}
