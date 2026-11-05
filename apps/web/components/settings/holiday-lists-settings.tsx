"use client"

// Settings › Operations › Holiday lists (2026-11-05): the company's holiday
// lists, one per country, in a table. "Add country" opens a form for the
// country and the list's name, the company's own country offered first; a
// row opens its list, a table of the list's holidays — filtered by year, each
// with Edit and Remove, a form to add one by date and name, and "Copy to next
// year", which places next year's from this year's. Below the lists, every
// project picks the list it rests on and its weekend. The record writes are
// lib/data/holiday-lists.ts's; on the Pilot the lists are the API's
// (`/holiday-lists`, lib/api/records/holiday-lists.ts) and a project's list
// is a key into them, so a rename follows to its projects.

import { useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import { ArrowLeft, CalendarPlus, Check, CopySimple, PencilSimple, Plus, Trash, X } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { AssetPanelShell } from "@/components/settings/asset-management-settings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useApiConfigured } from "@/components/waste/api-session-store"
import { savedRow, useBusinessRecordStore, useBusinessRecordsHydrated, useModuleRecords, whenSaved } from "@/components/waste/business-record-store"
import { removeHolidayList } from "@/lib/api/records/holiday-lists"
import { HOLIDAY_LISTS_PROJECT_PARAM } from "@/lib/data/business-links"
import { getModuleDefinition, type BusinessRecord, type ModuleLocation } from "@/lib/data/business-modules"
import { COLLECTION_CALENDARS_MODULE } from "@/lib/data/collection-calendars"
import { COUNTRY_CODES, countryName, suggestedHolidayListName } from "@/lib/data/countries"
import {
  createHolidayListRecord,
  holidayListEntryIssue,
  nextYearEntries,
  withHolidayListDraft,
  withHolidayListEntries,
  withProjectCalendar,
  type HolidayListDraft,
  type ProjectCalendarSettings,
} from "@/lib/data/holiday-lists"
import { projectRecordsOf } from "@/lib/data/project-scope"
import { isSoftDeleted, softDeletedRecord } from "@waste/domain/record-visibility"
import { typedString } from "@waste/domain/record-values"
import { holidayListCountry, holidayListEntries, holidayListName, holidayListYears, isHolidayListRecord } from "@waste/domain/route-schemes/holiday-list-records"
import { knownHolidaysOfYear, type HolidayEntry } from "@waste/domain/route-schemes/holiday-lists"
import { holidayNamesForCountry, knownHolidayListName } from "@waste/domain/route-schemes/holiday-names"
import { NO_HOLIDAY_LIST_LABEL, projectHolidayListName, projectWeekend, weekendLabel } from "@waste/domain/route-schemes/project-calendar"
import { SERVICE_DAYS, SERVICE_DAY_LABELS, SERVICE_DAY_SHORT_LABELS, formatServiceDate, isIsoDate, todayIso, type ServiceDay } from "@waste/domain/route-schemes/recurrence"
import { count } from "@waste/domain/text"
import { cn } from "@/lib/utils"

const ACTOR_NAME = "Olivia Larsen"

/** Where the projects and the company live — the module resolveProjectCalendar reads a project's list name from. */
const ORGANISATION_MODULE: ModuleLocation = { workspaceId: "configure", moduleId: "organization" }
const NO_RECORDS: readonly BusinessRecord[] = []
const ORGANISATION_FIXTURES = getModuleDefinition(ORGANISATION_MODULE)?.records ?? NO_RECORDS
const CALENDAR_FIXTURES = getModuleDefinition(COLLECTION_CALENDARS_MODULE)?.records ?? NO_RECORDS

/** The project select's value for "no list". */
const NO_LIST = "__none__"
/** The year filter's value for every year. */
const ALL_YEARS = "all"

/** The next holiday on or after today, as the table shows it. */
function nextHoliday(entries: readonly HolidayEntry[], today: string): HolidayEntry | undefined {
  return entries.find((entry) => entry.date >= today)
}

/** The name a holiday reads as: its own, else what its country's known list calls the day, else "Holiday". */
const shownName = (entry: HolidayEntry, country: string | undefined) => entry.name || holidayNamesForCountry(country)(entry.date) || "Holiday"

type ListDialogState = { mode: "create"; country?: string } | { mode: "edit"; record: BusinessRecord }

export function HolidayListsSettings() {
  const { upsertRecord, sendAction, refreshModule } = useBusinessRecordStore()
  const hydrated = useBusinessRecordsHydrated()
  const onApi = useApiConfigured()
  const searchParams = useSearchParams()
  const requestedProjectId = searchParams.get(HOLIDAY_LISTS_PROJECT_PARAM)
  const [openListId, setOpenListId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<ListDialogState | null>(null)

  // On the Pilot, the API's rows once they are here and nothing before (Issue #175).
  const organisation = useModuleRecords(ORGANISATION_MODULE.workspaceId, ORGANISATION_MODULE.moduleId, ORGANISATION_FIXTURES)
  const calendars = useModuleRecords(COLLECTION_CALENDARS_MODULE.workspaceId, COLLECTION_CALENDARS_MODULE.moduleId, CALENDAR_FIXTURES)
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

  const saveProject = (project: BusinessRecord, settings: ProjectCalendarSettings, quiet = false) => {
    const written = withProjectCalendar(project, settings)
    whenSaved(upsertRecord(ORGANISATION_MODULE.workspaceId, ORGANISATION_MODULE.moduleId, written), () => {
      if (!quiet) {
        toast.success(`${project.name} updated`, {
          description: `${projectHolidayListName(written) ?? NO_HOLIDAY_LIST_LABEL} · ${weekendLabel(projectWeekend(written))} weekend.`,
        })
      }
    })
  }

  const submitListDialog = (draft: HolidayListDraft, startWith: readonly HolidayEntry[]) => {
    if (!dialog) return
    if (dialog.mode === "create") {
      const record = createHolidayListRecord(draft, startWith, { actorName: ACTOR_NAME, companyId: company?.id })
      saveList(record, `${record.name} added`, (row) => {
        setDialog(null)
        setOpenListId(row.id)
      })
      return
    }
    const before = dialog.record
    const oldName = holidayListName(before)
    const resting = projectsOn(before)
    saveList(withHolidayListDraft(before, draft), `${draft.name.trim()} updated`, () => {
      setDialog(null)
      if (oldName === draft.name.trim()) return
      // A rename follows to the projects on the list: the API's key does it on the Pilot, which the projects are read again for; here the pane does.
      if (onApi) void refreshModule(ORGANISATION_MODULE.workspaceId, ORGANISATION_MODULE.moduleId)
      else for (const project of resting) saveProject(project, { holidayList: draft.name.trim(), weekend: projectWeekend(project) }, true)
    })
  }

  const removeList = (record: BusinessRecord) => {
    const resting = projectsOn(record)
    if (resting.length > 0) {
      toast.error(`${record.name} is in use`, { description: `${count(resting.length, "project")} rest on it: move ${resting.length === 1 ? "it" : "them"} to another list first.` })
      return
    }
    if (onApi) {
      void removeHolidayList(sendAction, record.id).then((outcome) => {
        if (outcome.kind !== "done") return
        toast.success(`${record.name} removed`)
        setOpenListId(null)
        void refreshModule(COLLECTION_CALENDARS_MODULE.workspaceId, COLLECTION_CALENDARS_MODULE.moduleId)
      })
      return
    }
    const removed = softDeletedRecord(record, { reason: "Removed in Settings › Holiday lists", actorName: ACTOR_NAME, deletionLogId: `holiday-list-removal-${record.id}` })
    saveList(removed, `${record.name} removed`, () => setOpenListId(null))
  }

  // The module whose problem the pane says, the projects first.
  const blocked = organisation.problem !== null ? organisation : calendars
  const notReadyMessage =
    organisation.pending || calendars.pending
      ? "Reading the holiday lists from the API…"
      : blocked.notGranted
        ? "The holiday lists are not shown to your role."
        : blocked.problem
          ? `The holiday lists could not be read from the API: ${blocked.problem.detail ?? blocked.problem.title}`
          : null
  const notReadyHint = blocked.notGranted ? blocked.problem?.detail : undefined
  const listedCountries = new Set(lists.map((record) => holidayListCountry(record) ?? ""))

  return (
    <AssetPanelShell
      heading="Operations"
      title="Holiday lists"
      description="The company's holiday lists, one per country, and the holidays of each. A project rests on one list: the guided setup, route generation and the scheme detail read its holidays from there."
      toolbar={
        openList ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpenListId(null)}>
              <ArrowLeft className="h-4 w-4" />
              All holiday lists
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setDialog({ mode: "create" })} disabled={!ready}>
              <Plus className="h-4 w-4" weight="bold" />
              Add country
            </Button>
          </div>
        )
      }
    >
      {!ready || notReadyMessage ? (
        <p className="rounded-xl border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
          {notReadyMessage ?? "Reading the holiday lists…"}
          {notReadyHint === undefined ? null : <span className="mt-1 block text-xs">{notReadyHint}</span>}
        </p>
      ) : openList ? (
        <HolidayListDetail
          record={openList}
          projects={projectsOn(openList)}
          onEdit={() => setDialog({ mode: "edit", record: openList })}
          onRemove={() => removeList(openList)}
          onSaveEntries={(entries, said) => saveList(withHolidayListEntries(openList, entries), said)}
        />
      ) : (
        <div className="space-y-6">
          <HolidayListsTable
            lists={lists}
            companyCountry={companyCountry !== undefined && !listedCountries.has(companyCountry) ? companyCountry : undefined}
            projectCount={(list) => projectsOn(list).length}
            onOpen={(list) => setOpenListId(list.id)}
            onSetUp={(country) => setDialog({ mode: "create", country })}
            onRemove={removeList}
          />
          <ProjectListsTable
            projects={projects}
            lists={lists}
            highlightedId={hydrated ? requestedProjectId : null}
            onSave={(project, settings) => saveProject(project, settings)}
          />
        </div>
      )}

      {dialog && (
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
      )}
    </AssetPanelShell>
  )
}

