"use client"

// Settings › Administration › Sorting guide (Issue #293, M1): one project's
// guide at a time — the items a resident's search finds on the public page,
// and the project's public address. Items are `configure.sorting-guide` on
// the API (lib/api/records/sorting-guide.ts), written through the store with
// this pane's own form (lib/data/sorting-guide.ts). Publishing is the
// project's own `publicSlug`, a write to `configure.organization` (ADR-0010).
// Offered on the Pilot alone, since the guide has no fixtures.

import { useMemo, useState } from "react"
import { ArrowSquareOut, PencilSimple, Plus } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/asset-management-settings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { useBusinessRecordStore, useModuleRecords, whenSaved } from "@/components/waste/business-record-store"
import { statusClasses } from "@/components/waste/business-record-views"
import { getModuleDefinition, type BusinessRecord } from "@/lib/data/business-modules"
import { MASTER_DATA_MODULE } from "@/lib/data/master-data"
import { masterDataKindOf } from "@/lib/data/master-data-kinds"
import {
  SORTING_GUIDE_MODULE,
  SORTING_GUIDE_STATUSES,
  slugRefusalOf,
  slugSuggestionOf,
  sortingGuideFormOf,
  sortingGuidePathOf,
  sortingGuideRecordOf,
  type SortingGuideItemForm,
} from "@/lib/data/sorting-guide"
import { cn } from "@/lib/utils"
import { isSoftDeleted } from "@waste/domain/record-visibility"

const ORGANISATION_FIXTURES = getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? []
const NO_FRACTION = "none"

