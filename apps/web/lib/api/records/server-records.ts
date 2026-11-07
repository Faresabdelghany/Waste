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
//   sentence for a pane to show. Where no API is configured every switched
//   module is `kept-on-api` (`KEPT_ON_API`): the API is its one source, and
//   the browser keeps no copy of it. Until it is `ready` the store answers
//   no rows of it at all.
//
//   A record's web id is the adapter's (adapter.ts: `<prefix>-<uuid>`), and the server's
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
//   Without that, the store tells it apart itself (#263): the write's
//   requests go through a client that notes whether a mutation landed and
//   whether a mutation failed. One that landed with none failing — a read
//   back, a mapper or an answer's body failed after it — is `landed`; one
//   that landed before another mutation failed is a `partial` refusal, the
//   row kept as typed and the module read again, never put back as the
//   server no longer holds it; and a command's movement that landed with
//   none failing is `landed`, which the store answers as done once it has
//   read the row again. An adapter does its reads after its writes, so a
//   read never decides a later mutation.
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
//
//   A load's mapping is handed a resolver and a clock that note what it asks
//   (`MappingReads`): the rows of other modules it named, the modules it
//   scanned, the ids it found nowhere, and the project's day on each clock it
//   read one on. Nothing declares them, so the store reads a module again
//   once a row it named has moved, a module it missed a row of comes to hold
//   it, or the day it read has turned (`readsChanged`, `dayTurnRereads`) — a
//   module read before the one it names is read again once that one lands,
//   so the order the store reads them in decides how many reads a load
//   takes, never which rows it shows. A row a read maps the same as the one
//   the store holds stays the object the store holds, so a module read again
//   to no change moves nothing that read it.
import { isSoftDeleted } from "@/lib/prototype/record-visibility"

import type { BusinessRecord, WorkspaceId } from "@/lib/data/business-modules"

import { UNREACHABLE_STATUS, type ApiClient } from "../client"
import { ApiProblem, genericProblem, isAccountRefusal, problemOfError, type Problem } from "../problem"
import { isLocalRefusal, moduleKeyOf, PartialWrite, recordFrom, statusToken, webIdOf, type CommandInput, type LocalRefusal, type MappingContext, type Resolver, type Resource, type ResourceAdapter, type ServerModule } from "./adapter"
import { dayIn } from "./clock"

export type ModuleStatus = "idle" | "not-granted" | "loading" | "ready" | "failed" | "kept-on-api"

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
  /** What the last read's mapping read beside the module's own rows; absent until a read has landed. */
  reads?: MappingReads
}

/**
 * What a module's last read was mapped against beside its own rows, as the
 * resolver and the clock saw the mapping ask (#232): the store's reason to
 * read the module again, and nothing an adapter declares.
 */
export type MappingReads = {
  /** Each other module's rows a lookup answered, by module key and web id: what of the row the mapping read, and the row as the store held it when the read began. */
  rows: ReadonlyMap<string, ReadonlyMap<string, RowRead>>
  /** Each other module a mapping scanned whole (`find`, `filter`). */
  scanned: ReadonlySet<string>
  /** The server ids and web ids a lookup found in no other module: a module that comes to hold one holds a row the mapping missed. */
  missed: { serverIds: ReadonlySet<string>; webIds: ReadonlySet<string> }
  /** Every other module's rows as the read began, null where one was not ready: a module holding these rows still has nothing new. */
  seen: ReadonlyMap<string, readonly BusinessRecord[] | null>
  /** The project's day the mapping read, by the clock it read it on, `""` the browser's. */
  days: ReadonlyMap<string, string>
}

/** The fields of one row a mapping read: each whole, or — a row's `facts` and `submittedValues` — key by key. A row only named by web id read none. */
export type FieldsRead = ReadonlyMap<string, true | ReadonlySet<string>>

/** One row a mapping named: the fields it read, and the row as the store held it when the read began, undefined where it held none. */
export type RowRead = { record: BusinessRecord | undefined; fields: FieldsRead }

export type ServerRecordsState = ReadonlyMap<string, ModuleState>

export const IDLE: ModuleState = { status: "idle", records: [], serverIds: new Map(), problem: null, loadedAt: null }

/**
 * What a page, a pane or a list whose subject the API alone holds says where
 * no API is configured: fixture mode keeps no copy of a switched module.
 */
export function keptOnApi(subject: string): string {
  return `${subject} is kept on the API: sign in on the Pilot to read it.`
}

/** Every switched module where no API is configured: no rows, and the sentence a pane shows in their place. */
export const KEPT_ON_API: ModuleState = { ...IDLE, status: "kept-on-api", problem: genericProblem(UNREACHABLE_STATUS, keptOnApi("This list")) }

