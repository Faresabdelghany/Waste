// What every server-backed module shares (Issue #81): how a resource the API
// answers becomes the prototype's `BusinessRecord`, and how a record the
// workspace hands back becomes the body of a create or a patch. One
// `ResourceAdapter` per wire resource, one `ServerModule` per
// `workspace.module` the store switches, composed in ./modules.ts.
//
// Two rules run through every adapter:
//
//   Ids. The prototype's ids stay the web's handles: a resource is
//   `<prefix>-<uuid>`, the same shape the workspace mints in the browser
//   (`project-<randomUUID>`), which is what `lib/data/project-scope.ts` reads
//   a project record by. The server's own id is kept beside the record by
//   the store (`serverIds`), never on it.
//
//   Fields. What the wire carries comes from the wire, on every read; what
//   the wire does not carry — an owner, a value, a description, related
//   chips — is "" or [] (`NO_PRESENTATION`). A change the workspace makes to
//   a field the wire does not carry is therefore not kept: the server is the
//   truth, and a fact that is only presentation has nowhere to go.
//
// The typed form payload (`submittedValues`) is keyed by the module's form
// field ids where the module has a form (the edit dialog seeds from them) and
// by the wire's names where it has none.
import type { AuditedTable } from "@waste/contracts/audit"
import type { ModuleKey } from "@waste/domain/access/modules"

import type { BusinessRecord, WorkspaceId } from "@/lib/data/business-modules"
import { type LocalRefusal, webIdOf } from "@/lib/records/fields"

import type { ApiClient } from "../client"

/** A wire resource: the server's id and stamps, then its own fields. */
export type Resource = { id: string; createdAt: string; updatedAt: string }

/**
 * How a mapping reaches the records of other resources: a user names its
 * role, its projects and its provider by server id, and a write names them
 * back by web id. The store composes one over every module it has loaded
 * and the rows of the module being loaded, so an adapter listed after
 * another in its module sees that one's rows. A load's resolver notes what
 * the mapping asked of it (server-records.ts, `MappingReads`), and the store
 * reads the module again once that moves.
 */
export type Resolver = {
  /** The web record a server id names, or undefined when nothing loaded carries it. */
  byServerId: (serverId: string) => BusinessRecord | undefined
  /** The server id a web id stands for, or undefined for a record the server does not hold. */
  serverIdOf: (webId: string) => string | undefined
  /**
   * The first record of one module, by key, the predicate holds for, or
   * undefined: for a mapping whose form names a row by the wire's own stable
   * key rather than by id — a route scheme's rule names its waste fractions by
   * name, the word the domain matches containers by. A scan reads the module
   * whole. A miss is the caller's refusal.
   */
  find: (moduleKey: string, predicate: (record: BusinessRecord) => boolean) => BusinessRecord | undefined
  /** Every record of one module, by key, the predicate holds for, in its order: for a reading that counts each — a container's planning areas, where areas overlap (#207). */
  filter: (moduleKey: string, predicate: (record: BusinessRecord) => boolean) => BusinessRecord[]
}

/** A resolver over nothing: every lookup misses. What a mapping gets when the store has nothing else to offer. */
export const NOTHING_RESOLVED: Resolver = { byServerId: () => undefined, serverIdOf: () => undefined, find: () => undefined, filter: () => [] }

/** What a mapping may look at beside the resource itself. */
export type MappingContext = {
  /** The other records the mapping may name or be named by. */
  resolve: Resolver
  /** The clock, for "Today" and "3 days ago"; a test pins it. */
  now?: Date
  /**
   * The project's day on a clock, `YYYY-MM-DD`, as `todayIn` (clock.ts) reads
   * it: a load's mapping notes each day it is asked for, so the store reads
   * the module again once that day turns. Absent, the day is read off `now`.
   */
  today?: (timezone: string | undefined) => string
}

