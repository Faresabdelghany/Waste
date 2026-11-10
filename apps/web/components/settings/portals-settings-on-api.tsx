"use client"

// Settings › Administration › Portals & branding on the Pilot (#487): what
// residents and drivers are given today, from the API's rows. Each project's
// public pages — the collection days and the drop-off points (ADR-0010) —
// under the `publicSlug` it is published by, a write to
// `configure.organization`; and the Driver App's reach, the project's
// drivers with a login (`fleet.drivers`); and
// each project's branding on those pages (M22 of #293): one colour behind
// white text, held to WCAG 2.1 AA's contrast before the API is asked, a logo
// and an accessibility statement it serves itself, written whole through
// `PUT /projects/:id/branding` under `edit` on `configure.portals`
// (lib/data/project-branding.ts). The customer portal (C20–C22, #382–#384)
// has no API yet and is not shown.

import { useState } from "react"
import { ArrowSquareOut, PencilSimple } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/settings-pane-kit"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiClient } from "@/components/platform/api-session-store"
import { useBusinessRecordStore, useModuleRecords, useServerModuleState, whenSaved } from "@/components/platform/business-record-store"
import { mayOn } from "@/lib/modules/grants"
import { problemOfError, problemSentence } from "@/lib/api/problem"
import { BRANDING_MODULE, replaceBranding } from "@/lib/api/project-branding"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { driverAppReadingOf, publicPagesOf, publicSlugOf, slugRefusalOf, slugSuggestionOf } from "@/lib/data/portals"
import { addressRefusalOf, brandColorRefusalOf, brandingFormOf, brandingFromForm, brandingOf, contrastLabelOf, type BrandingForm } from "@/lib/data/project-branding"
import { isSoftDeleted } from "@/lib/prototype/record-visibility"
import { moduleReadSentence } from "@/lib/api/read-state"
import { useGrants } from "@/components/platform/use-grants"

export function PortalsSettingsOnApi() {
  const organisation = useModuleRecords("configure", "organization")
  const drivers = useModuleRecords("fleet", "drivers")
  const projects = organisation.records.filter((record) => !isSoftDeleted(record) && record.id.startsWith("project-")).sort((a, b) => a.name.localeCompare(b.name))
  const [publishing, setPublishing] = useState<BusinessRecord | null>(null)
  const [branding, setBranding] = useState<BusinessRecord | null>(null)
  const brands = mayOn(useGrants(), BRANDING_MODULE, "edit")
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

  const emptyMessage = moduleReadSentence(organisation, "projects") ?? "No projects yet."
  const driverReading = (projectId: string) =>
    drivers.notGranted ? "Not shown to your role" : drivers.pending ? "Reading…" : drivers.problem ? "Could not be read" : driverAppReadingOf(drivers.records, projectId)

  return (
    <AssetPanelShell toolbar={null}>
      <RecordsSection shown={projects.length} total={projects.length}>
        <div className="overflow-x-auto">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Project</TableHead>
                <TableHead>Public pages</TableHead>
                <TableHead>Branding</TableHead>
                <TableHead>Driver App</TableHead>
                <TableHead className="w-28 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.length === 0 ? (
                <EmptyRow colSpan={5} message={emptyMessage} />
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
                      <TableCell>
                        <BrandingSummary project={project} onEdit={brands ? () => setBranding(project) : undefined} disabled={!organisation.ready} />
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
      {branding !== null && <BrandingDialog key={branding.id} project={branding} onClose={() => setBranding(null)} />}
      {publishing !== null && <PublishDialog key={publishing.id} project={publishing} saving={saving} onClose={() => setPublishing(null)} onPublish={(slug) => write(publishing, slug, () => setPublishing(null))} />}
    </AssetPanelShell>
  )
}

function PublishDialog({ project, saving, onClose, onPublish }: { project: BusinessRecord; saving: boolean; onClose: () => void; onPublish: (slug: string) => void }) {
  const [slug, setSlug] = useState(() => slugSuggestionOf(project.name))
  const refusal = slugRefusalOf(slug)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (refusal === null) onPublish(slug)
          }}
        >
          <DialogHeader>
            <DialogTitle>Publish {project.name}</DialogTitle>
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

