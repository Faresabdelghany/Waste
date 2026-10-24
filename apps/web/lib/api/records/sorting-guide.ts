// The Sorting Guide's items (Issue #293, M1) on the wire and in the store:
// `configure.sorting-guide`, `guide-item-<uuid>`, the API's
// `/sorting-guide-items`. An item names its project and its fraction by
// server id; the record names them by web id, through the resolver, so the
// module is read after the organisation (projects) and the master data
// (fractions). The record's `submittedValues` are what the Settings form
// (lib/data/sorting-guide.ts) wrote, the synonyms as one comma-separated line.
import type { SortingGuideItem } from "@waste/contracts/sorting-guide"
import { SORTING_GUIDE_ITEM_STATUSES } from "@waste/domain/sorting-guide/vocabulary"

import { FIXTURE_COMPANY_ID } from "@/lib/data/business-modules"
import { SORTING_GUIDE_ITEM_KIND, SORTING_GUIDE_ITEM_PREFIX, SORTING_GUIDE_MODULE, synonymsOf } from "@/lib/data/sorting-guide"
import { create, get, listAll, patch } from "../client"
import { inheritedPresentation, isLocalRefusal, ofKind, patchOf, stampFacts, statusLabel, statusToken, typed, webIdOf, type LocalRefusal, type MappingContext, type ResourceAdapter, type ServerModule } from "./adapter"
import { projectServerIdOf, referenced, requiredText } from "./places"

/** What an item names no fraction as, on its row. */
export const NO_FRACTION = "No fraction"

/** The fraction a record names under `wasteFractionId`, as a server id; null for none; a refusal for one the store does not hold. */
function fractionServerIdOf(record: Parameters<typeof typed>[0], context: MappingContext): string | null | LocalRefusal {
  const webId = typed(record, "wasteFractionId")
  if (webId === undefined) return null
  return context.resolve.serverIdOf(webId) ?? { path: "wasteFractionId", message: "Pick a waste fraction the API holds" }
}

/** The status token a record says, when it is one the guide knows. */
const statusOf = (record: Parameters<typeof typed>[0] & { status: string }) =>
  SORTING_GUIDE_ITEM_STATUSES.find((candidate) => candidate === (typed(record, "status") ?? statusToken(record.status)))

export const sortingGuideItemAdapter: ResourceAdapter<SortingGuideItem> = {
  prefix: SORTING_GUIDE_ITEM_PREFIX,
  auditTable: "sorting_guide_item",
  owns: ofKind(SORTING_GUIDE_ITEM_PREFIX, [SORTING_GUIDE_ITEM_KIND]),
  statuses: SORTING_GUIDE_ITEM_STATUSES,
  list: (client) => listAll<SortingGuideItem>(client, "/sorting-guide-items"),
  toRecord: (item, context) => {
    const project = referenced(context, "project", item.projectId)
    const fraction = item.wasteFractionId === null ? undefined : referenced(context, "fraction", item.wasteFractionId)
    const fractionName = fraction?.name ?? (fraction === undefined ? NO_FRACTION : "Fraction")
    const facts: Record<string, string> = { Fraction: fractionName }
    if (item.synonyms.length > 0) facts["Known as"] = item.synonyms.join(", ")
    if (project.name !== undefined) facts.Project = project.name
    const submittedValues: Record<string, string> = { projectId: project.webId, name: item.name, synonyms: item.synonyms.join(", "), status: item.status }
    if (fraction !== undefined) submittedValues.wasteFractionId = fraction.webId
    if (item.instructions !== null) submittedValues.instructions = item.instructions
    return {
      id: webIdOf(SORTING_GUIDE_ITEM_PREFIX, item.id),
      name: item.name,
      context: `${fractionName} · ${project.name ?? "Project"}`,
      status: statusLabel(item.status),
      ...inheritedPresentation(undefined),
      ...stampFacts(item, context.now),
      value: item.synonyms.join(", "),
      description: item.instructions ?? "",
      facts,
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: SORTING_GUIDE_ITEM_KIND,
      submittedValues,
    }
  },
  toCreateBody: (record, context) => {
    const projectId = projectServerIdOf(record, context)
    if (isLocalRefusal(projectId)) return projectId
    const name = requiredText(record, "name", "An item", "a name")
    if (isLocalRefusal(name)) return name
    const wasteFractionId = fractionServerIdOf(record, context)
    if (isLocalRefusal(wasteFractionId)) return wasteFractionId
    const instructions = typed(record, "instructions")
    const status = statusOf(record)
    return {
      projectId,
      name,
      synonyms: synonymsOf(typed(record, "synonyms") ?? ""),
      ...(wasteFractionId === null ? {} : { wasteFractionId }),
      ...(instructions === undefined ? {} : { instructions }),
      ...(status === undefined ? {} : { status }),
    }
  },
  toPatchBody: (before, after, context) => {
    // The two records compared as the form wrote them, the fraction by web id; a moved fraction then goes out as its server id.
    const body = patchOf<Record<string, unknown>>(before, after, (record) => ({
      name: typed(record, "name") ?? record.name,
      synonyms: synonymsOf(typed(record, "synonyms") ?? ""),
      wasteFractionId: typed(record, "wasteFractionId") ?? null,
      instructions: typed(record, "instructions") ?? null,
      status: statusOf(record),
    }))
    if (body === null || !("wasteFractionId" in body)) return body
    const wasteFractionId = fractionServerIdOf(after, context)
    return isLocalRefusal(wasteFractionId) ? wasteFractionId : { ...body, wasteFractionId }
  },
  create: (client, body) => create<SortingGuideItem>(client, "/sorting-guide-items", body).then((created) => created.body),
  update: (client, serverId, body) => patch<SortingGuideItem>(client, `/sorting-guide-items/${serverId}`, body),
  read: (client, serverId) => get<SortingGuideItem>(client, `/sorting-guide-items/${serverId}`),
}

/** The guide on the API, read after the projects and the fractions its items name. */
export const sortingGuideModule: ServerModule = {
  workspaceId: SORTING_GUIDE_MODULE.workspaceId,
  moduleId: SORTING_GUIDE_MODULE.moduleId,
  resources: [sortingGuideItemAdapter],
}
