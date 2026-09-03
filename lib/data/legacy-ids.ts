/**
 * Legacy identifiers from the Contractor → Service provider and
 * Contract area → Service area rename (2026-09-02), plus the Areas & Zones
 * move from the Plan workspace to Settings (2026-09-03, D37: the module key
 * `plan.areas` became `configure.areas`; record ids did not change).
 *
 * Fixtures and code use the new ids only. Browser-local state (localStorage)
 * and bookmarked URLs written before the rename still carry the old ids, so
 * the stores migrate persisted state on load and the workspace shell resolves
 * old `?module=` / `?record=` params through these maps. This file is the only
 * place the old ids are defined; the stores import it and carry only their
 * own display-string maps and legacy shape guards.
 *
 * Every helper here is idempotent: running it over already-migrated state is
 * a no-op, and `migrateLegacyState` / `migrateLegacyRecordBuckets` return the
 * very same object in that case so callers can detect "nothing changed" by
 * reference.
 */

export const LEGACY_WORKSPACE_IDS: Readonly<Record<string, string>> = {
  contractors: "service-providers",
}

export const LEGACY_MODULE_IDS: Readonly<Record<string, string>> = {
  contractors: "service-providers",
  "contract-areas": "service-areas",
  "contractor-workspace": "service-provider-workspace",
  "contractor-prices": "service-provider-prices",
}

/**
 * `${workspaceId}.${moduleId}` keys (record store buckets, role access maps).
 * The rename entries are listed for documentation;
 * `migrateLegacyModuleKey` also rewrites any other key token-wise (see
 * LEGACY_ID_TOKENS), so a bucket such as `contractors.settlements` resolves
 * without an entry here. The `plan.areas` move is a real lookup: its tokens
 * are not legacy, only the module's home changed.
 */
export const LEGACY_MODULE_KEYS: Readonly<Record<string, string>> = {
  // Areas & Zones moved from Plan to Settings (2026-09-03, D37).
  "plan.areas": "configure.areas",
  "contractors.contractors": "service-providers.service-providers",
  "contractors.contract-areas": "service-providers.service-areas",
  "contractors.activities": "service-providers.activities",
  "contractors.contractor-workspace":
    "service-providers.service-provider-workspace",
  "commercial.contractors": "commercial.service-providers",
  "commercial.contractor-workspace": "commercial.service-provider-workspace",
  "commercial.contractor-prices": "commercial.service-provider-prices",
}

/**
 * Id tokens. An id-shaped string (`ID_SHAPE`: lowercase letters, digits, `.`
 * and `-`) is rewritten token-wise, where a token is bounded by the string
 * edges, `-` or `.`:
 *
 *   role-contractor-manager               → role-service-provider-manager
 *   contractor-price-nordren-res          → service-provider-price-nordren-res
 *   dashboard-contractor                  → dashboard-service-provider
 *   contract-areas-service-area-1725…     → service-areas-service-area-1725…
 *   commercial.contractor-prices.apply-index
 *                                         → commercial.service-provider-prices.apply-index
 *
 * A bare `contract` (an agreement) is not a token and is never touched, and
 * `subcontractor-…` has no token boundary before `contractor`, so it is left
 * alone too. New ids never contain a legacy token, which is what makes the
 * rewrite idempotent.
 */
export const LEGACY_ID_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ["contract-areas", "service-areas"],
  ["contract-area", "service-area"],
  ["contractors", "service-providers"],
  ["contractor", "service-provider"],
]

/**
 * Enum-like values: ownership, employment type, audience, scope, persona,
 * filter variant. All of them fall out of the token rewrite; the map exists
 * so each one is pinned explicitly.
 */
export const LEGACY_ENUM_VALUES: Readonly<Record<string, string>> = {
  contractor: "service-provider",
  contractors: "service-providers",
  "contract-area": "service-area",
  "contract-areas": "service-areas",
  "contractor-operated": "service-provider-operated",
  "contractor-workspace": "service-provider-workspace",
  "contractor-prices": "service-provider-prices",
}

/**
 * Form field ids (camelCase). They occur as `submittedValues` keys and as the
 * `fieldId` of a `relationRefs` entry. The bare field `contractor` is
 * deliberately absent — as a value it means a scope (`"service-provider"`)
 * and as a key it means the access form's field (`serviceProvider`), so the
 * record store passes `{ contractor: "serviceProvider" }` as `extraKeys`.
 */
