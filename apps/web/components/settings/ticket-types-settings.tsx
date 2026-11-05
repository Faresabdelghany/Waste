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
// Offered on the Pilot alone, beside the Ticket teams.

import { useState } from "react"
import { ArrowDown, ArrowUp, PencilSimple, Plus, Trash } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { TicketTypeAction, TicketTypePermission } from "@waste/contracts/ticket-types"
import { fieldSetIssue } from "@waste/domain/resolution/ticket-types"
import type { TicketCommand } from "@waste/domain/resolution/transitions"
import type { TicketFieldInput, TicketFieldRequirement, TicketKind } from "@waste/domain/resolution/vocabulary"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/asset-management-settings"
import { TicketTypeAutomation, type AutomationChoices } from "@/components/settings/ticket-type-automation"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { StatusBadge } from "@/components/ui/status-badge"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useApiConfigured, useApiSession } from "@/components/waste/api-session-store"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, useModuleRecords, whenSaved } from "@/components/waste/business-record-store"
import { vehicleAdapter } from "@/lib/api/records/fleet"
import { roleAdapter, userAdapter } from "@/lib/api/records/organisation"
import { isTicketTeamRecord } from "@/lib/api/records/ticket-teams"
import { isTicketTypeRecord } from "@/lib/api/records/ticket-types"
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

export function TicketTypesSettings() {
  const configured = useApiConfigured()
  const { me } = useApiSession()
  const access = ticketTypesAccessOf(me?.role.grants)
  const { upsertRecord, refreshModule } = useBusinessRecordStore()
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
  const [editing, setEditing] = useState<BusinessRecord | null>(null)
  const [saving, setSaving] = useState(false)

  const write = (record: BusinessRecord, done: () => void, said: string, madeDefault: boolean) => {
    if (saving) return
    setSaving(true)
    whenSaved(
      upsertRecord(TICKET_TYPES_MODULE.workspaceId, TICKET_TYPES_MODULE.moduleId, record),
      () => {
        done()
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
    write(made, () => setCreating(false), "Ticket type added", madeDefault(null, made))
  }

  const emptyMessage = !configured
    ? "The ticket types are kept on the API: sign in on the Pilot to read and write them."
    : types.pending
      ? "Reading the ticket types from the API…"
      : types.notGranted
        ? "The ticket types are not shown to your role."
        : types.problem
          ? `The ticket types could not be read from the API: ${types.problem.detail ?? types.problem.title}`
          : "No ticket type yet."

  return (
    <AssetPanelShell
      heading="Operations"
      title="Ticket types"
      description="The company's own types of case, each inside one kind. A type carries the fields the office fills in and may name the roles that move it from one status to the next."
      toolbar={<p className="text-sm text-muted-foreground">A ticket opened by its kind alone — by a driver, the worker or a work order — is of the kind&apos;s default type.</p>}
      action={
        <Button size="sm" disabled={!configured || !access.create || !types.ready || saving} onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" weight="bold" />
          New type
        </Button>
      }
    >
      <RecordsSection shown={rows.length} total={rows.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Type</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Fields</TableHead>
                <TableHead>Automation</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={6} message={emptyMessage} hint={types.notGranted ? types.problem?.detail : undefined} />
              ) : (
                rows.map((record) => (
                  <TableRow key={record.id}>
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
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${record.name}`} disabled={!access.edit || saving} onClick={() => setEditing(record)}>
                        <PencilSimple className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </RecordsSection>

      {/* The form names no row of another module: every option is its own. */}
      <BusinessRecordFormDialog schema={TICKET_TYPE_FORM} open={creating} onOpenChange={setCreating} onSubmit={handleCreate} relationOptions={(field) => field.options ?? []} />
      {editing && <TicketTypeEditor record={editing} roles={roles} choices={choices} saving={saving} onClose={() => setEditing(null)} onSave={(record) => write(record, () => setEditing(null), "Ticket type saved", madeDefault(editing, record))} />}
    </AssetPanelShell>
  )
}

/** One type's editor: its own fields, its custom fields in order, who may give each status command and its automation — saved together, each set written where it changed. */
function TicketTypeEditor({ record, roles, choices, saving, onClose, onSave }: { record: BusinessRecord; roles: readonly BusinessRecord[]; choices: AutomationChoices; saving: boolean; onClose: () => void; onSave: (record: BusinessRecord) => void }) {
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
    onSave(updatedTicketTypeRecord(record, { name, description, status: active ? "Active" : "Inactive", isDefault: makeDefault, fields: wire, permissions, actions }))
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1200px]">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>{record.name}</DialogTitle>
          <DialogDescription>
            A type of {record.facts.Kind?.toLowerCase() ?? "case"}. Its kind never changes, since the tickets of the type carry it.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="details" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-6 mt-4 w-fit">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="fields">Fields ({fields.length})</TabsTrigger>
            <TabsTrigger value="permissions">Status permissions</TabsTrigger>
            <TabsTrigger value="automation">Automation ({actions.length})</TabsTrigger>
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            <TabsContent value="details" className="mt-0 grid gap-4 sm:grid-cols-2">
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
                  <span className="block text-xs text-muted-foreground">A retired type is offered to no new ticket and keeps the tickets it holds.</span>
                </span>
                <Switch checked={active} onCheckedChange={setActive} disabled={isDefault} aria-label="Active" />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
                <span>
                  <span className="font-medium">Default for its kind</span>
                  <span className="block text-xs text-muted-foreground">{isDefault ? "Make another type of the kind the default to change it." : "Makes this the type of a ticket opened by its kind alone."}</span>
                </span>
                <Switch checked={makeDefault} onCheckedChange={setMakeDefault} disabled={isDefault} aria-label="Default for its kind" />
              </label>
            </TabsContent>

            <TabsContent value="fields" className="mt-0 space-y-3">
              <p className="text-sm text-muted-foreground">The facts the office records on a ticket of this type, in the order its form asks for them. A field taken off keeps its values on the tickets that hold them.</p>
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
              <p className="text-sm text-muted-foreground">Who may move a ticket of this type. A command no role is ticked for stays open to everyone who works tickets; ticking roles makes it theirs alone. The system&apos;s own work — a stop serving its ticket — is not held to it.</p>
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
          </div>
        </Tabs>
        <DialogFooter className="border-t px-6 py-4">
          {refusal !== null && <p className="mr-auto text-sm text-destructive">{refusal}</p>}
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            Save type
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