/** What a command's dialog hands the store: its values by field, opaque to the store and read only by the command's `toBody`. */
export type CommandInput = Readonly<Record<string, unknown>>

/**
 * What an adapter's `update` throws when it is several requests and one is
 * refused after another landed: the API's refusal, and the resource as the
 * server now holds it, read back. The store shows that resource under the
 * refusal rather than the row as it was, since part of the write stands.
 */
export class PartialWrite<R extends Resource = Resource> extends Error {
  constructor(
    readonly refusal: unknown,
    readonly resource: R,
  ) {
    super("A write was refused after part of it landed")
  }
}

/**
 * A command on one row (`POST /users/:id/deactivate`): the request, which
 * answers the row as it now stands, and the heading a person is told a
 * refusal under ("Olivia Larsen was not deactivated"), the API's own
 * sentence beneath it. The store sends one through `commandRecord`
 * (server-records.ts). A command that says something — a warehouse, a reason
 * (Issue #181) — maps the dialog's input to its body in `toBody`, web ids to
 * server ids through the resolver, or refuses it naming the field before
 * the API sees it; a command without `toBody` runs with no body, its
 * `Body` what `run` is handed. Its members are methods, so a module's map of
 * commands holds each under its own body.
 */
export type RecordCommand<R extends Resource, Body = unknown> = {
  toBody?(input: CommandInput, record: BusinessRecord, context: MappingContext): Body | LocalRefusal
  run(client: Client, serverId: string, body: Body): Promise<R>
  refused(record: Pick<BusinessRecord, "name">): string
  /**
   * The other switched modules, by key, whose rows the command changes
   * beside its own row's — a container's movement appended to the ledger,
   * `resources.inventory`. Once the API has had the command the store reads
   * each of them again (Issue #198). A read again replaces a module's rows
   * whole, so the modules named here are ones no write of the person's
   * holds rows in flight in, such as a ledger.
   */
  touches?: readonly string[]
}

/**
 * An action on one row that answers another resource (Issue #178): a
 * scheme's generate answers the run it started, never the scheme. Its body
 * is mapped from the caller's input by `toBody`, as a command's is, and a
 * refusal is told under `refused`'s heading; the store leaves the row as it
 * is and hands the answer to the caller (`actOnRecord`, server-records.ts).
 * A page asks for one through its adapter's typed wrapper, never by name.
 */
export type RecordAction<Answer, Body = unknown> = {
  toBody?(input: CommandInput, record: BusinessRecord, context: MappingContext): Body | LocalRefusal
  run(client: Client, serverId: string, body: Body): Promise<Answer>
  refused(record: Pick<BusinessRecord, "name">): string
}

/** A command whose body is what its `toBody` answers, so its `run` reads that body as it is typed: one entry of a module's map. */
export const commandOf = <R extends Resource, Body>(command: RecordCommand<R, Body>): RecordCommand<R, Body> => command

/** An action whose body is what its `toBody` answers, as `commandOf`'s. */
export const actionOf = <Answer, Body>(action: RecordAction<Answer, Body>): RecordAction<Answer, Body> => action

/** What every row shares, which the store fills from the resource and its adapter (`recordFrom`): its web id, its stamps, and what the wire does not carry. */
type Envelope = "id" | "updated" | "freshness" | "source" | "owner" | "value" | "description" | "related"

/** What a mapping says of a resource: the module's own fields, and any of the envelope's it says otherwise (a credit note's id, a row's value). */
export type RecordFields = Omit<BusinessRecord, Envelope> & Partial<Pick<BusinessRecord, Envelope>>

/**
 * One wire resource as a module's rows: `R` the resource the API answers,
 * `Create` and `Patch` the bodies its writes send — the contracts' types, or
 * the adapter's own where a write is several requests (a patch, then a set).
 * The members a kind does without are absent: a kind the API does not create
 * has no `toCreateBody`/`create`, one it never patches no `update` — its
 * `toPatchBody`, where it has one, refuses in its own words — and the store
 * refuses what it is not given. Its members are methods, so a module holds
 * adapters of different resources and bodies side by side.
 */
