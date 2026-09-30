"use client"
// Settings › Operations › Master data (Issue #176, slice 2 of #81): the
// company's own catalogue vocabulary — waste fractions, container types,
// service frequencies, vehicle types — as the `configure.master` module's
// records, one kind per tab, created and edited from the pane's own forms
// (lib/data/master-data.ts) and written through the record store, which on
// the Pilot reaches the API through lib/api/records/master-data.ts. The pane
// exists for the Pilot: the prototype never had a surface for the module,
// whose fixture records are coarse master-data sets, so the Settings nav
// offers it only with the adapter configured.
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
import { useApiConfigured } from "@/components/waste/api-session-store"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import {
  useBusinessRecordStore,
  useBusinessRecordsHydrated,
  useModuleRecords,
  whenSaved,
} from "@/components/waste/business-record-store"
import type {
  BusinessFormField,
  BusinessFormOption,
  BusinessFormValues,
} from "@/lib/data/business-form-types"
import { MASTER_DATA_KIND_PARAM } from "@/lib/data/business-links"
import {
  getModuleDefinition,
  type BusinessRecord,
  type ModuleLocation,
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
import { isSoftDeleted } from "@waste/domain/record-visibility"

const ACTOR_NAME = "Olivia Larsen"
/** Where the project records live — what a service frequency names. */
const ORGANISATION_MODULE: ModuleLocation = { workspaceId: "configure", moduleId: "organization" }
const NO_RECORDS: readonly BusinessRecord[] = []
const MASTER_FIXTURES = getModuleDefinition(MASTER_DATA_MODULE)?.records ?? NO_RECORDS
const ORGANISATION_FIXTURES = getModuleDefinition(ORGANISATION_MODULE)?.records ?? NO_RECORDS
const STATUS_OPTIONS = ["Effective"] as const

/** What the table's detail column says of a row: the fact its kind is known by. */
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
  }
}

