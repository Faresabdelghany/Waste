"use client"

// Settings › Operations › Ticket types (#545 of #544): the company's own types
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
// Offered on the Pilot alone, beside the Ticket teams.

import { useEffect, useRef, useState, type ReactNode } from "react"
import { ArrowDown, ArrowLeft, ArrowUp, Info, Plus, Trash } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { TicketTypeAction, TicketTypePermission } from "@waste/contracts/ticket-types"
import { fieldSetIssue } from "@waste/domain/resolution/ticket-types"
import type { TicketCommand } from "@waste/domain/resolution/transitions"
import type { TicketFieldInput, TicketFieldRequirement, TicketKind } from "@waste/domain/resolution/vocabulary"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/asset-management-settings"
import { TicketTypeAutomation, type AutomationChoices } from "@/components/settings/ticket-type-automation"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { StatusBadge } from "@/components/ui/status-badge"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useApiConfigured, useApiSession } from "@/components/waste/api-session-store"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { savedRow, useBusinessRecordStore, useModuleRecords, useServerResolver, whenSaved, type SavedOutcome } from "@/components/waste/business-record-store"
import { vehicleAdapter } from "@/lib/api/records/fleet"
import { roleAdapter, userAdapter } from "@/lib/api/records/organisation"
import { isTicketTeamRecord } from "@/lib/api/records/ticket-teams"
import { isTicketTypeRecord } from "@/lib/api/records/ticket-types"
import { accessUnknownSentence } from "@/lib/api/session"
import { VEHICLES_MODULE } from "@/lib/data/allocations"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import type { BusinessRecord } from "@/lib/data/business-modules"
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
  ticketTypesAccessOf,
  TICKET_TYPE_FORM,
  TICKET_TYPES_MODULE,
  typeActionsOf,
  typeFieldsOf,
  typePermissionsOf,
  updatedTicketTypeRecord,
  type FieldDraft,
} from "@/lib/data/ticket-types"
import { isSoftDeleted } from "@waste/domain/record-visibility"

const NO_RECORDS: readonly BusinessRecord[] = []

/**
 * The pane, a tab of Settings › Tickets (#548 of #544): `tabs` is the page's tab strip, drawn in this pane's header.
 * `openTypeId` is the type whose own page stands in the list's place, by the API's id, or null for the list; `onOpenType` opens one, or the list with null.
 */
