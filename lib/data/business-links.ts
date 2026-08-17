import {
  businessWorkspaces,
  type BusinessRecord,
  type ModuleDefinition,
  type WorkspaceDefinition,
  type WorkspaceId,
} from "@/lib/data/business-modules"

export type ResolvedBusinessLink = {
  href: string
  workspaceId: WorkspaceId
  moduleId: string
  recordId?: string
}

type ModuleLocation = {
  workspaceId: WorkspaceId
  moduleId: string
}

type IndexedRecord = ModuleLocation & {
  record: BusinessRecord
  aliases: string[]
  identifiers: Set<string>
  numbers: Set<string>
  tokens: Set<string>
}

const workspacePaths: Record<Exclude<WorkspaceId, "configure">, string> = {
  operate: "/tickets",
  plan: "/plan",
  "route-studio": "/route-studio",
  fleet: "/fleet",
  customers: "/customers",
  resources: "/resources",
  contractors: "/contractors",
  commercial: "/commercial",
  improve: "/improve",
  "control-center": "/control-center",
}

const settingsPaneByModule: Record<string, string> = {
  organization: "company",
  access: "access",
  master: "operations-setup",
  templates: "ticket-comms",
  finance: "finance",
  integrations: "integrations",
  portals: "portals",
  privacy: "privacy",
}

const fallbackModules: Array<ModuleLocation & { terms: string[] }> = [
  { workspaceId: "commercial", moduleId: "events", terms: ["billable event", "billable events"] },
  { workspaceId: "commercial", moduleId: "billing", terms: ["billing run", "billing runs"] },
  { workspaceId: "route-studio", moduleId: "schemes", terms: ["route scheme", "route schemes"] },
  { workspaceId: "customers", moduleId: "agreements", terms: ["agreement", "agreements"] },
  { workspaceId: "plan", moduleId: "calendars", terms: ["calendar", "calendars"] },
  { workspaceId: "route-studio", moduleId: "routes", terms: ["route", "routes"] },
  { workspaceId: "operate", moduleId: "tickets", terms: ["ticket", "tickets"] },
  { workspaceId: "fleet", moduleId: "vehicles", terms: ["vehicle", "vehicles"] },
  { workspaceId: "fleet", moduleId: "drivers", terms: ["driver", "drivers"] },
  { workspaceId: "commercial", moduleId: "invoices", terms: ["invoice", "invoices", "credit note", "credit notes"] },
  { workspaceId: "contractors", moduleId: "contractors", terms: ["contractor", "contractors"] },
  { workspaceId: "contractors", moduleId: "contract-areas", terms: ["contract area", "contract areas"] },
  { workspaceId: "contractors", moduleId: "activities", terms: ["contractor activity", "contractor activities"] },
  { workspaceId: "customers", moduleId: "properties", terms: ["property", "properties"] },
  { workspaceId: "resources", moduleId: "containers", terms: ["container", "containers", "asset", "assets"] },
  { workspaceId: "operate", moduleId: "exceptions", terms: ["alert", "alerts", "exception", "exceptions"] },
  { workspaceId: "configure", moduleId: "integrations", terms: ["integration", "integrations"] },
  { workspaceId: "improve", moduleId: "intelligence", terms: ["insight", "insights", "metric", "metrics"] },
  { workspaceId: "plan", moduleId: "approvals", terms: ["approval", "approvals"] },
  { workspaceId: "improve", moduleId: "autopilot", terms: ["flow", "flows", "suggestion", "suggestions"] },
  { workspaceId: "plan", moduleId: "studio", terms: ["scenario", "scenarios", "promotion", "promotions", "plan", "plans"] },
  { workspaceId: "resources", moduleId: "warehouses", terms: ["warehouse", "warehouses", "stock movement", "stock movements"] },
  { workspaceId: "resources", moduleId: "inventory", terms: ["stock item", "stock items", "inventory"] },
  { workspaceId: "commercial", moduleId: "products", terms: ["product", "products"] },
  { workspaceId: "commercial", moduleId: "pricing", terms: ["price list", "price lists", "pricing"] },
  { workspaceId: "commercial", moduleId: "settlements", terms: ["settlement", "settlements"] },
  { workspaceId: "route-studio", moduleId: "weights", terms: ["weight record", "weight records", "weighbridge"] },
  { workspaceId: "route-studio", moduleId: "pickups", terms: ["pickup", "pickups", "stop", "stops", "proof bundle", "proof bundles"] },
  { workspaceId: "improve", moduleId: "imports", terms: ["import", "imports", "export", "exports"] },
  { workspaceId: "improve", moduleId: "compliance", terms: ["report", "reports"] },
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

function moduleHref({
  workspaceId,
  moduleId,
  recordId,
}: ModuleLocation & { recordId?: string }): string {
  if (workspaceId === "operate" && moduleId === "driver-app") {
    return "/tickets"
  }

  if (workspaceId === "configure") {
    if (moduleId === "control-center") {
      return moduleHref({
        workspaceId: "control-center",
        moduleId: "control-center",
        recordId,
      })
    }

    const params = new URLSearchParams({
      pane: settingsPaneByModule[moduleId] ?? "company",
    })
    if (recordId) params.set("record", recordId)
    return `/settings?${params.toString()}`
  }

  const params = new URLSearchParams({ module: moduleId })
  if (recordId) params.set("record", recordId)
  return `${workspacePaths[workspaceId]}?${params.toString()}`
}

export function getBusinessModuleHref(
  workspaceId: WorkspaceId,
  moduleId: string,
  recordId?: string,
): string {
  return moduleHref({ workspaceId, moduleId, recordId })
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
    // Control Center is intentionally exposed through its dedicated workspace.
    if (workspaceId === "configure" && module.id === "control-center") return []
    return module.records.map((record) => indexRecord(workspaceId, module, record))
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
      href: moduleHref({
        workspaceId: resolvedRecord.workspaceId,
        moduleId: resolvedRecord.moduleId,
        recordId: resolvedRecord.record.id,
      }),
    }
  }

  if (!fallback) return null

  return {
    workspaceId: fallback.workspaceId,
    moduleId: fallback.moduleId,
    href: moduleHref(fallback),
  }
}
