// The server-backed half of the record store (Issue #81): what
// `business-record-store.tsx` reads a switched module from and writes it
// through. Pure state and transitions over a `Map` of modules, no React, so
// the rules below are held by lib/api/__tests__/server-records.test.ts without
// a browser:
//
//   A module is `idle` until the store is asked for it, `loading` while its
//   first read is out, `ready` once the rows are records, `failed` with the
//   problem when the API refused or did not answer, and `not-granted` when
//   the person's role does not view it, so it is never asked for at all
//   (Issue #200): nothing failed, and its problem is the store's own
//   sentence for a pane to show. Until it is `ready` the store answers the
//   module's fixtures — the same as the browser-only path shows before
//   hydration — and never a mixture of the two, so a list is either the
//   server's or the prototype's and nobody counts both.
//
//   A record's web id is the adapter's (adapter.ts: a fixture's id when the
//   seed derived the row from it, else `<prefix>-<uuid>`), and the server's
//   id is kept beside it in `serverIds`; a write looks the server id up by
//   the web id, so a patch goes to the row's own route. A record the
//   workspace has just made keeps the id it minted for the session
//   (`withCreated`), since the address bar and the selection already carry
//   it, and takes the adapter's id on the next load.
//
//   A write is optimistic and reconciled: the record the workspace handed
//   over replaces the row at once, so a form closes on a list that already
//   shows what it saved; then the API's answer, mapped, replaces that, so
//   the stamps and every field the wire owns are the server's. A refusal
//   puts the row back as it was and the caller is told in the API's words
//   (the store's `onProblem`), since a 409 duplicate or a 400 naming a
//   field is a person's to read, not a console's. A write that is several
//   requests and is refused after one of them landed (`PartialWrite`) puts
//   the row as the server now holds it instead, read back by the adapter.
//
//   A record the workspace writes that no adapter owns — a companion row a
//   controlled action made, a soft delete's marked copy — has no route. The
//   API has no delete (a company deactivates, a project's status moves), so
//   such a write is refused here with a sentence and the row stays as the
//   server has it. Two more writes are refused before the API sees them,
//   since the API would take them as nothing and the row would show what
//   the next load reverts: a record moved to a status the adapter does not
//   list in `statuses` (the lifecycle's Merged, Archived, Suspended — the
//   wire has no word for them), and a soft delete of an owned record (the
//   marker is a fact, and a fact travels nowhere). `spellsStatus` is the
//   same rule read the other way, for the workspace to offer no transition
//   that would be refused.
//
//   A command answers its own row, which replaces the one the store holds
//   (`commandRecord`). A command that changes another module's rows too —
//   a container's movement appended to the ledger — names that module in
//   `touches`, and once it is done the store reads the module again through
//   the read the load makes (`readModuleInto`, `rereadsOf`), keeping the
//   rows it has while the read is out (Issue #198).
import { isSoftDeleted } from "@waste/domain/record-visibility"

import type { BusinessRecord, WorkspaceId } from "@/lib/data/business-modules"

import type { ApiClient } from "../client"
import { ApiProblem, genericProblem, isAccountRefusal, type Problem } from "../problem"
import { isLocalRefusal, moduleKeyOf, PartialWrite, statusToken, webIdOf, type CommandInput, type MappingContext, type Resolver, type Resource, type ResourceAdapter, type ServerModule } from "./adapter"
import { isCompanyRecord } from "./organisation"

export type ModuleStatus = "idle" | "not-granted" | "loading" | "ready" | "failed"

export type ModuleState = {
  status: ModuleStatus
  /** The module's records, in list order: the server's rows as the prototype shows them. Empty until `ready`. */
  records: BusinessRecord[]
  /** The server id behind each web id. */
  serverIds: ReadonlyMap<string, string>
  /** Why the last read or write failed, or why the module is not read at all; cleared by the next read. */
  problem: Problem | null
  /** The clock of the last successful read. */
  loadedAt: number | null
}

