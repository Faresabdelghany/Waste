// The record store's controller (Issue #81): the server-backed half of what
// `components/platform/business-record-store.tsx` answers, framework-free as the
// Driver App's controller is (`createDriverApp`). It holds a session's
// switched modules and runs everything that moves them — the session's load,
// a write and its turn, a command, an action, a row or a module read again,
// and the watcher that reads a module again for what it read or the day it
// read — on the rules of `server-records.ts`. The provider subscribes to its
// stores and binds its operations to hooks; what a person is told, the
// provider's notices say.
import type { Me } from "@waste/contracts/me"

import type { BusinessRecord, WorkspaceId } from "@/lib/data/business-modules"

import { UNREACHABLE_STATUS, type ApiClient } from "../client"
import { createExternalStore, type ExternalStore } from "../../external-store"
import { genericProblem, isAccountRefusal, problemOfError, type Problem } from "../problem"
import { moduleKeyOf, type CommandInput, type ServerModule } from "./adapter"
import { withMeProjects, type MeProject } from "./me-projects"
import { MODULES_WITHOUT_ME, SERVER_MODULES, serverModuleOf, viewableModules } from "./modules"
import { organisationModule } from "./organisation"
import {
  actOnRecord,
  adapterFor,
  clocksRead,
  commandRecord,
  dayTurnRereads,
  readModuleInto,
  readsChanged,
  readSourcesNow,
  rereadRecord,
  rereadsOf,
  sameSources,
  untilDayTurns,
  withNotGranted,
  withOutcome,
  withRecord,
  writeRecord,
  type ActionOutcome,
  type CommandOutcome,
  type RereadOutcome,
  type SendAction,
  type ServerRecordsState,
  type WriteOutcome,
} from "./server-records"
import { sessionEnded, writeRouteOf } from "./write-gate"

/** What the store tells a person, in the provider's words and place. */
export type RecordStoreNotices = {
  /** A refusal in the API's words, under the heading it was refused under: a write's, a command's, a read's. */
  refused: (what: string, problem: Problem) => void
  /** A write the API took whose answer could not be shown (#243): saved, never a refusal, so nobody sends it again. */
  landed: (name: string) => void
  /** A command whose movement landed but whose row could not be read, even again (#263): done, so nobody sends it a second time. */
  landedCommand: (name: string) => void
  /** A write refused before it was sent, its module not read (#243): one notice per module, which a sync of many of its rows replaces rather than stacks. */
  unsent: (moduleKey: string, name: string, problem: Problem) => void
}

/** The controller's state, which its operations and the provider's hooks read. */
export type RecordStoreState = {
  /**
   * The server-backed modules (Issue #81): one entry per switched
   * `workspace.module`, each the server's rows as the prototype shows them
   * once its read has landed. Empty while the adapter is off or nobody is
   * signed in. Until a module is `ready`, `getRecords` answers nothing of it
   * — no API configured, its load pending or failed, or the role not viewing
   * it — and a write made to it is refused (`writeRouteOf`, #243), never kept
   * in the browser's bucket.
   */
  server: ExternalStore<ServerRecordsState>
  /**
   * The client the writes go through; null when there is none. Held here so a
   * write and a load in flight read the current one when they run: it follows
   * every token refresh, while the load does not.
   */
  client: ExternalStore<ApiClient | null>
  /**
   * Writes and commands in flight, by web id, so a second save of a row
   * whose first has not answered waits its turn rather than racing it to the
   * API, and a command on a row whose create is out waits for its server id.
   * One map for the whole store, since two components may write the same
   * row.
   */
  pendingWrites: Map<string, Promise<unknown>>
  /**
   * Module reads in flight, by module key — the load's, and a read again
   * after a command (Issue #198) — so a read asked for while another of the
   * module is out follows it, and the rows that land last are the newest.
   */
  pendingReads: Map<string, Promise<unknown>>
  /**
   * Which session the server-backed modules belong to: one more each time
   * the person signed in changes (a sign-out, a sign-in as someone else). A
   * write remembers the one it began in, and an answer that arrives after it
   * changed is dropped: it would put the last person's rows back in front of
   * the next one.
   */
  generation: ExternalStore<number>
  /**
   * The signal of the session's load, aborted when the person or the API
   * changes: a module read again after a command goes out under it, so a
   * read the session outlives is abandoned as the load is (Issue #198).
   */
  sessionSignal: ExternalStore<AbortSignal | null>
  /** Whether the session's load is still reading its modules: a module read again for what it read waits for it, since a module the load has yet to read may answer what the mapping missed. */
  loading: ExternalStore<boolean>
}

