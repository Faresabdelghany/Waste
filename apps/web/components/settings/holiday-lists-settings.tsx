"use client"

// Settings › Operations › Holiday lists (issue #36, 2026-09-24): each
// project's holiday list — the list's name and the weekend on the project
// record, the dated, named holidays per year on the project's Collection
// Calendar records — with add, edit and remove per holiday and "Create next
// year", which proposes next year's record from this year's through the
// Collection calendar create form. Everything here reads and writes the
// records the guided setup, route generation and the scheme detail already
// resolve through resolveProjectCalendar; the record writes are owned by
// lib/data/holiday-lists.ts and the placement rules by
// @waste/domain/route-schemes/holiday-lists.

import { useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import {
  CalendarPlus,
  Check,
  PencilSimple,
  Plus,
  Trash,
  X,
} from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { AssetPanelShell } from "@/components/settings/asset-management-settings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
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
import { HOLIDAY_LISTS_PROJECT_PARAM } from "@/lib/data/business-links"
import {
  getModuleDefinition,
  type BusinessRecord,
  type ModuleLocation,
} from "@/lib/data/business-modules"
import {
  COLLECTION_CALENDARS_MODULE,
  collectionCalendarSchema,
  type CollectionCalendarLookups,
} from "@/lib/data/collection-calendars"
import {
  createYearRecord,
  withHolidayEntries,
  withProjectCalendar,
  yearProposalFormValues,
  type ProjectCalendarSettings,
} from "@/lib/data/holiday-lists"
import { projectRecordsOf } from "@/lib/data/project-scope"
import { isSoftDeleted } from "@waste/domain/record-visibility"
import { calendarFromRecord } from "@waste/domain/route-schemes/calendar"
import { formatValidity } from "@waste/domain/route-schemes/calendar-list"
import {
  calendarHolidayEntries,
  calendarYear,
  firstYearProposal,
  holidayEntryIssue,
  latestHolidayCalendar,
  nextYearProposal,
  type HolidayEntry,
  type YearProposal,
} from "@waste/domain/route-schemes/holiday-lists"
import {
  KNOWN_HOLIDAY_LIST_NAMES,
  holidayNamesFor,
  type HolidayNameLookup,
} from "@waste/domain/route-schemes/holiday-names"
import { projectCalendarRecords } from "@waste/domain/route-schemes/holidays"
import {
  NO_HOLIDAY_LIST_LABEL,
  projectHolidayListName,
  projectWeekend,
  weekendLabel,
} from "@waste/domain/route-schemes/project-calendar"
import {
  SERVICE_DAYS,
  SERVICE_DAY_LABELS,
  SERVICE_DAY_SHORT_LABELS,
  formatServiceDate,
  isIsoDate,
  todayIso,
  type ServiceDay,
} from "@waste/domain/route-schemes/recurrence"
import { count } from "@waste/domain/text"
import { cn } from "@/lib/utils"

const ACTOR_NAME = "Olivia Larsen"

/** Where the project records live — the module resolveProjectCalendar reads the weekend and list name from. */
const ORGANISATION_MODULE: ModuleLocation = { workspaceId: "configure", moduleId: "organization" }
const NO_RECORDS: readonly BusinessRecord[] = []
const ORGANISATION_FIXTURES = getModuleDefinition(ORGANISATION_MODULE)?.records ?? NO_RECORDS
const CALENDAR_FIXTURES = getModuleDefinition(COLLECTION_CALENDARS_MODULE)?.records ?? NO_RECORDS

const AMBER =
  "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"

type CreateState = {
  projectId: string
  proposal: YearProposal
  /** The record the year continues from; none for a project's first year. */
  previous?: BusinessRecord
}

export function HolidayListsSettings() {
  const { getRecords, upsertRecord } = useBusinessRecordStore()
  const hydrated = useBusinessRecordsHydrated()
  const searchParams = useSearchParams()
  const requestedProjectId = searchParams.get(HOLIDAY_LISTS_PROJECT_PARAM)
  const [query, setQuery] = useState("")
  const [creating, setCreating] = useState<CreateState | null>(null)

  // Live records of a module: fixtures merged with what the browser holds,
  // soft-deleted ones left out.
  const liveRecords = (location: ModuleLocation): BusinessRecord[] => {
    const module = getModuleDefinition(location)
    return module
      ? getRecords(location.workspaceId, module.id, module.records).filter(
          (record) => !isSoftDeleted(record),
        )
      : []
  }

  // The projects and the calendars the pane edits: on the Pilot, the API's
  // rows once they are here and nothing before (Issue #175), so no card
  // offers a year over fixtures the API does not hold.
  const organisation = useModuleRecords(ORGANISATION_MODULE.workspaceId, ORGANISATION_MODULE.moduleId, ORGANISATION_FIXTURES)
  const calendars = useModuleRecords(COLLECTION_CALENDARS_MODULE.workspaceId, COLLECTION_CALENDARS_MODULE.moduleId, CALENDAR_FIXTURES)
  const ready = organisation.ready && calendars.ready
  const projectRecords = projectRecordsOf(organisation.records.filter((record) => !isSoftDeleted(record)))
  const calendarRecords = calendars.records.filter((record) => !isSoftDeleted(record))

  const lookups: CollectionCalendarLookups = {
    projectName: (projectId) => projectRecords.find((record) => record.id === projectId)?.name,
    recordName: (relation, recordId) =>
      liveRecords(relation).find((record) => record.id === recordId)?.name,
  }

  const relationOptions = (field: BusinessFormField): readonly BusinessFormOption[] => {
    if (!field.relation) return field.options ?? []
    const records = field.id === "projectId" ? projectRecords : liveRecords(field.relation)
    return records.map((record) => ({ value: record.id, label: record.name }))
  }

  // The project the link came from is shown first; the rest keep the registry's order.
  const ordered = [...projectRecords].sort((a, b) =>
    a.id === requestedProjectId ? -1 : b.id === requestedProjectId ? 1 : 0,
  )
  const needle = query.trim().toLowerCase()
  const shown = ordered.filter((project) => project.name.toLowerCase().includes(needle))

  // On the Pilot the store answers the write's outcome once the API has, so
  // the success is said then and a refusal by the store, in the API's words;
  // on the browser's own path there is nothing to wait for.
  const whenSaved = (outcome: ReturnType<typeof upsertRecord>, done: () => void) => {
    if (outcome === undefined) done()
    else void outcome.then((result) => result.kind !== "refused" && done())
  }

  const saveProject = (project: BusinessRecord, settings: ProjectCalendarSettings) => {
    const written = withProjectCalendar(project, settings)
    whenSaved(upsertRecord(ORGANISATION_MODULE.workspaceId, ORGANISATION_MODULE.moduleId, written), () =>
      toast.success(`${project.name} updated`, {
        description: `${projectHolidayListName(written) ?? NO_HOLIDAY_LIST_LABEL} · ${weekendLabel(projectWeekend(written))} weekend.`,
      }),
    )
  }

  const saveEntries = (record: BusinessRecord, entries: readonly HolidayEntry[]) => {
    const written = withHolidayEntries(record, entries, lookups)
    whenSaved(upsertRecord(COLLECTION_CALENDARS_MODULE.workspaceId, COLLECTION_CALENDARS_MODULE.moduleId, written), () =>
      toast.success(`${record.name} updated`, {
        description: `${count(entries.length, "holiday")} · read by the next route generation on the project.`,
      }),
    )
  }

  const openCreate = (project: BusinessRecord, years: readonly BusinessRecord[]) => {
    const names = holidayNamesFor(projectHolidayListName(project) ?? undefined)
    const previous = latestHolidayCalendar(years)
    const proposal = previous
      ? nextYearProposal(previous, names)
      : firstYearProposal(project.name, Number(todayIso().slice(0, 4)), names)
    if (!proposal) return
    setCreating({ projectId: project.id, proposal, previous })
  }

  const createSchema = useMemo(() => {
    const schema = collectionCalendarSchema()
    return {
      ...schema,
      title: "Create next year's holiday list",
      description:
        "Review the year the list continues into: the moveable holidays are placed for the new year, the fixed ones keep their day, and anything the list could not place keeps its month and day for you to correct.",
    }
  }, [])
  const createValues = useMemo(
    () =>
      creating
        ? yearProposalFormValues(creating.proposal, creating.projectId, creating.previous)
        : undefined,
    [creating],
  )

  const handleCreate = (values: BusinessFormValues) => {
    if (!creating) return
    const record = createYearRecord(creating.proposal, values, { actorName: ACTOR_NAME, lookups })
    whenSaved(upsertRecord(COLLECTION_CALENDARS_MODULE.workspaceId, COLLECTION_CALENDARS_MODULE.moduleId, record), () => {
      setCreating(null)
      toast.success(`${record.name} created`, {
        description: "Its holidays are read by route generation on the project.",
      })
    })
  }

  const emptyMessage = organisation.pending || calendars.pending
    ? "Reading the projects and their calendars from the API…"
    : (organisation.problem ?? calendars.problem)
      ? `The holiday lists could not be read from the API: ${(organisation.problem ?? calendars.problem)?.detail ?? (organisation.problem ?? calendars.problem)?.title}`
      : "No project matches this search."

  return (
    <AssetPanelShell
      heading="Operations"
      title="Holiday lists"
      description="Each project's holiday list: its name, the weekend the project rests on, and the dated holidays of every year. The guided setup, route generation and the scheme detail read what is set here."
      toolbar={
        <div className="flex items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search projects"
            aria-label="Search projects"
            className="h-8 w-64"
          />
        </div>
      }
    >
      <div className="space-y-4">
        {!ready || shown.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
            {emptyMessage}
          </p>
        ) : (
          shown.map((project) => (
            <ProjectHolidayList
              key={project.id}
              project={project}
              years={projectCalendarRecords(project.id, calendarRecords)}
              highlighted={hydrated && project.id === requestedProjectId}
              onSaveProject={(settings) => saveProject(project, settings)}
              onSaveEntries={saveEntries}
              onCreateYear={(years) => openCreate(project, years)}
            />
          ))
        )}
      </div>

      {creating && createValues && (
        <BusinessRecordFormDialog
          schema={createSchema}
          open
          onOpenChange={(open) => {
            if (!open) setCreating(null)
          }}
          onSubmit={handleCreate}
          relationOptions={relationOptions}
          initialValueOverrides={createValues}
        />
      )}
    </AssetPanelShell>
  )
}

