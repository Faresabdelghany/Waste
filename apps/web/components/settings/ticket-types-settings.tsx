"use client"

// Settings › Tickets › Types (#545 of #544): the company's own types
// of case, each inside one kind — added, renamed, described, retired and made
// their kind's default, given their custom fields and the roles that may give
// each status command, and given their automation (#546), the actions the
// system takes on a ticket of the type when it opens or reaches a status —
// through the record store, which on the Pilot reaches
// `/ticket-types` through lib/api/records/ticket-types.ts. Every company
// starts with a default type per kind, the type of a ticket opened by kind
// alone; a ticket's form offers a type's fields once the type is picked.
// A row opens the type's own page in the tab's place, its four tabs edited
// and saved there, under an address of its own (`?pane=tickets&type=<id>`).
// Offered on the Pilot alone.

import { useEffect, useRef, useState, type ReactNode } from "react"
import { ArrowDown, ArrowUp, Info, Plus, Trash } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { TicketTeamDefaults } from "@waste/contracts/ticket-teams"
import type { TicketTypeAction, TicketTypePermission } from "@waste/contracts/ticket-types"
import { fieldSetIssue } from "@waste/domain/resolution/ticket-types"
import { type TicketCommand, type TicketFieldInput, type TicketFieldRequirement, type TicketKind } from "@waste/domain/resolution/vocabulary"
import { PillTab, PillTabsList, RecordPageHeader } from "@/components/page-layout"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/settings-pane-kit"
import { DefaultTeamSelect } from "@/components/settings/ticket-teams-settings"
import { TicketTypeAutomation, type AutomationChoices } from "@/components/settings/ticket-type-automation"
import { ProjectPicker, useProjectSetting, type ProjectPick } from "@/components/settings/use-project-setting"
import { useTicketTeams } from "@/components/settings/use-ticket-teams"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { StatusBadge } from "@/components/ui/status-badge"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useApiClient, useApiSession } from "@/components/platform/api-session-store"
import { BusinessRecordFormDialog } from "@/components/platform/business-record-form-dialog"
import { savedRow, useBusinessRecordStore, useModuleRecords, useServerResolver, whenSaved, type SavedOutcome } from "@/components/platform/business-record-store"
import { problemOfError, problemSentence } from "@/lib/api/problem"
import { vehicleAdapter } from "@/lib/api/records/fleet"
import { roleAdapter, userAdapter } from "@/lib/api/records/organisation"
import { isTicketTeamRecord } from "@/lib/api/records/ticket-teams"
import { isTicketTypeRecord } from "@/lib/api/records/ticket-types"
import { accessUnknownSentence } from "@/lib/api/session"
import { moveDefaultTeam, readTeamDefaults } from "@/lib/api/ticket-team-defaults"
import { VEHICLES_MODULE } from "@/lib/data/allocations"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { projectShown } from "@/lib/data/project-scope"
import type { TicketScope } from "@/lib/data/ticket-scope"
import { DEFAULT_TEAM_NOT_SAVED, defaultTeamSaved, NO_TEAM, pickedTeamOf, teamChoicesOf, teamOfScope, teamShownOf, ticketTeamsAccessOf } from "@/lib/data/ticket-teams"
import { ACCESS_MODULE } from "@/lib/data/tickets"
import {
  actionsIssue,
  COMMAND_HEADINGS,
  createTicketTypeRecord,
  draftOf,
  FIELD_INPUT_OPTIONS,
  FIELD_REQUIREMENT_OPTIONS,
  fieldOfDraft,
  newFieldDraft,
  relabelled,
  ticketTypeFormFor,
  ticketTypesAccessOf,
  TICKET_TYPES_MODULE,
  TYPE_DEFAULT_TEAM_FIELD,
  typeActionsOf,
  typeFieldsOf,
  typePermissionsOf,
  updatedTicketTypeRecord,
  type FieldDraft,
} from "@/lib/data/ticket-types"
import { isSoftDeleted } from "@/lib/prototype/record-visibility"
import { moduleReadSentence } from "@/lib/api/read-state"
import { useGrants } from "@/components/platform/use-grants"