export type ServerRecordsState = ReadonlyMap<string, ModuleState>

export const IDLE: ModuleState = { status: "idle", records: [], serverIds: new Map(), problem: null, loadedAt: null }

/**
 * A module the person's `/me` role does not view (`viewableModules`): never
 * requested, so no read failed and nobody is told; `getRecords` answers its
 * fixtures as for `idle`, and its problem is the sentence a pane shows in
 * place of rows — a 403 in the API's shape, which ends no session.
 */
export function notGranted(moduleKey: string): ModuleState {
  return { ...IDLE, status: "not-granted", problem: genericProblem(403, `Your role does not allow view on ${moduleKey}`) }
}

/** The state with each of `modules` marked not granted and every other module as it stands; the same state when there are none. */
export function withNotGranted(state: ServerRecordsState, modules: readonly ServerModule[]): ServerRecordsState {
  if (modules.length === 0) return state
  const next = new Map(state)
  for (const module of modules) {
    const key = moduleKeyOf(module.workspaceId, module.moduleId)
    next.set(key, notGranted(key))
  }
  return next
}

/** The state of a module the store has been asked for; `IDLE` for one it has not. */
export function moduleState(state: ServerRecordsState, workspaceId: WorkspaceId, moduleId: string): ModuleState {
  return state.get(moduleKeyOf(workspaceId, moduleId)) ?? IDLE
}

/**
 * What `getRecords` answers for a switched module: the server's records once
 * they are here, the fixtures until then. Never both.
 */
export function recordsOf(module: ModuleState, fixtures: readonly BusinessRecord[]): BusinessRecord[] {
  return module.status === "ready" ? module.records : [...fixtures]
}

/** `notGranted` tells a pane its problem is the role's, not a read that failed: nothing was read, so it says the rows are not shown to the role. */
export type PaneAnswer = { records: BusinessRecord[]; ready: boolean; pending: boolean; notGranted: boolean; problem: Problem | null }

/**
 * What a pane reading its own switched module is told on the Pilot
 * (`useModuleRecords`): the rows once the module is ready; before, none — a
 * fixture shown there is a row that does not exist — `pending` while the
 * read is still to come or out, and otherwise the problem the pane shows in
 * their place: the API's for a read that failed, the store's own for a
 * module the person's role does not view (`notGranted`).
 */
export function paneAnswerOf(module: ModuleState): PaneAnswer {
  if (module.status === "ready") return { records: module.records, ready: true, pending: false, notGranted: false, problem: null }
  return { records: [], ready: false, pending: module.status === "idle" || module.status === "loading", notGranted: module.status === "not-granted", problem: module.problem }
}

/** The problem an unknown failure is reported as; a thrown `ApiProblem` is reported as itself. */
export function problemOfError(error: unknown): Problem {
  if (error instanceof ApiProblem) return error.problem
  return genericProblem(0, error instanceof Error ? error.message : "The request failed")
}

/** The adapter that owns a record, by the module's own order; undefined for a record no adapter claims. */
export function adapterFor(module: ServerModule, record: BusinessRecord): ResourceAdapter<Resource> | undefined {
  return module.resources.find((resource) => resource.owns(record))
}

/**
 * A resolver over every loaded module's rows, and over the rows a load has
 * mapped so far (`extra`), so an adapter listed after another in one module
 * sees that one's records. Server ids are unique across tables (UUIDv7), so
 * one map serves every kind. The loaded modules are indexed by server id the
 * first time one is asked for, since a mapping may ask for hundreds — a
 * scheme's matched containers — and most of them are rows of a module not
 * read from the API, which only a full scan would otherwise rule out; the
 * rows a load is still mapping are read as they grow.
 */