export const LEGACY_FIELD_IDS: Readonly<Record<string, string>> = {
  contractorId: "serviceProviderId",
  contractorName: "serviceProviderName",
  contractAreaId: "serviceAreaId",
  contractArea: "serviceArea",
  contractAreas: "serviceAreas",
}

/**
 * Fact labels, i.e. display-label object keys on records. User-created records
 * write `facts[field.label]`, so every renamed form-field label is listed,
 * next to the fixture fact keys the code reads directly.
 */
export const LEGACY_FACT_LABELS: Readonly<Record<string, string>> = {
  Contractor: "Service provider",
  Contractors: "Service providers",
  "Contract area": "Service area",
  "Contract areas": "Service areas",
  "Contract Area": "Service Area",
  "Contract Areas": "Service Areas",
  "Contractor role": "Service provider role",
  "Contractor prices": "Service provider prices",
  "Owning contractor": "Owning service provider",
  "Responsible contractor": "Responsible service provider",
  "Previous contractor": "Previous service provider",
  "Allowed contract area": "Allowed service area",
  "Proposed contract area": "Proposed service area",
  "Contract area name": "Service area name",
  "Contract-area overlap review": "Service area overlap review",
  "Contractor ownership and Project visibility are respected":
    "Service provider ownership and Project visibility are respected",
  UnrelatedContractors: "UnrelatedServiceProviders",
}

/**
 * Object keys renamed everywhere: field ids, fact labels, module ids and
 * module keys. Keys not listed here are still rewritten token-wise when they
 * are id-shaped (a bucket keyed by record id, for instance).
 */
export const LEGACY_OBJECT_KEYS: Readonly<Record<string, string>> = {
  ...LEGACY_FIELD_IDS,
  ...LEGACY_FACT_LABELS,
  ...LEGACY_MODULE_KEYS,
  ...LEGACY_MODULE_IDS,
}

/**
 * Whole-string values that are terms, not free text: `recordKind` values
 * (`record.recordKind === "Service provider price"` is a live comparison in
 * the workspace), the `Record kind` fact, the option labels a form writes into
 * `facts[field.label]`, the bare canonical terms, and the Title Case role
 * display names the organization store persists. The exact match is checked
 * before the prefix rewrite below, so "Contractor Manager" becomes
 * "Service Provider Manager" rather than "Service provider Manager".
 */
export const LEGACY_TERM_VALUES: Readonly<Record<string, string>> = {
  Contractor: "Service provider",
  Contractors: "Service providers",
  "Contract area": "Service area",
  "Contract areas": "Service areas",
  "Contractor activity": "Service provider activity",
  "Contractor company": "Service provider company",
  "Contractor price": "Service provider price",
  "Contractor price indexation": "Service provider price indexation",
  "Contractor price or settlement action":
    "Service provider price or settlement action",
  "Contractor user": "Service provider user",
  "Contractor manager": "Service provider manager",
  "Contractor Manager": "Service Provider Manager",
  "Contractor Foreman": "Service Provider Foreman",
  "Contractor operated": "Service provider operated",
  "Contractor owned": "Service provider owned",
  "Contractor proposal": "Service provider proposal",
  "Contractor workforce": "Service provider workforce",
  "Restricted contractor audience": "Restricted service provider audience",
}

/**
 * Free text that starts with a retired term. Fixture copy carried the term at
 * the start of `related` chips ("Contractor NordRen ApS", "Contract area
 * CA-Ø-2") and descriptions ("Contractor-owned paper compactor …"), and a
 * record edited before the rename keeps that text in localStorage, where the
 * record detail renders it verbatim. Only these exact prefixes are rewritten,
 * and only at the string start — "Previous contractor NordRen", "Subcontractor
 * review" and "Route RC-1052 · Contractor NordRen ApS" stay as they are. A
 * rewritten string starts with "Service …", which no legacy prefix matches,
 * so the rewrite is idempotent.
 */
export const LEGACY_TERM_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["Contract areas ", "Service areas "],
  ["Contract area ", "Service area "],
  ["Contractors ", "Service providers "],
  ["Contractor ", "Service provider "],
  ["Contractor-", "Service provider-"],
]