export type ResourceAdapter<R extends Resource, Create = unknown, Patch = unknown> = {
  /** The id prefix a record of this kind carries: `project`, `customer`, … */
  prefix: string
  /** The table the API's audit log names a row of this kind by (#291), absent for a kind whose table keeps no history (a ledger, execution, the money the work makes). */
  auditTable?: AuditedTable
  /** Whether a record of the module is one of this kind; the composed module asks each adapter in turn. */
  owns(record: BusinessRecord): boolean
  /**
   * The wire's status tokens a patch may carry (`active`, `inactive`). A
   * record moved to a status not listed is refused by the store before the
   * API sees it, and the workspace offers no transition that lands there
   * (`spellsStatus` in server-records.ts). Absent for a kind whose status
   * the API does not take on a patch: every status move is then refused.
   */
  statuses?: readonly string[]
  /** Every row the caller reaches, whole; null for a kind the module lists through another adapter. */
  list: ((client: Client) => Promise<R[]>) | null
  /** The resource as the prototype shows it: its own fields, over the envelope the store fills (`recordFrom`). */
  toRecord(resource: R, context: MappingContext): RecordFields
  /** The body of `POST`, or a refusal naming the field the form left wrong; absent for a kind the API does not create (the company). */
  toCreateBody?(record: BusinessRecord, context: MappingContext): Create | LocalRefusal
  /** The body of `PATCH` for what moved between the two, or null when nothing the wire carries did; a refusal names a field. Absent for a kind the API never patches (`kept`). */
  toPatchBody?(before: BusinessRecord, after: BusinessRecord, context: MappingContext): Patch | null | LocalRefusal
  /**
   * Why a kind the API never patches — a ledger row, a row that moves by its
   * commands — refuses an edit: the sentence, at the field it names, else at
   * the first field the edit moved (`keptRefusal`, server-records.ts).
   */
  kept?: { message: string; path?: string }
  /** The collection the resource is created in; `Location` is read there. */
  create?(client: Client, body: Create): Promise<R>
  /** The row's own patch route; absent for a kind that moves by its commands alone. */
  update?(client: Client, serverId: string, body: Patch): Promise<R>
  /** The row's own read, for a row the server changed on its own account and the store reads back (`rereadRecord`); absent for a kind nothing reads back. */
  read?(client: Client, serverId: string): Promise<R>
  /** The row's commands, by name; absent for a kind the API commands nothing of. */
  commands?: Readonly<Record<string, RecordCommand<R>>>
  /** The row's actions, by name: requests about the row that answer another resource; absent for a kind with none. */
  actions?: Readonly<Record<string, RecordAction<unknown>>>
}

/** One switched `workspace.module`: the resources it lists, in list order. */
export type ServerModule = {
  workspaceId: WorkspaceId
  moduleId: string
  resources: readonly ResourceAdapter<Resource>[]
  /**
   * Whether it is read for a Service Provider's account alone (#291 C24): a
   * module whose routes the API opens to an office account under another
   * grant, whose rows the office reads in their own module.
   */
  providersOnly?: true
  /**
   * The other modules, by key, whose `view` the API reads it under too: the
   * ticket teams and types, which the people working tickets pick from
   * without keeping them (#545 of #544). A write is still its own grant's.
   */
  alsoViewedUnder?: readonly ModuleKey[]
}

/**
 * A resource as the prototype shows it: the envelope every row shares — the
 * web id its kind's prefix gives it, nothing for what the wire does not
 * carry, the stamps — under the fields its adapter says.
 */
export function recordFrom<R extends Resource>(adapter: Pick<ResourceAdapter<R>, "prefix" | "toRecord">, resource: R, context: MappingContext): BusinessRecord {
  return { id: webIdOf(adapter.prefix, resource.id), ...NO_PRESENTATION, ...stampFacts(resource, context.now), ...adapter.toRecord(resource, context) }
}

