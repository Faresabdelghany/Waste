import { workspaceHref } from "@/lib/data/workspace-href"
import { moduleAt } from "@/lib/modules/manifest"
import {
  businessWorkspaces,
  type BusinessRecord,
  type ModuleDefinition,
  type ModuleLocation,
  type WorkspaceDefinition,
  type WorkspaceId,
} from "@/lib/data/business-modules"

export type ResolvedBusinessLink = {
  href: string
  workspaceId: WorkspaceId
  moduleId: string
  recordId?: string
}

type IndexedRecord = ModuleLocation & {
  record: BusinessRecord
  aliases: string[]
  identifiers: Set<string>
  numbers: Set<string>
  tokens: Set<string>
}

// The module a relation names by a noun when no record matches it, the first
// whose noun it says: an order of precedence ("route scheme" before "route").
const fallbackModules: Array<ModuleLocation & { terms: string[] }> = [
  { ...moduleAt("commercial.events"), terms: ["billable event", "billable events"] },
  { ...moduleAt("commercial.billing"), terms: ["billing run", "billing runs"] },
  { ...moduleAt("route-studio.schemes"), terms: ["route scheme", "route schemes"] },
  { ...moduleAt("customers.agreements"), terms: ["agreement", "agreements"] },
  { ...moduleAt("configure.calendars"), terms: ["calendar", "calendars"] },
  { ...moduleAt("plan.map-planning"), terms: ["map planning"] },
  { ...moduleAt("route-studio.routes"), terms: ["route", "routes"] },
  { ...moduleAt("operate.tickets"), terms: ["ticket", "tickets"] },
  { ...moduleAt("fleet.vehicles"), terms: ["vehicle", "vehicles"] },
  { ...moduleAt("fleet.drivers"), terms: ["driver", "drivers"] },
  { ...moduleAt("commercial.invoices"), terms: ["invoice", "invoices", "credit note", "credit notes"] },
  { ...moduleAt("service-providers.service-providers"), terms: ["service provider", "service providers"] },
  { ...moduleAt("service-providers.service-areas"), terms: ["service area", "service areas"] },
  { ...moduleAt("configure.areas"), terms: ["planning area", "planning areas"] },
  { ...moduleAt("service-providers.activities"), terms: ["service provider activity", "service provider activities"] },
  { ...moduleAt("customers.properties"), terms: ["property", "properties"] },
  { ...moduleAt("resources.containers"), terms: ["container", "containers", "asset", "assets"] },
  { ...moduleAt("operate.exceptions"), terms: ["alert", "alerts", "exception", "exceptions"] },
  { ...moduleAt("configure.integrations"), terms: ["integration", "integrations"] },
  { ...moduleAt("improve.intelligence"), terms: ["insight", "insights", "metric", "metrics"] },
  { ...moduleAt("improve.autopilot"), terms: ["flow", "flows", "suggestion", "suggestions"] },
  { ...moduleAt("resources.warehouses"), terms: ["warehouse", "warehouses", "stock movement", "stock movements"] },
  { ...moduleAt("resources.inventory"), terms: ["stock item", "stock items", "inventory"] },
  { ...moduleAt("commercial.products"), terms: ["product", "products", "price list", "price lists", "pricing"] },
  { ...moduleAt("commercial.settlements"), terms: ["settlement", "settlements"] },
  { ...moduleAt("route-studio.weights"), terms: ["weight record", "weight records", "weighbridge"] },
  { ...moduleAt("route-studio.pickups"), terms: ["pickup", "pickups", "stop", "stops", "proof bundle", "proof bundles"] },
  { ...moduleAt("improve.imports"), terms: ["import", "imports", "export", "exports"] },
  { ...moduleAt("improve.compliance"), terms: ["report", "reports"] },
]

const ignoredTokens = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
])

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "ae")
    .replace(/å/gi, "a")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function extractIdentifiers(value: string): string[] {
  return Array.from(
    value.matchAll(/\b[A-ZÆØÅ]{1,12}(?:-[A-Za-zÆØÅæøå0-9]+)+\b/g),
    (match) => match[0],
  )
    .map(normalize)
}