const ID_SHAPE = /^[a-z0-9][a-z0-9.-]*$/
const LEGACY_ID_TOKEN_PATTERN = /(^|[.-])(contract-areas?|contractors?)(?=$|[.-])/g
const LEGACY_ID_TOKEN_MAP: Readonly<Record<string, string>> =
  Object.fromEntries(LEGACY_ID_TOKENS)

/** Own-property lookup: `"constructor" in {}` is true, so `in` is not safe here. */
function lookup(
  map: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined
}

/**
 * Rewrites one id-shaped string (module id, module key, record id, enum
 * value). Anything that is not id-shaped — display text, names, dates with
 * spaces, camelCase field ids — is returned untouched.
 */
export function migrateLegacyId(value: string): string {
  if (!ID_SHAPE.test(value)) return value
  return value.replace(
    LEGACY_ID_TOKEN_PATTERN,
    (_, boundary: string, token: string) =>
      `${boundary}${lookup(LEGACY_ID_TOKEN_MAP, token) ?? token}`,
  )
}

export function migrateLegacyWorkspaceId(id: string): string {
  return lookup(LEGACY_WORKSPACE_IDS, id) ?? migrateLegacyId(id)
}

export function migrateLegacyModuleId(id: string): string {
  return lookup(LEGACY_MODULE_IDS, id) ?? migrateLegacyId(id)
}

export function migrateLegacyModuleKey(key: string): string {
  return lookup(LEGACY_MODULE_KEYS, key) ?? migrateLegacyId(key)
}

/**
 * `/plan?module=areas[&record=…]` opened the Areas & Zones module before it
 * moved to Settings; the same records now open through the Settings pane.
 * Every other Plan href (calendars, the bare workspace) is left alone.
 */