export function resolverOver(state: ServerRecordsState, extra?: { records: readonly BusinessRecord[]; serverIds: ReadonlyMap<string, string> }): Resolver {
  const modules = [...state.values()].filter((module) => module.status === "ready")
  const sources = extra === undefined ? modules : [...modules, { records: extra.records, serverIds: extra.serverIds }]
  let loadedByServerId: Map<string, BusinessRecord | undefined> | undefined
  const indexOfLoaded = () => {
    if (loadedByServerId === undefined) {
      loadedByServerId = new Map()
      for (const module of modules) {
        const byWebId = new Map(module.records.map((record) => [record.id, record]))
        for (const [webId, id] of module.serverIds) if (!loadedByServerId.has(id)) loadedByServerId.set(id, byWebId.get(webId))
      }
    }
    return loadedByServerId
  }
  return {
    byServerId: (serverId) => {
      const loaded = indexOfLoaded()
      if (loaded.has(serverId)) return loaded.get(serverId)
      if (extra === undefined) return undefined
      for (const [webId, id] of extra.serverIds) {
        if (id === serverId) return extra.records.find((record) => record.id === webId)
      }
      return undefined
    },
    serverIdOf: (webId) => {
      for (const source of sources) {
        const found = source.serverIds.get(webId)
        if (found !== undefined) return found
      }
      return undefined
    },
    find: (predicate) => {
      for (const source of sources) {
        const found = source.records.find(predicate)
        if (found !== undefined) return found
      }
      return undefined
    },
  }
}

/**
 * The web id of the company record, once the organisation module has loaded
 * it; undefined before. Asked of the company adapter's own `owns` and the
 * record's kind, not of the id prefix alone: a customer organisation carries
 * `company-` too (registry.ts), and the tenant is the one row that is a
 * Company.
 */
export function companyRecordIdOf(state: ServerRecordsState): string | undefined {
  const organisation = state.get(moduleKeyOf("configure", "organization"))
  return organisation?.records.find(isCompanyRecord)?.id
}

export type LoadResult = { records: BusinessRecord[]; serverIds: Map<string, string> }

export type LoadOptions = {
  /** The module's fixtures, the seed's origin. */
  fixtures: readonly BusinessRecord[]
  /** Everything loaded so far, for the resolver. */
  state: ServerRecordsState
  now?: Date
}

/**
 * Every row of a module, listed adapter by adapter and mapped in list order,
 * each mapping resolving against what is loaded and what this load has
 * mapped before it.
 */
export async function loadModule(client: ApiClient, module: ServerModule, { fixtures, state, now }: LoadOptions): Promise<LoadResult> {
  const records: BusinessRecord[] = []
  const serverIds = new Map<string, string>()
  // The lists go out together; only the mapping runs in the module's order,
  // so an adapter listed after another still sees that one's rows.
  const lists = await Promise.all(module.resources.map((adapter) => (adapter.list === null ? null : adapter.list(client))))
  for (const [index, adapter] of module.resources.entries()) {
    const resources = lists[index]
    if (resources === null) continue
    const context: MappingContext = { fixtures, resolve: resolverOver(state, { records, serverIds }), companyRecordId: companyRecordIdOf(state), now }
    for (const resource of resources) {
      const mapped = adapter.toRecord(resource, context)
      // A fixture lends its id to one row. A second row the mapping matches
      // onto the same fixture (two accounts with one full name) keeps the
      // server's id instead, so no two rows share a web id — a write or a
      // command looks the server id up by it and would reach the wrong row.
      const record = serverIds.has(mapped.id) ? { ...mapped, id: webIdOf(adapter.prefix, resource.id) } : mapped
      records.push(record)
      serverIds.set(record.id, resource.id)
    }
  }
  return { records, serverIds }
}

/** The state after a read began. */
export function loading(module: ModuleState): ModuleState {
  return { ...module, status: module.status === "ready" ? "ready" : "loading", problem: null }
}

/** The state after a read answered. */
export function loaded(result: LoadResult, now: number): ModuleState {
  return { status: "ready", records: result.records, serverIds: result.serverIds, problem: null, loadedAt: now }
}

