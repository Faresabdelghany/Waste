// What every server-backed module shares (Issue #81): how a resource the API
// answers becomes the prototype's `BusinessRecord`, and how a record the
// workspace hands back becomes the body of a create or a patch. One
// `ResourceAdapter` per wire resource, one `ServerModule` per
// `workspace.module` the store switches, composed in ./modules.ts.
//
// Two rules run through every adapter:
//
//   Ids. The prototype's ids stay the web's handles. A seeded row is the
//   fixture record the seed derived it from (packages/db/src/seed: the demo
//   company's rows were built from `apps/web/lib/data/business-modules.ts`,
//   by name), so a resource whose name is a fixture's takes that fixture's id
//   — `project-copenhagen` stays `project-copenhagen`, and every fixture of a
//   module not yet switched that names it still finds it. A resource no
//   fixture names is `<prefix>-<uuid>`, the same shape the organisation store
//   mints in the browser (`project-<randomUUID>`), which is what
//   `lib/data/project-scope.ts` reads a project record by. The server's own
//   id is kept beside the record by the store (`serverIds`), never on it.
//
//   Fields. What the wire carries comes from the wire, on every read; what
//   the wire does not carry — a fixture's owner, value, description, related
//   chips, transitions, deep link — is inherited from the matched fixture
//   and is "" or [] for a resource with none. A change the workspace makes
//   to a field the wire does not carry is therefore not kept: the server is
//   the truth, and a fact that is only presentation has nowhere to go.
//
// The typed form payload (`submittedValues`) is keyed by the module's form
// field ids where the module has a form (the edit dialog seeds from them) and
// by the wire's names where it has none.
import type { BusinessRecord, WorkspaceId } from "@/lib/data/business-modules"

import type { ApiClient } from "../client"

/** A wire resource: the server's id and stamps, then its own fields. */
export type Resource = { id: string; createdAt: string; updatedAt: string }

/**
 * How a mapping reaches the records of other resources: a user names its
 * role, its projects and its provider by server id, and a write names them
 * back by web id. The store composes one over every module it has loaded
 * and the rows of the module being loaded, in list order, so an adapter
 * listed after another sees that one's rows.
 */
export type Resolver = {
  /** The web record a server id names, or undefined when nothing loaded carries it. */
  byServerId: (serverId: string) => BusinessRecord | undefined
  /** The server id a web id stands for, or undefined for a record the server does not hold. */
  serverIdOf: (webId: string) => string | undefined
  /**
   * The first loaded record the predicate holds for, or undefined: for a
   * mapping whose form names a row by the wire's own stable key rather than
   * by id — a route scheme's rule names its waste fractions by name, the
   * word the domain matches containers by. A miss is the caller's refusal.
   */
  find: (predicate: (record: BusinessRecord) => boolean) => BusinessRecord | undefined
}

/** A resolver over nothing: every lookup misses. What a mapping gets when the store has nothing else to offer. */
export const NOTHING_RESOLVED: Resolver = { byServerId: () => undefined, serverIdOf: () => undefined, find: () => undefined }

/** What a mapping may look at beside the resource itself. */
export type MappingContext = {
  /** The module's fixture records, the seed's origin, matched by name. */
  fixtures: readonly BusinessRecord[]
  /** The other records the mapping may name or be named by. */
  resolve: Resolver
  /** The web id of the caller's company record, once the organisation module has loaded. */
  companyRecordId?: string
  /** The clock, for "Today" and "3 days ago"; a test pins it. */
  now?: Date
}

/** A write the adapter refused before the API saw it, in the API's own words: a 400 with the field it names. */
export type LocalRefusal = { path: string; message: string }

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
 * the API sees it; a command without `toBody` runs with no body.
 */
export type RecordCommand<R extends Resource> = {
  toBody?: (input: CommandInput, record: BusinessRecord, context: MappingContext) => unknown | LocalRefusal
  run: (client: Client, serverId: string, body: unknown) => Promise<R>
  refused: (record: Pick<BusinessRecord, "name">) => string
}

export type ResourceAdapter<R extends Resource> = {
  /** The id prefix a record of this kind carries: `project`, `customer`, … */
  prefix: string
  /** Whether a record of the module is one of this kind; the composed module asks each adapter in turn. */
  owns: (record: BusinessRecord) => boolean
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
  /** The resource as the prototype shows it. */
  toRecord: (resource: R, context: MappingContext) => BusinessRecord
  /** The body of `POST`, or a refusal naming the field the form left wrong; absent for a kind the API does not create (the company). */
  toCreateBody?: (record: BusinessRecord, context: MappingContext) => unknown | LocalRefusal
  /** The body of `PATCH` for what moved between the two, or null when nothing the wire carries did; a refusal names a field. */
  toPatchBody: (before: BusinessRecord, after: BusinessRecord, context: MappingContext) => unknown | null | LocalRefusal
  /** The collection the resource is created in; `Location` is read there. */
  create?: (client: Client, body: unknown) => Promise<R>
  /** The row's own patch route. */
  update: (client: Client, serverId: string, body: unknown) => Promise<R>
  /** The row's commands, by name; absent for a kind the API commands nothing of. */
  commands?: Readonly<Record<string, RecordCommand<R>>>
}

