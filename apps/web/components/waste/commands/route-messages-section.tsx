"use client"

// A route's messages with its driver in the route's details on the Pilot (O24
// of #290): the thread oldest first, each line naming who wrote it and when on
// the project's clock, and the office's box beneath, which sends through the
// client and reads the thread again. The thread is read again every 30 s
// while the details are open, as the Live board is, so a driver's answer shows
// without a reload. The rules are lib/api/records/route-messages.ts's.

import { useEffect, useState } from "react"
import { PaperPlaneRight } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { RouteMessage } from "@waste/contracts/route-messages"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useApiClient } from "@/components/waste/api-session-store"
import { useRowHistory } from "@/components/waste/commands/use-command-support"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import { draftRefusal, messageLine, routeMessages, sendRouteMessage } from "@/lib/api/records/route-messages"
import { ROUTES_MODULE } from "@/lib/api/records/routes"
import { useServerModuleState } from "@/components/waste/business-record-store"

/** How often an open thread is read again. */
const THREAD_POLL_MS = 30_000

const readThread = (client: Parameters<typeof routeMessages>[0], serverId: string): Promise<RouteMessage[]> => routeMessages(client, serverId)

export function RouteMessagesSection({ record, timezone, canSend }: { record: BusinessRecord; timezone: string | undefined; canSend: boolean }) {
  const client = useApiClient()
  const serverId = useServerModuleState(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId)?.serverIds.get(record.id)
  const [version, setVersion] = useState(0)
  const thread = useRowHistory(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId, record, version, readThread)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  useEffect(() => {
    const timer = setInterval(() => setVersion((count) => count + 1), THREAD_POLL_MS)
    return () => clearInterval(timer)
  }, [])

  const refusal = draft.length === 0 ? null : draftRefusal(draft)
  const send = () => {
    if (client === null || serverId === undefined || draftRefusal(draft) !== null) return
    setSending(true)
    sendRouteMessage(client, serverId, draft)
      .then(
        () => {
          setDraft("")
          setVersion((count) => count + 1)
        },
        (error: unknown) => toast.error("The message was not sent", { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setSending(false))
  }

  return (
    <div className="space-y-2" data-testid="route-messages">
      <h4 className="text-xs font-medium text-muted-foreground">Messages with the driver</h4>
      {thread.problem !== null && <p className="text-sm text-muted-foreground">The messages could not be read: {thread.problem}</p>}
      {thread.problem === null && thread.rows === null && <p className="text-sm text-muted-foreground">Reading the route&apos;s messages…</p>}
      {thread.rows !== null && thread.rows.length === 0 && <p className="text-sm text-muted-foreground">No message yet between the office and the driver.</p>}
      {thread.rows !== null && thread.rows.length > 0 && (
        <ol aria-label="Messages with the driver" className="space-y-1.5">
          {thread.rows.map((message) => {
            const line = messageLine(message, timezone)
            return (
              <li key={message.id} className={line.fromDriver ? "rounded-md bg-muted/60 px-3 py-2" : "rounded-md border border-border/60 px-3 py-2"}>
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{line.who}</span>
                  <span>{line.when}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm">{line.body}</p>
              </li>
            )
          })}
        </ol>
      )}
      {canSend && (
        <div className="space-y-1.5">
          <Textarea aria-label="Message to the driver" rows={2} value={draft} aria-invalid={refusal !== null} onChange={(event) => setDraft(event.target.value)} placeholder="Write to the driver" />
          {refusal !== null && <p className="text-xs text-destructive">{refusal}</p>}
          <div className="flex justify-end">
            <Button size="sm" disabled={sending || draftRefusal(draft) !== null || serverId === undefined} onClick={send}>
              <PaperPlaneRight className="h-4 w-4" />
              Send to driver
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