function extractNumbers(value: string): string[] {
  return normalize(value).match(/\b\d{2,}\b/g) ?? []
}

function extractTokens(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((token) => token.length > 1 && !ignoredTokens.has(token))
}

function hasTerm(value: string, term: string): boolean {
  return ` ${value} `.includes(` ${normalize(term)} `)
}

function indexRecord(
  workspaceId: WorkspaceId,
  module: ModuleDefinition,
  record: BusinessRecord,
): IndexedRecord {
  const aliases = Array.from(
    new Set(
      [record.id, record.name, ...extractIdentifiers(record.id), ...extractIdentifiers(record.name)]
        .map(normalize)
        .filter(Boolean),
    ),
  )
  const indexText = `${record.id} ${record.name}`

  return {
    workspaceId,
    moduleId: module.id,
    record,
    aliases,
    identifiers: new Set(extractIdentifiers(indexText)),
    numbers: new Set(extractNumbers(indexText)),
    tokens: new Set(extractTokens(indexText)),
  }
}

const workspaceEntries = Object.entries(businessWorkspaces) as Array<
  [WorkspaceId, WorkspaceDefinition]
>

const recordIndex: IndexedRecord[] = workspaceEntries.flatMap(([workspaceId, workspace]) =>
  workspace.modules.flatMap((module) => {
    // Control Center has no navigable surface — its records must not appear
    // in search results, which would otherwise link to a removed route.
    if (workspaceId === "control-center") return []
    if (workspaceId === "configure" && module.id === "control-center") return []
    return (module.records ?? []).map((record) => indexRecord(workspaceId, module, record))
  }),
)

function matchScore(relation: string, rawRelation: string, indexed: IndexedRecord): number {
  let score = 0

  for (const alias of indexed.aliases) {
    if (relation === alias) score = Math.max(score, 140)
    else if (alias.length >= 4 && hasTerm(relation, alias)) score = Math.max(score, 95)
    else if (relation.length >= 8 && hasTerm(alias, relation)) score = Math.max(score, 75)
  }

  const relationIdentifiers = new Set(extractIdentifiers(rawRelation))
  for (const identifier of relationIdentifiers) {
    if (indexed.identifiers.has(identifier)) score += 110
  }

  const identifierNumbers = extractIdentifiers(rawRelation).flatMap(extractNumbers)
  for (const number of identifierNumbers) {
    if (indexed.numbers.has(number)) score += 36
  }

  for (const token of extractTokens(rawRelation)) {
    if (indexed.tokens.has(token)) score += 7
  }

  return score
}

export function resolveBusinessRelation(value: string): ResolvedBusinessLink | null {
  const relation = normalize(value)
  if (!relation) return null

  const fallback = fallbackModules.find(({ terms }) =>
    terms.some((term) => hasTerm(relation, term)),
  )

  let bestMatch: IndexedRecord | undefined
  let bestScore = 0
  let bestFallbackMatch: IndexedRecord | undefined
  let bestFallbackScore = 0

  for (const candidate of recordIndex) {
    const isFallbackCandidate = Boolean(
      fallback &&
      candidate.workspaceId === fallback.workspaceId &&
        candidate.moduleId === fallback.moduleId,
    )
    const rawScore = matchScore(relation, value, candidate)
    const score = rawScore + (isFallbackCandidate ? 20 : 0)
    if (score > bestScore) {
      bestMatch = candidate
      bestScore = score
    }
    if (isFallbackCandidate && rawScore > bestFallbackScore) {
      bestFallbackMatch = candidate
      bestFallbackScore = rawScore
    }
  }

  const resolvedRecord =
    bestMatch && bestScore >= 70
      ? bestMatch
      : bestFallbackMatch && bestFallbackScore >= 32
        ? bestFallbackMatch
        : undefined

  if (resolvedRecord) {
    return {
      workspaceId: resolvedRecord.workspaceId,
      moduleId: resolvedRecord.moduleId,
      recordId: resolvedRecord.record.id,
      href: workspaceHref(resolvedRecord, resolvedRecord.record.id),
    }
  }

  if (!fallback) return null

  return {
    workspaceId: fallback.workspaceId,
    moduleId: fallback.moduleId,
    href: workspaceHref(fallback),
  }
}