/** The state and the notices: what the controller's operations run over. */
export type RecordStoreContext = RecordStoreState & { notices: RecordStoreNotices }

/** A write's options: `report: false` leaves a refusal to the caller; `reason` rides in the change-reason header (#291). */
export type WriteOptions = { report?: boolean; reason?: string }

/** Where a write goes and what the module is called where it is refused before it is sent. */
export type WriteTarget = { apiConfigured: boolean; label: string }

export type RecordStore = RecordStoreContext & {
  /**
   * Reads the session's switched modules, or empties them where nobody is
   * signed in; answers the stop, which aborts what is still out. See
   * `startSession`.
   */
  startSession: (signedIn: boolean, loadMe: () => Promise<Me>) => () => void
  /** Reads a module again for what it read or the day it read; answers the stop. See `watchReads`. */
  watch: (options?: WatchOptions) => () => void
  /**
   * Saves a record of a switched module through the API, optimistic and
   * reconciled, its turn after the writes of the same row; refused at once
   * where the API has not read the module (`writeRouteOf`). Undefined for a
   * module on the browser's own path, which the provider's bucket keeps.
   */
  write: (workspaceId: WorkspaceId, moduleId: string, record: BusinessRecord, target: WriteTarget, options?: WriteOptions) => Promise<WriteOutcome> | undefined
  /** Sends one of a row's commands on a switched module that is ready and puts the API's answer in the row's place. */
  sendCommand: (workspaceId: WorkspaceId, moduleId: string, recordId: string, name: string, input?: CommandInput) => Promise<CommandOutcome>
  /** Sends one of a row's actions and hands back what it answered; the row stays as it is. */
  sendAction: SendAction
  /** Reads one row of a switched module back from the API, for a row the server changed on its own account. */
  refreshRecord: (workspaceId: WorkspaceId, moduleId: string, recordId: string) => Promise<RereadOutcome>
  /** Reads a switched module again whole, while it is ready. */
  refreshModule: (workspaceId: WorkspaceId, moduleId: string) => Promise<void>
}

const NO_SERVER_MODULES: ServerRecordsState = new Map()

/** A controller with an empty store, telling a person what it reports through `notices`. */
export function createRecordStore(notices: RecordStoreNotices): RecordStore {
  const context: RecordStoreContext = {
    server: createExternalStore<ServerRecordsState>(NO_SERVER_MODULES),
    client: createExternalStore<ApiClient | null>(null),
    pendingWrites: new Map(),
    pendingReads: new Map(),
    generation: createExternalStore(0),
    sessionSignal: createExternalStore<AbortSignal | null>(null),
    loading: createExternalStore(false),
    notices,
  }
  return {
    ...context,
    startSession: (signedIn, loadMe) => startSession(context, signedIn, loadMe),
    watch: (options) => watchReads(context, options),
    write: (workspaceId, moduleId, record, target, options) => write(context, workspaceId, moduleId, record, target, options),
    sendCommand: (workspaceId, moduleId, recordId, name, input) => sendCommand(context, workspaceId, moduleId, recordId, name, input),
    sendAction: (workspaceId, moduleId, recordId, name, input, options) => sendAction(context, workspaceId, moduleId, recordId, name, input, options),
    refreshRecord: (workspaceId, moduleId, recordId) => refreshRecord(context, workspaceId, moduleId, recordId),
    refreshModule: (workspaceId, moduleId) => refreshModule(context, workspaceId, moduleId),
  }
}

/**
 * Runs `turn` after the turns in flight under the same key, and holds the
 * key until it settles: two saves of one row take turns, a command on a row
 * whose create is out waits for its server id, and a module read again
 * after a command waits for the read of it already out.
 */