/* ------------------------------ The lists table ------------------------------ */

function HolidayListsTable({
  lists,
  companyCountry,
  projectCount,
  onOpen,
  onSetUp,
  onRemove,
}: {
  lists: readonly BusinessRecord[]
  /** The company's own country, where it has no list yet: offered first, as a row to set up. */
  companyCountry: string | undefined
  projectCount: (list: BusinessRecord) => number
  onOpen: (list: BusinessRecord) => void
  onSetUp: (country: string) => void
  onRemove: (list: BusinessRecord) => void
}) {
  const today = todayIso()
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-foreground">Countries</h2>
      <div className="overflow-hidden rounded-lg border border-border/60">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-48">Country</TableHead>
              <TableHead>List name</TableHead>
              <TableHead className="w-28">Holidays</TableHead>
              <TableHead className="w-48">Next holiday</TableHead>
              <TableHead className="w-28">Projects</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {companyCountry && (
              <TableRow data-testid="holiday-list-company-country">
                <TableCell className="text-sm font-medium">{countryName(companyCountry)}</TableCell>
                <TableCell className="text-sm text-muted-foreground" colSpan={4}>
                  The company&apos;s country has no holiday list yet.
                </TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" className="h-8" onClick={() => onSetUp(companyCountry)}>
                    Set up
                  </Button>
                </TableCell>
              </TableRow>
            )}
            {lists.length === 0 && !companyCountry ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                  No holiday list yet. Add a country to start one.
                </TableCell>
              </TableRow>
            ) : (
              lists.map((list) => {
                const country = holidayListCountry(list)
                const entries = holidayListEntries(list)
                const next = nextHoliday(entries, today)
                const used = projectCount(list)
                return (
                  <TableRow key={list.id} data-testid="holiday-list-row" className="cursor-pointer" onClick={() => onOpen(list)}>
                    <TableCell className="text-sm font-medium">
                      <Button variant="unstyled" className="text-left hover:underline" onClick={() => onOpen(list)}>
                        {country ? countryName(country) : "—"}
                      </Button>
                    </TableCell>
                    <TableCell className="text-sm">{holidayListName(list)}</TableCell>
                    <TableCell className="text-sm tabular-nums">{entries.length}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{next ? `${formatServiceDate(next.date)} · ${shownName(next, country)}` : "—"}</TableCell>
                    <TableCell className="text-sm tabular-nums">{used}</TableCell>
                    <TableCell className="whitespace-nowrap text-right" onClick={(event) => event.stopPropagation()}>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onOpen(list)} aria-label={`Open ${holidayListName(list)}`}>
                        <PencilSimple className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => onRemove(list)}
                        disabled={used > 0}
                        title={used > 0 ? "A project rests on this list" : undefined}
                        aria-label={`Remove ${holidayListName(list)}`}
                      >
                        <Trash className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </section>
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit holiday list" : "Add country"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Rename the list or move it to another country. Its holidays stay as they are, and the projects resting on it keep it."
              : "A holiday list for one country. Open it from the table to add its holidays by date and name."}
          </DialogDescription>
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
            <p className="text-xs leading-5 text-muted-foreground">The name a project picks the list by, and the guided setup shows beside the policy.</p>
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

/* ------------------------------ One list's holidays ------------------------------ */

const EMPTY_ENTRY: HolidayEntry = { date: "", name: "" }

function HolidayListDetail({
  record,
  projects,
  onEdit,
  onRemove,
  onSaveEntries,
}: {
  record: BusinessRecord
  projects: readonly BusinessRecord[]
  onEdit: () => void
  onRemove: () => void
  onSaveEntries: (entries: readonly HolidayEntry[], said: string) => void
}) {
  const country = holidayListCountry(record)
  const entries = holidayListEntries(record)
  const years = holidayListYears(entries)
  const thisYear = Number(todayIso().slice(0, 4))
  const [year, setYear] = useState<string>(() => (years.includes(thisYear) ? String(thisYear) : years[0] !== undefined ? String(years[0]) : ALL_YEARS))
  const [editingDate, setEditingDate] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<HolidayEntry>(EMPTY_ENTRY)
  const [addDraft, setAddDraft] = useState<HolidayEntry>(EMPTY_ENTRY)
  const [issue, setIssue] = useState<string | null>(null)

  const yearOptions = [...new Set([...years, thisYear])].sort((a, b) => b - a)
  const shown = year === ALL_YEARS ? entries : entries.filter((entry) => entry.date.startsWith(`${year}-`))
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
      `${formatServiceDate(editDraft.date)} updated`,
    )
    cancelEdit()
  }
  const add = () => {
    const problem = holidayListEntryIssue(entries, addDraft.date)
    if (problem) return setIssue(problem)
    const entry = { date: addDraft.date, name: addDraft.name.trim() || suggested(addDraft.date) || "" }
    onSaveEntries([...entries, entry], `${entry.name || "Holiday"} added on ${formatServiceDate(entry.date)}`)
    setAddDraft(EMPTY_ENTRY)
    setIssue(null)
    // Show the year the holiday went into.
    if (year !== ALL_YEARS && !entry.date.startsWith(`${year}-`)) setYear(entry.date.slice(0, 4))
  }
  const remove = (entry: HolidayEntry) => {
    if (editingDate === entry.date) cancelEdit()
    onSaveEntries(
      entries.filter((candidate) => candidate.date !== entry.date),
      `${shownName(entry, country)} removed`,
    )
  }
  const copyToNextYear = () => {
    if (copied.length === 0) return
    onSaveEntries([...entries, ...copied], `${count(copied.length, "holiday")} added to ${Number(year) + 1}`)
    setYear(String(Number(year) + 1))
  }

  return (
    <div className="space-y-4" data-testid={`holiday-list-${record.id}`}>
      <header className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border/60 p-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{holidayListName(record)}</h2>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[11px] font-medium">
              {country ? countryName(country) : "No country"}
            </Badge>
            <span>{count(entries.length, "holiday")}</span>
            <span>·</span>
            <span>{projects.length === 0 ? "No project rests on it" : `Used by ${projects.map((project) => project.name).join(", ")}`}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={onEdit}>
            <PencilSimple className="h-4 w-4" />
            Edit list
          </Button>
          <Button size="sm" variant="outline" onClick={onRemove} disabled={projects.length > 0} title={projects.length > 0 ? "A project rests on this list" : undefined}>
            <Trash className="h-4 w-4" />
            Remove list
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Label id="holiday-year-label">Year</Label>
          <Select value={year} onValueChange={setYear}>
            <SelectTrigger className="h-8 w-40" aria-labelledby="holiday-year-label">
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
        </div>
        {year !== ALL_YEARS && (
          <Button size="sm" variant="outline" onClick={copyToNextYear} disabled={copied.length === 0} title={copied.length === 0 ? `Every holiday of ${year} is in ${Number(year) + 1} already` : undefined}>
            <CopySimple className="h-4 w-4" />
            Copy {year} to {Number(year) + 1}
          </Button>
        )}
      </div>

      <form
        className="flex flex-wrap items-end gap-2 rounded-lg border border-border/60 bg-muted/20 p-3"
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
      </form>
      {issue && (
        <p role="alert" className="text-xs text-destructive">
          {issue}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-border/60">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-44">Date</TableHead>
              <TableHead className="w-36">Day</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-28 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                  {year === ALL_YEARS ? "No holiday on this list yet. Add one above." : `No holiday in ${year} yet. Add one above${copied.length === 0 && entries.some((entry) => entry.date.startsWith(`${Number(year) - 1}-`)) ? `, or copy ${Number(year) - 1}'s from that year` : ""}.`}
                </TableCell>
              </TableRow>
            ) : (
              shown.map((entry) =>
                editingDate === entry.date ? (
                  <TableRow key={entry.date} data-testid="holiday-row-editing">
                    <TableCell>
                      <Input type="date" value={editDraft.date} aria-label="Holiday date" onChange={(event) => setEditDraft({ ...editDraft, date: event.target.value })} className="h-8" />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{isIsoDate(editDraft.date) ? formatServiceDate(editDraft.date).slice(0, 3) : "—"}</TableCell>
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
                    <TableCell className="whitespace-nowrap text-right">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={commitEdit} aria-label="Save holiday">
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={cancelEdit} aria-label="Cancel editing">
                        <X className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ) : (
                  <TableRow key={entry.date} data-testid="holiday-row">
                    <TableCell className="text-sm tabular-nums">{entry.date}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatServiceDate(entry.date)}</TableCell>
                    <TableCell className="text-sm">{entry.name ? entry.name : <span className="text-muted-foreground">{shownName(entry, country)}</span>}</TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => startEdit(entry)} aria-label={`Edit ${entry.date}`}>
                        <PencilSimple className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => remove(entry)} aria-label={`Remove ${entry.date}`}>
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
    </div>
  )
}

/* ------------------------------ The projects ------------------------------ */

function ProjectListsTable({
  projects,
  lists,
  highlightedId,
  onSave,
}: {
  projects: readonly BusinessRecord[]
  lists: readonly BusinessRecord[]
  highlightedId: string | null
  onSave: (project: BusinessRecord, settings: ProjectCalendarSettings) => void
}) {
  const highlightedRef = useRef<HTMLTableRowElement>(null)
  useEffect(() => {
    if (highlightedId) highlightedRef.current?.scrollIntoView({ block: "center" })
  }, [highlightedId])
  const names = lists.map(holidayListName)

  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-medium text-foreground">Projects</h2>
        <p className="text-xs leading-5 text-muted-foreground">
          The list each project rests on, and the days of its weekend. A holiday policy that shifts a collection skips both.
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border border-border/60">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead>Project</TableHead>
              <TableHead className="w-72">Holiday list</TableHead>
              <TableHead className="w-80">Weekend</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                  No project yet.
                </TableCell>
              </TableRow>
            ) : (
              projects.map((project) => {
                const listName = projectHolidayListName(project)
                const weekend = projectWeekend(project)
                const highlighted = project.id === highlightedId
                // A name no list carries (a browser's old state): shown as it is, so the person can move it onto a list.
                const options = listName && !names.includes(listName) ? [...names, listName] : names
                return (
                  <TableRow key={project.id} ref={highlighted ? highlightedRef : undefined} data-testid={`holiday-project-${project.id}`} className={cn(highlighted && "bg-primary/5")}>
                    <TableCell className="text-sm font-medium">{project.name}</TableCell>
                    <TableCell>
                      <Select value={listName ?? NO_LIST} onValueChange={(value) => onSave(project, { holidayList: value === NO_LIST ? null : value, weekend })}>
                        <SelectTrigger className="h-8 w-64" aria-label={`Holiday list of ${project.name}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_LIST}>{NO_HOLIDAY_LIST_LABEL}</SelectItem>
                          {options.map((name) => (
                            <SelectItem key={name} value={name}>
                              {name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <ToggleGroup
                        type="multiple"
                        variant="outline"
                        size="sm"
                        aria-label={`Weekend of ${project.name}`}
                        value={[...weekend]}
                        onValueChange={(days) => {
                          // A project rests at least one day; the last one cannot be lifted.
                          if (days.length === 0) return
                          onSave(project, { holidayList: listName, weekend: days as ServiceDay[] })
                        }}
                        className="flex-wrap"
                      >
                        {SERVICE_DAYS.map((day) => (
                          <ToggleGroupItem key={day} value={day} aria-label={SERVICE_DAY_LABELS[day]}>
                            {SERVICE_DAY_SHORT_LABELS[day]}
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}