/**
 * A module the person's `/me` role does not view (`viewableModules`): never
 * requested, so no read failed and nobody is told; its problem is the sentence a pane shows in
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

/** `notGranted` tells a pane its problem is the role's, not a read that failed: nothing was read, so it says the rows are not shown to the role. */
export type PaneAnswer = { records: BusinessRecord[]; ready: boolean; pending: boolean; notGranted: boolean; problem: Problem | null }

/**
 * What a pane reading its own switched module is told (`useModuleRecords`):
 * the rows once the module is ready; before, none — `pending` while the read
 * is still to come or out, and otherwise the problem the pane shows in their
 * place: the API's for a read that failed, the store's own for a module the
 * person's role does not view (`notGranted`) or one kept on the API where
 * none is configured.
 */
export function paneAnswerOf(module: ModuleState): PaneAnswer {
  if (module.status === "ready") return { records: module.records, ready: true, pending: false, notGranted: false, problem: null }
  return { records: [], ready: false, pending: module.status === "idle" || module.status === "loading", notGranted: module.status === "not-granted", problem: module.problem }
}

/** The adapter that owns a record, by the module's own order; undefined for a record no adapter claims. */
export function adapterFor(module: ServerModule, record: BusinessRecord): ResourceAdapter<Resource> | undefined {
  return module.resources.find((resource) => resource.owns(record))
}

/** The rows a load has mapped so far, under the key of the module it is loading. */
export type MappingRows = { key?: string; records: readonly BusinessRecord[]; serverIds: ReadonlyMap<string, string>; byServerId: ReadonlyMap<string, BusinessRecord> }

/** The fields of one row a mapping is reading, as it reads them. */
type FieldsNoted = Map<string, true | Set<string>>

/** What a load's resolver and clock note as its mapping asks, before the read's stamp is put on it (`readsOf`). */
type Noted = {
  rows: Map<string, Map<string, FieldsNoted>>
  /** The view of each row the mapping is handed, one per row, so a row is the same object every time it is asked for. */
  views: WeakMap<BusinessRecord, BusinessRecord>
  scanned: Set<string>
  missedServerIds: Set<string>
  missedWebIds: Set<string>
  days: Map<string, string>
}

const noting = (): Noted => ({ rows: new Map(), views: new WeakMap(), scanned: new Set(), missedServerIds: new Set(), missedWebIds: new Set(), days: new Map() })

/** The fields noted of one row of a module, made the first time the row is named. */
function fieldsOf(noted: Noted, key: string, webId: string): FieldsNoted {
  const byId = noted.rows.get(key) ?? new Map<string, FieldsNoted>()
  noted.rows.set(key, byId)
  const fields = byId.get(webId) ?? new Map()
  byId.set(webId, fields)
  return fields
}

/**
 * A row as a mapping is handed it: the row itself, behind a view that notes
 * each field read — whole, or key by key for a field that is an object (its
 * `facts`, its `submittedValues`) — so a row that moves only in what the
 * mapping never read (a live route's position) moves nothing that named it.
 */
