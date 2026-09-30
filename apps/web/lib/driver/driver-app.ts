// The Driver App apart from React (Issue #145, decided on #125): what the
// screens show and the Command Queue behind them, as one controller the
// provider (components/waste/driver/driver-app-provider.tsx) holds and its
// tests drive over a scripted door and fake-indexeddb — the way session.ts
// is to the sign-in.
//
// The server is the source of truth and the queue never is (CONTEXT.md,
// Command Queue; ADR-0004). So the screens show the door's last reads, and
// nothing a tap did until the server says so: there is no local `decide` and
// no display cache.
//
// A tap. The command's id (a UUIDv7, commands.ts) and its `occurredAt` are
// fixed at the tap and the command is persisted at once, `location-pending`
// when its kind carries a position; its stop shows it waiting. One lookup
// (location.ts) enriches it with a fix that comes within 3 s and is good
// enough, else it goes without one, and it turns `ready`. A page closed or
// reloaded mid-lookup loses nothing: the next page finds the row, and since a
// lookup does not outlive its page, sends it without a location.
//
// The drain. The whole queue — the signed-in login's part of it, so a phone
// handed on never sends one driver's actions under another's token — goes as
// one `POST /driver/commands` in id order, up to the door's two hundred and
// then the rest, stopping short of a command still waiting for its fix so the
// order holds. It runs on every tap, on load, on the browser's `online` and
// every 30 s while anything waits; one batch is in flight at a time, and a
// reason to drain that arrives meanwhile runs another after it. The answer:
//
//   200         — every command answered leaves the queue. `applied` and
//                 `replayed` are silent; `rejected` shows its sentence on the
//                 stop or the route it names, dismissible, until the next
//                 successful read after the one that follows the batch (the
//                 server holds its receipt and Resolution hears of it). Then
//                 the start screen and every route on screen are re-read;
//   out of reach — no answer, a timeout, a rate limit or a 5xx (reads.ts):
//                 everything stays, the banner says "Can't reach the server ·
//                 N actions waiting", and the triggers above try again;
//   401         — waits for the session's refresh or the sign-in, whose new
//                 token (`setSession`) drains at once;
//   any other   — the batch refused whole, a 400 on the envelope or the 403
//                 of a login that is not an active driver's: the sentence,
//                 and a confirmed Discard waiting actions, the only way a
//                 person empties the queue. The triggers keep trying.
//
// A command older than 48 h is still sent and comes back rejected, the
// recorded answer ADR-0004 wants.
import type { DriverMe, DriverRouteDetail } from "@waste/contracts/driver-commands"

import type { ApiClient } from "../api/client"
import { problemSentence, type Problem } from "../api/problem"
import { problemOfError } from "../api/records/server-records"
import { createExternalStore, type ExternalStore } from "../external-store"
import type { CommandQueueStore, QueueEntry } from "./command-queue"
import { BATCH_LIMIT, createCommandIds, pickupIdOf, takesLocation, type PilotBody, type PilotCommand, type PilotCommandKind } from "./commands"
import { lookupFix } from "./location"
import { outOfReach, readDriverMe, readDriverRoute, sendCommands } from "./reads"
import { BROWSER_TIMERS, type Timers } from "./timers"

/** How long the queue waits before trying again while anything waits. */
export const DRAIN_RETRY_MS = 30_000

/** How long a request may go unanswered before it counts as the server out of reach: a weak signal can hold a fetch open for minutes, and one batch in flight at a time would hold the queue with it. A batch the server did apply is replayed when it is sent again. */
export const REQUEST_TIMEOUT_MS = 30_000

/** Who is signed in — `whoOf` their session — and the client for their token, null while it has expired unrefreshed. */
export type DriverSession = { who: string; client: ApiClient | null }

/** A command the server rejected, shown on the stop it names or else on its route until the next successful read. */
export type Rejection = { commandId: string; kind: PilotCommandKind; routeId: string; pickupId: string | null; sentence: string }

/** A route on screen: the door's last read of it, or its sentence for a route it no longer answers for (cancelled, reassigned). */
export type RouteRead = { status: "ready"; detail: DriverRouteDetail } | { status: "missing"; sentence: string }

export type DriverAppState = {
  /**
   * `loading` until the start screen is first read; `ready` from then on,
   * whatever later reads answer; `unreachable` when the first read found no
   * server, which shows the count and Retry and no stale stop; `not-a-driver`
   * when the door refuses the login.
   */
  status: "loading" | "ready" | "unreachable" | "not-a-driver"
  /** The door's sentence for a login it refuses. */
  refusal: string | null
  me: DriverMe | null
  routes: Readonly<Record<string, RouteRead>>
  /** The signed-in login's queued commands, in order: "N actions waiting", and "Sending" on what they name. */
  waiting: readonly QueueEntry[]
  /** The last contact found no server: the banner. */
  unreachable: boolean
  /** The sentence of a batch refused whole, beside Discard waiting actions. */
  refused: string | null
  rejections: readonly Rejection[]
}