/* ------------------------------- One project ------------------------------ */

function ProjectHolidayList({
  project,
  years,
  highlighted,
  onSaveProject,
  onSaveEntries,
  onCreateYear,
}: {
  project: BusinessRecord
  /** The project's calendar records, earliest first, dated or not. */
  years: readonly BusinessRecord[]
  highlighted: boolean
  onSaveProject: (settings: ProjectCalendarSettings) => void
  onSaveEntries: (record: BusinessRecord, entries: readonly HolidayEntry[]) => void
  onCreateYear: (years: readonly BusinessRecord[]) => void
}) {
  const listName = projectHolidayListName(project)
  const weekend = projectWeekend(project)
  const names = holidayNamesFor(listName ?? undefined)
  // The name field holds a draft only while it differs from what is stored, so
  // a save elsewhere shows through the moment the draft is committed or dropped.
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const sectionRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (highlighted) sectionRef.current?.scrollIntoView({ block: "start" })
  }, [highlighted])

  const latest = latestHolidayCalendar(years)
  const nextYear = latest ? (calendarYear(latest) ?? 0) + 1 : Number(todayIso().slice(0, 4))

  const commitName = () => {
    if (nameDraft === null) return
    const next = nameDraft.trim() || null
    if (next !== listName) onSaveProject({ holidayList: next, weekend })
    setNameDraft(null)
  }

  return (
    <section
      ref={sectionRef}
      data-testid={`holiday-list-${project.id}`}
      className={cn(
        "space-y-4 rounded-xl border border-border/60 p-4",
        highlighted && "ring-2 ring-primary/30",
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{project.name}</h2>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge
              variant="outline"
              className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", !listName && AMBER)}
            >
              {listName ?? NO_HOLIDAY_LIST_LABEL}
            </Badge>
            <span>{weekendLabel(weekend)} weekend</span>
            <span>·</span>
            <span>{count(years.length, "year list")}</span>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => onCreateYear(years)}>
          <CalendarPlus className="h-4 w-4" />
          {latest ? "Create next year" : `Create ${nextYear} list`}
        </Button>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${project.id}-holiday-list`}>Holiday list</Label>
          <Input
            id={`${project.id}-holiday-list`}
            value={nameDraft ?? listName ?? ""}
            placeholder="Blank means the project has no holiday list"
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                commitName()
              }
              if (event.key === "Escape") setNameDraft(null)
            }}
          />
          <div className="flex flex-wrap gap-1.5">
            {KNOWN_HOLIDAY_LIST_NAMES.filter((name) => name !== listName).map((name) => (
              <Button
                key={name}
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 rounded-full border border-border/60 px-2.5 text-xs"
                onClick={() => {
                  setNameDraft(null)
                  onSaveProject({ holidayList: name, weekend })
                }}
              >
                {name}
              </Button>
            ))}
            {listName && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 rounded-full border border-border/60 px-2.5 text-xs"
                onClick={() => {
                  setNameDraft(null)
                  onSaveProject({ holidayList: null, weekend })
                }}
              >
                No holiday list
              </Button>
            )}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            The name the guided setup shows beside the policy. A list this system knows names its
            holidays for you; any other name works, and you name the holidays yourself.
          </p>
        </div>

        <div className="space-y-2">
          <Label id={`${project.id}-weekend-label`}>Weekend</Label>
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            aria-labelledby={`${project.id}-weekend-label`}
            value={[...weekend]}
            onValueChange={(days) => {
              // A project rests at least one day; the last one cannot be lifted.
              if (days.length === 0) return
              onSaveProject({ holidayList: listName, weekend: days as ServiceDay[] })
            }}
            className="flex-wrap"
          >
            {SERVICE_DAYS.map((day) => (
              <ToggleGroupItem key={day} value={day} aria-label={SERVICE_DAY_LABELS[day]}>
                {SERVICE_DAY_SHORT_LABELS[day]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-xs leading-5 text-muted-foreground">
            The days the project rests on. A holiday policy that shifts a collection skips these days
            as well as the holidays.
          </p>
        </div>
      </div>

      {years.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
          No holiday list for any year yet. Create the {nextYear} list to start from what the list
          knows.
        </p>
      ) : (
        <div className="space-y-3">
          {years.map((record) => (
            <YearHolidays
              key={record.id}
              record={record}
              entries={calendarHolidayEntries(record, names)}
              names={names}
              onSave={(entries) => onSaveEntries(record, entries)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/* -------------------------------- One year -------------------------------- */

const EMPTY_ENTRY: HolidayEntry = { date: "", name: "" }

function YearHolidays({
  record,
  entries,
  names,
  onSave,
}: {
  record: BusinessRecord
  entries: readonly HolidayEntry[]
  names: HolidayNameLookup
  onSave: (entries: readonly HolidayEntry[]) => void
}) {
  const calendar = calendarFromRecord(record)
  const validity = calendar ? { validFrom: calendar.validFrom, validTo: calendar.validTo } : null
  const [editingDate, setEditingDate] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<HolidayEntry>(EMPTY_ENTRY)
  const [addDraft, setAddDraft] = useState<HolidayEntry>(EMPTY_ENTRY)
  const [issue, setIssue] = useState<string | null>(null)

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
    const problem = holidayEntryIssue(entries, editDraft.date, validity, editingDate)
    if (problem) {
      setIssue(problem)
      return
    }
    onSave(entries.map((entry) => (entry.date === editingDate ? editDraft : entry)))
    cancelEdit()
  }
  const add = () => {
    const problem = holidayEntryIssue(entries, addDraft.date, validity)
    if (problem) {
      setIssue(problem)
      return
    }
    onSave([...entries, addDraft])
    setAddDraft(EMPTY_ENTRY)
    setIssue(null)
  }
  const remove = (entry: HolidayEntry) => {
    if (editingDate === entry.date) cancelEdit()
    onSave(entries.filter((candidate) => candidate.date !== entry.date))
  }

  // The name the list would give a date the person has not named — shown as
  // the placeholder while they type, and as muted copy on an unnamed row.
  const suggestedName = (date: string) => names(date) ?? "Holiday"

  return (
    <div className="overflow-hidden rounded-lg border border-border/60">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-foreground">{record.name}</p>
          <span className="text-xs text-muted-foreground">
            {calendar ? formatValidity(calendar.validFrom, calendar.validTo) : "—"}
          </span>
          <Badge
            variant="outline"
            className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", statusClasses(record.status))}
          >
            {record.status}
          </Badge>
        </div>
        <span className="text-xs text-muted-foreground">{count(entries.length, "holiday")}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="w-44">Date</TableHead>
            <TableHead className="w-32">Day</TableHead>
            <TableHead>Name</TableHead>
            <TableHead className="w-24" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) =>
            editingDate === entry.date ? (
              <TableRow key={entry.date} data-testid="holiday-row-editing">
                <TableCell>
                  <Input
                    type="date"
                    value={editDraft.date}
                    aria-label="Holiday date"
                    onChange={(event) => setEditDraft({ ...editDraft, date: event.target.value })}
                    className="h-8"
                  />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {isIsoDate(editDraft.date) ? formatServiceDate(editDraft.date).slice(0, 3) : "—"}
                </TableCell>
                <TableCell>
                  <Input
                    value={editDraft.name}
                    aria-label="Holiday name"
                    placeholder={suggestedName(editDraft.date)}
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
                <TableCell className="text-sm text-muted-foreground">
                  {formatServiceDate(entry.date)}
                </TableCell>
                <TableCell className="text-sm">
                  {entry.name ? (
                    entry.name
                  ) : (
                    <span className="text-muted-foreground">{suggestedName(entry.date)}</span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => startEdit(entry)}
                    aria-label={`Edit ${entry.date}`}
                  >
                    <PencilSimple className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => remove(entry)}
                    aria-label={`Remove ${entry.date}`}
                  >
                    <Trash className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ),
          )}
          <TableRow className="bg-muted/20 hover:bg-muted/20" data-testid="holiday-row-add">
            <TableCell>
              <Input
                type="date"
                value={addDraft.date}
                aria-label={`New holiday date for ${record.name}`}
                onChange={(event) => setAddDraft({ ...addDraft, date: event.target.value })}
                className="h-8"
              />
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {isIsoDate(addDraft.date) ? formatServiceDate(addDraft.date).slice(0, 3) : "—"}
            </TableCell>
            <TableCell>
              <Input
                value={addDraft.name}
                aria-label={`New holiday name for ${record.name}`}
                placeholder={addDraft.date ? suggestedName(addDraft.date) : "Name (optional)"}
                onChange={(event) => setAddDraft({ ...addDraft, name: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    add()
                  }
                }}
                className="h-8"
              />
            </TableCell>
            <TableCell className="whitespace-nowrap text-right">
              <Button size="sm" variant="outline" onClick={add} className="h-8">
                <Plus className="h-4 w-4" weight="bold" />
                Add
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      {issue && (
        <p role="alert" className="border-t border-border px-4 py-2 text-xs text-destructive">
          {issue}
        </p>
      )}
    </div>
  )
}
