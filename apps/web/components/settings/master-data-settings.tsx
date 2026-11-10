"use client"
// Settings › Operations › Master data (Issue #176, slice 2 of #81): the
// company's own catalogue vocabulary — waste fractions, container types,
// service frequencies, vehicle types, contaminant codes and decommission
// reasons — as the `configure.master` module's
// records, one kind per tab, created and edited from the pane's own forms
// (lib/data/master-data.ts) and written through the record store, which on
// the Pilot reaches the API through lib/api/records/master-data.ts. The pane
// exists for the Pilot: the prototype never had a surface for the module,
// whose fixture records are coarse master-data sets, so where no API is
// configured the pane says its subject is kept on the API (`keptOnApi`).
import { useMemo, useState } from "react"
import { PencilSimple, Plus } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { ORGANISATION_MODULE } from "@/lib/data/containers"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/settings-pane-kit"
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { SettingsPaneProps } from "@/lib/modules/settings-panes"
import { useLinkedRecord } from "@/components/settings/use-linked-record"
import { BusinessRecordFormDialog } from "@/components/platform/business-record-form-dialog"
import { useActorName } from "@/components/platform/shell-identity"
import { densityClass, detailsColumn, listView, RECENT_ORDERS, RecordToolbar, sortByView } from "@/components/platform/record-toolbar"
import { type BusinessViewOptions } from "@/components/platform/business-view-options-popover"
import { cn } from "@/lib/utils"
import { type BusinessFilters, emptyBusinessFilters, type FilterValueReaders, matchesBusinessFilters, singleFilterValue } from "@/lib/prototype/business-filters"
import {
  useBusinessRecordStore,
  useBusinessRecordsHydrated,
  useModuleRecords,
  whenSaved,
} from "@/components/platform/business-record-store"
import type {
  BusinessFormField,
  BusinessFormOption,
  BusinessFormValues,
} from "@/lib/data/business-form-types"
import {
  type BusinessRecord,
} from "@/lib/data/business-modules"
import {
  MASTER_DATA_KIND_DETAILS,
  MASTER_DATA_KINDS,
  MASTER_DATA_MODULE,
  createMasterDataRecord,
  isMasterDataKind,
  masterDataEditSchema,
  masterDataFieldErrors,
  masterDataFormValues,
  masterDataKindOf,
  masterDataSchema,
  updateMasterDataRecord,
  type MasterDataKind,
  type MasterDataLookups,
} from "@/lib/data/master-data"
import { isSoftDeleted } from "@/lib/prototype/record-visibility"
import { moduleReadSentence } from "@/lib/api/read-state"

const STATUS_READERS: FilterValueReaders = { statuses: (record) => singleFilterValue(record.status) }

function detailOf(record: BusinessRecord, kind: MasterDataKind): string {
  switch (kind) {
    case "waste-fraction":
      return record.facts.Key ?? "—"
    case "container-type":
      return record.facts.Volume ?? "—"
    case "service-frequency":
      return record.facts.Cadence ?? "—"
    case "vehicle-type":
      return record.facts["Container types"] ?? "No container types"
    case "contaminant-code":
      return record.facts.Status === "Retired" ? `${record.facts.Fractions ?? "Every fraction"} · Retired` : (record.facts.Fractions ?? "Every fraction")
    case "decommission-reason":
      return record.facts.Status === "Retired" ? `${record.facts.Code ?? "—"} · Retired` : (record.facts.Code ?? "—")
  }
}