/** The state after a read failed: a module that was ready keeps its rows and notes the problem; one that was not is `failed`. */
export function loadFailed(module: ModuleState, problem: Problem): ModuleState {
  return { ...module, status: module.status === "ready" ? "ready" : "failed", problem }
}

/** The store's server-backed state as a read writes it: the external store's own two members. */
export type ServerStore = {
  getSnapshot: () => ServerRecordsState
  set: (update: (state: ServerRecordsState) => ServerRecordsState) => void
}

export type ReadOptions = {
  /** The module's fixtures, the seed's origin. */
  fixtures: readonly BusinessRecord[]
  /** Whether the session the read belongs to is still the store's: false once the person or the API has changed. */
  alive: () => boolean
  /** The clock a read that lands is stamped with. */
  now?: () => number
}

/**
 * One module read into the store: the load's read of each module, and the
 * read again after a command changed its rows (Issue #198). The module is
 * `loading` while the read is out, so one that was ready keeps its rows;
 * then it holds the API's rows, or the problem beside the rows it had. Once
 * `alive` says the session is over nothing is written, not even the
 * `loading` mark, which would land in the next session's store. The account's
 * own refusal is written nowhere either, since it has ended the session and
 * /login says why. The problem comes back for the caller to report.
 */
export async function readModuleInto(store: ServerStore, client: ApiClient, module: ServerModule, { fixtures, alive, now = Date.now }: ReadOptions): Promise<Problem | null> {
  if (!alive()) return null
  const key = moduleKeyOf(module.workspaceId, module.moduleId)
  store.set((state) => new Map(state).set(key, loading(state.get(key) ?? IDLE)))
  try {
    const result = await loadModule(client, module, { fixtures, state: store.getSnapshot() })
    if (alive()) store.set((state) => new Map(state).set(key, loaded(result, now())))
    return null
  } catch (error) {
    const problem = problemOfError(error)
    if (alive() && !isAccountRefusal(problem)) store.set((state) => new Map(state).set(key, loadFailed(state.get(key) ?? IDLE, problem)))
    return problem
  }
}

/**
 * Of `modules`, in their order, the ones a done command touched
 * (`CommandOutcome.touches`) that the store is to read again: each it holds
 * ready, or still on its first read, which the read again then follows. A
 * module the store holds in any other state — never asked for, not the
 * person's to view, or whose read failed — is left as it stands.
 */
export function rereadsOf(state: ServerRecordsState, touches: readonly string[], modules: readonly ServerModule[]): ServerModule[] {
  return modules.filter((module) => {
    const key = moduleKeyOf(module.workspaceId, module.moduleId)
    const status = state.get(key)?.status
    return touches.includes(key) && (status === "ready" || status === "loading")
  })
}

/** The module with one record replaced or, when it is new, put first — the browser store's own order. */
export function withRecord(module: ModuleState, record: BusinessRecord, serverId?: string): ModuleState {
  const exists = module.records.some((candidate) => candidate.id === record.id)
  const records = exists ? module.records.map((candidate) => (candidate.id === record.id ? record : candidate)) : [record, ...module.records]
  const serverIds = new Map(module.serverIds)
  if (serverId !== undefined) serverIds.set(record.id, serverId)
  return { ...module, records, serverIds }
}

/** The module without a record the API never took: an optimistic create rolled back. */
export function withoutRecord(module: ModuleState, recordId: string): ModuleState {
  const serverIds = new Map(module.serverIds)
  serverIds.delete(recordId)
  return { ...module, records: module.records.filter((candidate) => candidate.id !== recordId), serverIds }
}

/**
 * The module with a record the API has just created: the server's answer,
 * mapped, under the web id the workspace minted for it. The id stays the
 * minted one for the rest of the session — the workspace has already put it
 * in the address bar, selected it and may have linked to it, and the
 * prototype treats a minted id as canonical — and the adapter's own id (a
 * fixture's, or `<prefix>-<uuid>`) takes over on the next load, when the
 * row is read back from the server. The server id is what the row is
 * written under either way.
 */
