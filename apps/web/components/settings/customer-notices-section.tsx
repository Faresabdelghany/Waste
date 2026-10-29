"use client"

// Settings › Message templates' customer notices on the Pilot (O16 of #290,
// part b; C18 of #291): for the project picked above, which notice a customer
// is sent and from which template — a bulky collection booked, cancelled,
// collected, not collected; the collection reminder; a ticket's reply and
// completion; a route cancelled or running late — read from and saved whole
// to the API's `/projects/:id/notification-rules`. A notice with no template
// is not sent. A broadcast names the project's notification areas it
// reaches, read from `/planning-areas`; none is the whole project. The rules
// are lib/data/notification-rules.ts's.

import { useState } from "react"
import { FloppyDisk } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { MessageTemplate } from "@waste/contracts/messaging"
import type { CustomerNoticeEvent, NotificationRules } from "@waste/contracts/notifications"
import type { PlanningArea } from "@waste/contracts/planning-areas"
import { useReport } from "@/components/insight/use-report"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useApiClient } from "@/components/waste/api-session-store"
import { get, listAll, put } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import { CUSTOMER_NOTICES, isBroadcast, NOT_SENT, noticePicksOf, noticeRulesBody, noticeTemplateOptions, type NoticePick } from "@/lib/data/notification-rules"

type Picks = Record<CustomerNoticeEvent, NoticePick>

const NOTICES_HINT = "What a customer is sent, and from which service template. A notice with no template is not sent; a template is offered where its placeholders are the notice's."
const WHOLE_PROJECT = "No area ticked sends it across the whole project."

export function CustomerNoticesSection({ project, templates, access }: { project: { id: string; name: string }; templates: readonly MessageTemplate[]; access: { view: boolean; edit: boolean } }) {
  const client = useApiClient()
  const read = useReport<NotificationRules>(access.view ? `notification-rules:${project.id}` : null, (asking) => get<NotificationRules>(asking, `/projects/${project.id}/notification-rules`))
  // The set the last save answered, which stands for the read until another project is picked.
  const [answered, setAnswered] = useState<NotificationRules | null>(null)
  const base = answered !== null && answered.projectId === project.id ? answered : read.report
  const [edits, setEdits] = useState<{ base: NotificationRules; picks: Picks } | null>(null)
  const editing = edits !== null && edits.base === base
  const picks = editing ? edits.picks : base === null ? null : noticePicksOf(base)
  const [saving, setSaving] = useState(false)
  const areas = useReport<PlanningArea[]>(access.view ? `notification-areas:${project.id}` : null, (asking) => listAll<PlanningArea>(asking, "/planning-areas", { projectId: project.id, purpose: "notification" }))

  const pick = (event: CustomerNoticeEvent, change: Partial<NoticePick>) => {
    if (base === null || picks === null) return
    setEdits({ base, picks: { ...picks, [event]: { ...picks[event], ...change } } })
  }
  const toggleArea = (event: CustomerNoticeEvent, areaId: string, on: boolean) => {
    if (picks === null) return
    const held = picks[event].planningAreaIds.filter((id) => id !== areaId)
    pick(event, { planningAreaIds: on ? [...held, areaId] : held })
  }
  const save = () => {
    if (client === null || picks === null) return
    setSaving(true)
    put<NotificationRules>(client, `/projects/${project.id}/notification-rules`, noticeRulesBody(picks))
      .then(
        (saved) => {
          setAnswered(saved)
          setEdits(null)
          toast.success("Customer notices saved", { description: `${project.name} sends ${saved.rules.length === 0 ? "no notice" : saved.rules.length === 1 ? "one notice" : `${saved.rules.length} notices`}.` })
        },
        (error: unknown) => toast.error("The customer notices were not saved", { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setSaving(false))
  }

  if (!access.view) return null
  return (
    <section className="space-y-3 border-t border-border px-4 py-4" aria-labelledby="customer-notices" data-testid="customer-notices">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 id="customer-notices" className="text-sm font-semibold">
            Customer notices
          </h3>
          <p className="text-xs text-muted-foreground">{NOTICES_HINT}</p>
        </div>
        <div className="flex items-center gap-2">
          {editing && (
            <Button variant="outline" size="sm" disabled={saving} onClick={() => setEdits(null)}>
              Discard
            </Button>
          )}
          <Button size="sm" disabled={!access.edit || !editing || saving} onClick={save}>
            <FloppyDisk className="h-4 w-4" />
            Save notices
          </Button>
        </div>
      </div>
      {read.problem !== null && <p className="text-sm text-muted-foreground">The customer notices could not be read from the API: {problemSentence(read.problem)}</p>}
      {read.problem === null && picks === null && <p className="text-sm text-muted-foreground">Reading the customer notices from the API…</p>}
      {picks !== null && (
        <div className="grid gap-3 sm:grid-cols-2">
          {CUSTOMER_NOTICES.map((notice) => (
            <div key={notice.event} className="space-y-1.5">
              <Label htmlFor={`notice-${notice.event}`}>{notice.label}</Label>
              <Select value={picks[notice.event].templateId} onValueChange={(templateId) => pick(notice.event, { templateId })} disabled={!access.edit}>
                <SelectTrigger id={`notice-${notice.event}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NOT_SENT}>Not sent</SelectItem>
                  {noticeTemplateOptions(templates, notice.event).map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{notice.hint}</p>
              {isBroadcast(notice.event) && picks[notice.event].templateId !== NOT_SENT && (
                <fieldset className="space-y-1" data-testid={`notice-areas-${notice.event}`}>
                  <legend className="text-xs font-medium">Notification areas</legend>
                  {areas.problem !== null && <p className="text-xs text-muted-foreground">The notification areas could not be read: {problemSentence(areas.problem)}</p>}
                  {(areas.report ?? []).map((area) => (
                    <label key={area.id} className="flex items-center gap-2 text-xs">
                      <Checkbox checked={picks[notice.event].planningAreaIds.includes(area.id)} onCheckedChange={(checked) => toggleArea(notice.event, area.id, checked === true)} disabled={!access.edit} />
                      {area.name}
                    </label>
                  ))}
                  {areas.report !== null && areas.report.length === 0 && <p className="text-xs text-muted-foreground">The project has no notification areas; it is sent across the whole project.</p>}
                  {areas.report !== null && areas.report.length > 0 && <p className="text-xs text-muted-foreground">{WHOLE_PROJECT}</p>}
                </fieldset>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