function watched(record: BusinessRecord, fields: FieldsNoted): BusinessRecord {
  const whole = (field: string) => {
    fields.set(field, true)
  }
  const keyOf = (field: string, key: string) => {
    const keys = fields.get(field)
    if (keys === undefined) fields.set(field, new Set([key]))
    else if (keys !== true) keys.add(key)
  }
  const inner = new Map<string, object>()
  const objectView = (field: string, value: object): object => {
    let view = inner.get(field)
    if (view === undefined) {
      view = new Proxy(value, {
        get: (target, key, receiver) => {
          if (typeof key === "string") keyOf(field, key)
          return Reflect.get(target, key, receiver)
        },
        has: (target, key) => {
          if (typeof key === "string") keyOf(field, key)
          return Reflect.has(target, key)
        },
        ownKeys: (target) => {
          whole(field)
          return Reflect.ownKeys(target)
        },
      })
      inner.set(field, view)
    }
    return view
  }
  return new Proxy(record, {
    get: (target, field, receiver) => {
      const value: unknown = Reflect.get(target, field, receiver)
      if (typeof field !== "string") return value
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return objectView(field, value)
      whole(field)
      return value
    },
    has: (target, field) => {
      if (typeof field === "string") whole(field)
      return Reflect.has(target, field)
    },
    ownKeys: (target) => {
      for (const field of Object.keys(target)) whole(field)
      return Reflect.ownKeys(target)
    },
  })
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
 * under the same web id (#240), and the load's is the one just listed. A
 * load's resolver notes, in `noted`, every row of another module it answered
 * and the fields of it the mapping read (`watched`), every module it scanned
 * and every id it found nowhere; the loading module's own rows it does not
 * note.
 */
export function resolverOver(state: ServerRecordsState, extra?: MappingRows, noted?: Noted): Resolver {
  const own = extra?.key
  const modules = [...state].filter(([, module]) => module.status === "ready")
  const sources: (readonly [string | undefined, { records: readonly BusinessRecord[]; serverIds: ReadonlyMap<string, string> }])[] = extra === undefined ? modules : [...modules, [own, extra]]
  let loadedByServerId: Map<string, { key: string; record: BusinessRecord | undefined }> | undefined
  const indexOfLoaded = () => {
    if (loadedByServerId === undefined) {
      loadedByServerId = new Map()
      for (const [key, module] of modules) {
        const byWebId = rowsById(module.records)
        for (const [webId, id] of module.serverIds) if (!loadedByServerId.has(id)) loadedByServerId.set(id, { key, record: byWebId.get(webId) })
      }
    }
    return loadedByServerId
  }
  const answered = (key: string, record: BusinessRecord): BusinessRecord => {
    if (noted === undefined || key === own) return record
    const fields = fieldsOf(noted, key, record.id)
    let view = noted.views.get(record)
    if (view === undefined) {
      view = watched(record, fields)
      noted.views.set(record, view)
    }
    return view
  }
  const rowsOf = (moduleKey: string): readonly (readonly BusinessRecord[])[] => {
    if (moduleKey !== own) noted?.scanned.add(moduleKey)
    const loaded = state.get(moduleKey)
    return [...(loaded?.status === "ready" ? [loaded.records] : []), ...(extra !== undefined && moduleKey === own ? [extra.records] : [])]
  }
  return {
    byServerId: (serverId) => {
      const mapping = extra?.byServerId.get(serverId)
      if (mapping !== undefined) return mapping
      const loaded = indexOfLoaded().get(serverId)
      if (loaded?.record === undefined) {
        noted?.missedServerIds.add(serverId)
        return undefined
      }
      return answered(loaded.key, loaded.record)
    },
    serverIdOf: (webId) => {
      for (const [key, source] of sources) {
        const found = source.serverIds.get(webId)
        if (found === undefined) continue
        // Named, and nothing of it read: it moves the mapping only by going.
        if (noted !== undefined && key !== undefined && key !== own) fieldsOf(noted, key, webId)
        return found
      }
      noted?.missedWebIds.add(webId)
      return undefined
    },
    find: (moduleKey, predicate) => {
      for (const records of rowsOf(moduleKey)) {
        const found = records.find(predicate)
        if (found !== undefined) return found
      }
      return undefined
    },
    filter: (moduleKey, predicate) => {
      // A module read again while ready is both in the state and the extra: each record once, the loaded first, as `find` prefers it.
      const seen = new Set<string>()
      const found: BusinessRecord[] = []
      for (const records of rowsOf(moduleKey)) {
        for (const record of records) {
          if (seen.has(record.id)) continue
          seen.add(record.id)
          if (predicate(record)) found.push(record)
        }
      }
      return found
    },
  }
}

const indexes = new WeakMap<readonly BusinessRecord[], ReadonlyMap<string, BusinessRecord>>()

/** A module's rows by web id, indexed once per rows. */
function rowsById(records: readonly BusinessRecord[]): ReadonlyMap<string, BusinessRecord> {
  let index = indexes.get(records)
  if (index === undefined) {
    index = new Map(records.map((record) => [record.id, record]))
    indexes.set(records, index)
  }
  return index
}

export type LoadResult = { records: BusinessRecord[]; serverIds: Map<string, string>; reads?: MappingReads }

export type LoadOptions = {
  /** Everything loaded so far, for the resolver. */
  state: ServerRecordsState
  now?: Date
}

/** A load's options: beside what it is mapped against, the store as its read began, which its reads are stamped with (the state mapped against, where none is given). */
export type MapOptions = LoadOptions & { began?: ServerRecordsState }

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
 * read takes the adapter's. What the mapping asked of the resolver and the
 * clock comes back as its `reads`, stamped with the store as the read began
 * (`began`). A row mapped the same as the one the store holds under its id is
 * that one (`keptWhereSame`).
 */
export function mapModule(module: ServerModule, lists: ModuleLists, { state, now, began = state }: MapOptions): LoadResult {
  const key = moduleKeyOf(module.workspaceId, module.moduleId)
  const records: BusinessRecord[] = []
  const serverIds = new Map<string, string>()
  const byServerId = new Map<string, BusinessRecord>()
  const held = state.get(key)
  const heldIds = heldIdsOf(held, lists)
  const claimed = new Set(heldIds.values())
  const noted = noting()
  const today = (timezone: string | undefined) => {
    const day = dayIn(now ?? new Date(), timezone)
    noted.days.set(timezone ?? "", day)
    return day
  }
  for (const [index, adapter] of module.resources.entries()) {
    const resources = lists[index]
    if (resources === null) continue
    const context: MappingContext = { resolve: resolverOver(state, { key, records, serverIds, byServerId }, noted), now, today }
    for (const resource of resources) {
      const mapped = recordFrom(adapter, resource, context)
      // A row the mapping names by an id another row holds or is held under
      // keeps the server's id instead, so no two rows share a web id — a
      // write or a command looks the server id up by it and would reach the
      // wrong row.
      const id = heldIds.get(resource.id) ?? (serverIds.has(mapped.id) || claimed.has(mapped.id) ? webIdOf(adapter.prefix, resource.id) : mapped.id)
      const record = id === mapped.id ? mapped : { ...mapped, id }
      records.push(record)
      serverIds.set(record.id, resource.id)
      byServerId.set(resource.id, record)
    }
  }
  return { records: keptWhereSame(held?.status === "ready" ? held.records : [], records), serverIds, reads: readsOf(noted, began, key) }
}

/** Every row of a module: its lists, then their mapping against `state`. */
export async function loadModule(client: ApiClient, module: ServerModule, options: LoadOptions): Promise<LoadResult> {
  return mapModule(module, await listModule(client, module), options)
}

/** The members of a value that say something, as its JSON would: one holding undefined says nothing. */
const membersOf = (value: object): string[] => Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined)

/** Whether two values a mapping made read the same, as their JSON would, stopping at the first difference: a row's fields, its facts, its lists. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameValue(item, b[index]))
  const keys = membersOf(a)
  return keys.length === membersOf(b).length && keys.every((key) => sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/**
 * A read's rows with every one mapped the same as the row the store holds
 * under its id kept as the store's, and the store's rows themselves where
 * none moved: identity is what tells the modules that read them that a row
 * has moved (`readsChanged`), so a read again to no change moves nothing.
 */
function keptWhereSame(held: readonly BusinessRecord[], read: BusinessRecord[]): BusinessRecord[] {
  if (held.length === 0) return read
  const byId = rowsById(held)
  let unmoved = held.length === read.length
  const rows = read.map((record, index) => {
    const before = byId.get(record.id)
    const kept = before !== undefined && sameValue(before, record) ? before : record
    if (kept !== held[index]) unmoved = false
    return kept
  })
  return unmoved ? (held as BusinessRecord[]) : rows
}

const readyRowsOf = (module: ModuleState | undefined): readonly BusinessRecord[] | null => (module?.status === "ready" ? module.records : null)

/** What a load's mapping noted, stamped with the store as the read began: the rows it named as they stood then, and every other module's rows. */
function readsOf(noted: Noted, began: ServerRecordsState, key: string): MappingReads {
  const rows = new Map(
    [...noted.rows].map(([source, named]) => {
      const held = readyRowsOf(began.get(source))
      const byId = held === null ? undefined : rowsById(held)
      return [source, new Map([...named].map(([id, fields]): [string, RowRead] => [id, { record: byId?.get(id), fields }]))] as const
    }),
  )
  const seen = new Map([...began].filter(([source]) => source !== key).map(([source, module]) => [source, readyRowsOf(module)] as const))
  return { rows, scanned: noted.scanned, missed: { serverIds: noted.missedServerIds, webIds: noted.missedWebIds }, seen, days: noted.days }
}

/** The state after a read began. */
export function loading(module: ModuleState): ModuleState {
  return { ...module, status: module.status === "ready" ? "ready" : "loading", problem: null }
}

/** The state after a read answered, with what its mapping read. */
export function loaded(result: LoadResult, now: number): ModuleState {
  return { status: "ready", records: result.records, serverIds: result.serverIds, problem: null, loadedAt: now, ...(result.reads === undefined ? {} : { reads: result.reads }) }
}

/** Whether a row reads now as it did to the mapping that named it: there still, or not there still, and the same in every field it read. */
function readTheSame(now: BusinessRecord | undefined, { record, fields }: RowRead): boolean {
  if (now === record) return true
  if (now === undefined || record === undefined) return false
  const fieldOf = (row: BusinessRecord, field: string): unknown => (row as Record<string, unknown>)[field]
  for (const [field, read] of fields) {
    if (read === true) {
      if (!sameValue(fieldOf(now, field), fieldOf(record, field))) return false
      continue
    }
    const keyOf = (row: BusinessRecord, key: string): unknown => (fieldOf(row, field) as Record<string, unknown> | undefined)?.[key]
    for (const key of read) if (!sameValue(keyOf(now, key), keyOf(record, key))) return false
  }
  return true
}

/** Whether a module holds a row by one of the ids a mapping found nowhere. */
function holdsMissed(module: ModuleState, missed: MappingReads["missed"]): boolean {
  if (missed.serverIds.size === 0 && missed.webIds.size === 0) return false
  const held = serverIdsHeld(module.serverIds)
  for (const serverId of missed.serverIds) if (held.has(serverId)) return true
  for (const webId of missed.webIds) if (module.serverIds.has(webId)) return true
  return false
}

const heldServerIds = new WeakMap<ReadonlyMap<string, string>, ReadonlySet<string>>()

/** The server ids a module holds rows by, gathered once per module's ids. */
function serverIdsHeld(serverIds: ReadonlyMap<string, string>): ReadonlySet<string> {
  let held = heldServerIds.get(serverIds)
  if (held === undefined) {
    held = new Set(serverIds.values())
    heldServerIds.set(serverIds, held)
  }
  return held
}

const movedUnder = new WeakMap<MappingReads, Map<string, { rows: readonly BusinessRecord[]; moved: boolean }>>()

/** Whether a module has moved under what a read was mapped against, worked out once per rows of it: the store asks after every change. */
function movedUnderReads(reads: MappingReads, source: string, current: ModuleState): boolean {
  const known = movedUnder.get(reads) ?? new Map<string, { rows: readonly BusinessRecord[]; moved: boolean }>()
  movedUnder.set(reads, known)
  const last = known.get(source)
  if (last?.rows === current.records) return last.moved
  const named = reads.rows.get(source)
  const byId = rowsById(current.records)
  const moved = reads.scanned.has(source) || (named !== undefined && [...named].some(([id, read]) => !readTheSame(byId.get(id), read))) || holdsMissed(current, reads.missed)
  known.set(source, { rows: current.records, moved })
  return moved
}

/**
 * The other modules that have moved under what a ready module's last read
 * was mapped against (#232): a row it named that has moved in a field it
 * read, or gone, a module it scanned with new rows, a module that now holds a
 * row it found nowhere — a write, a read again, a module ready after it was
 * read, or one read before it. Rows say so, never a module state, so one not
 * ready now — loading, failed, not granted — says nothing new. Nothing while
 * the module is not ready or no read of it has landed.
 */
export function readsChanged(state: ServerRecordsState, key: string): string[] {
  const module = state.get(key)
  const reads = module?.reads
  if (module?.status !== "ready" || reads === undefined) return []
  const changed: string[] = []
  for (const [source, current] of state) {
    if (source === key || current.status !== "ready" || current.records === (reads.seen.get(source) ?? null)) continue
    if (movedUnderReads(reads, source, current)) changed.push(source)
  }
  return changed
}

/**
 * The rows now of the modules that have moved under a module's last read
 * (`readsChanged`): what the store remembers a read again was asked for at,
 * so a read that failed is not asked for again until one of them moves once
 * more — a module it never read moving says nothing.
 */
export function readSourcesNow(state: ServerRecordsState, key: string): ReadonlyMap<string, readonly BusinessRecord[] | null> {
  return new Map(readsChanged(state, key).map((source) => [source, readyRowsOf(state.get(source))] as const))
}

/** Whether two readings of the sources are the same rows. */
export function sameSources(a: ReadonlyMap<string, readonly BusinessRecord[] | null> | undefined, b: ReadonlyMap<string, readonly BusinessRecord[] | null>): boolean {
  return a !== undefined && a.size === b.size && [...b].every(([key, rows]) => a.has(key) && a.get(key) === rows)
}

/** The clocks the ready modules' reads read the project's day on, the browser's as undefined: the turns the store watches for. */
export function clocksRead(state: ServerRecordsState): (string | undefined)[] {
  const zones = new Set<string>()
  for (const module of state.values()) if (module.status === "ready") for (const zone of module.reads?.days.keys() ?? []) zones.add(zone)
  return [...zones].map((zone) => (zone === "" ? undefined : zone))
}

const zonesOr = (timezones: readonly (string | undefined)[]) => (timezones.length === 0 ? [undefined] : timezones)

/** Whether a project's day has turned between `then` and `now`, on any of the projects' clocks (the browser's without one). */
export function dayTurned(then: number, now: number, timezones: readonly (string | undefined)[]): boolean {
  return zonesOr(timezones).some((zone) => dayIn(new Date(then), zone) !== dayIn(new Date(now), zone))
}

/**
 * The modules to read again at the turn of a project's day (#232): each
 * ready one whose last read read a day that is no longer the day on its
 * clock. Each is read again whatever else is: a module read through another
 * that is read again too is read again by that one's new rows as well, where
 * they moved.
 */
export function dayTurnRereads(state: ServerRecordsState, modules: readonly ServerModule[], now: number): ServerModule[] {
  return modules.filter((module) => {
    const current = state.get(moduleKeyOf(module.workspaceId, module.moduleId))
    if (current?.status !== "ready") return false
    return [...(current.reads?.days ?? [])].some(([zone, day]) => dayIn(new Date(now), zone === "" ? undefined : zone) !== day)
  })
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
  /** Whether the session the read belongs to is still the store's: false once the person or the API has changed. */
  alive: () => boolean
  /** The clock a read that lands is stamped with. */
  now?: () => number
  /** The waits before a failure on the way is asked again (`READ_RETRY_DELAYS_MS`); a test hands its own. */
  retryDelaysMs?: readonly number[]
}

/**
 * How long a module's read waits before it asks again after a failure on the
 * way rather than an answer — a 5xx, or an API that did not answer: in a
 * page's burst of some forty reads, a connection the proxy finds reset is
 * one of them, and without a second ask the whole module stays failed for
 * the session (a master-data read lost so leaves every scheme form unable to
 * name its fraction). Once per delay, then the failure stands. A refusal the
 * API answered, a 4xx, says the same twice and is never asked again.
 */
export const READ_RETRY_DELAYS_MS: readonly number[] = [300, 1_000]

/** Whether a read failed on the way rather than by the API's answer: a 5xx or no answer at all. */
const failedOnTheWay = (error: unknown): boolean => error instanceof ApiProblem && (error.problem.status === UNREACHABLE_STATUS || error.problem.status >= 500)

/** The module's lists, asked again after each delay while the failure is on the way; undefined once the session ended during a wait. */
async function listModuleAgain(client: ApiClient, module: ServerModule, alive: () => boolean, delays: readonly number[]): Promise<ModuleLists | undefined> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await listModule(client, module)
    } catch (error) {
      const delay = delays[attempt]
      if (delay === undefined || !failedOnTheWay(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, delay))
      if (!alive()) return undefined
    }
  }
}