export function TicketTypesSettings({ tabs, openTypeId, onOpenType }: { tabs?: ReactNode; openTypeId: string | null; onOpenType: (typeId: string | null) => void }) {
  const configured = useApiConfigured()
  const session = useApiSession()
  const { me } = session
  const access = ticketTypesAccessOf(me?.role.grants)
  const { upsertRecord, refreshModule } = useBusinessRecordStore()
  const resolver = useServerResolver()
  const types = useModuleRecords(TICKET_TYPES_MODULE.workspaceId, TICKET_TYPES_MODULE.moduleId, NO_RECORDS)
  const users = useModuleRecords(ACCESS_MODULE.workspaceId, ACCESS_MODULE.moduleId, NO_RECORDS)
  const roles = users.records.filter((record) => roleAdapter.owns(record) && !isSoftDeleted(record))
  const vehicles = useModuleRecords(VEHICLES_MODULE.workspaceId, VEHICLES_MODULE.moduleId, NO_RECORDS)
  // The kinds' defaults first, then the company's own, each in the order they were made.
  const rows = types.records.filter((record) => isTicketTypeRecord(record) && !isSoftDeleted(record)).sort((a, b) => Number(b.submittedValues?.isDefault === true) - Number(a.submittedValues?.isDefault === true))
  // What the Automation tab's pickers offer: the active teams, people, types and the vehicles, each by its web id.
  const named = (records: readonly BusinessRecord[]) => records.map((record) => ({ value: record.id, label: record.name }))
  const choices: AutomationChoices = {
    teams: named(types.records.filter((record) => isTicketTeamRecord(record) && !isSoftDeleted(record) && record.status === "Active")),
    people: named(users.records.filter((record) => userAdapter.owns(record) && !isSoftDeleted(record) && record.status === "Active")),
    types: named(rows.filter((record) => record.status === "Active")),
    vehicles: named(vehicles.records.filter((record) => vehicleAdapter.owns(record) && !isSoftDeleted(record))),
  }
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  // A type is addressed by the API's id, which a reload maps to the same row; a row the server does not hold yet by its own.
  const addressOf = (record: BusinessRecord) => resolver.serverIdOf(record.id) ?? record.id
  const addressed = openTypeId === null ? undefined : (resolver.byServerId(openTypeId)?.id ?? openTypeId)
  const opened = rows.find((record) => record.id === addressed)
  // Whether the list is what shows, read when a create answers: a person who has moved on meanwhile is not pulled to the new type.
  const listShowing = useRef(true)
  useEffect(() => {
    listShowing.current = addressed === undefined
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
    const made = createTicketTypeRecord(values, { now: Date.now() })
    // A new type lands on its own page, addressed by the id the API gave it, while the list still shows; one whose answer named none is found on the list.
    const landOn = (saved: SavedOutcome | undefined) => {
      setCreating(false)
      if (listShowing.current && saved !== undefined && saved.kind !== "unchanged" && saved.serverId !== undefined) onOpenType(saved.serverId)
    }
    write(made, landOn, "Ticket type added", madeDefault(null, made))
  }

  const emptyMessage = !configured
    ? "The ticket types are kept on the API: sign in on the Pilot to read and write them."
    : accessUnknownSentence(session) ?? (types.pending
      ? "Reading the ticket types from the API…"
      : types.notGranted
        ? "The ticket types are not shown to your role."
        : types.problem
          ? `The ticket types could not be read from the API: ${types.problem.detail ?? types.problem.title}`
          : "No ticket type yet.")

  if (addressed !== undefined) {
    if (opened === undefined) return <TicketTypeMissing message={types.ready ? "No ticket type has this address." : emptyMessage} onBack={() => onOpenType(null)} />
    const save = (record: BusinessRecord, saved: (row: BusinessRecord) => void) => write(record, (outcome) => saved(savedRow(outcome, record)), "Ticket type saved", madeDefault(opened, record))
    return <TicketTypePage key={opened.id} record={opened} roles={roles} choices={choices} saving={saving} editable={access.edit} onBack={() => onOpenType(null)} onSave={save} />
  }

  return (
    <AssetPanelShell
      heading="Tickets"
      tabs={tabs}
      title="Ticket types"
      description="The company's own types of case, each inside one kind. A type carries the fields the office fills in and may name the roles that move it from one status to the next."
    >
      <RecordsSection
        shown={rows.length}
        total={rows.length}
        actions={
          <Button size="sm" disabled={!configured || !access.create || !types.ready || saving} onClick={() => setCreating(true)}>
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

      {/* The form names no row of another module: every option is its own. */}
      {/* Held open while the create is out, so the answer finds the person where they asked. */}
      <BusinessRecordFormDialog
        schema={TICKET_TYPE_FORM}
        open={creating}
        onOpenChange={(open) => {
          if (!saving) setCreating(open)
        }}
        onSubmit={handleCreate}
        relationOptions={(field) => field.options ?? []}
        submitting={saving}
      />
    </AssetPanelShell>
  )
}

/** The header a type's page stands under: the way back to the list, the type's name and what it is, and the page's own buttons. */
function TicketTypeHeader({ onBack, children, action }: { onBack: () => void; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Back to ticket types" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">{children}</div>
      </div>
      {action}
    </div>
  )
}

/** The page of a type the address names that is not listed: still being read, not shown to the role, or not there. */
function TicketTypeMissing({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="border-b border-border/40">
        <TicketTypeHeader onBack={onBack}>
          <p className="truncate text-base font-medium text-foreground">Ticket type</p>
        </TicketTypeHeader>
      </header>
      <p className="p-8 text-center text-sm text-muted-foreground">{message}</p>
    </div>
  )
}

/**
 * One type's page: its own fields, its custom fields in order, who may give each status command and its automation — saved together, each set written where it changed.
 * Read-only for a role that may not edit types. `onSave` hands back the row the save left, once the API has answered.
 */
function TicketTypePage({ record, roles, choices, saving, editable, onBack, onSave }: { record: BusinessRecord; roles: readonly BusinessRecord[]; choices: AutomationChoices; saving: boolean; editable: boolean; onBack: () => void; onSave: (record: BusinessRecord, saved: (row: BusinessRecord) => void) => void }) {
  const isDefault = record.submittedValues?.isDefault === true
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
    // A field the API now holds keeps its key from here on: tickets carry their values under it, so a later relabel must not move it.
    const freezeSavedKeys = (saved: BusinessRecord) => {
      const held = new Set(typeFieldsOf(saved).map((field) => field.key))
      setFields((current) => current.map((draft) => (held.has(draft.key) ? { ...draft, keyTouched: true } : draft)))
    }
    onSave(updatedTicketTypeRecord(record, { name, description, status: active ? "Active" : "Inactive", isDefault: makeDefault, fields: wire, permissions, actions }), freezeSavedKeys)
  }

  const tabClass = "h-7 rounded-full px-3 text-xs data-[state=active]:bg-background"
  return (
    <Tabs value={tab} onValueChange={setTab} className="flex min-w-0 flex-1 flex-col gap-0">
      <header className="flex flex-col border-b border-border/40">
        <TicketTypeHeader
          onBack={onBack}
          action={
            <div className="flex flex-wrap items-center justify-end gap-3">
              {refusal !== null && <p className="max-w-xl text-sm text-destructive">{refusal}</p>}
              {editable && (
                <Button size="sm" onClick={save} disabled={saving}>
                  Save type
                </Button>
              )}
            </div>
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-base font-medium text-foreground">{record.name}</h1>
            <StatusBadge tone={record.status === "Active" ? "success" : "warning"}>{record.status}</StatusBadge>
            {isDefault && <span className="text-xs text-muted-foreground">Default</span>}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{record.facts.Kind}</p>
        </TicketTypeHeader>
        <div className="overflow-x-auto px-4 py-3">
          <TabsList className="inline-flex h-8 rounded-full border border-border/50 bg-muted px-1 py-0.5 text-xs" aria-label="Ticket type">
            <TabsTrigger value="details" className={tabClass}>
              Details
            </TabsTrigger>
            <TabsTrigger value="fields" className={tabClass}>
              Fields
              <span className="ml-1.5 text-[10px] text-muted-foreground">{fields.length}</span>
            </TabsTrigger>
            <TabsTrigger value="permissions" className={tabClass}>
              Status permissions
            </TabsTrigger>
            <TabsTrigger value="automation" className={tabClass}>
              Automation
              <span className="ml-1.5 text-[10px] text-muted-foreground">{actions.length}</span>
            </TabsTrigger>
          </TabsList>
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
      </div>
    </Tabs>
  )
}