function enqueue<T>(pending: Map<string, Promise<unknown>>, key: string, turn: () => Promise<T>): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve()
  const next: Promise<T> = previous.then(turn, turn).finally(() => {
    if (pending.get(key) === next) pending.delete(key)
  })
  pending.set(key, next)
  return next
}

/** A module's read the API refused or did not answer, told as the load tells it; the account's own refusal is /login's to say. */
function reportRead(context: RecordStoreContext, key: string, problem: Problem) {
  if (!isAccountRefusal(problem)) context.notices.refused(`${key} could not be read from the API`, problem)
}

/**
 * The session's switched modules. They follow the session, not the token:
 * they load once when a person is signed in against an API, and again only
 * when the API or the person changes — a token refresh, which happens every
 * hour, changes neither and reloads nothing, since a request in flight reads
 * the current client at the moment it is sent. No session (signed out,
 * adapter off, expired and not refreshed) empties them. The switched modules
 * load in SERVER_MODULES' order, one after the other, so a later module's
 * mapping resolves the earlier ones' rows (a user names its role and its
 * projects); each lands as it arrives, and a module that fails is reported
 * once and shows no rows — unless the API refused the account itself (Issue
 * #150): the client has ended the session by then, so the load stops there,
 * reported nowhere but /login. Only the modules the person's `/me` role
 * grants `view` on are read (`viewableModules`, Issue #145); the rest are
 * never requested and are marked not granted, told to nobody (Issue #200), so
 * nobody meets a refusal for a pane they cannot open and a pane they do open
 * says why it is empty. A `/me` that cannot be read leaves the grants
 * unknown, and every module is tried as before but a provider's own
 * (`MODULES_WITHOUT_ME`, #291 C24). A load the session outlives — the person
 * signs out mid-way — is aborted by the stop, not left to finish into a store
 * that no longer wants it, and a write it outlives is dropped when it answers
 * (`generation`). Every change of person or API empties the modules first, a
 * sign-in as someone else included: the last person's rows are never shown
 * under the next one while theirs load.
 */
export function startSession(context: RecordStoreContext, signedIn: boolean, loadMe: () => Promise<Me>): () => void {
  const { server } = context
  context.generation.set((generation) => generation + 1)
  server.set(NO_SERVER_MODULES)
  if (!signedIn) return () => {}
  const initial = context.client.getSnapshot()
  if (initial === null) return () => {}
  const controller = new AbortController()
  context.sessionSignal.set(controller.signal)
  context.loading.set(true)
  const run = async () => {
    let modules = MODULES_WITHOUT_ME
    let projects: readonly MeProject[] | undefined
    try {
      const me = await loadMe()
      modules = viewableModules(me.role.grants, SERVER_MODULES, { provider: me.serviceProvider !== null })
      projects = me.projects
    } catch (error) {
      // The account's refusal has ended the session; anything else leaves the grants unknown.
      if (controller.signal.aborted || isAccountRefusal(problemOfError(error))) return
    }
    if (controller.signal.aborted) return
    server.set((state) => {
      const marked = withNotGranted(state, SERVER_MODULES.filter((module) => !modules.includes(module)))
      // Where the role does not view the organisation, a row's project resolves through `/me`'s projects (Issue #217).
      return projects !== undefined && !modules.includes(organisationModule) ? withMeProjects(marked, projects) : marked
    })
    for (const module of modules) {
      if (controller.signal.aborted) return
      const key = moduleKeyOf(module.workspaceId, module.moduleId)
      // The one read a module has, which a read again after a command
      // (Issue #198) takes too, one after the other. The token as it stands
      // when this module's read is sent; the one the session began with if
      // it lapsed under it, so the read goes out and the API's refusal is
      // reported rather than nothing at all.
      const problem = await enqueue(context.pendingReads, key, () =>
        readModuleInto(server, { ...(context.client.getSnapshot() ?? initial), signal: controller.signal }, module, {
          alive: () => !controller.signal.aborted,
        }),
      )
      if (controller.signal.aborted) return
      if (problem === null) continue
      if (isAccountRefusal(problem)) return
      reportRead(context, key, problem)
    }
  }
  void run().finally(() => {
    if (!controller.signal.aborted) context.loading.set(false)
  })
  return () => {
    controller.abort()
    context.loading.set(false)
  }
}

