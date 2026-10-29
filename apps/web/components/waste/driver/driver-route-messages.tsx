"use client"

// A route's messages on the Driver App's route screen (O24 of #290): the
// thread with the office, oldest first, read when the screen opens, every 30 s
// while it shows, and after each send; and the driver's box. A send keeps its
// device-minted id while its text is unchanged, so a send tried again after a
// lost answer is the same message, never a second. The rules are
// lib/driver/route-messages.ts's.

import { useEffect, useRef, useState } from "react"
import { ChatText, PaperPlaneRight } from "@phosphor-icons/react/dist/ssr"

import type { RouteMessage } from "@waste/contracts/route-messages"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useApiClient } from "@/components/waste/api-session-store"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import { authorLine, mintMessageId, readDriverRouteMessages, sendable, sendDriverRouteMessage } from "@/lib/driver/route-messages"

/** How often an open thread is read again. */
const THREAD_POLL_MS = 30_000

export function DriverRouteMessages({ routeId }: { routeId: string }) {
  const client = useApiClient()
  const [thread, setThread] = useState<RouteMessage[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [reading, setReading] = useState(0)
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  // The send in flight or last refused: its id is kept while its text is.
  const pending = useRef<{ id: string; text: string } | null>(null)

  useEffect(() => {
    if (client === null) return
    let current = true
    readDriverRouteMessages(client, routeId).then(
      (messages) => {
        if (!current) return
        setThread(messages)
        setProblem(null)
      },
      (error: unknown) => current && setProblem(problemSentence(problemOfError(error))),
    )
    return () => {
      current = false
    }
  }, [client, routeId, reading])
  useEffect(() => {
    const timer = setInterval(() => setReading((count) => count + 1), THREAD_POLL_MS)
    return () => clearInterval(timer)
  }, [])

  const send = () => {
    if (client === null || !sendable(text)) return
    const id = pending.current?.text === text ? pending.current.id : mintMessageId()
    pending.current = { id, text }
    setSending(true)
    sendDriverRouteMessage(client, routeId, { id, body: text })
      .then(
        () => {
          pending.current = null
          setText("")
          setProblem(null)
          setReading((count) => count + 1)
        },
        (error: unknown) => setProblem(`Not sent: ${problemSentence(problemOfError(error))}`),
      )
      .finally(() => setSending(false))
  }

  return (
    <section aria-label="Messages with the office" className="flex flex-col gap-3 rounded-xl border p-4">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <ChatText aria-hidden />
        Messages with the office
      </h2>
      {thread === null && problem === null && <p className="text-sm text-muted-foreground">Reading the messages…</p>}
      {thread !== null && thread.length === 0 && <p className="text-sm text-muted-foreground">No message yet.</p>}
      {thread !== null && thread.length > 0 && (
        <ol aria-label="Messages" className="flex flex-col gap-2">
          {thread.map((message) => (
            <li key={message.id} className={message.author === "driver" ? "ml-6 rounded-lg bg-muted px-3 py-2" : "mr-6 rounded-lg border px-3 py-2"}>
              <p className="text-xs text-muted-foreground">{authorLine(message)}</p>
              <p className="whitespace-pre-wrap text-sm">{message.body}</p>
            </li>
          ))}
        </ol>
      )}
      {problem !== null && <p className="text-sm text-destructive">{problem}</p>}
      <Textarea aria-label="Message to the office" rows={2} value={text} onChange={(event) => setText(event.target.value)} placeholder="Write to the office" />
      <Button className="h-11" disabled={sending || !sendable(text)} onClick={send}>
        <PaperPlaneRight aria-hidden />
        Send to the office
      </Button>
    </section>
  )
}
