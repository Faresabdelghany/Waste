"use client"

// Settings › Message templates' customer notices on the Pilot (O16 of #290,
// part b): for the project picked above, which notice a Bulky Booking's
// customer is sent and from which template — booked, cancelled, collected,
// not collected — read from and saved whole to the API's
// `/projects/:id/notification-rules`. A notice with no template is not sent.
// The rules are lib/data/notification-rules.ts's.

import { useState } from "react"
import { FloppyDisk } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { MessageTemplate } from "@waste/contracts/messaging"
import type { CustomerNoticeEvent, NotificationRules } from "@waste/contracts/notifications"
import { useReport } from "@/components/insight/use-report"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useApiClient } from "@/components/waste/api-session-store"
import { get, put } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import { CUSTOMER_NOTICES, NOT_SENT, noticePicksOf, noticeRulesBody, noticeTemplateOptions } from "@/lib/data/notification-rules"

type Picks = Record<CustomerNoticeEvent, string>

const NOTICES_HINT = "What a bulky collection's customer is sent, and from which service template. A notice with no template is not sent; {{collectionDate}} is the collection's day."

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
  const options = noticeTemplateOptions(templates)

  const pick = (event: CustomerNoticeEvent, templateId: string) => {
    if (base === null || picks === null) return
    setEdits({ base, picks: { ...picks, [event]: templateId } })
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
              <Select value={picks[notice.event]} onValueChange={(templateId) => pick(notice.event, templateId)} disabled={!access.edit}>
                <SelectTrigger id={`notice-${notice.event}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NOT_SENT}>Not sent</SelectItem>
                  {options.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{notice.hint}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