/**
 * Reads a module again after a command changed its rows (Issue #198), under
 * the load's rules: after any read of it already out, only while the store
 * holds it ready and the command's session is the current one, under the
 * session's signal — with the token as it stands, or the command's own if
 * the session lapsed under it, so the read goes out and a refusal is told —
 * and a failure reported as the load reports one. The module keeps its rows
 * while the read is out.
 */
function rereadModule(context: RecordStoreContext, module: ServerModule, outlived: () => boolean, commandClient: ApiClient): Promise<void> {
  const key = moduleKeyOf(module.workspaceId, module.moduleId)
  return enqueue(context.pendingReads, key, async () => {
    const signal = context.sessionSignal.getSnapshot()
    if (signal === null || outlived() || context.server.getSnapshot().get(key)?.status !== "ready") return
    const alive = () => !outlived() && !signal.aborted
    try {
      const client: ApiClient = { ...(context.client.getSnapshot() ?? commandClient), signal }
      const problem = await readModuleInto(context.server, client, module, { alive })
      if (problem !== null && alive()) reportRead(context, key, problem)
    } catch (error) {
      // Nothing thrown here goes unheard: the read's own failures come back above, anything else is told the same way.
      if (alive()) reportRead(context, key, problemOfError(error))
    }
  })
}

/**
 * The row read again after a command that landed unread (#263): alone
 * through its adapter's own read where it has one, else with its module;
 * undefined where that read fails too, or the session has moved on.
 */
export async function rowAgain(context: RecordStoreContext, module: ServerModule, key: string, row: BusinessRecord, client: ApiClient): Promise<BusinessRecord | undefined> {
  const serverStore = context.server
  const generation = context.generation.getSnapshot()
  const outlived = () => context.generation.getSnapshot() !== generation
  const state = serverStore.getSnapshot().get(key)
  if (state === undefined) return undefined
  if (adapterFor(module, row)?.read !== undefined) {
    const again = await rereadRecord(client, module, state, row, { state: serverStore.getSnapshot() })
    if (again.kind !== "done" || outlived()) return undefined
    serverStore.set((current) => new Map(current).set(key, withRecord(current.get(key) ?? state, again.record, again.serverId)))
    return again.record
  }
  const loadedAt = state.loadedAt
  await rereadModule(context, module, outlived, client)
  const read = serverStore.getSnapshot().get(key)
  return read === undefined || read.loadedAt === loadedAt ? undefined : read.records.find((candidate) => candidate.id === row.id)
}

/** A refusal of a command or an action asked of a module the store does not hold ready, or of a row it does not hold. */
const notReadHere = (key: string, recordId: string) => genericProblem(400, `${key} is not read from the API, or holds no record ${recordId}`)

/**
 * A write of a switched module. Optimistic and reconciled: the row shows what
 * was saved at once, the API's answer replaces it, a refusal puts the row back
 * and tells the person why in the API's words. A write the API took whose
 * answer could not be shown is `landed`, told as saved whatever `report` says,
 * and its module is read again. A switched module the API has not read — no
 * API configured, or a session that has ended — refuses the write at once
 * (`writeRouteOf`), never keeping it in the browser; a module on the browser's
 * own path is not this store's (undefined).
 */
