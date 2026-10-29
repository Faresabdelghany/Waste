"use client"

// Settings › Personal › Notifications on the Pilot (O16 of #290): the staff
// e-mails a person asked for — an alert raised at or above a severity, a
// ticket assigned to them — read from and saved whole to the API's
// `/me/notification-preferences`, and the newest of the notices they were
// sent (`GET /me/notices`). Nothing is sent until asked for. The rules are
// lib/data/notification-preferences.ts's; fixture mode keeps the browser's
// pane.

import { useState } from "react"
import { ArrowClockwise, FloppyDisk } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { Message } from "@waste/contracts/messaging"
import type { NotificationPreferences } from "@waste/contracts/notifications"
import type { AlertSeverity } from "@waste/contracts/resolution"
import { useReport } from "@/components/insight/use-report"
import { AssetPanelShell } from "@/components/settings/asset-management-settings"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useApiClient, useApiSession } from "@/components/waste/api-session-store"
import { get, listPage, put } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import { ALERT_THRESHOLD_OPTIONS, alertsWithheldBecause, alertThresholdOf, noticeRowOf, preferencesBodyOf, type NO_ALERTS } from "@/lib/data/notification-preferences"

/** How many of the newest notices the pane shows. */
const NOTICES_SHOWN = 20

type Threshold = AlertSeverity | typeof NO_ALERTS

export function NotificationsSettingsOnApi() {
  const client = useApiClient()
  const { me } = useApiSession()
  const read = useReport<NotificationPreferences>(me === null ? null : "notification-preferences", (asking) => get<NotificationPreferences>(asking, "/me/notification-preferences"))
  const [reading, setReading] = useState(0)
  const notices = useReport(me === null ? null : `my-notices:${reading}`, (asking) => listPage<Message>(asking, "/me/notices", { limit: NOTICES_SHOWN }))
  // The set the last save answered, which stands for the read until the pane is opened again.
  const [answered, setAnswered] = useState<NotificationPreferences | null>(null)
  const base = answered ?? read.report
  // The choice as edited, held to the set it was edited from.
  const [edits, setEdits] = useState<{ base: NotificationPreferences; threshold: Threshold; ticketAssigned: boolean } | null>(null)
  const editing = edits !== null && edits.base === base
  const threshold: Threshold = editing ? edits.threshold : base === null ? "none" : alertThresholdOf(base)
  const ticketAssigned = editing ? edits.ticketAssigned : (base?.ticketAssigned ?? false)
  const [saving, setSaving] = useState(false)
  const withheld = alertsWithheldBecause(me?.role.grants)

  const change = (values: Partial<{ threshold: Threshold; ticketAssigned: boolean }>) => {
    if (base === null) return
    setEdits({ base, threshold, ticketAssigned, ...values })
  }
  const save = () => {
    if (client === null || base === null) return
    setSaving(true)
    put<NotificationPreferences>(client, "/me/notification-preferences", preferencesBodyOf(threshold, ticketAssigned))
      .then(
        (saved) => {
          setAnswered(saved)
          setEdits(null)
          toast.success("Notifications saved", { description: "From now on you are e-mailed as chosen." })
        },
        (error: unknown) => toast.error("Your notifications were not saved", { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setSaving(false))
  }

  const rows = (notices.shown?.items ?? []).map(noticeRowOf)

  return (
    <AssetPanelShell
      heading="Personal"
      title="Notifications"
      description="The e-mails you get when something needs you. Nothing is sent until you ask for it."
      action={
        <div className="flex items-center gap-2">
          {editing && (
            <Button variant="outline" size="sm" disabled={saving} onClick={() => setEdits(null)}>
              Discard
            </Button>
          )}
          <Button size="sm" disabled={!editing || saving} onClick={save}>
            <FloppyDisk className="h-4 w-4" />
            Save
          </Button>
        </div>
      }
      toolbar={null}
    >
      <section className="space-y-4 rounded-xl border border-border/60 p-4" aria-labelledby="notifications-choice">
        <h3 id="notifications-choice" className="text-sm font-semibold">
          E-mail me
        </h3>
        {read.problem !== null && <p className="text-sm text-muted-foreground">Your notifications could not be read: {problemSentence(read.problem)}</p>}
        {read.problem === null && base === null && <p className="text-sm text-muted-foreground">Reading your notifications…</p>}
        {base !== null && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="notifications-alerts">When an alert is raised</Label>
              <Select value={threshold} onValueChange={(value) => change({ threshold: value as Threshold })}>
                <SelectTrigger id="notifications-alerts" className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALERT_THRESHOLD_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{withheld ?? "In the projects you work in."}</p>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="notifications-assigned">When a ticket is assigned to me</Label>
              </div>
              <Switch id="notifications-assigned" checked={ticketAssigned} onCheckedChange={(checked) => change({ ticketAssigned: checked })} />
            </div>
          </>
        )}
      </section>

      <section className="space-y-3 rounded-xl border border-border/60 p-4" aria-labelledby="notifications-sent">
        <div className="flex items-center justify-between gap-2">
          <h3 id="notifications-sent" className="text-sm font-semibold">
            Sent to you
          </h3>
          <Button variant="outline" size="sm" onClick={() => setReading((count) => count + 1)} disabled={notices.loading}>
            <ArrowClockwise className="h-4 w-4" />
            Refresh
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">No e-mail provider is set up yet: a notice is recorded as sent without reaching an inbox.</p>
        {notices.problem !== null && <p className="text-sm text-muted-foreground">Your notices could not be read: {problemSentence(notices.problem)}</p>}
        {notices.shown !== null && rows.length === 0 && <p className="text-sm text-muted-foreground">Nothing has been sent to you.</p>}
        {rows.length > 0 && (
          <ol aria-label="Notices sent to you" className="divide-y divide-border/60 border-y border-border/60">
            {rows.map((row) => (
              <li key={row.id} className="space-y-1 py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm">{row.subject}</span>
                  <span className="text-xs text-muted-foreground">{row.status}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  To {row.to}
                  {row.reason !== null ? ` · ${row.reason}` : ""}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </AssetPanelShell>
  )
}
