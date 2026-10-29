"use client"

// Settings › Administration › Portals & branding on the Pilot (#487): what
// residents and drivers are given today, from the API's rows. Each project's
// public pages — the collection days, the drop-off points and the sorting
// guide (ADR-0010) — under the `publicSlug` it is published by, a write to
// `configure.organization` as Settings › Sorting guide's; and the Driver
// App's reach, the project's drivers with a login (`fleet.drivers`). The
// customer portal (C20–C22, #382–#384) and a project's branding (M22, #410)
// have no API yet and are not shown. Fixture mode keeps the browser's pane
// (`configure.portals`).

import { useState } from "react"
import { ArrowSquareOut } from "@phosphor-icons/react/dist/ssr"
import Link from "next/link"
import { toast } from "sonner"

import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/asset-management-settings"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useBusinessRecordStore, useModuleRecords, whenSaved } from "@/components/waste/business-record-store"
import { getModuleDefinition, type BusinessRecord } from "@/lib/data/business-modules"
import { driverAppReadingOf, publicPagesOf, publicSlugOf } from "@/lib/data/portals"
import { slugRefusalOf, slugSuggestionOf } from "@/lib/data/sorting-guide"
import { isSoftDeleted } from "@waste/domain/record-visibility"

const ORGANISATION_FIXTURES = getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? []
const DRIVER_FIXTURES = getModuleDefinition({ workspaceId: "fleet", moduleId: "drivers" })?.records ?? []

/** What the public door enforces for every published page, whatever is configured: true of `PUBLIC_DOOR_TABLES`. */
export const PUBLIC_DOOR_RULE = "A public page reads only the columns the public door is granted: an address and its collection days, the drop-off points and the guide. No customer, ticket, invoice, price, service provider or driver reaches it."

export function PortalsSettingsOnApi() {
  const organisation = useModuleRecords("configure", "organization", ORGANISATION_FIXTURES)
  const drivers = useModuleRecords("fleet", "drivers", DRIVER_FIXTURES)
  const projects = organisation.records.filter((record) => !isSoftDeleted(record) && record.id.startsWith("project-")).sort((a, b) => a.name.localeCompare(b.name))
  const [publishing, setPublishing] = useState<BusinessRecord | null>(null)
  const [saving, setSaving] = useState(false)
  const { upsertRecord } = useBusinessRecordStore()

  const write = (project: BusinessRecord, publicSlug: string | null, done?: () => void) => {
    const submittedValues = { ...project.submittedValues }
    if (publicSlug === null) delete submittedValues.publicSlug
    else submittedValues.publicSlug = publicSlug
    setSaving(true)
    whenSaved(
      upsertRecord("configure", "organization", { ...project, submittedValues }),
      () => {
        toast.success(publicSlug === null ? "Public pages closed" : "Public pages published", { description: publicSlug === null ? `${project.name}'s public pages are closed.` : `Residents find ${project.name} at /p/${publicSlug}.` })
        done?.()
      },
      () => setSaving(false),
    )
  }

  const emptyMessage = organisation.pending
    ? "Reading the projects from the API…"
    : organisation.notGranted
      ? "The projects are not shown to your role."
      : organisation.problem
        ? `The projects could not be read from the API: ${organisation.problem.detail ?? organisation.problem.title}`
        : "No projects yet."
  const driverReading = (projectId: string) =>
    drivers.notGranted ? "Not shown to your role" : drivers.pending ? "Reading…" : drivers.problem ? "Could not be read" : driverAppReadingOf(drivers.records, projectId)

  return (
    <AssetPanelShell heading="Administration" title="Portals & branding" description="What each project's residents find on its public pages, and which of its drivers use the Driver App." toolbar={null}>
      <p className="border-b border-border px-4 py-3 text-xs text-muted-foreground">{PUBLIC_DOOR_RULE}</p>
      <RecordsSection shown={projects.length} total={projects.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Project</TableHead>
                <TableHead>Public pages</TableHead>
                <TableHead>Driver App</TableHead>
                <TableHead className="w-28 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.length === 0 ? (
                <EmptyRow colSpan={4} message={emptyMessage} hint="Projects are created under Company & projects." />
              ) : (
                projects.map((project) => {
                  const slug = publicSlugOf(project)
                  return (
                    <TableRow key={project.id}>
                      <TableCell className="font-medium">{project.name}</TableCell>
                      <TableCell>
                        {slug === null ? (
                          <span className="text-sm text-muted-foreground">Not published</span>
                        ) : (
                          <div className="space-y-1">
                            <p className="text-sm">Published at /p/{slug}</p>
                            <div className="flex flex-wrap gap-x-3 gap-y-1">
                              {publicPagesOf(slug).map((page) => (
                                <a key={page.href} className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline" href={page.href} target="_blank" rel="noreferrer">
                                  {page.label}
                                  <ArrowSquareOut className="h-3 w-3" />
                                </a>
                              ))}
                            </div>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">{driverReading(project.id)}</TableCell>
                      <TableCell className="text-right">
                        {slug === null ? (
                          <Button size="sm" disabled={!organisation.ready || saving} onClick={() => setPublishing(project)} aria-label={`Publish ${project.name}`}>
                            Publish
                          </Button>
                        ) : (
                          <Button variant="outline" size="sm" disabled={!organisation.ready || saving} onClick={() => write(project, null)} aria-label={`Unpublish ${project.name}`}>
                            Unpublish
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </RecordsSection>
      <p className="px-4 py-3 text-xs text-muted-foreground">
        A driver signs in to the <Link className="text-primary underline-offset-4 hover:underline" href="/driver">Driver App</Link> with the login their profile under Fleet › Drivers names.
      </p>
      {publishing !== null && <PublishDialog key={publishing.id} project={publishing} saving={saving} onClose={() => setPublishing(null)} onPublish={(slug) => write(publishing, slug, () => setPublishing(null))} />}
    </AssetPanelShell>
  )
}

function PublishDialog({ project, saving, onClose, onPublish }: { project: BusinessRecord; saving: boolean; onClose: () => void; onPublish: (slug: string) => void }) {
  const [slug, setSlug] = useState(() => slugSuggestionOf(project.name))
  const refusal = slugRefusalOf(slug)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (refusal === null) onPublish(slug)
          }}
        >
          <DialogHeader>
            <DialogTitle>Publish {project.name}</DialogTitle>
            <DialogDescription>Its collection days, drop-off points and sorting guide open to residents under this address.</DialogDescription>
          </DialogHeader>
          <div className="my-4 grid gap-1.5">
            <Label htmlFor="portal-slug">Public address</Label>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <span>/p/</span>
              <Input id="portal-slug" className="h-8" value={slug} onChange={(event) => setSlug(event.target.value.trim())} aria-invalid={refusal !== null} />
            </div>
            {refusal !== null && <p className="text-xs text-destructive">{refusal}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || refusal !== null}>
              Publish
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