function write(context: RecordStoreContext, workspaceId: WorkspaceId, moduleId: string, record: BusinessRecord, { apiConfigured, label }: WriteTarget, options?: WriteOptions): Promise<WriteOutcome> | undefined {
  const key = moduleKeyOf(workspaceId, moduleId)
  const module = serverModuleOf(workspaceId, moduleId)
  const serverStore = context.server
  const current = module === undefined ? undefined : serverStore.getSnapshot().get(key)
  const client = context.client.getSnapshot()
  const report = options?.report ?? true
  const route = writeRouteOf({ apiConfigured, switched: module !== undefined, target: current, signedIn: client !== null, label })
  const refused = (problem: Problem, said: boolean): Promise<WriteOutcome> => {
    if (report && said) context.notices.unsent(key, record.name, problem)
    return Promise.resolve({ kind: "refused", recordId: record.id, problem })
  }
  if (route.kind === "refused") return refused(route.problem, route.said)
  if (route.kind !== "api") return undefined
  // What the route was read from; never otherwise once it says "api".
  if (module === undefined || current === undefined || client === null) return refused(sessionEnded(), true)
  const before = current.records.find((candidate) => candidate.id === record.id)
  serverStore.set((state) => new Map(state).set(key, withRecord(state.get(key) ?? current, record)))
  // The session this write belongs to: one that has ended by the time the
  // write's turn comes gets nothing but the word that it ended; one that ends
  // while the API answers gets the answer, since the API gave it, but the
  // store — the next person's by then — does not.
  const generation = context.generation.getSnapshot()
  const outlived = () => context.generation.getSnapshot() !== generation
  const ended = (): WriteOutcome => ({ kind: "refused", recordId: record.id, problem: sessionEnded() })
  const run = async (): Promise<WriteOutcome> => {
    if (outlived()) return ended()
    // The server ids and the client as they stand when this write's turn
    // comes: a create queued before it has answered by now, so a second save
    // of the row is a patch and not a second POST, and the token is the
    // current one. The row as it was when this save was asked for stays the
    // patch's `before`: the patch says what this save moved.
    const latest = serverStore.getSnapshot().get(key) ?? current
    const turn = context.client.getSnapshot() ?? client
    // The reason rides on the write's requests alone, never on the reads after it.
    const writer = options?.reason === undefined ? turn : { ...turn, reason: options.reason }
    const outcome = await writeRecord(writer, module, { ...current, serverIds: latest.serverIds }, record, { state: serverStore.getSnapshot() })
    if (outlived()) return outcome
    serverStore.set((state) => {
      const settled = state.get(key) ?? current
      const next = withOutcome(settled, outcome, record, before)
      return next === settled ? state : new Map(state).set(key, next)
    })
    // The account's own refusal has ended the session; /login says why.
    // Part of it landed — the adapter's `PartialWrite`, or the store's own reading (#263) — and is said so.
    const inPart = outcome.kind === "refused" && (outcome.partial === true || outcome.record !== undefined)
    if (outcome.kind === "refused" && report && !isAccountRefusal(outcome.problem)) context.notices.refused(inPart ? `${record.name} was saved only in part` : `${record.name} was not saved`, outcome.problem)
    if (outcome.kind === "landed") context.notices.landed(record.name)
    if (outcome.kind === "landed" || (outcome.kind === "refused" && outcome.partial === true)) {
      // Once the writes now out have answered — this one's among them — so the read never lands between a create's POST and its answer.
      const inFlight = [...context.pendingWrites.values()]
      void Promise.allSettled(inFlight).then(() => rereadModule(context, module, outlived, turn))
    }
    return outcome
  }
  return enqueue(context.pendingWrites, record.id, run)
}

/**
 * Sends one of a row's commands (`deactivate`, `reactivate`, …: the
 * adapter's `commands`) on a switched module that is ready, and puts the
 * API's answer in the row's place. `input` is what the command's dialog says
 * (a warehouse, a reason), which the command maps to its body. A refusal is
 * told to the person in the API's words, as a write's is, and handed back.
 */
