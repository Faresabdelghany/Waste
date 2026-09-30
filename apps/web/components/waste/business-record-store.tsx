"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { toast } from "sonner"

import { createExternalStore, type ExternalStore } from "@/lib/external-store"
import {
  getModuleDefinition,
  type BusinessRecord,
  type WorkspaceId,
} from "@/lib/data/business-modules"
import {
  hasLegacyIds,
  migrateLegacyRecordBuckets,
} from "@/lib/data/legacy-ids"
import { UNREACHABLE_STATUS, type ApiClient } from "@/lib/api/client"
import { genericProblem, isAccountRefusal, problemSentence, type Problem } from "@/lib/api/problem"
import { moduleKeyOf, type CommandInput, type ServerModule } from "@/lib/api/records/adapter"
import { ME_PROJECTS, withMeProjects } from "@/lib/api/records/me-projects"
import { SERVER_MODULES, serverModuleOf, viewableModules } from "@/lib/api/records/modules"
import { organisationModule } from "@/lib/api/records/organisation"
import {
  actOnRecord,
  commandRecord,
  IDLE,
  paneAnswerOf,
  problemOfError,
  readModuleInto,
  recordsOf,
  rereadRecord,
  rereadsOf,
  withCreated,
  withNotGranted,
  withRecord,
  writeRecord,
  type ActionOutcome,
  type CommandOutcome,
  type ModuleState,
  type PaneAnswer,
  type RereadOutcome,
  type SendAction,
  type ServerRecordsState,
  type WriteOutcome,
} from "@/lib/api/records/server-records"
import {
  BUSINESS_RECORDS_STORAGE_KEY,
  readPersisted,
} from "@/lib/storage-keys"

import { useApiClient, useApiConfigured, useApiSession, useApiSessionIdentity } from "./api-session-store"

/**
 * Key renames specific to this store's records, on top of the shared map in
 * lib/data/legacy-ids.ts. Defensive only: no shipped form schema ever had a
 * bare `contractor` field (the access form's field is `serviceProviderId`,
 * which the shared map already covers), so no browser is known to hold this
 * key. It is kept because `organizationForRecord` in
 * lib/data/users-roles.ts (the Users & roles pane's fixture rows) reads
 * `submittedValues.serviceProvider`, and without an explicit entry a bare
 * `contractor` key would fall through to the token rewrite and become
 * `"service-provider"`, which nothing reads.
 */
const LEGACY_RECORD_KEY_RENAMES: Readonly<Record<string, string>> = {
  contractor: "serviceProvider",
}

type StoredRecords = Record<string, BusinessRecord[]>

type BusinessRecordStoreValue = {
  getRecords: (
    workspaceId: WorkspaceId,
    moduleId: string,
    fixtureRecords: readonly BusinessRecord[],
  ) => BusinessRecord[]
  /**
   * Saves a record. On a switched module that is ready, the write's outcome
   * once the API has answered — a caller that needs to know (a dialog that
   * stays open on a refusal) awaits it, and may say `report: false` to tell
   * the person itself instead of the store's toast; the rest of the
   * workspace ignores it. On every other module the record goes to the
   * browser's bucket, and there is nothing to await.
   */
  upsertRecord: (
    workspaceId: WorkspaceId,
    moduleId: string,
    record: BusinessRecord,
    options?: { report?: boolean },
  ) => Promise<WriteOutcome> | undefined
  /**
   * Sends one of a row's commands (`deactivate`, `reactivate`, …: the
   * adapter's `commands`) on a switched module that is ready, and puts the
   * API's answer in the row's place. `input` is what the command's dialog
   * says (a warehouse, a reason), which the command maps to its body. A
   * refusal is told to the person in the API's words, as a write's is, and
   * handed back.
   */
  sendCommand: (
    workspaceId: WorkspaceId,
    moduleId: string,
    recordId: string,
    name: string,
    input?: CommandInput,
  ) => Promise<CommandOutcome>
  /**
   * Sends one of a row's actions (the adapter's `actions`: a scheme's
   * generate) on a switched module that is ready, and hands back what it
   * answered — another resource; the row stays as it is. It takes its turn
   * on the row as a command does. A refusal is told in the API's words
   * unless `report: false` leaves that to the caller (a dialog that stays
   * open), and handed back. A page reaches an action through its adapter's
   * typed wrapper (`generateScheme`), never by name.
   */
  sendAction: SendAction
  /**
   * Reads one row of a switched module back from the API and puts it in
   * the row's place, for a row the server changed on its own account — a
   * scheme whose generation run has finished. It takes its turn on the row,
   * and a failed read leaves the row as it was.
   */
  refreshRecord: (
    workspaceId: WorkspaceId,
    moduleId: string,
    recordId: string,
  ) => Promise<RereadOutcome>
  /**
   * Reads a switched module again whole, as the store does after a command
   * that touches it (#213's re-read, the one read path), for a module whose
   * rows the server moves on its own account while a person watches it — the
   * Live board every 30 s. Only while the module is ready, and a failed read
   * leaves its rows as they were; nothing to do on any other module.
   */
  refreshModule: (workspaceId: WorkspaceId, moduleId: string) => Promise<void>
}