function BrandingSummary({ project, onEdit, disabled }: { project: BusinessRecord; onEdit?: () => void; disabled: boolean }) {
  const branding = brandingOf(project)
  const parts = [branding.logoUrl === null ? null : "Logo", branding.accessibilityStatementUrl === null ? null : "Accessibility statement"].filter((part): part is string => part !== null)
  return (
    <div className="flex items-center gap-2">
      {branding.brandColor !== null && <span className="inline-block h-4 w-4 shrink-0 rounded-sm border" style={{ backgroundColor: branding.brandColor }} aria-hidden="true" />}
      <span className="text-sm">{branding.brandColor === null && parts.length === 0 ? "None" : [branding.brandColor, ...parts].filter(Boolean).join(" · ")}</span>
      {onEdit !== undefined && (
        <Button variant="ghost" size="icon" aria-label={`Edit ${project.name}'s branding`} disabled={disabled} onClick={onEdit}>
          <PencilSimple className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}

function BrandingDialog({ project, onClose }: { project: BusinessRecord; onClose: () => void }) {
  const client = useApiClient()
  const state = useServerModuleState("configure", "organization")
  const { refreshModule } = useBusinessRecordStore()
  const [form, setForm] = useState<BrandingForm>(() => brandingFormOf(brandingOf(project)))
  const [saving, setSaving] = useState(false)
  const body = brandingFromForm(form)
  const serverId = state?.serverIds.get(project.id)
  const colorRefusal = brandColorRefusalOf(form.brandColor)
  const logoRefusal = addressRefusalOf(form.logoUrl)
  const statementRefusal = addressRefusalOf(form.accessibilityStatementUrl)
  const contrast = contrastLabelOf(form.brandColor)

  const save = () => {
    if (client === null || serverId === undefined || body === null) return
    setSaving(true)
    replaceBranding(client, serverId, body).then(
      () => {
        toast.success("Branding saved", { description: `${project.name}'s public pages show it from the next visit.` })
        void refreshModule("configure", "organization")
        onClose()
      },
      (error: unknown) => {
        setSaving(false)
        toast.error("The branding was not saved", { description: problemSentence(problemOfError(error)) })
      },
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <DialogHeader>
            <DialogTitle>{project.name}&apos;s branding</DialogTitle>
          </DialogHeader>
          <div className="my-4 grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="branding-color">Brand colour</Label>
              <Input id="branding-color" placeholder="#1f6f3f" value={form.brandColor} aria-invalid={colorRefusal !== null} onChange={(event) => setForm({ ...form, brandColor: event.target.value })} />
              {colorRefusal !== null ? <p className="text-xs text-destructive">{colorRefusal}</p> : contrast !== null && <p className="text-xs text-muted-foreground">{contrast}</p>}
              {contrast !== null && colorRefusal === null && (
                <div className="rounded-md px-3 py-2 text-sm font-medium" style={{ backgroundColor: form.brandColor.trim(), color: "#ffffff" }} data-testid="branding-preview">
                  {project.name}
                </div>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="branding-logo">Logo address</Label>
              <Input id="branding-logo" placeholder="https://kk.dk/logo.svg" value={form.logoUrl} aria-invalid={logoRefusal !== null} onChange={(event) => setForm({ ...form, logoUrl: event.target.value })} />
              {logoRefusal !== null && <p className="text-xs text-destructive">{logoRefusal}</p>}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="branding-statement">Accessibility statement address</Label>
              <Input id="branding-statement" placeholder="https://was.digst.dk/…" value={form.accessibilityStatementUrl} aria-invalid={statementRefusal !== null} onChange={(event) => setForm({ ...form, accessibilityStatementUrl: event.target.value })} />
              {statementRefusal !== null && <p className="text-xs text-destructive">{statementRefusal}</p>}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || body === null || serverId === undefined}>
              Save branding
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

