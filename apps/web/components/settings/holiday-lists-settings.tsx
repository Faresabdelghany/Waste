"use client"

// Settings › Operations › Holiday lists (2026-11-05): the company's holiday
// lists, one per country, laid out as the Routes page is (2026-11-06): the
// toolbar's search, Filter and View, then a table under its count, Export and
// "Add country", which opens a form for the country and the list's name, the
// company's own country offered first. A row opens its list as a page of its
// own, as a route opens: the breadcrumbs back, one Actions menu, and a table
// of the list's holidays — searched and filtered by year, each with Edit and
// Remove, a form to add one by date and name, and "Copy to next year", which
// places next year's from this year's. The pane no longer sets which list a
// project rests on or its weekend (2026-11-06); a project keeps what it has.
// The record writes are
// lib/data/holiday-lists.ts's; on the Pilot the lists are the API's
// (`/holiday-lists`, lib/api/records/holiday-lists.ts) and a project's list
// is a key into them, so a rename follows to its projects.

import { Fragment, useMemo, useState, type ReactNode } from "react"
import {
  ArrowSquareOut,
  CalendarPlus,
  CaretDown,
  Check,
  CopySimple,
  DownloadSimple,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Trash,
  X,
} from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { ORGANISATION_MODULE } from "@/lib/data/containers"
import { RecordPageHeader, TableCard } from "@/components/page-layout"
import { AssetPanelShell } from "@/components/settings/settings-pane-kit"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TablePagination, useTablePagination } from "@/components/ui/table-pagination"
import { savedRow, useBusinessRecordStore, useModuleRecords, whenSaved } from "@/components/platform/business-record-store"
import { RecordActionsMenu } from "@/components/platform/business-record-views"
import {
  defaultBusinessViewOptions,
  type BusinessColumnChip,
  type BusinessGroupOption,
  type BusinessOrderingOption,
  type BusinessViewOptions,
} from "@/components/platform/business-view-options-popover"
import { useActorName } from "@/components/platform/shell-identity"
import { RecordToolbar } from "@/components/platform/record-toolbar"
import { removeHolidayList } from "@/lib/api/records/holiday-lists"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { COLLECTION_CALENDARS_MODULE } from "@/lib/data/collection-calendars"
import { COUNTRY_CODES, countryName, suggestedHolidayListName } from "@/lib/data/countries"
import { csvFileName, downloadCsv } from "@/lib/data/csv"
import {
  HOLIDAY_LIST_OPTIONAL_COLUMNS,
  HOLIDAY_LIST_STATUSES,
  createHolidayListRecord,
  holidayListEntryIssue,
  holidayListRowMatches,
  holidayListRows,
  holidayListsCsv,
  nextYearEntries,
  orderHolidayListRows,
  shownHolidayName,
  withHolidayListDraft,
  withHolidayListEntries,
  type HolidayListDraft,
  type HolidayListRow,
  type HolidayListStatus,
} from "@/lib/data/holiday-lists"
import { projectRecordsOf } from "@/lib/data/project-scope"
import {
  businessFilterChips,
  emptyBusinessFilters,
  matchesBusinessFilters,
  singleFilterValue,
  type BusinessFilters,
  type FilterValueReaders,
} from "@/lib/prototype/business-filters"
import { isSoftDeleted } from "@/lib/prototype/record-visibility"
import { typedString } from "@/lib/prototype/record-values"
import { holidayListCountry, holidayListEntries, holidayListName, holidayListYears, isHolidayListRecord } from "@/lib/prototype/route-schemes/holiday-list-records"
import { knownHolidaysOfYear, type HolidayEntry } from "@/lib/prototype/route-schemes/holiday-lists"
import { holidayNamesForCountry, knownHolidayListName } from "@waste/domain/planning/holiday-names"
import { projectHolidayListName } from "@/lib/prototype/route-schemes/project-calendar"
import { todayIso } from "@waste/domain/planning/recurrence"
import { formatShortDay, isIsoDate } from "@waste/domain/days"
import { count } from "@waste/domain/text"
import { NARROWED_HINT } from "@/lib/table-copy"
import { cn } from "@/lib/utils"
import { moduleReadSentence } from "@/lib/api/read-state"