export function MasterDataSettings() {
  const { upsertRecord } = useBusinessRecordStore()
  const hydrated = useBusinessRecordsHydrated()
  const searchParams = useSearchParams()
  const requestedKind = searchParams.get(MASTER_DATA_KIND_PARAM)
  const requestedRecordId = searchParams.get("record")
  const [kind, setKind] = useState<MasterDataKind>(isMasterDataKind(requestedKind) ? requestedKind : "waste-fraction")
  const [query, setQuery] = useState("")
  const [statuses, setStatuses] = useState<string[]>([])
  const [view, setView] = useState<AssetView>(defaultAssetView)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [editing, setEditing] = useState<BusinessRecord | null>(null)
  // A write in flight: the form holds against a second submit until the API has answered.
  const [saving, setSaving] = useState(false)

  // The pane reads the API alone: off the Pilot it lists nothing and creates
  // nothing, since the prototype never kept rows of these kinds.
  const configured = useApiConfigured()
  // The module and the projects its frequencies name: on the Pilot, the API's
  // rows once they are here and nothing before.
  const master = useModuleRecords(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId, MASTER_FIXTURES)
  const organisation = useModuleRecords(ORGANISATION_MODULE.workspaceId, ORGANISATION_MODULE.moduleId, ORGANISATION_FIXTURES)
  const rows = master.records.filter((record) => !isSoftDeleted(record))
  const projectRecords = organisation.records.filter(
    (record) => !isSoftDeleted(record) && record.id.startsWith("project-"),
  )
  const containerTypes = rows.filter((record) => masterDataKindOf(record) === "container-type")

  const lookups: MasterDataLookups = {
    projectName: (projectId) => projectRecords.find((record) => record.id === projectId)?.name,
    containerTypeName: (containerTypeId) => containerTypes.find((record) => record.id === containerTypeId)?.name,
  }

  const relationOptions = (field: BusinessFormField): readonly BusinessFormOption[] => {
    if (field.id === "projectId") return projectRecords.map((record) => ({ value: record.id, label: record.name }))
    if (field.id === "containerTypeIds") return containerTypes.map((record) => ({ value: record.id, label: record.name }))
    return field.options ?? []
  }

  const details = MASTER_DATA_KIND_DETAILS[kind]
  const createSchema = useMemo(() => masterDataSchema(kind), [kind])
  const editKind = editing === null ? null : masterDataKindOf(editing)
  const editSchema = useMemo(() => (editKind === null ? null : masterDataEditSchema(editKind)), [editKind])
  const editValues = useMemo(() => (editing === null ? undefined : masterDataFormValues(editing)), [editing])

  // A link to a kind (/settings?pane=master-data&kind=…) switches the tab, on
  // arrival and on a later link, since the route stays mounted.
  useEffect(() => {
    if (isMasterDataKind(requestedKind)) setKind(requestedKind)
  }, [requestedKind])

  // A deep link (/settings?pane=master-data&record=…) opens that row for
  // editing on its own tab — once the store has loaded and, on the Pilot,
  // once the module's rows are here. Later edits keep their own state, so the
  // records list is deliberately not a dependency.
  useEffect(() => {
    if (!hydrated || !master.ready || !requestedRecordId) return
    const record = rows.find((candidate) => candidate.id === requestedRecordId)
    if (!record) return
    const recordKind = masterDataKindOf(record)
    if (recordKind !== null) setKind(recordKind)
    setEditing(record)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, master.ready, requestedRecordId])

  const ofKind = rows.filter((record) => masterDataKindOf(record) === kind)
  const shown = ofKind.map((record) => ({
    record,
    detail: detailOf(record, kind),
    scope: kind === "service-frequency" ? (record.facts.Project ?? "—") : "Company",
  }))
  const needle = query.trim().toLowerCase()
  const filtered = sortByView(
    shown
      .filter(({ record, detail, scope }) => [record.name, record.context, detail, scope].join(" ").toLowerCase().includes(needle))
      .filter(({ record }) => statuses.length === 0 || statuses.includes(record.status)),
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
    const record = createMasterDataRecord(kind, values, { now: Date.now(), actorName: ACTOR_NAME, lookups })
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
  const canCreate = configured && master.ready && !saving && (kind !== "service-frequency" || organisation.ready)

  const emptyMessage = !configured
    ? "The master data is kept on the API: sign in on the Pilot to read and write it."
    : master.pending
      ? "Reading the master data from the API…"
      : master.notGranted
        ? "The master data is not shown to your role."
        : master.problem
          ? `The master data could not be read from the API: ${master.problem.detail ?? master.problem.title}`
          : ofKind.length === 0
            ? `No ${details.plural.toLowerCase()} yet.`
            : `No ${details.plural.toLowerCase()} match this search.`
  // Nothing was read for a role that does not view the module: the store's sentence says why, beneath.
  const emptyHint = master.notGranted ? master.problem?.detail : undefined

  return (
    <AssetPanelShell
      heading="Operations"
      title="Master data"
      description="The company's own vocabulary: the waste fractions it collects, the container types it owns, the service frequencies each project offers, and the vehicle types with the container types they service. Products, containers, the fleet and route schemes name these rows."
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
      action={
        <Button size="sm" onClick={() => setIsCreateOpen(true)} disabled={!canCreate}>
          <Plus className="h-4 w-4" weight="bold" />
          New {details.label.toLowerCase()}
        </Button>
      }
      toolbar={
        <AssetToolbar
          searchPlaceholder={`Search ${details.plural.toLowerCase()}`}
          query={query}
          onQueryChange={setQuery}
          statuses={statuses}
          onStatusesChange={setStatuses}
          statusOptions={STATUS_OPTIONS}
          view={view}
          onViewChange={setView}
        />
      }
    >
      <RecordsSection shown={filtered.length} total={ofKind.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[880px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Name</TableHead>
                <TableHead>{kind === "waste-fraction" ? "Key" : kind === "container-type" ? "Volume" : kind === "service-frequency" ? "Cadence" : "Container types"}</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <EmptyRow colSpan={5} message={emptyMessage} hint={emptyHint} />
              ) : (
                pageRows.map(({ record, detail, scope }) => (
                  <TableRow key={record.id}>
                    <TableCell className="min-w-[220px]">
                      <p className="text-sm font-medium text-foreground">{record.name}</p>
                      {view.showDetails && (
                        <p className="text-xs text-muted-foreground">{record.facts.Description ?? record.context}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{detail}</TableCell>
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