/** The client the adapters call through; the type is client.ts's, named here so records/ imports one thing. */
export type Client = ApiClient

/** What the wire does not carry, the same for every resource: nothing here is read back into a write body. */
const NO_PRESENTATION: Pick<BusinessRecord, "owner" | "value" | "description" | "related"> = { owner: "", value: "", description: "", related: [] }

const DAY_MS = 86_400_000

/**
 * How long ago an instant was, as a record's Updated says it: "Just now" inside
 * the hour, "Today", "Yesterday", "N days ago", then weeks and months. Days
 * are counted on the calendar of the clock's own timezone — the browser's,
 * not a project's: a stamp is presentation only, and every date rule proper
 * (`dayIn`, `dayInTimezone`) is the project's — so an edit at 23:50
 * read at 00:10 is "Yesterday" and not "Today".
 */
export function relativeDay(iso: string, now = new Date()): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return ""
  const elapsed = now.getTime() - then.getTime()
  if (elapsed < 60 * 60 * 1000 && elapsed > -60 * 1000) return "Just now"
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(then)) / DAY_MS)
  if (days <= 0) return "Today"
  if (days === 1) return "Yesterday"
  if (days < 7) return `${days} days ago`
  if (days < 30) return `${Math.floor(days / 7)} week${days < 14 ? "" : "s"} ago`
  if (days < 365) return `${Math.floor(days / 30)} month${days < 60 ? "" : "s"} ago`
  return `${Math.floor(days / 365)} year${days < 730 ? "" : "s"} ago`
}

/** The stamps every server record shows the same way. */
function stampFacts(resource: Resource, now?: Date): Pick<BusinessRecord, "updated" | "freshness" | "source"> {
  const updated = relativeDay(resource.updatedAt, now)
  return { updated, freshness: updated, source: "Waste API" }
}

/** A command dialog's value read as a non-blank string, or undefined: `typed`, for what a person said. */
export function said(input: CommandInput, key: string): string | undefined {
  const value = input[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/**
 * The patch a change between two records makes: for each wire field, the
 * value read off `after` where it differs from the one read off `before`.
 * `read` answers `undefined` for a field the record does not say — which is
 * "leave it" on a patch — and `null` where the form emptied a nullable
 * field, which is "clear it". Answers null when nothing moved.
 */
export function patchOf<Body extends object>(before: BusinessRecord, after: BusinessRecord, read: (record: BusinessRecord) => Partial<Body>): Body | null {
  const was = read(before) as Record<string, unknown>
  const is = read(after) as Record<string, unknown>
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(is)) {
    if (value === undefined) continue
    if (JSON.stringify(value) !== JSON.stringify(was[key])) body[key] = value
  }
  return Object.keys(body).length === 0 ? null : (body as Body)
}

/** A country as ISO 3166-1 alpha-2 from what a form said: a code as typed, a name the prototype's forms offer, else the text as it stands for the API to judge. */
export function countryCode(value: string): string {
  const trimmed = value.trim()
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase()
  return COUNTRY_CODES[trimmed.toLowerCase()] ?? trimmed
}

const COUNTRY_CODES: Readonly<Record<string, string>> = {
  denmark: "DK",
  danmark: "DK",
  sweden: "SE",
  sverige: "SE",
  norway: "NO",
  norge: "NO",
  finland: "FI",
  germany: "DE",
  deutschland: "DE",
  netherlands: "NL",
  "united kingdom": "GB",
  egypt: "EG",
}

/** The name of a country from its code, in English, the code itself when the runtime cannot say. */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code
  } catch {
    return code
  }
}

/** The name of a language from its BCP 47 tag (`da` → Danish), the tag when the runtime cannot say. */
export function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag
  } catch {
    return tag
  }
}