function migratePlanAreasHref(href: string): string {
  const match = /^\/plan\?([^#]*)(#.*)?$/.exec(href)
  if (!match) return href
  const params = new URLSearchParams(match[1])
  if (params.get("module") !== "areas") return href
  const next = new URLSearchParams({ pane: "areas" })
  const recordId = params.get("record")
  if (recordId) next.set("record", recordId)
  return `/settings?${next.toString()}${match[2] ?? ""}`
}

/**
 * Rewrites app-relative hrefs: the retired `/contractors` and
 * `/contractor-workspace(/…)` paths plus `?module=` / `?record=` params, and
 * the Plan deep links into the moved Areas & Zones module. Absolute URLs and
 * non-app paths are returned untouched.
 */
export function migrateLegacyHref(href: string): string {
  if (!href.startsWith("/")) return href
  return migratePlanAreasHref(
    href
      .replace(/^\/contractors(?=[/?#]|$)/, "/service-providers")
      .replace(/^\/contractor-workspace(?=[/?#]|$)/, "/service-provider-workspace")
      .replace(
        /([?&](?:module|record)=)([a-z0-9.-]+)/g,
        (_, prefix: string, id: string) => `${prefix}${migrateLegacyId(id)}`,
      ),
  )
}

/**
 * Renames one object key (or a `fieldId` value, which names a key): the
 * caller's own renames first, then the shared key map, then the id rewrite.
 */
function migrateKey(
  key: string,
  extraKeys: Readonly<Record<string, string>>,
): string {
  return (
    lookup(extraKeys, key) ?? lookup(LEGACY_OBJECT_KEYS, key) ?? migrateLegacyId(key)
  )
}

/**
 * A stored `{ workspaceId, moduleId }` pair (a `relationRefs` entry, a form
 * relation target) that names a module's old home. Individual legacy tokens
 * are already rewritten string by string; only a *moved* module — same ids,
 * new workspace — needs the pair resolved together through LEGACY_MODULE_KEYS.
 */
function migrateModuleLocation(
  node: Record<string, unknown>,
): { workspaceId: string; moduleId: string } | undefined {
  const { workspaceId, moduleId } = node
  if (typeof workspaceId !== "string" || typeof moduleId !== "string") return undefined
  const key = `${workspaceId}.${moduleId}`
  const nextKey = migrateLegacyModuleKey(key)
  if (nextKey === key) return undefined
  const separator = nextKey.indexOf(".")
  return {
    workspaceId: nextKey.slice(0, separator),
    moduleId: nextKey.slice(separator + 1),
  }
}

function migrateStringValue(value: string): string {
  if (value.startsWith("/")) return migrateLegacyHref(value)
  const term = lookup(LEGACY_TERM_VALUES, value)
  if (term !== undefined) return term
  for (const [legacy, current] of LEGACY_TERM_PREFIXES) {
    if (value.startsWith(legacy)) return `${current}${value.slice(legacy.length)}`
  }
  return migrateLegacyId(value)
}

/**
 * Deep-rewrites persisted state: renames known legacy object keys, `fieldId`
 * values, id-shaped strings, enumerated term values, free text that starts
 * with a retired term, and app hrefs.
 *
 * Idempotent, and returns the same reference when nothing changed, so a store
 * can call it on every load and persist only when `result !== input`. When a
 * legacy key and its replacement both exist on one object, the value already
 * stored under the new key wins. `extraKeys` lets a store add the key renames
 * that are specific to its own shape.
 */
export function migrateLegacyState<T>(
  value: T,
  extraKeys: Readonly<Record<string, string>> = {},
): T {
  const visit = (node: unknown, parentKey?: string): unknown => {
    if (typeof node === "string") {
      return parentKey === "fieldId"
        ? migrateKey(node, extraKeys)
        : migrateStringValue(node)
    }
    if (Array.isArray(node)) {
      let changed = false
      const out = node.map((child) => {
        const next = visit(child)
        if (next !== child) changed = true
        return next
      })
      return changed ? out : node
    }
    if (node && typeof node === "object") {
      const source = node as Record<string, unknown>
      const movedModule = migrateModuleLocation(source)
      const out: Record<string, unknown> = {}
      let changed = false
      for (const [key, child] of Object.entries(source)) {
        const nextKey = migrateKey(key, extraKeys)
        if (nextKey !== key) {
          changed = true
          // Stored-new wins: keep the value already held under the new key.
          if (Object.prototype.hasOwnProperty.call(source, nextKey)) continue
        }
        const nextChild =
          movedModule && (key === "workspaceId" || key === "moduleId")
            ? movedModule[key]
            : visit(child, key)
        if (nextChild !== child) changed = true
        out[nextKey] = nextChild
      }
      return changed ? out : node
    }
    return node
  }
  return visit(value) as T
}

/**
 * Migrates a `Record<"workspaceId.moduleId", records[]>` payload (the business
 * record store shape): bucket keys move to their new module keys and every
 * bucket's records go through `migrateLegacyState`. When a legacy bucket and
 * its new-key bucket both exist they are merged, de-duplicated by record id
 * with the record stored under the new key winning. Returns the same object
 * when nothing needed migrating.
 */
export function migrateLegacyRecordBuckets<R extends { id: string }>(
  stored: Readonly<Record<string, R[]>>,
  extraKeys: Readonly<Record<string, string>> = {},
): Record<string, R[]> {
  let changed = false
  const next: Record<string, R[]> = {}
  const legacyBuckets: Array<[string, R[]]> = []

  for (const [key, records] of Object.entries(stored)) {
    const nextKey = migrateLegacyModuleKey(key)
    if (nextKey !== key) {
      changed = true
      legacyBuckets.push([nextKey, records])
      continue
    }
    const migrated = migrateLegacyState(records, extraKeys)
    if (migrated !== records) changed = true
    next[key] = migrated
  }

  for (const [key, records] of legacyBuckets) {
    const migrated = migrateLegacyState(records, extraKeys)
    const existing = next[key]
    if (!existing) {
      next[key] = migrated
      continue
    }
    const existingIds = new Set(existing.map((record) => record.id))
    next[key] = [
      ...existing,
      ...migrated.filter((record) => !existingIds.has(record.id)),
    ]
  }

  return changed ? next : (stored as Record<string, R[]>)
}

/**
 * True when serialized state still mentions a retired identifier or the moved
 * Areas & Zones module — as the `plan.areas` bucket/access key or as a stored
 * `workspaceId: "plan"` / `moduleId: "areas"` pair. A cheap, case-insensitive
 * pre-check — it may report free text such as "Subcontractor", so callers
 * compare the migration result by reference to decide whether anything
 * actually changed.
 */
export function hasLegacyIds(serialized: string): boolean {
  return /contractor|contract[- ]?area|plan\.areas|"workspaceId":\s*"plan",\s*"moduleId":\s*"areas"/i.test(
    serialized,
  )
}
