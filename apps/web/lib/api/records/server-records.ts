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
//   (`withCreated`), since the address bar, the selection and its links
//   already carry it, across every read again of its module (`mapModule`,
//   #240), as every row keeps the id it was first read under; the adapter's
//   id is the next session's.
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
import { dayIn } from "./planning"

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
  /** A module read through others (`ServerModule.derivedFrom`, #232): their rows, by key, as the snapshot its last read began with held them, null where one was not ready. */
  mappedAgainst?: ReadonlyMap<string, readonly BusinessRecord[] | null>
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
 * rows a load is still mapping come indexed by the load (`byServerId`), which
 * files each as it is mapped — a route's stops ask for their route and its
 * container by the hundred, and most of those miss. By server id the load's
 * row comes first: a module read again holds the row in the store as well,
 * under the same web id (#240), and the load's is the one just listed.
 */
export function resolverOver(state: ServerRecordsState, extra?: { records: readonly BusinessRecord[]; serverIds: ReadonlyMap<string, string>; byServerId: ReadonlyMap<string, BusinessRecord> }): Resolver {
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
      const mapping = extra?.byServerId.get(serverId)
      if (mapping !== undefined) return mapping
      return indexOfLoaded().get(serverId)
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
    filter: (predicate) => {
      // A module read again while ready is both in the state and the extra: each record once, the loaded first, as `find` prefers it.
      const seen = new Set<string>()
      const found: BusinessRecord[] = []
      for (const source of sources) {
        for (const record of source.records) {
          if (seen.has(record.id)) continue
          seen.add(record.id)
          if (predicate(record)) found.push(record)
        }
      }
      return found
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

/** Each adapter's list, in the module's order: null for one that lists nothing. */
export type ModuleLists = readonly (readonly Resource[] | null)[]

/** Every list of a module, sent together; only the mapping runs in the module's order. */
export function listModule(client: ApiClient, module: ServerModule): Promise<ModuleLists> {
  return Promise.all(module.resources.map((adapter) => (adapter.list === null ? null : adapter.list(client))))
}

/**
 * The web ids the store holds a module's rows under, by server id, for the
 * rows its lists hold again (#240): the first where it holds two, as the
 * resolver answers.
 */
function heldIdsOf(held: ModuleState | undefined, lists: ModuleLists): Map<string, string> {
  const ids = new Map<string, string>()
  if (held === undefined || held.serverIds.size === 0) return ids
  const listed = new Set(lists.flatMap((resources) => (resources ?? []).map((resource) => resource.id)))
  for (const [webId, serverId] of held.serverIds) if (listed.has(serverId) && !ids.has(serverId)) ids.set(serverId, webId)
  return ids
}

/**
 * A module's lists mapped adapter by adapter, in list order, each mapping
 * resolving against what is loaded and what this mapping has mapped before
 * it. A row the store already holds keeps the web id it holds it under
 * (#240): a row made this session stays under the id it was minted (the
 * address bar, the selection and every link that names it hold that id), and
 * a row read before stays under the one it was read under, whatever the
 * mapping derives now. Those ids are claimed before any row is mapped, so
 * which one a row keeps never hangs on the list's order; a session's first
 * read takes the adapter's.
 */
export function mapModule(module: ServerModule, lists: ModuleLists, { fixtures, state, now }: LoadOptions): LoadResult {
  const records: BusinessRecord[] = []
  const serverIds = new Map<string, string>()
  const byServerId = new Map<string, BusinessRecord>()
  const heldIds = heldIdsOf(state.get(moduleKeyOf(module.workspaceId, module.moduleId)), lists)
  const claimed = new Set(heldIds.values())
  for (const [index, adapter] of module.resources.entries()) {
    const resources = lists[index]
    if (resources === null) continue
    const context: MappingContext = { fixtures, resolve: resolverOver(state, { records, serverIds, byServerId }), companyRecordId: companyRecordIdOf(state), now }
    for (const resource of resources) {
      const mapped = adapter.toRecord(resource, context)
      // A fixture lends its id to one row. A second row the mapping matches
      // onto the same fixture (two accounts with one full name), or onto an
      // id another row is held under, keeps the server's id instead, so no
      // two rows share a web id — a write or a command looks the server id
      // up by it and would reach the wrong row.
      const id = heldIds.get(resource.id) ?? (serverIds.has(mapped.id) || claimed.has(mapped.id) ? webIdOf(adapter.prefix, resource.id) : mapped.id)
      const record = id === mapped.id ? mapped : { ...mapped, id }
      records.push(record)
      serverIds.set(record.id, resource.id)
      byServerId.set(resource.id, record)
    }
  }
  return { records, serverIds }
}

/** Every row of a module: its lists, then their mapping against `state`. */
export async function loadModule(client: ApiClient, module: ServerModule, options: LoadOptions): Promise<LoadResult> {
  return mapModule(module, await listModule(client, module), options)
}

/** The state after a read began. */
export function loading(module: ModuleState): ModuleState {
  return { ...module, status: module.status === "ready" ? "ready" : "loading", problem: null }
}

/** The state after a read answered, stamped with what a module read through others was mapped against. */
export function loaded(result: LoadResult, now: number, mappedAgainst?: ReadonlyMap<string, readonly BusinessRecord[] | null>): ModuleState {
  return { status: "ready", records: result.records, serverIds: result.serverIds, problem: null, loadedAt: now, ...(mappedAgainst === undefined ? {} : { mappedAgainst }) }
}

const readyRowsOf = (module: ModuleState | undefined): readonly BusinessRecord[] | null => (module?.status === "ready" ? module.records : null)

/** What a read of a module read through others is mapped against (#232): their rows, by key, in `state` — the snapshot the read began with — null where one is not ready; undefined for any other module. */
export function mappedAgainstOf(module: ServerModule, state: ServerRecordsState): ReadonlyMap<string, readonly BusinessRecord[] | null> | undefined {
  if (module.derivedFrom === undefined) return undefined
  return new Map(module.derivedFrom.map((key) => [key, readyRowsOf(state.get(key))]))
}

/**
 * The modules a derived module is read through that have new rows since it
 * was mapped (#232): a write, a read again, one ready after it was read. The
 * rows' identity says so, never a module state's, so one not ready now —
 * loading, failed, not granted — says nothing new: it never counts, and a
 * read again of the derived module stamped with it unready never asks for
 * another. Nothing while the derived module is not ready or was never
 * stamped.
 */
export function derivedFromChanged(derived: ModuleState | undefined, state: ServerRecordsState): string[] {
  if (derived?.status !== "ready" || derived.mappedAgainst === undefined) return []
  return [...derived.mappedAgainst].filter(([key, rows]) => {
    const now = readyRowsOf(state.get(key))
    return now !== null && now !== rows
  }).map(([key]) => key)
}

/**
 * The rows a derived module's sources hold now, in its stamp's order: what
 * the store remembers a read again was asked for at, so a read that failed
 * is not asked for again until a source changes once more.
 */
export function derivedSourcesNow(derived: ModuleState | undefined, state: ServerRecordsState): readonly (readonly BusinessRecord[] | null)[] {
  return [...(derived?.mappedAgainst?.keys() ?? [])].map((key) => readyRowsOf(state.get(key)))
}

/** Whether two readings of the sources are the same rows. */
export function sameSources(a: readonly (readonly BusinessRecord[] | null)[] | undefined, b: readonly (readonly BusinessRecord[] | null)[]): boolean {
  return a !== undefined && a.length === b.length && a.every((rows, index) => rows === b[index])
}

/** The timezones of the projects the organisation module holds, the clocks a derived module's day turns on. */
export function projectTimezonesOf(state: ServerRecordsState): string[] {
  const zones = (readyRowsOf(state.get("configure.organization")) ?? []).map((record) => record.submittedValues?.timezone)
  return [...new Set(zones.filter((zone): zone is string => typeof zone === "string" && zone !== ""))]
}

const zonesOr = (timezones: readonly (string | undefined)[]) => (timezones.length === 0 ? [undefined] : timezones)

/** Whether a project's day has turned between `then` and `now`, on any of the projects' clocks (the browser's without one). */
export function dayTurned(then: number, now: number, timezones: readonly (string | undefined)[]): boolean {
  return zonesOr(timezones).some((zone) => dayIn(new Date(then), zone) !== dayIn(new Date(now), zone))
}

/**
 * The modules to read again at the turn of a project's day (#232): each
 * ready one that reads the day (`readsTheDay`) and was read before it turned
 * — but not one read through another that is read again too, since that
 * read's new rows bring it after (`derivedFromChanged`), mapped against the
 * day's readings rather than yesterday's.
 */
export function dayTurnRereads(state: ServerRecordsState, modules: readonly ServerModule[], now: number, timezones: readonly (string | undefined)[]): ServerModule[] {
  const keyOf = (module: ServerModule) => moduleKeyOf(module.workspaceId, module.moduleId)
  const turned = modules.filter((module) => {
    const current = state.get(keyOf(module))
    return module.readsTheDay === true && current?.status === "ready" && current.loadedAt !== null && dayTurned(current.loadedAt, now, timezones)
  })
  const again = new Set(turned.map(keyOf))
  return turned.filter((module) => !(module.derivedFrom ?? []).some((source) => again.has(source)))
}

/** How long from `now` until the first of the projects' days turns, to the second. */
export function untilDayTurns(now: number, timezones: readonly (string | undefined)[]): number {
  const DAY = 26 * 60 * 60 * 1000
  let low = 0
  let high = DAY
  while (high - low > 1000) {
    const middle = Math.floor((low + high) / 2)
    if (dayTurned(now, now + middle, timezones)) high = middle
    else low = middle
  }
  return high
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
    const started = store.getSnapshot()
    const lists = await listModule(client, module)
    if (!alive()) return null
    // Mapped against the store as the answer lands, so a row made while the
    // read was out keeps the id it was minted under and the rows that name it
    // name that one (#240). The stamp is the snapshot the read began with:
    // the server's answer is no newer.
    const result = mapModule(module, lists, { fixtures, state: store.getSnapshot() })
    store.set((state) => new Map(state).set(key, loaded(result, now(), mappedAgainstOf(module, started))))
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
 * prototype treats a minted id as canonical — across every read again of the
 * module in the session (`mapModule`, #240); the adapter's own id (a
 * fixture's, or `<prefix>-<uuid>`) is the next session's. The server id is
 * what the row is written under either way. A read that landed before the
 * answer holds the row already, under the adapter's id: the minted one takes
 * its place, so one server row is one row here.
 */
export function withCreated(module: ModuleState, optimisticId: string, written: BusinessRecord, serverId: string): ModuleState {
  const readFirst = [...module.serverIds].filter(([webId, id]) => id === serverId && webId !== optimisticId).map(([webId]) => webId)
  return withRecord(readFirst.reduce(withoutRecord, module), { ...written, id: optimisticId }, serverId)
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

export type ActionOutcome<Answer = unknown> =
  | { kind: "done"; answer: Answer }
  /** As a command's: the heading, and the API's problem or the store's own for an action that was never sent. */
  | { kind: "refused"; what: string; problem: Problem; recordId: string }

/** The store's `sendAction`, as a page holds it and an adapter's typed wrapper takes it; `report: false` leaves a refusal to the caller, as `upsertRecord`'s does. */
export type SendAction = (workspaceId: WorkspaceId, moduleId: string, recordId: string, name: string, input?: CommandInput, options?: { report?: boolean }) => Promise<ActionOutcome>

/**
 * Sends one of a row's actions (adapter.ts, `actions`) and hands back what
 * it answered: another resource, never the row, which stays as it is. The
 * refusals are a command's — nothing is sent for a record no adapter owns,
 * an action the adapter does not have, a row the server does not hold yet
 * or an input the action's `toBody` refuses — and a refusal the API answers
 * comes back as its problem.
 */
export async function actOnRecord<Answer = unknown>(client: ApiClient, module: ServerModule, current: ModuleState, record: BusinessRecord, name: string, input: CommandInput | undefined, options: LoadOptions): Promise<ActionOutcome<Answer>> {
  const adapter = adapterFor(module, record)
  const action = adapter?.actions?.[name]
  const what = action?.refused(record) ?? `Nothing was done to ${record.name}`
  const refused = (problem: Problem): ActionOutcome<Answer> => ({ kind: "refused", what, problem, recordId: record.id })
  if (adapter === undefined) return refused(genericProblem(400, `${moduleKeyOf(module.workspaceId, module.moduleId)} has no server resource for ${record.id}`))
  if (action === undefined) return refused(genericProblem(400, `The API has no "${name}" for a ${adapter.prefix}`))
  const serverId = current.serverIds.get(record.id)
  if (serverId === undefined) return refused(genericProblem(400, `${record.name} is not on the API yet: wait for it to be saved, then try again`))
  const context: MappingContext = { fixtures: options.fixtures, resolve: resolverOver(options.state), companyRecordId: companyRecordIdOf(options.state), now: options.now }
  try {
    const body = action.toBody?.(input ?? {}, record, context)
    if (isLocalRefusal(body)) return refused(refusalProblem(body))
    return { kind: "done", answer: (await action.run(client, serverId, body)) as Answer }
  } catch (error) {
    return refused(problemOfError(error))
  }
}

export type RereadOutcome =
  | { kind: "done"; record: BusinessRecord; serverId: string }
  | { kind: "refused"; problem: Problem; recordId: string }

/**
 * Reads one row back through its adapter's own read and maps it as a load
 * does, under the row's own web id: for a row the server changed on its own
 * account, as a scheme's generation reading moves when its run finishes.
 * Nothing is read for a record no adapter owns, a kind whose adapter reads
 * no single row, or a row the server does not hold yet.
 */
export async function rereadRecord(client: ApiClient, module: ServerModule, current: ModuleState, record: BusinessRecord, options: LoadOptions): Promise<RereadOutcome> {
  const adapter = adapterFor(module, record)
  const refused = (problem: Problem): RereadOutcome => ({ kind: "refused", problem, recordId: record.id })
  if (adapter === undefined) return refused(genericProblem(400, `${moduleKeyOf(module.workspaceId, module.moduleId)} has no server resource for ${record.id}`))
  if (adapter.read === undefined) return refused(genericProblem(400, `A ${adapter.prefix} is not read back on its own`))
  const serverId = current.serverIds.get(record.id)
  if (serverId === undefined) return refused(genericProblem(400, `${record.name} is not on the API yet`))
  const context: MappingContext = { fixtures: options.fixtures, resolve: resolverOver(options.state), companyRecordId: companyRecordIdOf(options.state), now: options.now }
  try {
    const resource = await adapter.read(client, serverId)
    return { kind: "done", record: { ...adapter.toRecord(resource, context), id: record.id }, serverId: resource.id }
  } catch (error) {
    return refused(problemOfError(error))
  }
}