function sendCommand(context: RecordStoreContext, workspaceId: WorkspaceId, moduleId: string, recordId: string, name: string, input?: CommandInput): Promise<CommandOutcome> {
  const key = moduleKeyOf(workspaceId, moduleId)
  const module = serverModuleOf(workspaceId, moduleId)
  const serverStore = context.server
  const current = module === undefined ? undefined : serverStore.getSnapshot().get(key)
  const record = current?.records.find((candidate) => candidate.id === recordId)
  if (module === undefined || current === undefined || current.status !== "ready" || record === undefined || context.client.getSnapshot() === null) {
    // A module on the browser's own path has no commands, and the pane offers
    // none there; a caller that asked all the same is told, as for any refusal.
    const refused: CommandOutcome = { kind: "refused", what: "Nothing was changed", recordId, problem: notReadHere(key, recordId), touches: [] }
    context.notices.refused(refused.what, refused.problem)
    return Promise.resolve(refused)
  }
  // The session this command belongs to, as for a write.
  const generation = context.generation.getSnapshot()
  const outlived = () => context.generation.getSnapshot() !== generation
  const ended = (): CommandOutcome => ({ kind: "refused", what: `${record.name} was not changed`, recordId, problem: genericProblem(UNREACHABLE_STATUS, "The session ended before the command was sent"), touches: [] })
  const run = async (): Promise<CommandOutcome> => {
    if (outlived()) return ended()
    // The row and the client as they stand when the command's turn comes: a
    // create queued before it has answered by now, so the server id is there,
    // and the token is the current one.
    const latest = serverStore.getSnapshot().get(key) ?? current
    const row = latest.records.find((candidate) => candidate.id === recordId) ?? record
    const client = context.client.getSnapshot()
    if (client === null) return ended()
    let outcome = await commandRecord(client, module, latest, row, name, input, { state: serverStore.getSnapshot() })
    if (outlived()) return outcome
    if (outcome.kind === "landed") {
      // The movement stands and its row could not be read back (#263): read again once the other writes now out have answered,
      // and answered as done with the row as it now is, so what the caller says of it is true; sending it again would make a second.
      const landed = outcome
      const others = [...context.pendingWrites.entries()].filter(([id]) => id !== recordId).map(([, pending]) => pending)
      await Promise.allSettled(others)
      const again = outlived() ? undefined : await rowAgain(context, module, key, row, client)
      if (again !== undefined) outcome = { kind: "done", record: again, serverId: landed.serverId, touches: landed.touches.filter((touched) => touched !== key) }
      else if (!outlived()) context.notices.landedCommand(row.name)
    }
    if (outlived()) return outcome
    if (outcome.kind === "done") {
      const done = outcome
      serverStore.set((state) => new Map(state).set(key, withRecord(state.get(key) ?? latest, done.record, done.serverId)))
    } else if (outcome.kind === "refused" && !isAccountRefusal(outcome.problem)) {
      context.notices.refused(outcome.what, outcome.problem)
    }
    // The other modules the command may have changed rows of are read again, the command's answer not waiting on them.
    for (const touched of rereadsOf(serverStore.getSnapshot(), outcome.touches, SERVER_MODULES)) void rereadModule(context, touched, outlived, client)
    return outcome
  }
  return enqueue(context.pendingWrites, recordId, run)
}

/**
 * Sends one of a row's actions (the adapter's `actions`: a scheme's
 * generate) on a switched module that is ready, and hands back what it
 * answered — another resource; the row stays as it is. It takes its turn on
 * the row as a command does. A refusal is told in the API's words unless
 * `report: false` leaves that to the caller (a dialog that stays open), and
 * handed back.
 */
function sendAction(context: RecordStoreContext, ...[workspaceId, moduleId, recordId, name, input, options]: Parameters<SendAction>): Promise<ActionOutcome> {
  const key = moduleKeyOf(workspaceId, moduleId)
  const module = serverModuleOf(workspaceId, moduleId)
  const serverStore = context.server
  const current = module === undefined ? undefined : serverStore.getSnapshot().get(key)
  const record = current?.records.find((candidate) => candidate.id === recordId)
  const report = options?.report ?? true
  if (module === undefined || current === undefined || current.status !== "ready" || record === undefined || context.client.getSnapshot() === null) {
    // As for a command: a module on the browser's own path has no actions.
    const refused: ActionOutcome = { kind: "refused", what: "Nothing was done", recordId, problem: notReadHere(key, recordId) }
    if (report) context.notices.refused(refused.what, refused.problem)
    return Promise.resolve(refused)
  }
  // The session this action belongs to, as for a command.
  const generation = context.generation.getSnapshot()
  const outlived = () => context.generation.getSnapshot() !== generation
  const ended = (): ActionOutcome => ({ kind: "refused", what: `Nothing was done to ${record.name}`, recordId, problem: genericProblem(UNREACHABLE_STATUS, "The session ended before the action was sent") })
  const run = async (): Promise<ActionOutcome> => {
    if (outlived()) return ended()
    const latest = serverStore.getSnapshot().get(key) ?? current
    const row = latest.records.find((candidate) => candidate.id === recordId) ?? record
    const client = context.client.getSnapshot()
    if (client === null) return ended()
    const outcome = await actOnRecord(client, module, latest, row, name, input, { state: serverStore.getSnapshot() })
    if (outlived()) return outcome
    if (outcome.kind === "refused" && report && !isAccountRefusal(outcome.problem)) context.notices.refused(outcome.what, outcome.problem)
    return outcome
  }
  return enqueue(context.pendingWrites, recordId, run)
}