/**
 * One module read into the store: the load's read of each module, and the
 * read again after a command changed its rows (Issue #198). The module is
 * `loading` while the read is out, so one that was ready keeps its rows;
 * then it holds the API's rows, or the problem beside the rows it had. A
 * failure on the way is asked again first (`READ_RETRY_DELAYS_MS`). Once
 * `alive` says the session is over nothing is written, not even the
 * `loading` mark, which would land in the next session's store. The account's
 * own refusal is written nowhere either, since it has ended the session and
 * /login says why. The problem comes back for the caller to report.
 */
export async function readModuleInto(store: ServerStore, client: ApiClient, module: ServerModule, { alive, now = Date.now, retryDelaysMs = READ_RETRY_DELAYS_MS }: ReadOptions): Promise<Problem | null> {
  if (!alive()) return null
  const key = moduleKeyOf(module.workspaceId, module.moduleId)
  store.set((state) => new Map(state).set(key, loading(state.get(key) ?? IDLE)))
  try {
    const started = store.getSnapshot()
    const lists = await listModuleAgain(client, module, alive, retryDelaysMs)
    if (lists === undefined || !alive()) return null
    // Mapped against the store as the answer lands, so a row made while the
    // read was out keeps the id it was minted under and the rows that name it
    // name that one (#240). Its reads are stamped with the snapshot the read
    // began with: the server's answer is no newer.
    const result = mapModule(module, lists, { state: store.getSnapshot(), began: started })
    store.set((state) => new Map(state).set(key, loaded(result, now())))
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
 * module in the session (`mapModule`, #240); the adapter's own id
 * (`<prefix>-<uuid>`) is the next session's. The server id is
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
  /**
   * `record`, when part of a write landed before the refusal: the row as the
   * server now holds it, which the store shows instead of the row as it was;
   * `partial`, when part landed and the adapter could not say how the row now
   * stands (#263): the row stays as typed, so a second save sends only what
   * moved since, and the module is read again for it.
   */
  | { kind: "refused"; problem: Problem; recordId: string; record?: BusinessRecord; partial?: true }
  /**
   * The API took the write — a create's 201, a patch's 200 — but its answer
   * could not be mapped into a record (#243), or whatever failed after it
   * was no mutation — the row's read back, an answer's body (#263): saved,
   * so never asked for again. `serverId` is the row it was written to — undefined for a
   * create whose answer named none, whose row only the module's read again
   * finds; `problem`, why it could not be shown.
   */
  | { kind: "landed"; recordId: string; serverId?: string; problem: Problem }

/** The first field an edit moved, by the form's keys; the status where it moved none of them. */
function firstMoved(before: BusinessRecord, after: BusinessRecord): string {
  const was = before.submittedValues ?? {}
  const is = after.submittedValues ?? {}
  return Object.keys({ ...was, ...is }).find((key) => JSON.stringify(was[key]) !== JSON.stringify(is[key])) ?? "status"
}

/** Why an edit of a kind the API never patches is refused: its adapter's sentence at the field it names, else at the first field the edit moved; the store's own sentence for a kind that says none. */
export function keptRefusal(adapter: Pick<ResourceAdapter<Resource>, "prefix" | "kept">, before: BusinessRecord, after: BusinessRecord): LocalRefusal {
  const kept = adapter.kept
  return { path: kept?.path ?? firstMoved(before, after), message: kept?.message ?? `A ${adapter.prefix} is not changed here` }
}

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
 * A client that notes what a write's or a command's requests did (#263):
 * whether a request that changes something — anything but a `GET` — landed,
 * and whether one failed, refused or unanswered. An adapter that writes in
 * several requests needs no rule of its own: a failure after one of them
 * landed is the store's to tell apart.
 */
function trackingClient(client: ApiClient): { client: ApiClient; landed: () => boolean; mutationFailed: () => boolean } {
  const send = client.fetch ?? fetch
  let landed = false
  let mutationFailed = false
  const tracked: typeof fetch = async (input, init) => {
    const mutating = (init?.method ?? "GET").toUpperCase() !== "GET"
    try {
      const response = await send(input, init)
      if (mutating) {
        if (response.ok) landed = true
        else mutationFailed = true
      }
      return response
    } catch (error) {
      if (mutating) mutationFailed = true
      throw error
    }
  }
  return { client: { ...client, fetch: tracked }, landed: () => landed, mutationFailed: () => mutationFailed }
}

/**
 * Writes one record through its adapter: a create when the module holds no
 * server id for it, a patch of what moved otherwise, nothing when nothing
 * moved. `before` is the row as the module last had it, for the patch. A
 * soft delete and a move to a status the adapter cannot spell are refused
 * before anything is sent (the header says why). A write that fails after
 * a mutation of it landed (#263) is `landed` where no mutation failed, and a
 * `partial` refusal where a later one did: never the row put back as it
 * was, which the server no longer holds.
 */
export async function writeRecord(client: ApiClient, module: ServerModule, current: ModuleState, record: BusinessRecord, options: LoadOptions): Promise<WriteOutcome> {
  const adapter = adapterFor(module, record)
  if (adapter === undefined) {
    return { kind: "refused", recordId: record.id, problem: genericProblem(400, `${module.workspaceId}.${module.moduleId} has no server resource for ${record.id}`) }
  }
  if (isSoftDeleted(record)) {
    return { kind: "refused", recordId: record.id, problem: genericProblem(400, `The API has no delete: a ${adapter.prefix} is deactivated or moved to another status, not deleted`) }
  }
  const context: MappingContext = { resolve: resolverOver(options.state), now: options.now }
  const serverId = current.serverIds.get(record.id)
  const requests = trackingClient(client)
  try {
    if (serverId === undefined) {
      if (adapter.toCreateBody === undefined || adapter.create === undefined) {
        return { kind: "refused", recordId: record.id, problem: genericProblem(400, `A ${adapter.prefix} is not created here`) }
      }
      const body = adapter.toCreateBody(record, context)
      if (isLocalRefusal(body)) return { kind: "refused", recordId: record.id, problem: refusalProblem(body) }
      const resource = (await adapter.create(requests.client, body)) as Resource | undefined
      // The API said 201 whatever its answer holds: one that names no row has landed, and only the module's read again finds it.
      if (typeof resource?.id !== "string") return { kind: "landed", recordId: record.id, problem: genericProblem(0, "The API's answer named no row") }
      return mappedAnswer(record, resource.id, () => ({ kind: "created", record: recordFrom(adapter, resource, context), serverId: resource.id, optimisticId: record.id }))
    }
    const before = current.records.find((candidate) => candidate.id === record.id) ?? record
    if (before.status !== record.status && !spellsStatus(module, record, record.status)) {
      return { kind: "refused", recordId: record.id, problem: statusRefusal(adapter, record.status) }
    }
    if (adapter.toPatchBody === undefined) return { kind: "refused", recordId: record.id, problem: refusalProblem(keptRefusal(adapter, before, record)) }
    const body = adapter.toPatchBody(before, record, context)
    if (body === null) return { kind: "unchanged", record }
    if (isLocalRefusal(body)) return { kind: "refused", recordId: record.id, problem: refusalProblem(body) }
    if (adapter.update === undefined) return { kind: "refused", recordId: record.id, problem: genericProblem(400, `A ${adapter.prefix} is not changed here`) }
    const resource = await adapter.update(requests.client, serverId, body)
    // Under the row's own web id, whatever the mapping would now derive, so
    // one server row stays one row here, as `withCreated` keeps a minted id.
    return mappedAnswer(record, serverId, () => ({ kind: "updated", record: { ...recordFrom(adapter, resource, context), id: record.id }, serverId }))
  } catch (error) {
    if (error instanceof PartialWrite) {
      // The part that landed, as the server holds it — unless it cannot be mapped either, when the refusal stands alone.
      let landed: BusinessRecord | undefined
      try {
        landed = { ...recordFrom(adapter, error.resource, context), id: record.id }
      } catch {
        landed = undefined
      }
      return { kind: "refused", recordId: record.id, problem: problemOfError(error.refusal), ...(landed === undefined ? {} : { record: landed }) }
    }
    if (requests.landed()) {
      if (requests.mutationFailed()) return { kind: "refused", recordId: record.id, problem: problemOfError(error), partial: true }
      return { kind: "landed", recordId: record.id, ...(serverId === undefined ? {} : { serverId }), problem: problemOfError(error) }
    }
    return { kind: "refused", recordId: record.id, problem: problemOfError(error) }
  }
}

/** The outcome of a write the API has answered, written to `serverId`: `outcome` as mapped, or `landed` when mapping the answer throws (#243) — never a refusal, which would invite the person to send it again. */
function mappedAnswer(record: BusinessRecord, serverId: string, outcome: () => WriteOutcome): WriteOutcome {
  try {
    return outcome()
  } catch (error) {
    return { kind: "landed", recordId: record.id, serverId, problem: problemOfError(error) }
  }
}

/**
 * The module once a write's outcome is in (#243): a create under the id the
 * workspace minted, a patch in its row's place, nothing for nothing moved;
 * a landed write as `record` was typed, under its own id with the server id
 * behind it — the answer could not be shown, but a second save is a patch,
 * never a second create, and the module is read again for the row (a create
 * whose answer named no row is dropped, for that read to bring it); a
 * refusal puts back the row as it was `before` (dropping a create), or as
 * the server holds it where part of the write landed, and notes the problem.
 */
export function withOutcome(settled: ModuleState, outcome: WriteOutcome, record: BusinessRecord, before: BusinessRecord | undefined): ModuleState {
  switch (outcome.kind) {
    case "created":
      return withCreated(settled, outcome.optimisticId, outcome.record, outcome.serverId)
    case "updated":
      return withRecord(settled, outcome.record, outcome.serverId)
    case "unchanged":
      return settled
    case "landed":
      return outcome.serverId === undefined ? withoutRecord(settled, outcome.recordId) : withCreated(settled, outcome.recordId, record, outcome.serverId)
    case "refused": {
      // Part of it landed and nobody says how the row stands: as typed, until the module's read again says.
      if (outcome.partial === true) return { ...withRecord(settled, record), problem: outcome.problem }
      const restored =
        outcome.record !== undefined
          ? withRecord(settled, outcome.record)
          : before === undefined
            ? { ...settled, records: settled.records.filter((candidate) => candidate.id !== outcome.recordId) }
            : withRecord(settled, before)
      return { ...restored, problem: outcome.problem }
    }
  }
}

/**
 * `touches` are the other modules the command may have changed rows of
 * (`RecordCommand.touches`), which the store reads again: those it names
 * once the API has had it — refused or not, since a request of the command
 * may land before another fails — and none for a command never sent.
 */
export type CommandOutcome =
  /** `touches`: the modules the store reads again — the other modules the command may have changed rows of, and its own where a request of it failed after its movement landed (#263). */
  | { kind: "done"; record: BusinessRecord; serverId: string; touches: readonly string[] }
  /**
   * The movement landed and nothing that failed after it was a mutation — the
   * row's read back, or its mapping (#263): done, but the row as it now is
   * is not known. The store reads it again and answers `done` with it; only
   * where that read fails too does this reach the caller, never a refusal
   * that would invite a second movement.
   */
  | { kind: "landed"; what: string; problem: Problem; recordId: string; serverId: string; touches: readonly string[] }
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
  const context: MappingContext = { resolve: resolverOver(options.state), now: options.now }
  const touches = command.touches ?? []
  const requests = trackingClient(client)
  let sent = false
  try {
    // Inside the try: a mapper that throws on a stray input is a refusal under the command's heading, as a failing request is.
    const body = command.toBody?.(input ?? {}, record, context)
    if (isLocalRefusal(body)) return refused(refusalProblem(body))
    sent = true
    const resource = await command.run(requests.client, serverId, body)
    return { kind: "done", record: { ...recordFrom(adapter, resource, context), id: record.id }, serverId: resource.id, touches }
  } catch (error) {
    const problem = namingRow(problemOfError(error), serverId, record.name)
    // A command of several requests (a movement, then the row read back) may have changed what it touches before one failed; where
    // one landed, its own module is read again too (#263) — and where no mutation failed after it, the command has landed: the
    // movement stands, and sending it again would make a second.
    if (!requests.landed()) return refused(problem, sent ? touches : [])
    const readAgain = [...new Set([...touches, moduleKeyOf(module.workspaceId, module.moduleId)])]
    if (requests.mutationFailed()) return refused(problem, readAgain)
    return { kind: "landed", what, problem, recordId: record.id, serverId, touches: readAgain }
  }
}

/** A problem the API answered about a row, which names it by its server id: the office reads the row by its name, so the id is said as the name (#281). */
function namingRow(problem: Problem, serverId: string, name: string): Problem {
  return problem.detail?.includes(serverId) === true ? { ...problem, detail: problem.detail.replaceAll(serverId, name) } : problem
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
  const context: MappingContext = { resolve: resolverOver(options.state), now: options.now }
  try {
    const body = action.toBody?.(input ?? {}, record, context)
    if (isLocalRefusal(body)) return refused(refusalProblem(body))
    return { kind: "done", answer: (await action.run(client, serverId, body)) as Answer }
  } catch (error) {
    return refused(namingRow(problemOfError(error), serverId, record.name))
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
  const context: MappingContext = { resolve: resolverOver(options.state), now: options.now }
  try {
    const resource = await adapter.read(client, serverId)
    return { kind: "done", record: { ...recordFrom(adapter, resource, context), id: record.id }, serverId: resource.id }
  } catch (error) {
    return refused(problemOfError(error))
  }
}