const INITIAL: DriverAppState = { status: "loading", refusal: null, me: null, routes: {}, waiting: [], unreachable: false, refused: null, rejections: [] }

/** What the server owns on a start, and a position, which the controller adds: never part of a tap. */
type Added<Kind extends PilotCommandKind> = "location" | "accuracyM" | (Kind extends "start-route" ? "appVersion" : never)

/** One tap: the kind, the route, and the body as the screen fills it. */
export type Tap = { [Kind in PilotCommandKind]: { kind: Kind; routeId: string; body: Omit<PilotBody<Kind>, Added<Kind>> } }[PilotCommandKind]

export type DriverAppOptions = {
  /** The Command Queue's storage; a failure to open it leaves this page's commands in memory. */
  openQueue: () => Promise<CommandQueueStore>
  geolocation?: Pick<Geolocation, "getCurrentPosition"> | null
  now?: () => number
  fill?: (bytes: Uint8Array) => Uint8Array
  timers?: Timers
  /** The web's build identifier, carried by `start-route` when the deployment exposes one. */
  appVersion?: string | null
  log?: (message: string, cause?: unknown) => void
}

export type DriverAppController = {
  readonly store: ExternalStore<DriverAppState>
  /** The session changed: a new person starts afresh, and a new token drains what waited for it. */
  setSession: (session: DriverSession | null) => void
  /** Opens the queue, reads the start screen and every route on screen, and drains. */
  load: () => Promise<void>
  /** A route is on screen: it is read now and after every batch until unwatched. */
  watchRoute: (id: string) => () => void
  /** Reads the start screen and every route on screen again. */
  refresh: () => Promise<void>
  /** Retry: a read, then a drain. */
  retry: () => Promise<void>
  /** Queues a command and answers its id once it is persisted. */
  tap: (tap: Tap) => Promise<string>
  drain: () => Promise<void>
  /** The browser's `online` event. */
  online: () => void
  dismiss: (commandId: string) => void
  /** Discard waiting actions: the signed-in login's queue, emptied. */
  discardWaiting: () => Promise<void>
  dispose: () => void
}