export function withCreated(module: ModuleState, optimisticId: string, written: BusinessRecord, serverId: string): ModuleState {
  return withRecord(module, { ...written, id: optimisticId }, serverId)
}

export type WriteOutcome =
  | { kind: "created"; record: BusinessRecord; serverId: string; optimisticId: string }
  | { kind: "updated"; record: BusinessRecord; serverId: string }
  | { kind: "unchanged"; record: BusinessRecord }
  /** `record`, when part of a write landed before the refusal: the row as the server now holds it, which the store shows instead of the row as it was. */
  | { kind: "refused"; problem: Problem; recordId: string; record?: BusinessRecord }

/** The 400 a local refusal stands for, in the API's own shape, so a caller reads one. */
export function refusalProblem(refusal: { path: string; message: string }): Problem {
  return { type: "about:blank", title: "Bad Request", status: 400, detail: "The request body is invalid", errors: [{ path: refusal.path, message: refusal.message }] }
}

/**
 * Whether the adapter that owns a record can say a status on the wire: the
 * lifecycle's label as the wire's token (`Inactive` → `inactive`) is one of
 * the adapter's `statuses`. False for a record no adapter owns and for a
 * kind whose status the API does not take on a patch.
 */
export function spellsStatus(module: ServerModule, record: BusinessRecord, status: string): boolean {
  const adapter = adapterFor(module, record)
  return adapter?.statuses?.includes(statusToken(status)) ?? false
}

/** The refusal a status move the wire cannot spell gets, naming the field and the words it has. */
function statusRefusal(adapter: ResourceAdapter<Resource>, status: string): Problem {
  const words = adapter.statuses ?? []
  return refusalProblem({
    path: "status",
    message: words.length === 0 ? `The API does not change a ${adapter.prefix}'s status` : `The API has no status "${status}" for a ${adapter.prefix}; it knows ${words.join(", ")}`,
  })
}

/**
 * Writes one record through its adapter: a create when the module holds no
 * server id for it, a patch of what moved otherwise, nothing when nothing
 * moved. `before` is the row as the module last had it, for the patch. A
 * soft delete and a move to a status the adapter cannot spell are refused
 * before anything is sent (the header says why).
 */
export async function writeRecord(client: ApiClient, module: ServerModule, current: ModuleState, record: BusinessRecord, options: LoadOptions): Promise<WriteOutcome> {
  const adapter = adapterFor(module, record)
  if (adapter === undefined) {
    return { kind: "refused", recordId: record.id, problem: genericProblem(400, `${module.workspaceId}.${module.moduleId} has no server resource for ${record.id}`) }
  }
  if (isSoftDeleted(record)) {
    return { kind: "refused", recordId: record.id, problem: genericProblem(400, `The API has no delete: a ${adapter.prefix} is deactivated or moved to another status, not deleted`) }
  }
  const context: MappingContext = { fixtures: options.fixtures, resolve: resolverOver(options.state), companyRecordId: companyRecordIdOf(options.state), now: options.now }
  const serverId = current.serverIds.get(record.id)
  try {
    if (serverId === undefined) {
      if (adapter.toCreateBody === undefined || adapter.create === undefined) {
        return { kind: "refused", recordId: record.id, problem: genericProblem(400, `A ${adapter.prefix} is not created here`) }
      }
      const body = adapter.toCreateBody(record, context)
      if (isLocalRefusal(body)) return { kind: "refused", recordId: record.id, problem: refusalProblem(body) }
      const resource = await adapter.create(client, body)
      return { kind: "created", record: adapter.toRecord(resource, context), serverId: resource.id, optimisticId: record.id }
    }
    const before = current.records.find((candidate) => candidate.id === record.id) ?? record
    if (before.status !== record.status && !spellsStatus(module, record, record.status)) {
      return { kind: "refused", recordId: record.id, problem: statusRefusal(adapter, record.status) }
    }
    const body = adapter.toPatchBody(before, record, context)
    if (body === null) return { kind: "unchanged", record }
    if (isLocalRefusal(body)) return { kind: "refused", recordId: record.id, problem: refusalProblem(body) }
    const resource = await adapter.update(client, serverId, body)
    // Under the row's own web id, whatever the mapping would now derive — a
    // fixture matched by a name the write just changed — so one server row
    // stays one row here, as `withCreated` keeps a minted id.
    return { kind: "updated", record: { ...adapter.toRecord(resource, context), id: record.id }, serverId: resource.id }
  } catch (error) {
    if (error instanceof PartialWrite) {
      return { kind: "refused", recordId: record.id, problem: problemOfError(error.refusal), record: { ...adapter.toRecord(error.resource, context), id: record.id } }
    }
    return { kind: "refused", recordId: record.id, problem: problemOfError(error) }
  }
}