export function SortingGuideSettings() {
  const { upsertRecord } = useBusinessRecordStore()
  const guide = useModuleRecords(SORTING_GUIDE_MODULE.workspaceId, SORTING_GUIDE_MODULE.moduleId, [])
  const organisation = useModuleRecords("configure", "organization", ORGANISATION_FIXTURES)
  const master = useModuleRecords(MASTER_DATA_MODULE.workspaceId, MASTER_DATA_MODULE.moduleId, [])

  const projects = organisation.records.filter((record) => !isSoftDeleted(record) && record.id.startsWith("project-"))
  const fractions = master.records.filter((record) => masterDataKindOf(record) === "waste-fraction")
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null)
  const project = projects.find((record) => record.id === chosenProjectId) ?? projects[0] ?? null
  const items = useMemo(
    () => guide.records.filter((record) => project !== null && record.projectIds?.[0] === project.id).sort((a, b) => a.name.localeCompare(b.name)),
    [guide.records, project],
  )

  const [editing, setEditing] = useState<{ record: BusinessRecord | null; form: SortingGuideItemForm } | null>(null)
  const [saving, setSaving] = useState(false)

  const save = () => {
    if (editing === null) return
    const record = sortingGuideRecordOf(editing.form, editing.record, Date.now())
    setSaving(true)
    whenSaved(
      upsertRecord(SORTING_GUIDE_MODULE.workspaceId, SORTING_GUIDE_MODULE.moduleId, record),
      () => {
        setEditing(null)
        toast.success(editing.record === null ? "Item added" : "Item saved", { description: `${record.name} is ${record.status.toLowerCase()} in the sorting guide.` })
      },
      () => setSaving(false),
    )
  }

  const emptyMessage = guide.pending
    ? "Reading the sorting guide from the API…"
    : guide.notGranted
      ? "The sorting guide is not shown to your role."
      : guide.problem
        ? `The sorting guide could not be read from the API: ${guide.problem.detail ?? guide.problem.title}`
        : project === null
          ? "No project to show a guide for."
          : `${project.name}'s guide has no items yet.`

  return (
    <AssetPanelShell
      heading="Administration"
      title="Sorting guide"
      description="What residents find when they search where a thing goes, on the project's public page."
      action={
        <Button size="sm" disabled={!guide.ready || !master.ready || project === null} onClick={() => project && setEditing({ record: null, form: sortingGuideFormOf(null, project.id) })}>
          <Plus className="h-4 w-4" weight="bold" />
          New item
        </Button>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="sorting-guide-project" className="text-sm text-muted-foreground">
            Project
          </Label>
          <Select value={project?.id ?? ""} onValueChange={setChosenProjectId} disabled={projects.length === 0}>
            <SelectTrigger id="sorting-guide-project" className="w-64">
              <SelectValue placeholder="Pick a project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((record) => (
                <SelectItem key={record.id} value={record.id}>
                  {record.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    >
      {/* Keyed by the project: the address field starts from the project shown, not the first one picked. */}
      {project !== null && <PublicAddress key={project.id} project={project} disabled={!organisation.ready} />}
      <RecordsSection shown={items.length} total={items.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Item</TableHead>
                <TableHead>Fraction</TableHead>
                <TableHead>Also known as</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <EmptyRow colSpan={5} message={emptyMessage} hint={guide.notGranted ? guide.problem?.detail : guide.ready && project !== null ? "Add the things residents ask about most." : ""} />
              ) : (
                items.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell className="min-w-[200px]">
                      <p className="text-sm font-medium text-foreground">{record.name}</p>
                      {record.description !== "" && <p className="line-clamp-1 text-xs text-muted-foreground">{record.description}</p>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{record.facts.Fraction}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{record.value || "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", statusClasses(record.status))}>
                        {record.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${record.name}`} onClick={() => setEditing({ record, form: sortingGuideFormOf(record, project?.id ?? "") })}>
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

      {editing !== null && (
        <Dialog open onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{editing.record === null ? "New item" : `Edit ${editing.record.name}`}</DialogTitle>
              <DialogDescription>Only a published item of a published project reaches the public page.</DialogDescription>
            </DialogHeader>
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                save()
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="guide-item-name">Name</Label>
                <Input id="guide-item-name" required value={editing.form.name} onChange={(event) => setEditing({ ...editing, form: { ...editing.form, name: event.target.value } })} placeholder="Pizzabakke" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="guide-item-synonyms">Also known as</Label>
                <Input id="guide-item-synonyms" value={editing.form.synonyms} onChange={(event) => setEditing({ ...editing, form: { ...editing.form, synonyms: event.target.value } })} placeholder="pizza box, pizzaæske" />
                <p className="text-xs text-muted-foreground">Other words residents search for, separated by commas.</p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="guide-item-fraction">Fraction</Label>
                <Select value={editing.form.wasteFractionId || NO_FRACTION} onValueChange={(value) => setEditing({ ...editing, form: { ...editing.form, wasteFractionId: value === NO_FRACTION ? "" : value } })}>
                  <SelectTrigger id="guide-item-fraction">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_FRACTION}>No fraction (not for a bin at home)</SelectItem>
                    {fractions.map((record) => (
                      <SelectItem key={record.id} value={record.id}>
                        {record.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="guide-item-instructions">How to hand it in</Label>
                <Textarea id="guide-item-instructions" rows={3} value={editing.form.instructions} onChange={(event) => setEditing({ ...editing, form: { ...editing.form, instructions: event.target.value } })} placeholder="Skrab madrester af. Fedtede bakker i restaffald." />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="guide-item-status">Status</Label>
                <Select value={editing.form.status} onValueChange={(value) => setEditing({ ...editing, form: { ...editing.form, status: value } })}>
                  <SelectTrigger id="guide-item-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SORTING_GUIDE_STATUSES.map((status) => (
                      <SelectItem key={status.token} value={status.token}>
                        {status.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saving || editing.form.name.trim() === ""}>
                  {editing.record === null ? "Add item" : "Save changes"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </AssetPanelShell>
  )
}

/** The project's public address: where its guide is read, or the slug to publish it under. */
function PublicAddress({ project, disabled }: { project: BusinessRecord; disabled: boolean }) {
  const { upsertRecord } = useBusinessRecordStore()
  const published = typeof project.submittedValues?.publicSlug === "string" ? project.submittedValues.publicSlug : null
  const [slug, setSlug] = useState(() => published ?? slugSuggestionOf(project.name))
  const [saving, setSaving] = useState(false)
  const refusal = slugRefusalOf(slug)

  const write = (publicSlug: string | null) => {
    const submittedValues = { ...project.submittedValues }
    if (publicSlug === null) delete submittedValues.publicSlug
    else submittedValues.publicSlug = publicSlug
    setSaving(true)
    whenSaved(
      upsertRecord("configure", "organization", { ...project, submittedValues }),
      () => toast.success(publicSlug === null ? "Guide unpublished" : "Guide published", { description: publicSlug === null ? `${project.name}'s public page is closed.` : `Residents can search it at ${sortingGuidePathOf(publicSlug)}.` }),
      () => setSaving(false),
    )
  }

  return (
    <section className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-4 py-4">
      {published !== null ? (
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">Published</p>
          <a className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline" href={sortingGuidePathOf(published)} target="_blank" rel="noreferrer">
            {sortingGuidePathOf(published)}
            <ArrowSquareOut className="h-3.5 w-3.5" />
          </a>
        </div>
      ) : (
        <div className="grid min-w-[260px] gap-1.5">
          <Label htmlFor="sorting-guide-slug">Public address</Label>
          <div className="flex items-center gap-1 text-sm text-muted-foreground">
            <span>/p/</span>
            <Input id="sorting-guide-slug" className="h-8 w-56" value={slug} onChange={(event) => setSlug(event.target.value.trim())} aria-invalid={refusal !== null} />
            <span>/sorting</span>
          </div>
          {refusal !== null && <p className="text-xs text-destructive">{refusal}</p>}
        </div>
      )}
      {published !== null ? (
        <Button variant="outline" size="sm" disabled={disabled || saving} onClick={() => write(null)}>
          Unpublish
        </Button>
      ) : (
        <Button size="sm" disabled={disabled || saving || refusal !== null} onClick={() => write(slug)}>
          Publish
        </Button>
      )}
    </section>
  )
}