export function MasterDataSettings({ params }: SettingsPaneProps) {
  const { upsertRecord } = useBusinessRecordStore()
  const actorName = useActorName()
  const hydrated = useBusinessRecordsHydrated()
  const [kind, setKind] = useState<MasterDataKind>(isMasterDataKind(params.kind) ? params.kind : "waste-fraction")
  const [query, setQuery] = useState("")
  const [filters, setFilters] = useState<BusinessFilters>(emptyBusinessFilters)
  const [view, setView] = useState<BusinessViewOptions>(() => listView("updated"))
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [editing, setEditing] = useState<BusinessRecord | null>(null)
  const [saving, setSaving] = useState(false)

  // The module and the projects its frequencies name: on the Pilot, the API's
  // rows once they are here and nothing before.
  const master = useModuleRecords(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId)
  const organisation = useModuleRecords(ORGANISATION_MODULE.workspaceId, ORGANISATION_MODULE.moduleId)
  const rows = master.records.filter((record) => !isSoftDeleted(record))
  const projectRecords = organisation.records.filter(
    (record) => !isSoftDeleted(record) && record.id.startsWith("project-"),
  )
  const containerTypes = rows.filter((record) => masterDataKindOf(record) === "container-type")
  const wasteFractions = rows.filter((record) => masterDataKindOf(record) === "waste-fraction")

  const lookups: MasterDataLookups = {
    projectName: (projectId) => projectRecords.find((record) => record.id === projectId)?.name,
    containerTypeName: (containerTypeId) => containerTypes.find((record) => record.id === containerTypeId)?.name,
    wasteFractionName: (wasteFractionId) => wasteFractions.find((record) => record.id === wasteFractionId)?.name,
  }

  const relationOptions = (field: BusinessFormField): readonly BusinessFormOption[] => {
    if (field.id === "projectId") return projectRecords.map((record) => ({ value: record.id, label: record.name }))
    if (field.id === "containerTypeIds") return containerTypes.map((record) => ({ value: record.id, label: record.name }))
    if (field.id === "wasteFractionIds") return wasteFractions.map((record) => ({ value: record.id, label: record.name }))
    return field.options ?? []
  }

  const details = MASTER_DATA_KIND_DETAILS[kind]
  const createSchema = useMemo(() => masterDataSchema(kind), [kind])
  const editKind = editing === null ? null : masterDataKindOf(editing)
  const editSchema = useMemo(() => (editKind === null ? null : masterDataEditSchema(editKind)), [editKind])
  const editValues = useMemo(() => (editing === null ? undefined : masterDataFormValues(editing)), [editing])

  // A link to a kind switches the tab, on arrival and on a later link, since the pane stays mounted.
  const [kindLinked, setKindLinked] = useState(params.kind)
  if (params.kind !== kindLinked) {
    setKindLinked(params.kind)
    if (isMasterDataKind(params.kind)) setKind(params.kind)
  }

  useLinkedRecord(params.record, rows, hydrated && master.ready, (record) => {
    const recordKind = masterDataKindOf(record)
    if (recordKind !== null) setKind(recordKind)
    setEditing(record)
  })

  const ofKind = rows.filter((record) => masterDataKindOf(record) === kind)
  const shown = ofKind.map((record) => ({
    record,
    detail: detailOf(record, kind),
    scope: kind === "service-frequency" ? (record.facts.Project ?? "—") : "Company",
  }))
  const needle = query.trim().toLowerCase()
  const filtered = sortByView(
    shown
      .filter(({ record, detail, scope }) => [record.name, record.context, detail, scope, record.facts["Waste code"] ?? ""].join(" ").toLowerCase().includes(needle))
      .filter(({ record }) => matchesBusinessFilters(record, filters, STATUS_READERS)),
    view,
    ({ record }) => record.name,
    // Records carry a fuzzy "updated" label, not a sortable timestamp — the
    // "Last updated" ordering keeps the store's order instead of inventing one.
    () => "",
  )
  const { page, setPage, pageCount, pageRows, totalCount } = useTablePagination(filtered)

  const changeKind = (value: string) => {
    if (!isMasterDataKind(value)) return
    setKind(value)
    setQuery("")
    setPage(1)
  }

  const handleCreate = (values: BusinessFormValues) => {
    if (saving) return
    const record = createMasterDataRecord(kind, values, { now: Date.now(), actorName, lookups })
    setSaving(true)
    whenSaved(
      upsertRecord(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId, record),
      () => {
        setIsCreateOpen(false)
        toast.success(`${details.label} created`, {
          description: `${record.name} is offered to every module that picks from the ${details.plural.toLowerCase()}.`,
        })
      },
      () => setSaving(false),
    )
  }

  const handleEdit = (values: BusinessFormValues) => {
    if (saving || editing === null || editKind === null) return
    const record = updateMasterDataRecord(editing, values, lookups)
    const label = MASTER_DATA_KIND_DETAILS[editKind].label
    setSaving(true)
    whenSaved(
      upsertRecord(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId, record),
      () => {
        setEditing(null)
        toast.success(`${label} updated`, { description: `${record.name} was updated.` })
      },
      () => setSaving(false),
    )
  }

  // A frequency names a project, so its create waits for the projects too; the other kinds need only their own module.
  const canCreate = master.ready && !saving && (kind !== "service-frequency" || organisation.ready)

  const emptyMessage = moduleReadSentence(master, "master data", { is: true }) ?? (ofKind.length === 0 ? `No ${details.plural.toLowerCase()} yet.` : `No ${details.plural.toLowerCase()} match this search.`)
  // Nothing was read for a role that does not view the module: the store's sentence says why, beneath.
  const emptyHint = master.notGranted ? master.problem?.detail : undefined

  return (
    <AssetPanelShell
      tabs={
        <Tabs value={kind} onValueChange={changeKind}>
          <TabsList>
            {MASTER_DATA_KINDS.map((option) => (
              <TabsTrigger key={option} value={option}>
                {MASTER_DATA_KIND_DETAILS[option].plural}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      }
      toolbar={
        <RecordToolbar
          placeholder={`Search ${details.plural.toLowerCase()}`}
          query={query}
          onQueryChange={setQuery}
          records={shown.map(({ record }) => record)}
          readers={STATUS_READERS}
          filters={filters}
          onFiltersChange={setFilters}
          view={{
            value: view,
            onChange: setView,
            orderingOptions: RECENT_ORDERS,
            defaults: listView("updated"),
            builtinColumnChips: detailsColumn("Details"),
          }}
        />
      }
    >
      <RecordsSection
        shown={filtered.length}
        total={ofKind.length}
        actions={
          <Button size="sm" onClick={() => setIsCreateOpen(true)} disabled={!canCreate}>
            <Plus className="h-4 w-4" weight="bold" />
            New {details.label.toLowerCase()}
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <Table className={cn("min-w-[880px]", densityClass(view))}>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Name</TableHead>
                <TableHead>{kind === "waste-fraction" ? "Key" : kind === "container-type" ? "Volume" : kind === "service-frequency" ? "Cadence" : kind === "contaminant-code" ? "Fractions" : kind === "decommission-reason" ? "Code" : "Container types"}</TableHead>
                {kind === "waste-fraction" && <TableHead>Waste code</TableHead>}
                <TableHead>Scope</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <EmptyRow colSpan={kind === "waste-fraction" ? 6 : 5} message={emptyMessage} hint={emptyHint} narrowed={ofKind.length > 0} />
              ) : (
                pageRows.map(({ record, detail, scope }) => (
                  <TableRow key={record.id}>
                    <TableCell className="min-w-[220px]">
                      <p className="text-sm font-medium text-foreground">{record.name}</p>
                      {view.showDescription && (
                        <p className="text-xs text-muted-foreground">{record.facts.Description ?? record.context}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{detail}</TableCell>
                    {kind === "waste-fraction" && (
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        <span className="font-mono">{record.facts["Waste code"] ?? "—"}</span>
                        {record.facts.Hazardous === "Yes" && <span className="ml-2 font-medium text-destructive">Hazardous</span>}
                      </TableCell>
                    )}
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{scope}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{record.updated}</TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setEditing(record)}
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
        schema={createSchema}
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        onSubmit={handleCreate}
        relationOptions={relationOptions}
        validateValues={(values) => masterDataFieldErrors(kind, values)}
      />
      {editing && editSchema && (
        <BusinessRecordFormDialog
          schema={editSchema}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          onSubmit={handleEdit}
          relationOptions={relationOptions}
          initialValueOverrides={editValues}
          validateValues={(values) => masterDataFieldErrors(editKind ?? kind, values)}
        />
      )}
    </AssetPanelShell>
  )
}