type BusinessRecordStores = {
  records: ExternalStore<StoredRecords>
  /**
   * Flips to true once the provider has loaded localStorage. Effects that
   * write derived records (Plan Ahead auto-generation) must wait for it:
   * child effects run before the provider's load effect on mount, and a
   * write planned against fixture-only state would be clobbered by the load.
   */
  hydrated: ExternalStore<boolean>
  /**
   * The server-backed modules (Issue #81): one entry per switched
   * `workspace.module`, keyed like the records above, each the server's rows
   * as the prototype shows them once its read has landed. Empty while the
   * adapter is off or nobody is signed in, so every module reads the
   * browser's own path then. Until a module is `ready` — the load pending,
   * failed, or not granted — `getRecords` answers its fixtures alone: the
   * browser's own bucket for that module is not shown in that window, and a
   * write made in it goes to that bucket, which the module stops reading
   * once the server has answered. Never a mixture.
   */
  server: ExternalStore<ServerRecordsState>
  /**
   * The client the writes go through; null when there is none. Held here so
   * `upsertRecord` and a load in flight read the current one when they run:
   * it follows every token refresh, while the load below does not.
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
}

// The context carries the stable store handles, never the state itself — see
// lib/external-store.ts for why (hydration safety under streaming SSR).
const BusinessRecordStoreContext = createContext<BusinessRecordStores | null>(
  null,
)

// The server (and every hydrating component) sees fixtures only.
const EMPTY_STORED_RECORDS: StoredRecords = {}
const NO_SERVER_MODULES: ServerRecordsState = new Map()
const NO_RECORDS: readonly BusinessRecord[] = []

function moduleKey(workspaceId: WorkspaceId, moduleId: string) {
  return moduleKeyOf(workspaceId, moduleId)
}

function isStoredRecords(value: unknown): value is StoredRecords {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.values(value).every(
    (records) =>
      Array.isArray(records) &&
      records.every(
        (record) =>
          record &&
          typeof record === "object" &&
          typeof (record as BusinessRecord).id === "string" &&
          typeof (record as BusinessRecord).name === "string",
      ),
  )
}

/** A refusal is told to the person in the API's words: the toast for a write or a read the API refused. */
function reportProblem(what: string, problem: Problem) {
  toast.error(what, { description: problemSentence(problem) })
}

/** The fixtures of a module, the seed's origin, which every mapping matches by name. */
function fixturesOf(workspaceId: WorkspaceId, moduleId: string): readonly BusinessRecord[] {
  return getModuleDefinition({ workspaceId, moduleId })?.records ?? []
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
function reportRead(key: string, problem: Problem) {
  if (!isAccountRefusal(problem)) reportProblem(`${key} could not be read from the API`, problem)
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
function rereadModule(stores: BusinessRecordStores, module: ServerModule, outlived: () => boolean, commandClient: ApiClient): Promise<void> {
  const key = moduleKey(module.workspaceId, module.moduleId)
  return enqueue(stores.pendingReads, key, async () => {
    const signal = stores.sessionSignal.getSnapshot()
    if (signal === null || outlived() || stores.server.getSnapshot().get(key)?.status !== "ready") return
    const alive = () => !outlived() && !signal.aborted
    try {
      const client: ApiClient = { ...(stores.client.getSnapshot() ?? commandClient), signal }
      const problem = await readModuleInto(stores.server, client, module, { fixtures: fixturesOf(module.workspaceId, module.moduleId), alive })
      if (problem !== null && alive()) reportRead(key, problem)
    } catch (error) {
      // Nothing thrown here goes unheard: the read's own failures come back above, anything else is told the same way.
      if (alive()) reportRead(key, problemOfError(error))
    }
  })
}

export function BusinessRecordStoreProvider({
  children,
}: {
  children: ReactNode
}) {
  const [stores] = useState<BusinessRecordStores>(() => ({
    records: createExternalStore<StoredRecords>(EMPTY_STORED_RECORDS),
    hydrated: createExternalStore(false),
    server: createExternalStore<ServerRecordsState>(NO_SERVER_MODULES),
    client: createExternalStore<ApiClient | null>(null),
    pendingWrites: new Map(),
    pendingReads: new Map(),
    generation: createExternalStore(0),
    sessionSignal: createExternalStore<AbortSignal | null>(null),
  }))
  const client = useApiClient()
  const identity = useApiSessionIdentity()
  const { loadMe } = useApiSession()

  // The current client, whatever token it carries, for a write or a load
  // that reads it when it runs.
  useEffect(() => {
    stores.client.set(client)
  }, [client, stores])

  useEffect(() => {
    const store = stores.records
    try {
      const raw = readPersisted(
        window.localStorage,
        BUSINESS_RECORDS_STORAGE_KEY,
      )
      const parsed: unknown = raw ? JSON.parse(raw) : null
      if (isStoredRecords(parsed)) {
        // Browsers that wrote records before the Contractor → Service provider
        // rename still hold the old bucket keys ("contractors.contract-areas")
        // and old ids inside records. Migrate once on load; the migration is
        // idempotent and returns the parsed object itself when nothing is
        // legacy, and the persist below writes the migrated payload back.
        store.set(
          raw && hasLegacyIds(raw)
            ? migrateLegacyRecordBuckets(parsed, LEGACY_RECORD_KEY_RENAMES)
            : parsed,
        )
      }
    } catch {
      // A corrupt or unavailable browser store should not block the workspace.
    }
    stores.hydrated.set(true)
    const persist = () => {
      try {
        window.localStorage.setItem(
          BUSINESS_RECORDS_STORAGE_KEY,
          JSON.stringify(store.getSnapshot()),
        )
      } catch {
        // The in-memory record graph remains usable when persistence is blocked.
      }
    }
    persist()
    return store.subscribe(persist)
  }, [stores])

  // The server-backed modules follow the session, not the token: they load
  // once when a person is signed in against an API, and again only when the
  // API or the person changes (`useApiSessionIdentity`) — a token refresh,
  // which happens every hour, changes neither and reloads nothing, since a
  // request in flight reads the current client from `stores.client` at the
  // moment it is sent. No session (signed out, adapter off, expired and not
  // refreshed) empties them, so every module reads the browser's own path
  // again. The switched modules load in SERVER_MODULES' order, one after the
  // other, since a later module's mapping resolves the earlier ones' rows (a
  // user names its role and its projects); each lands as it arrives, and a
  // module that fails is reported once and left on its fixtures — unless the
  // API refused the account itself (Issue #150): the client has ended the
  // session by then, so the load stops there, reported nowhere but /login
  // and never falling back on fixtures. Only the modules the person's `/me`
  // role grants `view` on are read (`viewableModules`, Issue #145); the rest
  // are never requested and are marked not granted, told to nobody (Issue
  // #200), so nobody meets a refusal for a pane they cannot open and a pane
  // they do open says why it is empty. A `/me` that cannot be read leaves
  // the grants unknown, and every module is tried as before. A load the
  // session outlives — the person signs out mid-way — is aborted, not left
  // to finish into a store that no longer wants it, and a write it outlives
  // is dropped when it answers (`generation`). Every change of person or API
  // empties the modules first, a sign-in as someone else included: the last
  // person's rows are never shown under the next one while theirs load.
  useEffect(() => {
    const server = stores.server
    stores.generation.set((generation) => generation + 1)
    server.set(NO_SERVER_MODULES)
    if (identity === null) return
    const controller = new AbortController()
    const initial = stores.client.getSnapshot()
    if (initial === null) return
    stores.sessionSignal.set(controller.signal)
    const run = async () => {
      let modules = SERVER_MODULES
      let projects: readonly { id: string; name: string }[] | undefined
      try {
        const me = await loadMe()
        modules = viewableModules(me.role.grants, SERVER_MODULES)
        projects = me.projects
      } catch (error) {
        // The account's refusal has ended the session; anything else leaves the grants unknown.
        if (controller.signal.aborted || isAccountRefusal(problemOfError(error))) return
      }
      if (controller.signal.aborted) return
      server.set((state) => {
        const marked = withNotGranted(state, SERVER_MODULES.filter((module) => !modules.includes(module)))
        // Where the role does not view the organisation, a row's project resolves through `/me`'s projects (Issue #217).
        return projects !== undefined && !modules.includes(organisationModule) ? withMeProjects(marked, projects, fixturesOf("configure", "organization")) : marked
      })
      for (const module of modules) {
        if (controller.signal.aborted) return
        const key = moduleKey(module.workspaceId, module.moduleId)
        // The one read a module has, which a read again after a command
        // (Issue #198) takes too, one after the other. The token as it stands
        // when this module's read is sent; the one the effect began with if
        // the session lapsed under it, so the read goes out and the API's
        // refusal is reported rather than nothing at all.
        const problem = await enqueue(stores.pendingReads, key, () =>
          readModuleInto(server, { ...(stores.client.getSnapshot() ?? initial), signal: controller.signal }, module, {
            fixtures: fixturesOf(module.workspaceId, module.moduleId),
            alive: () => !controller.signal.aborted,
          }),
        )
        if (controller.signal.aborted) return
        if (problem === null) continue
        if (isAccountRefusal(problem)) return
        reportRead(key, problem)
      }
    }
    void run()
    return () => {
      controller.abort()
    }
  }, [identity, stores, loadMe])

  return (
    <BusinessRecordStoreContext.Provider value={stores}>
      {children}
    </BusinessRecordStoreContext.Provider>
  )
}

/** True once stored records have been loaded — see BusinessRecordStores. */
export function useBusinessRecordsHydrated(): boolean {
  const stores = useContext(BusinessRecordStoreContext)
  if (!stores) {
    throw new Error(
      "useBusinessRecordsHydrated must be used within BusinessRecordStoreProvider",
    )
  }
  return useSyncExternalStore(
    stores.hydrated.subscribe,
    stores.hydrated.getSnapshot,
    stores.hydrated.getServerSnapshot,
  )
}

export function useBusinessRecordStore(): BusinessRecordStoreValue {
  const stores = useContext(BusinessRecordStoreContext)
  if (!stores) {
    throw new Error(
      "useBusinessRecordStore must be used within BusinessRecordStoreProvider",
    )
  }
  const store = stores.records
  const storedRecords = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  )
  const serverModules = useSyncExternalStore(
    stores.server.subscribe,
    stores.server.getSnapshot,
    stores.server.getServerSnapshot,
  )
  /** The switched module's state, or null for a module still on the browser's own path. */
  const serverModuleState = useCallback(
    (workspaceId: WorkspaceId, moduleId: string): ModuleState | null =>
      serverModuleOf(workspaceId, moduleId) === undefined ? null : (serverModules.get(moduleKey(workspaceId, moduleId)) ?? IDLE),
    [serverModules],
  )

  const getRecords = useCallback(
    (
      workspaceId: WorkspaceId,
      moduleId: string,
      fixtureRecords: readonly BusinessRecord[],
    ) => {
      // A switched module answers the server's rows once they are here and
      // the fixtures until then — never a mixture with the browser's own
      // bucket, whose records were made against a store that no longer
      // decides (Issue #81).
      const server = serverModuleState(workspaceId, moduleId)
      if (server !== null && server.status === "ready") return recordsOf(server, fixtureRecords)

      const stored = storedRecords[moduleKey(workspaceId, moduleId)] ?? []
      const storedById = new Map(stored.map((record) => [record.id, record]))
      const fixtureIds = new Set(fixtureRecords.map((record) => record.id))
      const createdRecords = stored.filter((record) => !fixtureIds.has(record.id))
      const mergedFixtures = fixtureRecords.map(
        (record) => storedById.get(record.id) ?? record,
      )

      return [...createdRecords, ...mergedFixtures]
    },
    [serverModuleState, storedRecords],
  )

  const upsertRecord = useCallback(
    (workspaceId: WorkspaceId, moduleId: string, record: BusinessRecord, options?: { report?: boolean }) => {
      const key = moduleKey(workspaceId, moduleId)
      const module = serverModuleOf(workspaceId, moduleId)
      const serverStore = stores.server
      const current = module === undefined ? undefined : serverStore.getSnapshot().get(key)
      const client = stores.client.getSnapshot()
      const report = options?.report ?? true

      if (module !== undefined && current !== undefined && current.status === "ready" && client !== null) {
        // Optimistic and reconciled: the row shows what was saved at once,
        // the API's answer replaces it, a refusal puts the row back and
        // tells the person why in the API's words.
        const before = current.records.find((candidate) => candidate.id === record.id)
        serverStore.set((state) => new Map(state).set(key, withRecord(state.get(key) ?? current, record)))
        // The session this write belongs to: one that has ended by the time
        // the write's turn comes gets nothing but the word that it ended;
        // one that ends while the API answers gets the answer, since the
        // API gave it, but the store — the next person's by then — does not.
        const generation = stores.generation.getSnapshot()
        const outlived = () => stores.generation.getSnapshot() !== generation
        const ended = (): WriteOutcome => ({ kind: "refused", recordId: record.id, problem: genericProblem(UNREACHABLE_STATUS, "The session ended before the record was saved") })
        const run = async (): Promise<WriteOutcome> => {
          if (outlived()) return ended()
          // The server ids and the client as they stand when this write's
          // turn comes: a create queued before it has answered by now, so a
          // second save of the row is a patch and not a second POST, and the
          // token is the current one. The row as it was when this save was
          // asked for stays the patch's `before`: the patch says what this
          // save moved.
          const latest = serverStore.getSnapshot().get(key) ?? current
          const turn = stores.client.getSnapshot() ?? client
          const outcome = await writeRecord(turn, module, { ...current, serverIds: latest.serverIds }, record, { fixtures: fixturesOf(workspaceId, moduleId), state: serverStore.getSnapshot() })
          if (outlived()) return outcome
          serverStore.set((state) => {
            const settled = state.get(key) ?? current
            switch (outcome.kind) {
              case "created":
                return new Map(state).set(key, withCreated(settled, outcome.optimisticId, outcome.record, outcome.serverId))
              case "updated":
                return new Map(state).set(key, withRecord(settled, outcome.record, outcome.serverId))
              case "unchanged":
                return state
              case "refused": {
                // Part of a write that is several requests may stand: the row is then as the server holds it.
                const restored =
                  outcome.record !== undefined
                    ? withRecord(settled, outcome.record)
                    : before === undefined
                      ? { ...settled, records: settled.records.filter((candidate) => candidate.id !== outcome.recordId) }
                      : withRecord(settled, before)
                return new Map(state).set(key, { ...restored, problem: outcome.problem })
              }
            }
          })
          // The account's own refusal has ended the session; /login says why.
          if (outcome.kind === "refused" && report && !isAccountRefusal(outcome.problem)) reportProblem(`${record.name} was not saved`, outcome.problem)
          return outcome
        }
        return enqueue(stores.pendingWrites, record.id, run)
      }

      store.set((current) => {
        const existing = current[key] ?? []
        const hasRecord = existing.some((candidate) => candidate.id === record.id)
        return {
          ...current,
          [key]: hasRecord
            ? existing.map((candidate) =>
                candidate.id === record.id ? record : candidate,
              )
            : [record, ...existing],
        }
      })
      return undefined
    },
    [store, stores],
  )

  const sendCommand = useCallback(
    (workspaceId: WorkspaceId, moduleId: string, recordId: string, name: string, input?: CommandInput): Promise<CommandOutcome> => {
      const key = moduleKey(workspaceId, moduleId)
      const module = serverModuleOf(workspaceId, moduleId)
      const serverStore = stores.server
      const current = module === undefined ? undefined : serverStore.getSnapshot().get(key)
      const record = current?.records.find((candidate) => candidate.id === recordId)
      if (module === undefined || current === undefined || current.status !== "ready" || record === undefined || stores.client.getSnapshot() === null) {
        // A module on the browser's own path has no commands, and the pane
        // offers none there; a caller that asked all the same is told, as
        // for any refusal.
        const refused: CommandOutcome = { kind: "refused", what: "Nothing was changed", recordId, problem: genericProblem(400, `${key} is not read from the API, or holds no record ${recordId}`), touches: [] }
        reportProblem(refused.what, refused.problem)
        return Promise.resolve(refused)
      }
      // The session this command belongs to, as for a write above.
      const generation = stores.generation.getSnapshot()
      const outlived = () => stores.generation.getSnapshot() !== generation
      const ended = (): CommandOutcome => ({ kind: "refused", what: `${record.name} was not changed`, recordId, problem: genericProblem(UNREACHABLE_STATUS, "The session ended before the command was sent"), touches: [] })
      const run = async (): Promise<CommandOutcome> => {
        if (outlived()) return ended()
        // The row and the client as they stand when the command's turn
        // comes: a create queued before it has answered by now, so the
        // server id is there, and the token is the current one.
        const latest = serverStore.getSnapshot().get(key) ?? current
        const row = latest.records.find((candidate) => candidate.id === recordId) ?? record
        const client = stores.client.getSnapshot()
        if (client === null) return ended()
        const outcome = await commandRecord(client, module, latest, row, name, input, { fixtures: fixturesOf(workspaceId, moduleId), state: serverStore.getSnapshot() })
        if (outlived()) return outcome
        if (outcome.kind === "done") {
          serverStore.set((state) => new Map(state).set(key, withRecord(state.get(key) ?? latest, outcome.record, outcome.serverId)))
        } else if (!isAccountRefusal(outcome.problem)) {
          reportProblem(outcome.what, outcome.problem)
        }
        // The other modules the command may have changed rows of are read again, the command's answer not waiting on them.
        for (const touched of rereadsOf(serverStore.getSnapshot(), outcome.touches, SERVER_MODULES)) void rereadModule(stores, touched, outlived, client)
        return outcome
      }
      return enqueue(stores.pendingWrites, recordId, run)
    },
    [stores],
  )

  const sendAction = useCallback<SendAction>(
    (workspaceId, moduleId, recordId, name, input, options): Promise<ActionOutcome> => {
      const key = moduleKey(workspaceId, moduleId)
      const module = serverModuleOf(workspaceId, moduleId)
      const serverStore = stores.server
      const current = module === undefined ? undefined : serverStore.getSnapshot().get(key)
      const record = current?.records.find((candidate) => candidate.id === recordId)
      const report = options?.report ?? true
      if (module === undefined || current === undefined || current.status !== "ready" || record === undefined || stores.client.getSnapshot() === null) {
        // As for a command: a module on the browser's own path has no actions.
        const refused: ActionOutcome = { kind: "refused", what: "Nothing was done", recordId, problem: genericProblem(400, `${key} is not read from the API, or holds no record ${recordId}`) }
        if (report) reportProblem(refused.what, refused.problem)
        return Promise.resolve(refused)
      }
      // The session this action belongs to, as for a command above.
      const generation = stores.generation.getSnapshot()
      const outlived = () => stores.generation.getSnapshot() !== generation
      const ended = (): ActionOutcome => ({ kind: "refused", what: `Nothing was done to ${record.name}`, recordId, problem: genericProblem(UNREACHABLE_STATUS, "The session ended before the action was sent") })
      const run = async (): Promise<ActionOutcome> => {
        if (outlived()) return ended()
        const latest = serverStore.getSnapshot().get(key) ?? current
        const row = latest.records.find((candidate) => candidate.id === recordId) ?? record
        const client = stores.client.getSnapshot()
        if (client === null) return ended()
        const outcome = await actOnRecord(client, module, latest, row, name, input, { fixtures: fixturesOf(workspaceId, moduleId), state: serverStore.getSnapshot() })
        if (outlived()) return outcome
        if (outcome.kind === "refused" && report && !isAccountRefusal(outcome.problem)) reportProblem(outcome.what, outcome.problem)
        return outcome
      }
      return enqueue(stores.pendingWrites, recordId, run)
    },
    [stores],
  )

  const refreshRecord = useCallback(
    (workspaceId: WorkspaceId, moduleId: string, recordId: string): Promise<RereadOutcome> => {
      const key = moduleKey(workspaceId, moduleId)
      const module = serverModuleOf(workspaceId, moduleId)
      const serverStore = stores.server
      const current = module === undefined ? undefined : serverStore.getSnapshot().get(key)
      const record = current?.records.find((candidate) => candidate.id === recordId)
      if (module === undefined || current === undefined || current.status !== "ready" || record === undefined || stores.client.getSnapshot() === null) {
        return Promise.resolve({ kind: "refused", recordId, problem: genericProblem(400, `${key} is not read from the API, or holds no record ${recordId}`) })
      }
      // The session this read belongs to, as for a write above, and under its signal, as a module read again after a
      // command goes out (rereadModule): a read the session outlives is abandoned, its answer never in the next person's store.
      const generation = stores.generation.getSnapshot()
      const outlived = () => stores.generation.getSnapshot() !== generation
      const ended = (): RereadOutcome => ({ kind: "refused", recordId, problem: genericProblem(UNREACHABLE_STATUS, "The session ended before the record was read") })
      const run = async (): Promise<RereadOutcome> => {
        const signal = stores.sessionSignal.getSnapshot()
        if (signal === null || outlived()) return ended()
        const latest = serverStore.getSnapshot().get(key) ?? current
        const row = latest.records.find((candidate) => candidate.id === recordId) ?? record
        const client = stores.client.getSnapshot()
        if (client === null) return ended()
        const outcome = await rereadRecord({ ...client, signal }, module, latest, row, { fixtures: fixturesOf(workspaceId, moduleId), state: serverStore.getSnapshot() })
        if (outlived() || signal.aborted) return outcome
        if (outcome.kind === "done") serverStore.set((state) => new Map(state).set(key, withRecord(state.get(key) ?? latest, outcome.record, outcome.serverId)))
        return outcome
      }
      return enqueue(stores.pendingWrites, recordId, run)
    },
    [stores],
  )

  const refreshModule = useCallback(
    (workspaceId: WorkspaceId, moduleId: string): Promise<void> => {
      const module = serverModuleOf(workspaceId, moduleId)
      const client = stores.client.getSnapshot()
      if (module === undefined || client === null) return Promise.resolve()
      // The session this read belongs to, as for a command's re-read: one the session outlives is abandoned.
      const generation = stores.generation.getSnapshot()
      return rereadModule(stores, module, () => stores.generation.getSnapshot() !== generation, client)
    },
    [stores],
  )

  return useMemo(
    () => ({ getRecords, upsertRecord, sendCommand, sendAction, refreshRecord, refreshModule }),
    [getRecords, upsertRecord, sendCommand, sendAction, refreshRecord, refreshModule],
  )
}

/** The person's projects from `/me` where the role does not view the organisation (Issue #217), as the resolver reads them; none otherwise. */
export function useMeProjects(): readonly BusinessRecord[] {
  const stores = useContext(BusinessRecordStoreContext)
  if (!stores) {
    throw new Error("useMeProjects must be used within BusinessRecordStoreProvider")
  }
  const serverModules = useSyncExternalStore(
    stores.server.subscribe,
    stores.server.getSnapshot,
    stores.server.getServerSnapshot,
  )
  return serverModules.get(ME_PROJECTS)?.records ?? NO_RECORDS
}

/**
 * The state of a switched module — idle, not granted, loading, ready or
 * failed, with its problem — or null for a module on the browser's own
 * path. For a pane that must show nothing rather than the fixtures until
 * the API has answered (Settings › Users & roles on the Pilot, Issue #163).
 */
export function useServerModuleState(workspaceId: WorkspaceId, moduleId: string): ModuleState | null {
  const stores = useContext(BusinessRecordStoreContext)
  if (!stores) {
    throw new Error(
      "useServerModuleState must be used within BusinessRecordStoreProvider",
    )
  }
  const serverModules = useSyncExternalStore(
    stores.server.subscribe,
    stores.server.getSnapshot,
    stores.server.getServerSnapshot,
  )
  if (serverModuleOf(workspaceId, moduleId) === undefined) return null
  return serverModules.get(moduleKey(workspaceId, moduleId)) ?? IDLE
}

/**
 * The records a pane lists. On the browser's own path, `getRecords` as ever.
 * On the Pilot, a switched module's rows once they are here and nothing
 * before — never the fixtures, since a fixture row shown on the Pilot is a
 * row that does not exist — with the load's state beside them, for the
 * pane's empty row and its create button (Issue #163's rule for Settings ›
 * Users & roles, here for every pane that reads its own module). A module
 * the person's role does not view is not pending: its problem says so, and
 * nobody is toasted (`paneAnswerOf`, Issue #200).
 */
export function useModuleRecords(
  workspaceId: WorkspaceId,
  moduleId: string,
  fixtures: readonly BusinessRecord[],
): PaneAnswer {
  const configured = useApiConfigured()
  const state = useServerModuleState(workspaceId, moduleId)
  const { getRecords } = useBusinessRecordStore()
  if (configured && state !== null) return paneAnswerOf(state)
  return { records: getRecords(workspaceId, moduleId, fixtures), ready: true, pending: false, notGranted: false, problem: null }
}

/**
 * How a pane waits on a write's outcome — the one way. On the Pilot
 * `upsertRecord` answers once the API has, so the dialog stays open and the
 * success is said only then; a refusal is the store's toast, in the API's
 * words, over the form still holding what was typed, and `done` never runs.
 * `settled`, when given, runs either way once the answer is in — for a pane
 * that holds its form against a second submit while the first is out. On
 * the browser's own path there is nothing to wait for, and both run at once.
 */
export function whenSaved(outcome: Promise<WriteOutcome> | undefined, done: () => void, settled?: () => void): void {
  if (outcome === undefined) {
    done()
    settled?.()
    return
  }
  void outcome.then((result) => {
    settled?.()
    if (result.kind !== "refused") done()
  })
}