/**
 * Reads one row of a switched module back from the API and puts it in the
 * row's place, for a row the server changed on its own account — a scheme
 * whose generation run has finished. It takes its turn on the row, and a
 * failed read leaves the row as it was.
 */
function refreshRecord(context: RecordStoreContext, workspaceId: WorkspaceId, moduleId: string, recordId: string): Promise<RereadOutcome> {
  const key = moduleKeyOf(workspaceId, moduleId)
  const module = serverModuleOf(workspaceId, moduleId)
  const serverStore = context.server
  const current = module === undefined ? undefined : serverStore.getSnapshot().get(key)
  const record = current?.records.find((candidate) => candidate.id === recordId)
  if (module === undefined || current === undefined || current.status !== "ready" || record === undefined || context.client.getSnapshot() === null) {
    return Promise.resolve({ kind: "refused", recordId, problem: notReadHere(key, recordId) })
  }
  // The session this read belongs to, as for a write, and under its signal, as a module read again after a
  // command goes out (`rereadModule`): a read the session outlives is abandoned, its answer never in the next person's store.
  const generation = context.generation.getSnapshot()
  const outlived = () => context.generation.getSnapshot() !== generation
  const ended = (): RereadOutcome => ({ kind: "refused", recordId, problem: genericProblem(UNREACHABLE_STATUS, "The session ended before the record was read") })
  const run = async (): Promise<RereadOutcome> => {
    const signal = context.sessionSignal.getSnapshot()
    if (signal === null || outlived()) return ended()
    const latest = serverStore.getSnapshot().get(key) ?? current
    const row = latest.records.find((candidate) => candidate.id === recordId) ?? record
    const client = context.client.getSnapshot()
    if (client === null) return ended()
    const outcome = await rereadRecord({ ...client, signal }, module, latest, row, { state: serverStore.getSnapshot() })
    if (outlived() || signal.aborted) return outcome
    if (outcome.kind === "done") serverStore.set((state) => new Map(state).set(key, withRecord(state.get(key) ?? latest, outcome.record, outcome.serverId)))
    return outcome
  }
  return enqueue(context.pendingWrites, recordId, run)
}

/**
 * Reads a switched module again whole, as the store does after a command
 * that touches it (#213's re-read, the one read path), for a module whose
 * rows the server moves on its own account while a person watches it — the
 * Live board every 30 s. Only while the module is ready, and a failed read
 * leaves its rows as they were; nothing to do on any other module.
 */
function refreshModule(context: RecordStoreContext, workspaceId: WorkspaceId, moduleId: string): Promise<void> {
  const module = serverModuleOf(workspaceId, moduleId)
  const client = context.client.getSnapshot()
  if (module === undefined || client === null) return Promise.resolve()
  // The session this read belongs to, as for a command's re-read: one the session outlives is abandoned.
  const generation = context.generation.getSnapshot()
  return rereadModule(context, module, () => context.generation.getSnapshot() !== generation, client)
}

/** How often a module may be read again for what it read within a minute before a development build says it looks like a loop. */
const REREADS_BEFORE_A_LOOP = 5

/** The page coming back into view, which a timer sleeping with the machine missed: the browser's `visibilitychange` and `focus`. */
function pageReturns(back: () => void): () => void {
  const onReturn = () => {
    if (document.visibilityState === "visible") back()
  }
  document.addEventListener("visibilitychange", onReturn)
  window.addEventListener("focus", onReturn)
  return () => {
    document.removeEventListener("visibilitychange", onReturn)
    window.removeEventListener("focus", onReturn)
  }
}

export type WatchOptions = {
  /** Subscribes to the page coming back into view; the browser's events by default. */
  onReturn?: (back: () => void) => () => void
  /** Told when a module is read again for what it read more often than a minute should need, in a development build: two modules reading each other. */
  onLoop?: (moduleKey: string) => void
}