/** The year filter's value for every year. */
const ALL_YEARS = "all"

/* ------------------------------ The table's view ------------------------------ */

/** The View popover's starting point, and what its Reset returns to: every column, by list name, ungrouped. */
const HOLIDAY_LIST_VIEW_DEFAULTS: BusinessViewOptions = {
  ...defaultBusinessViewOptions,
  ordering: "name",
  factColumns: [...HOLIDAY_LIST_OPTIONAL_COLUMNS],
  showDescription: true,
  showContext: true,
}
/** A list reads no update time, so the table orders by name or by status alone. */
const ORDERING_OPTIONS: readonly BusinessOrderingOption[] = [
  { value: "name", label: "Name" },
  { value: "status", label: "Status" },
]
const GROUP_OPTIONS: readonly BusinessGroupOption[] = [
  { value: "none", label: "None" },
  { value: "status", label: "Status" },
]
/** `showContext` is the row's country, as it is a route's project. */
const BUILTIN_COLUMNS: readonly BusinessColumnChip[] = [
  { key: "showDescription", label: "Description" },
  { key: "showContext", label: "Country" },
]
const FIXED_COLUMNS = ["Holiday list", "Status"]

const STATUS_TONES: Readonly<Record<HolidayListStatus, StatusTone>> = { "In use": "success", "Not in use": "neutral" }

function HolidayListStatusBadge({ status }: { status: HolidayListStatus }) {
  return (
    <StatusBadge tone={STATUS_TONES[status]} className="whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium">
      {status}
    </StatusBadge>
  )
}

/** "2 holiday lists", or "1 of 2 holiday lists" under a search or a filter. */
function shownCount(shown: number, total: number, noun: string): string {
  return shown === total ? count(total, noun) : `${shown} of ${count(total, noun)}`
}

type ListDialogState = { mode: "create"; country?: string } | { mode: "edit"; record: BusinessRecord }

