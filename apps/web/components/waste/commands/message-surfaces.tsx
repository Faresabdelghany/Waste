"use client"
// A customer's Messages in its details, on the Pilot (#291 C15): the newest
// of the delivery log — sent, queued, failed or withheld, with the reason —
// read from `GET /messages?customerId=` (records/messages.ts), and Send
// message: an active template of Settings › Message templates, sent to the
// customer or to one of its contact persons with an address on the
// template's channel, as the customer's action. The worker sends it through
// the log-only sender and judges the customer's consent at the send, so a
// new message reads Queued until the log is read again (Refresh). A role
// without `create` on the customers reads the log and is offered no send.
import { useState } from "react"
import { toast } from "sonner"

import { useReport } from "@/components/insight/use-report"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useApiSession } from "@/components/waste/api-session-store"
import { useBusinessRecordStore } from "@/components/waste/business-record-store"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { ReadRows } from "@/components/waste/commands/read-rows"
import { useModuleReady, useRowHistory } from "@/components/waste/commands/use-command-support"
import { allows } from "@/lib/api/grants"
import { problemSentence } from "@/lib/api/problem"
import { customerContacts } from "@/lib/api/records/customer-contacts"
import { activeTemplates, customerMessages, MESSAGE_STATUS_LABELS, messageLine, recipientOptions, sendMessage, type MessageDraft } from "@/lib/api/records/messages"
import { typed } from "@/lib/api/records/adapter"
import { CHANNEL_LABELS } from "@/lib/data/message-templates"
import { CONTACTS_MODULE } from "@/lib/data/properties"

const STATUS_TONES: Readonly<Record<string, string>> = {
  sent: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200",
  queued: "",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  withheld: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200",
}

/** A customer's newest messages, and the dialog that sends one. */
export function MessagesSurface({ record }: RowSurfaceProps) {
  const { sendAction } = useBusinessRecordStore()
  const { me } = useApiSession()
  const moduleReady = useModuleReady(CONTACTS_MODULE)
  const sends = me !== null && allows(me.role.grants, "customers.contacts", "create")
  const [version, setVersion] = useState(0)
  const messages = useRowHistory(CONTACTS_MODULE.workspaceId, CONTACTS_MODULE.moduleId, record, version, customerMessages)
  const contacts = useRowHistory(CONTACTS_MODULE.workspaceId, CONTACTS_MODULE.moduleId, record, version, customerContacts)
  const [draft, setDraft] = useState<MessageDraft | null>(null)
  const templates = useReport(draft === null ? null : `message-templates:active:${version}`, activeTemplates)
  const [busy, setBusy] = useState(false)

  const template = templates.report?.find((candidate) => candidate.id === draft?.templateId)
  const holder = { name: record.name, email: typed(record, "email") ?? null, phone: typed(record, "phone") ?? null }
  const options = template === undefined ? [] : recipientOptions(template.channel, holder, contacts.rows ?? [])

  const send = () => {
    if (draft === null || busy) return
    setBusy(true)
    void sendMessage(sendAction, record.id, draft).then((outcome) => {
      setBusy(false)
      if (outcome.kind !== "done") return
      setDraft(null)
      setVersion((count) => count + 1)
      toast.success("Message queued", { description: `To ${outcome.answer.recipient}. Refresh the log to see it sent.` })
    })
  }

  return (
    <section className="space-y-3" data-testid="customer-messages">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Messages</h3>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={messages.rows === null} onClick={() => setVersion((count) => count + 1)}>
            Refresh
          </Button>
          {sends && (
            <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setDraft({ templateId: "", recipient: "" })}>
              Send message
            </Button>
          )}
        </div>
      </div>
      <ReadRows
        read={messages}
        label="Reading the messages…"
        empty="No message has been sent to this customer."
        testId="customer-message-rows"
        line={(message) => (
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0">
              <span className="font-medium">{message.subject ?? message.body.slice(0, 60)}</span>
              <span className="block truncate text-muted-foreground">{messageLine(message)}</span>
            </span>
            <Badge variant="outline" className={`shrink-0 rounded-full ${STATUS_TONES[message.status] ?? ""}`}>
              {MESSAGE_STATUS_LABELS[message.status]}
            </Badge>
          </div>
        )}
      />
      {draft !== null && (
        <Dialog open onOpenChange={(open) => !open && setDraft(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Send a message to {record.name}</DialogTitle>
              <DialogDescription>A template of Settings › Message templates, to the customer or to one of its contact persons. Messages go through a log-only sender for now: nothing reaches anyone yet.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="message-template">Template</Label>
                <Select value={draft.templateId} onValueChange={(templateId) => setDraft({ templateId, recipient: "" })} disabled={templates.report === null}>
                  <SelectTrigger id="message-template">
                    <SelectValue placeholder={templates.problem !== null ? "Templates could not be read" : templates.report === null ? "Reading the templates…" : "Pick a template"} />
                  </SelectTrigger>
                  <SelectContent>
                    {(templates.report ?? []).map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.name} · {CHANNEL_LABELS[candidate.channel]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {templates.problem !== null && <p className="text-xs text-destructive">{problemSentence(templates.problem)}</p>}
                {templates.report !== null && templates.report.length === 0 && <p className="text-xs text-muted-foreground">No active template: add one in Settings › Message templates.</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="message-recipient">To</Label>
                <Select value={draft.recipient} onValueChange={(recipient) => setDraft({ ...draft, recipient })} disabled={template === undefined}>
                  <SelectTrigger id="message-recipient">
                    <SelectValue placeholder="Pick who it goes to" />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {template !== undefined && options.length === 0 && (
                  <p className="text-xs text-muted-foreground">Neither the customer nor an active contact person has {template.channel === "email" ? "an e-mail address" : "a phone number"}.</p>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button disabled={busy || draft.templateId === "" || draft.recipient === ""} onClick={send}>
                Send message
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