/** One switched `workspace.module`: the resources it lists, in list order. */
export type ServerModule = {
  workspaceId: WorkspaceId
  moduleId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a module composes adapters of different resources; each is typed on its own
  resources: ResourceAdapter<any>[]
}

/** The client the adapters call through; the type is client.ts's, named here so records/ imports one thing. */
export type Client = ApiClient

export const isLocalRefusal = (value: unknown): value is LocalRefusal =>
  typeof value === "object" && value !== null && typeof (value as LocalRefusal).path === "string" && typeof (value as LocalRefusal).message === "string"

/** `${workspaceId}.${moduleId}`, the key every store, link and relation uses. */
export const moduleKeyOf = (workspaceId: WorkspaceId, moduleId: string) => `${workspaceId}.${moduleId}`

/** `<prefix>-<uuid>`: the id of a resource no fixture names. */
export const webIdOf = (prefix: string, serverId: string) => `${prefix}-${serverId.toLowerCase()}`

/** True for a record whose id carries the prefix — a fixture's, a browser-minted one or a `webIdOf`. */
export const hasPrefix = (prefix: string) => (record: Pick<BusinessRecord, "id">) => record.id.startsWith(`${prefix}-`)

/**
 * The rule every adapter's `owns` follows: a record is of a kind when its id
 * carries the kind's prefix — a fixture's id, a `webIdOf` — or, for a record
 * the workspace has just made (whose id is `<moduleId>-<slug of the form's
 * recordKind>-<clock>`, `organization-project-1700000000000`), when its
 * `recordKind` is the kind's. A form's `recordKind` is the one word the
 * generic create path stamps on every record it makes, so it is what a new
 * row is recognised by until the server has answered and the adapter's own
 * id has replaced the minted one.
 */
export const ofKind = (prefix: string, recordKinds: readonly string[]) => (record: Pick<BusinessRecord, "id" | "recordKind">) =>
  hasPrefix(prefix)(record) || (record.recordKind !== undefined && recordKinds.includes(record.recordKind))

/**
 * The fixture record a resource is: the one of the prefix whose name is the
 * resource's, the seed's own derivation. `names` lists what the resource
 * may be called, first match wins, since a company is spelled by its legal
 * name in one place and its short name in another.
 */
export function fixtureNamed(fixtures: readonly BusinessRecord[], prefix: string, names: readonly string[]): BusinessRecord | undefined {
  const ofKind = fixtures.filter(hasPrefix(prefix))
  for (const name of names) {
    const found = ofKind.find((record) => record.name === name)
    if (found) return found
  }
  return undefined
}

/**
 * The presentation a matched fixture lends a resource: everything the wire
 * does not carry. Nothing here is read back into a write body.
 */
export function inheritedPresentation(fixture: BusinessRecord | undefined): Pick<BusinessRecord, "owner" | "value" | "description" | "related" | "allowedTransitions" | "deepLink"> {
  return {
    owner: fixture?.owner ?? "",
    value: fixture?.value ?? "",
    description: fixture?.description ?? "",
    related: fixture?.related ?? [],
    allowedTransitions: fixture?.allowedTransitions,
    deepLink: fixture?.deepLink,
  }
}

/** `active` → `Active`, `service-contact` → `Service contact`: a wire token as a status or a fact reads. */
export function statusLabel(token: string): string {
  const words = token.replace(/[-_]+/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The inverse: `Active` → `active`, `Service contact` → `service-contact`. */
export function statusToken(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, "-")
}

const DAY_MS = 86_400_000

/**
 * How long ago an instant was, as the fixtures spell it: "Just now" inside
 * the hour, "Today", "Yesterday", "N days ago", then weeks and months. Days
 * are counted on the calendar of the clock's own timezone — the browser's,
 * not a project's: a stamp is presentation only, and every date rule proper
 * (`projectToday`, `dayInTimezone`) is the project's — so an edit at 23:50
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
export function stampFacts(resource: Resource, now?: Date): Pick<BusinessRecord, "updated" | "freshness" | "source"> {
  const updated = relativeDay(resource.updatedAt, now)
  return { updated, freshness: updated, source: "Waste API" }
}

/** A typed form value read as a non-blank string, or undefined. */
export function typed(record: Pick<BusinessRecord, "submittedValues">, key: string): string | undefined {
  const value = record.submittedValues?.[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/** A typed form value read as a boolean, or undefined when it is not one. */
export function typedFlag(record: Pick<BusinessRecord, "submittedValues">, key: string): boolean | undefined {
  const value = record.submittedValues?.[key]
  return typeof value === "boolean" ? value : undefined
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