/**
 * The store's watcher (#232): a module is read again once something its last
 * read's mapping read has moved since that read began (`readsChanged`) — a
 * row it named, a module it scanned, a module now holding a row it found
 * nowhere — and once the project's day it read has turned
 * (`dayTurnRereads`), checked again when the page comes back. A burst
 * collapses into one read a second after its last change, after any write
 * still out (its answer is the change that counts) and after the session's
 * load, queued as every read is (`rereadModule`). A read that failed is asked
 * for again half a minute on, or once what moved moves again — never for a
 * module it never read. The write, read and command paths are as they were;
 * this only watches what they leave. Answers the stop.
 */
export function watchReads(context: RecordStoreContext, { onReturn = pageReturns, onLoop = warnOfLoop }: WatchOptions = {}): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  // Once stopped, nothing is armed again: a read again still out when the watcher stops settles into nothing.
  let stopped = false
  const after = (ms: number, run: () => void) => {
    if (stopped) return undefined
    const timer = setTimeout(() => {
      timers.delete(timer)
      run()
    }, ms)
    timers.add(timer)
    return timer
  }
  const due = new Map<string, ReturnType<typeof setTimeout> | undefined>()
  const asked = new Map<string, ReturnType<typeof readSourcesNow>>()
  const sent = new Map<string, number[]>()
  const counted = (key: string) => {
    const now = Date.now()
    const recent = [...(sent.get(key) ?? []).filter((at) => now - at < 60_000), now]
    sent.set(key, recent)
    if (recent.length === REREADS_BEFORE_A_LOOP + 1) onLoop(key)
  }
  const readAgain = (module: ServerModule, forWhatItRead: boolean) => {
    const key = moduleKeyOf(module.workspaceId, module.moduleId)
    const pending = due.get(key)
    if (pending !== undefined) {
      clearTimeout(pending)
      timers.delete(pending)
    }
    const send = () => {
      if (context.pendingWrites.size > 0 || context.loading.getSnapshot()) {
        due.set(key, after(1_000, send))
        return
      }
      due.delete(key)
      const client = context.client.getSnapshot()
      if (client === null) return
      if (forWhatItRead) counted(key)
      const generation = context.generation.getSnapshot()
      void rereadModule(context, module, () => context.generation.getSnapshot() !== generation, client).finally(() => {
        if (context.server.getSnapshot().get(key)?.problem == null) return
        after(30_000, () => {
          asked.delete(key)
          check(false)
        })
      })
    }
    due.set(key, after(1_000, send))
  }
  let zones = ""
  let midnight: ReturnType<typeof setTimeout> | undefined
  const check = (dayToo: boolean) => {
    const state = context.server.getSnapshot()
    const timezones = clocksRead(state)
    for (const module of SERVER_MODULES) {
      const key = moduleKeyOf(module.workspaceId, module.moduleId)
      if (readsChanged(state, key).length === 0) continue
      const sources = readSourcesNow(state, key)
      if (sameSources(asked.get(key), sources)) continue
      asked.set(key, sources)
      readAgain(module, true)
    }
    if (dayToo) for (const module of dayTurnRereads(state, SERVER_MODULES, Date.now())) readAgain(module, false)
    // The next turn of the projects' day, armed again whenever their clocks are first known or change.
    if (dayToo || timezones.join() !== zones) {
      zones = timezones.join()
      if (midnight !== undefined) {
        clearTimeout(midnight)
        timers.delete(midnight)
      }
      midnight = after(untilDayTurns(Date.now(), timezones) + 1_000, () => check(true))
    }
  }
  const unsubscribe = context.server.subscribe(() => check(false))
  const stopReturns = onReturn(() => check(true))
  check(true)
  return () => {
    stopped = true
    unsubscribe()
    stopReturns()
    for (const timer of timers) clearTimeout(timer)
  }
}

/** A development build's word on a module read again and again for what it read: a loop costs reads, never rows, so production stays quiet. */
function warnOfLoop(moduleKey: string) {
  if (process.env.NODE_ENV !== "production") console.warn(`${moduleKey} was read again ${REREADS_BEFORE_A_LOOP + 1} times in a minute for what it read: does it read a module that reads it?`)
}