/**
 * The pane, a tab of Settings › Tickets (#548 of #544): `tabs` is the page's tab strip, drawn in this pane's header.
 * `openTypeId` is the type whose own page stands in the list's place, by the API's id, or null for the list; `onOpenType` opens one, or the list with null.
 * `pick` is the project the page's tabs share: a type's form sets its default team in it (#606).
 */
export function TicketTypesSettings({ tabs, pick, openTypeId, onOpenType }: { tabs?: ReactNode; pick: ProjectPick; openTypeId: string | null; onOpenType: (typeId: string | null) => void }) {
  const session = useApiSession()
  const client = useApiClient()
  const access = ticketTypesAccessOf(useGrants())
  const { upsertRecord, refreshModule } = useBusinessRecordStore()
  const resolver = useServerResolver()
  const ticketTeams = useTicketTeams()
  // The project the page's tabs share: a new type's default team is set in it.
  const project = projectShown(session.me?.projects ?? [], pick.projectId, (candidate) => candidate.id)
  const types = useModuleRecords(TICKET_TYPES_MODULE.workspaceId, TICKET_TYPES_MODULE.moduleId)
  const users = useModuleRecords(ACCESS_MODULE.workspaceId, ACCESS_MODULE.moduleId)
  const roles = users.records.filter((record) => roleAdapter.owns(record) && !isSoftDeleted(record))
  const vehicles = useModuleRecords(VEHICLES_MODULE.workspaceId, VEHICLES_MODULE.moduleId)
  // The kinds' defaults first, then the company's own, each in the order they were made.
  const rows = types.records.filter((record) => isTicketTypeRecord(record) && !isSoftDeleted(record)).sort((a, b) => Number(b.submittedValues?.isDefault === true) - Number(a.submittedValues?.isDefault === true))
  const named = (records: readonly BusinessRecord[]) => records.map((record) => ({ value: record.id, label: record.name }))
  const choices: AutomationChoices = {
    teams: named(types.records.filter((record) => isTicketTeamRecord(record) && !isSoftDeleted(record) && record.status === "Active")),
    people: named(users.records.filter((record) => userAdapter.owns(record) && !isSoftDeleted(record) && record.status === "Active")),
    types: named(rows.filter((record) => record.status === "Active")),
    vehicles: named(vehicles.records.filter((record) => vehicleAdapter.owns(record) && !isSoftDeleted(record))),
  }
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  // A new type's default team is out to the API, after the type itself landed (#606).
  const [settingTeam, setSettingTeam] = useState(false)
  // A type is addressed by the API's id, which a reload maps to the same row; a row the server does not hold yet by its own.
  const addressOf = (record: BusinessRecord) => resolver.serverIdOf(record.id) ?? record.id
  const addressed = openTypeId === null ? undefined : (resolver.byServerId(openTypeId)?.id ?? openTypeId)
  const opened = rows.find((record) => record.id === addressed)
  // Whether the list is what shows, read when a create answers: a person who has moved on meanwhile is not pulled to the new type.
  const listShowing = useRef(true)
  useEffect(() => {
    listShowing.current = addressed === undefined
    // Gone with the pane: an answer that arrives after it opens nothing.
    return () => {
      listShowing.current = false
    }
  })

  const write = (record: BusinessRecord, done: (saved: SavedOutcome | undefined) => void, said: string, madeDefault: boolean) => {
    if (saving) return
    setSaving(true)
    whenSaved(
      upsertRecord(TICKET_TYPES_MODULE.workspaceId, TICKET_TYPES_MODULE.moduleId, record),
      (saved) => {
        done(saved)
        toast.success(said, { description: record.name })
        // The API unmade the kind's other default too, a row the write did not answer: the module is read again.
        if (madeDefault) void refreshModule(TICKET_TYPES_MODULE.workspaceId, TICKET_TYPES_MODULE.moduleId)
      },
      () => setSaving(false),
    )
  }
  const madeDefault = (before: BusinessRecord | null, after: BusinessRecord) => after.submittedValues?.isDefault === true && before?.submittedValues?.isDefault !== true
  const handleCreate = (values: BusinessFormValues) => {
    // Minted on the clock inside the lib: the compiler's lint refuses `Date.now()` in this handler.
    const made = createTicketTypeRecord(values)
    const typed = values[TYPE_DEFAULT_TEAM_FIELD]
    const teamPicked = typeof typed === "string" && typed !== "" ? typed : NO_TEAM
    const team = pickedTeamOf(teamPicked, ticketTeams.serverIdOf)
    if ("message" in team) {
      toast.error("The ticket type was not added", { description: team.message })
      return
    }
    // A new type lands on its own page, addressed by the id the API gave it, while the list still shows; one whose answer named none is found on the list.
    const landOn = (saved: SavedOutcome | undefined) => {
      const serverId = saved !== undefined && saved.kind !== "unchanged" ? saved.serverId : undefined
      const land = () => {
        setCreating(false)
        if (listShowing.current && serverId !== undefined) onOpenType(serverId)
      }
      if (team.teamId === null || client === null || project === null) return land()
      const failed = (description: string) => toast.error(DEFAULT_TEAM_NOT_SAVED, { description })
      if (serverId === undefined) {
        failed("The type's own page sets it.")
        return land()
      }
      const told = defaultTeamSaved(made.name, project.name, teamShownOf({ teamId: teamPicked, ticketTypeId: serverId }, ticketTeams.teams, ticketTeams.reading))
      // The project's setting, written once the type has an id to name. The dialog stays, held, until it answers: the type's page reads the set as it opens, and the person is still where they asked.
      setSettingTeam(true)
      void moveDefaultTeam(client, project.id, { kind: null, ticketTypeId: serverId }, team.teamId)
        .then(
          () => toast.success(told.title, { description: told.description }),
          (error: unknown) => failed(problemSentence(problemOfError(error))),
        )
        .finally(() => {
          setSettingTeam(false)
          land()
        })
    }
    write(made, landOn, "Ticket type added", madeDefault(null, made))
  }

  const emptyMessage = accessUnknownSentence(session) ?? moduleReadSentence(types, "ticket types") ?? "No ticket type yet."

  if (addressed !== undefined) {
    if (opened === undefined) return <TicketTypeMissing message={types.ready ? "No ticket type has this address." : emptyMessage} onBack={() => onOpenType(null)} />
    const save = (record: BusinessRecord, saved: (row: BusinessRecord) => void) => write(record, (outcome) => saved(savedRow(outcome, record)), "Ticket type saved", madeDefault(opened, record))
    return <TicketTypePage key={opened.id} record={opened} serverId={resolver.serverIdOf(opened.id)} pick={pick} roles={roles} choices={choices} saving={saving} editable={access.edit} onBack={() => onOpenType(null)} onSave={save} />
  }

  return (
    <AssetPanelShell
      tabs={tabs}
      title="Ticket types"
      description="The company's own types of case, each inside one kind. A type carries the fields the office fills in and may name the roles that move it from one status to the next."
    >
      <RecordsSection
        shown={rows.length}
        total={rows.length}
        actions={
          <Button size="sm" disabled={!access.create || !types.ready || saving} onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" weight="bold" />
            New type
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Type</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Fields</TableHead>
                <TableHead>Automation</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={5} message={emptyMessage} hint={types.notGranted ? types.problem?.detail : undefined} />
              ) : (
                rows.map((record) => (
                  <TableRow
                    key={record.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${record.name}`}
                    className="cursor-pointer hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                    onClick={() => onOpenType(addressOf(record))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        onOpenType(addressOf(record))
                      }
                    }}
                  >
                    <TableCell className="text-sm font-medium text-foreground">
                      {record.name}
                      {record.submittedValues?.isDefault === true && <span className="ml-2 text-xs font-normal text-muted-foreground">Default</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{record.facts.Kind}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{record.facts.Fields ?? "None"}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{record.facts.Automation ?? "None"}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <StatusBadge tone={record.status === "Active" ? "success" : "warning"}>{record.status}</StatusBadge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </RecordsSection>

      {/* The form names no row of another module: every option is its own, the teams' handed to its schema. */}
      {/* Held open while the create, then its default team, is out, so the answer finds the person where they asked. */}
      <BusinessRecordFormDialog
        schema={ticketTypeFormFor(project, teamChoicesOf(true, ticketTeams.teams, NO_TEAM))}
        open={creating}
        onOpenChange={(open) => {
          if (!saving && !settingTeam) setCreating(open)
        }}
        onSubmit={handleCreate}
        relationOptions={(field) => field.options ?? []}
        submitting={saving || settingTeam}
      />
    </AssetPanelShell>
  )
}

/** The page of a type the address names that is not listed: still being read, not shown to the role, or not there. */
function TicketTypeMissing({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="border-b border-border/40">
        <RecordPageHeader backLabel="Back to ticket types" onBack={onBack} name="Ticket type" />
      </header>
      <p className="p-8 text-center text-sm text-muted-foreground">{message}</p>
    </div>
  )
}

/**
 * One type's page: its own fields, its custom fields in order, who may give each status command and its automation — saved together, each set written where it changed.
 * Read-only for a role that may not edit types. `onSave` hands back the row the save left, once the API has answered.
 */
function TicketTypePage({
  record,
  serverId,
  pick,
  roles,
  choices,
  saving,
  editable,
  onBack,
  onSave,
}: {
  record: BusinessRecord
  /** The type's id on the API, which a project's default team names it by; undefined while the API holds no such row. */
  serverId: string | undefined
  pick: ProjectPick
  roles: readonly BusinessRecord[]
  choices: AutomationChoices
  saving: boolean
  editable: boolean
  onBack: () => void
  onSave: (record: BusinessRecord, saved: (row: BusinessRecord) => void) => void
}) {
  const isDefault = record.submittedValues?.isDefault === true
  // The type's default team in the project shown (#606): the project's setting, the row the Default teams tab lists for the type, held as a draft until Save type.
  const ticketTeams = useTicketTeams()
  const teamDefaults = useProjectSetting<TicketTeamDefaults, string>({ name: "ticket-team-defaults", readable: ticketTeamsAccessOf(useGrants()).view, read: readTeamDefaults }, pick)
  const teamScope: TicketScope | null = serverId === undefined ? null : { kind: null, ticketTypeId: serverId }
  // Undefined until the project's set is read; then the team it names for the type, or null for none.
  const namedTeam = teamDefaults.base === null || teamScope === null ? undefined : teamOfScope(teamDefaults.base, teamScope)
  const savedTeam = namedTeam === undefined ? null : namedTeam === null ? NO_TEAM : ticketTeams.webIdOf(namedTeam)
  const team = teamDefaults.draft ?? savedTeam
  const [name, setName] = useState(record.name)
  const [description, setDescription] = useState(typeof record.submittedValues?.description === "string" ? record.submittedValues.description : "")
  const [active, setActive] = useState(record.status === "Active")
  const [makeDefault, setMakeDefault] = useState(isDefault)
  const [fields, setFields] = useState<FieldDraft[]>(() => typeFieldsOf(record).map(draftOf))
  const [permissions, setPermissions] = useState<TicketTypePermission[]>(() => typePermissionsOf(record))
  const [actions, setActions] = useState<TicketTypeAction[]>(() => typeActionsOf(record))
  const kind = record.submittedValues?.kind as TicketKind
  const [refusal, setRefusal] = useState<string | null>(null)
  const [tab, setTab] = useState("details")

  const changeField = (index: number, change: (draft: FieldDraft) => FieldDraft) => {
    setFields((current) => current.map((draft, at) => (at === index ? change(draft) : draft)))
    setRefusal(null)
  }
  const moveField = (index: number, by: -1 | 1) =>
    setFields((current) => {
      const next = [...current]
      const [moved] = next.splice(index, 1)
      next.splice(index + by, 0, moved)
      return next
    })
  const rolesOf = (command: TicketCommand) => permissions.find((entry) => entry.command === command)?.roleIds ?? []
  const toggleRole = (command: TicketCommand, roleId: string, on: boolean) =>
    setPermissions((current) => {
      const others = current.filter((entry) => entry.command !== command)
      // Read from the state the update is applied to, so two ticks before a render both land.
      const held = current.find((entry) => entry.command === command)?.roleIds ?? []
      const roleIds = on ? [...held.filter((id) => id !== roleId), roleId] : held.filter((id) => id !== roleId)
      return [...others, { command, roleIds }].sort((a, b) => COMMAND_HEADINGS.findIndex((heading) => heading.command === a.command) - COMMAND_HEADINGS.findIndex((heading) => heading.command === b.command))
    })

  const save = () => {
    if (name.trim() === "") return setRefusal("Name the ticket type.")
    // A kind's default is offered to every ticket of the kind: the API's rule, said before the request.
    if (makeDefault && !active) return setRefusal("A kind's default type is offered to every ticket of the kind; make another type the default first, or keep this one active.")
    const wire = fields.map(fieldOfDraft)
    const issue = fieldSetIssue(wire)
    if (issue !== undefined) return setRefusal(`Field ${issue.index + 1}: ${issue.message}.`)
    const unlabelled = wire.findIndex((field) => field.label === "")
    if (unlabelled !== -1) return setRefusal(`Field ${unlabelled + 1}: give it a label.`)
    const automation = actionsIssue(actions)
    if (automation !== undefined) return setRefusal(automation)
    const teamDraft = teamDefaults.draft
    const pickedTeam = teamDraft === null ? null : pickedTeamOf(teamDraft, ticketTeams.serverIdOf)
    if (pickedTeam !== null && "message" in pickedTeam) return setRefusal(pickedTeam.message)
    // The API's rule, said before the type is written: a project's set names no retired type afresh, though one it names already keeps its row.
    if (pickedTeam !== null && pickedTeam.teamId !== null && !active && namedTeam === null) return setRefusal("A retired type is given no default team: keep it active, or leave its team as its kind's.")
    // The project's setting, written once the type's own save has landed: a type the API refused moves no team.
    const saveTeam = () => {
      const project = teamDefaults.project
      if (teamDraft === null || pickedTeam === null || teamScope === null || project === null) return
      const told = defaultTeamSaved(name.trim(), project.name, teamShownOf({ teamId: teamDraft, ticketTypeId: teamScope.ticketTypeId }, ticketTeams.teams, ticketTeams.reading))
      teamDefaults.save((client, projectId) => moveDefaultTeam(client, projectId, teamScope, pickedTeam.teamId), { saved: () => told, failed: DEFAULT_TEAM_NOT_SAVED }, (answered) => answered)
    }
    // A field the API now holds keeps its key from here on: tickets carry their values under it, so a later relabel must not move it.
    const freezeSavedKeys = (saved: BusinessRecord) => {
      const held = new Set(typeFieldsOf(saved).map((field) => field.key))
      setFields((current) => current.map((draft) => (held.has(draft.key) ? { ...draft, keyTouched: true } : draft)))
    }
    onSave(updatedTicketTypeRecord(record, { name, description, status: active ? "Active" : "Inactive", isDefault: makeDefault, fields: wire, permissions, actions }), (saved) => {
      freezeSavedKeys(saved)
      saveTeam()
    })
  }

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex min-w-0 flex-1 flex-col gap-0">
      <header className="flex flex-col border-b border-border/40">
        <RecordPageHeader
          backLabel="Back to ticket types"
          onBack={onBack}
          name={record.name}
          badge={
            <>
              <StatusBadge tone={record.status === "Active" ? "success" : "warning"}>{record.status}</StatusBadge>
              {isDefault && <span className="text-xs text-muted-foreground">Default</span>}
            </>
          }
          line={record.facts.Kind}
          actions={
            editable ? (
              <Button size="sm" onClick={save} disabled={saving || teamDefaults.saving}>
                Save type
              </Button>
            ) : undefined
          }
        />
        {refusal !== null && <p className="border-b border-border px-4 py-2 text-sm text-destructive">{refusal}</p>}
        <div className="overflow-x-auto px-4 py-3">
          <PillTabsList aria-label="Ticket type">
            <PillTab value="details">
              Details
            </PillTab>
            <PillTab value="fields">
              Fields
              <span className="ml-1.5 text-[10px] text-muted-foreground">{fields.length}</span>
            </PillTab>
            <PillTab value="permissions">
              Status permissions
            </PillTab>
            <PillTab value="automation">
              Automation
              <span className="ml-1.5 text-[10px] text-muted-foreground">{actions.length}</span>
            </PillTab>
          </PillTabsList>
          {/* Outside the tabs' fieldset, so a role that only reads the page can open it too. */}
          {tab === "permissions" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="unstyled" className="ml-2 align-middle text-muted-foreground hover:text-foreground" aria-label="About status permissions">
                  <Info className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm text-xs">A command no role is ticked for stays open to everyone who works tickets; ticking roles makes it theirs alone.</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>
      <div className="flex-1 p-4">
        {/* A role that may not edit types reads the page: every control of the tabs is disabled with the fieldset. */}
        <fieldset disabled={!editable} className="mx-auto min-w-0 max-w-[1500px]">
          <TabsContent value="details" className="mt-0 grid max-w-4xl gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="ticket-type-name">Name</Label>
              <Input id="ticket-type-name" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Kind</Label>
              <Input value={record.facts.Kind ?? ""} disabled />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="ticket-type-description">Description</Label>
              <Textarea id="ticket-type-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What the type is for, for the office." />
            </div>
            <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
              <span>
                <span className="font-medium">Active</span>
                {isDefault && <span className="block text-xs text-muted-foreground">Make another type of the kind the default to change it.</span>}
              </span>
              <Switch checked={active} onCheckedChange={setActive} disabled={isDefault} aria-label="Active" />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
              <span>
                <span className="font-medium">Default for its kind</span>
                {isDefault && <span className="block text-xs text-muted-foreground">Make another type of the kind the default to change it.</span>}
              </span>
              <Switch checked={makeDefault} onCheckedChange={setMakeDefault} disabled={isDefault} aria-label="Default for its kind" />
            </label>
          </TabsContent>

          <TabsContent value="fields" className="mt-0 space-y-3">
            {fields.length === 0 && <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No field yet.</p>}
            {fields.map((draft, index) => (
              <div key={index} className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_1fr_10rem_10rem_auto]" aria-label={`Field ${index + 1}`}>
                <div className="grid gap-1.5">
                  <Label htmlFor={`field-label-${index}`}>Label</Label>
                  <Input id={`field-label-${index}`} value={draft.label} onChange={(event) => changeField(index, (current) => relabelled(current, event.target.value))} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`field-key-${index}`}>Key</Label>
                  <Input id={`field-key-${index}`} value={draft.key} onChange={(event) => changeField(index, (current) => ({ ...current, key: event.target.value, keyTouched: true }))} className="font-mono text-xs" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Input</Label>
                  <Select value={draft.input} onValueChange={(input) => changeField(index, (current) => ({ ...current, input: input as TicketFieldInput }))}>
                    <SelectTrigger aria-label={`Input of field ${index + 1}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_INPUT_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label>Required</Label>
                  <Select value={draft.requirement} onValueChange={(requirement) => changeField(index, (current) => ({ ...current, requirement: requirement as TicketFieldRequirement }))}>
                    <SelectTrigger aria-label={`Requirement of field ${index + 1}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_REQUIREMENT_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end gap-1">
                  <Button type="button" variant="ghost" size="icon" className="h-9 w-9" aria-label={`Move field ${index + 1} up`} disabled={index === 0} onClick={() => moveField(index, -1)}>
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="h-9 w-9" aria-label={`Move field ${index + 1} down`} disabled={index === fields.length - 1} onClick={() => moveField(index, 1)}>
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="h-9 w-9" aria-label={`Remove field ${index + 1}`} onClick={() => setFields((current) => current.filter((_, at) => at !== index))}>
                    <Trash className="h-4 w-4" />
                  </Button>
                </div>
                {draft.input === "choice" && (
                  <div className="grid gap-1.5 sm:col-span-2">
                    <Label htmlFor={`field-choices-${index}`}>Choices</Label>
                    <Input id={`field-choices-${index}`} value={draft.choices} placeholder="Granted, Refused" onChange={(event) => changeField(index, (current) => ({ ...current, choices: event.target.value }))} />
                  </div>
                )}
                <div className={draft.input === "choice" ? "grid gap-1.5 sm:col-span-3" : "grid gap-1.5 sm:col-span-5"}>
                  <Label htmlFor={`field-help-${index}`}>Help text</Label>
                  <Input id={`field-help-${index}`} value={draft.helpText} placeholder="Shown under the input" onChange={(event) => changeField(index, (current) => ({ ...current, helpText: event.target.value }))} />
                </div>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setFields((current) => [...current, newFieldDraft()])}>
              <Plus className="h-4 w-4" />
              Add field
            </Button>
          </TabsContent>

          <TabsContent value="permissions" className="mt-0 space-y-3">
            <div className="overflow-x-auto rounded-md border">
              <Table className="min-w-[760px]">
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead>Role</TableHead>
                    {COMMAND_HEADINGS.map((heading) => (
                      <TableHead key={heading.command} className="text-center">
                        {heading.heading}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {roles.length === 0 ? (
                    <EmptyRow colSpan={COMMAND_HEADINGS.length + 1} message="The roles are not read yet." hint="Users & roles lists them." />
                  ) : (
                    roles.map((roleRecord) => (
                      <TableRow key={roleRecord.id}>
                        <TableCell className="text-sm">{roleRecord.name}</TableCell>
                        {COMMAND_HEADINGS.map((heading) => (
                          <TableCell key={heading.command} className="text-center">
                            <Checkbox
                              aria-label={`${roleRecord.name} may ${heading.heading.toLowerCase()}`}
                              checked={rolesOf(heading.command).includes(roleRecord.id)}
                              onCheckedChange={(checked) => toggleRole(heading.command, roleRecord.id, checked === true)}
                            />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground">
              {COMMAND_HEADINGS.map((heading) => `${heading.heading}: ${rolesOf(heading.command).length === 0 ? "everyone" : `${rolesOf(heading.command).length} role${rolesOf(heading.command).length === 1 ? "" : "s"}`}`).join(" · ")}
            </p>
          </TabsContent>

          <TabsContent value="automation" className="mt-0">
            <TicketTypeAutomation
              kind={kind}
              actions={actions}
              choices={choices}
              onChange={(next) => {
                setActions(next)
                setRefusal(null)
              }}
            />
          </TabsContent>
        </fieldset>
        {/* The type's default team in one project, under its own fields. Outside the tabs' fieldset, so a role that only reads the page still picks the project whose team it reads; the team's picker is held for it by its own `disabled`. An account that works in no project has none to set the team in. */}
        {tab === "details" && teamDefaults.project !== null && (
          <div className="mx-auto mt-4 min-w-0 max-w-[1500px]">
            <div className="grid max-w-4xl gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                {/* Held while a team is picked and not saved: the pick is the shown project's. */}
                <ProjectPicker id="ticket-type-team-project" setting={teamDefaults} disabled={teamDefaults.draft !== null} field />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ticket-type-default-team">Default team</Label>
                <DefaultTeamSelect
                  id="ticket-type-default-team"
                  value={team ?? ""}
                  choices={teamChoicesOf(true, ticketTeams.teams, savedTeam ?? NO_TEAM)}
                  onChange={(teamId) => {
                    if (teamId === savedTeam) teamDefaults.discard()
                    else teamDefaults.edit(teamId)
                    setRefusal(null)
                  }}
                  disabled={!editable || team === null || saving || teamDefaults.saving}
                />
                {teamDefaults.problem !== null && <p className="text-xs text-destructive">{problemSentence(teamDefaults.problem)}</p>}
              </div>
            </div>
          </div>
        )}
      </div>
    </Tabs>
  )
}
