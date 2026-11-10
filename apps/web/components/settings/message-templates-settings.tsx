"use client"

// Settings › Operations › Message templates (#291 C15): one project's
// templates at a time — e-mails and text messages, each for service (sent
// only where the customer allows service messages) or for billing — read
// from and written to the API's `/message-templates` under
// `configure.templates`. A template is retired by its status, never deleted,
// since the delivery log names it. The rules and the bodies are
// lib/data/message-templates.ts's. Offered on the Pilot alone, in place of
// the fixtures' Tickets & communication's templates. Below the table, the
// project's customer notices (O16 of #290, part b,
// customer-notices-section.tsx): which template each notice of a bulky
// collection is sent from.

import { PencilSimple, Plus } from "@phosphor-icons/react/dist/ssr"

import type { MessageTemplate } from "@waste/contracts/messaging"
import { AssetPanelShell, EmptyRow, RecordsSection } from "@/components/settings/settings-pane-kit"
import { ProjectPicker, useProjectSetting } from "@/components/settings/use-project-setting"
import { CustomerNoticesSection } from "@/components/settings/customer-notices-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { create, listAll, patch } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { notShownSentence, readSentence } from "@/lib/api/read-state"
import { useGrants } from "@/components/platform/use-grants"
import {
  CHANNEL_LABELS,
  isTemplateRefusal,
  NEW_TEMPLATE,
  PURPOSE_LABELS,
  templateCreateBody,
  templateDraftOf,
  templateLine,
  templatePatchBody,
  templatesAccessOf,
  type TemplateDraft,
  type TemplateRefusal,
} from "@/lib/data/message-templates"

export function MessageTemplatesSettings() {
  const access = templatesAccessOf(useGrants())
  const setting = useProjectSetting<MessageTemplate[], TemplateDraft, TemplateRefusal>({
    name: "message-templates",
    readable: access.view,
    read: (asking, projectId) => listAll<MessageTemplate>(asking, "/message-templates", { projectId }),
  })
  const { project, base, draft, refusal, saving } = setting
  const templates = base ?? []

  const open = (next: TemplateDraft) => setting.edit(next)
  const change = (values: Partial<TemplateDraft>) => draft !== null && setting.edit({ ...draft, ...values })

  const save = () => {
    if (project === null || draft === null) return
    const stored = draft.id === undefined ? undefined : templates.find((template) => template.id === draft.id)
    const body = stored === undefined ? templateCreateBody(project.id, draft) : templatePatchBody(stored, draft)
    if (isTemplateRefusal(body)) return setting.refuse(body)
    if (body === null) return setting.discard()
    setting.save(
      (client) => (stored === undefined ? create<MessageTemplate>(client, "/message-templates", body).then((made) => made.body) : patch<MessageTemplate>(client, `/message-templates/${stored.id}`, body)),
      { saved: (template) => ({ title: stored === undefined ? "Template added" : "Template saved", description: `${template.name}: ${templateLine(template)}.` }), failed: "The template was not saved" },
    )
  }

  const emptyMessage = !access.view
    ? notShownSentence("message templates")
    : project === null
      ? "No project to write templates for."
      : (readSentence({ problem: setting.problem && problemSentence(setting.problem), answered: base !== null }, "templates") ?? `${project.name} has no message template yet.`)

  return (
    <AssetPanelShell
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <ProjectPicker id="message-templates-project" setting={setting} />
        </div>
      }
    >
      <p className="border-b border-border px-4 py-3 text-sm text-muted-foreground">Messages go through a log-only sender for now: nothing reaches anyone yet.</p>
      <RecordsSection
        shown={templates.length}
        total={templates.length}
        actions={
          <Button size="sm" disabled={!access.create || project === null || base === null} onClick={() => open({ ...NEW_TEMPLATE })}>
            <Plus className="h-4 w-4" weight="bold" />
            Add template
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <Table className="min-w-[640px]" data-testid="message-templates">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Name</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Purpose</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.length === 0 ? (
                <EmptyRow colSpan={5} message={emptyMessage} hint={access.create && base !== null ? "Add a template for each message the office sends." : ""} />
              ) : (
                templates.map((template) => (
                  <TableRow key={template.id}>
                    <TableCell className="font-medium">{template.name}</TableCell>
                    <TableCell>{CHANNEL_LABELS[template.channel]}</TableCell>
                    <TableCell>{PURPOSE_LABELS[template.purpose]}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="rounded-full">
                        {template.status === "active" ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit ${template.name}`} disabled={!access.edit} onClick={() => open(templateDraftOf(template))}>
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
      {project !== null && base !== null && <CustomerNoticesSection key={project.id} project={project} templates={templates} access={access} />}
      {draft !== null && (
        <Dialog open onOpenChange={(isOpen) => !isOpen && setting.discard()}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>{draft.id === undefined ? "Add template" : "Edit template"}</DialogTitle>
              <DialogDescription>{project?.name}</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="template-name">Name</Label>
                <Input id="template-name" value={draft.name} aria-invalid={refusal?.field === "name"} onChange={(event) => change({ name: event.target.value })} />
                {refusal?.field === "name" && <p className="text-xs text-destructive">{refusal.message}</p>}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="template-channel">Channel</Label>
                  <Select value={draft.channel} onValueChange={(channel) => change({ channel: channel as TemplateDraft["channel"] })}>
                    <SelectTrigger id="template-channel">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(CHANNEL_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="template-purpose">Purpose</Label>
                  <Select value={draft.purpose} onValueChange={(purpose) => change({ purpose: purpose as TemplateDraft["purpose"] })}>
                    <SelectTrigger id="template-purpose">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(PURPOSE_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {draft.channel === "email" && (
                <div className="space-y-1.5">
                  <Label htmlFor="template-subject">Subject</Label>
                  <Input id="template-subject" value={draft.subject} aria-invalid={refusal?.field === "subject"} onChange={(event) => change({ subject: event.target.value })} />
                  {refusal?.field === "subject" && <p className="text-xs text-destructive">{refusal.message}</p>}
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="template-body">Message</Label>
                <Textarea id="template-body" rows={7} value={draft.body} aria-invalid={refusal?.field === "body"} onChange={(event) => change({ body: event.target.value })} />
                {refusal?.field === "body" && <p className="text-xs text-destructive">{refusal.message}</p>}
              </div>
              {draft.id !== undefined && (
                <div className="space-y-1.5">
                  <Label htmlFor="template-status">Status</Label>
                  <Select value={draft.status} onValueChange={(status) => change({ status: status as TemplateDraft["status"] })}>
                    <SelectTrigger id="template-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="inactive">Inactive — kept, not offered</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" disabled={saving} onClick={setting.discard}>
                Cancel
              </Button>
              <Button disabled={saving} onClick={save}>
                {draft.id === undefined ? "Add template" : "Save template"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </AssetPanelShell>
  )
}