export function createDriverApp({ openQueue, geolocation = null, now = Date.now, fill, timers = BROWSER_TIMERS, appVersion = null, log = console.warn }: DriverAppOptions): DriverAppController {
  const store = createExternalStore<DriverAppState>(INITIAL)
  let session: DriverSession | null = null
  let queue: CommandQueueStore | null = null
  let opening: Promise<void> | null = null
  let deviceId = ""
  let nextId: () => string = () => {
    throw new Error("the Command Queue is not open")
  }
  /** Every row the database holds for this installation, whoever's, in id order. */
  let entries: QueueEntry[] = []
  const watched = new Map<string, number>()
  /** Rejections a successful read has already seen: the next one clears them. */
  const aged = new Set<string>()
  /** Rejections the drain in progress answered: kept through the reads of its own later batches, so none is read away before the drain is over. */
  const fresh = new Set<string>()
  /** A read the screens wait on that no token could make, or that the door answered 401: the next token makes it. */
  let owed = false
  let loaded = false
  let draining = false
  let again = false
  let retryTimer: unknown = null
  let disposed = false

  const mine = (): QueueEntry[] => (session === null ? [] : entries.filter((entry) => entry.owner === session?.who))
  const publishWaiting = () => store.set((state) => ({ ...state, waiting: mine() }))

  const persist = async (entry: QueueEntry) => {
    try {
      await queue?.put(entry)
    } catch (error) {
      log("the Command Queue could not write a command; it stays in this page's memory", error)
    }
  }
  const forget = async (ids: readonly string[]) => {
    if (ids.length === 0) return
    try {
      await queue?.remove(ids)
    } catch (error) {
      log("the Command Queue could not remove answered commands; the server replays them", error)
    }
  }

  const open = (): Promise<void> =>
    (opening ??= (async () => {
      try {
        queue = await openQueue()
      } catch (error) {
        log("the Command Queue could not be opened; this page keeps its commands in memory", error)
      }
      deviceId = queue?.deviceId ?? `web-${crypto.randomUUID()}`
      let stored: QueueEntry[] = []
      try {
        stored = (await queue?.list()) ?? []
      } catch (error) {
        log("the Command Queue could not be read", error)
      }
      // A lookup does not outlive its page: what the last page left looking goes without a location.
      const recovered = stored.map((entry): QueueEntry => (entry.state === "location-pending" ? { ...entry, state: "ready" } : entry))
      for (const [index, entry] of recovered.entries()) if (entry !== stored[index]) await persist(entry)
      entries = recovered
      nextId = createCommandIds({ now, ...(fill === undefined ? {} : { fill }), after: entries.at(-1)?.command.id })
      publishWaiting()
    })())

  const ageRejections = () => {
    store.set((state) => {
      const kept = state.rejections.filter((rejection) => fresh.has(rejection.commandId) || !aged.has(rejection.commandId))
      aged.clear()
      for (const rejection of kept) aged.add(rejection.commandId)
      return state.rejections.length === 0 ? state : { ...state, rejections: kept }
    })
  }

  /** A call under a deadline of its own: past it the request is aborted, which the client answers as the server out of reach. */
  const withDeadline = async <Answer>(client: ApiClient, call: (client: ApiClient) => Promise<Answer>): Promise<Answer> => {
    const deadline = new AbortController()
    const handle = timers.set(() => deadline.abort(), REQUEST_TIMEOUT_MS)
    try {
      return await call({ ...client, signal: deadline.signal })
    } finally {
      timers.clear(handle)
    }
  }

  /** Whether the start screen was read; a failure leaves the last read standing. */
  const readMe = async (client: ApiClient): Promise<boolean> => {
    try {
      const me = await withDeadline(client, readDriverMe)
      store.set((state) => ({ ...state, me, status: "ready", refusal: null, unreachable: false }))
      return true
    } catch (error) {
      failedRead(problemOfError(error))
      return false
    }
  }

  const readRoute = async (client: ApiClient, id: string): Promise<boolean> => {
    try {
      const detail = await withDeadline(client, (under) => readDriverRoute(under, id))
      store.set((state) => ({ ...state, routes: { ...state.routes, [id]: { status: "ready", detail } }, unreachable: false }))
      return true
    } catch (error) {
      const problem = problemOfError(error)
      if (problem.status !== 404) {
        failedRead(problem)
        return false
      }
      store.set((state) => ({ ...state, routes: { ...state.routes, [id]: { status: "missing", sentence: problemSentence(problem) } }, unreachable: false }))
      return true
    }
  }

  const failedRead = (problem: Problem) => {
    // A 401 waits for the session's refresh or the sign-in, whose token reads again.
    if (problem.status === 401) {
      owed = true
      return
    }
    if (problem.status === 403) {
      store.set((state) => ({ ...state, status: "not-a-driver", refusal: problemSentence(problem), me: null, routes: {} }))
      return
    }
    store.set((state) => ({ ...state, unreachable: true, status: state.me === null ? "unreachable" : state.status }))
  }

  const refresh = async (): Promise<void> => {
    if (!loaded) return
    const client = session?.client
    if (!client) {
      owed = true
      return
    }
    owed = false
    const reads = await Promise.all([readMe(client), ...[...watched.keys()].map((id) => readRoute(client, id))])
    if (reads.every(Boolean)) ageRejections()
  }

  const scheduleRetry = () => {
    if (disposed) return
    if (mine().length === 0) {
      if (retryTimer !== null) timers.clear(retryTimer)
      retryTimer = null
      return
    }
    if (retryTimer !== null) return
    retryTimer = timers.set(() => {
      retryTimer = null
      void drain()
    }, DRAIN_RETRY_MS)
  }

  const drainOnce = async (): Promise<void> => {
    const current = session
    if (!loaded || current?.client == null) return
    const sendable: QueueEntry[] = []
    for (const entry of mine()) {
      if (entry.state !== "ready") break
      sendable.push(entry)
    }
    if (sendable.length === 0) return
    const batch = sendable.slice(0, BATCH_LIMIT)

    let rows: unknown
    try {
      rows = (await withDeadline(current.client, (under) => sendCommands(under, batch.map((entry) => entry.command)))).outcomes
    } catch (error) {
      const problem = problemOfError(error)
      // A refusal of the last person's batch is nothing the next one is told.
      if (problem.status === 401 || session?.who !== current.who) return
      if (outOfReach(problem.status)) store.set((state) => ({ ...state, unreachable: true }))
      else store.set((state) => ({ ...state, refused: problemSentence(problem) }))
      return
    }
    // A 200 that is not the door's answer came from something in between; the commands are sent again and replayed.
    if (!Array.isArray(rows)) {
      store.set((state) => ({ ...state, unreachable: true }))
      return
    }
    const answered = new Map((rows as Array<{ commandId: string; outcome: string; problem?: Parameters<typeof problemSentence>[0] }>).map((row) => [row.commandId, row]))
    const done = batch.filter((entry) => answered.has(entry.command.id))
    const rejections: Rejection[] = done.flatMap((entry) => {
      const row = answered.get(entry.command.id)
      if (row?.outcome !== "rejected") return []
      const { id, kind, routeId } = entry.command
      return [{ commandId: id, kind, routeId, pickupId: pickupIdOf(entry.command), sentence: row.problem === undefined ? "The server rejected this action" : problemSentence(row.problem) }]
    })
    const doneIds = new Set(done.map((entry) => entry.command.id))
    entries = entries.filter((entry) => !doneIds.has(entry.command.id))
    if (session?.who !== current.who) {
      // Answered for someone no longer signed in here: the rows leave the queue, and nothing of the answer reaches the screen.
      await forget([...doneIds])
      return
    }
    for (const rejection of rejections) fresh.add(rejection.commandId)
    store.set((state) => ({ ...state, unreachable: false, refused: null, rejections: [...state.rejections, ...rejections], waiting: mine() }))
    await forget([...doneIds])
    await refresh()
    if (sendable.length > batch.length) again = true
  }

  const drain = async (): Promise<void> => {
    if (disposed) return
    if (draining) {
      again = true
      return
    }
    draining = true
    try {
      await open()
      do {
        again = false
        await drainOnce()
      } while (again && !disposed)
    } finally {
      draining = false
      fresh.clear()
      scheduleRetry()
    }
  }

  const locate = async (entry: QueueEntry) => {
    const fix = await lookupFix(geolocation, { now, timers })
    if (disposed) return
    const current = entries.find((candidate) => candidate.command.id === entry.command.id)
    // Discarded meanwhile, or already given up on.
    if (current === undefined || current.state !== "location-pending") return
    const ready: QueueEntry = { ...current, state: "ready", command: fix === null ? current.command : ({ ...current.command, body: { ...current.command.body, ...fix } } as PilotCommand) }
    entries = entries.map((candidate) => (candidate === current ? ready : candidate))
    publishWaiting()
    await persist(ready)
    void drain()
  }

  return {
    store,
    setSession: (next) => {
      const before = session
      session = next
      if (before?.who !== next?.who) {
        // Another person: nothing the last one read or was told stays on screen.
        aged.clear()
        fresh.clear()
        store.set({ ...INITIAL, waiting: mine() })
        if (loaded && next?.client) void refresh().then(drain)
        return
      }
      publishWaiting()
      if (!loaded || !next?.client || next.client === before?.client) return
      // A new token: what waited for one is sent, and what could not be read without one is read.
      const { status, unreachable } = store.getSnapshot()
      void (status === "ready" && !unreachable && !owed ? drain() : refresh().then(drain))
    },
    load: async () => {
      await open()
      loaded = true
      await refresh()
      void drain()
    },
    watchRoute: (id) => {
      watched.set(id, (watched.get(id) ?? 0) + 1)
      const client = session?.client
      if (loaded && client) void readRoute(client, id)
      else if (loaded) owed = true
      return () => {
        const count = (watched.get(id) ?? 1) - 1
        if (count > 0) watched.set(id, count)
        else watched.delete(id)
      }
    },
    refresh,
    retry: async () => {
      await refresh()
      await drain()
    },
    tap: async (tap) => {
      const owner = session?.who
      if (owner === undefined) throw new Error("Nobody is signed in")
      await open()
      const occurredAt = new Date(now()).toISOString()
      const id = nextId()
      const located = takesLocation(tap.kind)
      const body = tap.kind === "start-route" && appVersion ? { ...tap.body, appVersion } : tap.body
      const entry: QueueEntry = { owner, state: located ? "location-pending" : "ready", command: { id, kind: tap.kind, routeId: tap.routeId, occurredAt, deviceId, body } as PilotCommand }
      entries = [...entries, entry]
      publishWaiting()
      await persist(entry)
      if (located) void locate(entry)
      void drain()
      return id
    },
    drain,
    online: () => {
      void drain().then(() => {
        const { unreachable, status } = store.getSnapshot()
        if (unreachable || status !== "ready") return refresh()
      })
    },
    dismiss: (commandId) => {
      aged.delete(commandId)
      store.set((state) => ({ ...state, rejections: state.rejections.filter((rejection) => rejection.commandId !== commandId) }))
    },
    discardWaiting: async () => {
      const discarded = mine().map((entry) => entry.command.id)
      const gone = new Set(discarded)
      entries = entries.filter((entry) => !gone.has(entry.command.id))
      store.set((state) => ({ ...state, refused: null, waiting: mine() }))
      await forget(discarded)
      scheduleRetry()
    },
    dispose: () => {
      disposed = true
      if (retryTimer !== null) timers.clear(retryTimer)
      retryTimer = null
      queue?.close()
    },
  }
}