/**
 * `touches` are the other modules the command may have changed rows of
 * (`RecordCommand.touches`), which the store reads again: those it names
 * once the API has had it — refused or not, since a request of the command
 * may land before another fails — and none for a command never sent.
 */
export type CommandOutcome =
  | { kind: "done"; record: BusinessRecord; serverId: string; touches: readonly string[] }
  /** `what` is the heading the person is told the refusal under; the problem is the API's, or the store's own for a command that was never sent. */
  | { kind: "refused"; what: string; problem: Problem; recordId: string; touches: readonly string[] }

/**
 * Sends one of a row's commands (adapter.ts, `commands`) and maps the answer
 * as a read is mapped, under the row's own web id: a row the workspace
 * minted this session keeps its minted id, as `withCreated` keeps it. Nothing
 * is sent for a record no adapter owns, a command the adapter does not have,
 * or a row the server does not hold yet — an optimistic create still in
 * flight — and each is refused with a sentence; nor for a body the command's
 * `toBody` refuses, which comes back as the 400 a write's local refusal is.
 * A refusal the API answers comes back as its problem.
 */
export async function commandRecord(client: ApiClient, module: ServerModule, current: ModuleState, record: BusinessRecord, name: string, input: CommandInput | undefined, options: LoadOptions): Promise<CommandOutcome> {
  const adapter = adapterFor(module, record)
  const command = adapter?.commands?.[name]
  const what = command?.refused(record) ?? `${record.name} was not changed`
  const refused = (problem: Problem, touches: readonly string[] = []): CommandOutcome => ({ kind: "refused", what, problem, recordId: record.id, touches })
  if (adapter === undefined) return refused(genericProblem(400, `${moduleKeyOf(module.workspaceId, module.moduleId)} has no server resource for ${record.id}`))
  if (command === undefined) return refused(genericProblem(400, `The API has no "${name}" for a ${adapter.prefix}`))
  const serverId = current.serverIds.get(record.id)
  if (serverId === undefined) return refused(genericProblem(400, `${record.name} is not on the API yet: wait for it to be saved, then try again`))
  const context: MappingContext = { fixtures: options.fixtures, resolve: resolverOver(options.state), companyRecordId: companyRecordIdOf(options.state), now: options.now }
  const touches = command.touches ?? []
  let sent = false
  try {
    // Inside the try: a mapper that throws on a stray input is a refusal under the command's heading, as a failing request is.
    const body = command.toBody?.(input ?? {}, record, context)
    if (isLocalRefusal(body)) return refused(refusalProblem(body))
    sent = true
    const resource = await command.run(client, serverId, body)
    return { kind: "done", record: { ...adapter.toRecord(resource, context), id: record.id }, serverId: resource.id, touches }
  } catch (error) {
    // A command of several requests (a movement, then the row read back) may have changed what it touches before one failed.
    return refused(problemOfError(error), sent ? touches : [])
  }
}
