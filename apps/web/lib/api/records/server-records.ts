// The server-backed half of the record store (Issue #81): what
// `business-record-store.tsx` reads a switched module from and writes it
// through. Pure state and transitions over a `Map` of modules, no React, so
// the rules below are held by lib/api/__tests__/server-records.test.ts without
// a browser:
//
//   A module is `idle` until the store is asked for it, `loading` while its
//   first read is out, `ready` once the rows are records, `failed` with the
//   problem when the API refused or did not answer. Until it is `ready` the
//   store answers the module's fixtures — the same as the browser-only path
//   shows before hydration — and never a mixture of the two, so a list is
//   either the server's or the prototype's and nobody counts both.
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
//   field is a person's to read, not a console's.
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
import { isSoftDeleted } from "@waste/domain/record-visibility"

import type { BusinessRecord, WorkspaceId } from "@/lib/data/business-modules"

import type { ApiClient } from "../client"
import { ApiProblem, genericProblem, type Problem } from "../problem"
import { isLocalRefusal, moduleKeyOf, statusToken, webIdOf, type CommandInput, type MappingContext, type Resolver, type Resource, type ResourceAdapter, type ServerModule } from "./adapter"
import { isCompanyRecord } from "./organisation"

export type ModuleStatus = "idle" | "loading" | "ready" | "failed"

export type ModuleState = {
  status: ModuleStatus
  /** The module's records, in list order: the server's rows as the prototype shows them. Empty until `ready`. */
  records: BusinessRecord[]
  /** The server id behind each web id. */
  serverIds: ReadonlyMap<string, string>
  /** Why the last read or write failed; cleared by the next read. */
  problem: Problem | null
  /** The clock of the last successful read. */
  loadedAt: number | null
}

export type ServerRecordsState = ReadonlyMap<string, ModuleState>

export const IDLE: ModuleState = { status: "idle", records: [], serverIds: new Map(), problem: null, loadedAt: null }

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
 * one map serves every kind.
 */
export function resolverOver(state: ServerRecordsState, extra?: { records: readonly BusinessRecord[]; serverIds: ReadonlyMap<string, string> }): Resolver {
  const modules = [...state.values()].filter((module) => module.status === "ready")
  const sources = extra === undefined ? modules : [...modules, { records: extra.records, serverIds: extra.serverIds }]
  return {
    byServerId: (serverId) => {
      for (const source of sources) {
        for (const [webId, id] of source.serverIds) {
          if (id === serverId) return source.records.find((record) => record.id === webId)
        }
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
  | { kind: "refused"; problem: Problem; recordId: string }

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
    return { kind: "refused", recordId: record.id, problem: problemOfError(error) }
  }
}

export type CommandOutcome =
  | { kind: "done"; record: BusinessRecord; serverId: string }
  /** `what` is the heading the person is told the refusal under; the problem is the API's, or the store's own for a command that was never sent. */
  | { kind: "refused"; what: string; problem: Problem; recordId: string }

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
  const refused = (problem: Problem): CommandOutcome => ({ kind: "refused", what, problem, recordId: record.id })
  if (adapter === undefined) return refused(genericProblem(400, `${moduleKeyOf(module.workspaceId, module.moduleId)} has no server resource for ${record.id}`))
  if (command === undefined) return refused(genericProblem(400, `The API has no "${name}" for a ${adapter.prefix}`))
  const serverId = current.serverIds.get(record.id)
  if (serverId === undefined) return refused(genericProblem(400, `${record.name} is not on the API yet: wait for it to be saved, then try again`))
  const context: MappingContext = { fixtures: options.fixtures, resolve: resolverOver(options.state), companyRecordId: companyRecordIdOf(options.state), now: options.now }
  try {
    // Inside the try: a mapper that throws on a stray input is a refusal under the command's heading, as a failing request is.
    const body = command.toBody?.(input ?? {}, record, context)
    if (isLocalRefusal(body)) return refused(refusalProblem(body))
    const resource = await command.run(client, serverId, body)
    return { kind: "done", record: { ...adapter.toRecord(resource, context), id: record.id }, serverId: resource.id }
  } catch (error) {
    return refused(problemOfError(error))
  }
}