export function HolidayListsSettings() {
  const { upsertRecord, sendAction, refreshModule } = useBusinessRecordStore()
  const actorName = useActorName()
  const [openListId, setOpenListId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<ListDialogState | null>(null)

  // On the Pilot, the API's rows once they are here and nothing before (Issue #175).
  const organisation = useModuleRecords(ORGANISATION_MODULE.workspaceId, ORGANISATION_MODULE.moduleId)
  const calendars = useModuleRecords(COLLECTION_CALENDARS_MODULE.workspaceId, COLLECTION_CALENDARS_MODULE.moduleId)
  const ready = organisation.ready && calendars.ready
  const organisationRecords = organisation.records.filter((record) => !isSoftDeleted(record))
  const projects = projectRecordsOf(organisationRecords)
  const company = organisationRecords.find((record) => record.id.startsWith("company-") || record.recordKind === "Company")
  const companyCountry = typedString(company?.submittedValues, "country")
  const lists = calendars.records
    .filter((record) => isHolidayListRecord(record) && !isSoftDeleted(record))
    .sort((a, b) => countryName(holidayListCountry(a) ?? "").localeCompare(countryName(holidayListCountry(b) ?? "")))
  const openList = lists.find((record) => record.id === openListId)
  const projectsOn = (list: BusinessRecord) => projects.filter((project) => projectHolidayListName(project) === holidayListName(list))

  const saveList = (record: BusinessRecord, said: string, done?: (row: BusinessRecord) => void) => {
    whenSaved(upsertRecord(COLLECTION_CALENDARS_MODULE.workspaceId, COLLECTION_CALENDARS_MODULE.moduleId, record), (saved) => {
      toast.success(said)
      done?.(savedRow(saved, record))
    })
  }

  const submitListDialog = (draft: HolidayListDraft, startWith: readonly HolidayEntry[]) => {
    if (!dialog) return
    if (dialog.mode === "create") {
      const record = createHolidayListRecord(draft, startWith, { actorName })
      saveList(record, `${record.name} added`, (row) => {
        setDialog(null)
        setOpenListId(row.id)
      })
      return
    }
    const before = dialog.record
    const oldName = holidayListName(before)
    saveList(withHolidayListDraft(before, draft), `${draft.name.trim()} updated`, () => {
      setDialog(null)
      if (oldName === draft.name.trim()) return
      // A rename follows to the projects on the list through the API's key, which the projects are read again for.
      void refreshModule(ORGANISATION_MODULE.workspaceId, ORGANISATION_MODULE.moduleId)
    })
  }

  const removeList = (record: BusinessRecord) => {
    const resting = projectsOn(record)
    if (resting.length > 0) {
      toast.error(`${record.name} is in use`, { description: `${count(resting.length, "project")} rest on it: move ${resting.length === 1 ? "it" : "them"} to another list first.` })
      return
    }
    void removeHolidayList(sendAction, record.id).then((outcome) => {
      if (outcome.kind !== "done") return
      toast.success(`${record.name} removed`)
      setOpenListId(null)
      void refreshModule(COLLECTION_CALENDARS_MODULE.workspaceId, COLLECTION_CALENDARS_MODULE.moduleId)
    })
  }

  // The module whose problem the pane says, the projects first.
  const blocked = organisation.problem !== null ? organisation : calendars
  const notReadyMessage = moduleReadSentence({ pending: organisation.pending || calendars.pending, notGranted: blocked.notGranted, problem: blocked.problem }, "holiday lists")
  const notReadyHint = blocked.notGranted ? blocked.problem?.detail : undefined
  const listedCountries = new Set(lists.map((record) => holidayListCountry(record) ?? ""))

  const listDialog = dialog && (
    <HolidayListDialog
      state={dialog}
      companyCountry={companyCountry}
      takenCountries={listedCountries}
      takenNames={new Set(lists.map(holidayListName))}
      onOpenChange={(open) => {
        if (!open) setDialog(null)
      }}
      onSubmit={submitListDialog}
    />
  )

  if (ready && !notReadyMessage && openList) {
    return (
      <>
        <HolidayListPage
          key={openList.id}
          record={openList}
          projects={projectsOn(openList)}
          onBack={() => setOpenListId(null)}
          onEdit={() => setDialog({ mode: "edit", record: openList })}
          onRemove={() => removeList(openList)}
          onSaveEntries={(entries, said) => saveList(withHolidayListEntries(openList, entries), said)}
        />
        {listDialog}
      </>
    )
  }

  return (
    <>
      <HolidayListsIndex
        ready={ready && !notReadyMessage}
        notReady={
          <p className="rounded-xl border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
            {notReadyMessage ?? "Reading the holiday lists…"}
            {notReadyHint === undefined ? null : <span className="mt-1 block text-xs">{notReadyHint}</span>}
          </p>
        }
        lists={lists}
        companyCountry={companyCountry !== undefined && !listedCountries.has(companyCountry) ? companyCountry : undefined}
        projectCount={(list) => projectsOn(list).length}
        onOpen={(list) => setOpenListId(list.id)}
        onCreate={(country) => setDialog({ mode: "create", country })}
        onEdit={(list) => setDialog({ mode: "edit", record: list })}
        onRemove={removeList}
      />
      {listDialog}
    </>
  )
}

/* ------------------------------ The lists, as the Routes page ------------------------------ */

function HolidayListsIndex({
  ready,
  notReady,
  lists,
  companyCountry,
  projectCount,
  onOpen,
  onCreate,
  onEdit,
  onRemove,
}: {
  ready: boolean
  notReady: ReactNode
  lists: readonly BusinessRecord[]
  /** The company's own country, where it has no list yet: offered first, as a row to set up. */
  companyCountry: string | undefined
  projectCount: (list: BusinessRecord) => number
  onOpen: (list: BusinessRecord) => void
  onCreate: (country?: string) => void
  onEdit: (list: BusinessRecord) => void
  onRemove: (list: BusinessRecord) => void
}) {
  const [query, setQuery] = useState("")
  const [filters, setFilters] = useState<BusinessFilters>(emptyBusinessFilters)
  const [view, setView] = useState<BusinessViewOptions>(HOLIDAY_LIST_VIEW_DEFAULTS)

  const rows = holidayListRows(lists, projectCount, todayIso())
  const rowsById = new Map(rows.map((row) => [row.record.id, row]))
  // The Filter's options and the rows it keeps read the same functions.
  const readers: FilterValueReaders = {
    statuses: (record) => singleFilterValue(rowsById.get(record.id)?.status),
    collectionCalendars: (record) => singleFilterValue(rowsById.get(record.id)?.name),
  }
  const narrowed = query.trim() !== "" || businessFilterChips(filters).length > 0
  const shownRows = orderHolidayListRows(
    rows.filter((row) => matchesBusinessFilters(row.record, filters, readers) && holidayListRowMatches(row, query)),
    view.ordering,
  )
  const { page, setPage, pageCount, pageRows, totalCount } = useTablePagination(shownRows)
  const groups: { label: HolidayListStatus | null; rows: HolidayListRow[] }[] =
    view.groupBy === "status"
      ? HOLIDAY_LIST_STATUSES.map((status) => ({ label: status, rows: pageRows.filter((row) => row.status === status) })).filter((group) => group.rows.length > 0)
      : [{ label: null, rows: pageRows }]
  const columns = HOLIDAY_LIST_OPTIONAL_COLUMNS.filter((column) => view.factColumns.includes(column))
  const columnCount = 3 + (view.showContext ? 1 : 0) + columns.length
  const compact = view.density === "compact"

  const exportRows = () => {
    downloadCsv(
      csvFileName("Settings", "Holiday lists", todayIso()),
      holidayListsCsv(shownRows, { description: view.showDescription, country: view.showContext, columns }),
    )
    toast.success(`Exported ${count(shownRows.length, "row")}`, { description: "Holiday lists · the rows and columns shown" })
  }

  return (
    <AssetPanelShell
      toolbar={
        <RecordToolbar
          placeholder="Search holiday lists"
          query={query}
          onQueryChange={setQuery}
          records={lists}
          readers={readers}
          filters={filters}
          onFiltersChange={setFilters}
          view={{
            value: view,
            onChange: setView,
            orderingOptions: ORDERING_OPTIONS,
            defaults: HOLIDAY_LIST_VIEW_DEFAULTS,
            columnOptions: HOLIDAY_LIST_OPTIONAL_COLUMNS,
            groupOptions: GROUP_OPTIONS,
            builtinColumnChips: BUILTIN_COLUMNS,
            fixedColumnChips: FIXED_COLUMNS,
          }}
        />
      }
    >
      {!ready ? (
        notReady
      ) : (
        <div className="space-y-6">
          <TableCard
            testId="holiday-lists-table"
            summary={shownCount(shownRows.length, rows.length, "holiday list")}
            actions={
              <>
                <Button variant="ghost" size="sm" onClick={exportRows} disabled={shownRows.length === 0}>
                  <DownloadSimple className="h-4 w-4" />
                  <span className="hidden sm:inline">Export</span>
                </Button>
                <Button size="sm" onClick={() => onCreate()}>
                  <Plus className="h-4 w-4" weight="bold" />
                  Add country
                </Button>
              </>
            }
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead>Holiday list</TableHead>
                    {view.showContext && <TableHead>Country</TableHead>}
                    <TableHead>Status</TableHead>
                    {columns.map((column) => (
                      <TableHead key={column}>{column}</TableHead>
                    ))}
                    <TableHead className="w-10">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {companyCountry && !narrowed && (
                    <TableRow data-testid="holiday-list-company-country">
                      <TableCell className={cn("min-w-[240px]", compact && "py-2")}>
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-foreground">{countryName(companyCountry)}</p>
                          <p className="text-xs text-muted-foreground">The company&apos;s country has no holiday list yet.</p>
                        </div>
                      </TableCell>
                      <TableCell colSpan={columnCount - 2} />
                      <TableCell className="w-10 pr-3 text-right">
                        <Button size="sm" variant="outline" className="h-7" onClick={() => onCreate(companyCountry)}>
                          Set up
                        </Button>
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.length === 0 && !companyCountry ? (
                    <TableRow>
                      <TableCell colSpan={columnCount} className="h-40 text-center text-sm text-muted-foreground">
                        No holiday list yet. Add a country to start one.
                      </TableCell>
                    </TableRow>
                  ) : rows.length > 0 && shownRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={columnCount} className="h-52 text-center">
                        <div className="flex flex-col items-center gap-2">
                          <MagnifyingGlass className="h-6 w-6 text-muted-foreground" />
                          <p className="text-sm font-medium">No matching holiday lists</p>
                          <p className="text-xs text-muted-foreground">{NARROWED_HINT}</p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    groups.map((group) => (
                      <Fragment key={group.label ?? "all"}>
                        {group.label !== null && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell colSpan={columnCount} className="py-2">
                              <div className="flex items-center gap-2">
                                <HolidayListStatusBadge status={group.label} />
                                <span className="text-xs text-muted-foreground">{count(group.rows.length, "holiday list")}</span>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                        {group.rows.map((row) => (
                          <TableRow
                            key={row.record.id}
                            data-testid="holiday-list-row"
                            role="button"
                            tabIndex={0}
                            aria-label={`Open ${row.name}`}
                            className="cursor-pointer hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                            onClick={() => onOpen(row.record)}
                            onKeyDown={(event) => {
                              if (event.target !== event.currentTarget) return
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault()
                                onOpen(row.record)
                              }
                            }}
                          >
                            <TableCell className={cn("min-w-[200px]", compact && "py-2")}>
                              <div className="space-y-1">
                                <p className="text-sm font-medium text-foreground">{row.name}</p>
                                {view.showDescription && row.record.description && (
                                  <p className="max-w-[220px] truncate text-xs text-muted-foreground">{row.record.description}</p>
                                )}
                              </div>
                            </TableCell>
                            {view.showContext && <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{row.countryLabel}</TableCell>}
                            <TableCell>
                              <HolidayListStatusBadge status={row.status} />
                            </TableCell>
                            {columns.map((column) => (
                              <TableCell key={column} className={cn("whitespace-nowrap text-sm text-muted-foreground", column !== "Next holiday" && "tabular-nums")}>
                                {column === "Holidays" ? row.holidays : column === "Projects" ? row.projects : row.nextHoliday}
                              </TableCell>
                            ))}
                            <TableCell className="w-10 pr-3 text-right">
                              <RecordActionsMenu
                                record={row.record}
                                entityLabel="Holiday list"
                                extraActions={[{ label: "Open", icon: <ArrowSquareOut className="h-4 w-4" />, onSelect: onOpen }]}
                                onEdit={onEdit}
                                // A list a project rests on is not removed: the project moves first.
                                onDelete={row.projects === 0 ? onRemove : undefined}
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                      </Fragment>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            <TablePagination page={page} pageCount={pageCount} totalCount={totalCount} onPageChange={setPage} emptyLabel="No matching holiday lists" />
          </TableCard>
        </div>
      )}
    </AssetPanelShell>
  )
}

/* --------------------------- The add / edit dialog --------------------------- */

function HolidayListDialog({
  state,
  companyCountry,
  takenCountries,
  takenNames,
  onOpenChange,
  onSubmit,
}: {
  state: ListDialogState
  companyCountry: string | undefined
  takenCountries: ReadonlySet<string>
  takenNames: ReadonlySet<string>
  onOpenChange: (open: boolean) => void
  onSubmit: (draft: HolidayListDraft, startWith: readonly HolidayEntry[]) => void
}) {
  const editing = state.mode === "edit" ? state.record : undefined
  const ownCountry = editing ? holidayListCountry(editing) : undefined
  const ownName = editing ? holidayListName(editing) : undefined
  // The company's country first, where it is free; the dialog never offers a country already listed (the list's own excepted).
  const initialCountry = editing ? (ownCountry ?? "") : (state.mode === "create" ? state.country : undefined) ?? (companyCountry && !takenCountries.has(companyCountry) ? companyCountry : "")
  const [country, setCountry] = useState(initialCountry)
  const [name, setName] = useState(ownName ?? (initialCountry ? suggestedHolidayListName(initialCountry, knownHolidayListName) : ""))
  const [nameEdited, setNameEdited] = useState(editing !== undefined)
  const year = Number(todayIso().slice(0, 4))
  const known = country ? knownHolidaysOfYear(year, holidayNamesForCountry(country)) : []
  const [startWithKnown, setStartWithKnown] = useState(true)

  const options = useMemo(() => {
    const free = COUNTRY_CODES.filter((code) => code === ownCountry || !takenCountries.has(code)).sort((a, b) => countryName(a).localeCompare(countryName(b)))
    return companyCountry && free.includes(companyCountry) ? [companyCountry, ...free.filter((code) => code !== companyCountry)] : free
  }, [companyCountry, ownCountry, takenCountries])

  const trimmed = name.trim()
  const nameTaken = trimmed !== "" && trimmed !== ownName && takenNames.has(trimmed)
  const canSubmit = country !== "" && trimmed !== "" && !nameTaken

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit holiday list" : "Add country"}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSubmit) return
            onSubmit({ country, name: trimmed }, !editing && startWithKnown ? known : [])
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="holiday-list-country">Country</Label>
            <Select
              value={country}
              onValueChange={(code) => {
                setCountry(code)
                if (!nameEdited) setName(suggestedHolidayListName(code, knownHolidayListName))
              }}
            >
              <SelectTrigger id="holiday-list-country" aria-label="Country">
                <SelectValue placeholder="Pick a country" />
              </SelectTrigger>
              <SelectContent>
                {options.map((code) => (
                  <SelectItem key={code} value={code}>
                    {countryName(code)}
                    {code === companyCountry ? " · the company's country" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="holiday-list-name">List name</Label>
            <Input
              id="holiday-list-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setNameEdited(true)
              }}
              placeholder="Danish public holidays"
            />
            {nameTaken && <p className="text-xs text-destructive">The company already has a holiday list called {trimmed}.</p>}
          </div>
          {!editing && known.length > 0 && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={startWithKnown} onCheckedChange={(checked) => setStartWithKnown(checked === true)} className="mt-0.5" />
              <span>
                Start with the {count(known.length, "holiday")} of {year} this system knows for {countryName(country)}
              </span>
            </label>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {editing ? "Save" : "Add country"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------ One list's page, as a route's ------------------------------ */

const EMPTY_ENTRY: HolidayEntry = { date: "", name: "" }

function HolidayListPage({
  record,
  projects,
  onBack,
  onEdit,
  onRemove,
  onSaveEntries,
}: {
  record: BusinessRecord
  projects: readonly BusinessRecord[]
  onBack: () => void
  onEdit: () => void
  onRemove: () => void
  onSaveEntries: (entries: readonly HolidayEntry[], said: string) => void
}) {
  const name = holidayListName(record)
  const country = holidayListCountry(record)
  const entries = holidayListEntries(record)
  const years = holidayListYears(entries)
  const thisYear = Number(todayIso().slice(0, 4))
  const status: HolidayListStatus = projects.length > 0 ? "In use" : "Not in use"
  const [year, setYear] = useState<string>(() => (years.includes(thisYear) ? String(thisYear) : years[0] !== undefined ? String(years[0]) : ALL_YEARS))
  const [query, setQuery] = useState("")
  const [editingDate, setEditingDate] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<HolidayEntry>(EMPTY_ENTRY)
  const [addDraft, setAddDraft] = useState<HolidayEntry>(EMPTY_ENTRY)
  const [issue, setIssue] = useState<string | null>(null)

  const yearOptions = [...new Set([...years, thisYear])].sort((a, b) => b - a)
  const ofYear = year === ALL_YEARS ? entries : entries.filter((entry) => entry.date.startsWith(`${year}-`))
  const needle = query.trim().toLowerCase()
  const shown = needle === "" ? ofYear : ofYear.filter((entry) => [entry.date, formatShortDay(entry.date), shownHolidayName(entry, country)].join(" ").toLowerCase().includes(needle))
  const { page, setPage, pageCount, pageRows, totalCount } = useTablePagination(shown)
  const copied = year === ALL_YEARS ? [] : nextYearEntries(record, Number(year))
  const suggested = (date: string) => (isIsoDate(date) ? holidayNamesForCountry(country)(date) : undefined)

  const startEdit = (entry: HolidayEntry) => {
    setEditingDate(entry.date)
    setEditDraft(entry)
    setIssue(null)
  }
  const cancelEdit = () => {
    setEditingDate(null)
    setEditDraft(EMPTY_ENTRY)
    setIssue(null)
  }
  const commitEdit = () => {
    if (editingDate === null) return
    const problem = holidayListEntryIssue(entries, editDraft.date, editingDate)
    if (problem) return setIssue(problem)
    onSaveEntries(
      entries.map((entry) => (entry.date === editingDate ? editDraft : entry)),
      `${formatShortDay(editDraft.date)} updated`,
    )
    cancelEdit()
  }
  const add = () => {
    const problem = holidayListEntryIssue(entries, addDraft.date)
    if (problem) return setIssue(problem)
    const entry = { date: addDraft.date, name: addDraft.name.trim() || suggested(addDraft.date) || "" }
    onSaveEntries([...entries, entry], `${entry.name || "Holiday"} added on ${formatShortDay(entry.date)}`)
    setAddDraft(EMPTY_ENTRY)
    setIssue(null)
    // Show the year the holiday went into.
    if (year !== ALL_YEARS && !entry.date.startsWith(`${year}-`)) setYear(entry.date.slice(0, 4))
  }
  const remove = (entry: HolidayEntry) => {
    if (editingDate === entry.date) cancelEdit()
    onSaveEntries(
      entries.filter((candidate) => candidate.date !== entry.date),
      `${shownHolidayName(entry, country)} removed`,
    )
  }
  const copyToNextYear = () => {
    if (copied.length === 0) return
    onSaveEntries([...entries, ...copied], `${count(copied.length, "holiday")} added to ${Number(year) + 1}`)
    setYear(String(Number(year) + 1))
  }

  const emptyMessage =
    needle !== ""
      ? "No holiday matches the search."
      : year === ALL_YEARS
        ? "No holiday on this list yet. Add one above."
        : `No holiday in ${year} yet. Add one above${copied.length === 0 && entries.some((entry) => entry.date.startsWith(`${Number(year) - 1}-`)) ? `, or copy ${Number(year) - 1}'s from that year` : ""}.`

  return (
    <AssetPanelShell
      header={
        <RecordPageHeader
          backLabel="Back to holiday lists"
          onBack={onBack}
          name={name}
          badge={<HolidayListStatusBadge status={status} />}
          line={[country ? countryName(country) : "No country", count(entries.length, "holiday"), projects.length === 0 ? "No project rests on it" : `Used by ${projects.map((project) => project.name).join(", ")}`].join(" · ")}
          actions={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  Actions
                  <CaretDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuItem onSelect={onEdit}>
                  <PencilSimple className="h-4 w-4" />
                  Edit list
                </DropdownMenuItem>
                {year !== ALL_YEARS && (
                  <DropdownMenuItem onSelect={copyToNextYear} disabled={copied.length === 0}>
                    <CopySimple className="h-4 w-4" />
                    Copy {year} to {Number(year) + 1}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                {/* A list a project rests on is not removed: the project moves first. */}
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onRemove} disabled={projects.length > 0}>
                  <Trash className="h-4 w-4" />
                  Remove list
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
      }
      toolbar={
        <RecordToolbar placeholder="Search holidays" query={query} onQueryChange={setQuery}>
          <Select value={year} onValueChange={setYear}>
            <SelectTrigger className="h-8 w-36 rounded-lg border-border/60 text-sm" aria-label="Year">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_YEARS}>All years</SelectItem>
              {yearOptions.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </RecordToolbar>
      }
    >
      <TableCard
        testId={`holiday-list-${record.id}`}
        summary={`${shownCount(shown.length, ofYear.length, "holiday")}${year === ALL_YEARS ? "" : ` in ${year}`}`}
      >
        <form
          className="flex flex-wrap items-end gap-2 border-b border-border/60 bg-muted/20 px-4 py-3"
          data-testid="holiday-row-add"
          onSubmit={(event) => {
            event.preventDefault()
            add()
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="holiday-add-date">Date</Label>
            <Input id="holiday-add-date" type="date" value={addDraft.date} onChange={(event) => setAddDraft({ ...addDraft, date: event.target.value })} className="h-8 w-44" />
          </div>
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <Label htmlFor="holiday-add-name">Name</Label>
            <Input
              id="holiday-add-name"
              value={addDraft.name}
              placeholder={suggested(addDraft.date) ?? "Name of the holiday"}
              onChange={(event) => setAddDraft({ ...addDraft, name: event.target.value })}
              className="h-8"
            />
          </div>
          <Button type="submit" size="sm" className="h-8">
            <CalendarPlus className="h-4 w-4" />
            Add holiday
          </Button>
          {issue && (
            <p role="alert" className="basis-full text-xs text-destructive">
              {issue}
            </p>
          )}
        </form>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="w-44">Date</TableHead>
                <TableHead className="w-36">Day</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="w-24">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-40 text-center text-sm text-muted-foreground">
                    {emptyMessage}
                  </TableCell>
                </TableRow>
              ) : (
                pageRows.map((entry) =>
                  editingDate === entry.date ? (
                    <TableRow key={entry.date} data-testid="holiday-row-editing">
                      <TableCell>
                        <Input type="date" value={editDraft.date} aria-label="Holiday date" onChange={(event) => setEditDraft({ ...editDraft, date: event.target.value })} className="h-8" />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{isIsoDate(editDraft.date) ? formatShortDay(editDraft.date).slice(0, 3) : "—"}</TableCell>
                      <TableCell>
                        <Input
                          value={editDraft.name}
                          aria-label="Holiday name"
                          placeholder={suggested(editDraft.date) ?? "Holiday"}
                          onChange={(event) => setEditDraft({ ...editDraft, name: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault()
                              commitEdit()
                            }
                            if (event.key === "Escape") cancelEdit()
                          }}
                          className="h-8"
                        />
                      </TableCell>
                      <TableCell className="whitespace-nowrap pr-3 text-right">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={commitEdit} aria-label="Save holiday">
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={cancelEdit} aria-label="Cancel editing">
                          <X className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ) : (
                    <TableRow key={entry.date} data-testid="holiday-row">
                      <TableCell className="text-sm font-medium tabular-nums text-foreground">{entry.date}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatShortDay(entry.date)}</TableCell>
                      <TableCell className="text-sm">{entry.name ? entry.name : <span className="text-muted-foreground">{shownHolidayName(entry, country)}</span>}</TableCell>
                      <TableCell className="whitespace-nowrap pr-3 text-right">
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={() => startEdit(entry)} aria-label={`Edit ${entry.date}`}>
                          <PencilSimple className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={() => remove(entry)} aria-label={`Remove ${entry.date}`}>
                          <Trash className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ),
                )
              )}
            </TableBody>
          </Table>
        </div>
        <TablePagination page={page} pageCount={pageCount} totalCount={totalCount} onPageChange={setPage} emptyLabel="No holidays shown" />
      </TableCard>
    </AssetPanelShell>
  )
}
