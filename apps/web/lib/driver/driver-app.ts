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
// A photo or a signature (O1 of #290). The tap holds its bytes in the row, and
// the drain puts them to Storage before the batch that carries the command:
// `POST /driver/uploads` names the key and signs an upload URL, the bytes go
// to it, and the command, naming the key, goes in the batch. An object Storage
// holds already — a put whose answer was lost — is done. Out of reach on the
// way, what was tapped before it is sent and it and what follows wait, as for
// a batch, and the API's 401 waits for the session; any other refusal — a
// deployment without Storage (its 503 told by its type), a route no longer
// the driver's or no longer active, Storage refusing the bytes or its own
// URL — is the action's rejection, shown as the server's would be, and the
// rest goes. Once Storage has the bytes the row keeps the key alone.
//
// A command older than 48 h is still sent and comes back rejected, the
// recorded answer ADR-0004 wants.
//
// Positions (O8 of #290). While a route's screen is shown and the door's last
// read of it has this driver's session open and not paused — and no pause or
// end of it waits in the queue — the recorder (position-recorder.ts) watches
// the phone. Its open batch is the queue's one `collecting` row, rewritten on
// every kept fix, which the drain passes over and a reload closes into a
// command; a closed batch is a `record-positions` command minted then, so it
// takes its place in the queue's order at its close, and a pause or an
// end-route tap closes the open batch before the tap's own command. Positions
// are no action of the driver's: they are not counted among the actions
// waiting, nor is a rejection of one shown — the server keeps its receipt.
import type { DriverMe, DriverRouteDetail } from "@waste/contracts/driver-commands"

import type { ApiClient } from "../api/client"
import { problemSentence, type Problem } from "../api/problem"
import { problemOfError } from "../api/records/server-records"
import { createExternalStore, type ExternalStore } from "../external-store"
import type { CommandQueueStore, QueueEntry } from "./command-queue"
import { BATCH_LIMIT, createCommandIds, pickupIdOf, takesLocation, type ObjectKind, type PilotBody, type PilotCommand, type PilotCommandKind, type ProofBytes } from "./commands"
import { lookupFix } from "./location"
import { createPositionRecorder, sessionRecords, type PositionBatch, type PositionWatcher } from "./position-recorder"
import { NO_PROOF_STORAGE_TYPE, outOfReach, putObject, readDriverMe, readDriverRoute, sendCommands, signProofUpload } from "./reads"
import { BROWSER_TIMERS, type Timers } from "./timers"

/** How long the queue waits before trying again while anything waits. */
export const DRAIN_RETRY_MS = 30_000

/** How long a request may go unanswered before it counts as the server out of reach: a weak signal can hold a fetch open for minutes, and one batch in flight at a time would hold the queue with it. A batch the server did apply is replayed when it is sent again. */
export const REQUEST_TIMEOUT_MS = 30_000

/** How long a photo's bytes may take to reach Storage: a phone's JPEG is a few hundred kilobytes, which a weak signal carries in well under this. */
export const UPLOAD_TIMEOUT_MS = 120_000

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

/** What the server owns on a start, the key the API names for an object, and a position, which the controller adds: never part of a tap. */
type Added<Kind extends PilotCommandKind> = "location" | "accuracyM" | (Kind extends "start-route" ? "appVersion" : never) | (Kind extends ObjectKind ? "objectKey" : never)

/** One tap: the kind, the route, the body as the screen fills it, and a photo's or a signature's bytes. */
export type Tap = {
  [Kind in PilotCommandKind]: { kind: Kind; routeId: string; body: Omit<PilotBody<Kind>, Added<Kind>> } & (Kind extends ObjectKind ? { object: ProofBytes } : unknown)
}[PilotCommandKind]

export type DriverAppOptions = {
  /** The Command Queue's storage; a failure to open it leaves this page's commands in memory. */
  openQueue: () => Promise<CommandQueueStore>
  /** The phone's position: a lookup per located tap, and a watch while a session's route is on screen (O8 of #290). */
  geolocation?: (Pick<Geolocation, "getCurrentPosition"> & Partial<PositionWatcher>) | null
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
  /** The driver's own actions waiting: what the banner counts and a stop shows as sending, positions left out. */
  const actions = (): QueueEntry[] => mine().filter((entry) => entry.command.kind !== "record-positions")
  /** What the drain has to send: everything of the signed-in login's but the open batch. */
  const owing = (): QueueEntry[] => mine().filter((entry) => entry.state !== "collecting")
  const publishWaiting = () => store.set((state) => ({ ...state, waiting: actions() }))

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

  /** Queues a closed batch as a `record-positions` command of its own, minted now: its place in the queue's order is its close. */
  const queuePositions = async (owner: string, batch: PositionBatch) => {
    const command = { id: nextId(), kind: "record-positions", routeId: batch.routeId, occurredAt: new Date(now()).toISOString(), deviceId, body: { points: batch.points } } as PilotCommand
    const entry: QueueEntry = { owner, state: "ready", command }
    entries = [...entries, entry]
    await persist(entry)
  }

  /** The open batch's row, and whose it is: rewritten on every kept fix so a reload finds it. */
  let collecting: QueueEntry | null = null
  const recorder = createPositionRecorder({
    geolocation,
    now,
    timers,
    changed: (batch) => {
      const previous = collecting
      const owner = previous?.owner ?? session?.who
      if (batch === null || owner === undefined) {
        collecting = null
        if (previous !== null) {
          entries = entries.filter((entry) => entry !== previous)
          void forget([previous.command.id])
        }
        return
      }
      const id = previous?.command.id ?? nextId()
      const next: QueueEntry = { owner, state: "collecting", command: { id, kind: "record-positions", routeId: batch.routeId, occurredAt: new Date(now()).toISOString(), deviceId, body: { points: batch.points } } as PilotCommand }
      collecting = next
      entries = previous === null ? [...entries, next] : entries.map((entry) => (entry === previous ? next : entry))
      void persist(next)
    },
    closed: (batch) => {
      const owner = session?.who
      if (owner === undefined) return
      void queuePositions(owner, batch).then(drain)
    },
  })

  /**
   * The route to record for: one on screen whose last read has this
   * driver's session open and not paused, and no pause or end of which waits
   * in the queue — the tap that would stop it already made. The session's
   * start bounds the fixes, as the door does.
   */
  const recordingFor = (): { routeId: string; since: string } | null => {
    if (disposed || !loaded || !session?.client) return null
    const state = store.getSnapshot()
    const driverId = state.me?.driver.id
    for (const id of watched.keys()) {
      const read = state.routes[id]
      if (read?.status !== "ready") continue
      const open = read.detail.session
      if (open === null || !sessionRecords(read.detail, driverId)) continue
      if (mine().some((entry) => entry.command.routeId === id && (entry.command.kind === "pause" || entry.command.kind === "end-route"))) continue
      return { routeId: id, since: open.startedAt }
    }
    return null
  }
  const syncRecording = () => {
    const target = recordingFor()
    recorder.follow(target?.routeId ?? null, target?.since)
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
      // An open batch the last page left is closed into a command now, under an id of this page's: a reload while offline loses no fix.
      for (const entry of recovered.filter((candidate) => candidate.state === "collecting")) {
        entries = entries.filter((candidate) => candidate !== entry)
        await forget([entry.command.id])
        const points = entry.command.kind === "record-positions" ? entry.command.body.points : []
        if (points.length > 0) await queuePositions(entry.owner, { routeId: entry.command.routeId, points })
      }
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
  const withDeadline = async <Answer>(client: ApiClient, call: (client: ApiClient) => Promise<Answer>, ms = REQUEST_TIMEOUT_MS): Promise<Answer> => {
    const deadline = new AbortController()
    const handle = timers.set(() => deadline.abort(), ms)
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
      syncRecording()
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
      syncRecording()
      return true
    } catch (error) {
      const problem = problemOfError(error)
      if (problem.status !== 404) {
        failedRead(problem)
        return false
      }
      store.set((state) => ({ ...state, routes: { ...state.routes, [id]: { status: "missing", sentence: problemSentence(problem) } }, unreachable: false }))
      syncRecording()
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
    if (owing().length === 0) {
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

  /**
   * Puts an entry's bytes to Storage under the key the API names, and answers
   * the entry as it now stands, naming the key without the bytes; `refused`
   * once a refusal is the action's rejection and the entry has left the
   * queue; `unreachable` when the API or Storage could not be reached; null
   * when nothing may be sent now.
   */
  const upload = async (client: ApiClient, who: string, entry: QueueEntry, object: ProofBytes): Promise<QueueEntry | "refused" | "unreachable" | null> => {
    const { command } = entry
    let objectKey: string
    let atStorage = false
    try {
      const signed = await withDeadline(client, (under) => signProofUpload(under, { routeId: command.routeId, commandId: command.id, extension: object.extension }))
      objectKey = signed.objectKey
      if (signed.state === "upload") {
        atStorage = true
        await withDeadline(client, (under) => putObject(under, signed.uploadUrl, object), UPLOAD_TIMEOUT_MS)
      }
    } catch (error) {
      const problem = problemOfError(error)
      // The API's 401 waits for the session's refresh; Storage's own refuses the URL it signed, which no new token changes.
      if ((problem.status === 401 && !atStorage) || session?.who !== who) return null
      if (outOfReach(problem.status) && problem.type !== NO_PROOF_STORAGE_TYPE) {
        store.set((state) => ({ ...state, unreachable: true }))
        return "unreachable"
      }
      const sentence = atStorage ? `Storage refused the ${command.kind === "add-photo" ? "photo" : "signature"}: ${problemSentence(problem)}` : problemSentence(problem)
      const rejection: Rejection = { commandId: command.id, kind: command.kind, routeId: command.routeId, pickupId: pickupIdOf(command), sentence }
      entries = entries.filter((candidate) => candidate.command.id !== command.id)
      fresh.add(command.id)
      store.set((state) => ({ ...state, unreachable: false, rejections: [...state.rejections, rejection], waiting: actions() }))
      await forget([command.id])
      return "refused"
    }
    // Discarded meanwhile: nothing is written back.
    if (!entries.some((candidate) => candidate.command.id === command.id)) return null
    const uploaded: QueueEntry = { owner: entry.owner, state: entry.state, command: { ...command, body: { ...command.body, objectKey } } as PilotCommand }
    entries = entries.map((candidate) => (candidate.command.id === command.id ? uploaded : candidate))
    await persist(uploaded)
    return session?.who === who ? uploaded : null
  }

  const drainOnce = async (): Promise<void> => {
    const current = session
    if (!loaded || current?.client == null) return
    const sendable: QueueEntry[] = []
    for (const entry of mine()) {
      // The open batch is not sent as it stands, and holds nothing back: it takes its place in the order when it closes.
      if (entry.state === "collecting") continue
      if (entry.state !== "ready") break
      sendable.push(entry)
    }
    if (sendable.length === 0) return
    const batch = sendable.slice(0, BATCH_LIMIT)
    // A photo's or a signature's bytes reach Storage before the batch carrying its command is sent.
    let heldBack = false
    for (const [index, entry] of batch.entries()) {
      if (entry.object === undefined) continue
      const uploaded = await upload(current.client, current.who, entry, entry.object)
      if (uploaded === null) return
      if (uploaded === "refused") {
        again = true
        return
      }
      if (uploaded === "unreachable") {
        // What was tapped before it goes; it and what follows wait for the next try, and the banner with them.
        batch.splice(index)
        heldBack = true
        break
      }
      batch[index] = uploaded
    }
    if (batch.length === 0) return

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
      // A position refused is no action of the driver's to mend: the server keeps its receipt.
      if (row?.outcome !== "rejected" || entry.command.kind === "record-positions") return []
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
    store.set((state) => ({ ...state, unreachable: false, refused: null, rejections: [...state.rejections, ...rejections] }))
    await forget([...doneIds])
    // The answered leave the screen's queue once the route is read again, never before: off a read from before their answer a stop would offer again what was just done, and an arrival is applied twice.
    try {
      await refresh()
    } finally {
      store.set((state) => ({ ...state, waiting: actions(), ...(heldBack ? { unreachable: true } : {}) }))
    }
    if (!heldBack && sendable.length > batch.length) again = true
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
      // Another person, or none: the open batch is closed under the one who was signed in, and the recording stops until the next one's reads.
      if (before?.who !== next?.who) recorder.follow(null)
      session = next
      if (before?.who !== next?.who) {
        // Another person: nothing the last one read or was told stays on screen.
        aged.clear()
        fresh.clear()
        store.set({ ...INITIAL, waiting: actions() })
        if (loaded && next?.client) void refresh().then(drain)
        return
      }
      publishWaiting()
      syncRecording()
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
        syncRecording()
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
      // The fixes kept before a pause or the route's end go first, so the door takes them while the session still runs.
      if (tap.kind === "pause" || tap.kind === "end-route") recorder.close()
      const occurredAt = new Date(now()).toISOString()
      const id = nextId()
      const located = takesLocation(tap.kind)
      const object = "object" in tap ? tap.object : undefined
      // An object's key is the API's to name at the upload, which comes before the command is sent.
      const body = tap.kind === "start-route" && appVersion ? { ...tap.body, appVersion } : object === undefined ? tap.body : { ...tap.body, objectKey: "" }
      const command = { id, kind: tap.kind, routeId: tap.routeId, occurredAt, deviceId, body } as PilotCommand
      const entry: QueueEntry = { owner, state: located ? "location-pending" : "ready", command, ...(object === undefined ? {} : { object }) }
      entries = [...entries, entry]
      publishWaiting()
      await persist(entry)
      syncRecording()
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
      const discarded = owing().map((entry) => entry.command.id)
      const gone = new Set(discarded)
      entries = entries.filter((entry) => !gone.has(entry.command.id))
      store.set((state) => ({ ...state, refused: null, waiting: actions() }))
      await forget(discarded)
      scheduleRetry()
    },
    dispose: () => {
      disposed = true
      recorder.dispose()
      if (retryTimer !== null) timers.clear(retryTimer)
      retryTimer = null
      queue?.close()
    },
  }
}
